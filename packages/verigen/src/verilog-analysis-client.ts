import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bootstrapPythonWorker } from "./python-worker-bootstrap.ts";
import type {
	BuildControlflowArgs,
	BuildControlflowResult,
	IdentifySeqElementArgs,
	IdentifySeqElementResult,
	ParseAstArgs,
	ParseAstResult,
	TraceWaveformArgs,
	TraceWaveformResult,
	VerilogAnalysisClientOptions,
	WorkerFunctionName,
} from "./types.ts";

interface WorkerRequestFrame {
	id: number;
	fn: WorkerFunctionName;
	args: object;
}

interface PendingRequest {
	fn: WorkerFunctionName;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

const defaultRequestTimeoutMs = 30_000;
const defaultCloseTimeoutMs = 1_000;
const defaultStderrLimitBytes = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailsToMessage(details: unknown): string {
	if (typeof details === "string") return details;
	if (isRecord(details) && typeof details.msg === "string") return details.msg;
	if (Array.isArray(details)) {
		const firstMessage = details.find((item) => isRecord(item) && typeof item.msg === "string");
		if (isRecord(firstMessage) && typeof firstMessage.msg === "string") return firstMessage.msg;
	}
	return JSON.stringify(details);
}

function trimStderr(current: string, chunk: string, limitBytes: number): string {
	const combined = current + chunk;
	if (combined.length <= limitBytes) return combined;
	return combined.slice(combined.length - limitBytes);
}

function workerCwdCandidateExists(path: string): boolean {
	return existsSync(join(path, "pyproject.toml")) && existsSync(join(path, "src", "verilog_analysis", "server.py"));
}

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

function workerVenvLaunch(workerCwd: string): { command: string; args: string[] } | undefined {
	const binDir = process.platform === "win32" ? "Scripts" : "bin";
	const python = resolve(workerCwd, ".venv", binDir, executableName("python"));
	const workerCommand = resolve(workerCwd, ".venv", binDir, executableName("verigen-verilog-analysis"));
	return existsSync(python) && existsSync(workerCommand)
		? { command: python, args: ["-m", "verilog_analysis"] }
		: undefined;
}

function defaultWorkerCwd(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(process.cwd(), "packages/verilog-analysis"),
		resolve(process.cwd(), "../verilog-analysis"),
		resolve(moduleDir, "../../verilog-analysis"),
		resolve(moduleDir, "../verilog-analysis"),
	];
	for (const candidate of candidates) {
		if (workerCwdCandidateExists(candidate)) return candidate;
	}
	return candidates[0];
}

function workerErrorFromFrame(frame: unknown): VerilogAnalysisError {
	if (isRecord(frame) && typeof frame.kind === "string") {
		return new VerilogAnalysisError(frame.kind, frame.details);
	}
	return new VerilogAnalysisError("protocol_error", frame);
}

async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

export class VerilogAnalysisError extends Error {
	kind: string;
	details: unknown;

	constructor(kind: string, details: unknown) {
		super(`Verilog analysis ${kind}: ${detailsToMessage(details)}`);
		this.name = "VerilogAnalysisError";
		this.kind = kind;
		this.details = details;
	}
}

export class VerilogAnalysis {
	private options: VerilogAnalysisClientOptions;
	private process: ChildProcessWithoutNullStreams | null = null;
	private lineReader: Interface | null = null;
	private pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private stderr = "";
	private exitError: Error | null = null;
	private starting: Promise<void> | null = null;

