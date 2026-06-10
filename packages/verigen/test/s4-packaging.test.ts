import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { executableName, findBundledNativeTool } from "../src/native-tools.ts";
import {
	bootstrapPythonWorker,
	findBundledPythonWorkerRoot,
	findBundledUv,
	pythonWorkerRootLooksValid,
} from "../src/python-worker-bootstrap.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createWorkerRoot(root: string): string {
	const workerRoot = join(root, "verilog-analysis");
	mkdirSync(join(workerRoot, "src", "verilog_analysis"), { recursive: true });
	mkdirSync(join(workerRoot, "vendor", "pyverilog", "pyverilog"), { recursive: true });
	writeFileSync(join(workerRoot, "pyproject.toml"), '[project]\nname = "verigen-verilog-analysis"\n');
	writeFileSync(join(workerRoot, "uv.lock"), "version = 1\n");
	writeFileSync(join(workerRoot, "src", "verilog_analysis", "__main__.py"), "def main(): pass\n");
	writeFileSync(join(workerRoot, "vendor", "pyverilog", "pyverilog", "__init__.py"), "\n");
	return workerRoot;
}

function createFakeUv(root: string): string {
	const uvPath = join(root, "uv-fake.mjs");
	writeFileSync(
		uvPath,
		`#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("uv 0.0.0-test");
  process.exit(0);
}
if (args[0] === "venv") {
  const venv = args[args.length - 1];
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(join(venv, "bin", "python"), "#!/usr/bin/env node\\n");
  process.exit(0);
}
if (args[0] === "pip" && args[1] === "install") {
  const pythonIndex = args.indexOf("--python");
  const pythonPath = args[pythonIndex + 1];
  const binDir = dirname(pythonPath);
  writeFileSync(join(binDir, "verigen-verilog-analysis"), "#!/usr/bin/env node\\n");
  process.exit(0);
}
process.exit(1);
`,
	);
	chmodSync(uvPath, 0o755);
	return uvPath;
}

describe("S4 npm packaging surface", () => {
	test("declares a verigen bin and copies npm-vendored worker assets during build", () => {
		const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		assert.ok(isRecord(parsed));
		assert.ok(isRecord(parsed.bin));
		assert.equal(parsed.bin.verigen, "./dist/cli.js");
		assert.ok(isRecord(parsed.exports));
		const codingAgentExtensionExport = parsed.exports["./coding-agent-extension"];
		assert.ok(isRecord(codingAgentExtensionExport));
		assert.equal(codingAgentExtensionExport.import, "./dist/verigen-coding-agent-extension.js");
		assert.equal(codingAgentExtensionExport.types, "./dist/verigen-coding-agent-extension.d.ts");
		assert.ok(Array.isArray(parsed.files));
		assert.ok(parsed.files.includes("dist"));
		assert.ok(parsed.files.includes("install.ps1"));
		assert.ok(parsed.files.includes("install.sh"));
		assert.ok(parsed.files.includes("README.md"));
		assert.ok(parsed.files.includes("CHANGELOG.md"));
		assert.ok(isRecord(parsed.scripts));
		const buildScript = parsed.scripts.build;
		if (typeof buildScript !== "string") {
			throw new Error("expected package build script to be a string");
		}
		assert.match(buildScript, /copy-python-worker/);
		assert.equal(parsed.scripts.prepack, "npm run build");
		assert.ok(isRecord(parsed.dependencies));
		assert.equal(parsed.dependencies["@earendil-works/pi-coding-agent"], "0.79.0");
		assert.equal(parsed.dependencies["@earendil-works/pi-tui"], "0.79.0");
		assert.equal(parsed.dependencies.typebox, "1.1.38");

		const copyScript = readFileSync(join(packageRoot, "scripts", "copy-python-worker.mjs"), "utf8");
		assert.match(copyScript, /dist\/pi-assets/);
		assert.match(copyScript, /\.pi\/prompts/);
		assert.match(copyScript, /\.pi\/skills/);
		assert.match(copyScript, /verigen-/);

		const nativeToolsScript = readFileSync(join(packageRoot, "scripts", "install-native-tools.mjs"), "utf8");
		assert.match(nativeToolsScript, /uvx/);

		const installScript = readFileSync(join(packageRoot, "install.sh"), "utf8");
		assert.match(installScript, /--ignore-scripts/);
		assert.match(installScript, /--registry/);
		assert.match(installScript, /registry\.npmmirror\.com/);
		assert.match(installScript, /python-bootstrap --json/);
		assert.match(installScript, /Python worker cache and dependencies/);
		assert.match(installScript, /VERIGEN_SKIP_PYTHON_BOOTSTRAP/);

		const installPowerShell = readFileSync(join(packageRoot, "install.ps1"), "utf8");
		assert.match(installPowerShell, /--ignore-scripts/);
		assert.match(installPowerShell, /--registry/);
		assert.match(installPowerShell, /registry\.npmmirror\.com/);
		assert.match(installPowerShell, /python-bootstrap --json/);
		assert.match(installPowerShell, /Python worker cache and dependencies/);
		assert.match(installPowerShell, /VERIGEN_SKIP_PYTHON_BOOTSTRAP/);
		assert.match(installPowerShell, /choco install nodejs --version=/);
		assert.match(installPowerShell, /24\.16\.0/);
		assert.match(installPowerShell, /11\.13\.0/);
		assert.match(installPowerShell, /Git Bash/);
		assert.match(installPowerShell, /ExecutionPolicy Bypass/);
	});
});

