"""Interactive shells. Each terminal is a bash process on a pseudo-terminal, started inside the project's runtime resource group
(so it shares the RAM/CPU/process limits with the kernels) in the project's workspace, with the project's Python first on PATH."""
from __future__ import annotations

import asyncio
import codecs
import fcntl
import logging
import os
import pty
import struct
import sys
import termios
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from app import db

if TYPE_CHECKING:
    from app.services.runtime_manager import RuntimeHandle, RuntimeManager

log = logging.getLogger("mangolab.terminal")

MAX_TERMINALS = 3          # per runtime
SCROLLBACK_BYTES = 256 * 1024
READ_CHUNK = 65536
RCFILE = r"""
__ml_pwd() { local p="${PWD#"$MANGOLAB_WORKSPACE"}"; [ "$p" = "$PWD" ] && p="$PWD"; echo "/${p#/}"; }  # show paths relative to the project
export PS1='\[\e[1;32m\]mango\[\e[0m\]:\[\e[1;34m\]$(__ml_pwd)\[\e[0m\]\$ '
export HISTFILE="$MANGOLAB_STATE/bash_history"
ulimit -n 8192 2>/dev/null
alias ll='ls -alh --color=auto'; alias ls='ls --color=auto'
cd "$MANGOLAB_WORKSPACE" 2>/dev/null
"""
# Makes the pseudo-terminal this process's controlling terminal, then becomes the command (systemd-run, which becomes the shell).
LAUNCHER = "import fcntl, os, sys, termios; os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 1); os.execvp(sys.argv[1], sys.argv[1:])"


@dataclass
class Terminal:
    id: str
    runtime: "RuntimeHandle"
    master: int
    pid: int
    proc: asyncio.subprocess.Process
    title: str
    created: float = field(default_factory=time.time)
    cols: int = 100
    rows: int = 28
    scrollback: deque[bytes] = field(default_factory=deque)
    scrollback_size: int = 0
    queues: set[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=set)
    decoder: Any = field(default_factory=lambda: codecs.getincrementaldecoder("utf-8")(errors="replace"))
    closed: bool = False

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "created_at": self.created, "cols": self.cols, "rows": self.rows}

    def has_running_job(self) -> bool:
        """True while the shell has a child process (a script, a training run), so a quiet terminal doesn't count as idle."""
        try:
            for tid in os.listdir(f"/proc/{self.pid}/task"):
                with open(f"/proc/{self.pid}/task/{tid}/children") as f:
                    if f.read().strip():
                        return True
        except OSError:
            pass
        return False


