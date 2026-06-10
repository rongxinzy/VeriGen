import type {
	CodegenProbeGenerationResult,
	CodegenProbeModuleContract,
	CodegenQualityProbeCase,
	RunCodegenQualityProbeOptions,
} from "./quality-probe.ts";
import { generateCodegenQualityProbeRtl, normalizeGeneratedRtl } from "./quality-probe.ts";

export interface TaskDagNode {
	id: string;
	signal: string;
	description: string;
	dependsOn: string[];
	checks: string[];
	rtl?: string;
}

export interface TaskDag {
	moduleName: string;
	moduleContract: CodegenProbeModuleContract;
	nodes: TaskDagNode[];
	spec: string;
}

export interface SignalContext {
	signal: string;
	rtl: string;
}

function formatPorts(contract: CodegenProbeModuleContract): string {
	return contract.ports.map((p) => `  ${p.direction} ${p.name} width=${p.width} -- ${p.description}`).join("\n");
}

function scriptedSnippet(caseId: string, taskId: string): string | undefined {
	if (caseId === "l0-mux2" && taskId === "task:y") {
		return "  assign y = sel ? a : b;";
	}
	if (caseId === "l0-priority-encoder" && taskId === "task:valid") {
		return "  assign valid = |in;";
	}
	if (caseId === "l0-priority-encoder" && taskId === "task:idx") {
		return [
			"  always @* begin",
			"    idx = 2'd0;",
			"    if (in[3]) idx = 2'd3;",
			"    else if (in[2]) idx = 2'd2;",
			"    else if (in[1]) idx = 2'd1;",
			"    else idx = 2'd0;",
			"  end",
		].join("\n");
	}
	if (caseId === "l1-counter" && taskId === "task:q") {
		return [
			"  always @(posedge clk) begin",
			"    if (rst) q <= 8'h00;",
			"    else if (en) q <= q + 8'h01;",
			"  end",
		].join("\n");
	}
	if (caseId === "l1-shift-register" && taskId === "task:q") {
		return [
			"  always @(posedge clk) begin",
			"    if (clr) q <= 8'h00;",
			"    else q <= {q[6:0], din};",
			"  end",
		].join("\n");
	}
	return undefined;
}

export function buildPlannerPrompt(probeCase: CodegenQualityProbeCase): string {
	const contract = probeCase.moduleContract;
	const portLines = contract.ports
		.map((p) => `  ${p.direction} ${p.name} width=${p.width} -- ${p.description}`)
		.join("\n");
	return [
		"You are VeriGen Planner. Analyze the following module specification and produce a signal-level task DAG.",
		"",
		`Task: ${probeCase.title}`,
		`Spec: ${probeCase.spec}`,
		"",
		"Module contract:",
		`module: ${contract.moduleName}`,
		portLines,
		contract.clock ? `clock: ${contract.clock}` : "",
		contract.reset ? `reset: ${contract.reset}` : "",
		"",
		"Notes:",
		...contract.notes.map((n) => `  ${n}`),
		"",
		"Return a JSON array of task objects. Each task has: id (unique), signal (output signal name), description (one line), dependsOn (array of signal names this depends on), checks (array of verification checks).",
		"",
		"Example:",
		'[{"id":"task:y","signal":"y","description":"mux output","dependsOn":["a","b","sel"],"checks":["combinational","no latch"]}]',
		"",
		"Return ONLY the JSON array, no markdown fences, no explanation.",
	]
		.filter(Boolean)
		.join("\n");
}

function parsePlannerResponse(raw: string): TaskDagNode[] {
	const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();
	try {
		const parsed = JSON.parse(cleaned);
		if (!Array.isArray(parsed)) throw new Error("not an array");
		return parsed.map((item: Record<string, unknown>, index: number) => ({
			id: typeof item.id === "string" ? item.id : `task:${index}`,
			signal: typeof item.signal === "string" ? item.signal : `signal_${index}`,
			description: typeof item.description === "string" ? item.description : "",
			dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
			checks: Array.isArray(item.checks) ? item.checks.map(String) : [],
		}));
	} catch {
		return [];
	}
}

export async function generateTaskDagViaLlm(
	probeCase: CodegenQualityProbeCase,
	options: RunCodegenQualityProbeOptions,
): Promise<TaskDag> {
	const prompt = buildPlannerPrompt(probeCase);
	const result = await generateCodegenQualityProbeRtl(prompt, options);
	const llmNodes = parsePlannerResponse(result.generatedRtl);
	const contract = probeCase.moduleContract;

	if (llmNodes.length === 0) {
		return buildTaskDag(probeCase);
	}

	return {
		moduleName: contract.moduleName,
		moduleContract: contract,
		nodes: llmNodes,
		spec: probeCase.spec,
	};
}

