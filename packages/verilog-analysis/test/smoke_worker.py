from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


BUGGY_RTL = """module TopModule (
  input wire a,
  input wire b,
  input wire sel,
  output wire out
);
  wire n;
  assign n = a & b;
  assign out = sel ? n : b;
endmodule
"""


REF_RTL = """module RefModule (
  input wire a,
  input wire b,
  input wire sel,
  output wire out
);
  assign out = sel ? a : b;
endmodule
"""


TB_RTL = """`timescale 1ns/1ns
module tb;
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
"""


def request(process: subprocess.Popen[str], payload: dict[str, object]) -> dict[str, object]:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(json.dumps(payload) + "\n")
    process.stdin.flush()
    raw = process.stdout.readline()
    if not raw:
        raise RuntimeError("worker closed stdout")
    response = json.loads(raw)
    if not response.get("ok"):
        raise AssertionError(response)
    return response


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="verigen-worker-smoke-") as temp_dir:
        temp_path = Path(temp_dir)
        (temp_path / "buggy.v").write_text(BUGGY_RTL, encoding="utf-8")
        (temp_path / "ref.v").write_text(REF_RTL, encoding="utf-8")
        (temp_path / "tb.v").write_text(TB_RTL, encoding="utf-8")

        subprocess.check_call(
            [
                "iverilog",
                "-g2012",
                "-o",
                str(temp_path / "test.vvp"),
                str(temp_path / "buggy.v"),
                str(temp_path / "ref.v"),
                str(temp_path / "tb.v"),
            ],
            cwd=temp_path,
        )
        subprocess.check_call(["vvp", str(temp_path / "test.vvp")], cwd=temp_path)

        process = subprocess.Popen(
            ["uv", "run", "verigen-verilog-analysis"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            parse_response = request(
                process,
                {"id": 1, "fn": "parse_ast", "args": {"rtl": BUGGY_RTL, "top": "TopModule"}},
            )
            modules = parse_response["result"]["modules"]
            assert isinstance(modules, list) and modules[0]["name"] == "TopModule"

            cfg_response = request(
                process,
                {"id": 2, "fn": "build_controlflow", "args": {"rtl": BUGGY_RTL, "top": "TopModule"}},
            )
            assert cfg_response["result"]["nodes"]
            assert cfg_response["result"]["edges"]

            trace_response = request(
                process,
                {
                    "id": 3,
                    "fn": "trace_waveform",
                    "args": {
                        "rtl": BUGGY_RTL,
                        "vcd_path": str(temp_path / "wave.vcd"),
                        "mismatch_signals": ["out"],
                        "trace_level": 2,
                    },
                },
            )
            result = trace_response["result"]
            assert result["trace"][0]["controllers"]
            assert "out_dut" in result["wave_table_hex"]
            assert result["code_snippets"]

            seq_response = request(
                process,
                {
                    "id": 4,
                    "fn": "identify_seq_element",
                    "args": {
                        "clock_waveform": [0, 1, 0, 1, 0],
                        "signal_waveform": [0, 1, 1, 0, 0],
                    },
                },
            )
            assert seq_response["result"]["kind"] == "posedge_ff"
        finally:
            process.terminate()
            process.wait(timeout=5)

    print("smoke_worker.py: ok")


if __name__ == "__main__":
    main()
