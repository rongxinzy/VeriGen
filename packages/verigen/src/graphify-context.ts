import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	currentVerigenPackageRoot,
	executableName,
	findBundledNativeTool,
	installBundledNativeTools,
} from "./native-tools.ts";

export interface GraphifyContextOptions {
	repoRoot: string;
	graphPath?: string;
	staleAfterMs?: number;
	maxResults?: number;
	packageRoot?: string;
	uvxCommand?: string;
}

export interface GraphifyStatus {
	enabled: true;
	state: "ready" | "stale_or_missing_index" | "invalid_index";
	graphPath: string;
	nodeCount: number;
	edgeCount: number;
	mtimeMs?: number;
	message?: string;
}

export interface GraphifyNode {
	id: string;
	label: string;
	type?: string;
	path?: string;
	summary?: string;
	attributes: Record<string, unknown>;
}

export interface GraphifyEdge {
	source: string;
	target: string;
	label?: string;
	attributes: Record<string, unknown>;
}

export interface GraphifyQueryResult {
	status: GraphifyStatus;
	query: string;
	nodes: Array<GraphifyNode & { score: number }>;
	omittedNodes: number;
}

export interface GraphifyExplainResult {
	status: GraphifyStatus;
	node?: GraphifyNode;
	neighbors: GraphifyNode[];
	edges: GraphifyEdge[];
}

export interface GraphifyPathResult {
	status: GraphifyStatus;
	source: string;
	target: string;
	nodes: GraphifyNode[];
	edges: GraphifyEdge[];
	found: boolean;
}

export interface GraphifyUpdateResult {
	ok: boolean;
	command: string;
	args: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

interface GraphifyGraph {
	nodes: GraphifyNode[];
	edges: GraphifyEdge[];
}

interface ResolvedGraphifyContextOptions {
	repoRoot: string;
	graphPath: string;
	staleAfterMs: number;
	maxResults: number;
	packageRoot: string;
	uvxCommand?: string;
}

export function resolveGraphifyUpdateCommand(packageRoot: string, uvxCommand?: string): string {
	return uvxCommand ?? findBundledNativeTool(packageRoot, "uvx") ?? executableName("uvx");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function attributesText(attributes: Record<string, unknown>): string {
	return Object.values(attributes)
		.filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		.join(" ");
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((token) => token.length > 1);
}

function normalizeNode(raw: unknown, fallbackId: string): GraphifyNode | undefined {
	if (!isRecord(raw)) return undefined;
	const id =
		stringValue(raw.id) ?? stringValue(raw.key) ?? stringValue(raw.name) ?? stringValue(raw.path) ?? fallbackId;
	const label = stringValue(raw.label) ?? stringValue(raw.name) ?? stringValue(raw.title) ?? id;
	return {
		id,
		label,
		type: stringValue(raw.type) ?? stringValue(raw.kind),
		path: stringValue(raw.path) ?? stringValue(raw.file),
		summary: stringValue(raw.summary) ?? stringValue(raw.description),
		attributes: raw,
	};
}

function normalizeNodes(rawNodes: unknown): GraphifyNode[] {
	if (Array.isArray(rawNodes)) {
		return rawNodes
			.map((node, index) => normalizeNode(node, String(index)))
			.filter((node): node is GraphifyNode => Boolean(node));
	}
	if (isRecord(rawNodes)) {
		return Object.entries(rawNodes)
			.map(([id, node]) => normalizeNode(node, id))
			.filter((node): node is GraphifyNode => Boolean(node));
	}
	return [];
}

function normalizeEdge(raw: unknown): GraphifyEdge | undefined {
	if (!isRecord(raw)) return undefined;
	const source = stringValue(raw.source) ?? stringValue(raw.from) ?? stringValue(raw.src);
	const target = stringValue(raw.target) ?? stringValue(raw.to) ?? stringValue(raw.dst);
	if (!source || !target) return undefined;
	return {
		source,
		target,
		label: stringValue(raw.label) ?? stringValue(raw.type) ?? stringValue(raw.kind),
		attributes: raw,
	};
}

function normalizeEdges(rawEdges: unknown): GraphifyEdge[] {
	if (!Array.isArray(rawEdges)) return [];
	return rawEdges.map(normalizeEdge).filter((edge): edge is GraphifyEdge => Boolean(edge));
}

function normalizeGraph(raw: unknown): GraphifyGraph {
	if (!isRecord(raw)) return { nodes: [], edges: [] };
	const nodes = normalizeNodes(raw.nodes);
	const edges = normalizeEdges(raw.edges ?? raw.links);
	return { nodes, edges };
}

function scoreNode(queryTokens: string[], node: GraphifyNode): number {
	const text = [node.id, node.label, node.type, node.path, node.summary, attributesText(node.attributes)]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		if (text.includes(token)) score += token.length;
	}
	return score;
}

function findNode(nodes: GraphifyNode[], idOrPath: string): GraphifyNode | undefined {
	return nodes.find(
		(node) => node.id === idOrPath || node.path === idOrPath || node.label === idOrPath || node.id.endsWith(idOrPath),
	);
}

export class GraphifyContext {
	private options: ResolvedGraphifyContextOptions;

	constructor(options: GraphifyContextOptions) {
		this.options = {
			repoRoot: options.repoRoot,
			graphPath: options.graphPath ?? join(options.repoRoot, "graphify-out", "graph.json"),
			staleAfterMs: options.staleAfterMs ?? 24 * 60 * 60 * 1000,
			maxResults: options.maxResults ?? 8,
			packageRoot: options.packageRoot ? resolve(options.packageRoot) : currentVerigenPackageRoot(),
			...(options.uvxCommand ? { uvxCommand: options.uvxCommand } : {}),
		};
	}

