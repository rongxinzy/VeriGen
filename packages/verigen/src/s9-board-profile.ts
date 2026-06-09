export type BoardPinDirection = "input" | "output" | "inout";

export type BoardResetActiveLevel = "high" | "low";

export type BoardProgrammerKind = "mock" | "vivado" | "quartus" | "custom";

export type BoardSmokeKind = "blink_led" | "uart_loopback";

export type BoardBringupStepName = "validate" | "synth" | "bitstream" | "program" | "observe";

export type BoardBringupStepStatus = "pass" | "fail" | "skipped";

export interface BoardClockConstraint {
	name: string;
	pin: string;
	frequencyHz: number;
	ioStandard: string;
}

export interface BoardResetConstraint {
	name: string;
	pin: string;
	activeLevel: BoardResetActiveLevel;
	ioStandard: string;
}

export interface BoardPinConstraint {
	signal: string;
	pin: string;
	direction: BoardPinDirection;
	ioStandard: string;
	bank?: string;
	voltage?: string;
	description?: string;
}

export interface BoardProgrammerProfile {
	kind: BoardProgrammerKind;
	name: string;
	command: string;
	args: string[];
}

export interface BoardProfile {
	id: string;
	name: string;
	fpgaPart: string;
	clock: BoardClockConstraint;
	reset: BoardResetConstraint;
	pins: BoardPinConstraint[];
	programmer: BoardProgrammerProfile;
}

export interface BoardDesign {
	name: string;
	topModule: string;
	rtl: string;
	requiredSignals: string[];
}

export interface BoardBringupStep {
	name: BoardBringupStepName;
	status: BoardBringupStepStatus;
	command: string;
	args: string[];
	logs: string[];
	artifacts: string[];
}

export interface BoardObservation {
	signal: string;
	expected: string;
	observed: string;
	ok: boolean;
}

export interface MockBoardBringupOptions {
	profile?: BoardProfile;
	smoke?: BoardSmokeKind;
	design?: BoardDesign;
}

export interface MockBoardBringupReport {
	ok: boolean;
	dryRun: true;
	smoke: BoardSmokeKind;
	profile: BoardProfile;
	design: BoardDesign;
	steps: BoardBringupStep[];
	observations: BoardObservation[];
	issues: string[];
}

export function createDefaultMockBoardProfile(): BoardProfile {
	return {
		id: "mock-devboard",
		name: "VeriGen Mock Dev Board",
		fpgaPart: "mock-fpga-1k",
		clock: {
			name: "clk",
			pin: "P1",
			frequencyHz: 50_000_000,
			ioStandard: "LVCMOS33",
		},
		reset: {
			name: "rst",
			pin: "P2",
			activeLevel: "high",
			ioStandard: "LVCMOS33",
		},
		pins: [
			{ signal: "led0", pin: "P3", direction: "output", ioStandard: "LVCMOS33", bank: "0", voltage: "3.3V" },
			{ signal: "uart_rx", pin: "P4", direction: "input", ioStandard: "LVCMOS33", bank: "0", voltage: "3.3V" },
			{ signal: "uart_tx", pin: "P5", direction: "output", ioStandard: "LVCMOS33", bank: "0", voltage: "3.3V" },
		],
		programmer: {
			kind: "mock",
			name: "mock-programmer",
			command: "verigen-mock-program",
			args: ["--dry-run"],
		},
	};
}

export function createBlinkLedDesign(): BoardDesign {
	return {
		name: "blink_led",
		topModule: "blink_led",
		requiredSignals: ["clk", "rst", "led0"],
		rtl: `module blink_led(
  input wire clk,
  input wire rst,
  output reg led0
);
  reg [23:0] counter;

  always @(posedge clk) begin
    if (rst) begin
      counter <= 24'd0;
      led0 <= 1'b0;
    end else begin
      counter <= counter + 24'd1;
      if (counter == 24'd0) led0 <= ~led0;
    end
  end
endmodule
`,
	};
}

export function createUartLoopbackDesign(): BoardDesign {
	return {
		name: "uart_loopback",
		topModule: "uart_loopback",
		requiredSignals: ["clk", "rst", "uart_rx", "uart_tx"],
		rtl: `module uart_loopback(
  input wire clk,
  input wire rst,
  input wire uart_rx,
  output wire uart_tx
);
  assign uart_tx = rst ? 1'b1 : uart_rx;
endmodule
`,
	};
}

function designForSmoke(smoke: BoardSmokeKind): BoardDesign {
	if (smoke === "blink_led") return createBlinkLedDesign();
	return createUartLoopbackDesign();
}

