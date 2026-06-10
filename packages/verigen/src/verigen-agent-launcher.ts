import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const defaultAgentProvider = "verigen-kimi";
const defaultAgentModel = "kimi-for-coding";
const verigenLatestUrl = "https://registry.npmjs.org/verigen/latest";
const versionCheckTimeoutMs = 5_000;

export interface VerigenAgentAssets {
	systemPrompt: string;
	promptTemplates: string[];
	skills: string[];
	extensions: string[];
}

export interface VerigenAgentLaunchOptions {
	packageRoot?: string;
	piCommand?: string;
	piArgs?: string[];
}

export interface VerigenAgentLaunch {
	command: string;
	args: string[];
	assets: VerigenAgentAssets;
}

export interface VerigenAgentRunResult {
	exitCode: number;
	signal: NodeJS.Signals | null;
}

interface PackageJson {
	version?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function envFlagEnabled(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function defaultPackageRoot(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const dirName = basename(moduleDir);
	if (dirName === "src" || dirName === "dist") return dirname(moduleDir);
	return moduleDir;
}

function markdownFiles(dir: string, prefix: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".md"))
		.map((entry) => join(dir, entry))
		.sort();
}

function firstExisting(paths: string[]): string | undefined {
	return paths.find((candidate) => existsSync(candidate));
}