	async status(): Promise<GraphifyStatus> {
		const graphPath = resolve(this.options.graphPath);
		try {
			const [fileStats, graph] = await Promise.all([stat(graphPath), this.loadGraph()]);
			const age = Date.now() - fileStats.mtimeMs;
			return {
				enabled: true,
				state: age > this.options.staleAfterMs ? "stale_or_missing_index" : "ready",
				graphPath,
				nodeCount: graph.nodes.length,
				edgeCount: graph.edges.length,
				mtimeMs: fileStats.mtimeMs,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				enabled: true,
				state: "stale_or_missing_index",
				graphPath,
				nodeCount: 0,
				edgeCount: 0,
				message,
			};
		}
	}

	async query(query: string, maxResults = this.options.maxResults): Promise<GraphifyQueryResult> {
		const [status, graph] = await Promise.all([this.status(), this.loadGraphOrEmpty()]);
		const queryTokens = tokenize(query);
		const scored = graph.nodes
			.map((node) => ({ ...node, score: scoreNode(queryTokens, node) }))
			.filter((node) => node.score > 0)
			.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
		const nodes = scored.slice(0, maxResults);
		return { status, query, nodes, omittedNodes: Math.max(0, scored.length - nodes.length) };
	}

	async explain(idOrPath: string, maxNeighbors = this.options.maxResults): Promise<GraphifyExplainResult> {
		const [status, graph] = await Promise.all([this.status(), this.loadGraphOrEmpty()]);
		const node = findNode(graph.nodes, idOrPath);
		if (!node) return { status, neighbors: [], edges: [] };

		const relatedEdges = graph.edges
			.filter((edge) => edge.source === node.id || edge.target === node.id)
			.slice(0, maxNeighbors);
		const neighborIds = new Set(relatedEdges.map((edge) => (edge.source === node.id ? edge.target : edge.source)));
		const neighbors = graph.nodes.filter((item) => neighborIds.has(item.id)).slice(0, maxNeighbors);
		return { status, node, neighbors, edges: relatedEdges };
	}

	async path(sourceIdOrPath: string, targetIdOrPath: string, maxDepth = 4): Promise<GraphifyPathResult> {
		const [status, graph] = await Promise.all([this.status(), this.loadGraphOrEmpty()]);
		const source = findNode(graph.nodes, sourceIdOrPath);
		const target = findNode(graph.nodes, targetIdOrPath);
		if (!source || !target) {
			return { status, source: sourceIdOrPath, target: targetIdOrPath, nodes: [], edges: [], found: false };
		}

		const queue: Array<{ id: string; path: string[] }> = [{ id: source.id, path: [source.id] }];
		const seen = new Set([source.id]);
		let foundPath: string[] | undefined;
		for (let index = 0; index < queue.length; index += 1) {
			const current = queue[index];
			if (!current || current.path.length > maxDepth + 1) continue;
			if (current.id === target.id) {
				foundPath = current.path;
				break;
			}
			const neighbors = graph.edges
				.filter((edge) => edge.source === current.id || edge.target === current.id)
				.map((edge) => (edge.source === current.id ? edge.target : edge.source));
			for (const neighbor of neighbors) {
				if (seen.has(neighbor)) continue;
				seen.add(neighbor);
				queue.push({ id: neighbor, path: [...current.path, neighbor] });
			}
		}

		if (!foundPath) {
			return { status, source: source.id, target: target.id, nodes: [], edges: [], found: false };
		}

		const pathSet = new Set(foundPath);
		const nodes = foundPath
			.map((id) => graph.nodes.find((node) => node.id === id))
			.filter((node): node is GraphifyNode => Boolean(node));
		const edges = graph.edges.filter((edge) => pathSet.has(edge.source) && pathSet.has(edge.target));
		return { status, source: source.id, target: target.id, nodes, edges, found: true };
	}

	async update(target = this.options.repoRoot): Promise<GraphifyUpdateResult> {
		if (!this.options.uvxCommand && !findBundledNativeTool(this.options.packageRoot, "uvx")) {
			try {
				await installBundledNativeTools({ packageRoot: this.options.packageRoot });
			} catch {
				// PATH uvx remains the fallback below.
			}
		}
		const command = resolveGraphifyUpdateCommand(this.options.packageRoot, this.options.uvxCommand);
		const args = ["--from", "graphifyy", "graphify", "update", target, "--no-cluster"];
		return await new Promise((resolvePromise) => {
			const child = spawn(command, args, {
				cwd: this.options.repoRoot,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				resolvePromise({ ok: false, command, args, exitCode: null, stdout, stderr: `${stderr}${error.message}` });
			});
			child.on("close", (exitCode) => {
				resolvePromise({ ok: exitCode === 0, command, args, exitCode, stdout, stderr });
			});
		});
	}

	private async loadGraph(): Promise<GraphifyGraph> {
		const text = await readFile(this.options.graphPath, "utf8");
		return normalizeGraph(JSON.parse(text));
	}

	private async loadGraphOrEmpty(): Promise<GraphifyGraph> {
		try {
			return await this.loadGraph();
		} catch {
			return { nodes: [], edges: [] };
		}
	}
}

export function createDefaultGraphifyContext(repoRoot: string): GraphifyContext {
	return new GraphifyContext({ repoRoot });
}
