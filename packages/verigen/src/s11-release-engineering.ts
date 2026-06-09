import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseSmokeStepStatus = "pending" | "pass" | "blocked";
export type ReleaseSmokeVerificationStatus = "pass" | "warn" | "blocked";

export type ReleaseExampleKind = "counter" | "fsm" | "uart_loopback" | "i2c_skeleton";

export interface ReleaseSmokeStep {
	id: string;
	title: string;
	command: string;
	required: boolean;
	status: ReleaseSmokeStepStatus;
	notes: string;
}

export interface ReleaseExampleProject {
	id: ReleaseExampleKind;
	title: string;
	description: string;
	topModule: string;
	entryCommand: string;
}

export interface ReleaseEngineeringReport {
	packageName: string;
	versionStrategy: string;
	publishTarget: string;
	quickstart: string[];
	smokeSteps: ReleaseSmokeStep[];
	examples: ReleaseExampleProject[];
	ciChecklist: string[];
	blockers: string[];
}

export interface ReleasePackInstallSmokeStep {
	id: string;
	title: string;
	command: string;
	required: boolean;
	notes: string;
}

export interface ReleasePackInstallSmokePlan {
	packageName: string;
	version: string;
	repoRoot: string;
	packageRoot: string;
	packDestination: string;
	installPrefix: string;
	cacheDir: string;
	tarballPath: string;
	steps: ReleasePackInstallSmokeStep[];
	notes: string[];
}

export interface ReleaseSmokeVerificationCheck {
	id: string;
	title: string;
	status: ReleaseSmokeVerificationStatus;
	evidence: string;
	remediation: string;
}

export interface ReleaseSmokeVerificationReport {
	title: string;
	status: ReleaseSmokeVerificationStatus;
	repoRoot: string;
	packageRoot: string;
	checks: ReleaseSmokeVerificationCheck[];
	blockers: string[];
	warnings: string[];
}

export interface VerifyLocalReleaseSmokeOptions {
	repoRoot?: string;
}

export interface VerifyDistReleaseSmokeOptions {
	repoRoot?: string;
}

export interface CreateReleasePackInstallSmokePlanOptions {
	repoRoot?: string;
	packDestination?: string;
	installPrefix?: string;
	cacheDir?: string;
}

interface ReleaseWorkspace {
	repoRoot: string;
	packageRoot: string;
}

interface PackageJsonShape {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
	main?: unknown;
	types?: unknown;
	exports?: unknown;
	files?: unknown;
	scripts?: unknown;
	dependencies?: unknown;
}

const VERIGEN_PACKAGE_NAME = "verigen";

function readPackageJson(path: string): PackageJsonShape | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJsonShape;
	} catch {
		return undefined;
	}
}

function resolveReleaseWorkspace(inputRoot: string | undefined): ReleaseWorkspace {
	const root = inputRoot ? resolve(inputRoot) : currentReleasePackageRoot();
	const rootPackage = readPackageJson(join(root, "package.json"));
	if (rootPackage?.name === VERIGEN_PACKAGE_NAME) {
		return { packageRoot: root, repoRoot: resolve(root, "../..") };
	}
	const nestedPackageRoot = join(root, "packages", "verigen");
	if (readPackageJson(join(nestedPackageRoot, "package.json"))?.name === VERIGEN_PACKAGE_NAME) {
		return { repoRoot: root, packageRoot: nestedPackageRoot };
	}
	const parentPackageRoot = resolve(root, "packages", "verigen");
	if (readPackageJson(join(parentPackageRoot, "package.json"))?.name === VERIGEN_PACKAGE_NAME) {
		return { repoRoot: root, packageRoot: parentPackageRoot };
	}
	return { repoRoot: root, packageRoot: root };
}

function currentReleasePackageRoot(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const dirName = basename(moduleDir);
	if (dirName === "src" || dirName === "dist") return dirname(moduleDir);
	return moduleDir;
}

function checkStatus(ok: boolean, warn = false): ReleaseSmokeVerificationStatus {
	if (ok) return warn ? "warn" : "pass";
	return "blocked";
}

