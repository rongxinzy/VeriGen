import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const cacheRoot = resolve(packageRoot, ".cache/native-tools");
const distRoot = resolve(packageRoot, "dist/native-tools");
const uvVersion = "0.8.4";

const targets = {
	"win32-x64": {
		archive: "uv-x86_64-pc-windows-msvc.zip",
		url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-x86_64-pc-windows-msvc.zip`,
		sha256: "817c50c80229f88de9699626ee3774c0cceed86099663e8fb00c5ffae7ea911c",
		binaries: ["uv.exe", "uvx.exe"],
	},
	"win32-arm64": {
		archive: "uv-aarch64-pc-windows-msvc.zip",
		url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-aarch64-pc-windows-msvc.zip`,
		sha256: "34cdff9ed7e1ffece93a895e65377a0ea4f186eb6785ead045280be59edabf19",
		binaries: ["uv.exe", "uvx.exe"],
	},
	"darwin-arm64": {
		archive: "uv-aarch64-apple-darwin.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-aarch64-apple-darwin.tar.gz`,
		sha256: "ef6785df8c23232ce6209c04acefd0c0d2ffb3a3ba0eef16422bdfe99a059105",
		binaries: ["uv", "uvx"],
	},
	"darwin-x64": {
		archive: "uv-x86_64-apple-darwin.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-x86_64-apple-darwin.tar.gz`,
		sha256: "14e5309f182d1a92cf6c82f5891a0a0dc1cd5d46627171eaa1e84fa2b7e0afc3",
		binaries: ["uv", "uvx"],
	},
	"linux-x64": {
		archive: "uv-x86_64-unknown-linux-gnu.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-x86_64-unknown-linux-gnu.tar.gz`,
		sha256: "eb61d39fdc6ea21a6d00a24b50376102168240849c5022d3eba331f972ba3934",
		binaries: ["uv", "uvx"],
	},
	"linux-arm64": {
		archive: "uv-aarch64-unknown-linux-gnu.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-aarch64-unknown-linux-gnu.tar.gz`,
		sha256: "d42742a28ce161e72cce45c8c5621ee23317e30d461f595c382acf0f9b331f20",
		binaries: ["uv", "uvx"],
	},
};

function usage() {
	console.error("Usage: node scripts/install-native-tools.mjs --install-current");
}

async function download(url, destination) {
	const response = await fetch(url, {
		headers: { "User-Agent": "verigen-native-tool-installer" },
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

function extract(archive, destination) {
	mkdirSync(destination, { recursive: true });
	if (archive.endsWith(".zip")) {
		run("unzip", ["-q", "-o", archive, "-d", destination]);
		return;
	}
	run("tar", ["xzf", archive, "-C", destination]);
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

function currentTargetId() {
	return `${platform()}-${arch()}`;
}

async function installCurrent() {
	const targetId = currentTargetId();
	const target = targets[targetId];
	if (!target) {
		throw new Error(`No bundled uv target for ${targetId}`);
	}
	mkdirSync(cacheRoot, { recursive: true });
	const archive = join(cacheRoot, target.archive);
	if (!existsSync(archive) || hashFile(archive) !== target.sha256) {
		await download(target.url, archive);
	}
	const actualSha256 = hashFile(archive);
	if (actualSha256 !== target.sha256) {
		throw new Error(`uv checksum mismatch: expected ${target.sha256}, got ${actualSha256}`);
	}
	const extractDir = join(cacheRoot, `${targetId}-extract`);
	rmSync(extractDir, { recursive: true, force: true });
	extract(archive, extractDir);

	const targetDir = join(distRoot, targetId);
	rmSync(targetDir, { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });
	for (const binaryName of target.binaries) {
		const binary = findBinary(extractDir, binaryName);
		if (!binary) {
			throw new Error(`Could not find ${binaryName} in ${target.archive}`);
		}
		const output = join(targetDir, binaryName);
		await copyFile(binary, output);
		if (!binaryName.endsWith(".exe")) {
			await chmod(output, 0o755);
		}
	}
	writeFileSync(
		join(targetDir, "THIRD_PARTY_NOTICES.txt"),
		`uv ${uvVersion} (astral-sh/uv) asset=${target.url} sha256=${target.sha256} license=MIT OR Apache-2.0\n`,
		"utf8",
	);
	rmSync(extractDir, { recursive: true, force: true });
	console.log(`Installed uv/uvx for ${targetId} into ${targetDir}`);
}

if (process.argv.includes("--install-current")) {
	await installCurrent();
} else {
	usage();
	process.exitCode = 1;
}
