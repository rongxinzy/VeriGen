import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphifyContext } from "./graphify-context.ts";
import { executableName, findBundledNativeTool } from "./native-tools.ts";

export interface PythonWorkerBootstrapOptions {
	packageRoot?: string;
	workerRoot?: string;
	cacheRoot?: string;
	uvCommand?: string;
	env?: Record<string, string>;
	force?: boolean;
	bootstrap?: boolean;
}

export interface PythonWorkerLaunch {
	command: string;
	args: string[];
	cwd: string;
	workerRoot: string;
	venvDir: string;
	pythonPath: string;
	wasBootstrapped: boolean;
	commands: CommandResult[];
}

export interface CommandResult {
	command: string;
	args: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	ok: boolean;
}

export type DoctorCheckState = "ok" | "warn" | "error";

export interface DoctorCheck {
	name: string;
	state: DoctorCheckState;
	message: string;
	required: boolean;
	details?: Record<string, string | number | boolean>;
}

export interface VerigenDoctorResult {
	ok: boolean;
	checks: DoctorCheck[];
	workerLaunch?: PythonWorkerLaunch;
}

interface VenvPaths {
	venvDir: string;
	pythonPath: string;
	workerCommand: string;
}

const defaultCommandTimeoutMs = 120_000;
const outputLimit = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOutput(current: string, chunk: string): string {
	const combined = current + chunk;
	if (combined.length <= outputLimit) return combined;
	return combined.slice(combined.length - outputLimit);
}

function currentPackageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function currentPackageVersion(packageRoot: string): string {
	const packageJsonPath = join(packageRoot, "package.json");
	if (!existsSync(packageJsonPath)) return "0.0.0";
	try {
		const text = statSync(packageJsonPath).isFile() ? readFileSync(packageJsonPath, "utf8") : '{"version":"0.0.0"}';
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
	} catch {
		return "0.0.0";
	}
	return "0.0.0";
}

function hashPath(path: string): string {
	const realPath = existsSync(path) ? realpathSync(path) : path;
	return createHash("sha256").update(realPath).digest("hex").slice(0, 12);
}

function binDir(venvDir: string): string {
	return process.platform === "win32" ? join(venvDir, "Scripts") : join(venvDir, "bin");
}

function defaultCacheRoot(): string {
	const configured = process.env.VERIGEN_CACHE_DIR;
	if (configured) return resolve(configured);
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	if (xdgCacheHome) return resolve(xdgCacheHome, "verigen");
	if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "verigen");
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) return join(localAppData, "VeriGen", "Cache");
	}
	return join(homedir(), ".cache", "verigen");
}

function venvPaths(cacheRoot: string, packageVersion: string, workerRoot: string): VenvPaths {
	const venvDir = join(cacheRoot, "python", `${packageVersion}-${hashPath(workerRoot)}`);
	const venvBinDir = binDir(venvDir);
	return {
		venvDir,
		pythonPath: join(venvBinDir, executableName("python")),
		workerCommand: join(venvBinDir, executableName("verigen-verilog-analysis")),
	};
}

