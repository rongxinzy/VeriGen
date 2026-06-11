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

### comb-always-complete

- Category: language
- Triggers: `combinational`, `always @(*)`, `always @*`, `latch`, `incomplete`
- Bad: combinational `always` block that does not assign every output on every path.
- Good: assign a default value at the top of the block, then override in conditional branches.
- Check: every output is assigned in every branch of `if`/`case`; no implicit latch.
- Fix: add a default assignment (`= 1'bx` or `= '0`) before the first `if`/`case`, and cover all branches.
- Note: Quartus infers a latch whenever HDL assigns a signal in a combinational block without covering all input conditions. Use `default` in `case` and `else` in `if` to prevent latch inference. Assigning `'X` (don't care) on default paths allows better logic optimization.

### case-default-complete

- Category: language
- Triggers: `case`, `casex`, `casez`, `default`, `priority`, `parallel`
- Bad: `case` statement without `default`, or `if` without final `else`.
- Good: always include `default` in `case`; include final `else` in `if` chains.
- Check: every `case` has a `default` branch; every `if` chain has a final `else`.
- Fix: add `default:` to the case statement, add final `else` clause to if chain. Use don't-care (`'X`) assignments on default paths when the exact value is irrelevant.
- Note: In Verilog, `full_case` and `parallel_case` attributes are synthesis-only and can cause simulation mismatches. Always write complete RTL instead.

### avoid-transparent-latch

- Category: language
- Triggers: `latch`, `transparent`, `level-sensitive`
- Bad: unintentional transparent latch from missing sensitivity or incomplete assignment.
- Good: use edge-triggered `always @(posedge clk)` for registers; combinational logic in `always @(*)`.
- Check: all sequential logic uses `posedge`/`negedge`; all combinational blocks assign outputs for all input combinations.
- Fix: convert level-sensitive logic to edge-triggered registers; complete all combinational assignments.
- Note: Quartus reports inferred latches in "User-Specified and Inferred Latches" section. All combinational loops listed in "Logic Cells Representing Combinational Loops" are at risk of timing hazards.

### register-power-up

- Category: language
- Triggers: `initial`, `power-up`, `default value`, `reset`
- Bad: relying on `initial` blocks for register power-up values (not synthesizable on all targets).
- Good: use explicit reset signals to set registers to known states after power-up.
- Check: every register has a reset assignment; `initial` blocks are not used for synthesizable logic.
- Fix: replace `initial` block register defaults with explicit `if (reset)` in `always @(posedge clk or posedge reset)`.
- Note: Altera FPGA registers power up to 0. A default value (`reg q = 1'b1`) is converted to a Power-Up Level setting, which may use NOT gate push-back and degrade quality of results.

### clock-mux-glitch-free

- Category: engineering
- Triggers: `clock mux`, `clk mux`, `glitch`, `gated clock`
- Bad: combinational logic (assign, mux) on clock signals.
- Good: use dedicated clock control blocks (PLL dynamic reconfiguration, clock switchover) when available.
- Check: clock signals are not assigned with combinational logic; no mux on clock paths.
- Fix: use dedicated hardware primitives for clock switching; if combinational mux is unavoidable, add glitch-free enable logic and register the output.
- Note: Combinational clock muxes introduce glitches, global skew issues, and trigger Design Rule warnings. If using Quartus, prefer ALTCLKCTRL or PLL reconfiguration.

### tri-state-top-level-only

- Category: language
- Triggers: `tristate`, `tri-state`, `z`, `high-z`, `bidir`, `inout`
- Bad: internal bidirectional ports or internal tri-state signals.
- Good: use tri-state (`inout`) only at top-level pins; use internal muxes for internal bus arbitration.
- Check: `inout` ports appear only on the top-level module; `'Z` assignments are only for top-level outputs.
- Fix: replace internal bidir with input + output ports and a mux; push tri-state to top-level.
- Note: Quartus must push lower-level tri-states through hierarchy to reach output pins, which is restricted in block-based design flows.

### sync-reset-design

- Category: engineering
- Triggers: `async reset`, `asynchronous`, `meta`, `glitch`, `reset`
- Bad: asynchronous reset without synchronizer, or missing reset on control signals.
- Good: synchronize all external asynchronous inputs; use synchronous reset or synchronize async reset de-assertion.
- Check: async reset de-assertion is synchronized to the clock; at least two flip-flop synchronizers on external async inputs.
- Fix: add a reset synchronizer circuit (two flip-flops) for async reset de-assertion; register all external inputs.
- Note: Quartus reports metastability metrics (MTBF) in the Metastability report. Use `report_metastability` Tcl command to analyze synchronizer chains.

### metastability-sync

- Category: engineering
- Triggers: `clock domain`, `crossing`, `cdc`, `synchronizer`, `fifo`
- Bad: signals crossing clock domains without synchronization.
- Good: use at least two flip-flop synchronizers for single-bit CDC; use async-FIFO (dual-clock) for multi-bit CDC.
- Check: every signal crossing clock domains has a synchronizer; multi-bit buses use FIFO or handshake.
- Fix: add two flip-flop synchronizer chain for single-bit control signals; instantiate dual-clock FIFO for data buses.
- Note: Altera recommends synchronizer chain length of 2 or more depending on MTBF requirements. Report MTBF via `report_metastability` in Quartus. Use the `altera_std_synchronizer` IP for robust CDC.

### ram-inference-quartus

- Category: tool
- Triggers: `ram`, `rom`, `memory`, `infer`, `mlab`, `m20k`
- Bad: RAM with asynchronous read, or RAM reset description.
- Good: use synchronous RAM with registered read output; do not describe reset logic on RAM.
- Check: RAM read is registered (inside `always @(posedge clk)`); no reset condition on the inferred memory array.
- Fix: move read address into a clocked block; remove reset from RAM inference logic.
- Note: Altera FPGA memory blocks (M20K, MLAB) cannot be cleared with a reset signal during operation. If describing a RAM with reset, Quartus implements it in regular logic instead of dedicated RAM. Use `ramstyle` attribute to control implementation: `"M20K"`, `"MLAB"`, or `"logic"`. Small RAMs (<64 bits) may be more efficient in logic.

### quartus-help-authority

- Category: meta
- Triggers: `quartus`, `quartus_sh`, `quartus_map`, `quartus_fit`, `quartus_sta`, `quartus_asm`, `quartus_pgm`
- Good: when uncertain about Quartus command syntax, tool behavior, or option flags, run `quartus_sh --help` (or `quartus_map --help`, `quartus_fit --help`, etc.) on the user's machine as the authoritative reference.
- Check: if the Quartus command is available on PATH, consult its runtime help before guessing flags or behavior.
- Fix: run `<tool> --help` or `<tool> -h` and use the output to determine correct arguments.
- Note: Quartus versions differ (Pro vs Standard, 20.x vs 24.x). Do not rely on memorized flags; always defer to the installed version's help output.
