"""One notebook = one kernel inside the project's runtime. This talks the Jupyter messaging protocol to the Kernel Gateway,
turns it into small events for browsers, and holds output that nobody was watching until a browser attaches and acknowledges it."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import websockets
from websockets.asyncio.client import connect as ws_connect

from app.services.outputs import OutputList, convert

if TYPE_CHECKING:
    from app.services.runtime_manager import RuntimeHandle

log = logging.getLogger("mangolab.kernel")

TERMINAL = {"ok", "error", "aborted", "died"}
MAX_CODE_BYTES = 1_000_000
MAX_QUEUED = 500
MAX_UNACKED = 100          # finished executions kept for a browser that isn't attached
MAX_RETAINED_BYTES = 64 * 1024 * 1024  # ...and never more than this much output per notebook
UNACKED_TTL_S = 12 * 3600
FLUSH_S = 0.03             # stream text is coalesced for this long before it is sent, so print-heavy loops don't flood the browser
FLUSH_BYTES = 64 * 1024
REPLY_GRACE_S = 1.5        # after execute_reply, wait this long for the trailing iopub 'idle' (outputs always precede it)


@dataclass
class Execution:
    msg_id: str
    cell_id: str
    outputs: OutputList = field(default_factory=OutputList)
    state: str = "queued"             # queued | running | ok | error | aborted | died
    execution_count: int | None = None
    queued_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    reply_status: str | None = None
    saw_error: bool = False
    error_name: str | None = None
    idle_seen: bool = False
    pending_stream: dict[str, str] = field(default_factory=dict)  # name -> text not yet flushed
    pending_bytes: int = 0
    flush_handle: asyncio.TimerHandle | None = None
    grace_handle: asyncio.TimerHandle | None = None

    @property
    def done(self) -> bool:
        return self.state in TERMINAL

    def view(self) -> dict[str, Any]:
        return {"cell_id": self.cell_id, "msg_id": self.msg_id, "state": self.state, "execution_count": self.execution_count, "outputs": self.outputs.items}


class KernelError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class NotebookSession:
    def __init__(self, rt: "RuntimeHandle", path: str):
        self.rt, self.path = rt, path
        self.kernel_id: str | None = None
        self.state = "none"            # none | starting | idle | busy | restarting | dead
        self.execution_count = 0
        self.executions: dict[str, Execution] = {}
        self.internal: set[str] = set()  # msg ids of our own housekeeping requests (not shown to users)
        self._ws: Any = None
        self._reader: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._session_id = uuid.uuid4().hex
        self._restart_requested = False
        self._closing = False
        self._probes: set[str] = set()
        self._ready = asyncio.Event()
        self.pid: int | None = None            # the kernel's process id (learned when it starts)
        self.kill_reason: str | None = None     # set by the watchdog right before it ends this kernel, so the cell can say why

    # ---------------------------------------------------------------- events
    def emit(self, msg: dict[str, Any]) -> None:
        self.rt.broadcast_to_path(self.path, {**msg, "path": self.path})

    def set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            self.emit({"type": "kernel", "state": state, "execution_count": self.execution_count})
            self.rt.manager.persist_kernel_state(self)

    def snapshot(self) -> dict[str, Any]:
        for e in self.executions.values():
            self._flush(e)  # attached browsers get the pending text as a normal event; the new one gets it in this snapshot
        keep = [e.view() for e in self.executions.values()]
        return {"type": "snapshot", "path": self.path, "kernel": self.state, "execution_count": self.execution_count, "executions": keep}

    def ack(self, msg_id: str) -> None:
        e = self.executions.get(msg_id)
        if e and e.done:
            self.executions.pop(msg_id, None)

    def prune(self) -> None:
        done = [e for e in self.executions.values() if e.done]
        now = time.time()
        for e in done:
            if now - (e.finished_at or now) > UNACKED_TTL_S:
                self.executions.pop(e.msg_id, None)
        done = sorted((e for e in self.executions.values() if e.done), key=lambda e: e.finished_at or 0)
        for e in done[:-MAX_UNACKED]:
            self.executions.pop(e.msg_id, None)
        done = [e for e in done[-MAX_UNACKED:] if e.msg_id in self.executions]
        total = sum(e.outputs.size for e in done)
        while done and total > MAX_RETAINED_BYTES:  # oldest first: a long-away browser loses the oldest results, memory stays bounded
            old = done.pop(0)
            total -= old.outputs.size
            self.executions.pop(old.msg_id, None)

    @property
    def active(self) -> list[Execution]:
        return [e for e in self.executions.values() if not e.done]

    # ---------------------------------------------------------------- kernel lifecycle
    async def ensure_kernel(self) -> None:
        async with self._lock:
            if self.kernel_id and self._ws is not None and self.state not in ("dead", "none"):
                return
            http = self.rt.http
            if self.kernel_id and self.state != "dead":
                # known kernel (after an API restart): reconnect to it if it still exists
                r = await http.get(f"/api/kernels/{self.kernel_id}")
                if r.status_code == 200:
                    await self._connect()
                    self.set_state("busy" if r.json().get("execution_state") == "busy" else "idle")
                    return
            self.set_state("starting")
            r = await http.post("/api/kernels", json={"name": "python3"})
            if r.status_code >= 300:
                self.set_state("dead")
                raise KernelError("kernel_start_failed", "The notebook's kernel couldn't be started.")
            self.kernel_id = r.json()["id"]
            self._restart_requested = False
            await self._connect()
            await self._wait_ready()
            self._send_init()
            self.set_state("idle")
            await self.rt.manager.persist_kernel_created(self)

    async def _connect(self) -> None:
        if self._reader:
            self._reader.cancel()
        url = f"ws://127.0.0.1:{self.rt.port}/api/kernels/{self.kernel_id}/channels"
        self._ws = await ws_connect(url, additional_headers={"Authorization": f"token {self.rt.token}"}, max_size=64 * 2**20, ping_interval=20, open_timeout=15)
        self._reader = asyncio.create_task(self._read_loop(self._ws), name=f"kernel-reader-{self.path}")

    async def _wait_ready(self, timeout: float = 15.0) -> bool:
        """A freshly (re)started kernel can publish for a moment before the gateway's output channel is listening, and those
        messages are lost. Probe with silent no-op requests until one's status comes back; only then is it safe to run cells."""
        end = time.monotonic() + timeout
        self._ready = asyncio.Event()
        while time.monotonic() < end:
            if self._ws is None or self._closing:
                return False
            mid = self._send_request("pass", silent=True)
            self.internal.add(mid)
            self._probes.add(mid)
            try:
                await asyncio.wait_for(self._ready.wait(), 0.3)
                return True
            except asyncio.TimeoutError:
                continue
        return False

    def _send_init(self) -> None:
        """Run the notebook from its own folder, like Jupyter does."""
        folder = self.path.rsplit("/", 1)[0] if "/" in self.path else ""
        target = f"{self.rt.workspace}/{folder}" if folder else str(self.rt.workspace)
        mid = self._send_request("import os as _mlos; _mlos.chdir(%r); del _mlos" % target, silent=True, expressions={"pid": "__import__('os').getpid()"})
        self.internal.add(mid)

    def _request(self, code: str, silent: bool, expressions: dict[str, str] | None = None) -> tuple[str, str]:
        mid = uuid.uuid4().hex
        return mid, json.dumps({
            "header": {"msg_id": mid, "username": "mangolab", "session": self._session_id, "msg_type": "execute_request", "version": "5.3"},
            "parent_header": {}, "metadata": {}, "buffers": [], "channel": "shell",
            "content": {"code": code, "silent": silent, "store_history": not silent, "allow_stdin": False, "stop_on_error": True, "user_expressions": expressions or {}},
        })

    def _send_request(self, code: str, silent: bool = False, expressions: dict[str, str] | None = None) -> str:
        mid, payload = self._request(code, silent, expressions)
        asyncio.ensure_future(self._ws.send(payload))
        return mid

    async def execute(self, cell_id: str, code: str) -> None:
        if len(code.encode()) > MAX_CODE_BYTES:
            raise KernelError("code_too_large", "That cell is too large to run (over 1 MB).")
        if self.rt.disk_blocked:
            raise KernelError("disk_full", "Your workspace is over its disk limit, so running cells is paused. Delete some files and try again.")
        if len(self.active) >= MAX_QUEUED:
            raise KernelError("too_many_queued", f"Too many cells are waiting to run (over {MAX_QUEUED}). Wait for some to finish.")
        await self.ensure_kernel()
        mid, payload = self._request(code, False)
        ex = Execution(msg_id=mid, cell_id=cell_id)
        self.executions[mid] = ex
        self.rt.touch()
        self.emit({"type": "exec", "cell_id": cell_id, "msg_id": mid, "state": "queued"})
        try:
            await self._ws.send(payload)
        except Exception as e:  # noqa: BLE001
            self._finish(ex, "died", error_name="ConnectionLost")
            raise KernelError("kernel_unreachable", "Lost the connection to the kernel. Try again.") from e
        self.prune()

    async def interrupt(self) -> None:
        if not self.kernel_id:
            return
        self.rt.touch()
        await self.rt.http.post(f"/api/kernels/{self.kernel_id}/interrupt")

    async def restart(self) -> None:
        if not self.kernel_id:
            return
        self.rt.touch()
        self._restart_requested = True
        self.set_state("restarting")
        self._abort_active("aborted", "Kernel restarted.")
        r = await self.rt.http.post(f"/api/kernels/{self.kernel_id}/restart", timeout=60)
        if r.status_code >= 300:
            self.set_state("dead")
            raise KernelError("restart_failed", "The kernel couldn't be restarted.")
        self.pid = None
        await self._wait_ready(30)
        self._restart_requested = False
        self._send_init()
        self.set_state("idle")

    async def shutdown(self, delete: bool = True) -> None:
        self._closing = True
        if self._reader:
            self._reader.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        if delete and self.kernel_id:
            try:
                await self.rt.http.delete(f"/api/kernels/{self.kernel_id}")
            except Exception:  # noqa: BLE001
                pass
        self._abort_active("died", "The runtime was stopped.")
        self.state = "none"

    # ---------------------------------------------------------------- reading from the kernel
    async def _read_loop(self, ws: Any) -> None:
        try:
            async for raw in ws:
                try:
                    self._on_message(json.loads(raw))
                except Exception:  # noqa: BLE001 - one bad message must not kill the reader
                    log.exception("bad kernel message on %s", self.path)
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception:  # noqa: BLE001
            log.exception("kernel reader failed on %s", self.path)
        if self._closing or ws is not self._ws:
            return
        # The socket dropped while the runtime is alive: the kernel may be fine, so try to reattach before giving up.
        asyncio.create_task(self._recover_connection(), name=f"kernel-recover-{self.path}")

    async def _recover_connection(self) -> None:
        for delay in (0.5, 1.5, 4):
            await asyncio.sleep(delay)
            if self._closing or not await self.rt.manager.driver.is_active(self.rt.unit):
                break
            try:
                r = await self.rt.http.get(f"/api/kernels/{self.kernel_id}")
                if r.status_code == 200:
                    await self._connect()
                    return
                if r.status_code == 404:
                    break
            except Exception:  # noqa: BLE001
                continue
        self._abort_active("died", "The connection to the kernel was lost.")
        self.set_state("dead")

    def _on_message(self, m: dict[str, Any]) -> None:
        t = m.get("header", {}).get("msg_type")
        parent = (m.get("parent_header") or {}).get("msg_id")
        c = m.get("content", {})
        ex = self.executions.get(parent) if parent else None
        if parent in self._probes and t == "status":
            self._ready.set()
        if parent in self.internal:
            if t == "execute_reply":
                self._probes.discard(parent)
                self.internal.discard(parent)
                try:
                    self.pid = int(c["user_expressions"]["pid"]["data"]["text/plain"])
                except (KeyError, TypeError, ValueError):
                    pass
                if self.state in ("starting", "restarting") and not self._restart_requested:
                    self.set_state("idle")  # the restarted kernel answered, so it is alive
            return
        if t == "status":
            state = c.get("execution_state")
            if ex is None:
                if state == "restarting" and not self._restart_requested:
                    self.set_state("restarting")
                    asyncio.create_task(self._explain_death())
                elif state == "starting" and self.state not in ("idle", "busy"):
                    self.set_state("starting")
                return
            if state == "busy" and ex.state == "queued":
                ex.state, ex.started_at = "running", time.time()
                self.rt.touch()
                self.set_state("busy")
                self.emit({"type": "exec", "cell_id": ex.cell_id, "msg_id": ex.msg_id, "state": "running"})
            elif state == "idle":
                ex.idle_seen = True
                self._maybe_finish(ex)
            return
        if ex is None:
            return
        self.rt.touch()
        if t == "execute_input":
            if ex.state == "queued":  # the 'busy' status can be lost right after a restart; execute_input proves the cell is running
                ex.state, ex.started_at = "running", time.time()
                self.set_state("busy")
                self.emit({"type": "exec", "cell_id": ex.cell_id, "msg_id": ex.msg_id, "state": "running"})
            ex.execution_count = c.get("execution_count")
            if ex.execution_count:
                self.execution_count = max(self.execution_count, ex.execution_count)
            self.emit({"type": "exec", "cell_id": ex.cell_id, "msg_id": ex.msg_id, "state": ex.state, "execution_count": ex.execution_count})
        elif t == "stream":
            self._on_stream(ex, c.get("name", "stdout"), c.get("text", ""))
        elif t in ("display_data", "execute_result", "error"):
            self._flush(ex)
            if t == "error":
                ex.saw_error, ex.error_name = True, c.get("ename")
            if t == "execute_result" and c.get("execution_count"):
                ex.execution_count = c["execution_count"]
            self._add_output(ex, convert(t, c), (c.get("transient") or {}).get("display_id"))
        elif t == "clear_output":
            self._flush(ex)
            if c.get("wait"):
                ex.outputs.pending_clear = True
            else:
                ex.outputs.clear()
                self.emit({"type": "clear_output", "cell_id": ex.cell_id, "msg_id": ex.msg_id})
        elif t == "update_display_data":
            self._flush(ex)
            did = (c.get("transient") or {}).get("display_id")
            idx = ex.outputs.update_display(did, c.get("data", {}), c.get("metadata", {})) if did else None
            if idx is not None:
                self.emit({"type": "update_display", "cell_id": ex.cell_id, "msg_id": ex.msg_id, "index": idx, "data": c.get("data", {}), "metadata": c.get("metadata", {})})
        elif t == "execute_reply":
            ex.reply_status = c.get("status")
            if c.get("execution_count"):
                ex.execution_count = c["execution_count"]
            if ex.reply_status == "aborted" or ex.idle_seen:
                self._finish(ex, ex.reply_status or "ok")
            else:
                loop = asyncio.get_running_loop()
                ex.grace_handle = loop.call_later(REPLY_GRACE_S, lambda: self._finish(ex, ex.reply_status or "ok") if not ex.done else None)

    async def _explain_death(self) -> None:
        """Say why the kernel went away: the GPU watchdog, the RAM limit, or something else."""
        reason, self.kill_reason, self.pid = self.kill_reason, None, None
        if not reason:
            try:
                u = await self.rt.manager.driver.usage(self.rt.runtime_id)
            except Exception:  # noqa: BLE001
                u = None
            if u and u.oom_kills > self.rt.oom_seen:
                self.rt.oom_seen = u.oom_kills
                reason = f"The kernel ran out of memory (limit {self.rt.mem_max_mb} MB) and was restarted. Variables are gone; use less memory, for example a smaller batch or dataset."
        self._abort_active("died", reason or "The kernel died and was restarted. If it ran out of memory, reduce your batch size or data.", error_name="KernelDied")
        self._send_init_later()

    def _send_init_later(self) -> None:
        async def go() -> None:
            if self._ws is not None and not self._closing and await self._wait_ready(30):
                self._send_init()
        asyncio.create_task(go())

    def _maybe_finish(self, ex: Execution) -> None:
        if ex.done:
            return
        if ex.reply_status:
            self._finish(ex, ex.reply_status)
        else:
            # idle arrived first; the reply follows within a moment, otherwise infer the outcome from what we saw
            loop = asyncio.get_running_loop()
            ex.grace_handle = loop.call_later(REPLY_GRACE_S * 2, lambda: self._finish(ex, "error" if ex.saw_error else "ok") if not ex.done else None)

    # ---------------------------------------------------------------- outputs
    def _on_stream(self, ex: Execution, name: str, text: str) -> None:
        ex.pending_stream[name] = ex.pending_stream.get(name, "") + text
        ex.pending_bytes += len(text)
        if ex.pending_bytes >= FLUSH_BYTES:
            self._flush(ex)
        elif ex.flush_handle is None:
            ex.flush_handle = asyncio.get_running_loop().call_later(FLUSH_S, self._flush, ex)

    def _flush(self, ex: Execution, send: bool = True) -> None:
        if ex.flush_handle:
            ex.flush_handle.cancel()
            ex.flush_handle = None
        pending, ex.pending_stream, ex.pending_bytes = ex.pending_stream, {}, 0
        for name, text in pending.items():
            if text:
                self._add_output(ex, {"output_type": "stream", "name": name, "text": text}, None, send=send)

    def _add_output(self, ex: Execution, out: dict[str, Any] | None, display_id: str | None, send: bool = True) -> None:
        if out is None:
            return
        was_pending = ex.outputs.pending_clear
        added, cleared = ex.outputs.add(out, display_id)
        if send and cleared and was_pending:
            self.emit({"type": "clear_output", "cell_id": ex.cell_id, "msg_id": ex.msg_id})
        if send and added is not None:
            self.emit({"type": "output", "cell_id": ex.cell_id, "msg_id": ex.msg_id, "output": added})

    # ---------------------------------------------------------------- finishing
    def _finish(self, ex: Execution, state: str, error_name: str | None = None) -> None:
        if ex.done:
            return
        self._flush(ex)
        for h in (ex.flush_handle, ex.grace_handle):
            if h:
                h.cancel()
        ex.state = state if state in TERMINAL else "ok"
        ex.finished_at = time.time()
        ex.error_name = error_name or ex.error_name
        self.emit({"type": "exec", "cell_id": ex.cell_id, "msg_id": ex.msg_id, "state": ex.state, "execution_count": ex.execution_count,
                   "duration_ms": int((ex.finished_at - (ex.started_at or ex.queued_at)) * 1000)})
        self.rt.touch()
        if not self.active and self.state == "busy":
            self.set_state("idle")
        self.rt.manager.record_execution(self, ex)  # finished executions stay in memory until a browser acknowledges them

    def _abort_active(self, state: str, message: str, error_name: str | None = None) -> None:
        for ex in list(self.active):
            if state == "died" or error_name:
                self._add_output(ex, {"output_type": "error", "ename": error_name or "RuntimeStopped", "evalue": message, "traceback": [message]}, None)
            self._finish(ex, state, error_name=error_name)
