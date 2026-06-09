import type { DebuggerTraceContext } from "./context-router.ts";
import type { EdaToolRunResult } from "./eda-toolrunner.ts";
import type { GraphifyQueryResult } from "./graphify-context.ts";
import type { PlaybookSearchOptions, PlaybookSearchResult } from "./playbook-rag.ts";
import type { RelatedSubgraphResult, SpecAnchoredKnowledgeGraph } from "./spec-kg.ts";

export type VerigenContextRole = "planner" | "coder" | "verifier" | "debugger";

export type VerigenContextSectionKind = "kg" | "playbook" | "graphify" | "trace" | "tool";

export interface VerigenContextBudget {
	maxTotalChars?: number;
	maxSectionChars?: number;
	maxKgNodes?: number;
	maxPlaybookRules?: number;
	maxGraphifyNodes?: number;
	maxToolIssues?: number;
	maxTraceChars?: number;
}

export interface VerigenPlaybookProvider {
	search(query: string, options?: PlaybookSearchOptions): Promise<PlaybookSearchResult[]>;
}

export interface VerigenGraphifyProvider {
	query(query: string, maxResults?: number): Promise<GraphifyQueryResult>;
}

export interface BuildVerigenRoutedContextOptions {
	task: string;
	role: VerigenContextRole;
	kg?: SpecAnchoredKnowledgeGraph;
	kgSeeds?: string[];
	playbook?: VerigenPlaybookProvider;
	graphify?: VerigenGraphifyProvider;
	trace?: DebuggerTraceContext;
	toolResults?: EdaToolRunResult[];
	triggers?: string[];
	budget?: VerigenContextBudget;
}

export interface VerigenRoutedContextSection {
	kind: VerigenContextSectionKind;
	title: string;
	content: string;
	omittedItems: number;
	omittedChars: number;
}

export interface VerigenRoutedContext {
	task: string;
	role: VerigenContextRole;
	sections: VerigenRoutedContextSection[];
	rendered: string;
	omittedSections: number;
	omittedChars: number;
	budget: Required<VerigenContextBudget>;
}

const defaultBudget: Required<VerigenContextBudget> = {
	maxTotalChars: 8_000,
	maxSectionChars: 2_000,
	maxKgNodes: 12,
	maxPlaybookRules: 4,
	maxGraphifyNodes: 6,
	maxToolIssues: 8,
	maxTraceChars: 2_000,
};

function resolveBudget(budget?: VerigenContextBudget): Required<VerigenContextBudget> {
	return { ...defaultBudget, ...budget };
}

function truncateText(text: string, maxChars: number): { text: string; omittedChars: number } {
	if (text.length <= maxChars) return { text, omittedChars: 0 };
	const suffix = "\n[truncated]";
	const selectedLength = Math.max(0, maxChars - suffix.length);
	return {
		text: `${text.slice(0, selectedLength)}${suffix}`,
		omittedChars: text.length - selectedLength,
	};
}

function makeSection(
	kind: VerigenContextSectionKind,
	title: string,
	content: string,
	omittedItems: number,
	maxChars: number,
): VerigenRoutedContextSection {
	const trimmed = truncateText(content, maxChars);
	return {
		kind,
		title,
		content: trimmed.text,
		omittedItems,
		omittedChars: trimmed.omittedChars,
	};
}

function formatKgSubgraph(result: RelatedSubgraphResult): string {
	const nodeLines = result.nodes.map((node) => {
		const description = node.description ? `: ${node.description}` : "";
		return `- ${node.type} ${node.id} depth=${node.depth}${description}`;
	});
	const edgeLines = result.edges.map((edge) => `- ${edge.source} -${edge.type}-> ${edge.target}`);
	return ["KG nodes", ...nodeLines, "", "KG edges", ...edgeLines].join("\n");
}

function formatPlaybook(results: PlaybookSearchResult[]): string {
	return results
		.map((result) => {
			const checks = result.rule.check.map((item) => `  check: ${item}`).join("\n");
			return [
				`- ${result.rule.id} score=${result.score.toFixed(3)}`,
				`  title: ${result.rule.title}`,
				`  fix: ${result.rule.fix}`,
				checks,
			]
				.filter((line) => line.length > 0)
				.join("\n");
		})
		.join("\n");
}

