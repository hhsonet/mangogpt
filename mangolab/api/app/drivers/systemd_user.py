"""Runs each runtime as a transient systemd *user* slice: one cgroup with hard CPU, memory and process limits that the
Kernel Gateway (and so every kernel), terminals and package installs all share. No root required."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from .base import RuntimeSpec, Usage

CGROOT = Path("/sys/fs/cgroup")
PREFIX = "mangolab-rt-"
SLICE_PREFIX = "mangolabrt"   # no dash: a dash would make systemd nest the slice under another one


async def _run(*argv: str, timeout: float = 20) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(errors="replace")


class SystemdUserDriver:
    name = "systemd-user"

    def __init__(self) -> None:
        self._cg: dict[str, Path] = {}

    def unit_name(self, runtime_id: str) -> str:
        return f"{PREFIX}{runtime_id[:12]}.service"

    def slice_name(self, runtime_id: str) -> str:
        return f"{SLICE_PREFIX}{runtime_id[:12]}.slice"

    async def start(self, spec: RuntimeSpec) -> str:
        unit, slc = self.unit_name(spec.runtime_id), self.slice_name(spec.runtime_id)
        # The slice carries the limits, so everything started inside it (gateway, terminals, installs) shares one budget.
        code, out = await _run("systemctl", "--user", "start", slc)
        if code == 0:
            code, out = await _run("systemctl", "--user", "set-property", "--runtime", slc, f"MemoryMax={spec.mem_max_mb}M", "MemorySwapMax=0",
                                   f"CPUQuota={spec.cpu_quota_pct}%", f"TasksMax={spec.tasks_max}")
        if code != 0:
            raise RuntimeError(f"could not create the resource group ({code}): {out.strip()[:300]}")
        bindir = str(spec.python.parent)
        threads = str(max(1, spec.cpu_quota_pct // 100))  # keep BLAS/OpenMP pools within the CPU quota
        env = {
            "KG_IP": "127.0.0.1", "KG_PORT": str(spec.port), "KG_AUTH_TOKEN": spec.token,
            "PATH": f"{bindir}:/usr/local/bin:/usr/bin:/bin", "PYTHONUNBUFFERED": "1", "VIRTUAL_ENV": str(spec.python.parent.parent),
            "JUPYTER_RUNTIME_DIR": str(spec.state_dir / "jupyter-runtime"), "JUPYTER_DATA_DIR": str(spec.state_dir / "jupyter-data"),
            "IPYTHONDIR": str(spec.state_dir / "ipython"), "TMPDIR": str(spec.state_dir / "tmp"),
            "PIP_CACHE_DIR": str(Path.home() / ".cache" / "mangolab-pip"), "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "OMP_NUM_THREADS": threads, "MKL_NUM_THREADS": threads, "OPENBLAS_NUM_THREADS": threads,
            "MANGOLAB_GPU_BUDGET_MIB": str(spec.gpu_budget_mib), "MANGOLAB_WORKSPACE": str(spec.workspace),
            "MPLBACKEND": "module://matplotlib_inline.backend_inline", "TERM": "xterm-256color", "HOME": str(Path.home()), "LANG": "C.UTF-8",
        }
        for sub in ("jupyter-runtime", "jupyter-data", "ipython", "tmp"):
            (spec.state_dir / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
        argv = [
            "systemd-run", "--user", f"--unit={unit}", f"--slice={slc}", "--collect", "--quiet", f"--working-directory={spec.workspace}",
            "-p", "OOMPolicy=continue",   # an over-limit kernel is killed alone; the gateway and the other kernels survive
            "-p", "KillMode=control-group", "-p", "TimeoutStopSec=8", "-p", "LimitNOFILE=8192", "-p", "LimitCORE=0",
            *[f"--setenv={k}={v}" for k, v in env.items()],
            "--", str(spec.python), "-m", "kernel_gateway", "--JupyterWebsocketPersonality.list_kernels=True", "--KernelGatewayApp.default_kernel_name=python3",
            "--JupyterApp.answer_yes=True", "--log-level=WARN",
        ]
        code, out = await _run(*argv)
        if code != 0:
            await self.stop(spec.runtime_id)
            raise RuntimeError(f"systemd-run failed ({code}): {out.strip()[:300]}")
        return unit

    async def stop(self, runtime_id: str) -> None:
        # Stopping the slice stops everything inside it: the gateway and its kernels, terminals, installs.
        await _run("systemctl", "--user", "stop", self.unit_name(runtime_id), self.slice_name(runtime_id), timeout=40)
        self._cg.pop(runtime_id, None)

    async def stop_unit(self, name: str) -> None:
        """Stops any unit or slice by name (used to clean up leftovers that no database row knows about)."""
        await _run("systemctl", "--user", "stop", name, timeout=40)

    async def is_active(self, unit: str) -> bool:
        code, out = await _run("systemctl", "--user", "is-active", unit)
        return out.strip() in ("active", "activating")

    async def _cgroup(self, runtime_id: str) -> Path | None:
        hit = self._cg.get(runtime_id)
        if hit and hit.exists():
            return hit
        code, out = await _run("systemctl", "--user", "show", self.slice_name(runtime_id), "-p", "ControlGroup", "--value")
        rel = out.strip()
        if code != 0 or not rel:
            return None
        path = CGROOT / rel.lstrip("/")
        if path.exists():
            self._cg[runtime_id] = path
            return path
        return None

    async def usage(self, runtime_id: str) -> Usage:
        cg = await self._cgroup(runtime_id)
        if cg is None:
            return Usage()
        u = Usage()
        try:
            u.ram_mb = int((cg / "memory.current").read_text()) // (1024 * 1024)
            u.cpu_usec = next((int(line.split()[1]) for line in (cg / "cpu.stat").read_text().splitlines() if line.startswith("usage_usec")), None)
            u.oom_kills = next((int(line.split()[1]) for line in (cg / "memory.events").read_text().splitlines() if line.startswith("oom_kill ")), 0)
            for base, _dirs, files in os.walk(cg):
                if "cgroup.procs" in files:
                    u.pids += [int(p) for p in (Path(base) / "cgroup.procs").read_text().split()]
        except (OSError, ValueError):
            pass
        return u

    async def list_units(self) -> list[str]:
        """Runtime service units and their slices (so leftovers of either kind can be cleaned up)."""
        code, out = await _run("systemctl", "--user", "list-units", f"{PREFIX}*", f"{SLICE_PREFIX}*", "--all", "--no-legend", "--plain", "--no-pager")
        return [line.split()[0] for line in out.splitlines() if line.strip().startswith((PREFIX, SLICE_PREFIX))] if code == 0 else []

    async def logs(self, unit: str, lines: int = 15) -> str:
        _, out = await _run("journalctl", "--user", "-u", unit, "-n", str(lines), "--no-pager", "-o", "cat")
        return out.strip()

    def scope_argv(self, runtime_id: str, name: str, *, properties: list[str] | None = None) -> list[str]:
        """Prefix for a command that must run inside this runtime's resource group (a terminal, an install)."""
        return ["systemd-run", "--user", "--scope", "--quiet", f"--slice={self.slice_name(runtime_id)}", f"--unit={name}", "-p", "OOMPolicy=continue",
                *[a for p in (properties or []) for a in ("-p", p)], "--"]