function pathLooksExecutable(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function pythonWorkerRootLooksValid(workerRoot: string): boolean {
	return (
		existsSync(join(workerRoot, "pyproject.toml")) &&
		existsSync(join(workerRoot, "uv.lock")) &&
		existsSync(join(workerRoot, "src", "verilog_analysis", "__main__.py")) &&
		existsSync(join(workerRoot, "vendor", "pyverilog", "pyverilog", "__init__.py"))
	);
}

export function findBundledPythonWorkerRoot(packageRoot = currentPackageRoot()): string {
	const candidates = [
		resolve(packageRoot, "dist", "python", "verilog-analysis"),
		resolve(packageRoot, "python", "verilog-analysis"),
		resolve(packageRoot, "../verilog-analysis"),
		resolve(process.cwd(), "packages/verilog-analysis"),
	];
	for (const candidate of candidates) {
		if (pythonWorkerRootLooksValid(candidate)) return candidate;
	}
	return candidates[0];
}

export function findBundledUv(packageRoot = currentPackageRoot()): string | undefined {
	return findBundledNativeTool(packageRoot, "uv");
}

function resolveUvEnv(env?: Record<string, string>): Record<string, string> | undefined {
	const mirror = (env?.VERIGEN_UV_MIRROR ?? process.env.VERIGEN_UV_MIRROR)?.trim() ?? "tuna";
	if (mirror === "off" || mirror === "0" || mirror === "false" || mirror === "") return env;
	const result: Record<string, string> = { ...env };
	if (mirror === "tuna" || mirror === "tsinghua") {
		result.UV_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple";
		result.UV_PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone";
	} else if (mirror === "aliyun" || mirror === "ali") {
		result.UV_INDEX_URL = "https://mirrors.aliyun.com/pypi/simple/";
	} else if (mirror.startsWith("http://") || mirror.startsWith("https://")) {
		result.UV_INDEX_URL = mirror;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, options.timeoutMs ?? defaultCommandTimeoutMs);
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
				exitCode: null,
				stdout,
				stderr: trimOutput(stderr, error.message),
				ok: false,
			});
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolvePromise({ command, args, exitCode, stdout, stderr, ok: exitCode === 0 });
		});
	});
}

async function commandProbe(command: string, args: string[]): Promise<CommandResult> {
	return await runCommand(command, args, { timeoutMs: 10_000 });
}

export async function bootstrapPythonWorker(options: PythonWorkerBootstrapOptions = {}): Promise<PythonWorkerLaunch> {
	const packageRoot = options.packageRoot ? resolve(options.packageRoot) : currentPackageRoot();
	const workerRoot = options.workerRoot ? resolve(options.workerRoot) : findBundledPythonWorkerRoot(packageRoot);
	if (!pythonWorkerRootLooksValid(workerRoot)) {
		throw new Error(`VeriGen Python worker is missing or incomplete at ${workerRoot}`);
	}

	const cacheRoot = options.cacheRoot ? resolve(options.cacheRoot) : defaultCacheRoot();
	const packageVersion = currentPackageVersion(packageRoot);
	const paths = venvPaths(cacheRoot, packageVersion, workerRoot);
	const command = options.uvCommand ?? findBundledUv(packageRoot) ?? "uv";
	const bootstrapEnv = resolveUvEnv(options.env);
	const commands: CommandResult[] = [];
	if (!options.force && pathLooksExecutable(paths.pythonPath) && pathLooksExecutable(paths.workerCommand)) {
		return {
			command: paths.pythonPath,
			args: ["-m", "verilog_analysis"],
			cwd: workerRoot,
			workerRoot,
			venvDir: paths.venvDir,
			pythonPath: paths.pythonPath,
			wasBootstrapped: false,
			commands,
		};
	}

	if (options.bootstrap === false || process.env.VERIGEN_SKIP_PYTHON_BOOTSTRAP === "1") {
		throw new Error(`VeriGen Python worker venv is missing at ${paths.venvDir}; run verigen doctor to bootstrap it`);
	}

	const venv = await runCommand(command, ["venv", "--python", "3.11", paths.venvDir], { env: bootstrapEnv });
	commands.push(venv);
	if (!venv.ok) {
		throw new Error(`Failed to create VeriGen Python worker venv with ${command}: ${venv.stderr || venv.stdout}`);
	}
	const install = await runCommand(command, ["pip", "install", "--python", paths.pythonPath, workerRoot], {
		env: bootstrapEnv,
	});
	commands.push(install);
	if (!install.ok) {
		throw new Error(
			`Failed to install VeriGen Python worker into ${paths.venvDir}: ${install.stderr || install.stdout}`,
		);
	}
	if (!pathLooksExecutable(paths.workerCommand)) {
		throw new Error(`VeriGen Python worker command was not created at ${paths.workerCommand}`);
	}

	return {
		command: paths.pythonPath,
		args: ["-m", "verilog_analysis"],
		cwd: workerRoot,
		workerRoot,
		venvDir: paths.venvDir,
		pythonPath: paths.pythonPath,
		wasBootstrapped: true,
		commands,
	};
}

