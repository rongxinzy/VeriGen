from __future__ import annotations


def normalize_waveform(value: object, name: str) -> list[tuple[int, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"expected non-empty waveform list arg '{name}'")

    normalized: list[tuple[int, str]] = []
    for index, item in enumerate(value):
        if isinstance(item, dict):
            time = item.get("time", index)
            signal_value = item.get("value")
        elif isinstance(item, list) and len(item) == 2:
            time = item[0]
            signal_value = item[1]
        else:
            time = index
            signal_value = item
        if not isinstance(time, int):
            raise ValueError(f"waveform '{name}' contains non-integer time")
        if not isinstance(signal_value, (str, int)):
            raise ValueError(f"waveform '{name}' contains invalid value")
        normalized.append((time, str(signal_value)))
    return normalized


def transitions(waveform: list[tuple[int, str]]) -> list[tuple[int, str, str]]:
    result: list[tuple[int, str, str]] = []
    previous_value = waveform[0][1]
    for time, value in waveform[1:]:
        if value != previous_value:
            result.append((time, previous_value, value))
        previous_value = value
    return result


def clock_edge_times(clock: list[tuple[int, str]], from_value: str, to_value: str) -> set[int]:
    return {time for time, old, new in transitions(clock) if old == from_value and new == to_value}


def value_at_or_before(waveform: list[tuple[int, str]], time: int) -> str:
    current = waveform[0][1]
    for point_time, value in waveform:
        if point_time > time:
            break
        current = value
    return current


def identify_seq_element(args: dict[str, object]) -> dict[str, object]:
    clock = normalize_waveform(args.get("clock_waveform"), "clock_waveform")
    signal = normalize_waveform(args.get("signal_waveform"), "signal_waveform")
    signal_change_times = {time for time, _, _ in transitions(signal)}
    posedge_times = clock_edge_times(clock, "0", "1")
    negedge_times = clock_edge_times(clock, "1", "0")

    if signal_change_times and signal_change_times <= posedge_times:
        return {"kind": "posedge_ff", "confidence": 1.0}
    if signal_change_times and signal_change_times <= negedge_times:
        return {"kind": "negedge_ff", "confidence": 1.0}

    high_changes = {
        time for time in signal_change_times if value_at_or_before(clock, time) == "1"
    }
    low_changes = {
        time for time in signal_change_times if value_at_or_before(clock, time) == "0"
    }
    if signal_change_times and high_changes == signal_change_times:
        return {"kind": "latch_high", "confidence": 0.75}
    if signal_change_times and low_changes == signal_change_times:
        return {"kind": "latch_low", "confidence": 0.75}

    return {"kind": "unknown", "confidence": 0.0}