function formatGraphify(result: GraphifyQueryResult): string {
	const status = `status=${result.status.state} nodes=${result.status.nodeCount} edges=${result.status.edgeCount}`;
	const nodes = result.nodes.map((node) => {
		const path = node.path ? ` path=${node.path}` : "";
		const summary = node.summary ? ` summary=${node.summary}` : "";
		return `- ${node.id} score=${node.score}${path}${summary}`;
	});
	return [`Graphify ${status}`, ...nodes].join("\n");
}

function formatTrace(context: DebuggerTraceContext): string {
	const signals = context.trace.map((trace) => {
		const controllers = trace.controllers.length > 0 ? trace.controllers.join(", ") : "none";
		return `- ${trace.signal}: controllers ${controllers}`;
	});
	const snippets = context.code_snippets.map((snippet) => {
		return `- ${snippet.signal} lines ${snippet.start_line}-${snippet.end_line}\n${snippet.code}`;
	});
	return [
		`mismatch_time=${context.mismatch_time ?? "unknown"}`,
		`mismatch_values=${JSON.stringify(context.mismatch_values)}`,
		"",
		"signals",
		...signals,
		"",
		"waveform",
		context.wave_table_hex,
		"",
		"snippets",
		...snippets,
	].join("\n");
}

function formatToolResults(results: EdaToolRunResult[], maxIssues: number): { content: string; omittedItems: number } {
	const issues = results.flatMap((result) =>
		result.issues.map((issue) => ({
			profile: result.profile,
			stage: result.stage,
			issue,
		})),
	);
	const selectedIssues = issues.slice(0, maxIssues);
	const lines = selectedIssues.map((item) => {
		const location = item.issue.file
			? `${item.issue.file}${item.issue.line ? `:${item.issue.line}` : ""}`
			: item.issue.tool;
		return `- ${item.profile}/${item.stage} ${item.issue.kind} ${location}: ${item.issue.message}`;
	});
	return {
		content: lines.join("\n"),
		omittedItems: Math.max(0, issues.length - selectedIssues.length),
	};
}

function finalizeSections(
	task: string,
	role: VerigenContextRole,
	sections: VerigenRoutedContextSection[],
	budget: Required<VerigenContextBudget>,
): VerigenRoutedContext {
	const selected: VerigenRoutedContextSection[] = [];
	let used = 0;
	let omittedSections = 0;
	let omittedChars = 0;
	for (const section of sections) {
		const header = `## ${section.title}\n`;
		const sectionSize = header.length + section.content.length + 2;
		if (used + sectionSize > budget.maxTotalChars) {
			omittedSections += 1;
			omittedChars += section.content.length;
			continue;
		}
		selected.push(section);
		used += sectionSize;
		omittedChars += section.omittedChars;
	}
	const rendered = selected.map((section) => `## ${section.title}\n${section.content}`).join("\n\n");
	return {
		task,
		role,
		sections: selected,
		rendered,
		omittedSections,
		omittedChars,
		budget,
	};
}

export async function buildVerigenRoutedContext(
	options: BuildVerigenRoutedContextOptions,
): Promise<VerigenRoutedContext> {
	const budget = resolveBudget(options.budget);
	const sections: VerigenRoutedContextSection[] = [];

	if (options.kg && options.kgSeeds && options.kgSeeds.length > 0) {
		const result = options.kg.relatedSubgraph({
			seeds: options.kgSeeds,
			maxDepth: 2,
			maxNodes: budget.maxKgNodes,
			direction: "both",
		});
		sections.push(
			makeSection("kg", "Spec KG", formatKgSubgraph(result), result.omittedNodes, budget.maxSectionChars),
		);
	}

	if (options.playbook) {
		const results = await options.playbook.search(options.task, {
			topK: budget.maxPlaybookRules,
			triggers: options.triggers,
		});
		sections.push(makeSection("playbook", "Playbook", formatPlaybook(results), 0, budget.maxSectionChars));
	}

	if (options.graphify) {
		const result = await options.graphify.query(options.task, budget.maxGraphifyNodes);
		sections.push(
			makeSection("graphify", "Graphify", formatGraphify(result), result.omittedNodes, budget.maxSectionChars),
		);
	}

	if (options.trace) {
		sections.push(makeSection("trace", "Trace", formatTrace(options.trace), 0, budget.maxTraceChars));
	}

	if (options.toolResults && options.toolResults.length > 0) {
		const formatted = formatToolResults(options.toolResults, budget.maxToolIssues);
		sections.push(
			makeSection("tool", "Tool Results", formatted.content, formatted.omittedItems, budget.maxSectionChars),
		);
	}

	return finalizeSections(options.task, options.role, sections, budget);
}
