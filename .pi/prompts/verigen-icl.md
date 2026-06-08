# VeriGen ICL Examples

## Width Repair Example

Input failure:

```text
width warning: assigning 9-bit expression to 8-bit signal sum
```

Expected reasoning artifact:

```json
{
  "classification": "width",
  "playbook_rules_used": ["width-explicit-casts"],
  "repair": "Introduce a 9-bit intermediate carry_sum, then assign sum = carry_sum[7:0] only if truncation is intended."
}
```

## FSM Latch Repair Example

Input failure:

```text
latch inferred for next_state
```

Expected reasoning artifact:

```json
{
  "classification": "latch",
  "playbook_rules_used": ["fsm-localparam-case"],
  "repair": "Add default next_state assignment and a default case branch returning to reset state."
}
```

## TB Mismatch Trace Example

Input trace:

```text
mismatch_time: 5
mismatch_values: out_ref=1, out_dut=0
Signal trace:
- out: controllers n, sel
  level 1: n->out, sel->out
Relevant RTL snippets:
out lines 8-9:
assign n = a & b;
assign out = sel ? n : b;
```

Expected debugger output:

```json
{
  "root_cause": "out is driven by n when sel is high, but contract expects a",
  "evidence": {"signals": ["out", "n", "sel"], "rtl_lines": ["8-9"]},
  "repair_directive": {"change": "replace n with a in the selected branch"}
}
```