function nodeModuleSearchDirs(packageRoot: string): string[] {
	const dirs = new Set<string>();
	let current = resolve(packageRoot);
	while (true) {
		dirs.add(join(current, "node_modules"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const searchPath of requireFromHere.resolve.paths("@earendil-works/pi-coding-agent") ?? []) {
		dirs.add(searchPath);
	}
	return [...dirs];
}

function resolveNodeModuleFile(packageRoot: string, packageName: string, relativeFile: string): string | undefined {
	const packageParts = packageName.split("/");
	for (const nodeModulesDir of nodeModuleSearchDirs(packageRoot)) {
		const candidate = join(nodeModulesDir, ...packageParts, relativeFile);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function resolveRepoRoot(packageRoot: string): string {
	return resolve(packageRoot, "../..");
}

function nativeToolTargetId(): string {
	return `${process.platform}-${process.arch}`;
}

export function findBundledNativeToolDir(packageRoot = defaultPackageRoot()): string | undefined {
	const candidate = join(packageRoot, "dist", "native-tools", nativeToolTargetId());
	return existsSync(candidate) ? candidate : undefined;
}

export function findVerigenAgentAssets(packageRoot = defaultPackageRoot()): VerigenAgentAssets {
	const repoRoot = resolveRepoRoot(packageRoot);
	const bundledPromptDir = join(packageRoot, "dist", "pi-assets", "prompts");
	const bundledSkillDir = join(packageRoot, "dist", "pi-assets", "skills");
	const bundledExtension = join(packageRoot, "dist", "verigen-coding-agent-extension.js");
	const sourcePromptDir = join(repoRoot, ".pi", "prompts");
	const sourceSkillDir = join(repoRoot, ".pi", "skills");
	const sourceExtension = join(packageRoot, "src", "verigen-coding-agent-extension.ts");
	const isSourceCheckout = existsSync(join(packageRoot, "src")) && existsSync(sourcePromptDir);
	const promptDir = isSourceCheckout ? sourcePromptDir : bundledPromptDir;
	const skillDir = isSourceCheckout ? sourceSkillDir : bundledSkillDir;
	const extension = firstExisting(isSourceCheckout ? [sourceExtension, bundledExtension] : [bundledExtension]);
	const systemPrompt = firstExisting([
		join(promptDir, "verigen-system.md"),
		join(sourcePromptDir, "verigen-system.md"),
	]);
	if (!systemPrompt) {
		throw new Error("Could not find verigen-system.md in bundled or source prompt assets");
	}
	return {
		systemPrompt,
		promptTemplates: markdownFiles(promptDir, "verigen-").filter(
			(filePath) => basename(filePath) !== "verigen-system.md",
		),
		skills: markdownFiles(skillDir, "verigen-"),
		extensions: extension ? [extension] : [],
	};
}

function resolvePiLauncher(packageRoot: string, piCommand?: string): { command: string; args: string[] } {
	if (piCommand) return { command: piCommand, args: [] };

	const repoRoot = resolveRepoRoot(packageRoot);
	const sourceCheckoutLauncher = join(repoRoot, "pi-test.sh");
	const sourceCli = resolve(packageRoot, "../coding-agent/src/cli.ts");
	if (existsSync(sourceCheckoutLauncher) && existsSync(sourceCli)) {
		return { command: sourceCheckoutLauncher, args: [] };
	}

	const sourceTsx = join(repoRoot, "node_modules", ".bin", executableName("tsx"));
	if (existsSync(sourceCli)) {
		if (existsSync(sourceTsx)) {
			return { command: sourceTsx, args: ["--tsconfig", join(repoRoot, "tsconfig.json"), sourceCli] };
		}
		return { command: process.execPath, args: [sourceCli] };
	}

	const dependencyCli = resolveNodeModuleFile(packageRoot, "@earendil-works/pi-coding-agent", join("dist", "cli.js"));
	if (dependencyCli) {
		return { command: process.execPath, args: [dependencyCli] };
	}

	const localBin = join(packageRoot, "node_modules", ".bin", executableName("pi"));
	if (existsSync(localBin)) {
		return { command: localBin, args: [] };
	}

	return { command: executableName("pi"), args: [] };
}

function hasModelSelection(args: string[]): boolean {
	return args.includes("--model") || args.includes("--provider") || args.includes("--models");
}

function shouldInjectDefaultModel(args: string[], assets: VerigenAgentAssets): boolean {
	return assets.extensions.length > 0 && !args.includes("--no-extensions") && !hasModelSelection(args);
}

function defaultModelArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const model = env.VERIGEN_TEST_LLM_MODEL?.trim() || defaultAgentModel;
	return ["--model", `${defaultAgentProvider}/${model}`];
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
	if (process.platform !== "win32") return "PATH";
	const existingKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
	return existingKey ?? "Path";
}

export function buildVerigenAgentEnv(
	packageRoot = defaultPackageRoot(),
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const nextEnv: NodeJS.ProcessEnv = { ...env };
	nextEnv.PI_SKIP_VERSION_CHECK = "1";
	if (!envFlagEnabled(nextEnv.VERIGEN_ALLOW_STARTUP_DOWNLOADS) && nextEnv.PI_OFFLINE === undefined) {
		nextEnv.PI_OFFLINE = "1";
	}

	const nativeToolDir = findBundledNativeToolDir(packageRoot);
	if (nativeToolDir) {
		const key = pathEnvKey(nextEnv);
		const currentPath = nextEnv[key] ?? nextEnv.PATH ?? "";
		nextEnv[key] = currentPath ? `${nativeToolDir}${delimiter}${currentPath}` : nativeToolDir;
	}

	return nextEnv;
}

export function buildVerigenAgentLaunch(options: VerigenAgentLaunchOptions = {}): VerigenAgentLaunch {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const assets = findVerigenAgentAssets(packageRoot);
	const launcher = resolvePiLauncher(packageRoot, options.piCommand ?? process.env.VERIGEN_PI_COMMAND);
	const piArgs = options.piArgs ?? [];
	const args = [
		...launcher.args,
		"--system-prompt",
		assets.systemPrompt,
		...assets.promptTemplates.flatMap((promptPath) => ["--prompt-template", promptPath]),
		...assets.skills.flatMap((skillPath) => ["--skill", skillPath]),
		...assets.extensions.flatMap((extensionPath) => ["--extension", extensionPath]),
		...(shouldInjectDefaultModel(piArgs, assets) ? defaultModelArgs() : []),
		...piArgs,
	];
	return {
		command: launcher.command,
		args,
		assets,
	};
}

function parseVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

function isNewerVersion(candidateVersion: string, currentVersion: string): boolean {
	const candidate = parseVersion(candidateVersion);
	const current = parseVersion(currentVersion);
	if (!candidate || !current) return candidateVersion.trim() !== currentVersion.trim();
	if (candidate.major !== current.major) return candidate.major > current.major;
	if (candidate.minor !== current.minor) return candidate.minor > current.minor;
	if (candidate.patch !== current.patch) return candidate.patch > current.patch;
	if (candidate.prerelease === current.prerelease) return false;
	if (!candidate.prerelease) return true;
	if (!current.prerelease) return false;
	return candidate.prerelease.localeCompare(current.prerelease) > 0;
}

export function readVerigenPackageVersion(packageRoot = defaultPackageRoot()): string | undefined {
	try {
		const packageJson = requireFromHere(join(packageRoot, "package.json")) as PackageJson;
		return typeof packageJson.version === "string" ? packageJson.version : undefined;
	} catch {
		return undefined;
	}
}

async function checkLatestVerigenVersion(currentVersion: string): Promise<string | undefined> {
	if (envFlagEnabled(process.env.PI_OFFLINE) || envFlagEnabled(process.env.VERIGEN_SKIP_VERSION_CHECK)) {
		return undefined;
	}
	try {
		const response = await fetch(verigenLatestUrl, {
			headers: { "User-Agent": `verigen/${currentVersion}` },
			signal: AbortSignal.timeout(versionCheckTimeoutMs),
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { version?: unknown };
		if (typeof data.version !== "string") return undefined;
		return isNewerVersion(data.version, currentVersion) ? data.version : undefined;
	} catch {
		return undefined;
	}
}

async function printVerigenUpdateNotice(packageRoot: string): Promise<void> {
	const currentVersion = readVerigenPackageVersion(packageRoot);
	if (!currentVersion) return;
	const latestVersion = await checkLatestVerigenVersion(currentVersion);
	if (!latestVersion) return;
	console.log("Update Available");
	console.log(`New verigen version ${latestVersion} is available.`);
	console.log("Run: npm install -g verigen@latest");
	console.log("Changelog: https://github.com/rongxinzy/VeriGen/releases");
	console.log("");
}

export async function runVerigenAgent(options: VerigenAgentLaunchOptions = {}): Promise<VerigenAgentRunResult> {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	await printVerigenUpdateNotice(packageRoot);
	const launch = buildVerigenAgentLaunch(options);
	const child = spawn(launch.command, launch.args, {
		stdio: "inherit",
		env: buildVerigenAgentEnv(packageRoot),
		shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(launch.command),
	});
	return await new Promise((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", (exitCode, signal) => {
			resolvePromise({ exitCode: exitCode ?? 1, signal });
		});
	});
}
