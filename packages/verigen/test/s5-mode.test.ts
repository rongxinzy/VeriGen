import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import {
	buildCodegenQualityProbePrompt,
	buildVerigenAgentLaunch,
	createQualityProbeTuiPreview,
	createTraceTextPanel,
	createTraceTuiPreview,
	createVerigenPipelineStatus,
	type FetchLike,
	getCodegenQualityProbeCase,
	renderVerigenTuiPreview,
	runCodegenQualityProbeCase,
	type SimulationFailureTraceResult,
} from "../src/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sampleTraceResult(): SimulationFailureTraceResult {
	return {
		rawTrace: {
			trace: [
				{
					signal: "out",
					controllers: ["n", "a", "b"],
					controllers_by_level: [
						{ level: 0, relations: [{ controller: "n", controlled: "out" }] },
						{ level: 1, relations: [{ controller: "a", controlled: "n" }] },
					],
				},
			],
			wave_table_hex: "time out_dut out_ref\n2 0 1\n4 0 1",
			mismatch_time: 2,
			mismatch_values: { out: "dut=0 ref=1" },
			code_snippets: [
				{ signal: "out", start_line: 7, end_line: 8, code: "assign n = a & b;\nassign out = sel ? n : b;" },
			],
		},
		debuggerContext: {
			mismatch_time: 2,
			mismatch_values: { out: "dut=0 ref=1" },
			trace: [
				{
					signal: "out",
					controllers: ["n", "a", "b"],
					controllersOmitted: 0,
					controllers_by_level: [
						{ level: 0, relations: [{ controller: "n", controlled: "out" }], omittedRelations: 0 },
						{ level: 1, relations: [{ controller: "a", controlled: "n" }], omittedRelations: 0 },
					],
					levelsOmitted: 0,
				},
			],
			wave_table_hex: "time out_dut out_ref\n2 0 1\n4 0 1",
			code_snippets: [
				{
					signal: "out",
					start_line: 7,
					end_line: 8,
					code: "assign n = a & b;\nassign out = sel ? n : b;",
					linesOmitted: 0,
				},
			],
			omitted: {
				signals: 0,
				waveTableRows: 0,
				waveTableChars: 0,
				codeSnippets: 0,
				contextChars: 0,
			},
		},
		debuggerPromptContext: "AST waveform trace for Debugger (trimmed)\nSignal trace:\n- out: controllers n, a, b",
	};
}

describe("S5 VeriGen mode trace panel", () => {
	test("creates pipeline status and renders a text trace panel for TUI consumption", () => {
		const status = createVerigenPipelineStatus("trace");
		assert.deepEqual(
			status.map((item) => item.state),
			["done", "done", "done", "done", "active", "pending", "pending"],
		);

		const panel = createTraceTextPanel({ trace: sampleTraceResult() });
		assert.match(panel.rendered, /VeriGen S5 Trace Panel/);
		assert.match(panel.rendered, /Mismatch signals/);
		assert.match(panel.rendered, /out/);
		assert.match(panel.rendered, /out <- n <- a <- b/);
		assert.match(panel.rendered, /Waveform window \(hex\)/);
		assert.match(panel.rendered, /assign out = sel \? n : b;/);
		assert.match(panel.rendered, /Debugger suggestions/);
		assert.match(panel.debuggerPromptContext, /AST waveform trace for Debugger/);

		const preview = renderVerigenTuiPreview(createTraceTuiPreview(panel), 110);
		assert.match(preview, /VeriGen S5 Trace MVP/);
		assert.match(preview, /Pipeline:/);
		assert.match(preview, /Trace/);
		assert.match(preview, /Debugger/);
		assert.match(preview, /waveform hex:/);
		assert.match(preview, /out <- n <- a <- b/);
	});
});

describe("S5 Codegen Quality Probe", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("builds an L0/L1 probe prompt with module contract and manual review checklist", () => {
		const probeCase = getCodegenQualityProbeCase("l0-mux2");
		const prompt = buildCodegenQualityProbePrompt(probeCase);
		assert.match(prompt, /module: mux2/);
		assert.match(prompt, /input a width=8/);
		assert.match(prompt, /Manual review checklist/);
	});

	test("calls the configured Anthropic-compatible endpoint without exposing the API key", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-s5-probe-"));
		tempDirs.push(tempDir);
		writeFileSync(
			join(tempDir, ".env"),
			[
				"VERIGEN_TEST_LLM_PROVIDER=anthropic",
				"VERIGEN_TEST_LLM_BASE_URL=http://127.0.0.1:3000",
				"VERIGEN_TEST_LLM_MODEL=kimi-for-coding",
				"VERIGEN_TEST_LLM_API_KEY=secret-from-env",
			].join("\n"),
		);

		let capturedUrl = "";
		let capturedBody: unknown;
		const fakeFetch: FetchLike = async (url, init) => {
			capturedUrl = url;
			capturedBody = JSON.parse(init.body);
			assert.equal(init.headers["x-api-key"], "secret-from-env");
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						content: [
							{
								type: "text",
								text: "module mux2(input [7:0] a, input [7:0] b, input sel, output [7:0] y); assign y = sel ? b : a; endmodule",
							},
						],
					}),
			};
		};

		const result = await runCodegenQualityProbeCase("l0-mux2", {
			live: true,
			repoRoot: tempDir,
			fetchFn: fakeFetch,
		});

		assert.equal(capturedUrl, "http://127.0.0.1:3000/v1/messages");
		assert.ok(isRecord(capturedBody));
		assert.equal(capturedBody.model, "kimi-for-coding");
		assert.match(result.generatedRtl ?? "", /module mux2/);
		assert.equal(result.llm.apiKeyConfigured, true);
		assert.doesNotMatch(JSON.stringify(result), /secret-from-env/);
		assert.equal(result.toolResult.status, "not_run");
		assert.equal(result.manualReview.status, "pending");

		const preview = renderVerigenTuiPreview(createQualityProbeTuiPreview(result), 110);
		assert.match(preview, /VeriGen S5 Codegen Quality Probe/);
		assert.match(preview, /module: mux2/);
		assert.match(preview, /module mux2/);
		assert.match(preview, /manual review: pending/);
	});
});

