#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import { runHimasim, runIverilogVvp, runVerilatorLint, runYosysSynth } from "./eda-toolrunner.ts";
import { GraphifyContext } from "./graphify-context.ts";
import { getNativeToolsStatus, installBundledNativeTools } from "./native-tools.ts";
import { bootstrapPythonWorker, type DoctorCheck, doctorVerigenInstall } from "./python-worker-bootstrap.ts";
import {
	defaultCodegenQualityProbeCases,
	renderCodegenQualityProbeResult,
	runCodegenQualityProbeCase,
} from "./quality-probe.ts";
import { defaultVerigenModeProfile, runBuiltInTraceDemo, runTracePanelFromFiles } from "./s5-mode.ts";
import { createQualityProbeTuiPreview, createTraceTuiPreview, renderVerigenTuiPreview } from "./s5-tui.ts";
import { renderVerigenFixLoopReport, runCodegenQualityProbeFixLoop } from "./s7-agent-loop.ts";
import { type BoardSmokeKind, renderMockBoardBringupReport, runMockBoardBringup } from "./s9-board-profile.ts";
import {
	type HardwareFlowTemplateId,
	renderDryRunHardwareFlowReport,
	runDryRunHardwareFlow,
} from "./s10-hardware-flow.ts";
import {
	createReleaseEngineeringReport,
	createReleasePackInstallSmokePlan,
	renderReleaseEngineeringReport,
	renderReleasePackInstallSmokePlan,
	renderReleaseSmokeVerificationReport,
	verifyDistReleaseSmoke,
	verifyLocalReleaseSmoke,
} from "./s11-release-engineering.ts";
import { type EvaluationSuiteId, renderEvaluationSuiteReport, runEvaluationSuite } from "./s12-evaluation.ts";
import { runProductWorkbenchTui } from "./s15-product-tui.ts";
import {
	applyProductWorkbenchActions,
	applyProductWorkbenchLayoutPatch,
	createProductReportArtifact,
	createProductTemplateArtifact,
	createProductWorkbenchModel,
	exportProductReportMarkdown,
	isProductTemplateId,
	isWorkbenchDensity,
	isWorkbenchFocusPane,
	isWorkbenchInteractionAction,
	isWorkbenchPaneId,
	type ProductTemplateId,
	type ProductWorkbenchModel,
	renderBoardProfileManagement,
	renderProductWorkbenchPreview,
	renderProductWorkbenchTui,
	renderProviderConfigPage,
	restoreWorkbenchLayout,
	serializeWorkbenchLayout,
	type WorkbenchInteractionAction,
	type WorkbenchLayoutPatch,
} from "./s15-product-workbench.ts";
import { buildVerigenAgentLaunch, readVerigenPackageVersion, runVerigenAgent } from "./verigen-agent-launcher.ts";
import { VerilogAnalysis } from "./verilog-analysis-client.ts";

