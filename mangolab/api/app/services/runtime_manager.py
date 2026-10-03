"""Owns every running runtime: starts and stops Kernel Gateways, enforces how many a user (and the server) may run,
samples their resource use, stops idle ones, and re-adopts runtimes that survived a restart of this API."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import socket
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

from app import db
from app.config import get_settings
from app.deps import LabAccess, User
from app.drivers import Driver, RuntimeSpec, SystemdUserDriver
from app.errors import ApiError
from app.models import Project
from app.services import environments
from app.services.kernel_bridge import KernelError, NotebookSession, Execution
from app.services.packages import packages
from app.services.projects import user_usage, workspace_dir
from app.services.terminals import terminals
from app.usage import log_event

log = logging.getLogger("mangolab.runtime")

ACTIVE = ("starting", "running", "stopping")


class Client:
    """One connected browser socket. Events are queued; a client that cannot keep up is dropped (it reconnects and gets a snapshot)."""

    def __init__(self, user: User):
        self.user = user
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=3000)
        self.attached: set[str] = set()
        self.overflowed = False

    def send(self, msg: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(msg)
        except asyncio.QueueFull:
            self.overflowed = True


@dataclass
class RuntimeHandle:
    manager: "RuntimeManager"
    runtime_id: str
    project_id: uuid.UUID
    project_name: str
    owner_id: str
    owner_name: str
    workspace: Path
    state_dir: Path
    unit: str = ""
    port: int = 0
    token: str = ""
    status: str = "starting"           # starting | running | stopping
    error: str | None = None
    cpu_quota_pct: int = 200
    mem_max_mb: int = 6144
    gpu_budget_mib: int = 4096
    idle_timeout_min: int = 60
    disk_quota_mb: int = 20480
    python: Path = field(default_factory=lambda: Path("python"))
    history: deque = field(default_factory=lambda: deque(maxlen=360))   # last 30 minutes at one sample per 5 s
    disk: dict[str, Any] = field(default_factory=lambda: {"used_mb": None, "quota_mb": None})
    gpu_over: int = 0
    gpu_warned: bool = False
    disk_blocked: bool = False
    disk_warned: bool = False
    oom_kills: int = 0
    oom_seen: int = 0
    started_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.monotonic)
    sessions: dict[str, NotebookSession] = field(default_factory=dict)
    http: httpx.AsyncClient | None = None
    usage: dict[str, Any] = field(default_factory=lambda: {"ram_mb": None, "gpu_mib": None, "cpu_pct": None})
    _cpu_prev: tuple[int, float] | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    start_task: asyncio.Task | None = None

    @property
    def clients(self) -> set[Client]:
        return self.manager.subs.setdefault(self.project_id, set())

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    # -- pub/sub
    def broadcast(self, msg: dict[str, Any]) -> None:
        for c in list(self.clients):
            c.send(msg)

    def broadcast_to_path(self, path: str, msg: dict[str, Any]) -> None:
        for c in list(self.clients):
            if path in c.attached:
                c.send(msg)

    def view(self) -> dict[str, Any]:
        return {
            "status": self.status, "runtime_id": self.runtime_id, "project_id": str(self.project_id), "project_name": self.project_name, "error": self.error,
            "started_at": datetime.fromtimestamp(self.started_at, timezone.utc).isoformat(), "idle_timeout_min": self.idle_timeout_min,
            "limits": {"cpu_quota_pct": self.cpu_quota_pct, "mem_max_mb": self.mem_max_mb, "gpu_budget_mib": self.gpu_budget_mib},
            "usage": {**self.usage, "disk_mb": self.disk["used_mb"], "disk_quota_mb": self.disk["quota_mb"]},
            "blocked": self.disk_blocked,
            "terminals": len(terminals.for_runtime(self.runtime_id)),
            "kernels": [{"path": p, "state": s.state, "execution_count": s.execution_count, "running": len(s.active)} for p, s in self.sessions.items()],
        }


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RuntimeManager:
    def __init__(self, driver: Driver | None = None):
        self.driver: Driver = driver or SystemdUserDriver()
        self.runtimes: dict[uuid.UUID, RuntimeHandle] = {}
        self.subs: dict[uuid.UUID, set[Client]] = {}
        self.last_errors: dict[uuid.UUID, tuple[float, str]] = {}
        self._tasks: list[asyncio.Task] = []
        self._bg: set[asyncio.Task] = set()

    # ------------------------------------------------------------------ queries
    def get(self, project_id: uuid.UUID) -> RuntimeHandle | None:
        return self.runtimes.get(project_id)

    def for_user(self, user_id: str) -> list[RuntimeHandle]:
        return [r for r in self.runtimes.values() if r.owner_id == user_id]

    def status(self, project_id: uuid.UUID) -> dict[str, Any]:
        rt = self.runtimes.get(project_id)
        if rt:
            return rt.view()
        err = self.last_errors.get(project_id)
        return {"status": "none", "error": err[1] if err and time.time() - err[0] < 300 else None}

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # ------------------------------------------------------------------ start
    async def start(self, project: Project, user: User, access: LabAccess) -> RuntimeHandle:
        existing = self.runtimes.get(project.id)
        if existing and existing.status in ("starting", "running"):
            return existing
        if existing and existing.status == "stopping":
            raise ApiError(409, "runtime_stopping", "The runtime is still shutting down. Try again in a few seconds.")
        mine = [r for r in self.for_user(user.id) if r.status in ACTIVE]
        if len(mine) >= access.max_runtimes:
            names = ", ".join(f"“{r.project_name}”" for r in mine)
            raise ApiError(409, "runtime_limit", f"You can run {access.max_runtimes} runtime{'s' if access.max_runtimes != 1 else ''} at a time, and {names} {'is' if len(mine) == 1 else 'are'} running. Stop {'it' if len(mine) == 1 else 'one'} first.")
        if len(self.runtimes) >= get_settings().max_total_runtimes:
            raise ApiError(503, "server_busy", "The server is running as many notebooks as it can right now. Try again in a few minutes.")
        rid = uuid.uuid4().hex
        s = get_settings()
        rt = RuntimeHandle(
            manager=self, runtime_id=rid, project_id=project.id, project_name=project.name, owner_id=project.owner_id, owner_name=user.username,
            workspace=workspace_dir(project.owner_id, project.id), state_dir=s.runtimes_dir / rid,
            cpu_quota_pct=access.cpu_quota_pct, mem_max_mb=access.mem_max_mb, gpu_budget_mib=access.gpu_budget_mib, idle_timeout_min=access.idle_timeout_min,
            disk_quota_mb=access.disk_quota_mb,
        )
        rt.disk = {"used_mb": None, "quota_mb": access.disk_quota_mb}
        self.runtimes[project.id] = rt
        self.last_errors.pop(project.id, None)
        rt.start_task = asyncio.create_task(self._start(rt, user))
        return rt

    async def _start(self, rt: RuntimeHandle, user: User) -> None:
        s = get_settings()
        t0 = time.monotonic()
        try:
            await run_in_threadpool(lambda: rt.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700))
            rt.workspace.mkdir(parents=True, exist_ok=True)
            rt.port, rt.token = _free_port(), uuid.uuid4().hex + uuid.uuid4().hex
            rt.python = await environments.ensure_overlay(rt.workspace)  # the project's own packages on top of the shared ones
            spec = RuntimeSpec(rt.runtime_id, rt.workspace, rt.state_dir, rt.python, rt.port, rt.token, rt.cpu_quota_pct, rt.mem_max_mb, rt.gpu_budget_mib)
            await self._db_insert(rt)
            rt.unit = await self.driver.start(spec)
            fd = os.open(rt.state_dir / "conn.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # lets a restarted API re-adopt this runtime
            with os.fdopen(fd, "w") as f:
                json.dump({"port": rt.port, "token": rt.token, "unit": rt.unit}, f)
            rt.http = httpx.AsyncClient(base_url=f"http://127.0.0.1:{rt.port}", headers={"Authorization": f"token {rt.token}"}, timeout=30)
            deadline = t0 + s.runtime_start_timeout_s
            while True:
                if rt.status == "stopping":
                    return
                if not await self.driver.is_active(rt.unit):
                    raise RuntimeError("the runtime process exited during startup: " + (await self.driver.logs(rt.unit))[-400:])
                try:
                    if (await rt.http.get("/api")).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError("the runtime did not become ready in time")
                await asyncio.sleep(0.25)
            rt.status = "running"
            rt.touch()
            self._spawn(self._check_disk(rt))  # show disk use from the start, not after the first periodic check
            await self._db_status(rt, "idle")
            await self._audit(user.id, user.username, "lab.runtime.start", f"{rt.project_name} ({int((time.monotonic() - t0) * 1000)} ms)")
            rt.broadcast({"type": "runtime", **rt.view()})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("runtime start failed for %s", rt.project_id)
            msg = "The runtime couldn't be started. Please try again; if it keeps failing, ask an admin to check the server."
            self.last_errors[rt.project_id] = (time.time(), msg)
            rt.error = msg
            await self._teardown(rt, reason="error", detail=str(e)[:300])
            self.broadcast(rt.project_id, {"type": "runtime", "status": "none", "error": msg})

    # ------------------------------------------------------------------ stop
    async def stop(self, project_id: uuid.UUID, reason: str = "user", actor: User | None = None) -> bool:
        rt = self.runtimes.get(project_id)
        if not rt:
            return False
        if rt.status == "stopping":
            return True
        was_starting = rt.start_task is not None and not rt.start_task.done()
        rt.status = "stopping"
        rt.broadcast({"type": "runtime", **rt.view()})
        if was_starting:
            rt.start_task.cancel()  # type: ignore[union-attr]
        await self._teardown(rt, reason=reason, actor=actor)
        self.broadcast(rt.project_id, {"type": "runtime", "status": "none", "reason": reason})
        return True

    async def _teardown(self, rt: RuntimeHandle, reason: str, detail: str | None = None, actor: User | None = None) -> None:
        async with rt.lock:
            rt.status = "stopping"
            for sess in list(rt.sessions.values()):
                try:
                    await sess.shutdown(delete=False)
                except Exception:  # noqa: BLE001
                    log.exception("kernel shutdown failed")
            rt.sessions.clear()
            terminals.close_all(rt.runtime_id)
            try:
                await self.driver.stop(rt.runtime_id)  # the whole resource group: gateway, kernels, terminals, installs
            except Exception:  # noqa: BLE001
                log.exception("could not stop the runtime")
            if rt.http:
                await rt.http.aclose()
            await self._db_stopped(rt, "error" if reason == "error" else "stopped", detail)
            who = actor or User(rt.owner_id, rt.owner_name, "user")
            await self._audit(who.id, who.username, "lab.runtime.stop", f"{rt.project_name}: {reason}", status="error" if reason == "error" else "ok")
            self.runtimes.pop(rt.project_id, None)
            await run_in_threadpool(shutil.rmtree, rt.state_dir, True)

    # ------------------------------------------------------------------ attach
    def subscribe(self, project_id: uuid.UUID, client: Client) -> None:
        self.subs.setdefault(project_id, set()).add(client)

    def unsubscribe(self, project_id: uuid.UUID, client: Client) -> None:
        subs = self.subs.get(project_id)
        if subs:
            subs.discard(client)
            if not subs:
                self.subs.pop(project_id, None)

    def broadcast(self, project_id: uuid.UUID, msg: dict[str, Any]) -> None:
        for c in list(self.subs.get(project_id, ())):
            c.send(msg)

    def session(self, rt: RuntimeHandle, path: str) -> NotebookSession:
        s = rt.sessions.get(path)
        if not s:
            s = rt.sessions[path] = NotebookSession(rt, path)
        return s

    async def rename_notebook(self, project_id: uuid.UUID, old: str, new: str) -> None:
        rt = self.runtimes.get(project_id)
        if not rt:
            return
        for p in [p for p in rt.sessions if p == old or p.startswith(old + "/")]:
            s = rt.sessions.pop(p)
            s.path = new + p[len(old):]
            rt.sessions[s.path] = s
            for c in rt.clients:
                if p in c.attached:
                    c.attached.discard(p)
                    c.attached.add(s.path)
            rt.broadcast({"type": "renamed", "from": p, "to": s.path})

    async def forget_notebook(self, project_id: uuid.UUID, path: str) -> None:
        rt = self.runtimes.get(project_id)
        if not rt:
            return
        for p in [p for p in rt.sessions if p == path or p.startswith(path + "/")]:
            await rt.sessions.pop(p).shutdown(delete=True)

    # ------------------------------------------------------------------ background loops
    def start_loops(self) -> None:
        self._tasks = [asyncio.create_task(self._sampler(), name="lab-sampler"), asyncio.create_task(self._idle_sweeper(), name="lab-idle")]

    async def stop_loops(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for rt in self.runtimes.values():  # runtimes keep running; only this process's connections are closed
            for sess in rt.sessions.values():
                sess._closing = True  # noqa: SLF001
                if sess._reader:  # noqa: SLF001
                    sess._reader.cancel()  # noqa: SLF001
            if rt.http:
                await rt.http.aclose()

    async def _sampler(self) -> None:
        interval = get_settings().sample_interval_s
        tick = 0
        while True:
            await asyncio.sleep(interval)
            tick += 1
            try:
                live = [r for r in self.runtimes.values() if r.status == "running"]
                if not live:
                    continue
                gpu = await _gpu_by_pid()
                now = time.monotonic()
                for rt in live:
                    u = await self.driver.usage(rt.runtime_id)
                    cpu_pct = None
                    if u.cpu_usec is not None:
                        if rt._cpu_prev:
                            dt = now - rt._cpu_prev[1]
                            cpu_pct = round((u.cpu_usec - rt._cpu_prev[0]) / 1e6 / dt * 100, 1) if dt > 0 else None
                        rt._cpu_prev = (u.cpu_usec, now)
                    gpu_mib = sum(gpu.get(p, 0) for p in u.pids)
                    rt.usage = {"ram_mb": u.ram_mb, "gpu_mib": gpu_mib, "cpu_pct": cpu_pct}
                    rt.oom_kills = u.oom_kills
                    rt.history.append({"t": time.time(), "ram_mb": u.ram_mb, "gpu_mib": gpu_mib, "cpu_pct": cpu_pct})
                    rt.broadcast({"type": "usage", **rt.usage, "disk_mb": rt.disk["used_mb"], "disk_quota_mb": rt.disk["quota_mb"]})
                    if tick % 3 == 0:
                        self._spawn(self._db_sample(rt, u.ram_mb, gpu_mib, cpu_pct))
                    if tick % 6 == 1:
                        self._spawn(self._check_disk(rt))
                    await self._check_gpu(rt, gpu, u.pids, gpu_mib)
                    if rt.status == "running" and not await self.driver.is_active(rt.unit):
                        self._spawn(self.stop(rt.project_id, reason="crashed"))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("sampler failed")

    # ------------------------------------------------------------------ limits that systemd cannot enforce
    async def _check_gpu(self, rt: RuntimeHandle, gpu: dict[int, int], pids: list[int], total: int) -> None:
        """The GPU has no per-group limit, so it is watched: warn near the budget; if the runtime stays over it, end the process using the most."""
        budget = rt.gpu_budget_mib
        if total >= 0.9 * budget and not rt.gpu_warned:
            rt.gpu_warned = True
            rt.broadcast({"type": "limit", "kind": "gpu", "level": "warn", "message": f"GPU memory is at {total} of {budget} MiB. Free some (delete tensors, torch.cuda.empty_cache()) to avoid being stopped."})
        elif total < 0.8 * budget:
            rt.gpu_warned = False
        rt.gpu_over = rt.gpu_over + 1 if total > budget * 1.05 else 0
        if rt.gpu_over < 2:
            return  # one spike is fine; two samples in a row (about 10 s) is not
        rt.gpu_over = 0
        mine = {p: gpu.get(p, 0) for p in pids if gpu.get(p, 0) > 0}
        if not mine:
            return
        victim = max(mine, key=lambda p: mine[p])
        msg = f"Stopped because this runtime used {total} MiB of GPU memory, over the {budget} MiB limit for your account. Free GPU memory or ask an admin for a larger limit."
        sess = self._kernel_for_pid(rt, victim)
        if sess:
            sess.kill_reason = msg
        else:
            for t in terminals.for_runtime(rt.runtime_id):
                terminals.notice(t, f"[MangoLab] a process was stopped: {msg}")
        log.warning("GPU over budget in runtime %s (%d/%d MiB): killing pid %d", rt.runtime_id[:8], total, budget, victim)
        try:
            os.kill(victim, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        rt.broadcast({"type": "limit", "kind": "gpu", "level": "stopped", "message": msg})
        self._spawn(self._audit(rt.owner_id, rt.owner_name, "lab.limit", f"{rt.project_name}: GPU {total}/{budget} MiB, process stopped", status="error"))

    @staticmethod
    def _ppid(pid: int) -> int:
        try:
            with open(f"/proc/{pid}/stat") as f:
                return int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            return 0

    def _kernel_for_pid(self, rt: RuntimeHandle, pid: int) -> NotebookSession | None:
        """Which notebook's kernel does this process belong to (the kernel itself, or a worker it started)?"""
        by_pid = {s.pid: s for s in rt.sessions.values() if s.pid}
        for _ in range(12):
            if pid in by_pid:
                return by_pid[pid]
            pid = self._ppid(pid)
            if pid <= 1:
                break
        return None

    async def _check_disk(self, rt: RuntimeHandle) -> None:
        """Kernels and terminals write straight to the workspace, so the quota is checked while a runtime runs, not only on upload."""
        try:
            async with db.session() as c:
                used = await user_usage(c, User(rt.owner_id, rt.owner_name, "user"))
        except Exception:  # noqa: BLE001
            return
        quota = rt.disk_quota_mb * 1024 * 1024
        rt.disk = {"used_mb": round(used / 1048576), "quota_mb": rt.disk_quota_mb}
        if used >= 1.5 * quota:
            rt.broadcast({"type": "limit", "kind": "disk", "level": "stopped", "message": "The runtime was stopped because your workspace grew far past its disk limit. Delete files, then connect again."})
            self._spawn(self._audit(rt.owner_id, rt.owner_name, "lab.limit", f"{rt.project_name}: disk {rt.disk['used_mb']}/{rt.disk_quota_mb} MB, runtime stopped", status="error"))
            self._spawn(self.stop(rt.project_id, reason="disk_full"))
        elif used >= quota and not rt.disk_blocked:
            rt.disk_blocked = True
            msg = f"Your workspace is over its {_fmt_mb(rt.disk_quota_mb)} limit, so running cells is paused. Delete some files (the file list or a terminal), and it resumes by itself."
            rt.broadcast({"type": "limit", "kind": "disk", "level": "blocked", "message": msg})
            for sess in rt.sessions.values():
                if sess.active:
                    try:
                        await sess.interrupt()
                    except Exception:  # noqa: BLE001
                        pass
            self._spawn(self._audit(rt.owner_id, rt.owner_name, "lab.limit", f"{rt.project_name}: disk over quota, runs paused", status="error"))
        elif rt.disk_blocked and used < 0.95 * quota:
            rt.disk_blocked = False
            rt.disk_warned = False
            rt.broadcast({"type": "limit", "kind": "disk", "level": "ok", "message": "Disk space is back under the limit. You can run cells again."})
        elif used >= 0.9 * quota and not rt.disk_warned:
            rt.disk_warned = True
            rt.broadcast({"type": "limit", "kind": "disk", "level": "warn", "message": f"Your workspace is at {round(used / quota * 100)}% of its disk limit."})
        elif used < 0.8 * quota:
            rt.disk_warned = False

    async def _idle_sweeper(self) -> None:
        last_prune = 0.0
        while True:
            await asyncio.sleep(get_settings().sweep_interval_s)
            try:
                await self._stop_unauthorized()
                if time.monotonic() - last_prune > 3600:
                    last_prune = time.monotonic()
                    await self._prune_old()
                for rt in list(self.runtimes.values()):
                    if rt.status != "running":
                        continue
                    for sess in rt.sessions.values():
                        sess.prune()
                    # Quiet is not idle while a cell runs, a terminal has a program running, or an install is in progress.
                    busy = any(s.active for s in rt.sessions.values()) or terminals.busy(rt.runtime_id) or packages.running_for_project(rt.project_id) is not None
                    if busy:
                        rt.touch()
                    elif time.monotonic() - rt.last_activity > rt.idle_timeout_min * 60:
                        log.info("stopping idle runtime %s", rt.project_id)
                        self._spawn(self.stop(rt.project_id, reason="idle"))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("idle sweeper failed")

    async def _prune_old(self) -> None:
        try:
            async with db.session() as c:
                await c.execute(text("DELETE FROM mangolab.resource_samples WHERE ts < now() - interval '24 hours'"))
                await c.commit()
            await packages.cleanup_old_logs()
        except Exception:  # noqa: BLE001
            log.exception("prune failed")

    async def _db_sample(self, rt: RuntimeHandle, ram: int | None, gpu: int, cpu: float | None) -> None:
        try:
            async with db.session() as c:
                await c.execute(text("INSERT INTO mangolab.resource_samples (runtime_id, cpu_pct, ram_mb, gpu_mem_mib) VALUES (:r, :c, :m, :g)"),
                                {"r": uuid.UUID(rt.runtime_id), "c": cpu, "m": ram, "g": gpu})
                await c.commit()
        except Exception:  # noqa: BLE001
            pass  # the runtime may just have been removed

    async def history(self, project_id: uuid.UUID, minutes: int) -> list[dict[str, Any]]:
        rt = self.runtimes.get(project_id)
        if not rt:
            return []
        if minutes <= 30:
            cutoff = time.time() - minutes * 60
            return [h for h in rt.history if h["t"] >= cutoff]
        async with db.session() as c:
            rows = (await c.execute(text("SELECT extract(epoch from ts) AS ts_s, ram_mb, gpu_mem_mib, cpu_pct FROM mangolab.resource_samples WHERE runtime_id = :r AND ts > now() - make_interval(mins => :m) ORDER BY ts"),
                                    {"r": uuid.UUID(rt.runtime_id), "m": minutes})).all()
        return [{"t": float(r.ts_s), "ram_mb": r.ram_mb, "gpu_mib": r.gpu_mem_mib, "cpu_pct": r.cpu_pct} for r in rows]

    async def _stop_unauthorized(self) -> None:
        """A runtime belongs to someone who must still be active and still have MangoLab access (admins always do)."""
        owners = {r.owner_id for r in self.runtimes.values() if r.status in ("starting", "running")}
        if not owners:
            return
        async with db.session() as c:
            rows = (await c.execute(text(
                'SELECT u.id, u.status, u.role, coalesce(a.enabled, false) AS enabled FROM public."User" u LEFT JOIN mangolab.lab_access a ON a.user_id = u.id WHERE u.id = ANY(:ids)'),
                {"ids": list(owners)})).all()
        ok = {r.id for r in rows if r.status == "active" and (r.role == "admin" or r.enabled)}
        for rt in list(self.runtimes.values()):
            if rt.owner_id in owners and rt.owner_id not in ok:
                log.info("stopping runtime of %s: access ended", rt.owner_name)
                self._spawn(self.stop(rt.project_id, reason="access_removed"))

    # ------------------------------------------------------------------ recovery after an API restart
    async def recover(self) -> None:
        async with db.session() as conn:
            rows = (await conn.execute(text(
                "SELECT r.id, r.project_id, r.owner_id, r.gpu_budget_mib, r.cpu_quota_pct, r.mem_max_mb, r.started_at, p.name AS pname, u.username "
                "FROM mangolab.runtimes r JOIN mangolab.projects p ON p.id = r.project_id JOIN public.\"User\" u ON u.id = r.owner_id "
                "WHERE r.status NOT IN ('stopped', 'error')"))).all()
        known: set[str] = set()
        s = get_settings()
        for row in rows:
            rid = row.id.hex
            unit = self.driver.unit_name(rid)
            conn_file = s.runtimes_dir / rid / "conn.json"
            try:
                info = json.loads(conn_file.read_text())
                ok = await self.driver.is_active(unit)
            except (OSError, ValueError):
                ok = False
            if ok:
                http = httpx.AsyncClient(base_url=f"http://127.0.0.1:{info['port']}", headers={"Authorization": f"token {info['token']}"}, timeout=30)
                try:
                    ok = (await http.get("/api")).status_code == 200
                except httpx.HTTPError:
                    ok = False
            if not ok:
                await self._db_mark_stopped(row.id)
                try:
                    await self.driver.stop(rid)
                except Exception:  # noqa: BLE001
                    pass
                continue
            rt = RuntimeHandle(manager=self, runtime_id=rid, project_id=row.project_id, project_name=row.pname, owner_id=row.owner_id, owner_name=row.username,
                               workspace=workspace_dir(row.owner_id, row.project_id), state_dir=s.runtimes_dir / rid, unit=unit, port=info["port"], token=info["token"],
                               status="running", cpu_quota_pct=row.cpu_quota_pct, mem_max_mb=row.mem_max_mb, gpu_budget_mib=row.gpu_budget_mib, http=http,
                               python=_python_for(workspace_dir(row.owner_id, row.project_id)))
            rt.started_at = row.started_at.timestamp()
            async with db.session() as conn:
                ks = (await conn.execute(text(
                    "SELECT k.kernel_id, n.path FROM mangolab.kernel_sessions k JOIN mangolab.notebooks n ON n.id = k.notebook_id WHERE k.runtime_id = :r AND k.status <> 'dead'"), {"r": row.id})).all()
                acc = (await conn.execute(text("SELECT idle_timeout_min, disk_quota_mb FROM mangolab.lab_access WHERE user_id = :u"), {"u": row.owner_id})).first()
            rt.idle_timeout_min = acc.idle_timeout_min if acc else 60
            rt.disk_quota_mb = acc.disk_quota_mb if acc else 20480
            rt.disk = {"used_mb": None, "quota_mb": rt.disk_quota_mb}
            self._spawn(self._check_disk(rt))
            for k in ks:
                sess = self.session(rt, k.path)
                sess.kernel_id, sess.state = k.kernel_id, "idle"
            self.runtimes[row.project_id] = rt
            known.update({unit, self.driver.slice_name(rid)})
            log.info("re-adopted runtime %s (%d kernels)", rid[:8], len(ks))
        for unit in await self.driver.list_units():  # units with no database row are leftovers
            if unit not in known:
                log.warning("stopping orphan runtime unit %s", unit)
                await self.driver.stop_unit(unit)

    # ------------------------------------------------------------------ database bookkeeping (best effort: never breaks a running notebook)
    async def _db_insert(self, rt: RuntimeHandle) -> None:
        async with db.session() as c:
            await c.execute(text(
                "INSERT INTO mangolab.runtimes (id, project_id, owner_id, status, driver, port, gpu_budget_mib, cpu_quota_pct, mem_max_mb) "
                "VALUES (:id, :p, :o, 'starting', :d, :port, :g, :c, :m)"),
                {"id": uuid.UUID(rt.runtime_id), "p": rt.project_id, "o": rt.owner_id, "d": self.driver.name, "port": rt.port, "g": rt.gpu_budget_mib, "c": rt.cpu_quota_pct, "m": rt.mem_max_mb})
            await c.commit()

    async def _db_status(self, rt: RuntimeHandle, status: str) -> None:
        try:
            async with db.session() as c:
                await c.execute(text("UPDATE mangolab.runtimes SET status = :s, unit_name = :u, port = :port, last_activity_at = now() WHERE id = :id"),
                                {"s": status, "u": rt.unit, "port": rt.port, "id": uuid.UUID(rt.runtime_id)})
                await c.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not update runtime row")

    async def _db_stopped(self, rt: RuntimeHandle, status: str, detail: str | None) -> None:
        try:
            async with db.session() as c:
                await c.execute(text("UPDATE mangolab.runtimes SET status = :s, error = :e, stopped_at = now() WHERE id = :id"),
                                {"s": status, "e": detail, "id": uuid.UUID(rt.runtime_id)})
                await c.execute(text("UPDATE mangolab.kernel_sessions SET status = 'dead' WHERE runtime_id = :id"), {"id": uuid.UUID(rt.runtime_id)})
                await c.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not close runtime row")

    async def _db_mark_stopped(self, runtime_id: uuid.UUID) -> None:
        async with db.session() as c:
            await c.execute(text("UPDATE mangolab.runtimes SET status = 'stopped', stopped_at = now() WHERE id = :id"), {"id": runtime_id})
            await c.commit()

    async def _audit(self, user_id: str, username: str, type_: str, detail: str, status: str = "ok") -> None:
        try:
            async with db.session() as c:
                await log_event(c, type=type_, user_id=user_id, username=username, status=status, detail=detail)
                await c.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not write usage event")

    async def persist_kernel_created(self, sess: NotebookSession) -> None:
        try:
            async with db.session() as c:
                nb = (await c.execute(text("SELECT id FROM mangolab.notebooks WHERE project_id = :p AND path = :path"), {"p": sess.rt.project_id, "path": sess.path})).first()
                await c.execute(text(
                    "INSERT INTO mangolab.kernel_sessions (runtime_id, notebook_id, kernel_id, status) VALUES (:r, :n, :k, 'idle')"),
                    {"r": uuid.UUID(sess.rt.runtime_id), "n": nb.id if nb else None, "k": sess.kernel_id})
                await c.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not record kernel session")

    def persist_kernel_state(self, sess: NotebookSession) -> None:
        pass  # kernel state is live-only; the database keeps just the session's existence

    def record_execution(self, sess: NotebookSession, ex: Execution) -> None:
        async def go() -> None:
            try:
                async with db.session() as c:
                    nb = (await c.execute(text("SELECT id FROM mangolab.notebooks WHERE project_id = :p AND path = :path"), {"p": sess.rt.project_id, "path": sess.path})).first()
                    await c.execute(text(
                        "INSERT INTO mangolab.executions (user_id, notebook_id, cell_id, msg_id, status, error_name, queued_at, started_at, finished_at, duration_ms) "
                        "VALUES (:u, :n, :cell, :m, :s, :e, to_timestamp(:q), to_timestamp(:st), to_timestamp(:f), :d)"),
                        {"u": sess.rt.owner_id, "n": nb.id if nb else None, "cell": ex.cell_id, "m": ex.msg_id, "s": ex.state, "e": ex.error_name, "q": ex.queued_at,
                         "st": ex.started_at, "f": ex.finished_at, "d": int(((ex.finished_at or time.time()) - (ex.started_at or ex.queued_at)) * 1000)})
                    await c.commit()
            except Exception:  # noqa: BLE001
                log.exception("could not record execution")
        self._spawn(go())


def _python_for(workspace: Path) -> Path:
    """The project's overlay Python, or the shared one for a runtime that was started before projects had their own environment."""
    py = environments.overlay_python(workspace)
    return py if py.exists() else environments.base_python()


def _fmt_mb(mb: int) -> str:
    return f"{mb / 1024:g} GiB" if mb >= 1024 else f"{mb} MB"


async def _gpu_by_pid() -> dict[int, int]:
    """GPU memory (MiB) per process id, from nvidia-smi."""
    try:
        proc = await asyncio.create_subprocess_exec("nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits",
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, stdin=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), 8)
    except (OSError, asyncio.TimeoutError):
        return {}
    res: dict[int, int] = {}
    for line in out.decode().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[0].isdigit():
            res[int(parts[0])] = int(parts[1]) if parts[1].isdigit() else 0
    return res


manager = RuntimeManager()
