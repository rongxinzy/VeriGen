from __future__ import annotations

import tempfile
from bisect import bisect_right
from pathlib import Path

from vcdvcd import VCDVCD

from verilog_analysis.controlflow import build_graph_from_rtl
from verilog_analysis.controlflow import extract_code_snippets
from verilog_analysis.controlflow import read_rtl_arg
from verilog_analysis.controlflow import trace_control_signals


def read_vcd_arg(args: dict[str, object]) -> tuple[str, tempfile.TemporaryDirectory[str] | None]:
    vcd_path = args.get("vcd_path")
    if isinstance(vcd_path, str) and vcd_path:
        return vcd_path, None

    vcd = args.get("vcd")
    if not isinstance(vcd, str) or not vcd.strip():
        raise ValueError("expected non-empty string arg 'vcd' or 'vcd_path'")

    temp_dir = tempfile.TemporaryDirectory(prefix="verigen-vcd-")
    path = Path(temp_dir.name) / "wave.vcd"
    path.write_text(vcd, encoding="utf-8")
    return str(path), temp_dir


def signal_label(reference: str) -> str:
    fields = reference.split(".")
    name = fields[-1]
    if len(fields) >= 2 and fields[-2] == "top_module1":
        return f"{name}_dut"
    if len(fields) >= 2 and fields[-2] == "good1":
        return f"{name}_ref"
    if len(fields) == 2 and fields[0] == "tb":
        return name
    if len(fields) >= 2:
        return f"{fields[-2]}_{name}"
    return name


def base_signal_name(name: str) -> str:
    return name.split("[", 1)[0].replace("_dut", "").replace("_ref", "")


def reference_matches(reference: str, wanted: set[str]) -> bool:
    label = signal_label(reference)
    candidates = {
        label,
        base_signal_name(label),
        reference.split(".")[-1],
        base_signal_name(reference.split(".")[-1]),
    }
    return bool(candidates & wanted)


def select_references(vcd: VCDVCD, names: list[str]) -> list[str]:
    wanted = {name for name in names if name}
    refs = [ref for ref in vcd.signals if reference_matches(ref, wanted)]
    return sorted(refs, key=signal_label)


def value_series(vcd: VCDVCD, reference: str) -> list[tuple[int, str]]:
    symbol = vcd.references_to_ids[reference]
    return [(int(time), str(value)) for time, value in vcd.data[symbol].tv]


def value_at(series: list[tuple[int, str]], time: int) -> str:
    index = bisect_right([point[0] for point in series], time) - 1
    if index < 0:
        return "x"
    return series[index][1]


def value_to_hex(value: str) -> str:
    normalized = value.lower()
    if normalized.startswith("b"):
        normalized = normalized[1:]
    if normalized and all(char in {"0", "1"} for char in normalized):
        if len(normalized) == 1:
            return normalized
        return format(int(normalized, 2), "X")
    return value


def find_first_mismatch(
    labels: dict[str, str],
    series_by_ref: dict[str, list[tuple[int, str]]],
    all_times: list[int],
    mismatch_signals: list[str],
) -> tuple[int | None, dict[str, str]]:
    for signal in mismatch_signals:
        ref = next((key for key, label in labels.items() if label == f"{signal}_ref"), None)
        dut = next((key for key, label in labels.items() if label == f"{signal}_dut"), None)
        if ref is None or dut is None:
            continue
        for time in all_times:
            ref_value = value_at(series_by_ref[ref], time)
            dut_value = value_at(series_by_ref[dut], time)
            if ref_value != dut_value:
                return time, {f"{signal}_ref": value_to_hex(ref_value), f"{signal}_dut": value_to_hex(dut_value)}
    return (all_times[0] if all_times else None), {}


def format_wave_table(
    labels: dict[str, str],
    series_by_ref: dict[str, list[tuple[int, str]]],
    all_times: list[int],
    center_time: int | None,
    window_size: int,
) -> str:
    if not labels or not all_times:
        return "No VCD signals matched the requested trace signals."

    center_index = all_times.index(center_time) if center_time in all_times else 0
    before = max(1, window_size // 2)
    start = max(0, center_index - before)
    end = min(len(all_times), center_index + before + 1)
    selected_times = all_times[start:end]
    ordered_refs = sorted(labels, key=lambda ref: labels[ref])
    headers = ["time"] + [labels[ref] for ref in ordered_refs]
    rows = [headers]
    for time in selected_times:
        rows.append([str(time)] + [value_to_hex(value_at(series_by_ref[ref], time)) for ref in ordered_refs])

    widths = [max(len(row[index]) for row in rows) for index in range(len(headers))]
    return "\n".join(
        " | ".join(cell.rjust(widths[index]) for index, cell in enumerate(row))
        for row in rows
    )


def trace_waveform(args: dict[str, object]) -> dict[str, object]:
    source = read_rtl_arg(args)
    mismatch_signals_raw = args.get("mismatch_signals")
    if not isinstance(mismatch_signals_raw, list) or not all(isinstance(item, str) for item in mismatch_signals_raw):
        raise ValueError("expected string list arg 'mismatch_signals'")
    mismatch_signals = list(mismatch_signals_raw)
    trace_level = int(args.get("trace_level", 2))
    window_size = int(args.get("window_size", 8))

    graph = build_graph_from_rtl(source.text)
    trace, signal_lines = trace_control_signals(graph, mismatch_signals, trace_level, signal_only=True)
    controllers = sorted(
        {
            controller
            for item in trace
            for controller in item.get("controllers", [])
            if isinstance(controller, str)
        }
    )

    vcd_path, temp_dir = read_vcd_arg(args)
    try:
        vcd = VCDVCD(vcd_path)
        refs = select_references(vcd, mismatch_signals + controllers)
        labels = {ref: signal_label(ref) for ref in refs}
        series_by_ref = {ref: value_series(vcd, ref) for ref in refs}
        all_times = sorted({time for series in series_by_ref.values() for time, _ in series})
        mismatch_time, mismatch_values = find_first_mismatch(labels, series_by_ref, all_times, mismatch_signals)
        wave_table = format_wave_table(labels, series_by_ref, all_times, mismatch_time, window_size)
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()

    return {
        "trace": trace,
        "wave_table_hex": wave_table,
        "mismatch_time": mismatch_time,
        "mismatch_values": mismatch_values,
        "code_snippets": extract_code_snippets(source.text, signal_lines),
    }
