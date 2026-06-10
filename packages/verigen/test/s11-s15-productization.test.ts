import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyProductWorkbenchActions,
	applyProductWorkbenchLayoutPatch,
	calculateEvaluationMetrics,
	createProductReportArtifact,
	createProductTemplateArtifact,
	createProductWorkbenchModel,
	createProductWorkbenchPiTuiMount,
	createReleaseEngineeringReport,
	createReleasePackInstallSmokePlan,
	exportProductReportMarkdown,
	installVerigenCodingAgentExtension,
	ProductWorkbenchTuiComponent,
	renderBoardProfileManagement,
	renderProductWorkbenchPreview,
	renderProductWorkbenchTui,
	renderProviderConfigPage,
	renderReleaseEngineeringReport,
	renderReleasePackInstallSmokePlan,
	renderReleaseSmokeVerificationReport,
	resolveProductWorkbenchInput,
	restoreWorkbenchLayout,
	runDryRunHardwareFlow,
	runEvaluationSuite,
	serializeWorkbenchLayout,
	splitProductWorkbenchInput,
	VERIGEN_WORKBENCH_CUSTOM_TYPE,
	type VerigenWorkbenchExtensionApi,
	type VerigenWorkbenchExtensionCommand,
	verifyDistReleaseSmoke,
	verifyLocalReleaseSmoke,
} from "../src/index.ts";

type WidgetComponent = {
	render(width: number): string[];
};

type WidgetFactory = () => WidgetComponent;

function isWidgetFactory(value: unknown): value is WidgetFactory {
	return typeof value === "function";
}

function writeText(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
}

