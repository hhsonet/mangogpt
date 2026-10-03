"""What the assistant is shown about the notebook, and how much of it. The browser sends a snapshot of the open notebook (including
unsaved edits); this turns it into compact text for the model within a budget, favouring the selected cell, failing cells and their neighbours."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CtxCell(BaseModel):
    id: str = Field(max_length=64)
    type: Literal["code", "markdown", "raw"] = "code"
    source: str = Field(default="", max_length=30000)
    output: str = Field(default="", max_length=30000)        # text of the outputs, errors included; images are noted as [image]
    execution_count: int | None = None
    state: Literal["idle", "queued", "running"] = "idle"
    failed: bool = False


class NotebookContext(BaseModel):
    path: str = Field(max_length=500)
    cells: list[CtxCell] = Field(default_factory=list, max_length=400)
    selected: str | None = Field(default=None, max_length=64)
    kernel: str | None = Field(default=None, max_length=20)


def clip(text: str, limit: int, marker: str = "…[cut]") -> str:
    return text if len(text) <= limit else text[: max(0, limit - len(marker))] + marker


def cell_number(ctx: NotebookContext, ref: int | str | None) -> int | None:
    """The 1-based number of a cell given as a number or an id; None if there is no such cell."""
    if isinstance(ref, str) and not ref.strip().lstrip("-").isdigit():
        return next((i + 1 for i, c in enumerate(ctx.cells) if c.id == ref), None)
    try:
        n = int(ref)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= len(ctx.cells) else None


def render_cell(i: int, c: CtxCell, *, src_limit: int, out_limit: int) -> str:
    head = f"[{i}] {c.type} cell"
    if c.type == "code":
        head += f", run {c.execution_count}" if c.execution_count else ", not run"
        if c.state != "idle":
            head += f", {c.state}"
        if c.failed:
            head += ", FAILED"
    lang = "python" if c.type == "code" else ""
    parts = [head, f"```{lang}\n{clip(c.source, src_limit)}\n```" if c.source.strip() else "(empty)"]
    if c.type == "code" and c.output.strip():
        parts.append(f"output:\n```\n{clip(c.output, out_limit)}\n```")
    return "\n".join(parts)


def build_context_text(ctx: NotebookContext, budget_chars: int) -> str:
    """Notebook state as text. Everything is shown in full while it fits; otherwise the selected cell, failed cells and the cells next to
    them keep their detail and the rest shrink to a short head."""
    n = len(ctx.cells)
    sel = cell_number(ctx, ctx.selected)
    head = f"Notebook: {ctx.path}\nCells: {n}" + (f"\nSelected cell: [{sel}]" if sel else "") + (f"\nKernel: {ctx.kernel}" if ctx.kernel else "")
    if not n:
        return head + "\n(the notebook has no cells)"
    for src_limit, out_limit in ((6000, 2500), (2500, 1200), (1200, 600), (500, 300)):
        near = {sel} if sel else set()
        if sel:
            near |= {sel - 1, sel + 1}
        blocks = []
        for i, c in enumerate(ctx.cells, 1):
            important = i == sel or c.failed
            lo, lo_out = (src_limit, out_limit) if important else (src_limit // 2 if i in near else src_limit // 5, out_limit // 2 if i in near else out_limit // 5)
            blocks.append(render_cell(i, c, src_limit=max(lo, 120), out_limit=max(lo_out, 80)))
        text = head + "\n\n" + "\n\n".join(blocks)
        if len(text) <= budget_chars:
            return text
    # still too long: keep the head and as many whole blocks as fit around the selection, then say what was left out
    order = sorted(range(n), key=lambda k: (abs((k + 1) - sel) if sel else k, k))
    keep: set[int] = set()
    used = len(head) + 200
    for k in order:
        b = len(blocks[k]) + 2
        if used + b > budget_chars:
            continue
        keep.add(k)
        used += b
    shown = [blocks[k] for k in range(n) if k in keep]
    return head + "\n\n" + "\n\n".join(shown) + f"\n\n({n - len(keep)} more cells are not shown; use get_cell to read one)"