function hasStringEntry(values: unknown, expected: string): boolean {
	return Array.isArray(values) && values.some((entry) => entry === expected);
}

function hasDependency(packageJson: PackageJsonShape, dependency: string): boolean {
	const dependencies = packageJson.dependencies;
	return typeof dependencies === "object" && dependencies !== null && dependency in dependencies;
}

function hasExportEntry(
	packageJson: PackageJsonShape,
	key: string,
	expectedImport: string,
	expectedTypes: string,
): boolean {
	const exports = packageJson.exports;
	if (typeof exports !== "object" || exports === null) return false;
	const entry = (exports as Record<string, unknown>)[key];
	if (typeof entry !== "object" || entry === null) return false;
	const values = entry as Record<string, unknown>;
	return values.import === expectedImport && values.types === expectedTypes;
}

function hasScript(packageJson: PackageJsonShape, script: string): boolean {
	const scripts = packageJson.scripts;
	return typeof scripts === "object" && scripts !== null && script in scripts;
}

function binEntry(packageJson: PackageJsonShape, name: string): unknown {
	const bin = packageJson.bin;
	if (typeof bin !== "object" || bin === null) return undefined;
	return (bin as Record<string, unknown>)[name];
}

function check(
	id: string,
	title: string,
	status: ReleaseSmokeVerificationStatus,
	evidence: string,
	remediation: string,
): ReleaseSmokeVerificationCheck {
	return { id, title, status, evidence, remediation };
}

function fileContains(path: string, expected: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return readFileSync(path, "utf8").includes(expected);
	} catch {
		return false;
	}
}