function printHelp(): void {
	console.log(`Usage: verigen [command] [options]

Default:
  verigen [agent options] Launch the VeriGen chat-first coding agent TUI

Commands:
  agent            Launch the VeriGen chat-first coding agent
  mode             Print the VeriGen S5 mode/profile and pipeline stages
  doctor           Check Node, uv, iverilog/vvp, worker bootstrap, and Graphify status
  native-tools     Install or inspect bundled uv/uvx native tools
  python-bootstrap Prepare the Python worker venv with bundled uv
  worker-smoke     Bootstrap the worker and run one parse_ast JSONL request
  trace-demo       Run the built-in failing RTL/VCD example and print the S5 trace panel
  trace-panel      Trace user-provided RTL/VCD files and print the S5 trace panel
  tui-preview      Render the S5 TUI preview for trace-demo or quality-probe
  tool-runner      Run S6 EDA profiles: sim, lint, synth, or himasim
  quality-probe    List, run, or fix-loop Codegen Quality Probe cases
  board-smoke      Run S9 mock board bring-up dry-run
  hardware-flow    Run S10 sim plus mock board dry-run hardware flow
  release-smoke    Print S11 release smoke checklist and quickstart
  eval-suite       Run S12 evaluation suite
  product-preview  Render S13-S15 product workbench preview/report
  product-workbench Launch the dogfood/debug product workbench TUI
  product-template  Scaffold a S15 product template project
  graphify-status  Print the default Graphify index status for the current repo
  graphify-query   Search the Graphify index
  graphify-explain Explain a Graphify node by id or path
  graphify-path    Find a Graphify path between two nodes
  graphify-update  Rebuild the Graphify index with uvx graphify

Options:
  --dag            Use DAG-based incremental generation
  --planner-llm    Use LLM to plan the signal-level DAG (dag mode only)
  --no-bootstrap   Do not create the Python worker cache venv
  --force          Recreate the Python worker cache venv
  --json           Print machine-readable JSON
  --rtl PATH       RTL file for trace-panel
  --tb PATH        Testbench file for tool-runner sim
  --vcd PATH       VCD file for trace-panel
  --mismatch LIST  Comma-separated mismatch signals for trace-panel
  --top NAME       Top module for trace-panel
  --trace-level N  Controller trace depth for trace-panel
  --window-size N  Waveform window size for trace-panel
  --case ID        Codegen Quality Probe case id
  --live           Call the configured LLM endpoint for quality-probe run
  --run-tools      Compile/sim generated RTL for quality-probe run
  --model ID       Override VERIGEN_TEST_LLM_MODEL for quality-probe run
  --base-url URL   Override VERIGEN_TEST_LLM_BASE_URL for quality-probe run
  --max-tokens N   Override max output tokens for quality-probe run
  --max-rounds N   Max S7 fix-loop rounds, capped at 3
  --width N        Render width for TUI previews and product workbench
  --height N       Render height for product workbench TUI
  --focus PANE     Product workbench focus pane: left, center, or right
  --inspector ID   Product workbench inspector tab id
  --density MODE   Product workbench density: compact or comfortable
  --action LIST    Comma-separated product workbench actions to replay
  --layout-json S  Restore product workbench layout from serialized JSON
  --output PATH    Write product-preview --report markdown to a file
  --id ID          Product template id: counter, fsm, uart_loopback, or i2c_skeleton
  --provider-page  Print product provider configuration page
  --profiles       Print product board profile management page
  --show-layout    Print serialized product workbench layout
  --smoke ID       Board smoke id: blink_led or uart_loopback
  --template ID    Hardware flow template id: blink_led or uart_loopback
  --suite ID       Evaluation suite id: smoke or roadmap
  --with-smoke     Run local eval/hardware smoke before product-preview
  --verify-local   Verify local release smoke prerequisites without npm pack/build
  --verify-dist    Verify built dist package surface without running npm pack/build
  --pack-install-plan Print npm pack/install smoke commands without running them
  --pack-destination PATH  Temporary directory for pack/install smoke tarball
  --install-prefix PATH    Temporary npm prefix for pack/install smoke
  --cache-dir PATH   Temporary VERIGEN_CACHE_DIR for worker bootstrap/smoke
  --interactive    Launch product-preview as an interactive TUI
  --report         Print product report markdown instead of workbench preview
  --tui            Launch product workbench TUI on terminals, otherwise print layout preview
  --dry-run        Print the resolved verigen agent launch command without running it
  --pi-command CMD Override the pi command used by verigen agent
  --max-results N  Limit Graphify query/explain results
  --max-depth N    Limit Graphify path search depth
  --help           Show this help
`);
}

