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
import { createProductWorkbenchStatusPanelPiTuiComponent } from "./s15-product-tui.ts";
import {
	createProductWorkbenchModel,
	type ProductWorkbenchModel,
	type ProductWorkbenchOptions,
} from "./s15-product-workbench.ts";

export const VERIGEN_WORKBENCH_CUSTOM_TYPE = "verigen.product-workbench";
export const VERIGEN_PHASE_CONTEXT_CUSTOM_TYPE = "verigen.phase-context";
export const VERIGEN_RULE_CONTEXT_CUSTOM_TYPE = "verigen.rule-context";
export const VERIGEN_KIMI_PROVIDER_ID = "verigen-kimi";
export const VERIGEN_DEFAULT_MODEL_ID = "kimi-for-coding";
export const VERIGEN_DEFAULT_BASE_URL = "http://172.18.5.179:3000";

type VerigenExpertPhase = "planner" | "coder" | "verifier" | "debugger";

interface VerigenPhaseProfile {
	name: VerigenExpertPhase;
	instructions: string[];
}

interface VerigenPlaybookRule {
	id: string;
	phases: VerigenExpertPhase[];
	triggers: string[];
	summary: string;
	checks: string[];
}

interface VerigenContextInjection {
	content: string;
	ruleIds: string[];
}

interface VerigenPhaseContextDetails {
	phase: VerigenExpertPhase;
	query: string;
	ruleIds: string[];
}

interface VerigenRuleContextDetails {
	query: string;
	ruleIds: string[];
}

export interface VerigenBeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
}

export interface VerigenBeforeAgentStartResult {
	message?: {
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	};
}

export type VerigenExtensionEvent = { type: "session_start" } | { type: "turn_end" } | VerigenBeforeAgentStartEvent;

export type VerigenExtensionHandlerResult = undefined | VerigenBeforeAgentStartResult;

const phaseAliases: Record<string, VerigenExpertPhase> = {
	plan: "planner",
	planner: "planner",
	code: "coder",
	coder: "coder",
	implement: "coder",
	verify: "verifier",
	verifier: "verifier",
	debug: "debugger",
	debugger: "debugger",
	repair: "debugger",
};

const phaseProfiles: Record<VerigenExpertPhase, VerigenPhaseProfile> = {
	planner: {
		name: "planner",
		instructions: [
			"Produce a module contract before RTL: ports, widths, clock/reset behavior, invariants, and assumptions.",
			"Build a small task DAG and identify the KG nodes or source files that constrain the work.",
			"Use Graphify for repo or docs navigation; avoid loading whole repositories or broad raw specs.",
		],
	},
	coder: {
		name: "coder",
		instructions: [
			"Implement the smallest RTL diff that satisfies the contract and existing module interface.",
			"Use explicit widths, localparam states, nonblocking sequential assignments, and synthesizable SystemVerilog subsets.",
			"Do not invent ports, rename interfaces, or change reset/clock semantics without an explicit contract update.",
		],
	},
	verifier: {
		name: "verifier",
		instructions: [
			"Run or request the narrowest relevant lint, simulation, formal, or synth check.",
			"Report compile_error, sim_fail, width_warning, synth_fail, or missing_tool with file, line, and command evidence.",
			"On simulation mismatch, require deterministic trace context before proposing RTL repair.",
		],
	},
	debugger: {
		name: "debugger",
		instructions: [
			"Start from the tool issue and trace signal controller chain, not from speculation.",
			"Propose the smallest repair tied to a contract item, playbook rule, KG node, or traced signal.",
			"After each repair, rerun the narrow verification command that exposed the failure.",
		],
	},
};

