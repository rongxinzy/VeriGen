import {
	type DebuggerTraceContext,
	formatTraceForDebugger,
	type TraceContextOptions,
	trimTraceForDebugger,
} from "./context-router.ts";
import type { TraceWaveformArgs, TraceWaveformResult, VerilogAnalysisClientOptions } from "./types.ts";
import { VerilogAnalysis } from "./verilog-analysis-client.ts";

export type SimulationFailureTraceInput = TraceWaveformArgs & {
	worker?: VerilogAnalysis;
	workerOptions?: VerilogAnalysisClientOptions;
	contextOptions?: TraceContextOptions;
};

export interface SimulationFailureTraceResult {
	rawTrace: TraceWaveformResult;
	debuggerContext: DebuggerTraceContext;
	debuggerPromptContext: string;
}

function traceArgsFromInput(input: SimulationFailureTraceInput): TraceWaveformArgs {
	const base = {
		mismatch_signals: input.mismatch_signals,
		trace_level: input.trace_level,
		window_size: input.window_size,
		top: input.top,
	};

	if (typeof input.rtl_path === "string") {
		if (typeof input.vcd_path === "string") {
			return { rtl_path: input.rtl_path, vcd_path: input.vcd_path, ...base };
		}
		if (typeof input.vcd === "string") {
			return { rtl_path: input.rtl_path, vcd: input.vcd, ...base };
		}
	}

	if (typeof input.rtl === "string") {
		if (typeof input.vcd_path === "string") {
			return { rtl: input.rtl, vcd_path: input.vcd_path, ...base };
		}
		if (typeof input.vcd === "string") {
			return { rtl: input.rtl, vcd: input.vcd, ...base };
		}
	}

	throw new Error("expected one RTL source (rtl or rtl_path) and one VCD source (vcd or vcd_path)");
}

export async function traceSimulationFailure(
	input: SimulationFailureTraceInput,
): Promise<SimulationFailureTraceResult> {
	const ownsWorker = !input.worker;
	const worker = input.worker ?? new VerilogAnalysis(input.workerOptions);
	try {
		const rawTrace = await worker.traceWaveform(traceArgsFromInput(input));
		return {
			rawTrace,
			debuggerContext: trimTraceForDebugger(rawTrace, input.contextOptions),
			debuggerPromptContext: formatTraceForDebugger(rawTrace, input.contextOptions),
		};
	} finally {
		if (ownsWorker) {
			await worker.close();
		}
	}
}
