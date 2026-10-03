"""The assistant's tools. Inspection tools are read-only and limited to this project. Proposal tools change nothing: they record an
`ai_actions` row that the person has to approve in the browser, so a confused or manipulated model can only ever ask."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

from app import db
from app.errors import ApiError
from app.services import environments, notebooks_io
from app.services.assistant_context import NotebookContext, cell_number, clip, render_cell
from app.services.packages import validate as validate_specs
from app.services.safefs import FsError, SafeFS

MAX_TOOL_TEXT = 8000
MAX_FILE_BYTES = 100_000


def _obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or []}


def _fn(name: str, desc: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": params}}


INSPECT = [
    _fn("list_files", "List the files and folders in a folder of this project (not the contents).", _obj({"path": {"type": "string", "description": "folder, relative to the project root; empty for the root"}})),
    _fn("read_file", "Read a text file (script, CSV, config, log) from this project. Large files are cut.", _obj({"path": {"type": "string"}}, ["path"])),
    _fn("read_notebook", "Read another notebook of this project as a list of cells (source and short output).", _obj({"path": {"type": "string"}}, ["path"])),
    _fn("get_runtime_status", "Is a runtime connected, how much RAM / GPU memory / CPU is it using, against which limits, and what are the kernels doing.", _obj({})),
    _fn("list_packages", "Python packages the user installed in this project (the common scientific stack and CUDA PyTorch are always available).", _obj({})),
]
CELL_INSPECT = [
    _fn("get_cell", "Read one cell of the open notebook in full: its source and its complete output.", _obj({"cell": {"type": "integer", "description": "cell number, starting at 1, as shown in the notebook listing"}}, ["cell"])),
]
PROPOSE = [
    _fn("edit_cell", "PROPOSE replacing the code of an existing cell. Nothing changes until the user presses Apply. Give the complete new source of the cell.", _obj({"cell": {"type": "integer"}, "source": {"type": "string", "description": "the full new source"}}, ["cell", "source"])),
    _fn("insert_cell", "PROPOSE adding a new cell. Nothing changes until the user presses Apply.", _obj({
        "position": {"type": "string", "enum": ["after", "before", "end"], "description": "where, relative to the cell given in 'cell' (or the end of the notebook)"},
        "cell": {"type": "integer", "description": "reference cell number (not needed for 'end')"},
        "type": {"type": "string", "enum": ["code", "markdown"]},
        "source": {"type": "string"}}, ["position", "type", "source"])),
    _fn("run_cell", "PROPOSE running a cell. It runs only after the user presses Apply.", _obj({"cell": {"type": "integer"}}, ["cell"])),
    _fn("install_packages", "PROPOSE installing Python packages into this project (names with optional versions, like 'scikit-learn' or 'transformers==4.45.0'). Installs only after the user presses Apply.", _obj({"packages": {"type": "array", "items": {"type": "string"}}}, ["packages"])),
]
PROPOSAL_NAMES = {f["function"]["name"] for f in PROPOSE}


def tool_specs(has_notebook: bool) -> list[dict[str, Any]]:
    return [*INSPECT, *(CELL_INSPECT if has_notebook else []), *(PROPOSE if has_notebook else [f for f in PROPOSE if f["function"]["name"] == "install_packages"])]


@dataclass
class ToolEnv:
    user_id: str
    username: str
    project_id: uuid.UUID
    workspace: Path
    message_id: uuid.UUID
    ctx: NotebookContext | None
    manager: Any
    actions: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ToolResult:
    text: str                      # what the model sees
    summary: str                   # what the person sees ("Read cell 3")
    action: dict[str, Any] | None = None
    error: bool = False


def _fail(summary: str, msg: str) -> ToolResult:
    return ToolResult(msg, summary, error=True)


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


async def _record(env: ToolEnv, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
    aid = uuid.uuid4()
    async with db.session() as c:
        await c.execute(text("INSERT INTO mangolab.ai_actions (id, message_id, type, payload, status) VALUES (:id, :m, :t, CAST(:p AS jsonb), 'proposed')"),
                        {"id": aid, "m": env.message_id, "t": type_, "p": json.dumps(payload)})
        await c.commit()
    action = {"id": str(aid), "type": type_, "payload": payload, "status": "proposed"}
    env.actions.append(action)
    return action


async def run_tool(env: ToolEnv, name: str, args: dict[str, Any]) -> ToolResult:
    """Runs one tool call. Never raises: a problem becomes a message the model can read and react to."""
    if not isinstance(args, dict):
        args = {}
    try:
        return await _run(env, name, args)
    except FsError as e:
        return _fail(f"{name}: {e.message}", f"Error: {e.message}")
    except ApiError as e:
        return _fail(f"{name}: {e.message}", f"Error: {e.message}")
    except Exception:  # noqa: BLE001
        return _fail(f"{name} failed", "Error: that tool failed. Continue without it.")


async def _run(env: ToolEnv, name: str, a: dict[str, Any]) -> ToolResult:
    ctx = env.ctx
    fs = SafeFS(env.workspace)
    if name == "get_cell":
        if not ctx:
            return _fail("No notebook open", "Error: no notebook is open.")
        n = cell_number(ctx, a.get("cell"))
        if not n:
            return _fail("get_cell: no such cell", f"Error: there is no cell {a.get('cell')!r}; the notebook has {len(ctx.cells)} cells (numbered from 1).")
        return ToolResult(clip(render_cell(n, ctx.cells[n - 1], src_limit=20000, out_limit=8000), MAX_TOOL_TEXT), f"Read cell {n}")
    if name == "list_files":
        entries = await run_in_threadpool(fs.list_dir, str(a.get("path") or ""))
        lines = [f"{'[dir] ' if e.kind == 'dir' else ''}{e.name}" + ("" if e.kind == "dir" else f" ({e.size} bytes)") for e in entries[:200]]
        return ToolResult("\n".join(lines) or "(empty folder)", f"Listed files in /{a.get('path') or ''}".rstrip("/") or "Listed files")
    if name == "read_file":
        path = str(a.get("path") or "")
        data = await run_in_threadpool(fs.read_bytes, path, MAX_FILE_BYTES)
        if b"\x00" in data[:2048]:
            return _fail(f"{path} is not a text file", "Error: that file is binary, so it can't be shown as text.")
        return ToolResult(clip(data.decode(errors="replace"), MAX_TOOL_TEXT), f"Read {path}")
    if name == "read_notebook":
        path = str(a.get("path") or "")
        if not path.endswith(".ipynb"):
            return _fail("not a notebook", "Error: that is not a notebook (.ipynb).")
        nb = notebooks_io.parse(await run_in_threadpool(fs.read_bytes, path, notebooks_io.MAX_NOTEBOOK_BYTES))
        out = []
        for i, c in enumerate(nb.cells, 1):
            src = "".join(c.source) if isinstance(c.source, list) else str(c.source)
            outs = ""
            if c.cell_type == "code":
                for o in c.get("outputs", []):
                    if o.get("output_type") == "stream":
                        outs += "".join(o.get("text", ""))
                    elif o.get("output_type") == "error":
                        outs += f"{o.get('ename')}: {o.get('evalue')}\n"
                    elif "text/plain" in (o.get("data") or {}):
                        outs += "".join(o["data"]["text/plain"]) if isinstance(o["data"]["text/plain"], list) else str(o["data"]["text/plain"])
            out.append(f"[{i}] {c.cell_type}\n{clip(src, 1500)}" + (f"\noutput: {clip(outs, 400)}" if outs.strip() else ""))
        return ToolResult(clip("\n\n".join(out), MAX_TOOL_TEXT), f"Read notebook {path}")
    if name == "get_runtime_status":
        st = env.manager.status(env.project_id)
        return ToolResult(json.dumps({k: st.get(k) for k in ("status", "usage", "limits", "kernels", "blocked", "terminals")}, default=str), "Checked the runtime")
    if name == "list_packages":
        pk = await environments.list_overlay(env.workspace)
        return ToolResult("\n".join(f"{p['name']}=={p['version']}" for p in pk) or "(nothing installed in this project; the shared scientific stack with CUDA PyTorch is available)", "Listed installed packages")

    # ---- proposals
    if name in PROPOSAL_NAMES and name != "install_packages" and not ctx:
        return _fail("No notebook open", "Error: open a notebook first; there is nothing to change.")
    if name == "edit_cell":
        n = cell_number(ctx, a.get("cell")) if ctx else None
        src = a.get("source")
        if not n or not isinstance(src, str):
            return _fail("edit_cell: invalid", f"Error: give an existing cell number (1 to {len(ctx.cells) if ctx else 0}) and the full new source.")
        cell = ctx.cells[n - 1]  # type: ignore[union-attr]
        act = await _record(env, "edit_cell", {"cell_id": cell.id, "cell_number": n, "old_source": clip(cell.source, 30000, ""), "source": clip(src, 30000, "")})
        return ToolResult("Proposed. The change is waiting for the user to press Apply; do not say it has been made.", f"Proposed a change to cell {n}", act)
    if name == "insert_cell":
        pos = a.get("position") if a.get("position") in ("after", "before", "end") else "end"
        ref = cell_number(ctx, a.get("cell")) if (ctx and pos != "end") else None
        if pos != "end" and not ref:
            return _fail("insert_cell: invalid", "Error: say which cell to insert next to ('cell'), or use position 'end'.")
        typ = a.get("type") if a.get("type") in ("code", "markdown") else "code"
        src = a.get("source")
        if not isinstance(src, str):
            return _fail("insert_cell: invalid", "Error: 'source' must be text.")
        payload = {"position": pos, "ref_cell_id": ctx.cells[ref - 1].id if (ctx and ref) else None, "ref_cell_number": ref, "cell_type": typ, "source": clip(src, 30000, "")}
        act = await _record(env, "insert_cell", payload)
        where = "at the end" if pos == "end" else f"{pos} cell {ref}"
        return ToolResult("Proposed. The new cell is waiting for the user to press Apply; do not say it exists yet.", f"Proposed a new {typ} cell {where}", act)
    if name == "run_cell":
        n = cell_number(ctx, a.get("cell")) if ctx else None
        if not n or ctx.cells[n - 1].type != "code":  # type: ignore[union-attr]
            return _fail("run_cell: invalid", "Error: that is not a code cell.")
        act = await _record(env, "run_cell", {"cell_id": ctx.cells[n - 1].id, "cell_number": n})  # type: ignore[union-attr]
        return ToolResult("Proposed. The cell runs only after the user presses Apply.", f"Proposed running cell {n}", act)
    if name == "install_packages":
        pk = a.get("packages")
        if isinstance(pk, str):
            pk = pk.replace(",", " ").split()
        specs = validate_specs([str(p) for p in pk or []])
        act = await _record(env, "install_packages", {"specs": specs})
        return ToolResult("Proposed. The install starts only after the user presses Apply.", f"Proposed installing {', '.join(specs)}", act)
    return _fail(f"Unknown tool {name}", f"Error: there is no tool called {name!r}. Available: {', '.join(t['function']['name'] for t in tool_specs(bool(ctx)))}.")
