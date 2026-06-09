import type { VerigenDoctorResult } from "./python-worker-bootstrap.ts";
import { type BoardProfile, createDefaultMockBoardProfile, createUartLoopbackDesign } from "./s9-board-profile.ts";
import type { DryRunHardwareFlowReport } from "./s10-hardware-flow.ts";
import { createReleaseEngineeringReport, type ReleaseEngineeringReport } from "./s11-release-engineering.ts";
import type { EvaluationSuiteReport } from "./s12-evaluation.ts";

export type WorkbenchPaneId =
	| "chat"
	| "task-log"
	| "rtl-diff"
	| "sim-log"
	| "trace-report"
	| "waveform"
	| "kg"
	| "graphify"
	| "tool-log"
	| "board-report";

export type ProductTemplateId = "counter" | "fsm" | "uart_loopback" | "i2c_skeleton";
export type WorkbenchDensity = "compact" | "comfortable";

export interface ProviderConfig {
	provider: "anthropic";
	baseUrl: string;
	model: string;
	apiKeyEnvVar: string;
}

export interface ProviderConfigField {
	label: string;
	value: string;
	secret: boolean;
}

export interface ProviderConfigPage {
	status: "configured" | "needs_key";
	fields: ProviderConfigField[];
	setupAction: string;
}

export interface ProductTemplate {
	id: ProductTemplateId;
	title: string;
	description: string;
	command: string;
}

export interface ProductTemplateFile {
	path: string;
	content: string;
}

export interface ProductTemplateArtifact {
	id: ProductTemplateId;
	title: string;
	description: string;
	topModule: string;
	entryCommand: string;
	files: ProductTemplateFile[];
}

export interface OnboardingStep {
	id: string;
	title: string;
	status: "done" | "pending" | "blocked";
	action: string;
}

export interface WorkbenchTaskLogEntry {
	time: string;
	stage: string;
	message: string;
}

export interface WorkbenchInspectorTab {
	id: WorkbenchPaneId;
	title: string;
	badge: string;
	content: string;
}

export interface DoctorRepairSuggestion {
	checkName: string;
	severity: "required" | "optional";
	message: string;
	suggestedAction: string;
	command: string;
}

export interface BoardProfileManagement {
	selectedProfileId: string;
	profiles: Array<{
		id: string;
		fpgaPart: string;
		programmer: string;
		clockHz: number;
		resetSignal: string;
	}>;
	actions: string[];
}

export type WorkbenchFocusPane = "left" | "center" | "right";

export interface WorkbenchLayoutState {
	leftPane: "pipeline";
	centerPane: "task-log";
	rightPane: "inspector";
	selectedInspector: WorkbenchPaneId;
	density: WorkbenchDensity;
	focus: WorkbenchFocusPane;
}

export interface WorkbenchKeybinding {
	key: string;
	action: WorkbenchInteractionAction;
	description: string;
}

export type WorkbenchInteractionAction =
	| "next-inspector"
	| "previous-inspector"
	| "focus-left"
	| "focus-center"
	| "focus-right"
	| "toggle-density"
	| "open-selected"
	| "rerun"
	| "export-report";

export interface WorkbenchLayoutPatch {
	selectedInspector?: WorkbenchPaneId;
	density?: WorkbenchDensity;
	focus?: WorkbenchFocusPane;
}

const workbenchPaneIds: readonly WorkbenchPaneId[] = [
	"chat",
	"task-log",
	"rtl-diff",
	"sim-log",
	"trace-report",
	"waveform",
	"kg",
	"graphify",
	"tool-log",
	"board-report",
];

const workbenchDensities: readonly WorkbenchDensity[] = ["compact", "comfortable"];
const workbenchFocusPanes: readonly WorkbenchFocusPane[] = ["left", "center", "right"];
const productTemplateIds: readonly ProductTemplateId[] = ["counter", "fsm", "uart_loopback", "i2c_skeleton"];
const workbenchInteractionActions: readonly WorkbenchInteractionAction[] = [
	"next-inspector",
	"previous-inspector",
	"focus-left",
	"focus-center",
	"focus-right",
	"toggle-density",
	"open-selected",
	"rerun",
	"export-report",
];

export function isWorkbenchPaneId(value: string): value is WorkbenchPaneId {
	return workbenchPaneIds.includes(value as WorkbenchPaneId);
}

export function isWorkbenchDensity(value: string): value is WorkbenchDensity {
	return workbenchDensities.includes(value as WorkbenchDensity);
}

export function isWorkbenchFocusPane(value: string): value is WorkbenchFocusPane {
	return workbenchFocusPanes.includes(value as WorkbenchFocusPane);
}

export function isWorkbenchInteractionAction(value: string): value is WorkbenchInteractionAction {
	return workbenchInteractionActions.includes(value as WorkbenchInteractionAction);
}

export function isProductTemplateId(value: string): value is ProductTemplateId {
	return productTemplateIds.includes(value as ProductTemplateId);
}

export interface SessionReplayEvent {
	index: number;
	stage: string;
	action: string;
	summary: string;
}