function checkState(ok: boolean, required: boolean): DoctorCheckState {
	if (ok) return "ok";
	return required ? "error" : "warn";
}

function commandCheck(name: string, result: CommandResult, required: boolean): DoctorCheck {
	const message = result.ok
		? `${name} available`
		: `${name} unavailable: ${result.stderr || result.stdout || "command failed"}`;
	return {
		name,
		state: checkState(result.ok, required),
		message,
		required,
		details: { command: result.command, exitCode: result.exitCode ?? -1 },
	};
}

function optionalEdaToolCheck(name: string, result: CommandResult, repair: string): DoctorCheck {
	if (result.ok) {
		return commandCheck(name, result, false);
	}
	return {
		name,
		state: "warn",
		message: `${name} unavailable: ${result.stderr || result.stdout || "command failed"}. ${repair}`,
		required: false,
		details: { command: result.command, exitCode: result.exitCode ?? -1, repair },
	};
}

export async function doctorVerigenInstall(
	options: PythonWorkerBootstrapOptions & { repoRoot?: string } = {},
): Promise<VerigenDoctorResult> {
	const checks: DoctorCheck[] = [
		{
			name: "node",
			state: "ok",
			message: `Node ${process.version}`,
			required: true,
		},
	];

	const packageRoot = options.packageRoot ? resolve(options.packageRoot) : currentPackageRoot();
	const workerRoot = options.workerRoot ? resolve(options.workerRoot) : findBundledPythonWorkerRoot(packageRoot);
	const workerOk = pythonWorkerRootLooksValid(workerRoot);
	checks.push({
		name: "python-worker",
		state: workerOk ? "ok" : "error",
		message: workerOk
			? `worker source found at ${workerRoot}`
			: `worker source missing or incomplete at ${workerRoot}`,
		required: true,
	});

	const uvCommand = options.uvCommand ?? findBundledUv(packageRoot) ?? "uv";
	const uv = await commandProbe(uvCommand, ["--version"]);
	checks.push(commandCheck("uv", uv, true));
	const iverilog = await commandProbe("iverilog", ["-V"]);
	checks.push(commandCheck("iverilog", iverilog, true));
	const vvp = await commandProbe("vvp", ["-V"]);
	checks.push(commandCheck("vvp", vvp, true));
	const verilator = await commandProbe("verilator", ["--version"]);
	checks.push(optionalEdaToolCheck("verilator", verilator, "Install Verilator to enable S6 lint profile."));
	const yosys = await commandProbe("yosys", ["-V"]);
	checks.push(optionalEdaToolCheck("yosys", yosys, "Install Yosys to enable S6 synth profile."));
	const himasim = await commandProbe("himasim", ["--version"]);
	checks.push(optionalEdaToolCheck("himasim", himasim, "Install Himasim when that simulator backend is available."));

	let workerLaunch: PythonWorkerLaunch | undefined;
	if (workerOk && uv.ok) {
		try {
			workerLaunch = await bootstrapPythonWorker({ ...options, packageRoot, workerRoot, uvCommand });
			checks.push({
				name: "worker-venv",
				state: "ok",
				message: workerLaunch.wasBootstrapped
					? `created worker venv at ${workerLaunch.venvDir}`
					: `worker venv ready at ${workerLaunch.venvDir}`,
				required: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push({ name: "worker-venv", state: "error", message, required: true });
		}
	}

	const repoRoot = options.repoRoot ? resolve(options.repoRoot) : process.cwd();
	const graphifyStatus = await new GraphifyContext({ repoRoot }).status();
	checks.push({
		name: "graphify-index",
		state: graphifyStatus.state === "ready" ? "ok" : "warn",
		message:
			graphifyStatus.state === "ready"
				? `Graphify index ready at ${graphifyStatus.graphPath}`
				: `Graphify index missing or stale at ${graphifyStatus.graphPath}`,
		required: false,
		details: { nodeCount: graphifyStatus.nodeCount, edgeCount: graphifyStatus.edgeCount },
	});

	return { ok: checks.every((check) => check.state !== "error"), checks, workerLaunch };
}
