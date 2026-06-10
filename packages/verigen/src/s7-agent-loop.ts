import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DebuggerTraceContext } from "./context-router.ts";
import { type EdaToolIssue, type EdaToolIssueKind, type EdaToolRunResult, runIverilogVvp } from "./eda-toolrunner.ts";
import { createDefaultGraphifyContext, type GraphifyContext } from "./graphify-context.ts";
import { defaultPlaybookIndexPath, defaultPlaybookRules, PlaybookRag } from "./playbook-rag.ts";
import {
	buildCodegenQualityProbePrompt,
	buildCodegenQualityProbeTestbench,
	type CodegenProbeLlmConfig,
	type CodegenProbeModuleContract,
	type CodegenQualityProbeCase,
	generateCodegenQualityProbeRtl,
	getCodegenQualityProbeCase,
	normalizeGeneratedRtl,
	type RunCodegenQualityProbeOptions,
} from "./quality-probe.ts";
import {
	type BuildVerigenRoutedContextOptions,
	buildVerigenRoutedContext,
	type VerigenGraphifyProvider,
	type VerigenPlaybookProvider,
} from "./s8-context-router.ts";
import { SpecAnchoredKnowledgeGraph } from "./spec-kg.ts";
import { generateRtlViaDag } from "./task-dag.ts";

export type VerigenLoopAgent = "planner" | "coder" | "verifier" | "debugger";

export type VerigenFixLoopStatus = "pass" | "fail" | "missing_tool";

export type VerigenFixLoopFailureType = EdaToolIssueKind | "unknown" | "max_rounds";

export interface VerigenPlanKgNode {
	id: string;
	kind: "module" | "port" | "constraint";
	label: string;
}

export interface VerigenAgentPlan {
	caseId: string;
	title: string;
	spec: string;
	moduleContract: CodegenProbeModuleContract;
	kgSeed: VerigenPlanKgNode[];
}

export interface VerigenDebuggerFeedback {
	failureType: VerigenFixLoopFailureType;
	summary: string;
	repairPrompt: string;
	issue?: EdaToolIssue;
}

export interface VerigenCoderInput {
	plan: VerigenAgentPlan;
	round: number;
	maxRounds: number;
	prompt: string;
	previousFeedback?: VerigenDebuggerFeedback;
}

export type VerigenCoder = (input: VerigenCoderInput) => Promise<string> | string;

export interface VerigenFixLoopAttempt {
	round: number;
	coderPrompt: string;
	rtl: string;
	verifierResult: EdaToolRunResult;
	failureType?: VerigenFixLoopFailureType;
	debuggerFeedback?: VerigenDebuggerFeedback;
}

export interface VerigenFixLoopEvent {
	agent: VerigenLoopAgent;
	round?: number;
	action: string;
	summary: string;
}

export interface RunCodegenQualityProbeFixLoopOptions extends RunCodegenQualityProbeOptions {
	maxRounds?: number;
	dag?: boolean;
	plannerLlm?: boolean;
	context?: boolean;
	generateRtl?: VerigenCoder;
}

export interface VerigenFixLoopReport {
	status: VerigenFixLoopStatus;
	case: CodegenQualityProbeCase;
	plan: VerigenAgentPlan;
	maxRounds: number;
	attempts: VerigenFixLoopAttempt[];
	repairRounds: number;
	finalRtl: string | null;
	failureType?: VerigenFixLoopFailureType;
	events: VerigenFixLoopEvent[];
	llm?: CodegenProbeLlmConfig;
}

export interface FixLoopFailureRecord {
	caseId: string;
	spec: string;
	moduleName: string;
	timestamp: string;
	maxRounds: number;
	attempts: Array<{
		round: number;
		rtl: string;
		failureType: string;
		toolOutput: string;
	}>;
	failureType: string;
}

function failuresDir(repoRoot: string): string {
	return join(repoRoot, ".verigen", "failures");
}

async function saveFailureRecord(repoRoot: string, record: FixLoopFailureRecord): Promise<string> {
	const dir = failuresDir(repoRoot);
	await mkdir(dir, { recursive: true });
	const fileName = `${record.caseId}-${record.timestamp.replace(/[:.]/g, "-")}.json`;
	const filePath = join(dir, fileName);
	await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	return filePath;
}