function printVersion(): void {
	console.log(readVerigenPackageVersion() ?? "unknown");
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function optionValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function numberOption(args: string[], flag: string): number | undefined {
	const value = optionValue(args, flag);
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positionalArgs(args: string[]): string[] {
	const booleanFlags = new Set([
		"--dag",
		"--json",
		"--planner-llm",
		"--no-bootstrap",
		"--force",
		"--help",
		"--interactive",
		"--live",
		"--keep-temp",
		"--profiles",
		"--provider-page",
		"--dry-run",
		"--run-tools",
		"--with-smoke",
		"--report",
		"--show-layout",
		"--tui",
		"--verify-dist",
		"--verify-local",
		"--pack-install-plan",
	]);
	const valueFlags = new Set([
		"--action",
		"--base-url",
		"--case",
		"--density",
		"--focus",
		"--height",
		"--id",
		"--inspector",
		"--layout-json",
		"--max-depth",
		"--max-results",
		"--max-rounds",
		"--max-tokens",
		"--mismatch",
		"--model",
		"--output",
		"--cache-dir",
		"--install-prefix",
		"--pack-destination",
		"--pi-command",
		"--rtl",
		"--smoke",
		"--suite",
		"--tb",
		"--testbench",
		"--template",
		"--top",
		"--trace-level",
		"--vcd",
		"--window-size",
		"--width",
	]);
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (!value) continue;
		if (booleanFlags.has(value)) continue;
		if (valueFlags.has(value)) {
			index += 1;
			continue;
		}
		values.push(value);
	}
	return values;
}

function checkPrefix(check: DoctorCheck): string {
	if (check.state === "ok") return "OK";
	if (check.state === "warn") return "WARN";
	return "ERROR";
}

function printDoctorChecks(checks: DoctorCheck[]): void {
	for (const check of checks) {
		console.log(`${checkPrefix(check)} ${check.name}: ${check.message}`);
	}
}

function extractAgentOptions(args: string[]): {
	dryRun: boolean;
	json: boolean;
	piCommand: string | undefined;
	piArgs: string[];
} {
	const separatorIndex = args.indexOf("--");
	const beforeSeparator = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
	const afterSeparator = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
	const piArgs: string[] = [];
	let dryRun = false;
	let json = false;
	let piCommand: string | undefined;

	for (let index = 0; index < beforeSeparator.length; index += 1) {
		const arg = beforeSeparator[index];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--pi-command") {
			piCommand = beforeSeparator[index + 1];
			index += 1;
			continue;
		}
		piArgs.push(arg);
	}

	return {
		dryRun,
		json,
		piCommand,
		piArgs: [...piArgs, ...afterSeparator],
	};
}

function pathInputs(value: string | undefined): Array<{ path: string }> {
	if (!value) return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((path) => ({ path }));
}

async function runAgent(args: string[]): Promise<number> {
	const options = extractAgentOptions(args);
	if (options.dryRun) {
		const launch = buildVerigenAgentLaunch({ piCommand: options.piCommand, piArgs: options.piArgs });
		if (options.json) {
			console.log(JSON.stringify(launch, null, 2));
		} else {
			console.log([launch.command, ...launch.args].join(" "));
			console.log(`system prompt: ${launch.assets.systemPrompt}`);
			console.log(`prompt templates: ${launch.assets.promptTemplates.length}`);
			console.log(`skills: ${launch.assets.skills.length}`);
			console.log(`phase prompts: ${launch.assets.phasePrompts.length}`);
			console.log(`rule packs: ${launch.assets.rulePacks.length}`);
			console.log(`extensions: ${launch.assets.extensions.length}`);
		}
		return 0;
	}
	const result = await runVerigenAgent({ piCommand: options.piCommand, piArgs: options.piArgs });
	return result.exitCode;
}

async function runMode(args: string[]): Promise<number> {
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(defaultVerigenModeProfile, null, 2));
	} else {
		console.log(`${defaultVerigenModeProfile.name}`);
		console.log(defaultVerigenModeProfile.objective);
		console.log("");
		console.log(`Pipeline: ${defaultVerigenModeProfile.stages.join(" -> ")}`);
		console.log(`Trace panel: ${defaultVerigenModeProfile.tracePanelSections.join(", ")}`);
		console.log(`Codegen probe levels: ${defaultVerigenModeProfile.codegenProbeLevels.join(", ")}`);
	}
	return 0;
}

async function runDoctor(args: string[]): Promise<number> {
	const result = await doctorVerigenInstall({
		bootstrap: !hasFlag(args, "--no-bootstrap"),
		cacheRoot: optionValue(args, "--cache-dir"),
		force: hasFlag(args, "--force"),
	});
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		printDoctorChecks(result.checks);
	}
	return result.ok ? 0 : 1;
}

async function runNativeTools(args: string[]): Promise<number> {
	const action = positionalArgs(args)[0] ?? "status";
	if (action === "status") {
		const status = getNativeToolsStatus();
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			console.log(`${status.installed ? "OK" : "WARN"} native-tools: ${status.targetId}`);
			console.log(`dir: ${status.dir}`);
			if (status.missingBinaries.length > 0) console.log(`missing: ${status.missingBinaries.join(", ")}`);
		}
		return status.targetFound ? 0 : 1;
	}
	if (action === "install") {
		const result = await installBundledNativeTools({ force: hasFlag(args, "--force") });
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(`OK native-tools: ${result.action} ${result.targetId}`);
			console.log(`dir: ${result.dir}`);
			if (result.url) console.log(`source: ${result.url}`);
		}
		return 0;
	}
	console.error("native-tools action must be status or install");
	return 1;
}

