from __future__ import annotations

import json
import re
import sys
from collections.abc import Callable
from dataclasses import asdict

from verilog_analysis.binaries import check_required_tools
from verilog_analysis.controlflow import build_controlflow
from verilog_analysis.controlflow import parse_ast
from verilog_analysis.controlflow import redirect_worker_noise
from verilog_analysis.seq_element import identify_seq_element
from verilog_analysis.waveform import trace_waveform


class RpcError(Exception):
    def __init__(self, kind: str, message: str, details: object | None = None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.details = details


RpcHandler = Callable[[dict[str, object]], dict[str, object]]


HANDLERS: dict[str, RpcHandler] = {
    "parse_ast": parse_ast,
    "build_controlflow": build_controlflow,
    "trace_waveform": trace_waveform,
    "identify_seq_element": identify_seq_element,
}


def parse_error_details(message: str) -> list[dict[str, object]]:
    line_match = re.search(r"line[: ]+(\d+)", message, re.IGNORECASE)
    if line_match is None:
        return [{"msg": message}]
    return [{"line": int(line_match.group(1)), "msg": message}]


def classify_exception(error: Exception) -> tuple[str, object]:
    if isinstance(error, RpcError):
        return error.kind, error.details if error.details is not None else {"msg": error.message}
    if isinstance(error, ValueError):
        return "invalid_request", {"msg": str(error)}
    message = str(error)
    lowered = message.lower()
    if "parse" in lowered or "syntax" in lowered:
        return "parse_error", parse_error_details(message)
    if "vcd" in lowered:
        return "vcd_error", {"msg": message}
    return "internal_error", {"msg": message}


def handle_request(request: dict[str, object]) -> dict[str, object]:
    request_id = request.get("id")
    fn = request.get("fn")
    args = request.get("args", {})
    if not isinstance(fn, str):
        raise RpcError("invalid_request", "expected string field 'fn'")
    if not isinstance(args, dict):
        raise RpcError("invalid_request", "expected object field 'args'")
    handler = HANDLERS.get(fn)
    if handler is None:
        raise RpcError("unknown_function", f"unknown function '{fn}'")
    with redirect_worker_noise():
        result = handler(args)
    return {"id": request_id, "ok": True, "result": result}


def error_response(request_id: object | None, error: Exception) -> dict[str, object]:
    kind, details = classify_exception(error)
    return {"id": request_id, "ok": False, "error": {"kind": kind, "details": details}}


def write_response(response: dict[str, object]) -> None:
    print(json.dumps(response, separators=(",", ":"), sort_keys=True), flush=True)


def require_environment() -> list[dict[str, object]]:
    statuses = check_required_tools()
    missing = [status.name for status in statuses if not status.ok]
    if missing:
        for status in statuses:
            if not status.ok:
                print(f"missing required tool: {status.name}", file=sys.stderr)
        raise SystemExit(2)
    return [asdict(status) for status in statuses]


def serve() -> None:
    require_environment()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id: object | None = None
        shutdown_requested = False
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise RpcError("invalid_request", "request must be a JSON object")
            request_id = request.get("id")
            if request.get("fn") == "shutdown":
                response = {"id": request_id, "ok": True, "result": {"shutdown": True}}
                shutdown_requested = True
            else:
                response = handle_request(request)
        except json.JSONDecodeError as error:
            response = error_response(request_id, RpcError("invalid_json", str(error)))
        except Exception as error:
            response = error_response(request_id, error)
        write_response(response)
        if shutdown_requested:
            break


def main(argv: list[str] | None = None) -> None:
    args = argv if argv is not None else sys.argv[1:]
    if args == ["--self-check"]:
        write_response({"id": "self-check", "ok": True, "result": {"tools": require_environment()}})
        return
    serve()