export interface ProductWorkbenchModel {
	title: string;
	status: "ready" | "needs_setup" | "blocked";
	provider: ProviderConfig;
	providerConfigPage: ProviderConfigPage;
	boardProfiles: BoardProfile[];
	boardProfileManagement: BoardProfileManagement;
	templates: ProductTemplate[];
	onboarding: OnboardingStep[];
	doctorRepairSuggestions: DoctorRepairSuggestion[];
	pipelineNavigator: string[];
	taskLog: WorkbenchTaskLogEntry[];
	inspectorTabs: WorkbenchInspectorTab[];
	layout: WorkbenchLayoutState;
	keybindings: WorkbenchKeybinding[];
	sessionReplay: SessionReplayEvent[];
	release: ReleaseEngineeringReport;
}

export interface ProductReportArtifact {
	fileName: string;
	contentType: "text/markdown";
	content: string;
	description: string;
}

export interface ProductWorkbenchOptions {
	doctor?: VerigenDoctorResult;
	evaluation?: EvaluationSuiteReport;
	hardwareFlow?: DryRunHardwareFlowReport;
	release?: ReleaseEngineeringReport;
	now?: string;
	env?: Record<string, string | undefined>;
}

function providerConfig(): ProviderConfig {
	return {
		provider: "anthropic",
		baseUrl: "http://172.18.5.179:3000",
		model: "kimi-for-coding",
		apiKeyEnvVar: "VERIGEN_TEST_LLM_API_KEY",
	};
}

function providerConfigPage(provider: ProviderConfig, env: Record<string, string | undefined>): ProviderConfigPage {
	const hasKey = Boolean(env[provider.apiKeyEnvVar]);
	return {
		status: hasKey ? "configured" : "needs_key",
		fields: [
			{ label: "provider", value: provider.provider, secret: false },
			{ label: "baseUrl", value: provider.baseUrl, secret: false },
			{ label: "model", value: provider.model, secret: false },
			{ label: "apiKeyEnvVar", value: provider.apiKeyEnvVar, secret: false },
			{ label: "apiKey", value: hasKey ? "<set>" : "<missing>", secret: true },
		],
		setupAction: `export ${provider.apiKeyEnvVar}=<local-secret>`,
	};
}

function repairCommandForCheck(check: VerigenDoctorResult["checks"][number]): string {
	if (typeof check.details?.repair === "string") return check.details.repair;
	if (check.name === "uv") return "Install uv from https://docs.astral.sh/uv/";
	if (check.name === "iverilog" || check.name === "vvp")
		return "Install Icarus Verilog and make iverilog/vvp available on PATH.";
	if (check.name === "python-worker")
		return "Reinstall verigen or run from a package that includes dist/python/verilog-analysis.";
	if (check.name === "worker-venv") return "Run verigen doctor to recreate the managed Python worker venv.";
	if (check.name === "graphify-index") return "Run verigen graphify-update from the repository root.";
	if (check.name === "node") return "Use Node >=22.19.0.";
	return "Review the check output and rerun verigen doctor.";
}

function doctorRepairSuggestions(doctor: VerigenDoctorResult | undefined): DoctorRepairSuggestion[] {
	if (!doctor) {
		return [
			{
				checkName: "doctor",
				severity: "required",
				message: "Environment doctor has not run.",
				suggestedAction: "Run the environment doctor before an internal demo.",
				command: "verigen doctor --json",
			},
		];
	}
	return doctor.checks
		.filter((check) => check.state !== "ok")
		.map((check) => ({
			checkName: check.name,
			severity: check.required ? "required" : "optional",
			message: check.message,
			suggestedAction: repairCommandForCheck(check),
			command: check.name === "graphify-index" ? "verigen graphify-update" : "verigen doctor --json",
		}));
}

function boardProfileManagement(profiles: BoardProfile[]): BoardProfileManagement {
	const selected = profiles[0];
	return {
		selectedProfileId: selected?.id ?? "none",
		profiles: profiles.map((profile) => ({
			id: profile.id,
			fpgaPart: profile.fpgaPart,
			programmer: profile.programmer.kind,
			clockHz: profile.clock.frequencyHz,
			resetSignal: profile.reset.name,
		})),
		actions: [
			"verigen board-smoke --smoke blink_led",
			"verigen board-smoke --smoke uart_loopback",
			"verigen hardware-flow --template blink_led",
		],
	};
}

function templates(): ProductTemplate[] {
	return [
		{
			id: "counter",
			title: "Enabled counter",
			description: "Sequential RTL with reset and enable.",
			command: "verigen quality-probe fix-loop --case l1-counter",
		},
		{
			id: "fsm",
			title: "Simple FSM",
			description: "FSM evaluation template for S12 expansion.",
			command: "verigen eval-suite --suite roadmap",
		},
		{
			id: "uart_loopback",
			title: "UART loopback",
			description: "Dry-run hardware flow template.",
			command: "verigen hardware-flow --template uart_loopback",
		},
		{
			id: "i2c_skeleton",
			title: "I2C skeleton",
			description: "Interface skeleton placeholder for L3 tasks.",
			command: "verigen eval-suite --suite roadmap",
		},
	];
}

