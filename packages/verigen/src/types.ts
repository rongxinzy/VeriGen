export type WorkerFunctionName = "parse_ast" | "build_controlflow" | "trace_waveform" | "identify_seq_element";

export type RtlSourceArg = { rtl: string; rtl_path?: never } | { rtl_path: string; rtl?: never };

export type VcdSourceArg = { vcd: string; vcd_path?: never } | { vcd_path: string; vcd?: never };

export type ParseAstArgs = RtlSourceArg & {
	top?: string;
};

export type BuildControlflowArgs = RtlSourceArg & {
	top?: string;
};

export type TraceWaveformArgs = RtlSourceArg &
	VcdSourceArg & {
		mismatch_signals: string[];
		trace_level?: number;
		window_size?: number;
		top?: string;
	};

export interface IdentifySeqElementArgs {
	clock_waveform: WaveformPoint[];
	signal_waveform: WaveformPoint[];
}

export type WaveformPoint = string | number | [number, string | number] | { time: number; value: string | number };

export interface VerilogPortSummary {
	name: string | null;
	direction: string | null;
	width: string | null;
	line: number | null;
}

export interface VerilogModuleSummary {
	name: string;
	line: number | null;
	ports: VerilogPortSummary[];
}

export interface ParseAstResult {
	ast_ok: boolean;
	source: string;
	modules: VerilogModuleSummary[];
	warnings?: Array<Record<string, unknown>>;
}

export interface ControlflowNode {
	id: string;
	type: string | null;
	lines: number[];
}

export interface ControlflowEdge {
	source: string;
	target: string;
	type: string | null;
	lines: number[];
}

export interface BuildControlflowResult {
	nodes: ControlflowNode[];
	edges: ControlflowEdge[];
	signal_lines: Record<string, number[]>;
}

export interface TraceRelation {
	controller: string;
	controlled: string;
}

export interface TraceLevel {
	level: number;
	relations: TraceRelation[];
}

export interface SignalTrace {
	signal: string;
	controllers: string[];
	controllers_by_level: TraceLevel[];
	warnings?: Array<Record<string, unknown>>;
}

export interface CodeSnippet {
	signal: string;
	start_line: number;
	end_line: number;
	code: string;
}

export interface TraceWaveformResult {
	trace: SignalTrace[];
	wave_table_hex: string;
	mismatch_time: number | null;
	mismatch_values: Record<string, string>;
	code_snippets: CodeSnippet[];
}

export type SequentialElementKind = "posedge_ff" | "negedge_ff" | "latch_high" | "latch_low" | "unknown";

export interface IdentifySeqElementResult {
	kind: SequentialElementKind;
	confidence: number;
}

export interface WorkerErrorFrame {
	kind: string;
	details: unknown;
}

export interface VerilogAnalysisClientOptions {
	command?: string;
	args?: string[];
	workerCwd?: string;
	packageRoot?: string;
	workerRoot?: string;
	cacheRoot?: string;
	uvCommand?: string;
	bootstrap?: boolean;
	env?: Record<string, string>;
	requestTimeoutMs?: number;
	closeTimeoutMs?: number;
	stderrLimitBytes?: number;
	onStderr?: (chunk: string) => void;
}
