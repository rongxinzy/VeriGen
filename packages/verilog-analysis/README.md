# VeriGen Verilog Analysis Worker

This package is the S1 Python worker for VeriGen. It wraps the vendored VerilogCoder pyverilog fork behind a private newline-delimited JSON protocol over stdio.

For S4 npm distribution, this worker source tree and `vendor/pyverilog` are shipped inside the npm tarball. The managed uv venv is created after install or on first run, and only third-party Python dependencies are downloaded from PyPI.

## Setup

```bash
cd packages/verilog-analysis
uv sync --frozen
```

The worker requires `iverilog` and `vvp` on `PATH`. `PYVERILOG_IVERILOG` may point to a specific `iverilog` binary.

## Run

```bash
uv run verigen-verilog-analysis
```

Each request is one JSON object per line:

```json
{"id":1,"fn":"parse_ast","args":{"rtl":"module TopModule(input wire a, output wire y); assign y = a; endmodule","top":"TopModule"}}
```

Each response is one JSON object per line:

```json
{"id":1,"ok":true,"result":{"ast_ok":true,"modules":[...]}}
```

## RPCs

- `parse_ast`: `{ rtl, top? }`
- `build_controlflow`: `{ rtl, top? }`
- `trace_waveform`: `{ rtl, vcd, mismatch_signals, trace_level? }`
- `identify_seq_element`: `{ clock_waveform, signal_waveform }`

`rtl_path` and `vcd_path` are also accepted for local smoke testing and later TS integration.

## Offline Wheelhouse

```bash
scripts/download-wheelhouse.sh
```

This creates `requirements.lock.txt` and downloads third-party wheels into `wheelhouse/`. The vendored pyverilog fork is copied with the source tree rather than downloaded from PyPI. Wheelhouse artifacts are optional deployment aids and must not be included in the npm tarball.