function counterRtl(): string {
	return `module counter8_en(
  input wire clk,
  input wire rst,
  input wire en,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (rst) begin
      q <= 8'd0;
    end else if (en) begin
      q <= q + 8'd1;
    end
  end
endmodule
`;
}

function counterTestbench(): string {
	return `module tb;
  reg clk = 0;
  reg rst = 1;
  reg en = 0;
  wire [7:0] q;

  counter8_en dut (.clk(clk), .rst(rst), .en(en), .q(q));
  always #1 clk = ~clk;

  initial begin
    repeat (2) @(posedge clk);
    rst = 0;
    en = 1;
    repeat (4) @(posedge clk);
    if (q !== 8'd4) begin
      $display("VERIGEN_SIM_FAIL counter8_en q=%0d", q);
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS counter8_en");
    $finish;
  end
endmodule
`;
}

function fsmRtl(): string {
	return `module sequence_detector(
  input wire clk,
  input wire rst,
  input wire din,
  output reg seen
);
  localparam S0 = 2'd0;
  localparam S1 = 2'd1;
  localparam S10 = 2'd2;
  reg [1:0] state;

  always @(posedge clk) begin
    if (rst) begin
      state <= S0;
      seen <= 1'b0;
    end else begin
      seen <= 1'b0;
      case (state)
        S0: state <= din ? S1 : S0;
        S1: state <= din ? S1 : S10;
        S10: begin
          seen <= din;
          state <= din ? S1 : S0;
        end
        default: state <= S0;
      endcase
    end
  end
endmodule
`;
}

function fsmTestbench(): string {
	return `module tb;
  reg clk = 0;
  reg rst = 1;
  reg din = 0;
  wire seen;

  sequence_detector dut (.clk(clk), .rst(rst), .din(din), .seen(seen));
  always #1 clk = ~clk;

  task push;
    input value;
    begin
      din = value;
      @(posedge clk); #1;
    end
  endtask

  initial begin
    repeat (2) @(posedge clk);
    rst = 0;
    push(1'b1);
    push(1'b0);
    push(1'b1);
    if (seen !== 1'b1) begin
      $display("VERIGEN_SIM_FAIL sequence_detector");
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS sequence_detector");
    $finish;
  end
endmodule
`;
}

function i2cSkeletonRtl(): string {
	return `module i2c_master_skeleton(
  input wire clk,
  input wire rst,
  input wire start,
  output reg busy,
  output reg scl,
  inout wire sda
);
  assign sda = 1'bz;

  always @(posedge clk) begin
    if (rst) begin
      busy <= 1'b0;
      scl <= 1'b1;
    end else if (start) begin
      busy <= 1'b1;
      scl <= 1'b0;
    end else begin
      busy <= 1'b0;
      scl <= 1'b1;
    end
  end
endmodule
`;
}

function i2cSkeletonTestbench(): string {
	return `module tb;
  reg clk = 0;
  reg rst = 1;
  reg start = 0;
  wire busy;
  wire scl;
  wire sda;

  i2c_master_skeleton dut (.clk(clk), .rst(rst), .start(start), .busy(busy), .scl(scl), .sda(sda));
  always #1 clk = ~clk;

  initial begin
    repeat (2) @(posedge clk);
    rst = 0;
    start = 1;
    @(posedge clk); #1;
    if (busy !== 1'b1 || scl !== 1'b0) begin
      $display("VERIGEN_SIM_FAIL i2c_master_skeleton");
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS i2c_master_skeleton");
    $finish;
  end
endmodule
`;
}

function templateRtlAndTb(id: ProductTemplateId): { topModule: string; rtl: string; testbench: string } {
	if (id === "counter") return { topModule: "counter8_en", rtl: counterRtl(), testbench: counterTestbench() };
	if (id === "fsm") return { topModule: "sequence_detector", rtl: fsmRtl(), testbench: fsmTestbench() };
	if (id === "uart_loopback") {
		return {
			topModule: "uart_loopback",
			rtl: createUartLoopbackDesign().rtl,
			testbench: `module tb;
  reg clk = 0;
  reg rst = 1;
  reg uart_rx = 1;
  wire uart_tx;

  uart_loopback dut (.clk(clk), .rst(rst), .uart_rx(uart_rx), .uart_tx(uart_tx));
  always #1 clk = ~clk;

  initial begin
    #1;
    rst = 0;
    uart_rx = 0;
    #1;
    if (uart_tx !== 1'b0) begin
      $display("VERIGEN_SIM_FAIL uart_loopback");
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS uart_loopback");
    $finish;
  end
endmodule
`,
		};
	}
	return { topModule: "i2c_master_skeleton", rtl: i2cSkeletonRtl(), testbench: i2cSkeletonTestbench() };
}