const playbookRules: VerigenPlaybookRule[] = [
	{
		id: "fsm-localparam-case",
		phases: ["planner", "coder", "verifier", "debugger"],
		triggers: ["fsm", "state", "case", "latch", "localparam", "default"],
		summary: "Represent FSM states with explicit localparams and cover every state transition in a full case.",
		checks: [
			"Every state has a declared encoding width.",
			"Combinational next-state logic has defaults before the case.",
			"Unreachable or illegal states have an explicit recovery path.",
		],
	},
	{
		id: "width-explicit-casts",
		phases: ["planner", "coder", "verifier", "debugger"],
		triggers: ["width", "cast", "truncation", "extension", "signed", "vector", "overflow"],
		summary: "Make width extension, truncation, and signedness conversions explicit at assignment boundaries.",
		checks: [
			"Assignment RHS width matches the destination width or uses an explicit slice/concat/cast.",
			"Signed math operands are deliberately signed or deliberately unsigned.",
			"Tool width warnings are treated as verifier issues until explained.",
		],
	},
	{
		id: "seq-nonblocking",
		phases: ["coder", "verifier", "debugger"],
		triggers: ["always_ff", "posedge", "negedge", "sequential", "nonblocking", "blocking", "reset"],
		summary: "Use nonblocking assignments in sequential logic and keep reset behavior contract-aligned.",
		checks: [
			"Clocked blocks use nonblocking assignments for registers.",
			"Reset polarity and sync/async behavior match the module contract.",
			"No combinational temporary assignment is accidentally promoted to state.",
		],
	},
	{
		id: "tb-mismatch-wave-trace",
		phases: ["verifier", "debugger"],
		triggers: ["testbench", "mismatch", "wave", "vcd", "trace", "dut", "reference", "sim"],
		summary: "For DUT/reference mismatches, inspect the trimmed waveform and controller chain before editing RTL.",
		checks: [
			"Mismatch time, expected value, actual value, and signal name are captured.",
			"Trace context includes controlling signals and nearby RTL snippets.",
			"The proposed fix explains why the traced controller caused the mismatch.",
		],
	},
	{
		id: "tool-subset-sv",
		phases: ["planner", "coder", "verifier"],
		triggers: ["iverilog", "verilator", "yosys", "systemverilog", "syntax", "unsupported", "synth"],
		summary: "Target the project tool subset instead of unsupported SystemVerilog features.",
		checks: [
			"Generated syntax is accepted by the configured simulator/linter.",
			"Non-synthesizable constructs stay inside testbench files.",
			"Fallback syntax is preferred over clever constructs when tool support is uncertain.",
		],
	},
];

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
		event: "session_start" | "turn_end" | "before_agent_start",
		handler: (
			event: VerigenExtensionEvent,
			ctx: ExtensionContext,
		) => VerigenExtensionHandlerResult | Promise<VerigenExtensionHandlerResult>,
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

function tokenizeQuery(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^a-z0-9_+-]+/)
		.map((term) => term.trim())
		.filter((term) => term.length > 1);
}

function parsePhaseArgs(args: string): { phase?: VerigenExpertPhase; query: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const phaseToken = parts[0]?.toLowerCase();
	if (!phaseToken) return { query: "" };
	const phase = phaseAliases[phaseToken];
	if (!phase) return { query: parts.join(" ") };
	return { phase, query: parts.slice(1).join(" ") };
}

function scoreRule(rule: VerigenPlaybookRule, phase: VerigenExpertPhase | undefined, terms: string[]): number {
	let score = phase && rule.phases.includes(phase) ? 3 : 0;
	const searchable = `${rule.id} ${rule.summary} ${rule.triggers.join(" ")} ${rule.checks.join(" ")}`.toLowerCase();
	for (const term of terms) {
		if (rule.triggers.includes(term)) {
			score += 3;
		} else if (rule.id.includes(term)) {
			score += 2;
		} else if (searchable.includes(term)) {
			score += 1;
		}
	}
	return score;
}

