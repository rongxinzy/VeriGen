import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
	defaultPlaybookRules,
	executableName,
	GraphifyContext,
	PlaybookRag,
	resolveGraphifyUpdateCommand,
	SpecAnchoredKnowledgeGraph,
} from "../src/index.ts";

describe("SpecAnchoredKnowledgeGraph", () => {
	test("retrieves a related subgraph and validates module port contracts", () => {
		const kg = new SpecAnchoredKnowledgeGraph({
			nodes: [
				{ id: "module:i2c_master", type: "Module", name: "i2c_master" },
				{ id: "port:clk", type: "Port", name: "clk", metadata: { direction: "input", width: "1" } },
				{ id: "port:scl", type: "Port", name: "scl", metadata: { direction: "output", width: "1" } },
				{ id: "signal:state", type: "Signal", name: "state", description: "FSM state register" },
				{ id: "constraint:reset", type: "Constraint", name: "active-low reset" },
			],
			edges: [
				{ source: "module:i2c_master", target: "port:clk", type: "HAS_PORT" },
				{ source: "module:i2c_master", target: "port:scl", type: "HAS_PORT" },
				{ source: "signal:state", target: "port:scl", type: "DRIVES" },
				{ source: "signal:state", target: "constraint:reset", type: "CONSTRAINED_BY" },
			],
		});

		const context = kg.relatedSubgraph({ seeds: ["port:scl"], maxDepth: 2 });
		assert.ok(context.nodes.some((node) => node.id === "module:i2c_master"));
		assert.ok(context.nodes.some((node) => node.id === "signal:state"));

		const validation = kg.validateModuleContract("module:i2c_master", [
			{ name: "clk", direction: "input", width: "1" },
			{ name: "scl", direction: "output", width: "1" },
		]);
		assert.equal(validation.ok, true);

		const invalid = kg.validateModuleContract("module:i2c_master", [
			{ name: "clk", direction: "output", width: "1" },
			{ name: "extra", direction: "input", width: "1" },
		]);
		assert.equal(invalid.ok, false);
		assert.ok(invalid.violations.some((violation) => violation.kind === "direction_mismatch"));
		assert.ok(invalid.violations.some((violation) => violation.kind === "missing_port"));
		assert.ok(invalid.violations.some((violation) => violation.kind === "extra_port"));
	});
});

describe("PlaybookRag", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("indexes default Verilog playbook rules and retrieves task-relevant repairs", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-playbook-"));
		tempDirs.push(tempDir);
		const rag = new PlaybookRag(join(tempDir, "index"));
		await rag.indexRules(defaultPlaybookRules);

		const results = await rag.search("state machine inferred latch in next state case", {
			topK: 3,
			triggers: ["fsm", "latch"],
		});

		assert.ok(results.length > 0);
		assert.equal(results[0]?.rule.id, "fsm-localparam-case");
		assert.ok(results[0]?.score && results[0].score > 0);
	});
});

describe("GraphifyContext", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("reads graphify-out graph.json for autonomous query, explain, and path operations", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-graphify-"));
		tempDirs.push(tempDir);
		const graphDir = join(tempDir, "graphify-out");
		mkdirSync(graphDir, { recursive: true });
		const graphPath = join(graphDir, "graph.json");
		writeFileSync(
			graphPath,
			JSON.stringify({
				nodes: [
					{ id: "docs/PDD-VeriGen.md", label: "PDD", type: "doc", path: "docs/PDD-VeriGen.md" },
					{
						id: ".pi/prompts/verigen-coder.md",
						label: "Coder prompt",
						type: "prompt",
						path: ".pi/prompts/verigen-coder.md",
					},
					{
						id: "packages/verigen/src/spec-kg.ts",
						label: "Spec KG",
						type: "code",
						path: "packages/verigen/src/spec-kg.ts",
					},
				],
				edges: [
					{ source: "docs/PDD-VeriGen.md", target: ".pi/prompts/verigen-coder.md", label: "DESCRIBES" },
					{ source: ".pi/prompts/verigen-coder.md", target: "packages/verigen/src/spec-kg.ts", label: "USES" },
				],
			}),
		);

		const graphify = new GraphifyContext({ repoRoot: tempDir, graphPath });
		const status = await graphify.status();
		assert.equal(status.state, "ready");
		assert.equal(status.nodeCount, 3);

		const query = await graphify.query("coder prompt kg");
		assert.equal(query.nodes[0]?.id, ".pi/prompts/verigen-coder.md");

		const explain = await graphify.explain(".pi/prompts/verigen-coder.md");
		assert.equal(explain.node?.label, "Coder prompt");
		assert.equal(explain.neighbors.length, 2);

		const path = await graphify.path("docs/PDD-VeriGen.md", "packages/verigen/src/spec-kg.ts");
		assert.equal(path.found, true);
		assert.deepEqual(
			path.nodes.map((node) => node.id),
			["docs/PDD-VeriGen.md", ".pi/prompts/verigen-coder.md", "packages/verigen/src/spec-kg.ts"],
		);
	});

	test("prefers bundled uvx for graphify updates", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-graphify-uvx-"));
		tempDirs.push(tempDir);
		const packageRoot = join(tempDir, "package");
		const toolDir = join(packageRoot, "dist", "native-tools", `${process.platform}-${process.arch}`);
		mkdirSync(toolDir, { recursive: true });
		const bundledUvx = join(toolDir, executableName("uvx"));
		writeFileSync(bundledUvx, "");

		assert.equal(resolveGraphifyUpdateCommand(packageRoot), bundledUvx);
	});
});
