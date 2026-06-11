import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export type EdaToolProfile = "iverilog-vvp" | "verilator-lint" | "yosys-synth" | "symbiyosys" | "himasim" | "quartus";

export type EdaToolStage =
	| "lint"
	| "sim"
	| "synth"
	| "prove"
	| "quartus-project"
	| "quartus-map"
	| "quartus-fit"
	| "quartus-asm"
	| "quartus-sta"
	| "quartus-compile"
	| "quartus-pgm";

export type EdaToolIssueKind =
	| "compile_error"
	| "sim_fail"
	| "width_warning"
	| "synth_fail"
	| "formal_fail"
	| "missing_tool";

export type EdaToolIssueSeverity = "error" | "warning";

export interface EdaToolIssue {
	kind: EdaToolIssueKind;
	severity: EdaToolIssueSeverity;
	tool: string;
	message: string;
	file?: string;
	line?: number;
	column?: number;
	snippet?: string;
}

export interface EdaCommandResult {
	command: string;
	args: string[];
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	ok: boolean;
}

export interface EdaToolArtifacts {
	workDir: string;
	outputFile?: string;
	vcdPath?: string;
}

export interface EdaToolRunResult {
	profile: EdaToolProfile;
	stage: EdaToolStage;
	ok: boolean;
	commands: EdaCommandResult[];
	issues: EdaToolIssue[];
	artifacts?: EdaToolArtifacts;
}

export type EdaInputFile =
	| {
			path: string;
			filename?: never;
			content?: never;
	  }
	| {
			path?: never;
			filename: string;
			content: string;
	  };

export interface IverilogVvpOptions {
	rtl: EdaInputFile[];
	testbench: EdaInputFile[];
	top?: string;
	workDir?: string;
	keepWorkDir?: boolean;
	iverilogCommand?: string;
	vvpCommand?: string;
	outputName?: string;
}

export interface VerilatorLintOptions {
	rtl: EdaInputFile[];
	top?: string;
	workDir?: string;
	keepWorkDir?: boolean;
	verilatorCommand?: string;
}

export interface YosysSynthOptions {
	rtl: EdaInputFile[];
	top?: string;
	workDir?: string;
	keepWorkDir?: boolean;
	yosysCommand?: string;
}

export interface SymbiYosysOptions {
	rtl: EdaInputFile[];
	top: string;
	mode?: "bmc" | "prove";
	depth?: number;
	workDir?: string;
	keepWorkDir?: boolean;
	sbyCommand?: string;
}

export interface HimasimOptions {
	himasimCommand?: string;
}

export interface QuartusOptions {
	rtl: EdaInputFile[];
	top?: string;
	stage?: EdaToolStage;
	family?: string;
	device?: string;
	revision?: string;
	workDir?: string;
	keepWorkDir?: boolean;
	use64Bit?: boolean;
	jvmHeapMax?: string;
	licServer?: string;
	quartusCommand?: string;
	programmer?: {
		cable?: string;
		mode?: string;
		sofFile?: string;
	};
}

interface MaterializedInputs {
	workDir: string;
	cleanup: boolean;
	paths: string[];
	sources: Map<string, string>;
}

const outputLimit = 64_000;

function trimOutput(current: string, chunk: string): string {
	const combined = current + chunk;
	if (combined.length <= outputLimit) return combined;
	return combined.slice(combined.length - outputLimit);
}

function isMissingTool(result: EdaCommandResult): boolean {
	return result.exitCode === null && /ENOENT|not found|spawn .* ENOENT/i.test(result.stderr);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<EdaCommandResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout = trimOutput(stdout, chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = trimOutput(stderr, chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolvePromise({
				command,
				args,
				cwd,
				exitCode: null,
				stdout,
				stderr: trimOutput(stderr, error.message),
				ok: false,
			});
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolvePromise({ command, args, cwd, exitCode, stdout, stderr, ok: exitCode === 0 });
		});
	});
}