function retrievePlaybookRules(
	phase: VerigenExpertPhase | undefined,
	query: string,
	limit: number,
): VerigenPlaybookRule[] {
	const terms = tokenizeQuery(query);
	const scored = playbookRules
		.map((rule, index) => ({
			rule,
			index,
			score: scoreRule(rule, phase, terms),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	const selected = scored.length > 0 ? scored : playbookRules.map((rule, index) => ({ rule, index, score: 0 }));
	return selected.slice(0, limit).map((entry) => entry.rule);
}

function renderRuleLines(rules: VerigenPlaybookRule[]): string[] {
	const lines: string[] = [];
	for (const rule of rules) {
		lines.push(`- id: ${rule.id}`);
		lines.push(`  apply: ${rule.summary}`);
		lines.push(`  checks: ${rule.checks.join("; ")}`);
	}
	return lines;
}

function buildPhaseContextInjection(phase: VerigenExpertPhase, query: string): VerigenContextInjection {
	const profile = phaseProfiles[phase];
	const rules = retrievePlaybookRules(phase, query, 3);
	const lines = [
		"<verigen_phase_context>",
		`phase: ${profile.name}`,
		`task: ${query || "current conversation task"}`,
		"phase_instructions:",
		...profile.instructions.map((instruction) => `- ${instruction}`),
		"selected_playbook_rules:",
		...renderRuleLines(rules),
		"context_policy:",
		"- Use this block only for the current phase.",
		"- Keep output concise and tie RTL changes to contract, KG, tool, trace, or rule evidence.",
		"</verigen_phase_context>",
	];
	return {
		content: lines.join("\n"),
		ruleIds: rules.map((rule) => rule.id),
	};
}

function buildRuleContextInjection(query: string): VerigenContextInjection {
	const rules = retrievePlaybookRules(undefined, query, 4);
	const lines = [
		"<verigen_rule_context>",
		`query: ${query}`,
		"selected_playbook_rules:",
		...renderRuleLines(rules),
		"context_policy:",
		"- Treat these rules as retrieved guidance for the current task, not as global standing instructions.",
		"</verigen_rule_context>",
	];
	return {
		content: lines.join("\n"),
		ruleIds: rules.map((rule) => rule.id),
	};
}

function hasAnyTerm(terms: Set<string>, candidates: string[]): boolean {
	for (const candidate of candidates) {
		if (terms.has(candidate)) return true;
	}
	return false;
}

function inferPhaseForPrompt(prompt: string): VerigenExpertPhase | undefined {
	const trimmed = prompt.trim();
	if (!trimmed || trimmed.startsWith("/")) return undefined;
	const terms = new Set(tokenizeQuery(trimmed));
	const isVerigenRelevant = hasAnyTerm(terms, [
		"rtl",
		"verilog",
		"systemverilog",
		"module",
		"port",
		"ports",
		"fsm",
		"width",
		"waveform",
		"vcd",
		"testbench",
		"dut",
		"synth",
		"iverilog",
		"verilator",
		"yosys",
	]);
	if (!isVerigenRelevant) return undefined;
	if (
		hasAnyTerm(terms, ["debug", "fix", "repair", "fail", "failure", "mismatch", "waveform", "vcd", "trace", "broken"])
	) {
		return "debugger";
	}
	if (hasAnyTerm(terms, ["verify", "test", "sim", "simulation", "lint", "synth", "formal", "run"])) {
		return "verifier";
	}
	if (hasAnyTerm(terms, ["implement", "write", "generate", "code", "rtl", "module", "assign", "always_ff"])) {
		return "coder";
	}
	if (hasAnyTerm(terms, ["plan", "spec", "contract", "interface", "ports", "requirements", "kg", "dag"])) {
		return "planner";
	}
	return undefined;
}

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
	if (width < 56) return "RTL | tests | traces | FPGA";
	return "RTL, testbench, waveform debug, and FPGA bring-up.";
}

function commandHint(width: number): string {
	if (width < 56) return "/verigen-models | /verigen-workbench";
	return "Setup: /verigen-models   Dashboard: /verigen-workbench show";
}

function renderVerigenStartupHeader(theme: Theme, width: number): string[] {
	const columns = Math.max(1, width);
	const compact = columns < 52;
	const title = compact ? "Verilog coding agent" : "Verilog-specialized coding agent";
	return [
		theme.fg("accent", centerLine(`VERIGEN  ${title}`, columns)),
		theme.fg("dim", centerLine(mutedHint(columns), columns)),
		theme.fg("dim", centerLine(commandHint(columns), columns)),
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

function mountWorkbench(
	ctx: ExtensionContext,
	model: ProductWorkbenchModel,
	options: VerigenCodingAgentExtensionOptions,
	expanded: boolean,
): boolean {
	if (ctx.mode !== "tui") return false;
	const resolved = extensionOptions(options);
	ctx.ui.setWidget(
		resolved.widgetKey,
		() =>
			asDisposableComponent(
				createProductWorkbenchStatusPanelPiTuiComponent(model, {
					expanded,
					height: resolved.height,
				}),
			),
		{ placement: resolved.widgetPlacement },
	);
	ctx.ui.setStatus(resolved.statusKey, statusText(model));
	return true;
}

function clearWorkbench(ctx: ExtensionContext, options: VerigenCodingAgentExtensionOptions): void {
	const resolved = extensionOptions(options);
	ctx.ui.setWidget(resolved.widgetKey, undefined, { placement: resolved.widgetPlacement });
	ctx.ui.setStatus(resolved.statusKey, undefined);
}

function commandUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		"Usage: /verigen-workbench show|details|summary|hide|toggle|snapshot (open and close also work)",
		"info",
	);
}

function phaseCommandUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /verigen-phase planner|coder|verifier|debugger [task]", "info");
}

function rulesCommandUsage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /verigen-rules <query>", "info");
}