describe("S5 VeriGen agent launcher", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("builds a pi coding-agent launch command with VeriGen prompts and skill assets", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-s5-agent-"));
		tempDirs.push(tempDir);
		const promptDir = join(tempDir, "dist", "pi-assets", "prompts");
		const skillDir = join(tempDir, "dist", "pi-assets", "skills");
		mkdirSync(promptDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(promptDir, "verigen-system.md"), "# system\n");
		writeFileSync(join(promptDir, "verigen-coder.md"), "# coder\n");
		writeFileSync(join(promptDir, "verigen-debugger.md"), "# debugger\n");
		writeFileSync(join(promptDir, "verigen-planner.md"), "# planner\n");
		writeFileSync(join(promptDir, "verigen-verifier.md"), "# verifier\n");
		writeFileSync(join(skillDir, "verigen-playbook.md"), "# playbook\n");
		writeFileSync(
			join(tempDir, "dist", "verigen-coding-agent-extension.js"),
			"export default function extension() {}\n",
		);

		const launch = buildVerigenAgentLaunch({
			packageRoot: tempDir,
			piCommand: "pi-test",
			piArgs: ["--print", "generate a counter"],
		});

		assert.equal(launch.command, "pi-test");
		assert.equal(launch.assets.systemPrompt, join(promptDir, "verigen-system.md"));
		assert.equal(launch.assets.promptTemplates.length, 4);
		assert.equal(launch.assets.skills.length, 1);
		assert.deepEqual(launch.assets.extensions, [join(tempDir, "dist", "verigen-coding-agent-extension.js")]);
		assert.deepEqual(launch.args.slice(0, 2), ["--system-prompt", join(promptDir, "verigen-system.md")]);
		assert.ok(launch.args.includes("--prompt-template"));
		assert.ok(launch.args.includes(join(promptDir, "verigen-coder.md")));
		assert.ok(launch.args.includes("--skill"));
		assert.ok(launch.args.includes(join(skillDir, "verigen-playbook.md")));
		assert.ok(launch.args.includes("--extension"));
		assert.ok(launch.args.includes(join(tempDir, "dist", "verigen-coding-agent-extension.js")));
		assert.deepEqual(launch.args.slice(-2), ["--print", "generate a counter"]);
	});

	test("uses the source checkout pi-test launcher so workspace path aliases resolve", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-s5-agent-source-"));
		tempDirs.push(tempDir);
		const packageRoot = join(tempDir, "packages", "verigen");
		const promptDir = join(tempDir, ".pi", "prompts");
		const skillDir = join(tempDir, ".pi", "skills");
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		mkdirSync(join(tempDir, "packages", "coding-agent", "src"), { recursive: true });
		mkdirSync(promptDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(tempDir, "pi-test.sh"), "#!/usr/bin/env bash\n");
		writeFileSync(
			join(packageRoot, "src", "verigen-coding-agent-extension.ts"),
			"export default function extension() {}\n",
		);
		writeFileSync(join(tempDir, "packages", "coding-agent", "src", "cli.ts"), "#!/usr/bin/env node\n");
		writeFileSync(join(promptDir, "verigen-system.md"), "# system\n");
		writeFileSync(join(promptDir, "verigen-coder.md"), "# coder\n");
		writeFileSync(join(skillDir, "verigen-playbook.md"), "# playbook\n");

		const launch = buildVerigenAgentLaunch({ packageRoot });

		assert.equal(launch.command, join(tempDir, "pi-test.sh"));
		assert.ok(launch.args.includes("--extension"));
		assert.ok(launch.args.includes(join(packageRoot, "src", "verigen-coding-agent-extension.ts")));
		assert.ok(launch.args.includes("--prompt-template"));
		assert.ok(launch.args.includes(join(promptDir, "verigen-coder.md")));
		assert.ok(launch.args.includes("--skill"));
		assert.ok(launch.args.includes(join(skillDir, "verigen-playbook.md")));
	});

	test("uses the installed pi coding-agent dist CLI instead of falling back to PATH", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-s5-agent-installed-"));
		tempDirs.push(tempDir);
		const packageRoot = join(tempDir, "node_modules", "verigen");
		const promptDir = join(packageRoot, "dist", "pi-assets", "prompts");
		const skillDir = join(packageRoot, "dist", "pi-assets", "skills");
		const dependencyCli = join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
		mkdirSync(promptDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		mkdirSync(dirname(dependencyCli), { recursive: true });
		writeFileSync(join(promptDir, "verigen-system.md"), "# system\n");
		writeFileSync(join(promptDir, "verigen-coder.md"), "# coder\n");
		writeFileSync(join(skillDir, "verigen-playbook.md"), "# playbook\n");
		writeFileSync(join(packageRoot, "dist", "verigen-coding-agent-extension.js"), "export {};\n");
		writeFileSync(dependencyCli, "#!/usr/bin/env node\n");

		const launch = buildVerigenAgentLaunch({ packageRoot });

		assert.equal(launch.command, process.execPath);
		assert.equal(launch.args[0], dependencyCli);
		assert.ok(launch.args.includes("--system-prompt"));
		assert.ok(launch.args.includes("--extension"));
	});
});
