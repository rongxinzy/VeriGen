import { DirectedGraph } from "graphology";
import { z } from "zod";

export const specKgNodeTypes = [
	"Module",
	"Port",
	"Signal",
	"StateTransition",
	"SignalExample",
	"Constraint",
	"Task",
] as const;

export const specKgEdgeTypes = [
	"INSTANTIATES",
	"HAS_PORT",
	"DRIVES",
	"IMPLEMENTS",
	"STATETRANSITION",
	"EXAMPLES",
	"CONSTRAINED_BY",
] as const;

export const SpecKgNodeSchema = z.object({
	id: z.string().min(1),
	type: z.enum(specKgNodeTypes),
	name: z.string().min(1),
	description: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SpecKgEdgeSchema = z.object({
	id: z.string().min(1).optional(),
	source: z.string().min(1),
	target: z.string().min(1),
	type: z.enum(specKgEdgeTypes),
	description: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SpecKgInputSchema = z.object({
	nodes: z.array(SpecKgNodeSchema),
	edges: z.array(SpecKgEdgeSchema),
});

export type SpecKgNodeType = (typeof specKgNodeTypes)[number];
export type SpecKgEdgeType = (typeof specKgEdgeTypes)[number];
export type SpecKgNodeInput = z.infer<typeof SpecKgNodeSchema>;
export type SpecKgEdgeInput = z.infer<typeof SpecKgEdgeSchema>;
export type SpecKgInput = z.infer<typeof SpecKgInputSchema>;

export interface SpecKgNodeAttributes {
	type: SpecKgNodeType;
	name: string;
	description?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface SpecKgEdgeAttributes {
	type: SpecKgEdgeType;
	description?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface RelatedSubgraphOptions {
	seeds: string[];
	maxDepth?: number;
	nodeTypes?: SpecKgNodeType[];
	direction?: "in" | "out" | "both";
	maxNodes?: number;
}

export interface RelatedSubgraphResult {
	seeds: string[];
	nodes: Array<SpecKgNodeInput & { depth: number }>;
	edges: SpecKgEdgeInput[];
	omittedNodes: number;
}

export interface PortContractViolation {
	kind: "missing_module" | "missing_port" | "extra_port" | "direction_mismatch" | "width_mismatch";
	moduleId: string;
	portName?: string;
	expected?: string | null;
	actual?: string | null;
}

export interface InstancePortContract {
	name: string;
	direction?: string | null;
	width?: string | null;
}

export interface ModuleContractValidation {
	ok: boolean;
	violations: PortContractViolation[];
}

function edgeKey(edge: SpecKgEdgeInput): string {
	return edge.id ?? `${edge.source}->${edge.target}:${edge.type}`;
}

function nodeFromAttributes(
	id: string,
	attributes: SpecKgNodeAttributes,
	depth: number,
): SpecKgNodeInput & { depth: number } {
	return {
		id,
		type: attributes.type,
		name: attributes.name,
		description: attributes.description,
		metadata: attributes.metadata,
		depth,
	};
}

function edgeFromGraph(key: string, attributes: SpecKgEdgeAttributes, source: string, target: string): SpecKgEdgeInput {
	return {
		id: key,
		source,
		target,
		type: attributes.type,
		description: attributes.description,
		metadata: attributes.metadata,
	};
}

function portMetadataValue(node: SpecKgNodeInput, key: string): string | null {
	const value = node.metadata?.[key];
	return typeof value === "string" ? value : null;
}

export class SpecAnchoredKnowledgeGraph {
	private graph: DirectedGraph<SpecKgNodeAttributes, SpecKgEdgeAttributes>;

	constructor(input?: SpecKgInput) {
		this.graph = new DirectedGraph<SpecKgNodeAttributes, SpecKgEdgeAttributes>({ allowSelfLoops: false });
		if (input) {
			this.import(input);
		}
	}

	addNode(node: SpecKgNodeInput): void {
		const parsed = SpecKgNodeSchema.parse(node);
		this.graph.mergeNode(parsed.id, {
			type: parsed.type,
			name: parsed.name,
			description: parsed.description,
			metadata: parsed.metadata,
		});
	}

	addEdge(edge: SpecKgEdgeInput): void {
		const parsed = SpecKgEdgeSchema.parse(edge);
		if (!this.graph.hasNode(parsed.source)) {
			throw new Error(`Spec KG edge source not found: ${parsed.source}`);
		}
		if (!this.graph.hasNode(parsed.target)) {
			throw new Error(`Spec KG edge target not found: ${parsed.target}`);
		}
		this.graph.mergeDirectedEdgeWithKey(edgeKey(parsed), parsed.source, parsed.target, {
			type: parsed.type,
			description: parsed.description,
			metadata: parsed.metadata,
		});
	}

	import(input: SpecKgInput): void {
		const parsed = SpecKgInputSchema.parse(input);
		for (const node of parsed.nodes) {
			this.addNode(node);
		}
		for (const edge of parsed.edges) {
			this.addEdge(edge);
		}
	}

	export(): SpecKgInput {
		const nodes: SpecKgNodeInput[] = [];
		this.graph.forEachNode((id, attributes) => {
			nodes.push(nodeFromAttributes(id, attributes, 0));
		});

		const edges: SpecKgEdgeInput[] = [];
		this.graph.forEachEdge((key, attributes, source, target) => {
			edges.push(edgeFromGraph(key, attributes, source, target));
		});

		return { nodes, edges };
	}

	getNode(id: string): SpecKgNodeInput | undefined {
		if (!this.graph.hasNode(id)) return undefined;
		const attributes = this.graph.getNodeAttributes(id);
		return nodeFromAttributes(id, attributes, 0);
	}

	relatedSubgraph(options: RelatedSubgraphOptions): RelatedSubgraphResult {
		const maxDepth = options.maxDepth ?? 2;
		const maxNodes = options.maxNodes ?? 24;
		const allowedTypes = options.nodeTypes ? new Set(options.nodeTypes) : undefined;
		const direction = options.direction ?? "both";
		const queue: Array<{ id: string; depth: number }> = [];
		const depths = new Map<string, number>();

		for (const seed of options.seeds) {
			if (!this.graph.hasNode(seed)) continue;
			queue.push({ id: seed, depth: 0 });
			depths.set(seed, 0);
		}

		for (let index = 0; index < queue.length; index += 1) {
			const current = queue[index];
			if (!current || current.depth >= maxDepth) continue;

			const neighbors =
				direction === "in"
					? this.graph.inNeighbors(current.id)
					: direction === "out"
						? this.graph.outNeighbors(current.id)
						: [...this.graph.inNeighbors(current.id), ...this.graph.outNeighbors(current.id)];

			for (const neighbor of neighbors) {
				if (depths.has(neighbor)) continue;
				depths.set(neighbor, current.depth + 1);
				queue.push({ id: neighbor, depth: current.depth + 1 });
			}
		}

		const selected = [...depths.entries()]
			.map(([id, depth]) => ({ id, depth, attributes: this.graph.getNodeAttributes(id) }))
			.filter((item) => !allowedTypes || allowedTypes.has(item.attributes.type))
			.sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
		const limited = selected.slice(0, maxNodes);
		const selectedIds = new Set(limited.map((item) => item.id));
		const nodes = limited.map((item) => nodeFromAttributes(item.id, item.attributes, item.depth));

		const edges: SpecKgEdgeInput[] = [];
		this.graph.forEachEdge((key, attributes, source, target) => {
			if (selectedIds.has(source) && selectedIds.has(target)) {
				edges.push(edgeFromGraph(key, attributes, source, target));
			}
		});

		return {
			seeds: options.seeds,
			nodes,
			edges,
			omittedNodes: Math.max(0, selected.length - limited.length),
		};
	}

	validateModuleContract(moduleId: string, instancePorts: InstancePortContract[]): ModuleContractValidation {
		if (!this.graph.hasNode(moduleId)) {
			return { ok: false, violations: [{ kind: "missing_module", moduleId }] };
		}

		const expectedPorts = this.relatedSubgraph({
			seeds: [moduleId],
			maxDepth: 1,
			direction: "out",
			nodeTypes: ["Port"],
			maxNodes: 128,
		}).nodes;
		const expectedByName = new Map(expectedPorts.map((port) => [port.name, port]));
		const actualByName = new Map(instancePorts.map((port) => [port.name, port]));
		const violations: PortContractViolation[] = [];

		for (const expected of expectedPorts) {
			const actual = actualByName.get(expected.name);
			if (!actual) {
				violations.push({ kind: "missing_port", moduleId, portName: expected.name });
				continue;
			}
			const expectedDirection = portMetadataValue(expected, "direction");
			const expectedWidth = portMetadataValue(expected, "width");
			if (expectedDirection && actual.direction && expectedDirection !== actual.direction) {
				violations.push({
					kind: "direction_mismatch",
					moduleId,
					portName: expected.name,
					expected: expectedDirection,
					actual: actual.direction,
				});
			}
			if (expectedWidth && actual.width && expectedWidth !== actual.width) {
				violations.push({
					kind: "width_mismatch",
					moduleId,
					portName: expected.name,
					expected: expectedWidth,
					actual: actual.width,
				});
			}
		}

		for (const actual of instancePorts) {
			if (!expectedByName.has(actual.name)) {
				violations.push({ kind: "extra_port", moduleId, portName: actual.name });
			}
		}

		return { ok: violations.length === 0, violations };
	}
}

export function buildSpecAnchoredKnowledgeGraph(input: SpecKgInput): SpecAnchoredKnowledgeGraph {
	return new SpecAnchoredKnowledgeGraph(input);
}
