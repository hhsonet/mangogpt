"""Installing and removing Python packages for a project, as short background jobs with a log the browser can follow."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import text

from app import db
from app.config import get_settings
from app.deps import LabAccess, User
from app.errors import ApiError
from app.models import Project
from app.services import environments
from app.services.projects import user_usage, workspace_dir
from app.usage import log_event

log = logging.getLogger("mangolab.packages")

NAME = r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
CLAUSE = r"(?:===|==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]+"
SPEC_RE = re.compile(rf"^{NAME}(?:\[[A-Za-z0-9,._-]+\])?\s*(?:{CLAUSE}(?:\s*,\s*{CLAUSE})*)?$")
NAME_RE = re.compile(rf"^{NAME}$")
MAX_SPECS = 20
JOB_TIMEOUT_S = 900
MAX_LOG = 65536


def bus_env() -> dict[str, str]:
    """What `systemd-run --user` needs to reach the user manager (the rest of the environment is deliberately minimal)."""
    return {k: os.environ[k] for k in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS") if k in os.environ}


def validate(specs: list[str], *, names_only: bool = False) -> list[str]:
    """Only plain requirements: a name, optional extras and version clauses. No options, URLs, paths or VCS links."""
    clean = [s.strip() for s in specs if s and s.strip()]
    if not clean:
        raise ApiError(422, "bad_request", "Enter at least one package, for example: scikit-learn  or  transformers==4.45.0")
    if len(clean) > MAX_SPECS:
        raise ApiError(422, "bad_request", f"Install up to {MAX_SPECS} packages at a time.")
    for s in clean:
        if len(s) > 200 or not (NAME_RE if names_only else SPEC_RE).match(s):
            raise ApiError(422, "bad_request", f"“{s[:60]}” isn’t a package name pip understands. Use a name, optionally with a version, like numpy>=2.")
    return clean


@dataclass
class Job:
    id: str
    project_id: uuid.UUID
    user_id: str
    action: str
    specs: list[str]
    log_path: Path
    status: str = "running"            # running | ok | error | timeout
    exit_code: int | None = None
    started: float = field(default_factory=time.time)
    proc: asyncio.subprocess.Process | None = None


class PackageService:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}

    def _dir(self) -> Path:
        d = get_settings().data_dir / "jobs"
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        return d

    def running_for_project(self, project_id: uuid.UUID) -> Job | None:
        return next((j for j in self.jobs.values() if j.project_id == project_id and j.status == "running"), None)

    async def start(self, project: Project, user: User, access: LabAccess, action: str, specs: list[str], manager) -> Job:
        specs = validate(specs, names_only=action == "uninstall")
        if self.running_for_project(project.id):
            raise ApiError(409, "busy", "A package job is already running for this project. Wait for it to finish.")
        used = await user_usage_safe(user, access)
        if used > 0.95 * access.disk_quota_mb * 1024 * 1024:
            raise ApiError(413, "quota_exceeded", "Your workspace is almost full. Free some space before installing packages.")
        ws = workspace_dir(project.owner_id, project.id)
        py = await environments.ensure_overlay(ws)
        jid = uuid.uuid4().hex
        path = self._dir() / f"{jid}.log"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        pip = [str(py), "-m", "pip", "--disable-pip-version-check", "--no-input"]
        cmd = [*pip, "install", "--progress-bar", "off", *specs] if action == "install" else [*pip, "uninstall", "-y", *specs]
        rt = manager.get(project.id)
        unit = f"mangolab-pip-{jid[:12]}"
        if rt and rt.status == "running":
            prefix = manager.driver.scope_argv(rt.runtime_id, unit, properties=[f"RuntimeMaxSec={JOB_TIMEOUT_S}"])  # shares the runtime's limits
        else:
            prefix = ["systemd-run", "--user", "--scope", "--quiet", f"--unit={unit}", "-p", f"MemoryMax={min(access.mem_max_mb, 4096)}M", "-p", "MemorySwapMax=0",
                      "-p", f"CPUQuota={access.cpu_quota_pct}%", "-p", "TasksMax=512", "-p", "OOMPolicy=continue", "-p", f"RuntimeMaxSec={JOB_TIMEOUT_S}", "--"]
        env = {"PATH": f"{py.parent}:/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8", "VIRTUAL_ENV": str(py.parent.parent),
               "PIP_CACHE_DIR": str(Path.home() / ".cache" / "mangolab-pip"), "TMPDIR": str(self._dir()), "PYTHONUNBUFFERED": "1", **bus_env()}
        os.write(fd, f"$ pip {action} {' '.join(specs)}\n".encode())
        proc = await asyncio.create_subprocess_exec(*prefix, *cmd, stdout=fd, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL, cwd=ws, env=env)
        os.close(fd)
        job = Job(jid, project.id, user.id, action, specs, path, proc=proc)
        self.jobs[jid] = job
        async with db.session() as c:
            await c.execute(text("INSERT INTO mangolab.package_jobs (id, runtime_id, user_id, specs, status, log_path) VALUES (:id, :r, :u, :s, 'running', :l)"),
                            {"id": uuid.UUID(jid), "r": uuid.UUID(rt.runtime_id) if rt else None, "u": user.id, "s": [f"{action}:{s}" for s in specs], "l": str(path)})
            await c.commit()
        asyncio.create_task(self._watch(job, user, project, manager))
        return job

    async def _watch(self, job: Job, user: User, project: Project, manager) -> None:
        assert job.proc is not None
        try:
            code = await asyncio.wait_for(job.proc.wait(), JOB_TIMEOUT_S + 30)
        except asyncio.TimeoutError:
            job.proc.kill()
            code = -9
        job.exit_code = code
        job.status = "ok" if code == 0 else "timeout" if code in (-9, -15, 143, 137) and time.time() - job.started >= JOB_TIMEOUT_S else "error"
        try:
            async with db.session() as c:
                await c.execute(text("UPDATE mangolab.package_jobs SET status = :s, exit_code = :e, finished_at = now() WHERE id = :id"), {"s": job.status, "e": code, "id": uuid.UUID(job.id)})
                await log_event(c, type="lab.packages", user_id=user.id, username=user.username, status="ok" if job.status == "ok" else "error",
                                detail=f"{job.action} {' '.join(job.specs)} in {project.name}: {job.status}")
                await c.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not record package job")
        rt = manager.get(project.id)
        if rt:
            rt.broadcast({"type": "packages", "job_id": job.id, "status": job.status})
        if len(self.jobs) > 200:
            for k in [k for k, j in self.jobs.items() if j.status != "running"][:50]:
                self.jobs.pop(k, None)

    def get(self, job_id: str, user: User, project_id: uuid.UUID) -> Job:
        j = self.jobs.get(job_id)
        if not j or j.user_id != user.id or j.project_id != project_id:
            raise ApiError(404, "not_found", "That job doesn't exist (it may be old).")
        return j

    @staticmethod
    def read_log(job: Job, offset: int) -> tuple[str, int]:
        try:
            with open(job.log_path, "rb") as f:
                f.seek(max(0, offset))
                data = f.read(MAX_LOG)
        except OSError:
            return "", offset
        return data.decode(errors="replace"), offset + len(data)

    async def cancel(self, job: Job) -> None:
        if job.proc and job.status == "running":
            job.proc.terminate()

    async def cleanup_old_logs(self) -> None:
        cutoff = time.time() - 7 * 86400
        for p in self._dir().glob("*.log"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass


async def user_usage_safe(user: User, access: LabAccess) -> int:
    async with db.session() as c:
        return await user_usage(c, user)


packages = PackageService()
