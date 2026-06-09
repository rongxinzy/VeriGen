import type { Component } from "@earendil-works/pi-tui";
import {
	applyProductWorkbenchAction,
	type ProductWorkbenchModel,
	renderProductWorkbenchTui,
	type WorkbenchInteractionAction,
} from "./s15-product-workbench.ts";

export type ProductWorkbenchShellAction = WorkbenchInteractionAction | "quit";
export type ProductWorkbenchKeyId =
	| "tab"
	| "shift+tab"
	| "left"
	| "up"
	| "right"
	| "space"
	| "enter"
	| "r"
	| "e"
	| "q"
	| "escape"
	| "ctrl+c";

export interface ProductWorkbenchShellKeybinding {
	key: ProductWorkbenchKeyId;
	action: ProductWorkbenchShellAction;
	description: string;
}

export interface ProductWorkbenchTuiComponentOptions {
	height?: number;
	onExit?: (model: ProductWorkbenchModel) => void;
	onModelChange?: (model: ProductWorkbenchModel) => void;
}

export interface RunProductWorkbenchTuiOptions extends ProductWorkbenchTuiComponentOptions {
	width?: number;
}

export interface ProductWorkbenchPiTuiMount {
	id: "verigen.product-workbench";
	packageName: "@earendil-works/pi-tui";
	component: Component;
	keybindings: readonly ProductWorkbenchShellKeybinding[];
	notes: string[];
}

export const defaultProductWorkbenchShellKeybindings: readonly ProductWorkbenchShellKeybinding[] = [
	{ key: "q", action: "quit", description: "Quit workbench" },
	{ key: "escape", action: "quit", description: "Quit workbench" },
	{ key: "ctrl+c", action: "quit", description: "Quit workbench" },
];

function modelKeybindings(model: ProductWorkbenchModel): ProductWorkbenchShellKeybinding[] {
	return model.keybindings.map((binding) => ({
		key: binding.key as ProductWorkbenchKeyId,
		action: binding.action,
		description: binding.description,
	}));
}

function inputMatchesKey(data: string, key: ProductWorkbenchKeyId): boolean {
	if (key === "tab") return data === "\t";
	if (key === "shift+tab") return data === "\x1b[Z" || data === "\x1b[27;2;9~";
	if (key === "left") return data === "\x1b[D";
	if (key === "up") return data === "\x1b[A";
	if (key === "right") return data === "\x1b[C";
	if (key === "space") return data === " ";
	if (key === "enter") return data === "\r" || data === "\n";
	if (key === "escape") return data === "\x1b";
	if (key === "ctrl+c") return data === "\x03";
	return data.toLowerCase() === key;
}

export function splitProductWorkbenchInput(data: string): string[] {
	const sequences = ["\x1b[27;2;9~", "\x1b[Z", "\x1b[D", "\x1b[A", "\x1b[C"];
	const events: string[] = [];
	let index = 0;
	while (index < data.length) {
		const rest = data.slice(index);
		const sequence = sequences.find((candidate) => rest.startsWith(candidate));
		if (sequence) {
			events.push(sequence);
			index += sequence.length;
			continue;
		}
		events.push(data[index] ?? "");
		index += 1;
	}
	return events.filter((event) => event.length > 0);
}

export function resolveProductWorkbenchInput(
	model: ProductWorkbenchModel,
	data: string,
): ProductWorkbenchShellAction | undefined {
	for (const binding of [...defaultProductWorkbenchShellKeybindings, ...modelKeybindings(model)]) {
		if (inputMatchesKey(data, binding.key)) return binding.action;
	}
	return undefined;
}

export class ProductWorkbenchTuiComponent implements Component {
	private model: ProductWorkbenchModel;
	private readonly options: ProductWorkbenchTuiComponentOptions;

	constructor(model: ProductWorkbenchModel, options: ProductWorkbenchTuiComponentOptions = {}) {
		this.model = model;
		this.options = options;
	}

	getModel(): ProductWorkbenchModel {
		return this.model;
	}

	handleInput(data: string): void {
		const action = resolveProductWorkbenchInput(this.model, data);
		if (!action) return;
		if (action === "quit") {
			this.options.onExit?.(this.model);
			return;
		}
		this.model = applyProductWorkbenchAction(this.model, action);
		this.options.onModelChange?.(this.model);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderProductWorkbenchTui(this.model, width, this.options.height).split("\n");
	}
}

export function createProductWorkbenchPiTuiComponent(
	model: ProductWorkbenchModel,
	options: ProductWorkbenchTuiComponentOptions = {},
): Component {
	return new ProductWorkbenchTuiComponent(model, options);
}

export function createProductWorkbenchPiTuiMount(
	model: ProductWorkbenchModel,
	options: ProductWorkbenchTuiComponentOptions = {},
): ProductWorkbenchPiTuiMount {
	return {
		id: "verigen.product-workbench",
		packageName: "@earendil-works/pi-tui",
		component: createProductWorkbenchPiTuiComponent(model, options),
		keybindings: [...defaultProductWorkbenchShellKeybindings, ...modelKeybindings(model)],
		notes: [
			"Mount component.render(width) inside a coding-agent overlay, side panel, or custom message renderer.",
			"Forward focused terminal input to component.handleInput(data) to reuse workbench actions.",
			"The component is source-testable without packages/tui/dist because the pi-tui import is type-only.",
		],
	};
}

function writeFrame(lines: string[]): void {
	process.stdout.write("\x1b[?25l\x1b[H\x1b[J");
	process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runProductWorkbenchTui(
	model: ProductWorkbenchModel,
	options: RunProductWorkbenchTuiOptions = {},
): Promise<ProductWorkbenchModel> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("product-workbench requires an interactive TTY");
	}
	return await new Promise<ProductWorkbenchModel>((resolve) => {
		let current = model;
		const component = new ProductWorkbenchTuiComponent(model, {
			height: options.height,
			onModelChange: (nextModel) => {
				current = nextModel;
				options.onModelChange?.(nextModel);
				writeFrame(component.render(options.width ?? process.stdout.columns ?? 120));
			},
			onExit: (finalModel) => {
				current = finalModel;
				process.stdin.off("data", onData);
				process.stdout.off("resize", onResize);
				process.stdin.setRawMode?.(false);
				process.stdin.pause();
				process.stdout.write("\x1b[?25h\n");
				options.onExit?.(finalModel);
				resolve(current);
			},
		});
		const onResize = () => {
			writeFrame(component.render(options.width ?? process.stdout.columns ?? 120));
		};
		const onData = (data: Buffer | string) => {
			for (const event of splitProductWorkbenchInput(data.toString("utf8"))) {
				component.handleInput(event);
			}
		};
		process.stdin.setRawMode?.(true);
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.stdout.on("resize", onResize);
		writeFrame(component.render(options.width ?? process.stdout.columns ?? 120));
	});
}