function templateReadme(template: ProductTemplate, topModule: string): string {
	return [
		`# ${template.title}`,
		"",
		template.description,
		"",
		`Top module: \`${topModule}\``,
		"",
		"## Smoke",
		"",
		"```bash",
		template.command,
		"```",
		"",
		"## Files",
		"",
		`- \`rtl/${topModule}.v\``,
		`- \`tb/${topModule}_tb.v\``,
		"- `verigen.json`",
	].join("\n");
}

export function createProductTemplateArtifact(id: ProductTemplateId): ProductTemplateArtifact {
	const template = templates().find((entry) => entry.id === id);
	if (!template) throw new Error(`Unknown product template: ${id}`);
	const design = templateRtlAndTb(id);
	const manifest = {
		id,
		title: template.title,
		topModule: design.topModule,
		entryCommand: template.command,
		boardProfile: id === "uart_loopback" ? "mock-devboard" : "none",
	};
	return {
		id,
		title: template.title,
		description: template.description,
		topModule: design.topModule,
		entryCommand: template.command,
		files: [
			{ path: "README.md", content: templateReadme(template, design.topModule) },
			{ path: `rtl/${design.topModule}.v`, content: design.rtl },
			{ path: `tb/${design.topModule}_tb.v`, content: design.testbench },
			{ path: "verigen.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
		],
	};
}

function doctorStep(doctor: VerigenDoctorResult | undefined): OnboardingStep {
	if (!doctor) {
		return { id: "doctor", title: "Environment doctor", status: "pending", action: "verigen doctor" };
	}
	return {
		id: "doctor",
		title: "Environment doctor",
		status: doctor.ok ? "done" : "blocked",
		action: "verigen doctor --json",
	};
}

function onboardingSteps(options: ProductWorkbenchOptions): OnboardingStep[] {
	const provider = providerConfig();
	const providerPage = providerConfigPage(provider, options.env ?? process.env);
	return [
		doctorStep(options.doctor),
		{
			id: "provider",
			title: "Provider config",
			status: providerPage.status === "configured" ? "done" : "pending",
			action: providerPage.setupAction,
		},
		{
			id: "project",
			title: "Create project from template",
			status: "done",
			action: "verigen hardware-flow --template blink_led",
		},
		{
			id: "report",
			title: "Export report",
			status: "done",
			action: "verigen product-preview --json",
		},
	];
}

function pipelineNavigator(): string[] {
	return ["spec", "plan", "rtl", "sim", "trace", "fix", "report", "board-dry-run", "evaluation", "release"];
}

function layoutState(): WorkbenchLayoutState {
	return {
		leftPane: "pipeline",
		centerPane: "task-log",
		rightPane: "inspector",
		selectedInspector: "trace-report",
		density: "compact",
		focus: "right",
	};
}

function keybindings(): WorkbenchKeybinding[] {
	return [
		{ key: "tab", action: "next-inspector", description: "Switch inspector tab" },
		{ key: "shift+tab", action: "previous-inspector", description: "Switch inspector tab backward" },
		{ key: "left", action: "focus-left", description: "Focus pipeline pane" },
		{ key: "up", action: "focus-center", description: "Focus task log pane" },
		{ key: "right", action: "focus-right", description: "Focus inspector pane" },
		{ key: "space", action: "toggle-density", description: "Toggle compact or comfortable density" },
		{ key: "enter", action: "open-selected", description: "Open selected item" },
		{ key: "r", action: "rerun", description: "Rerun current flow" },
		{ key: "e", action: "export-report", description: "Export product report" },
	];
}

function taskLog(options: ProductWorkbenchOptions): WorkbenchTaskLogEntry[] {
	const time = options.now ?? "2026-06-09T00:00:00.000Z";
	return [
		{ time, stage: "doctor", message: options.doctor?.ok ? "environment ready" : "environment check pending" },
		{
			time,
			stage: "evaluation",
			message: options.evaluation ? "evaluation metrics available" : "evaluation pending",
		},
		{
			time,
			stage: "hardware",
			message: options.hardwareFlow?.ok ? "dry-run hardware flow passed" : "hardware flow pending",
		},
		{ time, stage: "release", message: "release smoke checklist generated" },
	];
}

function inspectorTabs(options: ProductWorkbenchOptions): WorkbenchInspectorTab[] {
	const evaluation = options.evaluation
		? `pass@1=${options.evaluation.metrics.passAt1Rate.toFixed(2)} convergence=${options.evaluation.metrics.convergenceRate.toFixed(2)}`
		: "evaluation not run";
	const hardware = options.hardwareFlow
		? `${options.hardwareFlow.template}: ${options.hardwareFlow.ok ? "pass" : "fail"}`
		: "hardware flow not run";
	const repairs = doctorRepairSuggestions(options.doctor);
	const providerPage = providerConfigPage(providerConfig(), options.env ?? process.env);
	return [
		{ id: "task-log", title: "Task Log", badge: "live", content: "Pipeline events and agent decisions." },
		{ id: "rtl-diff", title: "RTL Diff", badge: "ready", content: "Contract-preserving RTL changes." },
		{
			id: "sim-log",
			title: "Sim Log",
			badge: "ready",
			content: "Compile/sim stdout, stderr, and structured issues.",
		},
		{
			id: "trace-report",
			title: "Trace Report",
			badge: "ready",
			content: "Mismatch, controllers, snippets, and repair hints.",
		},
		{ id: "waveform", title: "Waveform", badge: "preview", content: "Compressed waveform table preview." },
		{ id: "kg", title: "KG", badge: "ready", content: "Spec-anchored module, port, constraint graph." },
		{ id: "graphify", title: "Graphify", badge: "ready", content: "Repo/document context nodes selected by router." },
		{ id: "tool-log", title: "Tool Log", badge: "ready", content: evaluation },
		{ id: "board-report", title: "Board", badge: "dry-run", content: hardware },
		{
			id: "chat",
			title: "Setup",
			badge: providerPage.status,
			content: `provider=${providerPage.status} repairs=${repairs.length}`,
		},
	];
}

function replay(options: ProductWorkbenchOptions): SessionReplayEvent[] {
	const events = [
		{ stage: "onboarding", action: "doctor", summary: options.doctor?.ok ? "doctor passed" : "doctor pending" },
		{ stage: "template", action: "select", summary: "selected blink_led dry-run template" },
		{
			stage: "sim",
			action: "run",
			summary: options.hardwareFlow?.simResult.ok ? "simulation passed" : "simulation pending",
		},
		{
			stage: "board",
			action: "dry-run",
			summary: options.hardwareFlow?.boardReport.ok ? "mock board passed" : "board pending",
		},
		{ stage: "report", action: "export", summary: "product report generated" },
	];
	return events.map((event, index) => ({ index: index + 1, ...event }));
}

export function createProductWorkbenchModel(options: ProductWorkbenchOptions = {}): ProductWorkbenchModel {
	const release = options.release ?? createReleaseEngineeringReport();
	const onboarding = onboardingSteps(options);
	const blocked = onboarding.some((step) => step.status === "blocked");
	const needsSetup = onboarding.some((step) => step.status === "pending");
	const provider = providerConfig();
	const boardProfiles = [createDefaultMockBoardProfile()];
	return {
		title: "VeriGen Product Workbench",
		status: blocked ? "blocked" : needsSetup ? "needs_setup" : "ready",
		provider,
		providerConfigPage: providerConfigPage(provider, options.env ?? process.env),
		boardProfiles,
		boardProfileManagement: boardProfileManagement(boardProfiles),
		templates: templates(),
		onboarding,
		doctorRepairSuggestions: doctorRepairSuggestions(options.doctor),
		pipelineNavigator: pipelineNavigator(),
		taskLog: taskLog(options),
		inspectorTabs: inspectorTabs(options),
		layout: layoutState(),
		keybindings: keybindings(),
		sessionReplay: replay(options),
		release,
	};
}

export function renderProductWorkbenchPreview(model: ProductWorkbenchModel): string {
	return [
		model.title,
		`Status: ${model.status}`,
		`Provider: ${model.provider.provider} ${model.provider.model} ${model.provider.baseUrl}`,
		"",
		"Pipeline",
		model.pipelineNavigator.map((stage) => `[${stage}]`).join(" -> "),
		"",
		"Onboarding",
		...model.onboarding.map((step) => `- ${step.status} ${step.title}: ${step.action}`),
		"",
		"Inspector tabs",
		...model.inspectorTabs.map((tab) => `- ${tab.title} (${tab.badge}): ${tab.content}`),
		"",
		"Provider config",
		...model.providerConfigPage.fields.map((field) => `- ${field.label}: ${field.value}`),
		"",
		"Board profiles",
		...model.boardProfileManagement.profiles.map((profile) => `- ${profile.id}: ${profile.fpgaPart}`),
		"",
		"Doctor repair suggestions",
		...(model.doctorRepairSuggestions.length > 0
			? model.doctorRepairSuggestions.map(
					(suggestion) => `- ${suggestion.severity} ${suggestion.checkName}: ${suggestion.command}`,
				)
			: ["- none"]),
		"",
		"Session replay",
		...model.sessionReplay.map((event) => `- #${event.index} ${event.stage}/${event.action}: ${event.summary}`),
	].join("\n");
}

export function renderProviderConfigPage(page: ProviderConfigPage): string {
	return [
		`Provider config: ${page.status}`,
		...page.fields.map((field) => `- ${field.label}: ${field.value}`),
		`Setup: ${page.setupAction}`,
	].join("\n");
}

export function renderBoardProfileManagement(management: BoardProfileManagement): string {
	return [
		`Selected board profile: ${management.selectedProfileId}`,
		"Profiles",
		...management.profiles.map(
			(profile) =>
				`- ${profile.id}: ${profile.fpgaPart}, programmer=${profile.programmer}, clock=${profile.clockHz}, reset=${profile.resetSignal}`,
		),
		"Actions",
		...management.actions.map((action) => `- ${action}`),
	].join("\n");
}

export function exportProductReportMarkdown(model: ProductWorkbenchModel): string {
	const selectedInspector = activeInspector(model);
	return [
		`# ${model.title} Report`,
		"",
		`Status: ${model.status}`,
		`Provider: ${model.provider.provider} / ${model.provider.model}`,
		`Provider endpoint: ${model.provider.baseUrl}`,
		`API key env: ${model.provider.apiKeyEnvVar}`,
		"",
		"## Onboarding",
		...model.onboarding.map((step) => `- ${step.status}: ${step.title} (${step.action})`),
		"",
		"## Provider Config",
		`- status: ${model.providerConfigPage.status}`,
		...model.providerConfigPage.fields.map((field) => `- ${field.label}: ${field.value}`),
		`- setup: ${model.providerConfigPage.setupAction}`,
		"",
		"## Workbench Layout",
		`- focus: ${model.layout.focus}`,
		`- selected inspector: ${model.layout.selectedInspector}`,
		`- density: ${model.layout.density}`,
		`- serialized: ${serializeWorkbenchLayout(model.layout)}`,
		"",
		"## Templates",
		...model.templates.map((template) => `- ${template.id}: ${template.command}`),
		"",
		"## Board Profiles",
		...model.boardProfileManagement.profiles.map(
			(profile) =>
				`- ${profile.id}: ${profile.fpgaPart}, programmer=${profile.programmer}, clock=${profile.clockHz}, reset=${profile.resetSignal}`,
		),
		"",
		"## Doctor Repair Suggestions",
		...(model.doctorRepairSuggestions.length > 0
			? model.doctorRepairSuggestions.map(
					(suggestion) =>
						`- ${suggestion.severity} ${suggestion.checkName}: ${suggestion.suggestedAction} (${suggestion.command})`,
				)
			: ["- none"]),
		"",
		"## Inspector Snapshot",
		`- ${selectedInspector.title} (${selectedInspector.badge}): ${selectedInspector.content}`,
		"",
		"## Keybindings",
		...model.keybindings.map((binding) => `- ${binding.key}: ${binding.action} (${binding.description})`),
		"",
		"## Release Smoke",
		...model.release.smokeSteps.map((step) => `- ${step.id}: ${step.command}`),
		"",
		"## Session Replay",
		...model.sessionReplay.map((event) => `- ${event.index}. ${event.stage}: ${event.summary}`),
	].join("\n");
}

export function createProductReportArtifact(
	model: ProductWorkbenchModel,
	fileName = "verigen-product-report.md",
): ProductReportArtifact {
	return {
		fileName,
		contentType: "text/markdown",
		content: exportProductReportMarkdown(model),
		description: "VeriGen S15 product workbench report with onboarding, layout, inspector, and replay state.",
	};
}

function inspectorIndex(model: ProductWorkbenchModel): number {
	const index = model.inspectorTabs.findIndex((tab) => tab.id === model.layout.selectedInspector);
	return index >= 0 ? index : 0;
}

function selectedInspectorAt(model: ProductWorkbenchModel, offset: number): WorkbenchPaneId {
	if (model.inspectorTabs.length === 0) return "task-log";
	const index = inspectorIndex(model);
	const next = (index + offset + model.inspectorTabs.length) % model.inspectorTabs.length;
	return model.inspectorTabs[next]?.id ?? "task-log";
}

function replayEvent(index: number, action: string, summary: string): SessionReplayEvent {
	return { index, stage: "ui", action, summary };
}

export function applyProductWorkbenchAction(
	model: ProductWorkbenchModel,
	action: WorkbenchInteractionAction,
): ProductWorkbenchModel {
	const layout: WorkbenchLayoutState = { ...model.layout };
	const replay = [...model.sessionReplay];
	if (action === "next-inspector") {
		layout.focus = "right";
		layout.selectedInspector = selectedInspectorAt(model, 1);
		replay.push(replayEvent(replay.length + 1, action, `selected ${layout.selectedInspector}`));
	} else if (action === "previous-inspector") {
		layout.focus = "right";
		layout.selectedInspector = selectedInspectorAt(model, -1);
		replay.push(replayEvent(replay.length + 1, action, `selected ${layout.selectedInspector}`));
	} else if (action === "focus-left") {
		layout.focus = "left";
		replay.push(replayEvent(replay.length + 1, action, "focused pipeline"));
	} else if (action === "focus-center") {
		layout.focus = "center";
		replay.push(replayEvent(replay.length + 1, action, "focused task log"));
	} else if (action === "focus-right") {
		layout.focus = "right";
		replay.push(replayEvent(replay.length + 1, action, "focused inspector"));
	} else if (action === "toggle-density") {
		layout.density = layout.density === "compact" ? "comfortable" : "compact";
		replay.push(replayEvent(replay.length + 1, action, `density ${layout.density}`));
	} else if (action === "open-selected") {
		replay.push(replayEvent(replay.length + 1, action, `opened ${layout.selectedInspector}`));
	} else if (action === "rerun") {
		replay.push(replayEvent(replay.length + 1, action, "rerun requested"));
	} else if (action === "export-report") {
		replay.push(replayEvent(replay.length + 1, action, "report export requested"));
	}
	return { ...model, layout, sessionReplay: replay };
}

export function applyProductWorkbenchActions(
	model: ProductWorkbenchModel,
	actions: WorkbenchInteractionAction[],
): ProductWorkbenchModel {
	let current = model;
	for (const action of actions) {
		current = applyProductWorkbenchAction(current, action);
	}
	return current;
}

export function applyProductWorkbenchLayoutPatch(
	model: ProductWorkbenchModel,
	patch: WorkbenchLayoutPatch,
): ProductWorkbenchModel {
	const selectedInspector =
		patch.selectedInspector && model.inspectorTabs.some((tab) => tab.id === patch.selectedInspector)
			? patch.selectedInspector
			: model.layout.selectedInspector;
	return {
		...model,
		layout: {
			...model.layout,
			selectedInspector,
			density: patch.density ?? model.layout.density,
			focus: patch.focus ?? model.layout.focus,
		},
	};
}

export function serializeWorkbenchLayout(layout: WorkbenchLayoutState): string {
	return JSON.stringify(layout);
}

export function restoreWorkbenchLayout(model: ProductWorkbenchModel, serialized: string): ProductWorkbenchModel {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		return model;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return model;
	const candidate = parsed as Partial<WorkbenchLayoutState>;
	return applyProductWorkbenchLayoutPatch(model, {
		selectedInspector:
			typeof candidate.selectedInspector === "string" && isWorkbenchPaneId(candidate.selectedInspector)
				? candidate.selectedInspector
				: undefined,
		density:
			typeof candidate.density === "string" && isWorkbenchDensity(candidate.density) ? candidate.density : undefined,
		focus: typeof candidate.focus === "string" && isWorkbenchFocusPane(candidate.focus) ? candidate.focus : undefined,
	});
}

function truncateLine(line: string, width: number): string {
	if (line.length <= width) return line;
	if (width <= 3) return ".".repeat(Math.max(0, width));
	return `${line.slice(0, width - 3)}...`;
}

function padLine(line: string, width: number): string {
	const truncated = truncateLine(line, width);
	return truncated + " ".repeat(Math.max(0, width - truncated.length));
}

function wrapLine(line: string, width: number): string[] {
	if (width <= 0) return [""];
	if (line.length <= width) return [line];
	const words = line.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return [""];
	const output: string[] = [];
	let current = "";
	for (const word of words) {
		if (word.length > width) {
			if (current) {
				output.push(current);
				current = "";
			}
			for (let index = 0; index < word.length; index += width) {
				output.push(word.slice(index, index + width));
			}
			continue;
		}
		const next = current ? `${current} ${word}` : word;
		if (next.length <= width) {
			current = next;
		} else {
			output.push(current);
			current = word;
		}
	}
	if (current) output.push(current);
	return output;
}

function wrapLines(lines: string[], width: number, maxLines: number): string[] {
	const output: string[] = [];
	for (const line of lines) {
		for (const wrapped of wrapLine(line, width)) {
			output.push(wrapped);
			if (output.length >= maxLines) return output;
		}
	}
	return output;
}

function panel(title: string, lines: string[], width: number, height: number, focused = false): string[] {
	const safeWidth = Math.max(12, width);
	const contentWidth = Math.max(8, safeWidth - 4);
	const contentHeight = Math.max(1, height - 4);
	const selected = wrapLines(lines, contentWidth, contentHeight);
	const padded = selected.slice(0, contentHeight);
	while (padded.length < contentHeight) padded.push("");
	const border = `+${"-".repeat(safeWidth - 2)}+`;
	const resolvedTitle = focused ? `* ${title}` : title;
	return [
		border,
		`| ${padLine(resolvedTitle, contentWidth)} |`,
		border,
		...padded.map((line) => `| ${padLine(line, contentWidth)} |`),
		border,
	];
}

function joinThreeColumns(left: string[], center: string[], right: string[], gap = 1): string[] {
	const rows = Math.max(left.length, center.length, right.length);
	const leftWidth = Math.max(...left.map((line) => line.length), 0);
	const centerWidth = Math.max(...center.map((line) => line.length), 0);
	const output: string[] = [];
	for (let index = 0; index < rows; index += 1) {
		output.push(
			[padLine(left[index] ?? "", leftWidth), padLine(center[index] ?? "", centerWidth), right[index] ?? ""].join(
				" ".repeat(gap),
			),
		);
	}
	return output;
}

function joinTwoColumns(left: string[], right: string[], gap = 1): string[] {
	const rows = Math.max(left.length, right.length);
	const leftWidth = Math.max(...left.map((line) => line.length), 0);
	const output: string[] = [];
	for (let index = 0; index < rows; index += 1) {
		output.push([padLine(left[index] ?? "", leftWidth), right[index] ?? ""].join(" ".repeat(gap)));
	}
	return output;
}

function activeInspector(model: ProductWorkbenchModel): WorkbenchInspectorTab {
	return (
		model.inspectorTabs.find((tab) => tab.id === model.layout.selectedInspector) ??
		model.inspectorTabs[0] ?? { id: "task-log", title: "Task Log", badge: "empty", content: "" }
	);
}

function leftPaneLines(model: ProductWorkbenchModel): string[] {
	return [
		`status: ${model.status}`,
		`focus: ${model.layout.focus}`,
		`density: ${model.layout.density}`,
		`provider: ${model.provider.model}`,
		"",
		"pipeline:",
		...model.pipelineNavigator.map((stage, index) => `${String(index + 1).padStart(2, "0")} ${stage}`),
		"",
		"onboarding:",
		...model.onboarding.map((step) => `${step.status} ${step.title}`),
	];
}

function centerPaneLines(model: ProductWorkbenchModel): string[] {
	return [
		"task log:",
		...model.taskLog.map((entry) => `${entry.stage}: ${entry.message}`),
		"",
		"session replay:",
		...model.sessionReplay.map((event) => `#${event.index} ${event.stage}/${event.action}: ${event.summary}`),
		"",
		"templates:",
		...model.templates.map((template) => `${template.id}: ${template.command}`),
	];
}

function rightPaneLines(model: ProductWorkbenchModel): string[] {
	const selected = activeInspector(model);
	return [
		"tabs:",
		...model.inspectorTabs.map((tab) => {
			const marker = tab.id === selected.id ? ">" : " ";
			return `${marker} ${tab.title} [${tab.badge}]`;
		}),
		"",
		`${selected.title}:`,
		selected.content,
		"",
		"board profiles:",
		...model.boardProfiles.map((profile) => `${profile.id}: ${profile.fpgaPart}`),
	];
}

function mediumInspectorLines(model: ProductWorkbenchModel): string[] {
	const selected = activeInspector(model);
	return [
		"tabs:",
		...model.inspectorTabs.map((tab) => {
			const marker = tab.id === selected.id ? ">" : " ";
			return `${marker} ${tab.title} [${tab.badge}]`;
		}),
		"",
		`${selected.title}: ${selected.content}`,
		"",
		"task log:",
		...model.taskLog.map((entry) => `${entry.stage}: ${entry.message}`),
		"",
		"replay:",
		...model.sessionReplay.map((event) => `#${event.index} ${event.stage}/${event.action}: ${event.summary}`),
	];
}

function footer(model: ProductWorkbenchModel, width: number): string[] {
	const keys = model.keybindings.map((binding) => `${binding.key}:${binding.action}`).join("  ");
	return ["-".repeat(width), padLine(`Keys ${keys}`, width), "=".repeat(width)];
}

export function renderProductWorkbenchTui(model: ProductWorkbenchModel, width = 120, height = 36): string {
	const resolvedWidth = Math.max(40, width);
	const resolvedHeight = Math.max(18, height);
	const header = [
		"=".repeat(resolvedWidth),
		padLine(`${model.title} :: product TUI`, resolvedWidth),
		padLine(
			`status=${model.status} focus=${model.layout.focus} inspector=${model.layout.selectedInspector} density=${model.layout.density} provider=${model.provider.provider}/${model.provider.model}`,
			resolvedWidth,
		),
		"=".repeat(resolvedWidth),
	];
	const bodyHeight = Math.max(8, resolvedHeight - header.length - 3);
	let body: string[];
	if (resolvedWidth >= 90) {
		const leftWidth = Math.max(22, Math.floor(resolvedWidth * 0.22));
		const rightWidth = Math.max(28, Math.floor(resolvedWidth * 0.32));
		const centerWidth = Math.max(28, resolvedWidth - leftWidth - rightWidth - 2);
		const left = panel(
			"Pipeline Navigator",
			leftPaneLines(model),
			leftWidth,
			bodyHeight,
			model.layout.focus === "left",
		);
		const center = panel(
			"Task Log / Replay",
			centerPaneLines(model),
			centerWidth,
			bodyHeight,
			model.layout.focus === "center",
		);
		const right = panel("Inspector", rightPaneLines(model), rightWidth, bodyHeight, model.layout.focus === "right");
		body = joinThreeColumns(left, center, right);
	} else if (resolvedWidth >= 64) {
		const leftWidth = Math.max(24, Math.floor(resolvedWidth * 0.4));
		const rightWidth = Math.max(28, resolvedWidth - leftWidth - 1);
		const left = panel("Pipeline", leftPaneLines(model), leftWidth, bodyHeight, model.layout.focus === "left");
		const right = panel(
			"Inspector / Replay",
			mediumInspectorLines(model),
			rightWidth,
			bodyHeight,
			model.layout.focus !== "left",
		);
		body = joinTwoColumns(left, right);
	} else {
		const topHeight = Math.max(6, Math.floor(bodyHeight * 0.45));
		const bottomHeight = Math.max(5, bodyHeight - topHeight);
		const top = panel("Pipeline", leftPaneLines(model), resolvedWidth, topHeight, model.layout.focus === "left");
		const bottom = panel(
			"Inspector",
			mediumInspectorLines(model),
			resolvedWidth,
			bottomHeight,
			model.layout.focus !== "left",
		);
		body = [...top, ...bottom].slice(0, bodyHeight);
	}
	return [...header, ...body, ...footer(model, resolvedWidth)].join("\n");
}