function knownSignals(profile: BoardProfile): Set<string> {
	return new Set([profile.clock.name, profile.reset.name, ...profile.pins.map((pin) => pin.signal)]);
}

function validateBoardDesign(profile: BoardProfile, design: BoardDesign): string[] {
	const signals = knownSignals(profile);
	const issues: string[] = [];
	for (const signal of design.requiredSignals) {
		if (!signals.has(signal)) {
			issues.push(`required signal ${signal} is not constrained by board profile ${profile.id}`);
		}
	}
	if (!design.rtl.includes(`module ${design.topModule}`)) {
		issues.push(`top module ${design.topModule} was not found in RTL`);
	}
	return issues;
}

function step(
	name: BoardBringupStepName,
	status: BoardBringupStepStatus,
	command: string,
	args: string[],
	logs: string[],
	artifacts: string[] = [],
): BoardBringupStep {
	return { name, status, command, args, logs, artifacts };
}

function skippedStep(name: BoardBringupStepName): BoardBringupStep {
	return step(name, "skipped", "verigen-mock-board", [name], ["skipped because validation failed"]);
}

function observationsForSmoke(smoke: BoardSmokeKind): BoardObservation[] {
	if (smoke === "blink_led") {
		return [{ signal: "led0", expected: "toggles after counter rollover", observed: "mock_toggle_seen", ok: true }];
	}
	return [{ signal: "uart_tx", expected: "echoes uart_rx when reset is low", observed: "mock_echo_seen", ok: true }];
}

export function runMockBoardBringup(options: MockBoardBringupOptions = {}): MockBoardBringupReport {
	const profile = options.profile ?? createDefaultMockBoardProfile();
	const smoke = options.smoke ?? "blink_led";
	const design = options.design ?? designForSmoke(smoke);
	const issues = validateBoardDesign(profile, design);
	const validationOk = issues.length === 0;
	const steps: BoardBringupStep[] = [
		step(
			"validate",
			validationOk ? "pass" : "fail",
			"verigen-board-validate",
			["--profile", profile.id, "--top", design.topModule],
			validationOk ? ["profile constraints cover all required signals"] : issues,
		),
	];

	if (!validationOk) {
		steps.push(skippedStep("synth"), skippedStep("bitstream"), skippedStep("program"), skippedStep("observe"));
		return { ok: false, dryRun: true, smoke, profile, design, steps, observations: [], issues };
	}

	steps.push(
		step(
			"synth",
			"pass",
			"verigen-mock-synth",
			["--part", profile.fpgaPart, "--top", design.topModule],
			[`synth dry-run accepted ${design.topModule}`],
			[`artifacts/${design.name}.json`],
		),
		step(
			"bitstream",
			"pass",
			"verigen-mock-bitgen",
			["--part", profile.fpgaPart, "--input", `artifacts/${design.name}.json`],
			["bitstream dry-run generated mock bitstream"],
			[`artifacts/${design.name}.bit.mock`],
		),
		step(
			"program",
			"pass",
			profile.programmer.command,
			[...profile.programmer.args, "--bitstream", `artifacts/${design.name}.bit.mock`],
			[`program dry-run via ${profile.programmer.name}`],
		),
		step(
			"observe",
			"pass",
			"verigen-mock-observe",
			["--smoke", smoke],
			observationsForSmoke(smoke).map((observation) => `${observation.signal}: ${observation.observed}`),
		),
	);

	const observations = observationsForSmoke(smoke);
	return {
		ok: observations.every((observation) => observation.ok),
		dryRun: true,
		smoke,
		profile,
		design,
		steps,
		observations,
		issues,
	};
}

export function renderMockBoardBringupReport(report: MockBoardBringupReport): string {
	const lines = [
		`VeriGen S9 Mock Board Bring-up: ${report.smoke}`,
		`Status: ${report.ok ? "pass" : "fail"}`,
		`Board: ${report.profile.name} (${report.profile.fpgaPart})`,
		`Top: ${report.design.topModule}`,
		"",
		"Steps",
		...report.steps.map((item) => `- ${item.name}: ${item.status} ${item.command} ${item.args.join(" ")}`),
		"",
		"Observations",
		...(report.observations.length > 0
			? report.observations.map((item) => `- ${item.signal}: ${item.observed} expected=${item.expected}`)
			: ["[none]"]),
	];
	if (report.issues.length > 0) {
		lines.push("", "Issues", ...report.issues.map((issue) => `- ${issue}`));
	}
	return lines.join("\n");
}
