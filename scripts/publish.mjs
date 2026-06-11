#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const packageToPublish = { directory: "packages/verigen", name: "verigen" };
const registry = "https://registry.npmjs.org/";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function removeGeneratedNativeTools(directory) {
	rmSync(join(directory, "dist", "native-tools"), { recursive: true, force: true });
	rmSync(join(directory, "dist", "native-tools-manifest.json"), { force: true });
}

function assertGeneratedNativeToolsExcluded(directory) {
	if (existsSync(join(directory, "dist", "native-tools"))) {
		throw new Error(`${directory}/dist/native-tools must not be present before npm publish.`);
	}
	if (existsSync(join(directory, "dist", "native-tools-manifest.json"))) {
		throw new Error(`${directory}/dist/native-tools-manifest.json must not be present before npm publish.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json", "--registry", registry], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

function isTransparencyLogConflict(error) {
	const text = errorText(error);
	return (
		text.includes("TLOG_CREATE_ENTRY_ERROR") ||
		text.includes("equivalent entry already exists in the transparency log")
	);
}

function publishPackage(directory, name, version) {
	const provenanceArgs = ["publish", "--access", "public", "--provenance", "--ignore-scripts", "--registry", registry];
	try {
		run("npm", provenanceArgs, { cwd: directory });
		return;
	} catch (error) {
		if (!isTransparencyLogConflict(error)) {
			throw error;
		}
		if (isPublished(name, version)) {
			console.log(`Skipping ${name}@${version}: already published after npm transparency log conflict\n`);
			return;
		}
		console.warn(
			"npm provenance transparency log entry already exists, but the package version is not published. Retrying once without --provenance.",
		);
		run("npm", ["publish", "--access", "public", "--ignore-scripts", "--registry", registry], { cwd: directory });
	}
}

const packageJson = readPackageJson(packageToPublish.directory);
if (packageJson.name !== packageToPublish.name) {
	throw new Error(`${packageToPublish.directory}/package.json has name ${packageJson.name}, expected ${packageToPublish.name}`);
}

const version = packageJson.version;
if (typeof version !== "string" || version.length === 0) {
	throw new Error(`${packageToPublish.directory}/package.json must declare a version`);
}

console.log(`Publishing VeriGen package ${packageToPublish.name}@${version}${dryRun ? " (dry run)" : ""}\n`);

assertBuildOutputExists(packageToPublish.directory);
removeGeneratedNativeTools(packageToPublish.directory);
assertGeneratedNativeToolsExcluded(packageToPublish.directory);
const published = isPublished(packageToPublish.name, version);

if (dryRun) {
	if (published) {
		console.log(`${packageToPublish.name}@${version} is already published; validating package contents only.`);
	} else {
		console.log(`${packageToPublish.name}@${version} is not published; validating package contents before publish.`);
	}
	validatePack(packageToPublish.directory);
	console.log();
	process.exit(0);
}

if (published) {
	console.log(`Skipping ${packageToPublish.name}@${version}: already published\n`);
	process.exit(0);
}

publishPackage(packageToPublish.directory, packageToPublish.name, version);
console.log();
