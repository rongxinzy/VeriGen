import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { traceSimulationFailure, VerilogAnalysis } from "../src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workerCwd = join(repoRoot, "packages/verilog-analysis");

const buggyRtl = `module TopModule (
  input wire a,
  input wire b,
  input wire sel,
  output wire out
);
  wire n;
  assign n = a & b;
  assign out = sel ? n : b;
endmodule
`;

const refRtl = `module RefModule (
  input wire a,
  input wire b,
  input wire sel,
  output wire out
);
  assign out = sel ? a : b;
endmodule
`;

const tbRtl =
	`` +
	"`timescale 1ns/1ns\n" +
	`module tb;
  reg clk = 0;
  reg a = 0;
  reg b = 1;
  reg sel = 0;
  wire out_ref;
  wire out_dut;
  integer errors_out = 0;
  integer errortime_out = 0;
  integer clocks = 0;

  always #1 clk = ~clk;

  RefModule good1 (.a(a), .b(b), .sel(sel), .out(out_ref));
  TopModule top_module1 (.a(a), .b(b), .sel(sel), .out(out_dut));

  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, tb);
    #2 a = 1; b = 1; sel = 1;
    #2 a = 1; b = 0; sel = 1;
    #4;
    if (errors_out) begin
      $display("Hint: Output '%s' has %0d mismatches. First mismatch occurred at time %0d.", "out", errors_out, errortime_out);
    end else begin
      $display("Hint: Output '%s' has no mismatches.", "out");
    end
    $finish;
  end

  always @(posedge clk) begin
    clocks = clocks + 1;
    if (out_ref !== out_dut) begin
      if (errors_out == 0) errortime_out = $time;
      errors_out = errors_out + 1;
    end
  end
endmodule
`;

function createSimulationFixture(): { tempDir: string; vcdPath: string } {
	const tempDir = mkdtempSync(join(tmpdir(), "verigen-ts-worker-"));
	writeFileSync(join(tempDir, "buggy.v"), buggyRtl);
	writeFileSync(join(tempDir, "ref.v"), refRtl);
	writeFileSync(join(tempDir, "tb.v"), tbRtl);
	execFileSync(
		"iverilog",
		[
			"-g2012",
			"-o",
			join(tempDir, "test.vvp"),
			join(tempDir, "buggy.v"),
			join(tempDir, "ref.v"),
			join(tempDir, "tb.v"),
		],
		{ cwd: tempDir, stdio: "pipe" },
	);
	execFileSync("vvp", [join(tempDir, "test.vvp")], { cwd: tempDir, stdio: "pipe" });
	return { tempDir, vcdPath: join(tempDir, "wave.vcd") };
}

describe("VerilogAnalysis", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const tempDir of tempDirs) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("keeps a worker alive, pairs JSONL responses by id, and formats sim-fail trace context", async () => {
		const fixture = createSimulationFixture();
		tempDirs.push(fixture.tempDir);

		const worker = new VerilogAnalysis({ workerCwd, requestTimeoutMs: 60_000 });
		try {
			const [parseResult, seqResult] = await Promise.all([
				worker.parseAst({ rtl: buggyRtl, top: "TopModule" }),
				worker.identifySeqElement({
					clock_waveform: [0, 1, 0, 1, 0],
					signal_waveform: [0, 1, 1, 0, 0],
				}),
			]);
			assert.equal(parseResult.ast_ok, true);
			assert.equal(parseResult.modules[0]?.name, "TopModule");
			assert.equal(seqResult.kind, "posedge_ff");

			const traced = await traceSimulationFailure({
				rtl: buggyRtl,
				vcd_path: fixture.vcdPath,
				mismatch_signals: ["out"],
				trace_level: 2,
				worker,
				contextOptions: {
					maxSignals: 2,
					maxControllersPerSignal: 8,
					maxWaveTableRows: 6,
					maxCodeSnippets: 4,
				},
			});

			const firstTrace = traced.rawTrace.trace[0];
			assert.equal(firstTrace?.signal, "out");
			assert.ok(firstTrace?.controllers.includes("n"));
			assert.match(traced.rawTrace.wave_table_hex, /out_dut/);
			assert.match(traced.debuggerPromptContext, /AST waveform trace for Debugger/);
			assert.match(traced.debuggerPromptContext, /Signal trace:/);
			assert.match(traced.debuggerPromptContext, /Waveform window \(hex\):/);
			assert.match(traced.debuggerPromptContext, /Relevant RTL snippets:/);
			assert.ok(traced.debuggerPromptContext.length <= 8_000);
			assert.ok(traced.debuggerContext.code_snippets.length <= 4);
		} finally {
			await worker.close();
		}
	});
});
