import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EdaToolRunResult, runIverilogVvp } from "./eda-toolrunner.ts";

export type CodegenProbeLevel = "L0" | "L1";

export type CodegenProbeToolStatus = "not_run" | "pass" | "fail" | "missing_tool";

export interface CodegenProbePort {
	name: string;
	direction: "input" | "output";
	width: string;
	description: string;
}

export interface CodegenProbeModuleContract {
	moduleName: string;
	ports: CodegenProbePort[];
	clock?: string;
	reset?: string;
	notes: string[];
}

export interface CodegenQualityProbeCase {
	id: string;
	level: CodegenProbeLevel;
	category: string;
	title: string;
	spec: string;
	moduleContract: CodegenProbeModuleContract;
	reviewChecklist: string[];
}

export interface CodegenProbeToolResult {
	status: CodegenProbeToolStatus;
	summary: string;
	edaResults: EdaToolRunResult[];
}

export interface CodegenProbeManualReview {
	status: "pending";
	notes: string;
	checklist: string[];
}

export interface CodegenProbeLlmConfig {
	provider: "anthropic";
	baseUrl: string;
	model: string;
	apiKeyConfigured: boolean;
}

export interface CodegenProbeRunResult {
	case: CodegenQualityProbeCase;
	prompt: string;
	llm: CodegenProbeLlmConfig;
	generatedRtl: string | null;
	toolResult: CodegenProbeToolResult;
	manualReview: CodegenProbeManualReview;
}

export interface CodegenProbeGenerationResult {
	llm: CodegenProbeLlmConfig;
	generatedRtl: string;
}

export interface HttpResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponseLike>;

export interface RunCodegenQualityProbeOptions {
	live?: boolean;
	repoRoot?: string;
	provider?: "anthropic";
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	maxTokens?: number;
	fetchFn?: FetchLike;
	runTools?: boolean;
	keepToolWorkDir?: boolean;
}

const defaultBaseUrl = "http://172.18.5.179:3000";
const defaultModel = "kimi-for-coding";

