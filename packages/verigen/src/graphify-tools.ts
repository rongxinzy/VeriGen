import { inspect } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { GraphifyContext } from "./graphify-context.ts";

const statusSchema = Type.Object({});

const querySchema = Type.Object({
	query: Type.String({ description: "Natural language search query to find relevant nodes in the graph" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 8)" })),
});

const explainSchema = Type.Object({
	idOrPath: Type.String({
		description: "Node id, file path, or label to explain — shows its neighbors and edges",
	}),
	maxNeighbors: Type.Optional(Type.Number({ description: "Maximum number of neighbors to return (default: 8)" })),
});

const pathSchema = Type.Object({
	source: Type.String({ description: "Starting node id or path" }),
	target: Type.String({ description: "Target node id or path" }),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum search depth (default: 4)" })),
});

const updateSchema = Type.Object({
	target: Type.Optional(Type.String({ description: "Directory to scan for the graph index (default: repo root)" })),
});

export type GraphifyStatusInput = Static<typeof statusSchema>;
export type GraphifyQueryInput = Static<typeof querySchema>;
export type GraphifyExplainInput = Static<typeof explainSchema>;
export type GraphifyPathInput = Static<typeof pathSchema>;
export type GraphifyUpdateInput = Static<typeof updateSchema>;

function createGraphifyContext(ctx: { cwd: string }): GraphifyContext {
	return new GraphifyContext({ repoRoot: ctx.cwd });
}

export function createGraphifyStatusToolDefinition(): ToolDefinition<typeof statusSchema> {
	return defineTool({
		name: "graphify-status",
		label: "Graphify Status",
		description:
			"Check whether the repo/docs context graph index exists, is stale, or is ready. Graphify must be ready before query, explain, or path work.",
		promptSnippet: "Check Graphify index status",
		promptGuidelines: [
			"Before searching the graph, call this tool to verify the index is ready.",
			"If the index is stale or missing, run graphify-update first.",
		],
		parameters: statusSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const gctx = createGraphifyContext(ctx);
			const status = await gctx.status();
			return {
				content: [{ type: "text", text: inspect(status, { colors: false, depth: null }) }],
				details: undefined,
			};
		},
	});
}

export function createGraphifyQueryToolDefinition(): ToolDefinition<typeof querySchema> {
	return defineTool({
		name: "graphify-query",
		label: "Graphify Query",
		description:
			"Search the repo/docs context graph with a natural language query. Returns the most relevant nodes (files, functions, doc sections) with relevance scores. Use to locate source files, prompts, Playbook rules, design docs, or cross-file relationships.",
		promptSnippet: "Search the repo/docs context graph",
		promptGuidelines: [
			"Use graphify-query to find relevant code files, prompts, docs, or rules instead of grepping blindly.",
			"The graph covers the whole repo and design documents; ask specific questions about what you need.",
		],
		parameters: querySchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gctx = createGraphifyContext(ctx);
			const result = await gctx.query(params.query, params.maxResults);
			return {
				content: [{ type: "text", text: inspect(result, { colors: false, depth: null }) }],
				details: undefined,
			};
		},
	});
}

export function createGraphifyExplainToolDefinition(): ToolDefinition<typeof explainSchema> {
	return defineTool({
		name: "graphify-explain",
		label: "Graphify Explain",
		description:
			"Show the neighbors and edges of a specific node (file, function, doc section) in the repo/docs context graph. Use to understand how a file or concept relates to others.",
		promptSnippet: "Show a node's relationships in the graph",
		parameters: explainSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gctx = createGraphifyContext(ctx);
			const result = await gctx.explain(params.idOrPath, params.maxNeighbors);
			return {
				content: [{ type: "text", text: inspect(result, { colors: false, depth: null }) }],
				details: undefined,
			};
		},
	});
}

export function createGraphifyPathToolDefinition(): ToolDefinition<typeof pathSchema> {
	return defineTool({
		name: "graphify-path",
		label: "Graphify Path",
		description:
			"Find a connection path between two nodes in the repo/docs context graph. Useful for discovering indirect relationships, dependency chains, or trace paths between files and concepts.",
		promptSnippet: "Find a path between two nodes in the graph",
		parameters: pathSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gctx = createGraphifyContext(ctx);
			const result = await gctx.path(params.source, params.target, params.maxDepth);
			return {
				content: [{ type: "text", text: inspect(result, { colors: false, depth: null }) }],
				details: undefined,
			};
		},
	});
}

export function createGraphifyUpdateToolDefinition(): ToolDefinition<typeof updateSchema> {
	return defineTool({
		name: "graphify-update",
		label: "Graphify Update",
		description:
			"Rebuild the repo/docs context graph index by scanning the repository. Must be run when the index is stale, missing, or after file changes. This tool uses bundled uvx when available.",
		promptSnippet: "Rebuild the Graphify context graph index",
		promptGuidelines: [
			"Run graphify-update before graphify-query if the index is stale or missing.",
			"The update spawns an external process and may take several seconds.",
		],
		parameters: updateSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gctx = createGraphifyContext(ctx);
			const result = await gctx.update(params.target);
			return {
				content: [{ type: "text", text: inspect(result, { colors: false, depth: null }) }],
				details: undefined,
			};
		},
	});
}
