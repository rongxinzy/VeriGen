import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceContextOptions } from "./context-router.ts";
import { runIverilogVvp } from "./eda-toolrunner.ts";
import { bootstrapPythonWorker, type PythonWorkerBootstrapOptions } from "./python-worker-bootstrap.ts";
import { type SimulationFailureTraceResult, traceSimulationFailure } from "./sim-failure-trace.ts";
import { VerilogAnalysis } from "./verilog-analysis-client.ts";

export const verigenPipelineStages = ["spec", "plan", "rtl", "sim", "trace", "fix", "report"] as const;

export type VerigenPipelineStage = (typeof verigenPipelineStages)[number];

export type VerigenPipelineStageState = "pending" | "active" | "done";

export interface VerigenPipelineStageStatus {
	stage: VerigenPipelineStage;
	state: VerigenPipelineStageState;
}

export interface VerigenModeProfile {
	id: "verigen";
	name: string;
	objective: string;
	stages: readonly VerigenPipelineStage[];
	defaultActiveStage: VerigenPipelineStage;
	tracePanelSections: readonly string[];
	codegenProbeLevels: readonly string[];
}

export interface TracePanelInput {
	trace: SimulationFailureTraceResult;
	activeStage?: VerigenPipelineStage;
	debuggerSuggestions?: string[];
}

export interface TraceTextPanel {
	title: string;
	pipeline: VerigenPipelineStageStatus[];
	mismatchSignals: string[];
	controllerChains: string[];
	waveformHex: string;
	rtlSnippets: string[];
	debuggerSuggestions: string[];
	debuggerPromptContext: string;
	rendered: string;
}

export interface TracePanelRunOptions {
	rtlPath: string;
	vcdPath: string;
	mismatchSignals: string[];
	top?: string;
	traceLevel?: number;
	windowSize?: number;
	contextOptions?: TraceContextOptions;
	workerOptions?: PythonWorkerBootstrapOptions;
}

export interface TracePanelRunResult {
	trace: SimulationFailureTraceResult;
	panel: TraceTextPanel;
}

export interface BuiltInTraceDemoOptions {
	contextOptions?: TraceContextOptions;
	workerOptions?: PythonWorkerBootstrapOptions;
	keepTempDir?: boolean;
}

export interface BuiltInTraceDemoResult extends TracePanelRunResult {
	tempDir: string;
	cleanedTempDir: boolean;
}

export const defaultVerigenModeProfile: VerigenModeProfile = {
	id: "verigen",
	name: "VeriGen RTL Debug Mode",
	objective: "Convert a Verilog task into a verified RTL debug loop with deterministic trace context.",
	stages: verigenPipelineStages,
	defaultActiveStage: "trace",
	tracePanelSections: [
		"mismatch signal",
		"controller chain",
		"hex waveform table",
		"matched RTL snippets",
		"debugger suggestions",
	],
	codegenProbeLevels: ["L0", "L1"],
};

const demoBuggyRtl = `module TopModule (
  input wire a,
  input wire b,
  input wire sel,
  output wire out
);
  wire n;
  assign n = a & b;
  assign out = sel ? n : b;
endmodule
`;

const demoReferenceRtl = `module RefModule (
  input wire a,
  input wire b,
  input wire sel,
  output wire out
);
  assign out = sel ? a : b;
endmodule
`;

const demoTestbenchRtl =
	"`timescale 1ns/1ns\n" +
	`module tb;
  reg clk = 0;
  reg a = 0;
  reg b = 1;
  reg sel = 0;
  wire out_ref;
  wire out_dut;
  integer errors_out = 0;
  integer errortime_out = 0;

  always #1 clk = ~clk;

  RefModule good1 (.a(a), .b(b), .sel(sel), .out(out_ref));
  TopModule top_module1 (.a(a), .b(b), .sel(sel), .out(out_dut));

  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, tb);
    #2 a = 1; b = 1; sel = 1;
    #2 a = 1; b = 0; sel = 1;
    #4;
    if (errors_out) begin
      $display("Hint: Output '%s' has %0d mismatches. First mismatch occurred at time %0d.", "out", errors_out, errortime_out);
    end else begin
      $display("Hint: Output '%s' has no mismatches.", "out");
    end
    $finish;
  end

  always @(posedge clk) begin
    if (out_ref !== out_dut) begin
      if (errors_out == 0) errortime_out = $time;
      errors_out = errors_out + 1;
    end
  end
endmodule
`;

export function createVerigenPipelineStatus(activeStage: VerigenPipelineStage): VerigenPipelineStageStatus[] {
	const activeIndex = verigenPipelineStages.indexOf(activeStage);
	return verigenPipelineStages.map((stage, index) => {
		if (index < activeIndex) return { stage, state: "done" };
		if (index === activeIndex) return { stage, state: "active" };
		return { stage, state: "pending" };
	});
}

function controllerChain(signal: string, controllers: string[]): string {
	if (controllers.length === 0) return `${signal} <- none`;
	return `${signal} <- ${controllers.join(" <- ")}`;
}

function snippetBlock(signal: string, startLine: number, endLine: number, code: string): string {
	return `${signal} lines ${startLine}-${endLine}\n${code}`;
}

function deriveDebuggerSuggestions(trace: SimulationFailureTraceResult): string[] {
	const firstSignalTrace = trace.debuggerContext.trace[0];
	if (!firstSignalTrace) {
		return ["No controller chain was found; inspect the failing output assignment and rerun simulation."];
	}
	const firstController = firstSignalTrace.controllers[0];
	const controllerHint = firstController
		? `Inspect assignments feeding ${firstSignalTrace.signal}, starting from controller ${firstController}.`
		: `Inspect direct assignments to ${firstSignalTrace.signal}.`;
	return [
		controllerHint,
		"Compare the hex waveform window at the first mismatch before changing RTL.",
		"Make the smallest contract-preserving RTL fix, then rerun simulation and trace.",
	];
}