export const defaultCodegenQualityProbeCases: CodegenQualityProbeCase[] = [
	{
		id: "l0-mux2",
		level: "L0",
		category: "combinational",
		title: "2:1 mux",
		spec: "Implement a synthesizable two-input mux. When sel is 0, y follows a. When sel is 1, y follows b.",
		moduleContract: {
			moduleName: "mux2",
			ports: [
				{ name: "a", direction: "input", width: "8", description: "input selected when sel=0" },
				{ name: "b", direction: "input", width: "8", description: "input selected when sel=1" },
				{ name: "sel", direction: "input", width: "1", description: "select signal" },
				{ name: "y", direction: "output", width: "8", description: "mux output" },
			],
			notes: ["Use a single module named mux2.", "Do not infer latches.", "Keep the design combinational."],
		},
		reviewChecklist: [
			"Module name and ports exactly match the contract.",
			"Output y equals a when sel=0 and b when sel=1.",
			"No clocked logic, latch, delay, initial block, or non-synthesizable construct.",
		],
	},
	{
		id: "l0-priority-encoder",
		level: "L0",
		category: "combinational",
		title: "4-bit priority encoder",
		spec: "Implement a 4-bit priority encoder. Highest set bit wins. valid is 1 when any input bit is set.",
		moduleContract: {
			moduleName: "priority_encoder4",
			ports: [
				{ name: "in", direction: "input", width: "4", description: "request bits, bit 3 has highest priority" },
				{ name: "idx", direction: "output", width: "2", description: "index of highest set bit" },
				{ name: "valid", direction: "output", width: "1", description: "at least one input bit is set" },
			],
			notes: ["Use a deterministic default assignment.", "Do not infer latches."],
		},
		reviewChecklist: [
			"Priority order is 3, 2, 1, 0.",
			"valid is low only for in=0000.",
			"Combinational block has complete assignments on every path.",
		],
	},
	{
		id: "l1-counter",
		level: "L1",
		category: "sequential",
		title: "Enabled up counter",
		spec: "Implement an 8-bit up counter with synchronous active-high reset and enable.",
		moduleContract: {
			moduleName: "counter8_en",
			clock: "clk",
			reset: "rst",
			ports: [
				{ name: "clk", direction: "input", width: "1", description: "posedge clock" },
				{ name: "rst", direction: "input", width: "1", description: "synchronous active-high reset" },
				{ name: "en", direction: "input", width: "1", description: "count enable" },
				{ name: "q", direction: "output", width: "8", description: "counter state" },
			],
			notes: ["Use posedge clk.", "Reset q to 0 synchronously.", "Hold q when en is 0."],
		},
		reviewChecklist: [
			"Only q is assigned in the sequential block.",
			"rst has priority over en.",
			"Counter holds value when en=0 and wraps naturally at 8 bits.",
		],
	},
	{
		id: "l1-shift-register",
		level: "L1",
		category: "sequential",
		title: "Serial-in shift register",
		spec: "Implement an 8-bit left shift register with synchronous clear and serial input.",
		moduleContract: {
			moduleName: "shift_reg8",
			clock: "clk",
			reset: "clr",
			ports: [
				{ name: "clk", direction: "input", width: "1", description: "posedge clock" },
				{ name: "clr", direction: "input", width: "1", description: "synchronous active-high clear" },
				{ name: "din", direction: "input", width: "1", description: "serial input bit" },
				{ name: "q", direction: "output", width: "8", description: "shift register state" },
			],
			notes: ["Use posedge clk.", "When clr is high, q becomes 0.", "Otherwise shift left and insert din at bit 0."],
		},
		reviewChecklist: [
			"q shifts as {q[6:0], din}.",
			"clr is synchronous and has priority.",
			"No combinational feedback or blocking assignment race in sequential logic.",
		],
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDotEnv(repoRoot: string): Record<string, string> {
	const envPath = join(repoRoot, ".env");
	if (!existsSync(envPath)) return {};
	const entries: Record<string, string> = {};
	for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		const rawValue = line.slice(separator + 1).trim();
		entries[key] = rawValue.replace(/^["']|["']$/g, "");
	}
	return entries;
}

function resolveConfig(options: RunCodegenQualityProbeOptions): { config: CodegenProbeLlmConfig; apiKey: string } {
	const dotEnv = readDotEnv(options.repoRoot ?? process.cwd());
	const provider = options.provider ?? "anthropic";
	const baseUrl =
		options.baseUrl ?? process.env.VERIGEN_TEST_LLM_BASE_URL ?? dotEnv.VERIGEN_TEST_LLM_BASE_URL ?? defaultBaseUrl;
	const model = options.model ?? process.env.VERIGEN_TEST_LLM_MODEL ?? dotEnv.VERIGEN_TEST_LLM_MODEL ?? defaultModel;
	const apiKey = options.apiKey ?? process.env.VERIGEN_TEST_LLM_API_KEY ?? dotEnv.VERIGEN_TEST_LLM_API_KEY ?? "";
	return {
		config: {
			provider,
			baseUrl,
			model,
			apiKeyConfigured: apiKey.length > 0,
		},
		apiKey,
	};
}

function messagesUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
	return `${trimmed}/v1/messages`;
}

function formatPorts(contract: CodegenProbeModuleContract): string {
	return contract.ports
		.map((port) => `- ${port.direction} ${port.name} width=${port.width}: ${port.description}`)
		.join("\n");
}

function formatNotes(notes: string[]): string {
	return notes.map((note) => `- ${note}`).join("\n");
}

function formatChecklist(checklist: string[]): string {
	return checklist.map((item) => `- ${item}`).join("\n");
}

export function normalizeGeneratedRtl(rtl: string): string {
	const fenced = rtl.match(/```(?:systemverilog|verilog|sv)?\s*([\s\S]*?)```/i);
	return (fenced?.[1] ?? rtl).trim();
}

export function getCodegenQualityProbeCase(id: string): CodegenQualityProbeCase {
	const probeCase = defaultCodegenQualityProbeCases.find((item) => item.id === id);
	if (!probeCase) {
		throw new Error(`Unknown Codegen Quality Probe case: ${id}`);
	}
	return probeCase;
}

export function buildCodegenQualityProbePrompt(probeCase: CodegenQualityProbeCase): string {
	return [
		"You are VeriGen Coder. Generate synthesizable Verilog RTL only.",
		"Return one complete Verilog module. Do not include markdown fences.",
		"",
		`Task: ${probeCase.title}`,
		`Level: ${probeCase.level}`,
		`Spec: ${probeCase.spec}`,
		"",
		"Module contract",
		`module: ${probeCase.moduleContract.moduleName}`,
		"ports:",
		formatPorts(probeCase.moduleContract),
		"",
		"Notes",
		formatNotes(probeCase.moduleContract.notes),
		"",
		"Manual review checklist",
		formatChecklist(probeCase.reviewChecklist),
	].join("\n");
}

async function defaultFetch(
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
): Promise<HttpResponseLike> {
	const response = await fetch(url, init);
	return {
		ok: response.ok,
		status: response.status,
		text: () => response.text(),
	};
}

function extractAnthropicText(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Anthropic-compatible endpoint returned non-JSON response");
	}
	if (!isRecord(parsed)) {
		throw new Error("Anthropic-compatible endpoint returned an invalid response shape");
	}
	const content = parsed.content;
	if (!Array.isArray(content)) {
		const error =
			isRecord(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : raw.slice(0, 500);
		throw new Error(`Anthropic-compatible endpoint returned no text content: ${error}`);
	}
	const textParts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			textParts.push(item.text);
		}
	}
	return textParts.join("").trim();
}

