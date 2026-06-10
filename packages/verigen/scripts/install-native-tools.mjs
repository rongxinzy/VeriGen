import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const cacheRoot = resolve(packageRoot, ".cache/native-tools");
const distRoot = resolve(packageRoot, "dist/native-tools");

const targets = [
	{
		id: "win32-x64",
		tools: [
			{
				name: "fd",
				version: "10.4.2",
				repo: "sharkdp/fd",
				asset: "fd-v10.4.2-x86_64-pc-windows-msvc.zip",
				binary: "fd.exe",
				license: "MIT OR Apache-2.0",
			},
			{
				name: "rg",
				version: "15.1.0",
				repo: "BurntSushi/ripgrep",
				asset: "ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
				binary: "rg.exe",
				license: "MIT OR Unlicense",
			},
			{
				name: "uv",
				version: "0.8.4",
				repo: "astral-sh/uv",
				asset: "uv-x86_64-pc-windows-msvc.zip",
				binaries: ["uv.exe", "uvx.exe"],
				license: "MIT OR Apache-2.0",
			},
		],
	},
	{
		id: "win32-arm64",
		tools: [
			{
				name: "fd",
				version: "10.4.2",
				repo: "sharkdp/fd",
				asset: "fd-v10.4.2-aarch64-pc-windows-msvc.zip",
				binary: "fd.exe",
				license: "MIT OR Apache-2.0",
			},
			{
				name: "rg",
				version: "15.1.0",
				repo: "BurntSushi/ripgrep",
				asset: "ripgrep-15.1.0-aarch64-pc-windows-msvc.zip",
				binary: "rg.exe",
				license: "MIT OR Unlicense",
			},
			{
				name: "uv",
				version: "0.8.4",
				repo: "astral-sh/uv",
				asset: "uv-aarch64-pc-windows-msvc.zip",
				binaries: ["uv.exe", "uvx.exe"],
				license: "MIT OR Apache-2.0",
			},
		],
	},
	{
		id: "darwin-arm64",
		tools: [
			{
				name: "fd",
				version: "10.4.2",
				repo: "sharkdp/fd",
				asset: "fd-v10.4.2-aarch64-apple-darwin.tar.gz",
				binary: "fd",
				license: "MIT OR Apache-2.0",
			},
			{
				name: "rg",
				version: "15.1.0",
				repo: "BurntSushi/ripgrep",
				asset: "ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
				binary: "rg",
				license: "MIT OR Unlicense",
			},
			{
				name: "uv",
				version: "0.8.4",
				repo: "astral-sh/uv",
				asset: "uv-aarch64-apple-darwin.tar.gz",
				binaries: ["uv", "uvx"],
				license: "MIT OR Apache-2.0",
			},
		],
	},
	{
		id: "darwin-x64",
		tools: [
			{
				name: "fd",
				version: "10.3.0",
				repo: "sharkdp/fd",
				asset: "fd-v10.3.0-x86_64-apple-darwin.tar.gz",
				binary: "fd",
				license: "MIT OR Apache-2.0",
			},
			{
				name: "rg",
				version: "15.1.0",
				repo: "BurntSushi/ripgrep",
				asset: "ripgrep-15.1.0-x86_64-apple-darwin.tar.gz",
				binary: "rg",
				license: "MIT OR Unlicense",
			},
			{
				name: "uv",
				version: "0.8.4",
				repo: "astral-sh/uv",
				asset: "uv-x86_64-apple-darwin.tar.gz",
				binaries: ["uv", "uvx"],
				license: "MIT OR Apache-2.0",
			},
		],
	},
	{
		id: "linux-x64",
		tools: [
			{
				name: "fd",
				version: "10.4.2",
				repo: "sharkdp/fd",
				asset: "fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz",
				binary: "fd",
				license: "MIT OR Apache-2.0",
			},
			{
				name: "rg",
				version: "15.1.0",
				repo: "BurntSushi/ripgrep",
				asset: "ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
				binary: "rg",
				license: "MIT OR Unlicense",
			},
			{
				name: "uv",
				version: "0.8.4",
				repo: "astral-sh/uv",
				asset: "uv-x86_64-unknown-linux-gnu.tar.gz",
				binaries: ["uv", "uvx"],
				license: "MIT OR Apache-2.0",
			},
		],
	},
	{
		id: "linux-arm64",
		tools: [
			{
				name: "fd",
				version: "10.4.2",
				repo: "sharkdp/fd",
				asset: "fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz",
				binary: "fd",
				license: "MIT OR Apache-2.0",
			},
			{
				name: "rg",
				version: "15.1.0",
				repo: "BurntSushi/ripgrep",
				asset: "ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz",
				binary: "rg",
				license: "MIT OR Unlicense",
			},
			{
				name: "uv",
				version: "0.8.4",
				repo: "astral-sh/uv",
				asset: "uv-aarch64-unknown-linux-gnu.tar.gz",
				binaries: ["uv", "uvx"],
				license: "MIT OR Apache-2.0",
			},
		],
	},
];

function releaseUrl(tool) {
	if (tool.name === "rg" || tool.name === "uv") {
		return `https://github.com/${tool.repo}/releases/download/${tool.version}/${tool.asset}`;
	}
	return `https://github.com/${tool.repo}/releases/download/v${tool.version}/${tool.asset}`;
}

async function download(url, destination) {
	const response = await fetch(url, {
		headers: { "User-Agent": "verigen-native-tool-packager" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${url}: ${response.status}`);
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `${command} failed:\n${output}` : `${command} failed`);
	}
}

function findBinary(root, binary) {
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isFile() && entry.name === binary) return fullPath;
			if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return undefined;
}

function toolBinaries(tool) {
	return tool.binaries ?? [tool.binary];
}

function extract(archive, destination) {
	mkdirSync(destination, { recursive: true });
	if (archive.endsWith(".zip")) {
		run("unzip", ["-q", "-o", archive, "-d", destination]);
		return;
	}
	run("tar", ["xzf", archive, "-C", destination]);
}

function currentTargetId() {
	return `${platform()}-${arch()}`;
}

mkdirSync(cacheRoot, { recursive: true });
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

for (const target of targets) {
	const targetDir = join(distRoot, target.id);
	mkdirSync(targetDir, { recursive: true });
	const notices = [];
	for (const tool of target.tools) {
		const archive = join(cacheRoot, `${tool.version}-${tool.asset}`);
		if (!existsSync(archive) || statSync(archive).size === 0) {
			await download(releaseUrl(tool), archive);
		}
		const extractDir = join(cacheRoot, `${target.id}-${tool.name}-extract`);
		rmSync(extractDir, { recursive: true, force: true });
		extract(archive, extractDir);
		for (const binaryName of toolBinaries(tool)) {
			const binary = findBinary(extractDir, binaryName);
			if (!binary) {
				throw new Error(`Could not find ${binaryName} in ${basename(archive)}`);
			}
			const output = join(targetDir, binaryName);
			await copyFile(binary, output);
			if (!binaryName.endsWith(".exe")) {
				await chmod(output, 0o755);
			}
		}
		const archiveSha256 = hashFile(archive);
		notices.push(`${tool.name} ${tool.version} (${tool.repo}) asset=${tool.asset} sha256=${archiveSha256} license=${tool.license}`);
		rmSync(extractDir, { recursive: true, force: true });
	}
	const noticePath = join(targetDir, "THIRD_PARTY_NOTICES.txt");
	writeFileSync(noticePath, `${notices.join("\n")}\n`, "utf8");
}

if (!targets.some((target) => target.id === currentTargetId())) {
	console.warn(`No bundled native tools target for ${currentTargetId()}`);
}
