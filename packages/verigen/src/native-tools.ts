import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { chmod, cp, mkdtemp } from "node:fs/promises";
import { arch as currentArch, platform as currentPlatform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export interface NativeToolLookupOptions {
	platform?: NodeJS.Platform;
	arch?: NodeJS.Architecture;
}

export interface NativeToolManifestTarget {
	archive: string;
	url: string;
	sha256: string;
	size: number;
	binaries: string[];
}

export interface NativeToolManifest {
	schemaVersion: 1;
	packageVersion: string;
	assetBaseUrl?: string;
	targets: Record<string, NativeToolManifestTarget>;
}

export interface NativeToolsStatusOptions {
	packageRoot?: string;
	target?: NativeToolLookupOptions;
}

export interface NativeToolsStatus {
	targetId: string;
	dir: string;
	manifestPath: string;
	manifestFound: boolean;
	targetFound: boolean;
	installed: boolean;
	missingBinaries: string[];
}

export interface InstallBundledNativeToolsOptions extends NativeToolsStatusOptions {
	force?: boolean;
	assetBaseUrl?: string;
}

export interface InstallBundledNativeToolsResult extends NativeToolsStatus {
	action: "already_installed" | "installed";
	url?: string;
	archiveSha256?: string;
}

interface OfficialUvTarget {
	targetId: string;
	archive: string;
	url: string;
	sha256: string;
	binaries: string[];
}

const officialUvVersion = "0.8.4";

const officialUvTargets: Record<string, OfficialUvTarget> = {
	"win32-x64": {
		targetId: "win32-x64",
		archive: "uv-x86_64-pc-windows-msvc.zip",
		url: `https://github.com/astral-sh/uv/releases/download/${officialUvVersion}/uv-x86_64-pc-windows-msvc.zip`,
		sha256: "817c50c80229f88de9699626ee3774c0cceed86099663e8fb00c5ffae7ea911c",
		binaries: ["uv.exe", "uvx.exe"],
	},
	"win32-arm64": {
		targetId: "win32-arm64",
		archive: "uv-aarch64-pc-windows-msvc.zip",
		url: `https://github.com/astral-sh/uv/releases/download/${officialUvVersion}/uv-aarch64-pc-windows-msvc.zip`,
		sha256: "34cdff9ed7e1ffece93a895e65377a0ea4f186eb6785ead045280be59edabf19",
		binaries: ["uv.exe", "uvx.exe"],
	},
	"darwin-arm64": {
		targetId: "darwin-arm64",
		archive: "uv-aarch64-apple-darwin.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${officialUvVersion}/uv-aarch64-apple-darwin.tar.gz`,
		sha256: "ef6785df8c23232ce6209c04acefd0c0d2ffb3a3ba0eef16422bdfe99a059105",
		binaries: ["uv", "uvx"],
	},
	"darwin-x64": {
		targetId: "darwin-x64",
		archive: "uv-x86_64-apple-darwin.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${officialUvVersion}/uv-x86_64-apple-darwin.tar.gz`,
		sha256: "14e5309f182d1a92cf6c82f5891a0a0dc1cd5d46627171eaa1e84fa2b7e0afc3",
		binaries: ["uv", "uvx"],
	},
	"linux-x64": {
		targetId: "linux-x64",
		archive: "uv-x86_64-unknown-linux-gnu.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${officialUvVersion}/uv-x86_64-unknown-linux-gnu.tar.gz`,
		sha256: "eb61d39fdc6ea21a6d00a24b50376102168240849c5022d3eba331f972ba3934",
		binaries: ["uv", "uvx"],
	},
	"linux-arm64": {
		targetId: "linux-arm64",
		archive: "uv-aarch64-unknown-linux-gnu.tar.gz",
		url: `https://github.com/astral-sh/uv/releases/download/${officialUvVersion}/uv-aarch64-unknown-linux-gnu.tar.gz`,
		sha256: "d42742a28ce161e72cce45c8c5621ee23317e30d461f595c382acf0f9b331f20",
		binaries: ["uv", "uvx"],
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return result.length === value.length ? result : undefined;
}

function parseManifestTarget(value: unknown): NativeToolManifestTarget | undefined {
	if (!isRecord(value)) return undefined;
	const archive = stringValue(value.archive);
	const url = stringValue(value.url);
	const sha256 = stringValue(value.sha256);
	const size = numberValue(value.size);
	const binaries = stringArray(value.binaries);
	if (!archive || !url || !sha256 || size === undefined || !binaries) return undefined;
	return { archive, url, sha256, size, binaries };
}

function parseNativeToolManifest(value: unknown): NativeToolManifest | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
	const packageVersion = stringValue(value.packageVersion);
	if (!packageVersion || !isRecord(value.targets)) return undefined;
	const targets: Record<string, NativeToolManifestTarget> = {};
	for (const [targetId, target] of Object.entries(value.targets)) {
		const parsed = parseManifestTarget(target);
		if (parsed) targets[targetId] = parsed;
	}
	return {
		schemaVersion: 1,
		packageVersion,
		...(stringValue(value.assetBaseUrl) ? { assetBaseUrl: stringValue(value.assetBaseUrl) } : {}),
		targets,
	};
}

export function executableName(name: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? `${name}.exe` : name;
}

export function nativeToolTargetId(options: NativeToolLookupOptions = {}): string {
	return `${options.platform ?? currentPlatform()}-${options.arch ?? currentArch()}`;
}

export function currentVerigenPackageRoot(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const dirName = basename(moduleDir);
	if (dirName === "src" || dirName === "dist") return dirname(moduleDir);
	return moduleDir;
}

export function nativeToolsManifestPath(packageRoot = currentVerigenPackageRoot()): string {
	return join(packageRoot, "dist", "native-tools-manifest.json");
}

export function readNativeToolsManifest(packageRoot = currentVerigenPackageRoot()): NativeToolManifest | undefined {
	const manifestPath = nativeToolsManifestPath(packageRoot);
	if (!existsSync(manifestPath)) return undefined;
	try {
		return parseNativeToolManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
	} catch {
		return undefined;
	}
}

export function findBundledNativeToolDir(
	packageRoot = currentVerigenPackageRoot(),
	options: NativeToolLookupOptions = {},
): string | undefined {
	const candidate = join(packageRoot, "dist", "native-tools", nativeToolTargetId(options));
	return existsSync(candidate) ? candidate : undefined;
}

export function nativeToolsInstallDir(
	packageRoot = currentVerigenPackageRoot(),
	options: NativeToolLookupOptions = {},
): string {
	return join(packageRoot, "dist", "native-tools", nativeToolTargetId(options));
}

export function findBundledNativeTool(
	packageRoot: string,
	name: string,
	options: NativeToolLookupOptions = {},
): string | undefined {
	const dir = findBundledNativeToolDir(packageRoot, options);
	if (!dir) return undefined;
	const candidate = join(dir, executableName(name, options.platform));
	return existsSync(candidate) ? candidate : undefined;
}

export function getNativeToolsStatus(options: NativeToolsStatusOptions = {}): NativeToolsStatus {
	const packageRoot = options.packageRoot ? resolve(options.packageRoot) : currentVerigenPackageRoot();
	const targetOptions = options.target ?? {};
	const targetId = nativeToolTargetId(targetOptions);
	const dir = nativeToolsInstallDir(packageRoot, targetOptions);
	const manifestPath = nativeToolsManifestPath(packageRoot);
	const manifest = readNativeToolsManifest(packageRoot);
	const target = manifest?.targets[targetId];
	const officialTarget = officialUvTargets[targetId];
	const requiredBinaries = target?.binaries ?? officialTarget?.binaries ?? [];
	const missingBinaries = requiredBinaries.filter((binary) => !existsSync(join(dir, binary)));
	return {
		targetId,
		dir,
		manifestPath,
		manifestFound: Boolean(manifest),
		targetFound: Boolean(target ?? officialTarget),
		installed: requiredBinaries.length > 0 && missingBinaries.length === 0,
		missingBinaries,
	};
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function targetUrl(target: NativeToolManifestTarget, options: InstallBundledNativeToolsOptions): string {
	const baseUrl = options.assetBaseUrl?.trim() || process.env.VERIGEN_NATIVE_TOOLS_BASE_URL?.trim();
	if (!baseUrl) return target.url;
	return `${trimTrailingSlash(baseUrl)}/${target.archive}`;
}

async function download(url: string, destination: string): Promise<void> {
	const response = await fetch(url, {
		headers: { "User-Agent": "verigen-native-tool-installer" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download native tools from ${url}: ${response.status}`);
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function runTarExtract(archive: string, destination: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("tar", ["-xzf", archive, "-C", destination], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			if (exitCode === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(stderr || `tar exited with ${exitCode}`));
		});
	});
}

function runZipExtract(archive: string, destination: string): Promise<void> {
	const command = process.platform === "win32" ? "powershell" : "unzip";
	const args =
		process.platform === "win32"
			? [
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-Command",
					`Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
				]
			: ["-q", "-o", archive, "-d", destination];
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			if (exitCode === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(stderr || `${command} exited with ${exitCode}`));
		});
	});
}