export async function loadRecentFailures(repoRoot: string, maxFiles = 3): Promise<FixLoopFailureRecord[]> {
	const dir = failuresDir(repoRoot);
	try {
		const entries = await readdir(dir);
		const jsonFiles = entries
			.filter((e) => e.endsWith(".json"))
			.sort()
			.reverse()
			.slice(0, maxFiles);
		const records: FixLoopFailureRecord[] = [];
		for (const file of jsonFiles) {
			try {
				const content = await readFile(join(dir, file), "utf8");
				const parsed = JSON.parse(content) as FixLoopFailureRecord;
				records.push(parsed);
			} catch {
				// skip corrupt files
			}
		}
		return records;
	} catch {
		return [];
	}
}

function formatFailureIcl(records: FixLoopFailureRecord[]): string {
	if (records.length === 0) return "";
	return [
		"## Recent similar failure patterns",
		"",
		...records.flatMap((r) => [
			`- Case: ${r.caseId} (${r.failureType}, ${r.attempts.length} attempt(s))`,
			`  Spec: ${r.spec.slice(0, 120)}`,
			`  Last RTL errors: ${r.attempts.map((a) => a.failureType).join(", ")}`,
		]),
	].join("\n");
}

export interface FixLoopContextProviders {
	kg: SpecAnchoredKnowledgeGraph;
	playbook: VerigenPlaybookProvider;
	graphify: VerigenGraphifyProvider;
	graphifyCtx: GraphifyContext;
}

function buildKgFromPlan(plan: VerigenAgentPlan): SpecAnchoredKnowledgeGraph {
	const kg = new SpecAnchoredKnowledgeGraph();
	const moduleNode = plan.kgSeed.find((n) => n.kind === "module");
	const portNodes = plan.kgSeed.filter((n) => n.kind === "port");
	const constraintNodes = plan.kgSeed.filter((n) => n.kind === "constraint");

	for (const node of plan.kgSeed) {
		if (node.kind === "module") {
			kg.addNode({ id: node.id, type: "Module", name: node.label });
		} else if (node.kind === "port") {
			kg.addNode({
				id: node.id,
				type: "Port",
				name: node.label,
				metadata: { direction: node.label.split(" ")[0], name: node.label.split(" ")[1] },
			});
		} else if (node.kind === "constraint") {
			kg.addNode({ id: node.id, type: "Constraint", name: node.label });
		}
	}

	if (moduleNode) {
		for (const port of portNodes) {
			kg.addEdge({ source: moduleNode.id, target: port.id, type: "HAS_PORT" });
		}
		for (const constraint of constraintNodes) {
			kg.addEdge({ source: moduleNode.id, target: constraint.id, type: "CONSTRAINED_BY" });
		}
	}

	return kg;
}

async function buildFixLoopProviders(plan: VerigenAgentPlan, repoRoot: string): Promise<FixLoopContextProviders> {
	const kg = buildKgFromPlan(plan);

	const playbookIndexPath = defaultPlaybookIndexPath(repoRoot);
	const playbook = new PlaybookRag(playbookIndexPath);
	await playbook.indexRules(defaultPlaybookRules);

	const graphifyCtx = createDefaultGraphifyContext(repoRoot);
	const graphify: VerigenGraphifyProvider = {
		query: (query, maxResults) => graphifyCtx.query(query, maxResults),
	};

	return { kg, playbook, graphify, graphifyCtx };
}

function buildRoutedContextForRound(
	providers: FixLoopContextProviders,
	plan: VerigenAgentPlan,
	role: "coder" | "debugger",
	triggers: string[],
	toolResults?: EdaToolRunResult[],
	trace?: DebuggerTraceContext,
): Promise<import("./s8-context-router.ts").VerigenRoutedContext> {
	const options: BuildVerigenRoutedContextOptions = {
		task: `${plan.title}: ${plan.spec}`,
		role,
		kg: providers.kg,
		kgSeeds: plan.kgSeed.map((n) => n.id),
		playbook: providers.playbook,
		graphify: providers.graphify,
		triggers,
	};

	if (toolResults && toolResults.length > 0) {
		options.toolResults = toolResults;
	}
	if (trace) {
		options.trace = trace;
	}

	return buildVerigenRoutedContext(options);
}