function stringField(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function command(parts: string[]): string {
	return parts.map(shellQuote).join(" ");
}

function npmTarballName(packageName: string, version: string): string {
	const withoutScopePrefix = packageName.startsWith("@") ? packageName.slice(1) : packageName;
	return `${withoutScopePrefix.replaceAll("/", "-")}-${version}.tgz`;
}

export function verifyLocalReleaseSmoke(options: VerifyLocalReleaseSmokeOptions = {}): ReleaseSmokeVerificationReport {
	const workspace = resolveReleaseWorkspace(options.repoRoot);
	const packageJsonPath = join(workspace.packageRoot, "package.json");
	const packageJson = readPackageJson(packageJsonPath);
	const pythonRoot = join(workspace.repoRoot, "packages", "verilog-analysis");
	const pyverilogRoot = join(pythonRoot, "vendor", "pyverilog");
	const extensionSource = join(workspace.packageRoot, "src", "verigen-coding-agent-extension.ts");
	const extensionDist = join(workspace.packageRoot, "dist", "verigen-coding-agent-extension.js");
	const agentLauncherSource = join(workspace.packageRoot, "src", "verigen-agent-launcher.ts");
	const agentLauncherDist = join(workspace.packageRoot, "dist", "verigen-agent-launcher.js");
	const changelogPath = join(workspace.packageRoot, "CHANGELOG.md");
	const packageVersion = typeof packageJson?.version === "string" ? packageJson.version : undefined;
	const changelogHasCurrentRelease =
		fileContains(changelogPath, "## [Unreleased]") ||
		(packageVersion !== undefined && fileContains(changelogPath, `## [${packageVersion}]`));
	const checks: ReleaseSmokeVerificationCheck[] = [];

	checks.push(
		check(
			"package-json",
			"npm package manifest",
			checkStatus(Boolean(packageJson)),
			packageJson ? packageJsonPath : "package.json not readable",
			"Ensure packages/verigen/package.json exists and is valid JSON.",
		),
	);

	if (packageJson) {
		checks.push(
			check(
				"package-name",
				"npm package name",
				checkStatus(packageJson.name === VERIGEN_PACKAGE_NAME),
				String(packageJson.name ?? ""),
				"Keep the VeriGen package name as the standalone npm package before publish.",
			),
			check(
				"bin-entry",
				"verigen bin entry",
				checkStatus(binEntry(packageJson, "verigen") === "./dist/cli.js"),
				JSON.stringify(packageJson.bin ?? {}),
				"Expose verigen as ./dist/cli.js in package.json bin.",
			),
			check(
				"files-entry",
				"npm files whitelist",
				checkStatus(
					hasStringEntry(packageJson.files, "dist") &&
						hasStringEntry(packageJson.files, "README.md") &&
						hasStringEntry(packageJson.files, "CHANGELOG.md"),
				),
				JSON.stringify(packageJson.files ?? []),
				"Keep dist, README.md, and CHANGELOG.md in the package files whitelist.",
			),
			check(
				"prepack",
				"prepack build hook",
				checkStatus(hasScript(packageJson, "prepack")),
				JSON.stringify(packageJson.scripts ?? {}),
				"Keep prepack so npm pack creates dist and copies worker assets.",
			),
			check(
				"coding-agent-dependency",
				"pi coding-agent dependency",
				checkStatus(hasDependency(packageJson, "@earendil-works/pi-coding-agent")),
				JSON.stringify(packageJson.dependencies ?? {}),
				"Keep @earendil-works/pi-coding-agent as the base runtime dependency.",
			),
			check(
				"pi-tui-dependency",
				"pi-tui direct dependency for exported Component types",
				checkStatus(hasDependency(packageJson, "@earendil-works/pi-tui")),
				JSON.stringify(packageJson.dependencies ?? {}),
				"Keep @earendil-works/pi-tui as a direct dependency for workbench Component exports.",
			),
			check(
				"extension-export",
				"coding-agent extension subpath export",
				checkStatus(
					hasExportEntry(
						packageJson,
						"./coding-agent-extension",
						"./dist/verigen-coding-agent-extension.js",
						"./dist/verigen-coding-agent-extension.d.ts",
					),
				),
				JSON.stringify(packageJson.exports ?? {}),
				"Export ./coding-agent-extension so external pi extensions can load the S15 workbench.",
			),
		);
	}

	checks.push(
		check(
			"workbench-extension-entry",
			"S15 workbench extension entry exists",
			checkStatus(existsSync(extensionSource) || existsSync(extensionDist)),
			existsSync(extensionSource) ? extensionSource : extensionDist,
			"Keep verigen-coding-agent-extension in src and ensure prepack emits dist/verigen-coding-agent-extension.js.",
		),
		check(
			"agent-default-extension",
			"verigen agent defaults to loading the workbench extension",
			checkStatus(
				(fileContains(agentLauncherSource, "verigen-coding-agent-extension") &&
					fileContains(agentLauncherSource, "--extension")) ||
					(fileContains(agentLauncherDist, "verigen-coding-agent-extension") &&
						fileContains(agentLauncherDist, "--extension")),
			),
			existsSync(agentLauncherSource) ? agentLauncherSource : agentLauncherDist,
			"Keep verigen agent launch args wired to --extension verigen-coding-agent-extension.",
		),
		check(
			"python-worker-source",
			"Python worker source is vendored in repo",
			checkStatus(existsSync(join(pythonRoot, "pyproject.toml")) && existsSync(join(pythonRoot, "src"))),
			pythonRoot,
			"Keep packages/verilog-analysis source available for npm prepack copy.",
		),
		check(
			"pyverilog-vendor",
			"modified pyverilog fork is vendored internally",
			checkStatus(existsSync(join(pyverilogRoot, "pyproject.toml")) || existsSync(join(pyverilogRoot, "setup.py"))),
			pyverilogRoot,
			"Keep the modified pyverilog fork under packages/verilog-analysis/vendor/pyverilog.",
		),
		check(
			"no-docker-path",
			"Docker is not required for S15 install",
			checkStatus(!existsSync(join(workspace.packageRoot, "Dockerfile"))),
			join(workspace.packageRoot, "Dockerfile"),
			"Do not add Docker as a required install path for VeriGen S15.",
		),
		check(
			"changelog",
			"package changelog exists",
			checkStatus(changelogHasCurrentRelease),
			changelogPath,
			"Keep a package changelog with an [Unreleased] section or the current release section.",
		),
	);

	const blockers = checks.filter((item) => item.status === "blocked").map((item) => `${item.id}: ${item.remediation}`);
	const warnings = checks.filter((item) => item.status === "warn").map((item) => `${item.id}: ${item.remediation}`);
	return {
		title: "VeriGen local release smoke verification",
		status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warn" : "pass",
		repoRoot: workspace.repoRoot,
		packageRoot: workspace.packageRoot,
		checks,
		blockers,
		warnings,
	};
}

export function verifyDistReleaseSmoke(options: VerifyDistReleaseSmokeOptions = {}): ReleaseSmokeVerificationReport {
	const workspace = resolveReleaseWorkspace(options.repoRoot);
	const distRoot = join(workspace.packageRoot, "dist");
	const cli = join(distRoot, "cli.js");
	const indexJs = join(distRoot, "index.js");
	const indexDts = join(distRoot, "index.d.ts");
	const extensionJs = join(distRoot, "verigen-coding-agent-extension.js");
	const extensionDts = join(distRoot, "verigen-coding-agent-extension.d.ts");
	const launcherJs = join(distRoot, "verigen-agent-launcher.js");
	const workerRoot = join(distRoot, "python", "verilog-analysis");
	const assetsRoot = join(distRoot, "pi-assets");
	const checks: ReleaseSmokeVerificationCheck[] = [
		check(
			"dist-root",
			"built dist directory",
			checkStatus(existsSync(distRoot)),
			distRoot,
			"Run the package build/prepack before npm pack so dist exists.",
		),
		check(
			"dist-cli",
			"built verigen CLI entry",
			checkStatus(existsSync(cli) && fileContains(cli, "#!/usr/bin/env node")),
			cli,
			"Ensure dist/cli.js is emitted with the Node shebang.",
		),
		check(
			"dist-index",
			"built public API entry and types",
			checkStatus(existsSync(indexJs) && existsSync(indexDts)),
			`${indexJs} / ${indexDts}`,
			"Ensure dist/index.js and dist/index.d.ts are emitted.",
		),
		check(
			"dist-extension",
			"built coding-agent extension entry and types",
			checkStatus(existsSync(extensionJs) && existsSync(extensionDts)),
			`${extensionJs} / ${extensionDts}`,
			"Ensure dist/verigen-coding-agent-extension.js and .d.ts are emitted.",
		),
		check(
			"dist-agent-extension-wiring",
			"built agent launcher loads the workbench extension",
			checkStatus(
				fileContains(launcherJs, "verigen-coding-agent-extension") && fileContains(launcherJs, "--extension"),
			),
			launcherJs,
			"Ensure built verigen-agent-launcher.js still passes --extension for the workbench.",
		),
		check(
			"dist-python-worker",
			"built npm-vendored Python worker",
			checkStatus(
				existsSync(join(workerRoot, "pyproject.toml")) &&
					existsSync(join(workerRoot, "uv.lock")) &&
					existsSync(join(workerRoot, "src", "verilog_analysis", "__main__.py")),
			),
			workerRoot,
			"Ensure prepack copies packages/verilog-analysis into dist/python/verilog-analysis.",
		),
		check(
			"dist-pyverilog-vendor",
			"built modified pyverilog vendor fork",
			checkStatus(existsSync(join(workerRoot, "vendor", "pyverilog", "pyverilog", "__init__.py"))),
			join(workerRoot, "vendor", "pyverilog"),
			"Ensure the modified pyverilog fork is present under the built worker vendor directory.",
		),
		check(
			"dist-prompt-assets",
			"built VeriGen prompt assets",
			checkStatus(
				existsSync(join(assetsRoot, "prompts", "verigen-system.md")) &&
					existsSync(join(assetsRoot, "prompts", "verigen-coder.md")) &&
					existsSync(join(assetsRoot, "prompts", "verigen-debugger.md")) &&
					existsSync(join(assetsRoot, "prompts", "verigen-planner.md")) &&
					existsSync(join(assetsRoot, "prompts", "verigen-verifier.md")),
			),
			join(assetsRoot, "prompts"),
			"Ensure prepack copies .pi/prompts/verigen-*.md into dist/pi-assets/prompts.",
		),
		check(
			"dist-skill-assets",
			"built VeriGen skill assets",
			checkStatus(existsSync(join(assetsRoot, "skills", "verigen-playbook.md"))),
			join(assetsRoot, "skills"),
			"Ensure prepack copies .pi/skills/verigen-*.md into dist/pi-assets/skills.",
		),
	];

	const blockers = checks.filter((item) => item.status === "blocked").map((item) => `${item.id}: ${item.remediation}`);
	const warnings = checks.filter((item) => item.status === "warn").map((item) => `${item.id}: ${item.remediation}`);
	return {
		title: "VeriGen built dist release smoke verification",
		status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warn" : "pass",
		repoRoot: workspace.repoRoot,
		packageRoot: workspace.packageRoot,
		checks,
		blockers,
		warnings,
	};
}

export function createReleasePackInstallSmokePlan(
	options: CreateReleasePackInstallSmokePlanOptions = {},
): ReleasePackInstallSmokePlan {
	const workspace = resolveReleaseWorkspace(options.repoRoot);
	const packageJson = readPackageJson(join(workspace.packageRoot, "package.json"));
	const packageName = stringField(packageJson?.name, VERIGEN_PACKAGE_NAME);
	const version = stringField(packageJson?.version, "0.0.0");
	const packDestination = resolve(options.packDestination ?? "/tmp/verigen-pack-smoke");
	const installPrefix = resolve(options.installPrefix ?? "/tmp/verigen-install-smoke");
	const cacheDir = resolve(options.cacheDir ?? "/tmp/verigen-cache-smoke");
	const tarballPath = join(packDestination, npmTarballName(packageName, version));
	const installedBin = join(installPrefix, "bin", "verigen");
	const sourceCli = join(workspace.packageRoot, "src", "cli.ts");
	const steps: ReleasePackInstallSmokeStep[] = [
		{
			id: "clean-temp",
			title: "Clean temporary smoke directories",
			command: command(["rm", "-rf", packDestination, installPrefix, cacheDir]),
			required: true,
			notes: "Use throwaway paths outside the repository so npm install cannot resolve workspace files.",
		},
		{
			id: "source-verify-local",
			title: "Verify source release prerequisites",
			command: command(["node", sourceCli, "release-smoke", "--verify-local", "--json"]),
			required: true,
			notes: "Checks manifest, bin/files/prepack, dependencies, extension source, worker source, pyverilog vendor, and no-Docker boundary.",
		},
		{
			id: "pack",
			title: "Create npm tarball",
			command: `${command(["mkdir", "-p", packDestination])} && ${command([
				"npm",
				"--prefix",
				workspace.packageRoot,
				"pack",
				"--pack-destination",
				packDestination,
			])}`,
			required: true,
			notes: "Runs package prepack/build and creates the same tarball shape npm publish will upload.",
		},
		{
			id: "install",
			title: "Install tarball into a clean temporary prefix",
			command: command(["npm", "install", "-g", "--prefix", installPrefix, tarballPath, "--ignore-scripts"]),
			required: true,
			notes: "Installs from the tarball only; install scripts stay disabled.",
		},
		{
			id: "installed-help",
			title: "Verify installed CLI starts",
			command: command([installedBin, "--help"]),
			required: true,
			notes: "Proves the npm bin entry resolves to built dist/cli.js.",
		},
		{
			id: "installed-dist-surface",
			title: "Verify installed dist package surface",
			command: command([installedBin, "release-smoke", "--verify-dist", "--json"]),
			required: true,
			notes: "Checks built CLI/API/extension, workbench wiring, prompt/skill assets, Python worker, and pyverilog vendor.",
		},
		{
			id: "installed-agent-extension",
			title: "Verify installed agent launch wiring",
			command: command([installedBin, "agent", "--dry-run", "--json"]),
			required: true,
			notes: "Proves installed verigen agent loads bundled prompts, skills, and the S15 workbench extension.",
		},
		{
			id: "installed-product-tui",
			title: "Verify installed product TUI render path",
			command: command([installedBin, "product-preview", "--tui", "--width", "100", "--height", "32"]),
			required: true,
			notes: "Exercises the S15 responsive product workbench render path from the installed package.",
		},
		{
			id: "installed-quality-probe",
			title: "Verify installed quality probe loop",
			command: command([installedBin, "quality-probe", "fix-loop", "--case", "l0-mux2", "--json"]),
			required: true,
			notes: "Exercises S7 fix-loop and S6 simulation integration without paid model calls.",
		},
		{
			id: "installed-hardware-flow",
			title: "Verify installed dry-run hardware flow",
			command: command([installedBin, "hardware-flow", "--template", "blink_led", "--json"]),
			required: true,
			notes: "Exercises S10 simulation plus mock board dry-run report from the installed package.",
		},
		{
			id: "installed-doctor",
			title: "Verify installed doctor with isolated worker cache",
			command: `VERIGEN_CACHE_DIR=${shellQuote(cacheDir)} ${command([installedBin, "doctor", "--json"])}`,
			required: true,
			notes: "Bootstraps the npm-vendored Python worker into an isolated uv cache and checks required tools.",
		},
		{
			id: "installed-worker-smoke",
			title: "Verify installed Python worker roundtrip",
			command: `VERIGEN_CACHE_DIR=${shellQuote(cacheDir)} ${command([installedBin, "worker-smoke", "--json"])}`,
			required: true,
			notes: "Runs a parse_ast JSONL request through the installed worker and vendored pyverilog fork.",
		},
	];
	return {
		packageName,
		version,
		repoRoot: workspace.repoRoot,
		packageRoot: workspace.packageRoot,
		packDestination,
		installPrefix,
		cacheDir,
		tarballPath,
		steps,
		notes: [
			"This plan does not include npm authentication handling and does not run npm publish.",
			"Run it only after changelog/release policy is satisfied or explicitly overridden.",
			"After any local npm credential is used, revoke or rotate it from the npm account settings.",
		],
	};
}

export function createReleaseEngineeringReport(): ReleaseEngineeringReport {
	const smokeSteps: ReleaseSmokeStep[] = [
		{
			id: "cli-help",
			title: "CLI starts",
			command: "verigen --help",
			required: true,
			status: "pending",
			notes: "Validates the npm bin entry and Node runtime.",
		},
		{
			id: "doctor",
			title: "Install doctor",
			command: "verigen doctor --json",
			required: true,
			status: "pending",
			notes: "Checks Node, uv, worker bootstrap, iverilog/vvp, Graphify and optional EDA tools.",
		},
		{
			id: "worker-smoke",
			title: "Python worker smoke",
			command: "verigen worker-smoke --json",
			required: true,
			status: "pending",
			notes: "Verifies npm-vendored Python worker and pyverilog fork bootstrap.",
		},
		{
			id: "quality-probe",
			title: "Codegen quality probe",
			command: "verigen quality-probe fix-loop --case l0-mux2 --json",
			required: true,
			status: "pending",
			notes: "Verifies S7 loop and S6 sim path without paid tokens by default.",
		},
		{
			id: "agent-extension",
			title: "VeriGen agent extension wiring",
			command: "verigen agent --dry-run --json",
			required: true,
			status: "pending",
			notes: "Verifies the pi launch command includes VeriGen prompts, skills, and the S15 workbench extension.",
		},
		{
			id: "product-tui",
			title: "Product workbench TUI preview",
			command: "verigen product-preview --tui --width 100 --height 32",
			required: true,
			status: "pending",
			notes: "Verifies the responsive S15 workbench render path without starting a live terminal.",
		},
		{
			id: "dist-surface",
			title: "Built npm package surface",
			command: "verigen release-smoke --verify-dist --json",
			required: true,
			status: "pending",
			notes: "Verifies built dist CLI/API/extension, prompt assets, skill assets, Python worker, and pyverilog vendor paths before npm pack.",
		},
		{
			id: "hardware-flow",
			title: "Dry-run hardware flow",
			command: "verigen hardware-flow --template blink_led --json",
			required: true,
			status: "pending",
			notes: "Verifies S10 sim plus mock board report.",
		},
	];
	return {
		packageName: VERIGEN_PACKAGE_NAME,
		versionStrategy: "standalone VeriGen package version",
		publishTarget: "npm package with vendored Python worker source and pyverilog fork",
		quickstart: [
			"npm install -g verigen",
			"verigen doctor",
			"verigen worker-smoke --json",
			"verigen quality-probe fix-loop --case l0-mux2",
			"verigen agent --dry-run --json",
			"verigen product-preview --tui",
			"verigen hardware-flow --template blink_led",
		],
		smokeSteps,
		examples: [
			{
				id: "counter",
				title: "Enabled counter",
				description: "L1 sequential RTL template with reset and enable.",
				topModule: "counter8_en",
				entryCommand: "verigen quality-probe fix-loop --case l1-counter",
			},
			{
				id: "fsm",
				title: "Simple FSM",
				description: "Planned S7/S12 FSM evaluation template using explicit state encodings.",
				topModule: "sequence_detector",
				entryCommand: "verigen eval-suite --suite smoke",
			},
			{
				id: "uart_loopback",
				title: "UART loopback",
				description: "S9/S10 mock board hardware flow template.",
				topModule: "uart_loopback",
				entryCommand: "verigen hardware-flow --template uart_loopback",
			},
			{
				id: "i2c_skeleton",
				title: "I2C skeleton",
				description: "Planned L3 interface skeleton for S12 expanded evaluation.",
				topModule: "i2c_master_skeleton",
				entryCommand: "verigen eval-suite --suite roadmap",
			},
		],
		ciChecklist: [
			"npm install --ignore-scripts",
			"cd packages/verigen && node --test test/*.test.ts",
			"npm run check",
			"verigen release-smoke --pack-install-plan",
			"verigen release-smoke --verify-dist --json after build/prepack",
			"npm pack smoke from a clean temp prefix before publishing",
		],
		blockers: [
			"npm publish permission and dist-tag still require owner confirmation.",
			"Release command must follow repository release policy and is not run by this smoke report.",
		],
	};
}

export function renderReleaseSmokeVerificationReport(report: ReleaseSmokeVerificationReport): string {
	return [
		`${report.title}: ${report.status}`,
		`Repo root: ${report.repoRoot}`,
		`Package root: ${report.packageRoot}`,
		"",
		"Checks",
		...report.checks.map((item) => `- [${item.status}] ${item.id}: ${item.evidence}`),
		"",
		"Blockers",
		...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
		"",
		"Warnings",
		...(report.warnings.length > 0 ? report.warnings.map((item) => `- ${item}`) : ["- none"]),
	].join("\n");
}

export function renderReleasePackInstallSmokePlan(plan: ReleasePackInstallSmokePlan): string {
	return [
		`VeriGen pack/install smoke plan: ${plan.packageName}@${plan.version}`,
		`Repo root: ${plan.repoRoot}`,
		`Package root: ${plan.packageRoot}`,
		`Pack destination: ${plan.packDestination}`,
		`Install prefix: ${plan.installPrefix}`,
		`Cache dir: ${plan.cacheDir}`,
		`Tarball path: ${plan.tarballPath}`,
		"",
		"Steps",
		...plan.steps.map((step, index) => `${index + 1}. ${step.id}: ${step.command}`),
		"",
		"Notes",
		...plan.notes.map((note) => `- ${note}`),
	].join("\n");
}

export function renderReleaseEngineeringReport(report: ReleaseEngineeringReport): string {
	return [
		`VeriGen S11 Release Engineering: ${report.packageName}`,
		`Version strategy: ${report.versionStrategy}`,
		`Publish target: ${report.publishTarget}`,
		"",
		"Quickstart",
		...report.quickstart.map((command) => `- ${command}`),
		"",
		"Smoke checklist",
		...report.smokeSteps.map((step) => `- [${step.status}] ${step.id}: ${step.command}`),
		"",
		"Examples",
		...report.examples.map((example) => `- ${example.id}: ${example.topModule} (${example.entryCommand})`),
		"",
		"CI checklist",
		...report.ciChecklist.map((item) => `- ${item}`),
		"",
		"Blockers",
		...report.blockers.map((item) => `- ${item}`),
	].join("\n");
}
