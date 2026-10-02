"""Turns Jupyter messages into nbformat outputs and keeps a bounded, merged list of them for one execution.
Pure functions and a small class, so they are easy to test without a kernel."""
from __future__ import annotations

import json
from typing import Any

MAX_EXEC_BYTES = 20 * 1024 * 1024      # all outputs of one execution
MAX_ONE_OUTPUT_BYTES = 8 * 1024 * 1024  # a single image/html blob
TRUNCATED_NOTE = "\n[Output truncated: this cell produced more output than MangoLab keeps.]\n"


def fold_cr(text: str) -> str:
    """Emulates a terminal for progress bars: a lone carriage return moves to the start of the line and later characters overwrite."""
    if "\r" not in text:
        return text
    lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if "\r" not in line:
            lines.append(line)
            continue
        buf: list[str] = []
        col = 0
        for ch in line:
            if ch == "\r":
                col = 0
            else:
                if col < len(buf):
                    buf[col] = ch
                else:
                    buf.append(ch)
                col += 1
        lines.append("".join(buf))
    return "\n".join(lines)


def _size(o: Any) -> int:
    return len(json.dumps(o, separators=(",", ":")))


def _joined(v: Any) -> Any:
    return "".join(v) if isinstance(v, list) else v


def convert(msg_type: str, c: dict[str, Any]) -> dict[str, Any] | None:
    """One iopub message to one nbformat output, or None for message types that are not outputs."""
    if msg_type == "stream":
        return {"output_type": "stream", "name": c.get("name", "stdout"), "text": c.get("text", "")}
    if msg_type == "display_data":
        return {"output_type": "display_data", "data": c.get("data", {}), "metadata": c.get("metadata", {})}
    if msg_type == "execute_result":
        return {"output_type": "execute_result", "data": c.get("data", {}), "metadata": c.get("metadata", {}), "execution_count": c.get("execution_count")}
    if msg_type == "error":
        return {"output_type": "error", "ename": c.get("ename", "Error"), "evalue": c.get("evalue", ""), "traceback": c.get("traceback", [])}
    return None


class OutputList:
    """The outputs of one execution, merged the way a notebook shows them."""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.size = 0
        self.truncated = False
        self.display_index: dict[str, int] = {}
        self.pending_clear = False

    def clear(self) -> None:
        self.items.clear()
        self.display_index.clear()
        self.size = 0
        self.truncated = False
        self.pending_clear = False

    def add(self, out: dict[str, Any], display_id: str | None = None) -> tuple[dict[str, Any] | None, bool]:
        """Adds an output. Returns (what the client should append or None, whether a deferred clear_output was applied first)."""
        cleared = False
        if self.pending_clear:
            self.clear()
            cleared = True
        if self.truncated:
            return None, cleared
        out = self._limit(out)
        if self.size + _size(out) > MAX_EXEC_BYTES:
            self.truncated = True
            note = {"output_type": "stream", "name": "stderr", "text": TRUNCATED_NOTE}
            self.items.append(note)
            return note, cleared
        last = self.items[-1] if self.items else None
        if out["output_type"] == "stream" and last and last["output_type"] == "stream" and last["name"] == out["name"]:
            last["text"] = fold_cr(last["text"] + out["text"])
        else:
            if out["output_type"] == "stream":
                out = {**out, "text": fold_cr(out["text"])}
            self.items.append(out)
            if display_id:
                self.display_index[display_id] = len(self.items) - 1
        self.size += _size(out)
        return out, cleared

    def update_display(self, display_id: str, data: dict, metadata: dict) -> int | None:
        """Replaces the display with this id. Returns its position in the list (browsers keep the same list), or None if unknown."""
        i = self.display_index.get(display_id)
        if i is None or i >= len(self.items):
            return None
        self.items[i] = {**self.items[i], "data": data, "metadata": metadata}
        return i

    @staticmethod
    def _limit(out: dict[str, Any]) -> dict[str, Any]:
        if out["output_type"] in ("display_data", "execute_result") and _size(out) > MAX_ONE_OUTPUT_BYTES:
            mb = _size(out) / 1048576
            return {**out, "data": {"text/plain": f"[Output too large to display ({mb:.0f} MB). Save it to a file instead.]"}, "metadata": {}}
        if out["output_type"] == "stream" and len(out["text"]) > MAX_ONE_OUTPUT_BYTES:
            return {**out, "text": out["text"][-MAX_ONE_OUTPUT_BYTES:]}
        return out