function renderPipeline(statuses: VerigenPipelineStageStatus[]): string {
	return statuses
		.map((status) => {
			if (status.state === "done") return `[x] ${status.stage}`;
			if (status.state === "active") return `[>] ${status.stage}`;
			return `[ ] ${status.stage}`;
		})
		.join(" -> ");
}

export function renderTraceTextPanel(panel: Omit<TraceTextPanel, "rendered">): string {
	const lines = [
		panel.title,
		"",
		"Pipeline",
		renderPipeline(panel.pipeline),
		"",
		"Mismatch signals",
		panel.mismatchSignals.length === 0 ? "none" : panel.mismatchSignals.join(", "),
		"",
		"Controller chain",
		...panel.controllerChains.map((chain) => `- ${chain}`),
		"",
		"Waveform window (hex)",
		panel.waveformHex || "empty",
		"",
		"RTL snippets",
	];

	if (panel.rtlSnippets.length === 0) {
		lines.push("none");
	} else {
		for (const snippet of panel.rtlSnippets) {
			lines.push("```verilog", snippet, "```");
		}
	}

	lines.push("", "Debugger suggestions");
	for (const suggestion of panel.debuggerSuggestions) {
		lines.push(`- ${suggestion}`);
	}

	lines.push("", "Debugger prompt context", panel.debuggerPromptContext);
	return lines.join("\n");
}

export function createTraceTextPanel(input: TracePanelInput): TraceTextPanel {
	const activeStage = input.activeStage ?? defaultVerigenModeProfile.defaultActiveStage;
	const mismatchSignals = Object.keys(input.trace.debuggerContext.mismatch_values);
	const controllerChains = input.trace.debuggerContext.trace.map((trace) =>
		controllerChain(trace.signal, trace.controllers),
	);
	const rtlSnippets = input.trace.debuggerContext.code_snippets.map((snippet) =>
		snippetBlock(snippet.signal, snippet.start_line, snippet.end_line, snippet.code),
	);
	const panelWithoutRendered = {
		title: "VeriGen S5 Trace Panel",
		pipeline: createVerigenPipelineStatus(activeStage),
		mismatchSignals,
		controllerChains,
		waveformHex: input.trace.debuggerContext.wave_table_hex,
		rtlSnippets,
		debuggerSuggestions: input.debuggerSuggestions ?? deriveDebuggerSuggestions(input.trace),
		debuggerPromptContext: input.trace.debuggerPromptContext,
	};
	return {
		...panelWithoutRendered,
		rendered: renderTraceTextPanel(panelWithoutRendered),
	};
}

async function createDemoFixture(): Promise<{ tempDir: string; rtlPath: string; vcdPath: string }> {
	const tempDir = await mkdtemp(join(tmpdir(), "verigen-s5-trace-"));
	const buggyPath = join(tempDir, "buggy.v");
	const referencePath = join(tempDir, "ref.v");
	const testbenchPath = join(tempDir, "tb.v");
	await writeFile(buggyPath, demoBuggyRtl);
	await writeFile(referencePath, demoReferenceRtl);
	await writeFile(testbenchPath, demoTestbenchRtl);
	const sim = await runIverilogVvp({
		rtl: [{ path: buggyPath }, { path: referencePath }],
		testbench: [{ path: testbenchPath }],
		top: "tb",
		workDir: tempDir,
		keepWorkDir: true,
	});
	if (!sim.artifacts?.vcdPath) {
		const detail = sim.issues.map((issue) => issue.message).join("; ");
		throw new Error(`trace demo did not produce wave.vcd: ${detail || "unknown simulation failure"}`);
	}
	return { tempDir, rtlPath: buggyPath, vcdPath: sim.artifacts.vcdPath };
}

export async function runTracePanelFromFiles(options: TracePanelRunOptions): Promise<TracePanelRunResult> {
	const launch = await bootstrapPythonWorker(options.workerOptions);
	const worker = new VerilogAnalysis({
		command: launch.command,
		args: launch.args,
		workerCwd: launch.cwd,
		requestTimeoutMs: 60_000,
	});
	try {
		const trace = await traceSimulationFailure({
			rtl_path: options.rtlPath,
			vcd_path: options.vcdPath,
			mismatch_signals: options.mismatchSignals,
			top: options.top,
			trace_level: options.traceLevel,
			window_size: options.windowSize,
			contextOptions: options.contextOptions,
			worker,
		});
		return { trace, panel: createTraceTextPanel({ trace }) };
	} finally {
		await worker.close();
	}
}

export async function runBuiltInTraceDemo(options: BuiltInTraceDemoOptions = {}): Promise<BuiltInTraceDemoResult> {
	const fixture = await createDemoFixture();
	let shouldCleanup = !options.keepTempDir;
	try {
		const result = await runTracePanelFromFiles({
			rtlPath: fixture.rtlPath,
			vcdPath: fixture.vcdPath,
			mismatchSignals: ["out"],
			top: "TopModule",
			traceLevel: 2,
			contextOptions: options.contextOptions,
			workerOptions: options.workerOptions,
		});
		if (!options.keepTempDir) {
			await rm(fixture.tempDir, { recursive: true, force: true });
			shouldCleanup = false;
			return { ...result, tempDir: fixture.tempDir, cleanedTempDir: true };
		}
		return { ...result, tempDir: fixture.tempDir, cleanedTempDir: false };
	} finally {
		if (shouldCleanup) {
			await rm(fixture.tempDir, { recursive: true, force: true });
		}
	}
}