async function runPythonBootstrap(args: string[]): Promise<number> {
	const launch = await bootstrapPythonWorker({
		bootstrap: !hasFlag(args, "--no-bootstrap"),
		cacheRoot: optionValue(args, "--cache-dir"),
		force: hasFlag(args, "--force"),
	});
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify({ ok: true, workerLaunch: launch }, null, 2));
	} else {
		console.log(`OK python-bootstrap: worker venv and dependencies ready at ${launch.venvDir}`);
		console.log(`worker root: ${launch.workerRoot}`);
		console.log(`python: ${launch.pythonPath}`);
		console.log(`bootstrapped: ${launch.wasBootstrapped ? "yes" : "no"}`);
	}
	return 0;
}

async function runWorkerSmoke(args: string[]): Promise<number> {
	const launch = await bootstrapPythonWorker({
		bootstrap: !hasFlag(args, "--no-bootstrap"),
		cacheRoot: optionValue(args, "--cache-dir"),
		force: hasFlag(args, "--force"),
	});
	const worker = new VerilogAnalysis({
		command: launch.command,
		args: launch.args,
		workerCwd: launch.cwd,
		requestTimeoutMs: 60_000,
	});
	try {
		const result = await worker.parseAst({
			rtl: "module TopModule(input wire a, output wire y); assign y = a; endmodule",
			top: "TopModule",
		});
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify({ ok: true, result }, null, 2));
		} else {
			console.log(`OK worker-smoke: parsed ${result.modules.length} module(s)`);
		}
		return result.ast_ok ? 0 : 1;
	} finally {
		await worker.close();
	}
}

async function runTraceDemo(args: string[]): Promise<number> {
	const result = await runBuiltInTraceDemo({
		keepTempDir: hasFlag(args, "--keep-temp"),
		workerOptions: { bootstrap: !hasFlag(args, "--no-bootstrap") },
	});
	if (hasFlag(args, "--json")) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					tempDir: result.tempDir,
					cleanedTempDir: result.cleanedTempDir,
					panel: result.panel,
					debuggerContext: result.trace.debuggerContext,
				},
				null,
				2,
			),
		);
	} else {
		console.log(result.panel.rendered);
	}
	return 0;
}

async function runTracePanel(args: string[]): Promise<number> {
	const positional = positionalArgs(args);
	const rtlPath = optionValue(args, "--rtl") ?? positional[0];
	const vcdPath = optionValue(args, "--vcd") ?? positional[1];
	const mismatchValue = optionValue(args, "--mismatch") ?? positional[2];
	if (!rtlPath || !vcdPath || !mismatchValue) {
		console.error("trace-panel requires --rtl PATH --vcd PATH --mismatch signal[,signal]");
		return 1;
	}
	const mismatchSignals = mismatchValue
		.split(",")
		.map((signal) => signal.trim())
		.filter((signal) => signal.length > 0);
	if (mismatchSignals.length === 0) {
		console.error("trace-panel requires at least one mismatch signal");
		return 1;
	}
	const result = await runTracePanelFromFiles({
		rtlPath,
		vcdPath,
		mismatchSignals,
		top: optionValue(args, "--top"),
		traceLevel: numberOption(args, "--trace-level"),
		windowSize: numberOption(args, "--window-size"),
		workerOptions: { bootstrap: !hasFlag(args, "--no-bootstrap") },
	});
	if (hasFlag(args, "--json")) {
		console.log(
			JSON.stringify({ ok: true, panel: result.panel, debuggerContext: result.trace.debuggerContext }, null, 2),
		);
	} else {
		console.log(result.panel.rendered);
	}
	return 0;
}

