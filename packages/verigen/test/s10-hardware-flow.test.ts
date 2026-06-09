import assert from "node:assert";
import { describe, test } from "node:test";
import { createBlinkLedDesign, renderDryRunHardwareFlowReport, runDryRunHardwareFlow } from "../src/index.ts";

describe("S10 dry-run hardware flow", () => {
	test("runs blink_led through simulation and mock board dry-run", async () => {
		const report = await runDryRunHardwareFlow({ template: "blink_led" });

		assert.equal(report.ok, true);
		assert.equal(report.simResult.ok, true);
		assert.equal(report.boardReport.ok, true);
		assert.deepEqual(
			report.boardReport.steps.map((step) => `${step.name}:${step.status}`),
			["validate:pass", "synth:pass", "bitstream:pass", "program:pass", "observe:pass"],
		);
		assert.match(renderDryRunHardwareFlowReport(report), /S10 Dry-run Hardware Flow/);
	});

	test("runs uart_loopback through the same flow contract", async () => {
		const report = await runDryRunHardwareFlow({ template: "uart_loopback" });

		assert.equal(report.ok, true);
		assert.equal(report.template, "uart_loopback");
		assert.equal(report.simResult.ok, true);
		assert.equal(report.boardReport.observations[0]?.signal, "uart_tx");
	});

	test("rejects custom designs outside controlled template names", async () => {
		const report = await runDryRunHardwareFlow({
			template: "blink_led",
			design: { ...createBlinkLedDesign(), name: "custom_unreviewed" },
		});

		assert.equal(report.ok, false);
		assert.ok(report.issues.some((issue) => /controlled hardware flow template/.test(issue)));
		assert.equal(report.boardReport.steps.find((step) => step.name === "program")?.status, "skipped");
	});
});
