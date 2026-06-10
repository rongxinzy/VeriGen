import { existsSync } from "node:fs";
import { arch as currentArch, platform as currentPlatform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeToolLookupOptions {
	platform?: NodeJS.Platform;
	arch?: NodeJS.Architecture;
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

export function findBundledNativeToolDir(
	packageRoot = currentVerigenPackageRoot(),
	options: NativeToolLookupOptions = {},
): string | undefined {
	const candidate = join(packageRoot, "dist", "native-tools", nativeToolTargetId(options));
	return existsSync(candidate) ? candidate : undefined;
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