async function runQualityProbe(args: string[]): Promise<number> {
	const positional = positionalArgs(args);
	const action = positional[0] ?? "list";
	if (action === "list") {
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify({ cases: defaultCodegenQualityProbeCases }, null, 2));
		} else {
			for (const probeCase of defaultCodegenQualityProbeCases) {
				console.log(`${probeCase.id}\t${probeCase.level}\t${probeCase.title}`);
			}
		}
		return 0;
	}

	if (action === "fix-loop" || action === "loop") {
		const caseId = optionValue(args, "--case") ?? positional[1];
		if (!caseId) {
			console.error("quality-probe fix-loop requires --case ID or a case id positional argument");
			return 1;
		}
		const result = await runCodegenQualityProbeFixLoop(caseId, {
			live: hasFlag(args, "--live"),
			dag: hasFlag(args, "--dag"),
			plannerLlm: hasFlag(args, "--planner-llm"),
			repoRoot: process.cwd(),
			baseUrl: optionValue(args, "--base-url"),
			model: optionValue(args, "--model"),
			maxTokens: numberOption(args, "--max-tokens"),
			maxRounds: numberOption(args, "--max-rounds"),
		});
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(renderVerigenFixLoopReport(result));
		}
		return result.status === "pass" ? 0 : 1;
	}

	const caseId = optionValue(args, "--case") ?? (action === "run" ? positional[1] : action);
	if (!caseId) {
		console.error("quality-probe run requires --case ID or a case id positional argument");
		return 1;
	}
	const result = await runCodegenQualityProbeCase(caseId, {
		live: hasFlag(args, "--live"),
		runTools: hasFlag(args, "--run-tools"),
		repoRoot: process.cwd(),
		baseUrl: optionValue(args, "--base-url"),
		model: optionValue(args, "--model"),
		maxTokens: numberOption(args, "--max-tokens"),
	});
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(renderCodegenQualityProbeResult(result));
	}
	return 0;
}

async function runToolRunner(args: string[]): Promise<number> {
	const positional = positionalArgs(args);
	const action = positional[0] ?? "sim";
	const rtl = pathInputs(optionValue(args, "--rtl") ?? positional[1]);
	const testbench = pathInputs(optionValue(args, "--tb") ?? optionValue(args, "--testbench") ?? positional[2]);
	const top = optionValue(args, "--top");

	if (action === "sim") {
		if (rtl.length === 0 || testbench.length === 0) {
			console.error("tool-runner sim requires --rtl file[,file] --tb file[,file]");
			return 1;
		}
		const result = await runIverilogVvp({ rtl, testbench, top, keepWorkDir: hasFlag(args, "--keep-temp") });
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(inspect(result, { colors: false, depth: null }));
		}
		return result.ok ? 0 : 1;
	}

	if (action === "lint") {
		if (rtl.length === 0) {
			console.error("tool-runner lint requires --rtl file[,file]");
			return 1;
		}
		const result = await runVerilatorLint({ rtl, top, keepWorkDir: hasFlag(args, "--keep-temp") });
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(inspect(result, { colors: false, depth: null }));
		}
		return result.ok ? 0 : 1;
	}

	if (action === "synth") {
		if (rtl.length === 0) {
			console.error("tool-runner synth requires --rtl file[,file]");
			return 1;
		}
		const result = await runYosysSynth({ rtl, top, keepWorkDir: hasFlag(args, "--keep-temp") });
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(inspect(result, { colors: false, depth: null }));
		}
		return result.ok ? 0 : 1;
	}

	if (action === "himasim") {
		const result = await runHimasim();
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(inspect(result, { colors: false, depth: null }));
		}
		return result.ok ? 0 : 1;
	}

	console.error("tool-runner action must be sim, lint, synth, or himasim");
	return 1;
}

function smokeOption(args: string[]): BoardSmokeKind {
	const value = optionValue(args, "--smoke") ?? positionalArgs(args)[0] ?? "blink_led";
	if (value === "blink_led" || value === "uart_loopback") return value;
	throw new Error("board-smoke --smoke must be blink_led or uart_loopback");
}

async function runBoardSmoke(args: string[]): Promise<number> {
	const result = runMockBoardBringup({ smoke: smokeOption(args) });
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(renderMockBoardBringupReport(result));
	}
	return result.ok ? 0 : 1;
}

function templateOption(args: string[]): HardwareFlowTemplateId {
	const value = optionValue(args, "--template") ?? positionalArgs(args)[0] ?? "blink_led";
	if (value === "blink_led" || value === "uart_loopback") return value;
	throw new Error("hardware-flow --template must be blink_led or uart_loopback");
}

async function runHardwareFlow(args: string[]): Promise<number> {
	const result = await runDryRunHardwareFlow({ template: templateOption(args) });
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(renderDryRunHardwareFlowReport(result));
	}
	return result.ok ? 0 : 1;
}