describe("S11-S15 productization layer", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("builds a release smoke checklist with quickstart and examples", () => {
		const report = createReleaseEngineeringReport();

		assert.equal(report.packageName, "verigen");
		assert.ok(report.quickstart.some((command) => command.includes("verigen doctor")));
		assert.ok(report.quickstart.some((command) => command.includes("verigen agent --dry-run --json")));
		assert.ok(report.smokeSteps.some((step) => step.id === "hardware-flow" && step.required));
		assert.ok(report.smokeSteps.some((step) => step.id === "agent-extension" && step.required));
		assert.ok(report.smokeSteps.some((step) => step.id === "product-tui" && step.required));
		assert.ok(report.smokeSteps.some((step) => step.id === "dist-surface" && step.required));
		assert.ok(report.examples.some((example) => example.id === "uart_loopback"));
		assert.ok(report.ciChecklist.some((item) => item.includes("--pack-install-plan")));
		assert.match(renderReleaseEngineeringReport(report), /Release Engineering/);
	});

	test("prints a pack and temporary install smoke plan without handling npm tokens", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "verigen-pack-plan-"));
		tempDirs.push(repoRoot);
		const packageRoot = join(repoRoot, "packages", "verigen");
		writeText(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "verigen",
				version: "1.2.3",
			}),
		);

		const plan = createReleasePackInstallSmokePlan({
			repoRoot,
			packDestination: join(repoRoot, "pack out"),
			installPrefix: join(repoRoot, "install out"),
			cacheDir: join(repoRoot, "cache out"),
		});
		const rendered = renderReleasePackInstallSmokePlan(plan);

		assert.equal(plan.packageName, "verigen");
		assert.equal(plan.version, "1.2.3");
		assert.ok(plan.tarballPath.endsWith("verigen-1.2.3.tgz"));
		assert.ok(plan.steps.some((step) => step.id === "pack" && step.command.includes("npm --prefix")));
		assert.ok(plan.steps.some((step) => step.id === "installed-worker-smoke"));
		assert.ok(plan.steps.some((step) => step.id === "installed-dist-surface"));
		assert.doesNotMatch(rendered, /token/i);
		assert.match(rendered, /pack\/install smoke plan/);
	});

	test("verifies local release smoke prerequisites without running npm pack", () => {
		const report = verifyLocalReleaseSmoke();

		assert.equal(report.status, "pass");
		assert.ok(report.packageRoot.endsWith("packages/verigen"));
		assert.ok(report.checks.some((check) => check.id === "pyverilog-vendor" && check.status === "pass"));
		assert.ok(report.checks.some((check) => check.id === "pi-tui-dependency" && check.status === "pass"));
		assert.ok(report.checks.some((check) => check.id === "extension-export" && check.status === "pass"));
		assert.ok(report.checks.some((check) => check.id === "workbench-extension-entry" && check.status === "pass"));
		assert.ok(report.checks.some((check) => check.id === "agent-default-extension" && check.status === "pass"));
		assert.match(renderReleaseSmokeVerificationReport(report), /local release smoke verification/);
	});

	test("accepts a release tag changelog without the next Unreleased section", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "verigen-tag-smoke-"));
		tempDirs.push(repoRoot);
		const packageRoot = join(repoRoot, "packages", "verigen");
		writeText(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "verigen",
				version: "1.2.3",
				bin: { verigen: "./dist/cli.js" },
				files: ["dist", "README.md", "CHANGELOG.md"],
				scripts: { prepack: "npm run build" },
				dependencies: {
					"@earendil-works/pi-coding-agent": "0.79.0",
					"@earendil-works/pi-tui": "0.79.0",
				},
				exports: {
					"./coding-agent-extension": {
						import: "./dist/verigen-coding-agent-extension.js",
						types: "./dist/verigen-coding-agent-extension.d.ts",
					},
				},
			}),
		);
		writeText(join(packageRoot, "src", "verigen-coding-agent-extension.ts"), "export {};\n");
		writeText(
			join(packageRoot, "src", "verigen-agent-launcher.ts"),
			"const extension = 'verigen-coding-agent-extension'; const flag = '--extension';\n",
		);
		writeText(join(packageRoot, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3] - 2026-06-09\n");
		writeText(join(repoRoot, "packages", "verilog-analysis", "pyproject.toml"), "[project]\n");
		writeText(join(repoRoot, "packages", "verilog-analysis", "src", "verilog_analysis", "__init__.py"), "\n");
		writeText(
			join(repoRoot, "packages", "verilog-analysis", "vendor", "pyverilog", "setup.py"),
			"from setuptools import setup\n",
		);

		const report = verifyLocalReleaseSmoke({ repoRoot });

		assert.equal(report.status, "pass");
		assert.ok(report.checks.some((check) => check.id === "changelog" && check.status === "pass"));
	});

	test("verifies built dist release surface without running npm pack", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "verigen-dist-smoke-"));
		tempDirs.push(repoRoot);
		const packageRoot = join(repoRoot, "packages", "verigen");
		writeText(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "verigen",
				version: "0.0.0-test",
			}),
		);

		const missing = verifyDistReleaseSmoke({ repoRoot });
		assert.equal(missing.status, "blocked");
		assert.ok(missing.checks.some((check) => check.id === "dist-root" && check.status === "blocked"));

		writeText(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('verigen');\n");
		writeText(join(packageRoot, "dist", "index.js"), "export {};\n");
		writeText(join(packageRoot, "dist", "index.d.ts"), "export {};\n");
		writeText(join(packageRoot, "dist", "verigen-coding-agent-extension.js"), "export {};\n");
		writeText(join(packageRoot, "dist", "verigen-coding-agent-extension.d.ts"), "export {};\n");
		writeText(
			join(packageRoot, "dist", "verigen-agent-launcher.js"),
			"const extension = 'verigen-coding-agent-extension'; const flag = '--extension';\n",
		);
		writeText(join(packageRoot, "dist", "python", "verilog-analysis", "pyproject.toml"), "[project]\n");
		writeText(join(packageRoot, "dist", "python", "verilog-analysis", "uv.lock"), "version = 1\n");
		writeText(
			join(packageRoot, "dist", "python", "verilog-analysis", "src", "verilog_analysis", "__main__.py"),
			"def main(): pass\n",
		);
		writeText(
			join(packageRoot, "dist", "python", "verilog-analysis", "vendor", "pyverilog", "pyverilog", "__init__.py"),
			"\n",
		);
		for (const prompt of [
			"verigen-system.md",
			"verigen-coder.md",
			"verigen-debugger.md",
			"verigen-planner.md",
			"verigen-verifier.md",
		]) {
			writeText(join(packageRoot, "dist", "pi-assets", "prompts", prompt), `# ${prompt}\n`);
		}
		writeText(join(packageRoot, "dist", "pi-assets", "skills", "verigen-playbook.md"), "# playbook\n");

		const report = verifyDistReleaseSmoke({ repoRoot });
		assert.equal(report.status, "pass");
		assert.ok(report.checks.some((check) => check.id === "dist-extension" && check.status === "pass"));
		assert.ok(report.checks.some((check) => check.id === "dist-prompt-assets" && check.status === "pass"));
		assert.match(renderReleaseSmokeVerificationReport(report), /built dist release smoke verification/);
	});

	test("calculates evaluation metrics and runs the smoke suite", async () => {
		const metrics = calculateEvaluationMetrics([
			{
				caseId: "a",
				status: "pass",
				passAt1: true,
				convergedWithin3: true,
				repairRounds: 0,
				failureTypes: [],
			},
			{
				caseId: "b",
				status: "pass",
				passAt1: false,
				convergedWithin3: true,
				repairRounds: 1,
				failureTypes: ["sim_fail"],
			},
		]);
		assert.equal(metrics.passAt1Rate, 0.5);
		assert.equal(metrics.convergenceRate, 1);
		assert.equal(metrics.failureTypeDistribution.sim_fail, 1);

		const report = await runEvaluationSuite("smoke");
		assert.equal(report.metrics.total, 2);
		assert.equal(report.metrics.passed, 2);
		assert.equal(report.metrics.convergedWithin3, 2);
		assert.ok(report.failureSamples.length >= 1);
	});

	test("renders product workbench preview, report export, and session replay", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });

		assert.equal(model.title, "VeriGen Product Workbench");
		assert.ok(model.pipelineNavigator.includes("evaluation"));
		assert.ok(model.inspectorTabs.some((tab) => tab.id === "board-report"));
		assert.equal(model.providerConfigPage.status, "needs_key");
		assert.ok(model.boardProfileManagement.profiles.some((profile) => profile.id === "mock-devboard"));
		assert.equal(model.layout.selectedInspector, "trace-report");
		assert.ok(model.keybindings.some((binding) => binding.action === "export-report"));
		assert.ok(model.templates.some((template) => template.id === "counter"));
		assert.ok(model.boardProfiles.some((profile) => profile.id === "mock-devboard"));
		assert.ok(model.sessionReplay.length >= 5);
		assert.match(renderProductWorkbenchPreview(model), /Inspector tabs/);
		assert.match(exportProductReportMarkdown(model), /Session Replay/);
	});

	test("renders provider configuration, board profile management, and doctor repair suggestions", () => {
		const model = createProductWorkbenchModel({
			env: { VERIGEN_TEST_LLM_API_KEY: "secret" },
			doctor: {
				ok: true,
				checks: [
					{
						name: "graphify-index",
						state: "warn",
						message: "Graphify index missing",
						required: false,
						details: { nodeCount: 0, edgeCount: 0 },
					},
				],
			},
		});

		assert.equal(model.providerConfigPage.status, "configured");
		assert.equal(model.doctorRepairSuggestions.length, 1);
		assert.equal(model.doctorRepairSuggestions[0]?.command, "verigen graphify-update");
		assert.match(renderProviderConfigPage(model.providerConfigPage), /apiKey: <set>/);
		assert.match(renderBoardProfileManagement(model.boardProfileManagement), /mock-devboard/);
		assert.match(renderBoardProfileManagement(model.boardProfileManagement), /reset=rst/);
		assert.match(exportProductReportMarkdown(model), /Doctor Repair Suggestions/);
	});

	test("creates scaffoldable product template artifacts", () => {
		for (const templateId of ["counter", "fsm", "uart_loopback", "i2c_skeleton"] as const) {
			const artifact = createProductTemplateArtifact(templateId);
			const paths = artifact.files.map((file) => file.path);

			assert.equal(artifact.id, templateId);
			assert.ok(paths.includes("README.md"));
			assert.ok(paths.some((path) => path.startsWith("rtl/") && path.endsWith(".v")));
			assert.ok(paths.some((path) => path.startsWith("tb/") && path.endsWith("_tb.v")));
			assert.ok(paths.includes("verigen.json"));
		}

		const uart = createProductTemplateArtifact("uart_loopback");
		assert.equal(uart.topModule, "uart_loopback");
		assert.match(uart.files.find((file) => file.path === "verigen.json")?.content ?? "", /mock-devboard/);
	});

	test("creates a product report artifact with layout and replay state", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = applyProductWorkbenchActions(createProductWorkbenchModel({ evaluation, hardwareFlow }), [
			"next-inspector",
			"toggle-density",
		]);
		const artifact = createProductReportArtifact(model, "demo-report.md");

		assert.equal(artifact.fileName, "demo-report.md");
		assert.equal(artifact.contentType, "text/markdown");
		assert.match(artifact.content, /Workbench Layout/);
		assert.match(artifact.content, /Session Replay/);
		assert.match(artifact.content, /selected inspector: waveform/);
		assert.match(artifact.content, /ui\/toggle-density|ui: density comfortable/);
	});

	test("renders a bounded three-column product TUI layout", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });
		const rendered = renderProductWorkbenchTui(model, 112, 30);
		const lines = rendered.split("\n");

		assert.match(rendered, /Pipeline Navigator/);
		assert.match(rendered, /Task Log \/ Replay/);
		assert.match(rendered, /Inspector/);
		assert.match(rendered, /Keys/);
		assert.ok(lines.every((line) => line.length <= 112));
	});

	test("renders responsive product TUI layouts for medium and narrow terminals", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });
		const medium = renderProductWorkbenchTui(model, 72, 24);
		const narrow = renderProductWorkbenchTui(model, 48, 22);
		const mediumLines = medium.split("\n");
		const narrowLines = narrow.split("\n");

		assert.match(medium, /Inspector \/ Replay/);
		assert.match(narrow, /Inspector/);
		assert.ok(mediumLines.every((line) => line.length <= 72));
		assert.ok(narrowLines.every((line) => line.length <= 48));
		assert.ok(mediumLines.length <= 24);
		assert.ok(narrowLines.length <= 22);
	});

	test("applies product TUI focus, inspector, density, and layout persistence", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });
		const patched = applyProductWorkbenchLayoutPatch(model, {
			selectedInspector: "board-report",
			focus: "center",
			density: "comfortable",
		});

		assert.equal(patched.layout.selectedInspector, "board-report");
		assert.equal(patched.layout.focus, "center");
		assert.equal(patched.layout.density, "comfortable");

		const acted = applyProductWorkbenchActions(patched, [
			"previous-inspector",
			"focus-left",
			"toggle-density",
			"open-selected",
		]);
		assert.equal(acted.layout.focus, "left");
		assert.equal(acted.layout.density, "compact");
		assert.equal(acted.layout.selectedInspector, "tool-log");
		assert.ok(acted.sessionReplay.some((event) => event.action === "open-selected"));

		const restored = restoreWorkbenchLayout(model, serializeWorkbenchLayout(acted.layout));
		assert.equal(restored.layout.focus, "left");
		assert.equal(restored.layout.density, "compact");
		assert.equal(restored.layout.selectedInspector, "tool-log");
		assert.match(renderProductWorkbenchTui(restored, 112, 30), /\* Pipeline Navigator/);
	});

	test("maps terminal input into product workbench actions without a live terminal", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });
		let exited = false;
		const component = new ProductWorkbenchTuiComponent(model, {
			onExit: () => {
				exited = true;
			},
		});

		assert.equal(resolveProductWorkbenchInput(model, "\t"), "next-inspector");
		component.handleInput("\t");
		component.handleInput(" ");
		component.handleInput("q");

		const updated = component.getModel();
		assert.equal(updated.layout.selectedInspector, "waveform");
		assert.equal(updated.layout.density, "comfortable");
		assert.equal(exited, true);
		assert.match(component.render(112).join("\n"), /Waveform/);
	});

	test("exposes a pi-tui component mount contract for coding-agent integration", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });
		let changed = false;
		const mount = createProductWorkbenchPiTuiMount(model, {
			height: 24,
			onModelChange: () => {
				changed = true;
			},
		});

		assert.equal(mount.id, "verigen.product-workbench");
		assert.equal(mount.packageName, "@earendil-works/pi-tui");
		assert.ok(mount.keybindings.some((binding) => binding.action === "next-inspector"));
		assert.ok(mount.notes.some((note) => note.includes("coding-agent")));
		assert.match(mount.component.render(72).join("\n"), /Inspector \/ Replay/);

		mount.component.handleInput?.("\t");
		assert.equal(changed, true);
		assert.match(mount.component.render(72).join("\n"), /Waveform/);
	});

	test("registers a coding-agent extension that mounts the workbench widget on command", async () => {
		type WorkbenchHandler = Parameters<VerigenWorkbenchExtensionApi["on"]>[1];
		const handlers = new Map<string, WorkbenchHandler>();
		let command: VerigenWorkbenchExtensionCommand | undefined;
		let rendererType: string | undefined;
		let renderedHeader = "";
		let widgetKey: string | undefined;
		let widgetPlacement: string | undefined;
		let renderedWidget = "";
		let statusText: string | undefined;
		let sentCustomType: string | undefined;
		const api: VerigenWorkbenchExtensionApi = {
			on: (event, handler) => {
				handlers.set(event, handler);
			},
			registerCommand: (name, registeredCommand) => {
				assert.equal(name, "verigen-workbench");
				command = registeredCommand;
			},
			registerMessageRenderer: (customType) => {
				rendererType = customType;
			},
			sendMessage: (message) => {
				sentCustomType = message.customType;
			},
		};
		const fakeContext = {
			mode: "tui",
			ui: {
				setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
					widgetKey = key;
					widgetPlacement = options?.placement;
					if (isWidgetFactory(content)) {
						renderedWidget = content().render(72).join("\n");
					}
				},
				setStatus: (_key: string, text: string | undefined) => {
					statusText = text;
				},
				setHeader: (factory: unknown) => {
					if (typeof factory !== "function") {
						renderedHeader = "";
						return;
					}
					const header = (
						factory as (tui: unknown, theme: { fg: (_color: string, text: string) => string }) => WidgetComponent
					)({}, { fg: (_color, text) => text });
					renderedHeader = header.render(80).join("\n");
				},
				notify: () => {},
			},
		};

		installVerigenCodingAgentExtension(api, {
			height: 24,
			now: "2026-06-09T00:00:00.000Z",
		});
		assert.equal(rendererType, VERIGEN_WORKBENCH_CUSTOM_TYPE);
		assert.ok(command);

		const startHandler = handlers.get("session_start");
		assert.ok(startHandler);
		await startHandler({ type: "session_start" }, fakeContext as unknown as ExtensionContext);
		assert.match(renderedHeader, /VERIGEN|_____/);
		assert.match(renderedHeader, /Verilog-specialized coding agent/);
		assert.equal(widgetKey, undefined);
		assert.equal(statusText, undefined);

		await command.handler("show", fakeContext as unknown as ExtensionCommandContext);
		assert.equal(widgetKey, "verigen-product-workbench");
		assert.equal(widgetPlacement, "belowEditor");
		assert.equal(statusText, "VeriGen S15 workbench");
		assert.match(renderedWidget, /Inspector \/ Replay/);

		await command.handler("snapshot", fakeContext as unknown as ExtensionCommandContext);
		assert.equal(sentCustomType, VERIGEN_WORKBENCH_CUSTOM_TYPE);
	});

	test("splits batched terminal input before applying workbench actions", async () => {
		const evaluation = await runEvaluationSuite("smoke");
		const hardwareFlow = await runDryRunHardwareFlow({ template: "blink_led" });
		const model = createProductWorkbenchModel({ evaluation, hardwareFlow });
		const component = new ProductWorkbenchTuiComponent(model);

		assert.deepEqual(splitProductWorkbenchInput("\t q"), ["\t", " ", "q"]);
		for (const event of splitProductWorkbenchInput("\t ")) {
			component.handleInput(event);
		}

		const updated = component.getModel();
		assert.equal(updated.layout.selectedInspector, "waveform");
		assert.equal(updated.layout.density, "comfortable");
	});
});