	constructor(options: VerilogAnalysisClientOptions = {}) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.process) return;
		if (this.starting) {
			await this.starting;
			return;
		}
		this.starting = this.startProcess();
		try {
			await this.starting;
		} finally {
			this.starting = null;
		}
	}

	private async startProcess(): Promise<void> {
		this.exitError = null;
		this.stderr = "";
		const launch = await this.resolveLaunch();
		const child = spawn(launch.command, launch.args, {
			cwd: launch.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: "pipe",
			windowsHide: true,
		});
		this.process = child;

		const stderrLimitBytes = this.options.stderrLimitBytes ?? defaultStderrLimitBytes;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = trimStderr(this.stderr, chunk, stderrLimitBytes);
			this.options.onStderr?.(chunk);
		});

		child.once("error", (error) => {
			if (this.process !== child) return;
			const processError = new Error(`Verilog analysis worker error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPending(processError);
		});

		child.once("exit", (code, signal) => {
			if (this.process !== child) return;
			const processError = new Error(
				`Verilog analysis worker exited with code ${code ?? "null"} signal ${signal ?? "null"}. Stderr: ${this.stderr}`,
			);
			this.exitError = processError;
			this.rejectPending(processError);
		});

		child.stdin.on("error", (error) => {
			if (this.process !== child) return;
			const stdinError = this.exitError ?? new Error(`Verilog analysis worker stdin error: ${error.message}`);
			this.exitError = stdinError;
			this.rejectPending(stdinError);
		});

		this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
		this.lineReader.on("line", (line) => {
			this.handleLine(line);
		});
	}

	async close(): Promise<void> {
		const child = this.process;
		if (!child) return;

		this.lineReader?.close();
		this.lineReader = null;
		this.process = null;
		const closeError = new Error("Verilog analysis worker closed");
		this.rejectPending(closeError);

		if (child.stdin.writable) {
			child.stdin.write(`${JSON.stringify({ id: 0, fn: "shutdown", args: {} })}\n`);
			child.stdin.end();
		}
		await delay(this.options.closeTimeoutMs ?? defaultCloseTimeoutMs);
		this.killChild(child, "SIGTERM");
		await delay(100);
		this.killChild(child, "SIGKILL");
		child.unref();
		child.stdout.destroy();
		child.stderr.destroy();
		child.stdin.destroy();
	}

	private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
		if (child.pid) {
			try {
				process.kill(child.pid, signal);
				return;
			} catch {
				// Fall back to ChildProcess.kill below.
			}
		}
		try {
			child.kill(signal);
		} catch {
			// The process may have already exited.
		}
	}

	async request<TResult>(fn: WorkerFunctionName, args: object): Promise<TResult> {
		await this.start();
		const child = this.process;
		if (!child) {
			throw new Error("Verilog analysis worker did not start");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (!child.stdin.writable) {
			throw new Error(`Verilog analysis worker stdin is not writable. Stderr: ${this.stderr}`);
		}

		const id = this.nextId;
		this.nextId += 1;
		const frame: WorkerRequestFrame = { id, fn, args };
		const timeoutMs = this.options.requestTimeoutMs ?? defaultRequestTimeoutMs;

		return await new Promise<TResult>((resolvePromise, rejectPromise) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectPromise(new Error(`Verilog analysis request ${id} (${fn}) timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				fn,
				resolve: (value) => {
					resolvePromise(value as TResult);
				},
				reject: rejectPromise,
				timeout,
			});

			child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timeout);
				rejectPromise(error);
			});
		});
	}

	async parseAst(args: ParseAstArgs): Promise<ParseAstResult> {
		return await this.request<ParseAstResult>("parse_ast", args);
	}

	async buildControlflow(args: BuildControlflowArgs): Promise<BuildControlflowResult> {
		return await this.request<BuildControlflowResult>("build_controlflow", args);
	}

	async traceWaveform(args: TraceWaveformArgs): Promise<TraceWaveformResult> {
		return await this.request<TraceWaveformResult>("trace_waveform", args);
	}

	async identifySeqElement(args: IdentifySeqElementArgs): Promise<IdentifySeqElementResult> {
		return await this.request<IdentifySeqElementResult>("identify_seq_element", args);
	}

	private async resolveLaunch(): Promise<{ command: string; args: string[]; cwd: string }> {
		if (this.options.command || this.options.args || this.options.workerCwd) {
			const cwd = this.options.workerCwd ?? defaultWorkerCwd();
			const directWorkerLaunch = this.options.command ? undefined : workerVenvLaunch(cwd);
			return {
				command: this.options.command ?? directWorkerLaunch?.command ?? "uv",
				args: this.options.args ?? directWorkerLaunch?.args ?? ["run", "verigen-verilog-analysis"],
				cwd,
			};
		}
		const launch = await bootstrapPythonWorker({
			packageRoot: this.options.packageRoot,
			workerRoot: this.options.workerRoot,
			cacheRoot: this.options.cacheRoot,
			uvCommand: this.options.uvCommand,
			env: this.options.env,
			bootstrap: this.options.bootstrap,
		});
		return { command: launch.command, args: launch.args, cwd: launch.cwd };
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			const parseError = error instanceof Error ? error : new Error(String(error));
			this.rejectPending(new Error(`Invalid JSON from Verilog analysis worker: ${parseError.message}`));
			return;
		}

		if (!isRecord(parsed) || typeof parsed.id !== "number") {
			this.rejectPending(new Error(`Invalid Verilog analysis response frame: ${line}`));
			return;
		}

		const pending = this.pending.get(parsed.id);
		if (!pending) return;

		this.pending.delete(parsed.id);
		clearTimeout(pending.timeout);

		if (parsed.ok === true) {
			pending.resolve(parsed.result);
			return;
		}

		if (parsed.ok === false) {
			pending.reject(workerErrorFromFrame(parsed.error));
			return;
		}

		pending.reject(new Error(`Invalid Verilog analysis response for request ${parsed.id} (${pending.fn})`));
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}
