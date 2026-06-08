import type { CodeSnippet, SignalTrace, TraceLevel, TraceRelation, TraceWaveformResult } from "./types.ts";

export interface TraceContextOptions {
	maxSignals?: number;
	maxControllersPerSignal?: number;
	maxLevelsPerSignal?: number;
	maxRelationsPerLevel?: number;
	maxWaveTableRows?: number;
	maxWaveTableChars?: number;
	maxCodeSnippets?: number;
	maxSnippetLines?: number;
	maxContextChars?: number;
}

export interface TrimmedTraceLevel {
	level: number;
	relations: TraceRelation[];
	omittedRelations: number;
}

export interface TrimmedSignalTrace {
	signal: string;
	controllers: string[];
	controllersOmitted: number;
	controllers_by_level: TrimmedTraceLevel[];
	levelsOmitted: number;
	warnings?: Array<Record<string, unknown>>;
}

export interface TrimmedCodeSnippet {
	signal: string;
	start_line: number;
	end_line: number;
	code: string;
	linesOmitted: number;
}

export interface DebuggerTraceContext {
	mismatch_time: number | null;
	mismatch_values: Record<string, string>;
	trace: TrimmedSignalTrace[];
	wave_table_hex: string;
	code_snippets: TrimmedCodeSnippet[];
	omitted: {
		signals: number;
		waveTableRows: number;
		waveTableChars: number;
		codeSnippets: number;
		contextChars: number;
	};
}

const defaultOptions: Required<TraceContextOptions> = {
	maxSignals: 4,
	maxControllersPerSignal: 12,
	maxLevelsPerSignal: 4,
	maxRelationsPerLevel: 12,
	maxWaveTableRows: 10,
	maxWaveTableChars: 2_000,
	maxCodeSnippets: 8,
	maxSnippetLines: 8,
	maxContextChars: 8_000,
};

function resolveOptions(options?: TraceContextOptions): Required<TraceContextOptions> {
	return { ...defaultOptions, ...options };
}

function truncateByLines(text: string, maxRows: number): { text: string; omittedRows: number } {
	const rows = text.split(/\r?\n/);
	if (rows.length <= maxRows) return { text, omittedRows: 0 };
	const omittedRows = rows.length - maxRows;
	return {
		text: `${rows.slice(0, maxRows).join("\n")}\n[truncated ${omittedRows} rows]`,
		omittedRows,
	};
}

function truncateByChars(text: string, maxChars: number): { text: string; omittedChars: number } {
	if (text.length <= maxChars) return { text, omittedChars: 0 };
	const suffix = "\n[truncated]";
	const sliceLength = Math.max(0, maxChars - suffix.length);
	return { text: `${text.slice(0, sliceLength)}${suffix}`, omittedChars: text.length - sliceLength };
}

function trimTraceLevel(level: TraceLevel, maxRelations: number): TrimmedTraceLevel {
	const relations = level.relations.slice(0, maxRelations);
	return {
		level: level.level,
		relations,
		omittedRelations: Math.max(0, level.relations.length - relations.length),
	};
}

function trimSignalTrace(
	trace: SignalTrace,
	maxControllers: number,
	maxLevels: number,
	maxRelations: number,
): TrimmedSignalTrace {
	const controllers = trace.controllers.slice(0, maxControllers);
	const levels = trace.controllers_by_level.slice(0, maxLevels).map((level) => trimTraceLevel(level, maxRelations));
	return {
		signal: trace.signal,
		controllers,
		controllersOmitted: Math.max(0, trace.controllers.length - controllers.length),
		controllers_by_level: levels,
		levelsOmitted: Math.max(0, trace.controllers_by_level.length - levels.length),
		warnings: trace.warnings,
	};
}

function trimCodeSnippet(snippet: CodeSnippet, maxLines: number): TrimmedCodeSnippet {
	const lines = snippet.code.split(/\r?\n/);
	const selected = lines.slice(0, maxLines);
	const linesOmitted = Math.max(0, lines.length - selected.length);
	const endLine = linesOmitted > 0 ? snippet.start_line + selected.length - 1 : snippet.end_line;
	const code = linesOmitted > 0 ? `${selected.join("\n")}\n[truncated ${linesOmitted} lines]` : snippet.code;
	return {
		signal: snippet.signal,
		start_line: snippet.start_line,
		end_line: endLine,
		code,
		linesOmitted,
	};
}

