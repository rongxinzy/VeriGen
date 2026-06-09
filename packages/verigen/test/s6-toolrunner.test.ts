import assert from "node:assert";
import { describe, test } from "node:test";
import { type FetchLike, runCodegenQualityProbeCase, runIverilogVvp, runVerilatorLint } from "../src/index.ts";

const passRtl = `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? b : a;
endmodule
`;

const passTb = `module tb;
  reg [7:0] a;
  reg [7:0] b;
  reg sel;
  wire [7:0] y;
  mux2 dut (.a(a), .b(b), .sel(sel), .y(y));
  initial begin
    a = 8'h12; b = 8'h34; sel = 1'b0; #1;
    if (y !== 8'h12) begin
      $display("VERIGEN_SIM_FAIL expected a");
      $fatal(1);
    end
    sel = 1'b1; #1;
    if (y !== 8'h34) begin
      $display("VERIGEN_SIM_FAIL expected b");
      $fatal(1);
    end
    $display("VERIGEN_SIM_PASS");
    $finish;
  end
endmodule
`;

describe("S6 EDA ToolRunner", () => {
	test("runs iverilog/vvp compile and simulation for a passing RTL/testbench pair", async () => {
		const result = await runIverilogVvp({
			rtl: [{ filename: "mux2.v", content: passRtl }],
			testbench: [{ filename: "tb.v", content: passTb }],
			top: "tb",
		});

		assert.equal(result.profile, "iverilog-vvp");
		assert.equal(result.stage, "sim");
		assert.equal(result.ok, true);
		assert.equal(result.commands.length, 2);
		assert.deepEqual(
			result.issues.filter((issue) => issue.severity === "error"),
			[],
		);
	});

	test("returns structured compile errors with file, line, and source snippet", async () => {
		const result = await runIverilogVvp({
			rtl: [{ filename: "broken.v", content: "module broken(output y);\n  assign y = ;\nendmodule\n" }],
			testbench: [{ filename: "tb.v", content: "module tb; wire y; broken dut (.y(y)); endmodule\n" }],
			top: "tb",
		});

		assert.equal(result.ok, false);
		const issue = result.issues.find((item) => item.kind === "compile_error");
		assert.ok(issue);
		assert.equal(issue.severity, "error");
		assert.match(issue.file ?? "", /broken\.v$/);
		assert.equal(issue.line, 2);
		assert.match(issue.snippet ?? "", /assign y = ;/);
	});

	test("returns structured simulation failures", async () => {
		const result = await runIverilogVvp({
			rtl: [{ filename: "mux2.v", content: passRtl }],
			testbench: [
				{
					filename: "tb.v",
					content: `module tb;
  reg [7:0] a = 8'h12;
  reg [7:0] b = 8'h34;
  reg sel = 1'b0;
  wire [7:0] y;
  mux2 dut (.a(a), .b(b), .sel(sel), .y(y));
  initial begin
    #1;
    if (y !== 8'h34) begin
      $display("VERIGEN_SIM_FAIL intentional mismatch");
      $fatal(1);
    end
  end
endmodule
`,
				},
			],
			top: "tb",
		});

		assert.equal(result.ok, false);
		assert.ok(result.issues.some((issue) => issue.kind === "sim_fail" && /intentional mismatch/.test(issue.message)));
	});

	test("normalizes missing optional EDA tools", async () => {
		const result = await runVerilatorLint({
			rtl: [{ filename: "mux2.v", content: passRtl }],
			verilatorCommand: "verilator-definitely-missing-for-verigen",
		});

		assert.equal(result.ok, false);
		assert.equal(result.issues[0]?.kind, "missing_tool");
		assert.equal(result.issues[0]?.tool, "verilator-definitely-missing-for-verigen");
	});
});

describe("S6 Codegen Quality Probe ToolRunner integration", () => {
	test("compiles and simulates generated RTL when requested", async () => {
		const fakeFetch: FetchLike = async () => ({
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					content: [{ type: "text", text: passRtl }],
				}),
		});

		const result = await runCodegenQualityProbeCase("l0-mux2", {
			live: true,
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:3000",
			fetchFn: fakeFetch,
			runTools: true,
		});

		assert.equal(result.toolResult.status, "pass");
		assert.equal(result.toolResult.edaResults.length, 1);
		assert.equal(result.toolResult.edaResults[0]?.profile, "iverilog-vvp");
		assert.equal(result.toolResult.edaResults[0]?.ok, true);
	});
});