function clampMaxRounds(value: number | undefined): number {
	if (value === undefined) return 3;
	return Math.min(3, Math.max(1, value));
}

function planFromProbeCase(probeCase: CodegenQualityProbeCase): VerigenAgentPlan {
	const moduleNode: VerigenPlanKgNode = {
		id: `module:${probeCase.moduleContract.moduleName}`,
		kind: "module",
		label: probeCase.moduleContract.moduleName,
	};
	const portNodes: VerigenPlanKgNode[] = probeCase.moduleContract.ports.map((port) => ({
		id: `port:${probeCase.moduleContract.moduleName}.${port.name}`,
		kind: "port",
		label: `${port.direction} ${port.name}[${port.width}]`,
	}));
	const constraintNodes: VerigenPlanKgNode[] = probeCase.moduleContract.notes.map((note, index) => ({
		id: `constraint:${probeCase.id}:${index + 1}`,
		kind: "constraint",
		label: note,
	}));
	return {
		caseId: probeCase.id,
		title: probeCase.title,
		spec: probeCase.spec,
		moduleContract: probeCase.moduleContract,
		kgSeed: [moduleNode, ...portNodes, ...constraintNodes],
	};
}

function mux2Candidate(round: number): string {
	if (round <= 1) {
		return `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? a : b;
endmodule
`;
	}
	return `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? b : a;
endmodule
`;
}

function priorityEncoderCandidate(round: number): string {
	if (round <= 1) {
		return `module priority_encoder4(
  input [3:0] in,
  output reg [1:0] idx,
  output reg valid
);
  always @* begin
    valid = |in;
    idx = 2'd0;
    if (in[0]) idx = 2'd0;
    else if (in[1]) idx = 2'd1;
    else if (in[2]) idx = 2'd2;
    else if (in[3]) idx = 2'd3;
  end
endmodule
`;
	}
	return `module priority_encoder4(
  input [3:0] in,
  output reg [1:0] idx,
  output reg valid
);
  always @* begin
    valid = |in;
    idx = 2'd0;
    if (in[3]) idx = 2'd3;
    else if (in[2]) idx = 2'd2;
    else if (in[1]) idx = 2'd1;
    else idx = 2'd0;
  end
endmodule
`;
}

function counterCandidate(round: number): string {
	if (round <= 1) {
		return `module counter8_en(
  input clk,
  input rst,
  input en,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (rst) q <= 8'h00;
    else q <= q + 8'h01;
  end
endmodule
`;
	}
	return `module counter8_en(
  input clk,
  input rst,
  input en,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (rst) q <= 8'h00;
    else if (en) q <= q + 8'h01;
  end
endmodule
`;
}

function shiftRegisterCandidate(round: number): string {
	if (round <= 1) {
		return `module shift_reg8(
  input clk,
  input clr,
  input din,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (clr) q <= 8'h00;
    else q <= {din, q[7:1]};
  end
endmodule
`;
	}
	return `module shift_reg8(
  input clk,
  input clr,
  input din,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (clr) q <= 8'h00;
    else q <= {q[6:0], din};
  end
endmodule
`;
}

function scriptedCandidate(caseId: string, round: number): string {
	if (caseId === "l0-mux2") return mux2Candidate(round);
	if (caseId === "l0-priority-encoder") return priorityEncoderCandidate(round);
	if (caseId === "l1-counter") return counterCandidate(round);
	if (caseId === "l1-shift-register") return shiftRegisterCandidate(round);
	throw new Error(`No scripted S7 fix-loop candidate for Codegen Quality Probe case ${caseId}`);
}

function firstIssue(result: EdaToolRunResult): EdaToolIssue | undefined {
	return result.issues.find((issue) => issue.severity === "error") ?? result.issues[0];
}

function failureTypeFor(result: EdaToolRunResult): VerigenFixLoopFailureType {
	const issue = firstIssue(result);
	return issue?.kind ?? "unknown";
}

function formatIssue(issue: EdaToolIssue | undefined): string {
	if (!issue) return "verifier failed without a structured issue";
	const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : issue.tool;
	const snippet = issue.snippet ? `\nSnippet:\n${issue.snippet}` : "";
	return `${issue.kind} from ${location}: ${issue.message}${snippet}`;
}