class TerminalManager:
    def __init__(self) -> None:
        self.terminals: dict[str, Terminal] = {}

    def for_runtime(self, runtime_id: str) -> list[Terminal]:
        return [t for t in self.terminals.values() if t.runtime.runtime_id == runtime_id]

    def get(self, rt: "RuntimeHandle", tid: str) -> Terminal | None:
        t = self.terminals.get(tid)
        return t if t and t.runtime.runtime_id == rt.runtime_id else None

    async def create(self, manager: "RuntimeManager", rt: "RuntimeHandle", cols: int = 100, rows: int = 28) -> Terminal:
        from app.errors import ApiError
        if rt.status != "running":
            raise ApiError(409, "no_runtime", "Connect a runtime first, then open a terminal.")
        if len(self.for_runtime(rt.runtime_id)) >= MAX_TERMINALS:
            raise ApiError(409, "too_many_terminals", f"You can have {MAX_TERMINALS} terminals open at once. Close one first.")
        tid = uuid.uuid4().hex[:12]
        rc = rt.state_dir / "bashrc"
        rc.write_text(RCFILE)
        py_bin = str(Path(rt.python).parent)
        env = {"PATH": f"{py_bin}:/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home()), "TERM": "xterm-256color", "LANG": "C.UTF-8", "SHELL": "/bin/bash", "USER": os.environ.get("USER", ""),
               "VIRTUAL_ENV": str(Path(py_bin).parent), "MANGOLAB_WORKSPACE": str(rt.workspace), "MANGOLAB_STATE": str(rt.state_dir), "MANGOLAB_GPU_BUDGET_MIB": str(rt.gpu_budget_mib),
               "PIP_CACHE_DIR": str(Path.home() / ".cache" / "mangolab-pip"), "TMPDIR": str(rt.state_dir / "tmp"), "PYTHONUNBUFFERED": "1", "COLUMNS": str(cols), "LINES": str(rows),
               **{k: os.environ[k] for k in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS") if k in os.environ}}
        master, slave = pty.openpty()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        argv = [sys.executable, "-c", LAUNCHER, *manager.driver.scope_argv(rt.runtime_id, f"mangolab-term-{tid}"), "bash", "--noprofile", "--rcfile", str(rc), "-i"]
        try:
            proc = await asyncio.create_subprocess_exec(*argv, stdin=slave, stdout=slave, stderr=slave, cwd=rt.workspace, env=env, close_fds=True)
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        n = len(self.for_runtime(rt.runtime_id)) + 1
        t = Terminal(id=tid, runtime=rt, master=master, pid=proc.pid, proc=proc, title=f"Terminal {n}", cols=cols, rows=rows)
        self.terminals[tid] = t
        asyncio.get_running_loop().add_reader(master, self._on_readable, t)
        asyncio.create_task(self._reap(t))
        rt.touch()
        try:
            async with db.session() as c:
                await c.execute(text("INSERT INTO mangolab.terminals (id, runtime_id, owner_id) VALUES (:id, :r, :o)"), {"id": uuid.uuid5(uuid.NAMESPACE_OID, tid), "r": uuid.UUID(rt.runtime_id), "o": rt.owner_id})
                await c.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not record terminal")
        return t

    def _on_readable(self, t: Terminal) -> None:
        try:
            data = os.read(t.master, READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self._finish(t)
            return
        t.scrollback.append(data)
        t.scrollback_size += len(data)
        while t.scrollback_size > SCROLLBACK_BYTES and len(t.scrollback) > 1:
            t.scrollback_size -= len(t.scrollback.popleft())
        msg = {"type": "output", "data": t.decoder.decode(data)}
        for q in list(t.queues):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                t.queues.discard(q)  # a client that can't keep up is dropped; it reconnects and gets the scrollback

    async def _reap(self, t: Terminal) -> None:
        await t.proc.wait()
        self._finish(t)

    def _finish(self, t: Terminal) -> None:
        if t.closed:
            return
        t.closed = True
        try:
            asyncio.get_running_loop().remove_reader(t.master)
            os.close(t.master)
        except (OSError, ValueError):
            pass
        for q in list(t.queues):
            try:
                q.put_nowait({"type": "exit", "code": t.proc.returncode})
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self.terminals.pop(t.id, None)
        asyncio.create_task(self._db_close(t))

    async def _db_close(self, t: Terminal) -> None:
        try:
            async with db.session() as c:
                await c.execute(text("UPDATE mangolab.terminals SET closed_at = now() WHERE id = :id"), {"id": uuid.uuid5(uuid.NAMESPACE_OID, t.id)})
                await c.commit()
        except Exception:  # noqa: BLE001
            pass

    def write(self, t: Terminal, data: str) -> None:
        if t.closed or len(data) > 65536:
            return
        t.runtime.touch()
        try:
            os.write(t.master, data.encode())
        except (BlockingIOError, OSError):
            pass

    def resize(self, t: Terminal, cols: int, rows: int) -> None:
        cols, rows = max(10, min(cols, 400)), max(3, min(rows, 200))
        t.cols, t.rows = cols, rows
        try:
            fcntl.ioctl(t.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def close(self, t: Terminal) -> None:
        if not t.closed:
            try:
                os.killpg(t.pid, 9)  # the shell leads its own session
            except (ProcessLookupError, PermissionError):
                pass
            self._finish(t)

    def close_all(self, runtime_id: str) -> None:
        for t in self.for_runtime(runtime_id):
            self.close(t)

    def notice(self, t: Terminal, message: str) -> None:
        """Prints a message from MangoLab in the terminal (not typed by the user, not sent to the shell)."""
        text_ = f"\r\n\x1b[1;33m{message}\x1b[0m\r\n"
        t.scrollback.append(text_.encode())
        for q in list(t.queues):
            try:
                q.put_nowait({"type": "output", "data": text_})
            except asyncio.QueueFull:
                t.queues.discard(q)

    def subscribe(self, t: Terminal) -> asyncio.Queue[dict[str, Any] | None]:
        q: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=2000)
        replay = codecs.getincrementaldecoder("utf-8")(errors="replace").decode(b"".join(t.scrollback))
        q.put_nowait({"type": "replay", "data": replay, "cols": t.cols, "rows": t.rows})
        t.queues.add(q)
        return q

    def busy(self, runtime_id: str) -> bool:
        return any(t.has_running_job() for t in self.for_runtime(runtime_id))


terminals = TerminalManager()

