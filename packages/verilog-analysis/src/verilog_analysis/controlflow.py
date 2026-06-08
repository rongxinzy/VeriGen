from __future__ import annotations

import contextlib
import io
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import networkx as nx
from pyverilog.vparser.ast import Ioport
from pyverilog.vparser.ast import ModuleDef
from pyverilog.vparser.ast import Node
from pyverilog.vparser.ast import Port
from pyverilog.vparser.parser import VerilogCodeParser


@dataclass(frozen=True)
class RtlSource:
    text: str
    path: str


@contextlib.contextmanager
def redirect_worker_noise() -> Iterator[None]:
    stdout_buffer = io.StringIO()
    with contextlib.redirect_stdout(stdout_buffer):
        try:
            yield
        finally:
            text = stdout_buffer.getvalue()
            if text:
                print(text, file=sys.stderr, end="")


def read_rtl_arg(args: dict[str, object]) -> RtlSource:
    rtl_path = args.get("rtl_path")
    if isinstance(rtl_path, str) and rtl_path:
        path = Path(rtl_path)
        return RtlSource(text=path.read_text(encoding="utf-8"), path=str(path))

    rtl = args.get("rtl")
    if not isinstance(rtl, str) or not rtl.strip():
        raise ValueError("expected non-empty string arg 'rtl' or 'rtl_path'")
    return RtlSource(text=rtl, path="<inline>")


def parse_rtl_text(rtl: str) -> Node:
    with tempfile.TemporaryDirectory(prefix="verigen-rtl-") as temp_dir:
        temp_path = Path(temp_dir)
        rtl_path = temp_path / "input.v"
        preprocess_path = temp_path / "preprocess.out"
        rtl_path.write_text(rtl, encoding="utf-8")

        parser = VerilogCodeParser(
            [str(rtl_path)],
            preprocess_output=str(preprocess_path),
            preprocess_include=[],
            preprocess_define=[],
            outputdir=str(temp_path),
            debug=False,
        )
        with redirect_worker_noise():
            return parser.parse()


def iter_nodes(node: Node) -> Iterator[Node]:
    yield node
    for child in node.children():
        yield from iter_nodes(child)


def width_to_string(width: object) -> str | None:
    if width is None:
        return None
    return str(width).replace("\n", " ")


def extract_modules(ast: Node) -> list[dict[str, object]]:
    modules: list[dict[str, object]] = []
    for node in iter_nodes(ast):
        if not isinstance(node, ModuleDef):
            continue
        ports: list[dict[str, object]] = []
        for port in node.portlist.ports if node.portlist is not None else []:
            if isinstance(port, Ioport):
                declaration = port.first
                ports.append(
                    {
                        "name": getattr(declaration, "name", None),
                        "direction": declaration.__class__.__name__.lower(),
                        "width": width_to_string(getattr(declaration, "width", None)),
                        "line": getattr(declaration, "lineno", None),
                    }
                )
            elif isinstance(port, Port):
                ports.append(
                    {
                        "name": port.name,
                        "direction": None,
                        "width": None,
                        "line": getattr(port, "lineno", None),
                    }
                )
        modules.append({"name": node.name, "line": node.lineno, "ports": ports})
    return modules


def parse_ast(args: dict[str, object]) -> dict[str, object]:
    source = read_rtl_arg(args)
    ast = parse_rtl_text(source.text)
    modules = extract_modules(ast)
    top = args.get("top")
    if isinstance(top, str) and top and top not in {str(module["name"]) for module in modules}:
        return {
            "ast_ok": True,
            "source": source.path,
            "modules": modules,
            "warnings": [{"kind": "top_not_found", "top": top}],
        }
    return {"ast_ok": True, "source": source.path, "modules": modules}


def build_graph_from_rtl(rtl: str) -> nx.DiGraph:
    ast = parse_rtl_text(rtl)
    graph = nx.DiGraph()
    with redirect_worker_noise():
        ast.toplogic_tree_traverse(network_G=graph, rvalue=False, lvalue=False)
    return graph


