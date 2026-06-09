import { type EdaToolRunResult, runIverilogVvp } from "./eda-toolrunner.ts";
import {
	type BoardDesign,
	type BoardProfile,
	type BoardSmokeKind,
	createBlinkLedDesign,
	createDefaultMockBoardProfile,
	createUartLoopbackDesign,
	type MockBoardBringupReport,
	runMockBoardBringup,
} from "./s9-board-profile.ts";

export type HardwareFlowTemplateId = "blink_led" | "uart_loopback";

export interface DryRunHardwareFlowOptions {
	template?: HardwareFlowTemplateId;
	profile?: BoardProfile;
	design?: BoardDesign;
}

export interface DryRunHardwareFlowReport {
	ok: boolean;
	template: HardwareFlowTemplateId;
	design: BoardDesign;
	simResult: EdaToolRunResult;
	boardReport: MockBoardBringupReport;
	issues: string[];
}

function designForTemplate(template: HardwareFlowTemplateId): BoardDesign {
	if (template === "blink_led") return createBlinkLedDesign();
	return createUartLoopbackDesign();
}

function smokeForTemplate(template: HardwareFlowTemplateId): BoardSmokeKind {
	return template;
}

function blinkLedTestbench(): string {
	return `module tb;
  reg clk = 0;
  reg rst = 1;
  wire led0;

  blink_led dut (.clk(clk), .rst(rst), .led0(led0));
  always #1 clk = ~clk;

  initial begin
    @(posedge clk); #1;
    if (led0 !== 1'b0) begin
      $display("VERIGEN_SIM_FAIL blink_led reset led0=%0b", led0);
      $fatal(1);
    end
    rst = 0;
    @(posedge clk); #1;
    if (led0 !== 1'b1) begin
      $display("VERIGEN_SIM_FAIL blink_led expected first toggle led0=%0b", led0);
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS blink_led");
    $finish;
  end
endmodule
`;
}

function uartLoopbackTestbench(): string {
	return `module tb;
  reg clk = 0;
  reg rst = 1;
  reg uart_rx = 1;
  wire uart_tx;

  uart_loopback dut (.clk(clk), .rst(rst), .uart_rx(uart_rx), .uart_tx(uart_tx));
  always #1 clk = ~clk;

  initial begin
    #1;
    if (uart_tx !== 1'b1) begin
      $display("VERIGEN_SIM_FAIL uart_loopback reset tx=%0b", uart_tx);
      $fatal(1);
    end
    rst = 0;
    uart_rx = 0;
    #1;
    if (uart_tx !== 1'b0) begin
      $display("VERIGEN_SIM_FAIL uart_loopback expected echo low tx=%0b", uart_tx);
      $fatal(1);
    end
    uart_rx = 1;
    #1;
    if (uart_tx !== 1'b1) begin
      $display("VERIGEN_SIM_FAIL uart_loopback expected echo high tx=%0b", uart_tx);
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS uart_loopback");
    $finish;
  end
endmodule
`;
}

function testbenchForTemplate(template: HardwareFlowTemplateId): string {
	if (template === "blink_led") return blinkLedTestbench();
	return uartLoopbackTestbench();
}

export async function runDryRunHardwareFlow(
	options: DryRunHardwareFlowOptions = {},
): Promise<DryRunHardwareFlowReport> {
	const template = options.template ?? "blink_led";
	const profile = options.profile ?? createDefaultMockBoardProfile();
	const design = options.design ?? designForTemplate(template);
	const issues: string[] = [];
	if (options.design && options.design.name !== template) {
		issues.push("custom design must use a controlled hardware flow template name");
	}

	const simResult =
		issues.length === 0
			? await runIverilogVvp({
					rtl: [{ filename: `${design.topModule}.v`, content: design.rtl }],
					testbench: [{ filename: `${design.topModule}_tb.v`, content: testbenchForTemplate(template) }],
					top: "tb",
				})
			: {
					profile: "iverilog-vvp" as const,
					stage: "sim" as const,
					ok: false,
					commands: [],
					issues: [
						{
							kind: "sim_fail" as const,
							severity: "error" as const,
							tool: "verigen-hardware-flow",
							message: issues[0] ?? "hardware flow rejected custom design",
						},
					],
				};
	if (!simResult.ok) {
		issues.push(simResult.issues.find((issue) => issue.severity === "error")?.message ?? "simulation failed");
	}

	const boardReport =
		simResult.ok && issues.length === 0
			? runMockBoardBringup({ profile, smoke: smokeForTemplate(template), design })
			: runMockBoardBringup({
					profile: { ...profile, pins: [] },
					smoke: smokeForTemplate(template),
					design,
				});
	if (!boardReport.ok) {
		issues.push(...boardReport.issues);
	}

	return {
		ok: simResult.ok && boardReport.ok && issues.length === 0,
		template,
		design,
		simResult,
		boardReport,
		issues,
	};
}

export function renderDryRunHardwareFlowReport(report: DryRunHardwareFlowReport): string {
	const lines = [
		`VeriGen S10 Dry-run Hardware Flow: ${report.template}`,
		`Status: ${report.ok ? "pass" : "fail"}`,
		`Top: ${report.design.topModule}`,
		"",
		"Simulation",
		`- ${report.simResult.profile}: ${report.simResult.ok ? "pass" : "fail"}`,
		"",
		"Board dry-run",
		...report.boardReport.steps.map((step) => `- ${step.name}: ${step.status}`),
	];
	if (report.issues.length > 0) {
		lines.push("", "Issues", ...report.issues.map((issue) => `- ${issue}`));
	}
	return lines.join("\n");
}
