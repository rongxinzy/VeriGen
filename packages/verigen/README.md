# @earendil-works/pi-verigen

TypeScript integration layer for VeriGen.

This package owns the VeriGen TypeScript vertical layer:

- `VerilogAnalysis` keeps a worker process alive and calls the private JSONL RPC
  protocol by request id.
- `traceSimulationFailure` deterministically runs waveform tracing for a
  simulation failure.
- `trimTraceForDebugger` and `formatTraceForDebugger` reduce raw trace output
  before it enters Debugger context.
- `SpecAnchoredKnowledgeGraph` stores module, port, signal, state, example,
  constraint, and task relationships in Graphology.
- `PlaybookRag` indexes Verilog repair rules with Vectra and offline deterministic
  embeddings.
- `GraphifyContext` exposes default Graphify repo/docs context navigation through
  status, query, explain, path, and controlled update operations.

## CLI

The npm package exposes a `verigen` bin:

```bash
verigen --help
verigen doctor
verigen worker-smoke
verigen graphify-status
verigen graphify-query "coder prompt"
verigen graphify-explain .pi/prompts/verigen-coder.md
verigen graphify-path docs/PDD-VeriGen.md packages/verigen/src/spec-kg.ts
verigen graphify-update
```

On first run, `verigen` locates the npm-bundled Python worker under
`dist/python/verilog-analysis`, creates a uv-managed cache venv, and installs the
worker from that local path. The vendored `pyverilog==1.3.0+verigen` fork is
installed from `vendor/pyverilog`; only third-party Python dependencies are
downloaded from PyPI.

Set `VERIGEN_SKIP_PYTHON_BOOTSTRAP=1` to disable automatic bootstrap and use
`verigen doctor` to inspect the missing runtime pieces.