async function runReleaseSmoke(args: string[]): Promise<number> {
	if (hasFlag(args, "--pack-install-plan")) {
		const result = createReleasePackInstallSmokePlan({
			repoRoot: process.cwd(),
			packDestination: optionValue(args, "--pack-destination"),
			installPrefix: optionValue(args, "--install-prefix"),
			cacheDir: optionValue(args, "--cache-dir"),
		});
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(renderReleasePackInstallSmokePlan(result));
		}
		return 0;
	}
	if (hasFlag(args, "--verify-local")) {
		const result = verifyLocalReleaseSmoke({ repoRoot: process.cwd() });
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(renderReleaseSmokeVerificationReport(result));
		}
		return result.status === "blocked" ? 1 : 0;
	}
	if (hasFlag(args, "--verify-dist")) {
		const result = verifyDistReleaseSmoke();
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(renderReleaseSmokeVerificationReport(result));
		}
		return result.status === "blocked" ? 1 : 0;
	}
	const result = createReleaseEngineeringReport();
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(renderReleaseEngineeringReport(result));
	}
	return 0;
}

function suiteOption(args: string[]): EvaluationSuiteId {
	const value = optionValue(args, "--suite") ?? positionalArgs(args)[0] ?? "smoke";
	if (value === "smoke" || value === "roadmap") return value;
	throw new Error("eval-suite --suite must be smoke or roadmap");
}

async function runEvalSuite(args: string[]): Promise<number> {
	const result = await runEvaluationSuite(suiteOption(args));
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(renderEvaluationSuiteReport(result));
	}
	return result.metrics.passed === result.metrics.total ? 0 : 1;
}

function workbenchLayoutPatchOption(args: string[]): WorkbenchLayoutPatch {
	const patch: WorkbenchLayoutPatch = {};
	const focus = optionValue(args, "--focus");
	if (focus) {
		if (!isWorkbenchFocusPane(focus)) throw new Error("--focus must be left, center, or right");
		patch.focus = focus;
	}
	const inspector = optionValue(args, "--inspector");
	if (inspector) {
		if (!isWorkbenchPaneId(inspector)) throw new Error("--inspector must be a known workbench pane id");
		patch.selectedInspector = inspector;
	}
	const density = optionValue(args, "--density");
	if (density) {
		if (!isWorkbenchDensity(density)) throw new Error("--density must be compact or comfortable");
		patch.density = density;
	}
	return patch;
}

function workbenchActionsOption(args: string[]): WorkbenchInteractionAction[] {
	const value = optionValue(args, "--action");
	if (!value) return [];
	const actions: WorkbenchInteractionAction[] = [];
	for (const action of value.split(",")) {
		const trimmed = action.trim();
		if (!trimmed) continue;
		if (!isWorkbenchInteractionAction(trimmed)) {
			throw new Error("--action contains an unknown product workbench action");
		}
		actions.push(trimmed);
	}
	return actions;
}

function configureProductWorkbenchModel(model: ProductWorkbenchModel, args: string[]): ProductWorkbenchModel {
	let current = model;
	const layoutJson = optionValue(args, "--layout-json");
	if (layoutJson) current = restoreWorkbenchLayout(current, layoutJson);
	current = applyProductWorkbenchLayoutPatch(current, workbenchLayoutPatchOption(args));
	return applyProductWorkbenchActions(current, workbenchActionsOption(args));
}

function writeTextArtifact(filePath: string, content: string): string {
	const resolved = resolve(filePath);
	mkdirSync(dirname(resolved), { recursive: true });
	writeFileSync(resolved, content, "utf8");
	return resolved;
}

function productTemplateOption(args: string[]): ProductTemplateId {
	const value = optionValue(args, "--id") ?? positionalArgs(args)[0] ?? "counter";
	if (!isProductTemplateId(value)) {
		throw new Error("product-template --id must be counter, fsm, uart_loopback, or i2c_skeleton");
	}
	return value;
}

function writeTemplateArtifact(outputDir: string, templateId: ProductTemplateId): string[] {
	const artifact = createProductTemplateArtifact(templateId);
	const root = resolve(outputDir);
	const written: string[] = [];
	for (const file of artifact.files) {
		const destination = join(root, file.path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, file.content, "utf8");
		written.push(destination);
	}
	return written;
}

