# S0 Feasibility Report

Date: 2026-06-08

## Verdict

S0 passed. The vendored VerilogCoder pyverilog fork can run outside AutoGen and produce:

- AST/control-flow graph from RTL.
- Multi-level signal backtrace from a mismatched output.
- VCD waveform comparison table from a real `iverilog`/`vvp` simulation.

This supports proceeding to S1: package the Python analysis worker behind the private JSON-stdio protocol.

## Environment

- Workspace: `/Users/krli/workspace/VeriGen`
- Reference repo: `/Users/krli/workspace/VerilogCoder`
- Temp workspace: `/tmp/verigen-s0`
- Python: uv-managed CPython 3.11.13
- `iverilog`: Homebrew `icarus-verilog` 13.0
- Python packages used:
  - `ply==3.11`
  - `jinja2==3.1.6`
  - `vcdvcd==2.6.0`
  - `pandas==2.3.3`
  - `networkx==3.6.1`
  - `matplotlib==3.10.9`
  - `numpy==2.4.6`

## What Ran

1. Created isolated uv venv in `/tmp/verigen-s0/.venv`.
2. Imported VerilogCoder by `PYTHONPATH`:
   - `/Users/krli/workspace/VerilogCoder`
   - `/Users/krli/workspace/VerilogCoder/hardware_agent/examples/VerilogCoder/pyverilog`
3. Set `PYVERILOG_IVERILOG=/opt/homebrew/bin/iverilog`.
4. Ran `DebugGraph` over a buggy mux DUT.
5. Compiled and ran a tiny golden-reference testbench with `iverilog -g2012` and `vvp`.
6. Parsed the generated VCD with `vcd_waveform_analyzer.get_tabular`.

## Observed Output

Control-flow graph:

- Nodes: 8
- Edges: 19
- Backtrace for `out`:
  - level 0: `out->out`
  - level 1: `sel->out`, `n->out`, `b->out`
  - level 2: `a->n`, `b->n`

Simulation output:

```text
Hint: Output 'out' has 2 mismatches. First mismatch occurred at time 5.
Hint: Total mismatched samples is 2 out of 4 samples
```

Waveform analyzer output identified `out_dut=0` versus `out_ref=1` at the mismatch window and produced the expected hex table.

## Issues Found

1. `iverilog` was not initially installed. Installed Homebrew `icarus-verilog` 13.0 to complete real validation.
2. The vendored pyverilog fork has no `setup.py` or `pyproject.toml`; S1 should either keep `PYTHONPATH`-style vendoring or add a thin local package wrapper.
3. `pandas==3.0.3` breaks `vcd_waveform_analyzer.py` because `DataFrame.fillna(method=...)` is removed. Pin `pandas<3` or patch to `.ffill()`.
4. `pandas==2.3.3` still emits deprecation warnings for `fillna(method=...)` and `applymap`.
5. The waveform analyzer assumes mismatch timestamps and VCD timestamps use the same unit. A `1ns/1ps` testbench produced VCD `#5000` while `$time` reported `5`, causing an empty slice. Use aligned timescales or normalize timestamps in S1.
6. pyverilog emits `Generating LALR tables` and `183 shift/reduce conflicts` on first parse. This is noisy but not fatal.

## S1 Implications

- Add worker startup self-checks for `iverilog -V` and `vvp -V`.
- Pin Python dependencies exactly in `pyproject.toml`; do not allow pandas 3 until analyzer code is patched.
- Normalize VCD/mismatch time units before calling `get_tabular`.
- Capture/suppress pyverilog parser table noise in the worker so stdout remains clean newline-delimited JSON.
- Wrap VerilogCoder imports cleanly; avoid relying on ambient `PYTHONPATH` in the final package.