function buildRepairPrompt(
	plan: VerigenAgentPlan,
	round: number,
	maxRounds: number,
	rtl: string,
	verifierResult: EdaToolRunResult,
): VerigenDebuggerFeedback {
	const issue = firstIssue(verifierResult);
	const failureType = failureTypeFor(verifierResult);
	const issueText = formatIssue(issue);
	const repairPrompt = [
		"You are VeriGen Debugger + Coder.",
		"Repair the RTL while preserving the module contract exactly.",
		`Task: ${plan.title}`,
		`Round ${round} failed; ${maxRounds - round} repair round(s) remain.`,
		`Failure type: ${failureType}`,
		"",
		"Verifier issue",
		issueText,
		"",
		"Module contract",
		`module: ${plan.moduleContract.moduleName}`,
		...plan.moduleContract.ports.map((port) => `- ${port.direction} ${port.name} width=${port.width}`),
		"",
		"Previous RTL",
		rtl,
		"",
		"Return one complete synthesizable Verilog module only. Do not include markdown fences.",
	].join("\n");
	return {
		failureType,
		summary: issueText,
		repairPrompt,
		...(issue ? { issue } : {}),
	};
}

function buildVerifierInput(probeCase: CodegenQualityProbeCase, rtl: string): Parameters<typeof runIverilogVvp>[0] {
	return {
		rtl: [{ filename: `${probeCase.moduleContract.moduleName}.v`, content: normalizeGeneratedRtl(rtl) }],
		testbench: [
			{
				filename: `${probeCase.moduleContract.moduleName}_tb.v`,
				content: buildCodegenQualityProbeTestbench(probeCase.id),
			},
		],
		top: "tb",
	};
}

async function generateAttemptRtl(
	input: VerigenCoderInput,
	options: RunCodegenQualityProbeFixLoopOptions,
): Promise<{ rtl: string; llm?: CodegenProbeLlmConfig }> {
	if (options.dag) {
		const probeCase = getCodegenQualityProbeCase(input.plan.caseId);
		const generated = await generateRtlViaDag(probeCase, { ...options, plannerLlm: options.plannerLlm });
		return { rtl: generated.generatedRtl, llm: generated.llm };
	}
	if (options.generateRtl) {
		return { rtl: normalizeGeneratedRtl(await options.generateRtl(input)) };
	}
	if (options.live) {
		const generated = await generateCodegenQualityProbeRtl(input.prompt, options);
		return { rtl: generated.generatedRtl, llm: generated.llm };
	}
	return { rtl: scriptedCandidate(input.plan.caseId, input.round) };
}