async function runProductPreview(args: string[]): Promise<number> {
	const release = createReleaseEngineeringReport();
	const doctor = hasFlag(args, "--with-smoke")
		? await doctorVerigenInstall({ bootstrap: !hasFlag(args, "--no-bootstrap") })
		: undefined;
	const evaluation = hasFlag(args, "--with-smoke") ? await runEvaluationSuite("smoke") : undefined;
	const hardwareFlow = hasFlag(args, "--with-smoke")
		? await runDryRunHardwareFlow({ template: "blink_led" })
		: undefined;
	const model = configureProductWorkbenchModel(
		createProductWorkbenchModel({ doctor, evaluation, hardwareFlow, release }),
		args,
	);
	const width = numberOption(args, "--width") ?? process.stdout.columns ?? 120;
	const height = numberOption(args, "--height") ?? 36;
	if (hasFlag(args, "--show-layout")) {
		console.log(serializeWorkbenchLayout(model.layout));
		return 0;
	}
	if (hasFlag(args, "--provider-page")) {
		console.log(renderProviderConfigPage(model.providerConfigPage));
		return 0;
	}
	if (hasFlag(args, "--profiles")) {
		console.log(renderBoardProfileManagement(model.boardProfileManagement));
		return 0;
	}
	if (hasFlag(args, "--interactive")) {
		await runProductWorkbenchTui(model, { width, height });
		return 0;
	}
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(model, null, 2));
	} else if (hasFlag(args, "--report")) {
		const outputPath = optionValue(args, "--output");
		if (outputPath) {
			const artifact = createProductReportArtifact(model, outputPath);
			const resolved = writeTextArtifact(artifact.fileName, artifact.content);
			console.log(`Wrote ${artifact.contentType} report: ${resolved}`);
		} else {
			console.log(exportProductReportMarkdown(model));
		}
	} else if (hasFlag(args, "--tui")) {
		if (process.stdin.isTTY && process.stdout.isTTY) {
			await runProductWorkbenchTui(model, { width, height });
			return 0;
		}
		console.log(renderProductWorkbenchTui(model, width, height));
	} else {
		console.log(renderProductWorkbenchPreview(model));
	}
	return model.status === "blocked" ? 1 : 0;
}

async function runProductTemplate(args: string[]): Promise<number> {
	const templateId = productTemplateOption(args);
	const artifact = createProductTemplateArtifact(templateId);
	const output = optionValue(args, "--output");
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(artifact, null, 2));
		return 0;
	}
	if (!output) {
		console.error("product-template requires --output DIR unless --json is used");
		return 1;
	}
	const files = writeTemplateArtifact(output, templateId);
	console.log(`Wrote product template ${templateId}: ${resolve(output)}`);
	for (const file of files) console.log(`- ${file}`);
	return 0;
}

async function runProductWorkbench(args: string[]): Promise<number> {
	const release = createReleaseEngineeringReport();
	const doctor = hasFlag(args, "--with-smoke")
		? await doctorVerigenInstall({ bootstrap: !hasFlag(args, "--no-bootstrap") })
		: undefined;
	const evaluation = hasFlag(args, "--with-smoke") ? await runEvaluationSuite("smoke") : undefined;
	const hardwareFlow = hasFlag(args, "--with-smoke")
		? await runDryRunHardwareFlow({ template: "blink_led" })
		: undefined;
	const model = configureProductWorkbenchModel(
		createProductWorkbenchModel({ doctor, evaluation, hardwareFlow, release }),
		args,
	);
	await runProductWorkbenchTui(model, {
		width: numberOption(args, "--width"),
		height: numberOption(args, "--height"),
	});
	return 0;
}

async function runTuiPreview(args: string[]): Promise<number> {
	const positional = positionalArgs(args);
	const view = positional[0] ?? "trace-demo";
	const width = numberOption(args, "--width") ?? process.stdout.columns ?? 100;

	if (view === "trace-demo" || view === "trace") {
		const result = await runBuiltInTraceDemo({
			keepTempDir: hasFlag(args, "--keep-temp"),
			workerOptions: { bootstrap: !hasFlag(args, "--no-bootstrap") },
		});
		const model = createTraceTuiPreview(result.panel);
		if (hasFlag(args, "--json")) {
			console.log(
				JSON.stringify({ ok: true, model, lines: renderVerigenTuiPreview(model, width).split("\n") }, null, 2),
			);
		} else {
			console.log(renderVerigenTuiPreview(model, width));
		}
		return 0;
	}

	if (view === "quality-probe" || view === "probe") {
		const caseId = optionValue(args, "--case") ?? positional[1] ?? "l0-mux2";
		const result = await runCodegenQualityProbeCase(caseId, {
			live: hasFlag(args, "--live"),
			runTools: hasFlag(args, "--run-tools"),
			repoRoot: process.cwd(),
			baseUrl: optionValue(args, "--base-url"),
			model: optionValue(args, "--model"),
			maxTokens: numberOption(args, "--max-tokens"),
		});
		const model = createQualityProbeTuiPreview(result);
		if (hasFlag(args, "--json")) {
			console.log(
				JSON.stringify({ ok: true, model, lines: renderVerigenTuiPreview(model, width).split("\n") }, null, 2),
			);
		} else {
			console.log(renderVerigenTuiPreview(model, width));
		}
		return 0;
	}

	console.error("tui-preview view must be trace-demo or quality-probe");
	return 1;
}