function sourceText(filePath: string): string | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

async function materializeInputs(
	files: EdaInputFile[],
	options: { workDir?: string; keepWorkDir?: boolean; prefix: string },
): Promise<MaterializedInputs> {
	const workDir = options.workDir ? resolve(options.workDir) : await mkdtemp(join(tmpdir(), options.prefix));
	const cleanup = !options.keepWorkDir && !options.workDir;
	const paths: string[] = [];
	const sources = new Map<string, string>();

	for (const file of files) {
		if (file.path !== undefined) {
			const filePath = resolve(file.path);
			paths.push(filePath);
			const text = sourceText(filePath);
			if (text !== undefined) sources.set(filePath, text);
		} else {
			const filePath = join(workDir, file.filename);
			await writeFile(filePath, file.content);
			paths.push(filePath);
			sources.set(filePath, file.content);
		}
	}

	return { workDir, cleanup, paths, sources };
}

function lineSnippet(
	file: string | undefined,
	line: number | undefined,
	sources: Map<string, string>,
): string | undefined {
	if (!file || line === undefined) return undefined;
	const resolved = resolve(file);
	const text = sources.get(resolved) ?? sourceText(resolved);
	if (!text) return undefined;
	const lines = text.split(/\r?\n/);
	const selected = lines[line - 1];
	return selected === undefined ? undefined : selected.trimEnd();
}

function issueFromMissingTool(
	profile: EdaToolProfile,
	stage: EdaToolStage,
	result: EdaCommandResult,
): EdaToolRunResult {
	return {
		profile,
		stage,
		ok: false,
		commands: [result],
		issues: [
			{
				kind: "missing_tool",
				severity: "error",
				tool: result.command,
				message: `${result.command} is not available on PATH`,
			},
		],
	};
}

function issueKindFromText(
	severity: EdaToolIssueSeverity,
	text: string,
	defaultErrorKind: EdaToolIssueKind,
): EdaToolIssueKind {
	if (severity === "warning" && /width|padding|truncat|extend/i.test(text)) return "width_warning";
	if (severity === "warning") return "width_warning";
	return defaultErrorKind;
}

function parseLineIssues(
	tool: string,
	output: string,
	defaultErrorKind: EdaToolIssueKind,
	sources: Map<string, string>,
): EdaToolIssue[] {
	const issues: EdaToolIssue[] = [];
	const common = /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning):\s*(.+)$/i;
	const simpleFileLine = /^(.+?):(\d+):\s*(.+)$/i;
	const verilator = /^%(Error|Warning)(?:-[A-Z0-9_]+)?:\s*(.+?):(\d+):(\d+):\s*(.+)$/i;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const verilatorMatch = line.match(verilator);
		if (verilatorMatch) {
			const severity: EdaToolIssueSeverity = verilatorMatch[1]?.toLowerCase() === "warning" ? "warning" : "error";
			const file = resolve(verilatorMatch[2] ?? "");
			const lineNumber = Number.parseInt(verilatorMatch[3] ?? "0", 10);
			const column = Number.parseInt(verilatorMatch[4] ?? "0", 10);
			const message = verilatorMatch[5] ?? line;
			issues.push({
				kind: issueKindFromText(severity, line, defaultErrorKind),
				severity,
				tool,
				message,
				file,
				line: lineNumber,
				column,
				snippet: lineSnippet(file, lineNumber, sources),
			});
			continue;
		}

		const commonMatch = line.match(common);
		if (commonMatch) {
			const severity: EdaToolIssueSeverity = commonMatch[4]?.toLowerCase() === "warning" ? "warning" : "error";
			const file = resolve(commonMatch[1] ?? "");
			const lineNumber = Number.parseInt(commonMatch[2] ?? "0", 10);
			const columnText = commonMatch[3];
			const column = columnText ? Number.parseInt(columnText, 10) : undefined;
			const message = commonMatch[5] ?? line;
			issues.push({
				kind: issueKindFromText(severity, line, defaultErrorKind),
				severity,
				tool,
				message,
				file,
				line: lineNumber,
				column,
				snippet: lineSnippet(file, lineNumber, sources),
			});
			continue;
		}

		const simpleMatch = line.match(simpleFileLine);
		if (simpleMatch && /error|syntax/i.test(simpleMatch[3] ?? "")) {
			const file = resolve(simpleMatch[1] ?? "");
			const lineNumber = Number.parseInt(simpleMatch[2] ?? "0", 10);
			const message = simpleMatch[3] ?? line;
			issues.push({
				kind: defaultErrorKind,
				severity: "error",
				tool,
				message,
				file,
				line: lineNumber,
				snippet: lineSnippet(file, lineNumber, sources),
			});
		}
	}

	return issues;
}