export async function runCodegenQualityProbeFixLoop(
	caseId: string,
	options: RunCodegenQualityProbeFixLoopOptions = {},
): Promise<VerigenFixLoopReport> {
	const probeCase = getCodegenQualityProbeCase(caseId);
	const plan = planFromProbeCase(probeCase);
	const maxRounds = clampMaxRounds(options.maxRounds);
	const contextEnabled = options.context ?? true;
	const repoRoot = options.repoRoot ?? process.cwd();
	const attempts: VerigenFixLoopAttempt[] = [];
	const events: VerigenFixLoopEvent[] = [
		{
			agent: "planner",
			action: "plan",
			summary: `Created module contract and KG seed for ${probeCase.moduleContract.moduleName}`,
		},
	];
	let previousFeedback: VerigenDebuggerFeedback | undefined;
	let llm: CodegenProbeLlmConfig | undefined;
	const providers = contextEnabled ? await buildFixLoopProviders(plan, repoRoot) : undefined;

	if (providers) {
		events.push({
			agent: "planner",
			action: "context_ready",
			summary: "KG, Playbook, and Graphify providers initialized",
		});
	}

	for (let round = 1; round <= maxRounds; round += 1) {
		let coderPrompt = previousFeedback?.repairPrompt ?? buildCodegenQualityProbePrompt(probeCase);
		const triggers = [probeCase.level, probeCase.category, ...probeCase.moduleContract.notes];

		if (providers && !previousFeedback) {
			const routed = await buildRoutedContextForRound(providers, plan, "coder", triggers);
			const recentFailures = await loadRecentFailures(repoRoot, 2);
			const failureIcl = formatFailureIcl(recentFailures);
			coderPrompt = `${routed.rendered}\n\n${failureIcl}\n\n${coderPrompt}`;
		}

		const generateMode = options.dag ? "dag" : "flat";
		events.push({
			agent: "coder",
			round,
			action: "generate",
			summary: `Generated candidate RTL round ${round} (${generateMode}${providers ? "+context" : ""})`,
		});
		const generated = await generateAttemptRtl(
			{ plan, round, maxRounds, prompt: coderPrompt, previousFeedback },
			options,
		);
		if (generated.llm) llm = generated.llm;
		const verifierResult = await runIverilogVvp(buildVerifierInput(probeCase, generated.rtl));
		events.push({
			agent: "verifier",
			round,
			action: "compile_sim",
			summary: verifierResult.ok ? "compile/sim passed" : `${failureTypeFor(verifierResult)} failed`,
		});

		if (verifierResult.ok) {
			attempts.push({
				round,
				coderPrompt,
				rtl: generated.rtl,
				verifierResult,
			});
			return {
				status: "pass",
				case: probeCase,
				plan,
				maxRounds,
				attempts,
				repairRounds: Math.max(0, round - 1),
				finalRtl: generated.rtl,
				events,
				...(llm ? { llm } : {}),
			};
		}

		const debuggerFeedback = buildRepairPrompt(plan, round, maxRounds, generated.rtl, verifierResult);
		if (providers) {
			const routed = await buildRoutedContextForRound(providers, plan, "debugger", triggers, [verifierResult]);
			debuggerFeedback.repairPrompt = `${routed.rendered}\n\n${debuggerFeedback.repairPrompt}`;
		}
		events.push({
			agent: "debugger",
			round,
			action: "repair_prompt",
			summary: debuggerFeedback.summary,
		});
		attempts.push({
			round,
			coderPrompt,
			rtl: generated.rtl,
			verifierResult,
			failureType: debuggerFeedback.failureType,
			debuggerFeedback,
		});
		previousFeedback = debuggerFeedback;
	}

	const lastAttempt = attempts[attempts.length - 1];
	const lastFailure = lastAttempt?.failureType ?? "max_rounds";
	const status = lastFailure === "missing_tool" ? "missing_tool" : "fail";

	if (status === "fail" || status === "missing_tool") {
		const record: FixLoopFailureRecord = {
			caseId: plan.caseId,
			spec: plan.spec,
			moduleName: plan.moduleContract.moduleName,
			timestamp: new Date().toISOString(),
			maxRounds,
			attempts: attempts.map((a) => ({
				round: a.round,
				rtl: a.rtl.slice(0, 2000),
				failureType: a.failureType ?? "unknown",
				toolOutput: a.verifierResult.issues
					.map((i) => i.message)
					.join("; ")
					.slice(0, 500),
			})),
			failureType: lastFailure,
		};
		await saveFailureRecord(repoRoot, record).catch(() => {});
	}

	return {
		status,
		case: probeCase,
		plan,
		maxRounds,
		attempts,
		repairRounds: Math.max(0, attempts.length - 1),
		finalRtl: lastAttempt?.rtl ?? null,
		failureType: lastFailure,
		events,
		...(llm ? { llm } : {}),
	};
}

export function renderVerigenFixLoopReport(report: VerigenFixLoopReport): string {
	const lines = [
		`VeriGen S7 Fix Loop: ${report.case.id}`,
		`Status: ${report.status}`,
		`Repair rounds: ${report.repairRounds}/${report.maxRounds - 1}`,
		`Module: ${report.plan.moduleContract.moduleName}`,
		"",
		"Agent events",
		...report.events.map((event) => {
			const round = event.round ? ` round=${event.round}` : "";
			return `- ${event.agent}${round} ${event.action}: ${event.summary}`;
		}),
		"",
		"Attempts",
		...report.attempts.map((attempt) => {
			const result = attempt.verifierResult.ok ? "pass" : (attempt.failureType ?? "unknown");
			return `- round ${attempt.round}: ${result}`;
		}),
		"",
		"Final RTL",
		report.finalRtl ?? "[no RTL generated]",
	];
	return lines.join("\n");
}
