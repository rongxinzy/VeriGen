import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	bootstrapPythonWorker,
	findBundledPythonWorkerRoot,
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
  const venv = args[1];
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
		assert.ok(Array.isArray(parsed.files));
		assert.ok(parsed.files.includes("dist"));
		assert.ok(isRecord(parsed.scripts));
		const buildScript = parsed.scripts.build;
		if (typeof buildScript !== "string") {
			throw new Error("expected package build script to be a string");
		}
		assert.match(buildScript, /copy-python-worker/);
		assert.equal(parsed.scripts.prepack, "npm run build");
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
});