async function runGraphifyStatus(args: string[]): Promise<number> {
	const status = await new GraphifyContext({ repoRoot: process.cwd() }).status();
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(status, null, 2));
	} else {
		console.log(inspect(status, { colors: false, depth: null }));
	}
	return status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyQuery(args: string[]): Promise<number> {
	const query = positionalArgs(args).join(" ");
	if (!query) {
		console.error("graphify-query requires a query string");
		return 1;
	}
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).query(
		query,
		numberOption(args, "--max-results"),
	);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyExplain(args: string[]): Promise<number> {
	const [idOrPath] = positionalArgs(args);
	if (!idOrPath) {
		console.error("graphify-explain requires a node id or path");
		return 1;
	}
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).explain(
		idOrPath,
		numberOption(args, "--max-results"),
	);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyPath(args: string[]): Promise<number> {
	const [source, target] = positionalArgs(args);
	if (!source || !target) {
		console.error("graphify-path requires source and target node ids or paths");
		return 1;
	}
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).path(
		source,
		target,
		numberOption(args, "--max-depth"),
	);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyUpdate(args: string[]): Promise<number> {
	const [target] = positionalArgs(args);
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).update(target);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.ok ? 0 : 1;
}

async function runDefault(): Promise<number> {
	if (process.stdin.isTTY && process.stdout.isTTY) {
		return await runAgent([]);
	}
	printHelp();
	return 0;
}

async function main(args: string[]): Promise<number> {
	if (args[0] === "--version" || args[0] === "-v") {
		printVersion();
		return 0;
	}
	if (args[0] === "--help" || args[0] === "-h" || hasFlag(args, "--help")) {
		printHelp();
		return 0;
	}
	if (args.length === 0) return await runDefault();
	const command = args[0] ?? "";
	if (command.startsWith("-")) return await runAgent(args);
	if (command === "agent") return await runAgent(args.slice(1));
	if (command === "mode") return await runMode(args.slice(1));
	if (command === "doctor") return await runDoctor(args.slice(1));
	if (command === "native-tools") return await runNativeTools(args.slice(1));
	if (command === "python-bootstrap") return await runPythonBootstrap(args.slice(1));
	if (command === "worker-smoke") return await runWorkerSmoke(args.slice(1));
	if (command === "trace-demo") return await runTraceDemo(args.slice(1));
	if (command === "trace-panel") return await runTracePanel(args.slice(1));
	if (command === "tui-preview") return await runTuiPreview(args.slice(1));
	if (command === "tool-runner") return await runToolRunner(args.slice(1));
	if (command === "quality-probe") return await runQualityProbe(args.slice(1));
	if (command === "board-smoke") return await runBoardSmoke(args.slice(1));
	if (command === "hardware-flow") return await runHardwareFlow(args.slice(1));
	if (command === "release-smoke") return await runReleaseSmoke(args.slice(1));
	if (command === "eval-suite") return await runEvalSuite(args.slice(1));
	if (command === "product-preview") return await runProductPreview(args.slice(1));
	if (command === "product-workbench") return await runProductWorkbench(args.slice(1));
	if (command === "product-template") return await runProductTemplate(args.slice(1));
	if (command === "graphify-status") return await runGraphifyStatus(args.slice(1));
	if (command === "graphify-query") return await runGraphifyQuery(args.slice(1));
	if (command === "graphify-explain") return await runGraphifyExplain(args.slice(1));
	if (command === "graphify-path") return await runGraphifyPath(args.slice(1));
	if (command === "graphify-update") return await runGraphifyUpdate(args.slice(1));
	console.error(`Unknown command: ${command}`);
	printHelp();
	return 1;
}

main(process.argv.slice(2))
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
