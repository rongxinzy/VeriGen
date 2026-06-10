import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);

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

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name;
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

export function buildVerigenAgentLaunch(options: VerigenAgentLaunchOptions = {}): VerigenAgentLaunch {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const assets = findVerigenAgentAssets(packageRoot);
	const launcher = resolvePiLauncher(packageRoot, options.piCommand ?? process.env.VERIGEN_PI_COMMAND);
	const args = [
		...launcher.args,
		"--system-prompt",
		assets.systemPrompt,
		...assets.promptTemplates.flatMap((promptPath) => ["--prompt-template", promptPath]),
		...assets.skills.flatMap((skillPath) => ["--skill", skillPath]),
		...assets.extensions.flatMap((extensionPath) => ["--extension", extensionPath]),
		...(options.piArgs ?? []),
	];
	return {
		command: launcher.command,
		args,
		assets,
	};
}

export async function runVerigenAgent(options: VerigenAgentLaunchOptions = {}): Promise<VerigenAgentRunResult> {
	const launch = buildVerigenAgentLaunch(options);
	const child = spawn(launch.command, launch.args, {
		stdio: "inherit",
		env: process.env,
		shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(launch.command),
	});
	return await new Promise((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", (exitCode, signal) => {
			resolvePromise({ exitCode: exitCode ?? 1, signal });
		});
	});
}
