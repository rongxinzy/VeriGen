import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "../..");
const sourceWorker = resolve(repoRoot, "packages/verilog-analysis");
const targetWorker = resolve(packageRoot, "dist/python/verilog-analysis");
const targetAssets = resolve(packageRoot, "dist/pi-assets");

const excludedNames = new Set([
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".venv",
	"__pycache__",
	"build",
	"dist",
	"requirements.lock.txt",
	"wheelhouse",
]);

function shouldCopy(source) {
	const name = basename(source);
	if (excludedNames.has(name)) return false;
	if (name.endsWith(".pyc")) return false;
	if (name.endsWith(".pyo")) return false;
	return true;
}

function copyDirectory(source, target) {
	rmSync(target, { recursive: true, force: true });
	cpSync(source, target, {
		recursive: true,
		filter: shouldCopy,
	});
}

function copyMarkdownFiles(source, target, prefix) {
	if (!existsSync(source)) return;
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source)) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue;
		const sourcePath = join(source, entry);
		if (!statSync(sourcePath).isFile()) continue;
		cpSync(sourcePath, join(target, entry));
	}
}

if (!existsSync(sourceWorker)) {
	throw new Error(`Missing Python worker source at ${sourceWorker}`);
}

copyDirectory(sourceWorker, targetWorker);
rmSync(targetAssets, { recursive: true, force: true });
copyMarkdownFiles(resolve(repoRoot, ".pi/prompts"), resolve(targetAssets, "prompts"), "verigen-");
copyMarkdownFiles(resolve(repoRoot, ".pi/skills"), resolve(targetAssets, "skills"), "verigen-");

