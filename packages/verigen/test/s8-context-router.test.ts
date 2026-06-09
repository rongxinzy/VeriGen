import assert from "node:assert";
import { describe, test } from "node:test";
import {
	buildSpecAnchoredKnowledgeGraph,
	buildVerigenRoutedContext,
	type DebuggerTraceContext,
	defaultPlaybookRules,
	type EdaToolRunResult,
	type VerigenGraphifyProvider,
	type VerigenPlaybookProvider,
} from "../src/index.ts";

function sampleTraceContext(): DebuggerTraceContext {
	return {
		mismatch_time: 4,
		mismatch_values: { y_dut: "0", y_ref: "1" },
		trace: [
			{
				signal: "y",
				controllers: ["sel", "a", "b"],
				controllersOmitted: 0,
				controllers_by_level: [],
				levelsOmitted: 0,
			},
		],
		wave_table_hex: "time y_dut y_ref\n4 0 1",
		code_snippets: [{ signal: "y", start_line: 7, end_line: 7, code: "assign y = sel ? a : b;", linesOmitted: 0 }],
		omitted: {
			signals: 0,
			waveTableRows: 0,
			waveTableChars: 0,
			codeSnippets: 0,
			contextChars: 0,
		},
	};
}

function sampleToolResult(): EdaToolRunResult {
	return {
		profile: "iverilog-vvp",
		stage: "sim",
		ok: false,
		commands: [],
		issues: [
			{
				kind: "sim_fail",
				severity: "error",
				tool: "vvp",
				message: "VERIGEN_SIM_FAIL mux2 y=0 expected=1",
			},
			{
				kind: "width_warning",
				severity: "warning",
				tool: "iverilog",
				message: "width warning",
			},
		],
	};
}

describe("S8 VeriGen context router", () => {
	test("combines KG, Playbook, Graphify, trace, and tool results under budget", async () => {
		const kg = buildSpecAnchoredKnowledgeGraph({
			nodes: [
				{ id: "module:mux2", type: "Module", name: "mux2", description: "2:1 mux" },
				{ id: "port:mux2.y", type: "Port", name: "y", metadata: { direction: "output", width: "8" } },
				{ id: "constraint:mux2", type: "Constraint", name: "select contract" },
			],
			edges: [
				{ source: "module:mux2", target: "port:mux2.y", type: "HAS_PORT" },
				{ source: "module:mux2", target: "constraint:mux2", type: "CONSTRAINED_BY" },
			],
		});
		const playbook: VerigenPlaybookProvider = {
			search: async (_query, options) => {
				assert.equal(options?.topK, 1);
				return [{ rule: defaultPlaybookRules[3], score: 0.9 }];
			},
		};
		const graphify: VerigenGraphifyProvider = {
			query: async (_query, maxResults) => {
				assert.equal(maxResults, 1);
				return {
					status: {
						enabled: true,
						state: "ready",
						graphPath: "graphify-out/graph.json",
						nodeCount: 3,
						edgeCount: 2,
					},
					query: "mux mismatch",
					nodes: [
						{
							id: "docs/ROADMAP-VeriGen.md",
							label: "ROADMAP",
							path: "docs/ROADMAP-VeriGen.md",
							score: 12,
							attributes: { raw: "not rendered" },
						},
					],
					omittedNodes: 2,
				};
			},
		};

		const context = await buildVerigenRoutedContext({
			task: "mux mismatch repair",
			role: "debugger",
			kg,
			kgSeeds: ["module:mux2"],
			playbook,
			graphify,
			trace: sampleTraceContext(),
			toolResults: [sampleToolResult()],
			budget: {
				maxPlaybookRules: 1,
				maxGraphifyNodes: 1,
				maxToolIssues: 1,
				maxSectionChars: 1_000,
			},
		});

		assert.deepEqual(
			context.sections.map((section) => section.kind),
			["kg", "playbook", "graphify", "trace", "tool"],
		);
		assert.match(context.rendered, /Spec KG/);
		assert.match(context.rendered, /tb-mismatch-wave-trace/);
		assert.match(context.rendered, /docs\/ROADMAP-VeriGen\.md/);
		assert.match(context.rendered, /controllers sel, a, b/);
		assert.match(context.rendered, /VERIGEN_SIM_FAIL/);
		assert.doesNotMatch(context.rendered, /not rendered/);
		assert.equal(context.sections.find((section) => section.kind === "graphify")?.omittedItems, 2);
		assert.equal(context.sections.find((section) => section.kind === "tool")?.omittedItems, 1);
	});

	test("drops whole sections when the total budget is exhausted", async () => {
		const playbook: VerigenPlaybookProvider = {
			search: async () => [{ rule: defaultPlaybookRules[0], score: 0.8 }],
		};
		const context = await buildVerigenRoutedContext({
			task: "fsm latch repair",
			role: "coder",
			playbook,
			trace: sampleTraceContext(),
			budget: { maxTotalChars: 80 },
		});

		assert.equal(context.sections.length, 0);
		assert.equal(context.omittedSections, 2);
		assert.ok(context.omittedChars > 0);
	});
});
