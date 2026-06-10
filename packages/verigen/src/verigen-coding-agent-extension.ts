import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	MessageRenderer,
	ProviderConfig,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { createDefaultGraphifyContext } from "./graphify-context.ts";
import {
	createGraphifyExplainToolDefinition,
	createGraphifyPathToolDefinition,
	createGraphifyQueryToolDefinition,
	createGraphifyStatusToolDefinition,
	createGraphifyUpdateToolDefinition,
} from "./graphify-tools.ts";
import { createProductWorkbenchPiTuiComponent } from "./s15-product-tui.ts";
import {
	createProductWorkbenchModel,
	type ProductWorkbenchModel,
	type ProductWorkbenchOptions,
} from "./s15-product-workbench.ts";

export const VERIGEN_WORKBENCH_CUSTOM_TYPE = "verigen.product-workbench";
export const VERIGEN_KIMI_PROVIDER_ID = "verigen-kimi";
export const VERIGEN_DEFAULT_MODEL_ID = "kimi-for-coding";
export const VERIGEN_DEFAULT_BASE_URL = "http://172.18.5.179:3000";

export interface VerigenCodingAgentExtensionOptions {
	autoMount?: boolean;
	env?: ProductWorkbenchOptions["env"];
	height?: number;
	now?: string;
	showHeader?: boolean;
	statusKey?: string;
	widgetKey?: string;
	widgetPlacement?: "aboveEditor" | "belowEditor";
}

export interface VerigenWorkbenchExtensionCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface VerigenWorkbenchExtensionApi {
	on(
		event: "session_start" | "turn_end",
		handler: (event: { type: "session_start" } | { type: "turn_end" }, ctx: ExtensionContext) => void | Promise<void>,
	): void;
	registerCommand(name: string, options: VerigenWorkbenchExtensionCommand): void;
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
	registerProvider(name: string, config: ProviderConfig): void;
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;
	sendMessage<T = unknown>(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: T;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
}

function extensionOptions(options: VerigenCodingAgentExtensionOptions): Required<VerigenCodingAgentExtensionOptions> {
	return {
		autoMount: options.autoMount ?? false,
		env: options.env ?? process.env,
		height: options.height ?? 18,
		now: options.now ?? new Date().toISOString(),
		showHeader: options.showHeader ?? true,
		statusKey: options.statusKey ?? "verigen",
		widgetKey: options.widgetKey ?? "verigen-product-workbench",
		widgetPlacement: options.widgetPlacement ?? "belowEditor",
	};
}

function verigenProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
	const modelId = env.VERIGEN_TEST_LLM_MODEL?.trim() || VERIGEN_DEFAULT_MODEL_ID;
	const baseUrl = env.VERIGEN_TEST_LLM_BASE_URL?.trim() || VERIGEN_DEFAULT_BASE_URL;
	return {
		name: "VeriGen Kimi",
		baseUrl,
		apiKey: "$VERIGEN_TEST_LLM_API_KEY",
		api: "anthropic-messages",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	};
}

const verigenAsciiLogo = [
	"__     _______ ____  ___ ____ _____ _   _",
	"\\ \\   / / ____|  _ \\|_ _/ ___| ____| \\ | |",
	" \\ \\ / /|  _| | |_) || | |  _|  _| |  \\| |",
	"  \\ V / | |___|  _ < | | |_| | |___| |\\  |",
	"   \\_/  |_____|_| \\_\\___\\____|_____|_| \\_|",
];

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	if (line.length <= width) return line;
	if (width <= 1) return line.slice(0, width);
	return `${line.slice(0, width - 1)}~`;
}

function centerLine(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const padding = Math.max(0, Math.floor((width - fitted.length) / 2));
	return `${" ".repeat(padding)}${fitted}`;
}

function mutedHint(width: number): string {
	if (width < 56) return "RTL, tests, traces, FPGA bring-up.";
	return "Ask for RTL, testbenches, waveform debug, or FPGA bring-up.";
}

function dashboardHint(width: number): string {
	if (width < 56) return "/verigen-workbench show";
	return "/verigen-workbench show opens the engineering dashboard.";
}

function renderVerigenStartupHeader(theme: Theme, width: number): string[] {
	const columns = Math.max(1, width);
	const compact = columns < 52;
	const logoLines = compact ? ["VERIGEN"] : verigenAsciiLogo;
	const title = compact ? "Verilog coding agent" : "Verilog-specialized coding agent";
	return [
		"",
		...logoLines.map((line) => theme.fg("accent", centerLine(line, columns))),
		theme.fg("muted", centerLine(title, columns)),
		theme.fg("dim", centerLine(mutedHint(columns), columns)),
		theme.fg("dim", centerLine(dashboardHint(columns), columns)),
		"",
	];
}

function productWorkbenchModel(options: VerigenCodingAgentExtensionOptions): ProductWorkbenchModel {
	const resolved = extensionOptions(options);
	return createProductWorkbenchModel({
		env: resolved.env,
		now: resolved.now,
	});
}