function findExtractedBinary(root: string, binary: string): string | undefined {
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isFile() && entry.name === binary) return fullPath;
			if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return undefined;
}

async function installOfficialUvTarget(
	target: OfficialUvTarget,
	packageRoot: string,
	status: NativeToolsStatus,
): Promise<InstallBundledNativeToolsResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "verigen-uv-"));
	const archivePath = join(tempDir, target.archive);
	const extractDir = join(tempDir, "extract");
	try {
		mkdirSync(extractDir, { recursive: true });
		await download(target.url, archivePath);
		const actualSha256 = hashFile(archivePath);
		if (actualSha256 !== target.sha256) {
			throw new Error(
				`VeriGen uv checksum mismatch for ${target.url}: expected ${target.sha256}, got ${actualSha256}`,
			);
		}
		if (target.archive.endsWith(".zip")) {
			await runZipExtract(archivePath, extractDir);
		} else {
			await runTarExtract(archivePath, extractDir);
		}
		rmSync(status.dir, { recursive: true, force: true });
		mkdirSync(status.dir, { recursive: true });
		for (const binary of target.binaries) {
			const extracted = findExtractedBinary(extractDir, binary);
			if (!extracted) throw new Error(`Could not find ${binary} in ${target.archive}`);
			await cp(extracted, join(status.dir, binary), { force: true });
			if (!binary.endsWith(".exe")) await chmod(join(status.dir, binary), 0o755);
		}
		const installedStatus = getNativeToolsStatus({ packageRoot });
		if (!installedStatus.installed) {
			throw new Error(`VeriGen uv install is incomplete: missing ${installedStatus.missingBinaries.join(", ")}`);
		}
		return { ...installedStatus, action: "installed", url: target.url, archiveSha256: target.sha256 };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function chmodInstalledBinaries(target: NativeToolManifestTarget, dir: string): Promise<void> {
	for (const binary of target.binaries) {
		if (binary.endsWith(".exe")) continue;
		const path = join(dir, binary);
		if (existsSync(path)) await chmod(path, 0o755);
	}
}

export async function installBundledNativeTools(
	options: InstallBundledNativeToolsOptions = {},
): Promise<InstallBundledNativeToolsResult> {
	const packageRoot = options.packageRoot ? resolve(options.packageRoot) : currentVerigenPackageRoot();
	const targetOptions = options.target ?? {};
	const status = getNativeToolsStatus({ packageRoot, target: targetOptions });
	if (status.installed && !options.force) {
		return { ...status, action: "already_installed" };
	}

	const manifest = readNativeToolsManifest(packageRoot);
	const target = manifest?.targets[status.targetId];
	if (!target) {
		const officialTarget = officialUvTargets[status.targetId];
		if (!officialTarget) {
			throw new Error(`VeriGen native tools do not provide target ${status.targetId}`);
		}
		return await installOfficialUvTarget(officialTarget, packageRoot, status);
	}

	const tempDir = await mkdtemp(join(tmpdir(), "verigen-native-tools-"));
	const archivePath = join(tempDir, target.archive);
	const extractDir = join(tempDir, "extract");
	const url = targetUrl(target, options);
	try {
		mkdirSync(extractDir, { recursive: true });
		await download(url, archivePath);
		const actualSha256 = hashFile(archivePath);
		if (actualSha256 !== target.sha256) {
			throw new Error(
				`VeriGen native tools checksum mismatch for ${url}: expected ${target.sha256}, got ${actualSha256}`,
			);
		}
		if (statSync(archivePath).size !== target.size) {
			throw new Error(`VeriGen native tools size mismatch for ${url}`);
		}
		await runTarExtract(archivePath, extractDir);
		rmSync(status.dir, { recursive: true, force: true });
		mkdirSync(dirname(status.dir), { recursive: true });
		await cp(extractDir, status.dir, { recursive: true, force: true });
		await chmodInstalledBinaries(target, status.dir);
		const installedStatus = getNativeToolsStatus({ packageRoot, target: targetOptions });
		if (!installedStatus.installed) {
			throw new Error(
				`VeriGen native tools install is incomplete: missing ${installedStatus.missingBinaries.join(", ")}`,
			);
		}
		return {
			...installedStatus,
			action: "installed",
			url,
			archiveSha256: target.sha256,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
