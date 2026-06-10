---
name: verigen-playbook
description: Verilog/SystemVerilog RTL generation, verification, waveform trace debugging, and repair rules for VeriGen.
---

# VeriGen Playbook

Use this skill when generating, verifying, or repairing Verilog/SystemVerilog RTL.

## Rule Index

### fsm-localparam-case

- Category: engineering
- Triggers: `fsm`, `state`, `case`, `latch`
- Bad: implicit state encodings or incomplete case branches.
- Good: declare states with `localparam`, reset state explicitly, assign defaults before `case`, and cover `default`.
- Check: reset state exists; next-state logic assigns every output on every path; illegal states recover.
- Fix: add default assignments and a default case that returns to reset state.

### width-explicit-casts

- Category: language
- Triggers: `width`, `signed`, `truncate`, `extend`
- Bad: unsized constants in arithmetic.
- Good: size constants and intermediate wires explicitly.
- Check: constants have explicit width; signed operands match; carry width is intentional.
- Fix: introduce a sized localparam or widened intermediate before intentional truncation.

### seq-nonblocking

- Category: language
- Triggers: `posedge`, `reset`, `nonblocking`, `ff`
- Bad: blocking assignment in clocked logic.
- Good: use nonblocking assignment and explicit reset behavior.
- Check: every register uses `<=`; reset polarity matches contract; no combinational assignment is hidden inside sequential logic.
- Fix: replace `=` with `<=` in clocked blocks and align reset with the module contract.

### tb-mismatch-wave-trace

- Category: debug
- Triggers: `mismatch`, `waveform`, `debugger`, `trace`
- Good: start from the trimmed trace context: mismatch time, ref/dut values, signal controllers, and RTL snippets.
- Check: every proposed repair maps to a traced controller or snippet.
- Fix: patch the nearest traced assignment or state transition, then rerun simulation.

### tool-subset-sv

- Category: tool
- Triggers: `yosys`, `iverilog`, `himasim`, `systemverilog`, `unsupported`
- Good: prefer plain module ports, `localparam`, `always @(*)`, `always @(posedge clk)`, packed vectors, and synthesizable assigns.
- Check: avoid `interface`, `modport`, and `typedef enum` unless tool support is confirmed.
- Fix: rewrite unsupported SystemVerilog constructs into equivalent Verilog-2005 compatible code.