async function generateWithAnthropic(
	prompt: string,
	config: CodegenProbeLlmConfig,
	apiKey: string,
	options: RunCodegenQualityProbeOptions,
): Promise<string> {
	if (!apiKey) {
		throw new Error("VERIGEN_TEST_LLM_API_KEY is required for --live Codegen Quality Probe runs");
	}
	const fetchFn = options.fetchFn ?? defaultFetch;
	const response = await fetchFn(messagesUrl(config.baseUrl), {
		method: "POST",
		headers: {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify({
			model: config.model,
			max_tokens: options.maxTokens ?? 2_048,
			messages: [{ role: "user", content: prompt }],
		}),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`Anthropic-compatible endpoint failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
	}
	return extractAnthropicText(raw);
}

export async function generateCodegenQualityProbeRtl(
	prompt: string,
	options: RunCodegenQualityProbeOptions = {},
): Promise<CodegenProbeGenerationResult> {
	const resolved = resolveConfig(options);
	const generatedRtl = await generateWithAnthropic(prompt, resolved.config, resolved.apiKey, options);
	return {
		llm: resolved.config,
		generatedRtl: normalizeGeneratedRtl(generatedRtl),
	};
}

function mux2Testbench(): string {
	return `module tb;
  reg [7:0] a;
  reg [7:0] b;
  reg sel;
  wire [7:0] y;

  mux2 dut (.a(a), .b(b), .sel(sel), .y(y));

  task check;
    input [7:0] ta;
    input [7:0] tbv;
    input tsel;
    input [7:0] expected;
    begin
      a = ta; b = tbv; sel = tsel; #1;
      if (y !== expected) begin
        $display("VERIGEN_SIM_FAIL mux2 a=%0h b=%0h sel=%0b y=%0h expected=%0h", a, b, sel, y, expected);
        $fatal(1);
      end
    end
  endtask

  initial begin
    check(8'h12, 8'h34, 1'b0, 8'h12);
    check(8'h12, 8'h34, 1'b1, 8'h34);
    check(8'hff, 8'h00, 1'b0, 8'hff);
    check(8'hff, 8'h00, 1'b1, 8'h00);
    $display("VERIGEN_SIM_PASS mux2");
    $finish;
  end
endmodule
`;
}

function priorityEncoder4Testbench(): string {
	return `module tb;
  reg [3:0] in;
  wire [1:0] idx;
  wire valid;

  priority_encoder4 dut (.in(in), .idx(idx), .valid(valid));

  task check;
    input [3:0] value;
    input [1:0] expected_idx;
    input expected_valid;
    begin
      in = value; #1;
      if (idx !== expected_idx || valid !== expected_valid) begin
        $display("VERIGEN_SIM_FAIL priority_encoder4 in=%0b idx=%0d valid=%0b expected_idx=%0d expected_valid=%0b", in, idx, valid, expected_idx, expected_valid);
        $fatal(1);
      end
    end
  endtask

  initial begin
    check(4'b0000, 2'd0, 1'b0);
    check(4'b0001, 2'd0, 1'b1);
    check(4'b0010, 2'd1, 1'b1);
    check(4'b0101, 2'd2, 1'b1);
    check(4'b1011, 2'd3, 1'b1);
    $display("VERIGEN_SIM_PASS priority_encoder4");
    $finish;
  end
endmodule
`;
}

function counter8Testbench(): string {
	return `module tb;
  reg clk = 0;
  reg rst = 0;
  reg en = 0;
  wire [7:0] q;

  counter8_en dut (.clk(clk), .rst(rst), .en(en), .q(q));
  always #1 clk = ~clk;

  task expect_q;
    input [7:0] expected;
    begin
      #0;
      if (q !== expected) begin
        $display("VERIGEN_SIM_FAIL counter8_en q=%0h expected=%0h", q, expected);
        $fatal(1);
      end
    end
  endtask

  initial begin
    rst = 1; en = 0; @(posedge clk); #1; expect_q(8'h00);
    rst = 0; en = 1; @(posedge clk); #1; expect_q(8'h01);
    @(posedge clk); #1; expect_q(8'h02);
    en = 0; @(posedge clk); #1; expect_q(8'h02);
    rst = 1; @(posedge clk); #1; expect_q(8'h00);
    $display("VERIGEN_SIM_PASS counter8_en");
    $finish;
  end
endmodule
`;
}

function shiftReg8Testbench(): string {
	return `module tb;
  reg clk = 0;
  reg clr = 0;
  reg din = 0;
  wire [7:0] q;

  shift_reg8 dut (.clk(clk), .clr(clr), .din(din), .q(q));
  always #1 clk = ~clk;

  task expect_q;
    input [7:0] expected;
    begin
      #0;
      if (q !== expected) begin
        $display("VERIGEN_SIM_FAIL shift_reg8 q=%0h expected=%0h", q, expected);
        $fatal(1);
      end
    end
  endtask

  initial begin
    clr = 1; din = 0; @(posedge clk); #1; expect_q(8'h00);
    clr = 0; din = 1; @(posedge clk); #1; expect_q(8'h01);
    din = 0; @(posedge clk); #1; expect_q(8'h02);
    din = 1; @(posedge clk); #1; expect_q(8'h05);
    $display("VERIGEN_SIM_PASS shift_reg8");
    $finish;
  end
endmodule
`;
}

export function buildCodegenQualityProbeTestbench(id: string): string {
	if (id === "l0-mux2") return mux2Testbench();
	if (id === "l0-priority-encoder") return priorityEncoder4Testbench();
	if (id === "l1-counter") return counter8Testbench();
	if (id === "l1-shift-register") return shiftReg8Testbench();
	throw new Error(`No S6 compile/sim testbench for Codegen Quality Probe case ${id}`);
}

async function runProbeTools(
	probeCase: CodegenQualityProbeCase,
	generatedRtl: string,
	options: RunCodegenQualityProbeOptions,
): Promise<CodegenProbeToolResult> {
	const sim = await runIverilogVvp({
		rtl: [{ filename: `${probeCase.moduleContract.moduleName}.v`, content: normalizeGeneratedRtl(generatedRtl) }],
		testbench: [
			{
				filename: `${probeCase.moduleContract.moduleName}_tb.v`,
				content: buildCodegenQualityProbeTestbench(probeCase.id),
			},
		],
		top: "tb",
		keepWorkDir: options.keepToolWorkDir,
	});
	const firstMissing = sim.issues.find((issue) => issue.kind === "missing_tool");
	if (firstMissing) {
		return {
			status: "missing_tool",
			summary: firstMissing.message,
			edaResults: [sim],
		};
	}
	if (!sim.ok) {
		const firstError = sim.issues.find((issue) => issue.severity === "error");
		return {
			status: "fail",
			summary: firstError?.message ?? "compile/sim failed",
			edaResults: [sim],
		};
	}
	return {
		status: "pass",
		summary: "iverilog/vvp compile and simulation passed",
		edaResults: [sim],
	};
}

export async function runCodegenQualityProbeCase(
	id: string,
	options: RunCodegenQualityProbeOptions = {},
): Promise<CodegenProbeRunResult> {
	const probeCase = getCodegenQualityProbeCase(id);
	const prompt = buildCodegenQualityProbePrompt(probeCase);
	const resolved = resolveConfig(options);
	const generatedRtl = options.live
		? normalizeGeneratedRtl(await generateWithAnthropic(prompt, resolved.config, resolved.apiKey, options))
		: null;
	const toolResult =
		options.runTools && generatedRtl
			? await runProbeTools(probeCase, generatedRtl, options)
			: {
					status: "not_run" as const,
					summary: generatedRtl
						? "S6 ToolRunner was not requested; pass --run-tools to compile/sim generated RTL."
						: "No generated RTL to compile/sim; pass --live or provide generated RTL in a later S6 runner.",
					edaResults: [],
				};
	return {
		case: probeCase,
		prompt,
		llm: resolved.config,
		generatedRtl,
		toolResult,
		manualReview: {
			status: "pending",
			notes: "",
			checklist: probeCase.reviewChecklist,
		},
	};
}

export function renderCodegenQualityProbeResult(result: CodegenProbeRunResult): string {
	const lines = [
		`Codegen Quality Probe: ${result.case.id}`,
		`Level: ${result.case.level}`,
		`Model: ${result.llm.model}`,
		`Endpoint configured: ${result.llm.apiKeyConfigured ? "yes" : "no"}`,
		"",
		"Spec",
		result.case.spec,
		"",
		"Module contract",
		`module ${result.case.moduleContract.moduleName}`,
		formatPorts(result.case.moduleContract),
		"",
		"Generated RTL",
		result.generatedRtl ?? "[not generated; pass --live to call the configured LLM endpoint]",
		"",
		"Tool result",
		`${result.toolResult.status}: ${result.toolResult.summary}`,
		"",
		"Manual review checklist",
		formatChecklist(result.manualReview.checklist),
		"",
		"Manual review notes",
		result.manualReview.notes || "[pending]",
	];
	return lines.join("\n");
}