describe("S4 Python worker bootstrap", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("finds npm-bundled worker root and creates a uv cache venv from local paths", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-s4-"));
		tempDirs.push(tempDir);
		const fakePackageRoot = join(tempDir, "package");
		const bundledWorker = createWorkerRoot(join(fakePackageRoot, "dist", "python"));
		writeFileSync(join(fakePackageRoot, "package.json"), JSON.stringify({ version: "9.8.7" }));
		const fakeUv = createFakeUv(tempDir);
		const cacheRoot = join(tempDir, "cache");

		assert.equal(findBundledPythonWorkerRoot(fakePackageRoot), bundledWorker);
		assert.equal(pythonWorkerRootLooksValid(bundledWorker), true);

		const firstLaunch = await bootstrapPythonWorker({
			packageRoot: fakePackageRoot,
			cacheRoot,
			uvCommand: fakeUv,
		});
		assert.equal(firstLaunch.workerRoot, bundledWorker);
		assert.equal(firstLaunch.wasBootstrapped, true);
		assert.equal(firstLaunch.commands.length, 2);
		assert.deepEqual(firstLaunch.commands[0]?.args, ["venv", "--python", "3.11", firstLaunch.venvDir]);
		assert.deepEqual(firstLaunch.commands[1]?.args, [
			"pip",
			"install",
			"--python",
			firstLaunch.pythonPath,
			bundledWorker,
		]);
		assert.match(firstLaunch.command, /python$/);
		assert.deepEqual(firstLaunch.args, ["-m", "verilog_analysis"]);

		const secondLaunch = await bootstrapPythonWorker({
			packageRoot: fakePackageRoot,
			cacheRoot,
			uvCommand: fakeUv,
		});
		assert.equal(secondLaunch.wasBootstrapped, false);
		assert.equal(secondLaunch.command, firstLaunch.command);
	});

	test("resolves bundled uv and uvx with platform executable suffixes", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-native-tools-"));
		tempDirs.push(tempDir);
		const packageDir = join(tempDir, "package");
		const windowsToolDir = join(packageDir, "dist", "native-tools", "win32-x64");
		mkdirSync(windowsToolDir, { recursive: true });
		writeFileSync(join(windowsToolDir, "uv.exe"), "");
		writeFileSync(join(windowsToolDir, "uvx.exe"), "");

		assert.equal(executableName("uv", "win32"), "uv.exe");
		assert.equal(
			findBundledNativeTool(packageDir, "uv", { platform: "win32", arch: "x64" }),
			join(windowsToolDir, "uv.exe"),
		);
		assert.equal(
			findBundledNativeTool(packageDir, "uvx", { platform: "win32", arch: "x64" }),
			join(windowsToolDir, "uvx.exe"),
		);
	});

	test("prefers the bundled uv command for Python worker bootstrap", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "verigen-bundled-uv-"));
		tempDirs.push(tempDir);
		const packageDir = join(tempDir, "package");
		const nativeToolDir = join(packageDir, "dist", "native-tools", `${process.platform}-${process.arch}`);
		mkdirSync(nativeToolDir, { recursive: true });
		const bundledUv = join(nativeToolDir, executableName("uv"));
		writeFileSync(bundledUv, "");

		assert.equal(findBundledUv(packageDir), bundledUv);
	});
});
