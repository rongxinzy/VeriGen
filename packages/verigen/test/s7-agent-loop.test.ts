import assert from "node:assert";
import { describe, test } from "node:test";
import { renderVerigenFixLoopReport, runCodegenQualityProbeFixLoop, type VerigenCoder } from "../src/index.ts";

const badMux = `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? a : b;
endmodule
`;

const fixedMux = `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? b : a;
endmodule
`;

describe("S7 VeriGen four-agent fix loop", () => {
	test("retries through Debugger feedback and records repair rounds", async () => {
		const coder: VerigenCoder = (input) => {
			assert.equal(input.plan.moduleContract.moduleName, "mux2");
			if (input.round === 1) return badMux;
			assert.match(input.previousFeedback?.repairPrompt ?? "", /Failure type: sim_fail/);
			return fixedMux;
		};

		const report = await runCodegenQualityProbeFixLoop("l0-mux2", { generateRtl: coder });

		assert.equal(report.status, "pass");
		assert.equal(report.repairRounds, 1);
		assert.equal(report.attempts.length, 2);
		assert.equal(report.attempts[0]?.failureType, "sim_fail");
		assert.match(report.attempts[0]?.debuggerFeedback?.summary ?? "", /VERIGEN_SIM_FAIL/);
		assert.equal(report.attempts[1]?.verifierResult.ok, true);
		assert.ok(report.events.some((event) => event.agent === "planner" && /KG seed/.test(event.summary)));
		assert.ok(report.events.some((event) => event.agent === "debugger" && event.round === 1));

		const rendered = renderVerigenFixLoopReport(report);
		assert.match(rendered, /VeriGen S7 Fix Loop/);
		assert.match(rendered, /Status: pass/);
		assert.match(rendered, /round 1: sim_fail/);
		assert.match(rendered, /round 2: pass/);
	});

	test("caps fix loop at three rounds", async () => {
		const report = await runCodegenQualityProbeFixLoop("l0-mux2", {
			generateRtl: () => badMux,
			maxRounds: 9,
		});

		assert.equal(report.status, "fail");
		assert.equal(report.maxRounds, 3);
		assert.equal(report.attempts.length, 3);
		assert.equal(report.failureType, "sim_fail");
		assert.equal(report.repairRounds, 2);
		assert.ok(report.attempts.every((attempt) => attempt.failureType === "sim_fail"));
	});
});