function isProductWorkbenchModel(value: unknown): value is ProductWorkbenchModel {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<ProductWorkbenchModel>;
	return (
		candidate.title === "VeriGen Product Workbench" &&
		typeof candidate.status === "string" &&
		typeof candidate.provider === "object" &&
		Array.isArray(candidate.pipelineNavigator) &&
		Array.isArray(candidate.inspectorTabs) &&
		typeof candidate.layout === "object"
	);
}

function asDisposableComponent(component: Component): Component & { dispose?(): void } {
	return component;
}

function mountWorkbench(ctx: ExtensionContext, options: VerigenCodingAgentExtensionOptions): boolean {
	if (ctx.mode !== "tui") return false;
	const resolved = extensionOptions(options);
	ctx.ui.setWidget(
		resolved.widgetKey,
		() =>
			asDisposableComponent(
				createProductWorkbenchPiTuiComponent(productWorkbenchModel(options), {
					height: resolved.height,
				}),
			),
		{ placement: resolved.widgetPlacement },
	);
	ctx.ui.setStatus(resolved.statusKey, "VeriGen S15 workbench");
	return true;
}

function clearWorkbench(ctx: ExtensionContext, options: VerigenCodingAgentExtensionOptions): void {
	const resolved = extensionOptions(options);
	ctx.ui.setWidget(resolved.widgetKey, undefined, { placement: resolved.widgetPlacement });
	ctx.ui.setStatus(resolved.statusKey, undefined);
}

function commandUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /verigen-workbench show|hide|toggle|snapshot", "info");
}

function modelSetupGuide(env: NodeJS.ProcessEnv = process.env): string {
	const modelId = env.VERIGEN_TEST_LLM_MODEL?.trim() || VERIGEN_DEFAULT_MODEL_ID;
	const baseUrl = env.VERIGEN_TEST_LLM_BASE_URL?.trim() || VERIGEN_DEFAULT_BASE_URL;
	return [
		"VeriGen model setup",
		`Default model: ${VERIGEN_KIMI_PROVIDER_ID}/${modelId}`,
		`Endpoint: ${baseUrl}`,
		"Interactive setup: run /login, choose Use an API key, select VeriGen Kimi, then paste the API key.",
		"Environment setup: set VERIGEN_TEST_LLM_API_KEY before starting verigen.",
		"Optional overrides: VERIGEN_TEST_LLM_BASE_URL and VERIGEN_TEST_LLM_MODEL.",
	].join("\n");
}

