from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolStatus:
    name: str
    path: str | None
    ok: bool
    version_line: str | None


def resolve_iverilog() -> str | None:
    configured = os.environ.get("PYVERILOG_IVERILOG")
    if configured:
        return configured if shutil.which(configured) or os.path.exists(configured) else None
    return shutil.which("iverilog")


def resolve_vvp() -> str | None:
    configured = os.environ.get("VERIGEN_VVP")
    if configured:
        return configured if shutil.which(configured) or os.path.exists(configured) else None
    return shutil.which("vvp")


def probe_tool(name: str, path: str | None) -> ToolStatus:
    if path is None:
        return ToolStatus(name=name, path=None, ok=False, version_line=None)
    try:
        output = subprocess.run(
            [path, "-V"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=5,
        ).stdout
    except OSError:
        return ToolStatus(name=name, path=path, ok=False, version_line=None)
    except subprocess.TimeoutExpired:
        return ToolStatus(name=name, path=path, ok=False, version_line=None)

    first_line = next((line.strip() for line in output.splitlines() if line.strip()), None)
    return ToolStatus(name=name, path=path, ok=True, version_line=first_line)


def check_required_tools() -> list[ToolStatus]:
    statuses = [
        probe_tool("iverilog", resolve_iverilog()),
        probe_tool("vvp", resolve_vvp()),
    ]
    iverilog_status = statuses[0]
    if iverilog_status.path:
        os.environ["PYVERILOG_IVERILOG"] = iverilog_status.path
    return statuses