export function buildTaskDag(probeCase: CodegenQualityProbeCase): TaskDag {
	const contract = probeCase.moduleContract;
	const outputPorts = contract.ports.filter((p) => p.direction === "output");
	const inputPorts = contract.ports.filter((p) => p.direction === "input");

	const nodes: TaskDagNode[] = [];

	for (const port of outputPorts) {
		const isSequential = contract.clock !== undefined && port.name !== contract.clock && port.name !== contract.reset;
		const dependsOnBase = inputPorts
			.filter((p) => {
				if (p.name === port.name) return false;
				if (p.name === contract.clock || p.name === contract.reset) {
					return isSequential;
				}
				if (isSequential) {
					return p.name === contract.clock || p.name === contract.reset || true;
				}
				return true;
			})
			.map((p) => p.name);

		const specHints: string[] = [];
		if (isSequential) {
			specHints.push(`Use posedge ${contract.clock}.`);
			if (contract.reset) {
				specHints.push(`Synchronous active-high ${contract.reset} has priority.`);
			}
		}
		for (const note of contract.notes) {
			if (note.toLowerCase().includes(port.name.toLowerCase())) {
				specHints.push(note);
			}
		}

		nodes.push({
			id: `task:${port.name}`,
			signal: port.name,
			description: port.description,
			dependsOn: dependsOnBase,
			checks: [
				`${port.name} width is ${port.width}`,
				...(isSequential
					? ["Sequential assignment (nonblocking)", "Reset value is 0"]
					: ["Combinational", "No latch"]),
			],
		});
	}

	const clockPort = contract.clock ? contract.ports.find((p) => p.name === contract.clock) : undefined;
	const resetPort = contract.reset ? contract.ports.find((p) => p.name === contract.reset) : undefined;
	const internalDep: string[] = [];
	if (clockPort) internalDep.push(clockPort.name);
	if (resetPort) internalDep.push(resetPort.name);

	if (nodes.length === 0 && clockPort) {
		nodes.push({
			id: "task:clock",
			signal: contract.clock!,
			description: clockPort.description,
			dependsOn: [],
			checks: ["Clock declaration"],
		});
	}
	if (nodes.length === 0 && resetPort) {
		nodes.push({
			id: "task:reset",
			signal: contract.reset!,
			description: resetPort.description,
			dependsOn: [],
			checks: ["Reset declaration"],
		});
	}

	return {
		moduleName: contract.moduleName,
		moduleContract: contract,
		nodes,
		spec: probeCase.spec,
	};
}

export function topologicalSort(nodes: TaskDagNode[]): TaskDagNode[] {
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	for (const node of nodes) {
		inDegree.set(node.id, 0);
		adjacency.set(node.id, []);
	}

	for (const node of nodes) {
		for (const depSignal of node.dependsOn) {
			const depNode = nodes.find((n) => n.signal === depSignal);
			if (depNode) {
				adjacency.get(depNode.id)!.push(node.id);
				inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
			}
		}
	}

	const queue: string[] = [];
	for (const [id, degree] of inDegree) {
		if (degree === 0) queue.push(id);
	}

	const sorted: TaskDagNode[] = [];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const node = nodeMap.get(current);
		if (node) sorted.push(node);
		for (const neighbor of adjacency.get(current) ?? []) {
			const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) queue.push(neighbor);
		}
	}

	const remaining = nodes.filter((n) => !sorted.find((s) => s.id === n.id));
	return [...sorted, ...remaining];
}

export function buildModuleHeader(contract: CodegenProbeModuleContract): string {
	const ports = contract.ports.map((p) => `  ${p.direction} ${p.width === "1" ? "" : `[${p.width}] `}${p.name}`);
	const portList = ports.join(",\n");
	return `module ${contract.moduleName} (\n${portList}\n);`;
}

export function buildPortDeclarations(contract: CodegenProbeModuleContract): string {
	const lines: string[] = [];
	for (const port of contract.ports) {
		const width = port.width === "1" ? "" : ` [${port.width}]`;
		const reg = port.direction === "output" && contract.clock !== undefined ? "reg " : "";
		lines.push(`  ${reg}${port.direction}${width} ${port.name};`);
	}
	const clockPort = contract.clock;
	if (clockPort && !contract.ports.find((p) => p.direction === "output" && p.name !== clockPort)) {
		return lines.join("\n");
	}
	for (const port of contract.ports) {
		if (port.direction === "output" && port.name !== contract.clock && port.name !== contract.reset) {
			const isSeq = contract.clock !== undefined;
			if (isSeq) {
				const idx = lines.findIndex((l) => l.includes(port.name));
				if (idx >= 0) {
					lines[idx] = `  output reg [${port.width}] ${port.name};`;
				}
			}
		}
	}
	return lines.join("\n");
}