export function trimTraceForDebugger(result: TraceWaveformResult, options?: TraceContextOptions): DebuggerTraceContext {
	const resolved = resolveOptions(options);
	const selectedTrace = result.trace.slice(0, resolved.maxSignals);
	const trace = selectedTrace.map((item) =>
		trimSignalTrace(
			item,
			resolved.maxControllersPerSignal,
			resolved.maxLevelsPerSignal,
			resolved.maxRelationsPerLevel,
		),
	);

	const byRows = truncateByLines(result.wave_table_hex, resolved.maxWaveTableRows);
	const byChars = truncateByChars(byRows.text, resolved.maxWaveTableChars);

	const selectedSnippets = result.code_snippets.slice(0, resolved.maxCodeSnippets);
	const codeSnippets = selectedSnippets.map((snippet) => trimCodeSnippet(snippet, resolved.maxSnippetLines));

	return {
		mismatch_time: result.mismatch_time,
		mismatch_values: result.mismatch_values,
		trace,
		wave_table_hex: byChars.text,
		code_snippets: codeSnippets,
		omitted: {
			signals: Math.max(0, result.trace.length - selectedTrace.length),
			waveTableRows: byRows.omittedRows,
			waveTableChars: byChars.omittedChars,
			codeSnippets: Math.max(0, result.code_snippets.length - selectedSnippets.length),
			contextChars: 0,
		},
	};
}

function formatMismatchValues(values: Record<string, string>): string {
	const entries = Object.entries(values);
	if (entries.length === 0) return "none";
	return entries.map(([name, value]) => `${name}=${value}`).join(", ");
}

function formatTraceLevels(levels: TrimmedTraceLevel[]): string[] {
	const lines: string[] = [];
	for (const level of levels) {
		const relations =
			level.relations.length === 0
				? "none"
				: level.relations.map((relation) => `${relation.controller}->${relation.controlled}`).join(", ");
		const omitted = level.omittedRelations > 0 ? ` (${level.omittedRelations} omitted)` : "";
		lines.push(`  level ${level.level}: ${relations}${omitted}`);
	}
	return lines;
}

function formatSignalTrace(trace: TrimmedSignalTrace): string[] {
	const controllers = trace.controllers.length === 0 ? "none" : trace.controllers.join(", ");
	const omitted = trace.controllersOmitted > 0 ? ` (${trace.controllersOmitted} omitted)` : "";
	const lines = [`- ${trace.signal}: controllers ${controllers}${omitted}`];
	lines.push(...formatTraceLevels(trace.controllers_by_level));
	if (trace.levelsOmitted > 0) {
		lines.push(`  levels omitted: ${trace.levelsOmitted}`);
	}
	if (trace.warnings && trace.warnings.length > 0) {
		lines.push(`  warnings: ${JSON.stringify(trace.warnings)}`);
	}
	return lines;
}

function formatCodeSnippet(snippet: TrimmedCodeSnippet): string[] {
	const lines = [
		`${snippet.signal} lines ${snippet.start_line}-${snippet.end_line}:`,
		"```verilog",
		snippet.code,
		"```",
	];
	if (snippet.linesOmitted > 0) {
		lines.push(`snippet lines omitted: ${snippet.linesOmitted}`);
	}
	return lines;
}

function formatDebuggerContext(context: DebuggerTraceContext): string {
	const lines = [
		"AST waveform trace for Debugger (trimmed)",
		`mismatch_time: ${context.mismatch_time ?? "unknown"}`,
		`mismatch_values: ${formatMismatchValues(context.mismatch_values)}`,
		"",
		"Signal trace:",
	];

	for (const trace of context.trace) {
		lines.push(...formatSignalTrace(trace));
	}

	lines.push("", "Waveform window (hex):", context.wave_table_hex, "", "Relevant RTL snippets:");
	for (const snippet of context.code_snippets) {
		lines.push(...formatCodeSnippet(snippet));
	}

	const omitted = context.omitted;
	const omittedDetails = [
		`signals=${omitted.signals}`,
		`wave_rows=${omitted.waveTableRows}`,
		`wave_chars=${omitted.waveTableChars}`,
		`snippets=${omitted.codeSnippets}`,
		`context_chars=${omitted.contextChars}`,
	];
	lines.push("", `omitted: ${omittedDetails.join(", ")}`);
	return lines.join("\n");
}

export function formatTraceForDebugger(result: TraceWaveformResult, options?: TraceContextOptions): string {
	const resolved = resolveOptions(options);
	const context = trimTraceForDebugger(result, resolved);
	const formatted = formatDebuggerContext(context);
	const truncated = truncateByChars(formatted, resolved.maxContextChars);
	if (truncated.omittedChars === 0) return formatted;
	return formatDebuggerContext({
		...context,
		wave_table_hex: context.wave_table_hex,
		omitted: {
			...context.omitted,
			contextChars: truncated.omittedChars,
		},
	}).slice(0, resolved.maxContextChars);
}
