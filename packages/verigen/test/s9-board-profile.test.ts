import assert from "node:assert";
import { describe, test } from "node:test";
import {
	type BoardProfile,
	createDefaultMockBoardProfile,
	createUartLoopbackDesign,
	renderMockBoardBringupReport,
	runMockBoardBringup,
} from "../src/index.ts";

describe("S9 mock board profile", () => {
	test("runs blink_led through mock synth, bitstream, program, and observe", () => {
		const report = runMockBoardBringup({ smoke: "blink_led" });

		assert.equal(report.ok, true);
		assert.equal(report.dryRun, true);
		assert.equal(report.profile.fpgaPart, "mock-fpga-1k");
		assert.deepEqual(
			report.steps.map((step) => `${step.name}:${step.status}`),
			["validate:pass", "synth:pass", "bitstream:pass", "program:pass", "observe:pass"],
		);
		assert.equal(report.observations[0]?.signal, "led0");
		assert.match(renderMockBoardBringupReport(report), /VeriGen S9 Mock Board Bring-up/);
	});

	test("runs uart_loopback smoke on the same board/profile schema", () => {
		const report = runMockBoardBringup({ smoke: "uart_loopback", design: createUartLoopbackDesign() });

		assert.equal(report.ok, true);
		assert.equal(report.smoke, "uart_loopback");
		assert.equal(report.design.topModule, "uart_loopback");
		assert.equal(report.observations[0]?.signal, "uart_tx");
		assert.match(report.steps.find((step) => step.name === "program")?.command ?? "", /verigen-mock-program/);
	});

	test("fails validation before dry-run programming when constraints are missing", () => {
		const profile: BoardProfile = {
			...createDefaultMockBoardProfile(),
			pins: [],
		};
		const report = runMockBoardBringup({ profile, smoke: "blink_led" });

		assert.equal(report.ok, false);
		assert.equal(report.steps[0]?.status, "fail");
		assert.equal(report.steps.find((step) => step.name === "program")?.status, "skipped");
		assert.ok(report.issues.some((issue) => /led0/.test(issue)));
	});
});