function fallbackIssue(
	tool: string,
	kind: EdaToolIssueKind,
	message: string,
	severity: EdaToolIssueSeverity = "error",
): EdaToolIssue {
	return { kind, severity, tool, message: message.trim() || `${tool} failed` };
}

function hasErrorIssue(issues: EdaToolIssue[]): boolean {
	return issues.some((issue) => issue.severity === "error");
}

function simFailureIssues(result: EdaCommandResult): EdaToolIssue[] {
	const combined = `${result.stdout}\n${result.stderr}`;
	if (result.ok && !/VERIGEN_SIM_FAIL|mismatch|failed/i.test(combined)) return [];
	return [
		fallbackIssue(
			result.command,
			"sim_fail",
			combined.split(/\r?\n/).find((line) => /VERIGEN_SIM_FAIL|mismatch|failed|fatal/i.test(line)) ??
				combined.slice(0, 500),
		),
	];
}

function quoteYosysPath(path: string): string {
	return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function runIverilogVvp(options: IverilogVvpOptions): Promise<EdaToolRunResult> {
	const materialized = await materializeInputs([...options.rtl, ...options.testbench], {
		workDir: options.workDir,
		keepWorkDir: options.keepWorkDir,
		prefix: "verigen-iverilog-",
	});
	try {
		const outputFile = join(materialized.workDir, options.outputName ?? "sim.vvp");
		const compileArgs = [
			"-g2012",
			"-Wall",
			...(options.top ? ["-s", options.top] : []),
			"-o",
			outputFile,
			...materialized.paths,
		];
		const iverilog = await runCommand(options.iverilogCommand ?? "iverilog", compileArgs, materialized.workDir);
		if (isMissingTool(iverilog)) return issueFromMissingTool("iverilog-vvp", "sim", iverilog);

		const compileIssues = parseLineIssues(
			"iverilog",
			`${iverilog.stdout}\n${iverilog.stderr}`,
			"compile_error",
			materialized.sources,
		);
		if (!iverilog.ok || hasErrorIssue(compileIssues)) {
			const issues =
				compileIssues.length > 0
					? compileIssues
					: [fallbackIssue("iverilog", "compile_error", iverilog.stderr || iverilog.stdout)];
			return {
				profile: "iverilog-vvp",
				stage: "sim",
				ok: false,
				commands: [iverilog],
				issues,
				artifacts: { workDir: materialized.workDir, outputFile },
			};
		}

		const vvp = await runCommand(options.vvpCommand ?? "vvp", [outputFile], materialized.workDir);
		if (isMissingTool(vvp)) {
			return {
				...issueFromMissingTool("iverilog-vvp", "sim", vvp),
				commands: [iverilog, vvp],
				artifacts: { workDir: materialized.workDir, outputFile },
			};
		}
		const simIssues = simFailureIssues(vvp);
		const vcdPath = join(materialized.workDir, "wave.vcd");
		return {
			profile: "iverilog-vvp",
			stage: "sim",
			ok: vvp.ok && simIssues.length === 0,
			commands: [iverilog, vvp],
			issues: [...compileIssues, ...simIssues],
			artifacts: {
				workDir: materialized.workDir,
				outputFile,
				...(existsSync(vcdPath) ? { vcdPath } : {}),
			},
		};
	} finally {
		if (materialized.cleanup) {
			await rm(materialized.workDir, { recursive: true, force: true });
		}
	}
}

export async function runVerilatorLint(options: VerilatorLintOptions): Promise<EdaToolRunResult> {
	const materialized = await materializeInputs(options.rtl, {
		workDir: options.workDir,
		keepWorkDir: options.keepWorkDir,
		prefix: "verigen-verilator-",
	});
	try {
		const args = [
			"--lint-only",
			"-Wall",
			"--sv",
			...(options.top ? ["--top-module", options.top] : []),
			...materialized.paths,
		];
		const result = await runCommand(options.verilatorCommand ?? "verilator", args, materialized.workDir);
		if (isMissingTool(result)) return issueFromMissingTool("verilator-lint", "lint", result);
		const issues = parseLineIssues(
			"verilator",
			`${result.stdout}\n${result.stderr}`,
			"compile_error",
			materialized.sources,
		);
		return {
			profile: "verilator-lint",
			stage: "lint",
			ok: result.ok && !hasErrorIssue(issues),
			commands: [result],
			issues:
				result.ok || issues.length > 0
					? issues
					: [fallbackIssue("verilator", "compile_error", result.stderr || result.stdout)],
			artifacts: { workDir: materialized.workDir },
		};
	} finally {
		if (materialized.cleanup) {
			await rm(materialized.workDir, { recursive: true, force: true });
		}
	}
}

export async function runYosysSynth(options: YosysSynthOptions): Promise<EdaToolRunResult> {
	const materialized = await materializeInputs(options.rtl, {
		workDir: options.workDir,
		keepWorkDir: options.keepWorkDir,
		prefix: "verigen-yosys-",
	});
	try {
		const scriptPath = join(materialized.workDir, "synth.ys");
		const readCommands = materialized.paths.map((path) => `read_verilog -sv ${quoteYosysPath(path)}`);
		const hierarchy = options.top ? `hierarchy -check -top ${options.top}` : "hierarchy -check -auto-top";
		await writeFile(scriptPath, [...readCommands, hierarchy, "proc", "opt", "check"].join("\n"));
		const result = await runCommand(options.yosysCommand ?? "yosys", ["-q", scriptPath], materialized.workDir);
		if (isMissingTool(result)) return issueFromMissingTool("yosys-synth", "synth", result);
		const parsed = parseLineIssues("yosys", `${result.stdout}\n${result.stderr}`, "synth_fail", materialized.sources);
		const issues =
			result.ok || parsed.length > 0
				? parsed
				: [fallbackIssue("yosys", "synth_fail", result.stderr || result.stdout)];
		return {
			profile: "yosys-synth",
			stage: "synth",
			ok: result.ok && !hasErrorIssue(issues),
			commands: [result],
			issues,
			artifacts: { workDir: materialized.workDir },
		};
	} finally {
		if (materialized.cleanup) {
			await rm(materialized.workDir, { recursive: true, force: true });
		}
	}
}

export async function runSymbiYosys(options: SymbiYosysOptions): Promise<EdaToolRunResult> {
	const mode = options.mode ?? "bmc";
	const depth = options.depth ?? 20;
	const materialized = await materializeInputs(options.rtl, {
		workDir: options.workDir,
		keepWorkDir: options.keepWorkDir,
		prefix: "verigen-sby-",
	});
	try {
		const sbyPath = join(materialized.workDir, "formal.sby");
		const scriptLines = [
			`read -formal ${materialized.paths.map((p) => quoteYosysPath(p)).join(" ")}`,
			`prep -top ${options.top}`,
		];
		const filesLines = materialized.paths.map((p) => basename(p));
		const sbyContent = [
			"[options]",
			`mode ${mode}`,
			`depth ${depth}`,
			"",
			"[engines]",
			"smtbmc",
			"",
			"[script]",
			...scriptLines,
			"",
			"[files]",
			...filesLines,
		].join("\n");
		await writeFile(sbyPath, sbyContent);

		const result = await runCommand(options.sbyCommand ?? "sby", ["-f", sbyPath], materialized.workDir, 300_000);
		if (isMissingTool(result)) return issueFromMissingTool("symbiyosys", "prove", result);

		const combined = `${result.stdout}\n${result.stderr}`;
		const issues = parseLineIssues("sby", combined, "formal_fail", materialized.sources);

		const statusPath = join(materialized.workDir, "output", "engine_0", "status");
		let formalPass = false;
		let formalOutput = "";
		if (existsSync(statusPath)) {
			formalOutput = readFileSync(statusPath, "utf8").trim();
			formalPass = /PASS/i.test(formalOutput);
		}

		if (formalPass) {
			return {
				profile: "symbiyosys",
				stage: "prove",
				ok: true,
				commands: [result],
				issues: [],
				artifacts: { workDir: materialized.workDir },
			};
		}

		const traceVcd = join(materialized.workDir, "output", "engine_0", "trace.vcd");
		if (!hasErrorIssue(issues) && !formalPass && formalOutput) {
			issues.push({
				kind: "formal_fail",
				severity: "error",
				tool: "sby",
				message: formalOutput.includes("FAIL")
					? `Formal ${mode} failed (depth ${depth})`
					: `Formal ${mode} inconclusive: ${formalOutput}`,
			});
		}

		return {
			profile: "symbiyosys",
			stage: "prove",
			ok: false,
			commands: [result],
			issues: issues.length > 0 ? issues : [fallbackIssue("sby", "formal_fail", combined.slice(0, 500))],
			artifacts: {
				workDir: materialized.workDir,
				...(existsSync(traceVcd) ? { vcdPath: traceVcd } : {}),
			},
		};
	} finally {
		if (materialized.cleanup) {
			await rm(materialized.workDir, { recursive: true, force: true });
		}
	}
}

export async function runHimasim(options: HimasimOptions = {}): Promise<EdaToolRunResult> {
	const command = options.himasimCommand ?? "himasim";
	const result = await runCommand(command, ["--version"], process.cwd(), 10_000);
	if (isMissingTool(result) || !result.ok) {
		return {
			profile: "himasim",
			stage: "sim",
			ok: false,
			commands: [result],
			issues: [
				{
					kind: "missing_tool",
					severity: "error",
					tool: command,
					message: "Himasim profile is defined, but himasim is not available on PATH.",
				},
			],
		};
	}
	return {
		profile: "himasim",
		stage: "sim",
		ok: true,
		commands: [result],
		issues: [],
	};
}

function stageToQuartusModule(stage: EdaToolStage): string | undefined {
	switch (stage) {
		case "quartus-map":
			return "map";
		case "quartus-fit":
			return "fit";
		case "quartus-asm":
			return "asm";
		case "quartus-sta":
			return "sta";
	}
	return undefined;
}

function buildQuartusArgs(options: QuartusOptions): string[] {
	const args: string[] = [];
	if (options.use64Bit) args.push("--64bit");
	if (options.jvmHeapMax) args.push(`--jvm_heap_max=${options.jvmHeapMax}`);
	if (options.licServer) args.push(`--lic=${options.licServer}`);
	if (options.revision) args.push("--rev", options.revision);
	return args;
}

function generateQuartusProjectTcl(
	projectName: string,
	options: Required<Pick<QuartusOptions, "family" | "device">> & { top: string; rtlPaths: string[] },
): string {
	const lines = [
		"# Auto-generated by VeriGen Quartus runner",
		"load_package flow",
		"",
		`project_new -overwrite ${projectName}`,
		`set_global_assignment -name FAMILY "${options.family}"`,
		`set_global_assignment -name DEVICE ${options.device}`,
		`set_global_assignment -name TOP_LEVEL_ENTITY ${options.top}`,
		`set_global_assignment -name PROJECT_OUTPUT_DIRECTORY output_files`,
	];
	for (const p of options.rtlPaths) {
		lines.push(`set_global_assignment -name VERILOG_FILE "${p}"`);
	}
	lines.push("", "project_close");
	return lines.join("\n");
}

function generateQuartusCompileTcl(projectName: string, stage?: EdaToolStage): string {
	const lines = ["# Auto-generated by VeriGen Quartus runner", `load_package flow`, `project_open ${projectName}`, ""];
	if (stage && stage !== "quartus-compile") {
		const mod = stageToQuartusModule(stage);
		if (mod) {
			lines.push(`execute_module -tool ${mod}`);
		} else {
			lines.push("execute_module -tool map");
			lines.push("execute_module -tool fit");
			lines.push("execute_module -tool asm");
			lines.push("execute_module -tool sta");
		}
	} else {
		lines.push("execute_module -tool map");
		lines.push("execute_module -tool fit");
		lines.push("execute_module -tool asm");
		lines.push("execute_module -tool sta");
	}
	lines.push("", "project_close");
	return lines.join("\n");
}

function parseQuartusIssues(output: string, sources: Map<string, string>): EdaToolIssue[] {
	const issues: EdaToolIssue[] = [];
	const quartusErr = /^Error\s*\(\s*\d+\s*\):\s*(.+)$/im;
	const quartusWarn = /^Critical Warning\s*\(\s*\d+\s*\):\s*(.+)$/im;
	const common = /^(.+?):(\d+):\s*(error|warning):\s*(.+)$/i;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const commonMatch = line.match(common);
		if (commonMatch) {
			const severity: EdaToolIssueSeverity = commonMatch[3]?.toLowerCase() === "warning" ? "warning" : "error";
			issues.push({
				kind: severity === "warning" ? "width_warning" : "compile_error",
				severity,
				tool: "quartus",
				message: commonMatch[4] ?? line,
				file: resolve(commonMatch[1] ?? ""),
				line: Number.parseInt(commonMatch[2] ?? "0", 10),
				snippet: lineSnippet(commonMatch[1], Number.parseInt(commonMatch[2] ?? "0", 10), sources),
			});
			continue;
		}

		const errMatch = line.match(quartusErr);
		if (errMatch) {
			issues.push({
				kind: "compile_error",
				severity: "error",
				tool: "quartus",
				message: errMatch[1] ?? line,
			});
			continue;
		}

		const warnMatch = line.match(quartusWarn);
		if (warnMatch) {
			issues.push({
				kind: "width_warning",
				severity: "warning",
				tool: "quartus",
				message: warnMatch[1] ?? line,
			});
		}
	}
	return issues;
}

