import type { CodegenProbeRunResult } from "./quality-probe.ts";
import type { TraceTextPanel, VerigenPipelineStageStatus } from "./s5-mode.ts";

export interface VerigenTuiRenderable {
	render(width: number): string[];
	invalidate(): void;
}

export type VerigenTuiPreviewKind = "trace" | "quality-probe";

export interface VerigenTuiPreviewModel {
	kind: VerigenTuiPreviewKind;
	title: string;
	subtitle: string;
	pipeline: VerigenPipelineStageStatus[];
	leftTitle: string;
	leftLines: string[];
	rightTitle: string;
	rightLines: string[];
	footer: string[];
}

function truncateLine(line: string, width: number): string {
	if (line.length <= width) return line;
	if (width <= 1) return line.slice(0, width);
	if (width <= 3) return ".".repeat(width);
	return `${line.slice(0, width - 3)}...`;
}

function padLine(line: string, width: number): string {
	const truncated = truncateLine(line, width);
	return truncated + " ".repeat(Math.max(0, width - truncated.length));
}

function wrapLine(line: string, width: number): string[] {
	if (line.length <= width) return [line];
	const words = line.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			for (let index = 0; index < word.length; index += width) {
				lines.push(word.slice(index, index + width));
			}
			continue;
		}
		const next = current ? `${current} ${word}` : word;
		if (next.length <= width) {
			current = next;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function wrapLines(lines: string[], width: number, maxLines: number): string[] {
	const output: string[] = [];
	for (const line of lines) {
		for (const wrapped of wrapLine(line, width)) {
			output.push(wrapped);
			if (output.length >= maxLines) return output;
		}
	}
	return output;
}

function box(title: string, lines: string[], width: number, maxContentLines: number): string[] {
	const contentWidth = Math.max(8, width - 4);
	const selected = wrapLines(lines, contentWidth, maxContentLines);
	const omitted = lines.length > 0 && selected.length >= maxContentLines ? ["..."] : [];
	const border = `+${"-".repeat(width - 2)}+`;
	const header = `| ${padLine(title, width - 4)} |`;
	const body = [...selected, ...omitted].map((line) => `| ${padLine(line, width - 4)} |`);
	return [border, header, border, ...body, border];
}

function joinColumns(left: string[], right: string[], gap = 2): string[] {
	const rows = Math.max(left.length, right.length);
	const leftWidth = Math.max(...left.map((line) => line.length), 0);
	const output: string[] = [];
	for (let index = 0; index < rows; index += 1) {
		const leftLine = padLine(left[index] ?? "", leftWidth);
		const rightLine = right[index] ?? "";
		output.push(`${leftLine}${" ".repeat(gap)}${rightLine}`);
	}
	return output;
}

function pipelineText(statuses: VerigenPipelineStageStatus[]): string {
	return statuses
		.map((status) => {
			if (status.state === "done") return `[x] ${status.stage}`;
			if (status.state === "active") return `[>] ${status.stage}`;
			return `[ ] ${status.stage}`;
		})
		.join(" -> ");
}

function splitNonEmpty(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function contractLines(result: CodegenProbeRunResult): string[] {
	const contract = result.case.moduleContract;
	return [
		`case: ${result.case.id}`,
		`level: ${result.case.level}`,
		`module: ${contract.moduleName}`,
		...contract.ports.map((port) => `${port.direction} ${port.name} width=${port.width}`),
		"",
		"checklist:",
		...result.manualReview.checklist.map((item) => `- ${item}`),
	];
}

export function createTraceTuiPreview(panel: TraceTextPanel): VerigenTuiPreviewModel {
	return {
		kind: "trace",
		title: "VeriGen S5 Trace MVP",
		subtitle: "Text TUI panel for sim-fail trace, controller chain, waveform window, and debugger context.",
		pipeline: panel.pipeline,
		leftTitle: "Trace",
		leftLines: [
			`mismatch: ${panel.mismatchSignals.length === 0 ? "none" : panel.mismatchSignals.join(", ")}`,
			"",
			"controllers:",
			...panel.controllerChains.map((chain) => `- ${chain}`),
			"",
			"waveform hex:",
			...splitNonEmpty(panel.waveformHex),
		],
		rightTitle: "Debugger",
		rightLines: [
			"rtl snippets:",
			...panel.rtlSnippets.flatMap((snippet) => splitNonEmpty(snippet).slice(0, 4)),
			"",
			"suggestions:",
			...panel.debuggerSuggestions.map((suggestion) => `- ${suggestion}`),
		],
		footer: ["S5: fix/report are still pending; S6 will add compile/sim ToolRunner automation."],
	};
}

export function createQualityProbeTuiPreview(result: CodegenProbeRunResult): VerigenTuiPreviewModel {
	return {
		kind: "quality-probe",
		title: "VeriGen S5 Codegen Quality Probe",
		subtitle: "L0/L1 Verilog generation probe for manual review before S6 compile/sim automation.",
		pipeline: [
			{ stage: "spec", state: "done" },
			{ stage: "plan", state: "done" },
			{ stage: "rtl", state: result.generatedRtl ? "done" : "active" },
			{ stage: "sim", state: "pending" },
			{ stage: "trace", state: "pending" },
			{ stage: "fix", state: "pending" },
			{ stage: "report", state: "pending" },
		],
		leftTitle: "Spec",
		leftLines: [result.case.spec, "", ...contractLines(result)],
		rightTitle: "Generated RTL",
		rightLines: result.generatedRtl
			? splitNonEmpty(result.generatedRtl)
			: ["not generated", "run with --live to call the configured LLM endpoint"],
		footer: [
			`model: ${result.llm.model}`,
			`tool: ${result.toolResult.status} - ${result.toolResult.summary}`,
			`manual review: ${result.manualReview.status}`,
		],
	};
}

export class VerigenTuiPreviewComponent implements VerigenTuiRenderable {
	private model: VerigenTuiPreviewModel;

	constructor(model: VerigenTuiPreviewModel) {
		this.model = model;
	}

	setModel(model: VerigenTuiPreviewModel): void {
		this.model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const resolvedWidth = Math.max(48, width);
		const contentWidth = resolvedWidth - 2;
		const title = `${this.model.title} :: ${this.model.kind}`;
		const header = [
			"=".repeat(resolvedWidth),
			padLine(title, resolvedWidth),
			padLine(this.model.subtitle, resolvedWidth),
			"-".repeat(resolvedWidth),
			padLine(`Pipeline: ${pipelineText(this.model.pipeline)}`, resolvedWidth),
			"=".repeat(resolvedWidth),
		];

		const wide = resolvedWidth >= 100;
		if (wide) {
			const columnWidth = Math.floor((contentWidth - 2) / 2);
			const left = box(this.model.leftTitle, this.model.leftLines, columnWidth, 22);
			const right = box(this.model.rightTitle, this.model.rightLines, contentWidth - columnWidth - 2, 22);
			return [...header, ...joinColumns(left, right), ...this.renderFooter(resolvedWidth)];
		}

		return [
			...header,
			...box(this.model.leftTitle, this.model.leftLines, resolvedWidth, 16),
			...box(this.model.rightTitle, this.model.rightLines, resolvedWidth, 16),
			...this.renderFooter(resolvedWidth),
		];
	}

	private renderFooter(width: number): string[] {
		return ["-".repeat(width), ...this.model.footer.map((line) => padLine(line, width)), "=".repeat(width)];
	}
}

export function renderVerigenTuiPreview(model: VerigenTuiPreviewModel, width = 100): string {
	return new VerigenTuiPreviewComponent(model).render(width).join("\n");
}