export function installVerigenCodingAgentExtension(
	pi: VerigenWorkbenchExtensionApi,
	options: VerigenCodingAgentExtensionOptions = {},
): void {
	let visible = extensionOptions(options).autoMount;
	pi.registerProvider(VERIGEN_KIMI_PROVIDER_ID, verigenProviderConfig(extensionOptions(options).env));

	pi.registerTool(createGraphifyStatusToolDefinition());
	pi.registerTool(createGraphifyQueryToolDefinition());
	pi.registerTool(createGraphifyExplainToolDefinition());
	pi.registerTool(createGraphifyPathToolDefinition());
	pi.registerTool(createGraphifyUpdateToolDefinition());

	pi.registerMessageRenderer<ProductWorkbenchModel>(VERIGEN_WORKBENCH_CUSTOM_TYPE, (message) => {
		const model = isProductWorkbenchModel(message.details) ? message.details : productWorkbenchModel(options);
		return createProductWorkbenchPiTuiComponent(model, { height: extensionOptions(options).height });
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && extensionOptions(options).showHeader) {
			ctx.ui.setHeader((_tui, theme) => ({
				render: (width: number) => renderVerigenStartupHeader(theme, width),
				invalidate: () => {},
			}));
		}
		if (ctx.mode === "tui" && ctx.modelRegistry.getAvailable().length === 0) {
			ctx.ui.notify(modelSetupGuide(extensionOptions(options).env), "warning");
		}
		if (!visible) return;
		mountWorkbench(ctx, options);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!visible) return;
		mountWorkbench(ctx, options);
	});

	pi.registerCommand("verigen-workbench", {
		description: "Show, hide, or snapshot the VeriGen S15 product workbench",
		handler: async (args, ctx) => {
			const action = args.trim() || "toggle";
			if (action === "show") {
				visible = true;
				if (!mountWorkbench(ctx, options))
					ctx.ui.notify("VeriGen workbench is only available in TUI mode", "warning");
				return;
			}
			if (action === "hide") {
				visible = false;
				clearWorkbench(ctx, options);
				return;
			}
			if (action === "toggle") {
				visible = !visible;
				if (visible) {
					if (!mountWorkbench(ctx, options))
						ctx.ui.notify("VeriGen workbench is only available in TUI mode", "warning");
				} else {
					clearWorkbench(ctx, options);
				}
				return;
			}
			if (action === "snapshot") {
				pi.sendMessage(
					{
						customType: VERIGEN_WORKBENCH_CUSTOM_TYPE,
						content: "VeriGen S15 product workbench snapshot.",
						display: true,
						details: productWorkbenchModel(options),
					},
					{ triggerTurn: false },
				);
				return;
			}
			commandUsage(ctx);
		},
	});

	pi.registerCommand("verigen-models", {
		description: "Show VeriGen model setup guidance",
		handler: async (_args, ctx) => {
			ctx.ui.notify(modelSetupGuide(extensionOptions(options).env), "info");
		},
	});

	pi.registerCommand("init", {
		description:
			"Initialize the project: build the Graphify context graph and generate AGENTS.md with a navigation map",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const candidates = [".claude/CLAUDE.md", "CLAUDE.md", "AGENTS.md"];
			const existing = candidates.find((name) => existsSync(join(cwd, name)));
			const targetName = existing ?? "AGENTS.md";
			const targetPath = join(cwd, targetName);
			const force = args.trim() === "--force";

			if (existing && !force) {
				const ok = await ctx.ui.confirm(
					"Overwrite?",
					`${targetName} already exists. Overwrite it? Use /init --force to skip this prompt.`,
				);
				if (!ok) {
					ctx.ui.notify("init cancelled", "info");
					return;
				}
			}

			ctx.ui.notify("Building Graphify context graph...", "info");

			const gctx = createDefaultGraphifyContext(cwd);
			const updateResult = await gctx.update();
			if (!updateResult.ok) {
				ctx.ui.notify(`Graphify update failed: ${updateResult.stderr.slice(0, 200)}`, "error");
				return;
			}

			const gitignorePath = join(cwd, ".gitignore");
			const gitignoreLine = "graphify-out/";
			const gitignoreContent = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";
			const hasGitignoreEntry = gitignoreContent
				.split("\n")
				.some((line) => line.trim() === gitignoreLine || line.trim() === "graphify-out");
			if (!hasGitignoreEntry) {
				const separator = gitignoreContent.length > 0 && !gitignoreContent.endsWith("\n") ? "\n" : "";
				await writeFile(gitignorePath, `${gitignoreContent}${separator}${gitignoreLine}\n`, "utf8");
			}

			const status = await gctx.status();
			const topNodes = (await gctx.query("source test doc config readme package", 20)).nodes;
			const docNodes = (await gctx.query("documentation spec architecture design guide", 10)).nodes;
			const allNodeIds = new Set<string>();
			for (const node of [...topNodes, ...docNodes]) {
				allNodeIds.add(node.id);
			}

			let packageScripts = "";
			const pkgPath = join(cwd, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkgText = await readFile(pkgPath, "utf8");
					const pkg = JSON.parse(pkgText);
					const scripts = pkg.scripts as Record<string, string> | undefined;
					if (scripts) {
						const entries = Object.entries(scripts)
							.filter(([name]) => !name.startsWith("pre") && !name.startsWith("post"))
							.slice(0, 10);
						if (entries.length > 0) {
							packageScripts = entries.map(([name, cmd]) => `- \`${name}\`: ${cmd}`).join("\n");
						}
					}
				} catch {
					// ignore
				}
			}

			const mapLines: string[] = [];
			for (const node of [...topNodes, ...docNodes]) {
				const path = node.path ? ` (\`${node.path}\`)` : "";
				const summary = node.summary ? ` — ${node.summary}` : "";
				mapLines.push(`- \`${node.id}\`${path}${summary}`);
			}

			const lines: string[] = [
				"# Agent Instructions",
				"",
				`> Auto-generated by \`/init\` on ${new Date().toISOString().slice(0, 10)}.`,
				`> Graphify index: ${status.nodeCount} nodes, ${status.edgeCount} edges.`,
				`> Run \`/init\` again after significant project changes to rebuild this map.`,
				"",
				"## Graphify Navigation",
				"",
				"Graphify is a repo/docs context graph that helps you navigate this project.",
				"Use these tools to explore the codebase before reading files directly:",
				"",
				"- `graphify-status` — check whether the graph index is ready",
				'- `graphify-query` — search the graph by natural language (e.g. `graphify-query query: "where are the tests"`)',
				"- `graphify-explain` — explore relationships around a file or concept",
				"- `graphify-path` — find indirect connections between two nodes",
				"- `graphify-update` — rebuild the index after file changes",
				"",
			];

			if (packageScripts) {
				lines.push("## Common Commands", "", packageScripts, "");
			}

			lines.push("## Project Map", "");
			if (mapLines.length > 0) {
				lines.push(...mapLines);
			} else {
				lines.push("_Run `graphify-query` to discover the project structure._");
			}
			lines.push("");

			await writeFile(targetPath, `${lines.join("\n")}\n`, "utf8");
			ctx.ui.notify(`Wrote ${targetName} (${status.nodeCount} graph nodes, ${status.edgeCount} edges)`, "info");
		},
	});
}

export function createVerigenCodingAgentExtension(options: VerigenCodingAgentExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		installVerigenCodingAgentExtension(pi, options);
	};
}

export default function verigenCodingAgentExtension(pi: VerigenWorkbenchExtensionApi): void {
	installVerigenCodingAgentExtension(pi);
}