function modelSetupNotice(): string {
	return "No VeriGen model is ready. Run /verigen-models or set VERIGEN_TEST_LLM_API_KEY.";
}

function statusText(model: ProductWorkbenchModel): string {
	if (model.status === "ready") return "VeriGen ready";
	if (model.status === "blocked") return "VeriGen blocked";
	return "VeriGen setup";
}

function modelSetupGuide(env: NodeJS.ProcessEnv = process.env): string {
	const modelId = env.VERIGEN_TEST_LLM_MODEL?.trim() || VERIGEN_DEFAULT_MODEL_ID;
	const baseUrl = env.VERIGEN_TEST_LLM_BASE_URL?.trim() || VERIGEN_DEFAULT_BASE_URL;
	return [
		"VeriGen model setup",
		`Model: ${VERIGEN_KIMI_PROVIDER_ID}/${modelId}`,
		`Endpoint: ${baseUrl}`,
		"Interactive: /login -> Use an API key -> VeriGen Kimi.",
		"Environment: set VERIGEN_TEST_LLM_API_KEY before starting verigen.",
		"Optional: VERIGEN_TEST_LLM_BASE_URL and VERIGEN_TEST_LLM_MODEL.",
	].join("\n");
}

export function installVerigenCodingAgentExtension(
	pi: VerigenWorkbenchExtensionApi,
	options: VerigenCodingAgentExtensionOptions = {},
): void {
	let visible = extensionOptions(options).autoMount;
	let expanded = false;
	const currentModel = productWorkbenchModel(options);
	pi.registerProvider(VERIGEN_KIMI_PROVIDER_ID, verigenProviderConfig(extensionOptions(options).env));

	pi.registerTool(createGraphifyStatusToolDefinition());
	pi.registerTool(createGraphifyQueryToolDefinition());
	pi.registerTool(createGraphifyExplainToolDefinition());
	pi.registerTool(createGraphifyPathToolDefinition());
	pi.registerTool(createGraphifyUpdateToolDefinition());

	pi.registerMessageRenderer<ProductWorkbenchModel>(VERIGEN_WORKBENCH_CUSTOM_TYPE, (message) => {
		const model = isProductWorkbenchModel(message.details) ? message.details : productWorkbenchModel(options);
		return createProductWorkbenchStatusPanelPiTuiComponent(model, {
			expanded: true,
			height: extensionOptions(options).height,
		});
	});

	pi.registerCommand("verigen-phase", {
		description: "Inject a VeriGen phase prompt and relevant playbook rules for the current task",
		handler: async (args, ctx) => {
			const parsed = parsePhaseArgs(args);
			if (!parsed.phase) {
				phaseCommandUsage(ctx);
				return;
			}
			const injection = buildPhaseContextInjection(parsed.phase, parsed.query);
			pi.sendMessage<VerigenPhaseContextDetails>(
				{
					customType: VERIGEN_PHASE_CONTEXT_CUSTOM_TYPE,
					content: injection.content,
					display: false,
					details: {
						phase: parsed.phase,
						query: parsed.query,
						ruleIds: injection.ruleIds,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			ctx.ui.notify(
				`Injected VeriGen ${parsed.phase} context with ${injection.ruleIds.length} playbook rules.`,
				"info",
			);
		},
	});

	pi.registerCommand("verigen-rules", {
		description: "Retrieve and inject relevant VeriGen playbook rules",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				rulesCommandUsage(ctx);
				return;
			}
			const injection = buildRuleContextInjection(query);
			pi.sendMessage<VerigenRuleContextDetails>(
				{
					customType: VERIGEN_RULE_CONTEXT_CUSTOM_TYPE,
					content: injection.content,
					display: false,
					details: {
						query,
						ruleIds: injection.ruleIds,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			ctx.ui.notify(`Injected ${injection.ruleIds.length} VeriGen playbook rules.`, "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (event.type !== "before_agent_start") return undefined;
		const phase = inferPhaseForPrompt(event.prompt);
		if (!phase) return undefined;
		const injection = buildPhaseContextInjection(phase, event.prompt);
		return {
			message: {
				customType: VERIGEN_PHASE_CONTEXT_CUSTOM_TYPE,
				content: injection.content,
				display: false,
				details: {
					phase,
					query: event.prompt,
					ruleIds: injection.ruleIds,
				} satisfies VerigenPhaseContextDetails,
			},
		};
	});

	const hideWorkbench = (ctx: ExtensionContext): void => {
		visible = false;
		clearWorkbench(ctx, options);
		ctx.ui.notify("VeriGen status panel hidden.", "info");
	};

	const mountVisibleWorkbench = (ctx: ExtensionContext, notify: boolean): boolean => {
		const mounted = mountWorkbench(ctx, currentModel, options, expanded);
		if (!mounted) {
			ctx.ui.notify("VeriGen status panel is only available in TUI mode", "warning");
			return false;
		}
		if (notify) {
			const mode = expanded ? "details" : "summary";
			ctx.ui.notify(`VeriGen status panel open (${mode}). Use /verigen-workbench hide to close it.`, "info");
		}
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && extensionOptions(options).showHeader) {
			ctx.ui.setHeader((_tui, theme) => ({
				render: (width: number) => renderVerigenStartupHeader(theme, width),
				invalidate: () => {},
			}));
		}
		if (ctx.mode === "tui" && ctx.modelRegistry.getAvailable().length === 0) {
			ctx.ui.notify(modelSetupNotice(), "warning");
			if (!visible) {
				visible = true;
				expanded = false;
			}
		}
		if (!visible) return undefined;
		mountVisibleWorkbench(ctx, false);
		return undefined;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!visible) return undefined;
		mountVisibleWorkbench(ctx, false);
		return undefined;
	});

	pi.registerCommand("verigen-workbench", {
		description: "Show, hide, or snapshot the VeriGen S15 product workbench",
		handler: async (args, ctx) => {
			const rawAction = args.trim() || "toggle";
			const action = rawAction === "open" ? "show" : rawAction === "close" ? "hide" : rawAction;
			if (action === "show") {
				visible = true;
				expanded = false;
				mountVisibleWorkbench(ctx, true);
				return;
			}
			if (action === "details" || action === "expand") {
				visible = true;
				expanded = true;
				mountVisibleWorkbench(ctx, true);
				return;
			}
			if (action === "summary" || action === "collapse") {
				visible = true;
				expanded = false;
				mountVisibleWorkbench(ctx, true);
				return;
			}
			if (action === "hide") {
				hideWorkbench(ctx);
				return;
			}
			if (action === "toggle") {
				visible = !visible;
				if (visible) {
					expanded = false;
					mountVisibleWorkbench(ctx, true);
				} else {
					hideWorkbench(ctx);
				}
				return;
			}
			if (action === "snapshot") {
				pi.sendMessage(
					{
						customType: VERIGEN_WORKBENCH_CUSTOM_TYPE,
						content: "VeriGen S15 product workbench snapshot.",
						display: true,
						details: currentModel,
					},
					{ triggerTurn: false },
				);
				ctx.ui.notify("Workbench snapshot added to the conversation.", "info");
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