export async function runQuartus(options: QuartusOptions): Promise<EdaToolRunResult> {
	const stage = options.stage ?? "quartus-compile";
	const isPgm = stage === "quartus-pgm";
	const isProjectOnly = stage === "quartus-project";

	if (isPgm) {
		const cmd = options.quartusCommand ?? "quartus_pgm";
		const cable = options.programmer?.cable ?? "USB-Blaster";
		const mode = options.programmer?.mode ?? "JTAG";
		const sof = options.programmer?.sofFile ?? `${options.top ?? "output_files/verigen_top"}.sof`;
		const pgmArg = `p;${sof}@${mode}`;
		const result = await runCommand(cmd, ["-c", cable, "-m", mode, "-o", pgmArg], process.cwd(), 120_000);
		if (isMissingTool(result)) return issueFromMissingTool("quartus", "quartus-pgm", result);
		const combined = `${result.stdout}\n${result.stderr}`;
		return {
			profile: "quartus",
			stage: "quartus-pgm",
			ok: result.ok,
			commands: [result],
			issues: parseQuartusIssues(combined, new Map()),
		};
	}

	const materialized = await materializeInputs(options.rtl, {
		workDir: options.workDir,
		keepWorkDir: options.keepWorkDir,
		prefix: "verigen-quartus-",
	});
	try {
		const projectName = options.top ?? "verigen_top";
		const device = options.device ?? "EP4CE10F17C8";
		const family = options.family ?? "Cyclone IV E";
		const command = options.quartusCommand ?? "quartus_sh";
		const baseArgs = buildQuartusArgs(options);

		if (isProjectOnly) {
			const tcl = generateQuartusProjectTcl(projectName, {
				top: projectName,
				family,
				device,
				rtlPaths: materialized.paths,
			});
			const tclPath = join(materialized.workDir, `${projectName}_create.tcl`);
			await writeFile(tclPath, tcl);
			const result = await runCommand(command, [...baseArgs, "-t", tclPath], materialized.workDir, 60_000);
			if (isMissingTool(result)) return issueFromMissingTool("quartus", "quartus-project", result);
			return {
				profile: "quartus",
				stage: "quartus-project",
				ok: result.ok,
				commands: [result],
				issues: parseQuartusIssues(`${result.stdout}\n${result.stderr}`, materialized.sources),
				artifacts: { workDir: materialized.workDir },
			};
		}

		const projectQpf = `${projectName}.qpf`;
		const projectExists = existsSync(join(materialized.workDir, projectQpf));

		if (!projectExists) {
			const createTcl = generateQuartusProjectTcl(projectName, {
				top: projectName,
				family,
				device,
				rtlPaths: materialized.paths,
			});
			const createTclPath = join(materialized.workDir, `${projectName}_create.tcl`);
			await writeFile(createTclPath, createTcl);
			const createResult = await runCommand(
				command,
				[...baseArgs, "-t", createTclPath],
				materialized.workDir,
				60_000,
			);
			if (isMissingTool(createResult)) {
				return issueFromMissingTool("quartus", stage, createResult);
			}
			if (!createResult.ok) {
				return {
					profile: "quartus",
					stage: "quartus-project",
					ok: false,
					commands: [createResult],
					issues: parseQuartusIssues(`${createResult.stdout}\n${createResult.stderr}`, materialized.sources),
					artifacts: { workDir: materialized.workDir },
				};
			}
		}

		const tcl = generateQuartusCompileTcl(projectName, stage);
		const tclPath = join(materialized.workDir, `${projectName}_compile.tcl`);
		await writeFile(tclPath, tcl);
		const result = await runCommand(
			command,
			[...baseArgs, "-t", tclPath],
			materialized.workDir,
			stage === "quartus-map" ? 180_000 : 300_000,
		);
		if (isMissingTool(result)) return issueFromMissingTool("quartus", stage, result);

		const combined = `${result.stdout}\n${result.stderr}`;
		const issues = parseQuartusIssues(combined, materialized.sources);

		if (!result.ok && issues.length === 0) {
			const errLine = combined.split(/\r?\n/).find((l) => /^Error/i.test(l));
			issues.push(fallbackIssue("quartus", "compile_error", errLine ?? combined.slice(0, 500)));
		}

		return {
			profile: "quartus",
			stage,
			ok: result.ok && !hasErrorIssue(issues),
			commands: [result],
			issues,
			artifacts: { workDir: materialized.workDir },
		};
	} finally {
		if (materialized.cleanup) {
			await rm(materialized.workDir, { recursive: true, force: true });
		}
	}
}

export function basenameForIssue(issue: EdaToolIssue): string {
	return issue.file ? basename(issue.file) : issue.tool;
}