def normalize_lines(value: object) -> list[int]:
    if isinstance(value, tuple) and len(value) == 2:
        start, end = value
        if isinstance(start, int) and isinstance(end, int):
            return list(range(start, end + 1))
    if isinstance(value, list):
        return [item for item in value if isinstance(item, int)]
    if isinstance(value, int):
        return [value]
    return []


def build_controlflow(args: dict[str, object]) -> dict[str, object]:
    source = read_rtl_arg(args)
    graph = build_graph_from_rtl(source.text)
    nodes = [
        {
            "id": str(node),
            "type": attrs.get("type"),
            "lines": normalize_lines(attrs.get("lines") or attrs.get("line")),
        }
        for node, attrs in graph.nodes(data=True)
    ]
    edges = [
        {
            "source": str(src),
            "target": str(dst),
            "type": attrs.get("type"),
            "lines": normalize_lines(attrs.get("lines") or attrs.get("line")),
        }
        for src, dst, attrs in graph.edges(data=True)
    ]
    signal_lines = {
        str(node): normalize_lines(attrs.get("lines") or attrs.get("line"))
        for node, attrs in graph.nodes(data=True)
        if normalize_lines(attrs.get("lines") or attrs.get("line"))
    }
    return {"nodes": nodes, "edges": edges, "signal_lines": signal_lines}


def is_internal_control_node(name: str) -> bool:
    return re.match(r"^(Always|Assign|Module|IntConst)", name) is not None


def trace_control_signals(
    graph: nx.DiGraph,
    target_signals: list[str],
    trace_level: int,
    signal_only: bool = True,
) -> tuple[list[dict[str, object]], dict[str, list[int]]]:
    traces: list[dict[str, object]] = []
    all_signal_lines: dict[str, list[int]] = {}

    for target in target_signals:
        if target not in graph:
            traces.append(
                {
                    "signal": target,
                    "controllers": [],
                    "controllers_by_level": [],
                    "warnings": [{"kind": "signal_not_in_controlflow_graph"}],
                }
            )
            continue

        queue: list[tuple[str, str]] = [(target, target)]
        visited: dict[str, list[int]] = {
            target: normalize_lines(graph.nodes[target].get("lines") or graph.nodes[target].get("line"))
        }
        levels: list[dict[str, object]] = []

        for level in range(trace_level + 1):
            next_queue: list[tuple[str, str]] = []
            relations: list[dict[str, str]] = []
            for signal, controlled_signal in queue:
                relations.append({"controller": signal, "controlled": controlled_signal})
                for predecessor in graph.predecessors(signal):
                    predecessor_name = str(predecessor)
                    if predecessor_name in visited:
                        continue
                    attrs = graph.nodes[predecessor]
                    if attrs.get("type") in {"Parameter", "Localparam"}:
                        continue
                    if signal_only and is_internal_control_node(predecessor_name):
                        continue
                    edge_attrs = graph.get_edge_data(predecessor, signal, default={})
                    visited[predecessor_name] = normalize_lines(
                        edge_attrs.get("lines")
                        or edge_attrs.get("line")
                        or attrs.get("lines")
                        or attrs.get("line")
                    )
                    next_queue.append((predecessor_name, signal))
            levels.append({"level": level, "relations": relations})
            queue = next_queue

        controllers = [signal for signal in visited if signal != target]
        all_signal_lines.update({signal: lines for signal, lines in visited.items() if lines})
        traces.append(
            {
                "signal": target,
                "controllers": controllers,
                "controllers_by_level": levels,
            }
        )

    return traces, all_signal_lines


def extract_code_snippets(rtl: str, signal_lines: dict[str, list[int]]) -> list[dict[str, object]]:
    rtl_lines = rtl.splitlines()
    snippets: list[dict[str, object]] = []
    seen: set[tuple[str, int, int]] = set()
    for signal, lines in sorted(signal_lines.items()):
        if not lines:
            continue
        start = max(1, min(lines) - 1)
        end = min(len(rtl_lines), max(lines) + 1)
        key = (signal, start, end)
        if key in seen:
            continue
        seen.add(key)
        snippets.append(
            {
                "signal": signal,
                "start_line": start,
                "end_line": end,
                "code": "\n".join(rtl_lines[start - 1 : end]),
            }
        )
    return snippets