export function buildIncrementalPrompt(dag: TaskDag, node: TaskDagNode, completedSignals: SignalContext[]): string {
	const completedRtl = completedSignals.map((s) => `// signal: ${s.signal}\n${s.rtl}`).join("\n\n");
	const dependencyLines = node.dependsOn.length > 0 ? `Depends on: ${node.dependsOn.join(", ")}` : "No dependencies.";

	return [
		`You are generating signal \`${node.signal}\` of module \`${dag.moduleName}\`.`,
		"",
		"Module contract:",
		formatPorts(dag.moduleContract),
		"",
		`Spec: ${dag.spec}`,
		"",
		dependencyLines,
		`Signal description: ${node.description}`,
		"",
		"Checks:",
		...node.checks.map((c) => `- ${c}`),
		"",
		"Already generated signals:",
		completedSignals.length > 0 ? completedRtl : "(none yet)",
		"",
		"Generate ONLY the Verilog code for signal `{signal}`. Do NOT include the module header, port declarations, or endmodule.",
		"Return only the always block, assign statement, or reg/wire declaration needed for this signal.",
		"Do not include markdown fences.",
	].join("\n");
}

export function assembleRtl(
	moduleName: string,
	ports: CodegenProbeModuleContract["ports"],
	signalRtl: SignalContext[],
): string {
	const header = `module ${moduleName} (`;
	const portNames = ports.map((p) => `  ${p.direction} ${p.width === "1" ? "" : `[${p.width}] `}${p.name}`);
	const portDecl = `${header}\n${portNames.join(",\n")}\n);`;

	const declarations: string[] = [];
	const bodies: string[] = [];

	for (const port of ports) {
		const width = port.width === "1" ? "" : ` [${port.width}]`;
		const isSeqOutput = port.direction === "output" && signalRtl.some((s) => s.rtl.includes("always @(posedge"));
		if (port.direction === "output") {
			const style =
				isSeqOutput || signalRtl.some((s) => s.signal === port.name && s.rtl.includes("always"))
					? `output reg${width} ${port.name};`
					: `output wire${width} ${port.name};`;
			declarations.push(`  ${style}`);
		} else {
			declarations.push(`  input${width} ${port.name};`);
		}
	}

	for (const sr of signalRtl) {
		if (sr.rtl.trim()) {
			bodies.push(sr.rtl.trim());
		}
	}

	return [portDecl, "", declarations.join("\n"), "", bodies.join("\n\n"), "", "endmodule"].join("\n");
}

function scriptedDagRtl(caseId: string, dag: TaskDag): string {
	const sorted = topologicalSort(dag.nodes);
	const signalRtl: SignalContext[] = [];
	for (const node of sorted) {
		const snippet = scriptedSnippet(caseId, node.id);
		if (snippet) {
			signalRtl.push({ signal: node.signal, rtl: snippet });
		}
	}
	return assembleRtl(dag.moduleName, dag.moduleContract.ports, signalRtl);
}

export async function generateRtlViaDag(
	probeCase: CodegenQualityProbeCase,
	options: RunCodegenQualityProbeOptions & { plannerLlm?: boolean } = {},
): Promise<CodegenProbeGenerationResult> {
	const dag =
		options.live && options.plannerLlm ? await generateTaskDagViaLlm(probeCase, options) : buildTaskDag(probeCase);

	if (!options.live) {
		return {
			llm: { provider: "anthropic", baseUrl: "", model: "", apiKeyConfigured: false },
			generatedRtl: scriptedDagRtl(probeCase.id, dag),
		};
	}

	const sorted = topologicalSort(dag.nodes);
	const completedSignals: SignalContext[] = [];
	let lastLlmConfig: CodegenProbeGenerationResult["llm"] = {
		provider: "anthropic",
		baseUrl: "",
		model: "",
		apiKeyConfigured: false,
	};

	for (const node of sorted) {
		const prompt = buildIncrementalPrompt(dag, node, completedSignals);
		const result = await generateCodegenQualityProbeRtl(prompt, options);
		lastLlmConfig = result.llm;
		const normalized = normalizeGeneratedRtl(result.generatedRtl);
		completedSignals.push({ signal: node.signal, rtl: normalized });
	}

	const assembled = assembleRtl(dag.moduleName, dag.moduleContract.ports, completedSignals);
	return { llm: lastLlmConfig, generatedRtl: assembled };
}
