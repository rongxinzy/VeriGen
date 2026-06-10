import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createProductWorkbenchPiTuiComponent } from "./s15-product-tui.ts";
import {
	createProductWorkbenchModel,
	type ProductWorkbenchModel,
	type ProductWorkbenchOptions,
} from "./s15-product-workbench.ts";

export const VERIGEN_WORKBENCH_CUSTOM_TYPE = "verigen.product-workbench";

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

export function installVerigenCodingAgentExtension(
	pi: VerigenWorkbenchExtensionApi,
	options: VerigenCodingAgentExtensionOptions = {},
): void {
	let visible = extensionOptions(options).autoMount;

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
}

export function createVerigenCodingAgentExtension(options: VerigenCodingAgentExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		installVerigenCodingAgentExtension(pi, options);
	};
}

export default function verigenCodingAgentExtension(pi: VerigenWorkbenchExtensionApi): void {
	installVerigenCodingAgentExtension(pi);
}
