"""Runs each runtime as a transient systemd *user* service: a cgroup with hard CPU, memory and process limits, no root required."""
from __future__ import annotations

import asyncio
import os

from pathlib import Path

from .base import RuntimeSpec, Usage

CGROOT = Path("/sys/fs/cgroup")
PREFIX = "mangolab-rt-"


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

    def __init__(self, python: str | None = None) -> None:
        # The kernel environment: CUDA PyTorch, matplotlib, pandas... lives outside the repo.
        self.python = python or os.environ.get("MANGOLAB_BASE_PYTHON") or str(Path.home() / ".venvs/mangolab-base/bin/python")

    def unit_name(self, runtime_id: str) -> str:
        return f"{PREFIX}{runtime_id[:12]}.service"

    async def start(self, spec: RuntimeSpec) -> str:
        unit = self.unit_name(spec.runtime_id)
        bindir = str(Path(self.python).parent)
        threads = str(max(1, spec.cpu_quota_pct // 100))  # keep BLAS/OpenMP pools within the CPU quota
        env = {
            "KG_IP": "127.0.0.1", "KG_PORT": str(spec.port), "KG_AUTH_TOKEN": spec.token,
            "PATH": f"{bindir}:/usr/local/bin:/usr/bin:/bin", "PYTHONUNBUFFERED": "1",
            "JUPYTER_RUNTIME_DIR": str(spec.state_dir / "jupyter-runtime"), "JUPYTER_DATA_DIR": str(spec.state_dir / "jupyter-data"),
            "IPYTHONDIR": str(spec.state_dir / "ipython"), "TMPDIR": str(spec.state_dir / "tmp"),
            "OMP_NUM_THREADS": threads, "MKL_NUM_THREADS": threads, "OPENBLAS_NUM_THREADS": threads,
            "MANGOLAB_GPU_BUDGET_MIB": str(spec.gpu_budget_mib), "MANGOLAB_WORKSPACE": str(spec.workspace),
            "MPLBACKEND": "module://matplotlib_inline.backend_inline", "TERM": "xterm-256color", "HOME": str(Path.home()),
        }
        for sub in ("jupyter-runtime", "jupyter-data", "ipython", "tmp"):
            (spec.state_dir / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
        argv = [
            "systemd-run", "--user", f"--unit={unit}", "--collect", "--quiet", f"--working-directory={spec.workspace}",
            "-p", f"MemoryMax={spec.mem_max_mb}M", "-p", "MemorySwapMax=0", "-p", f"CPUQuota={spec.cpu_quota_pct}%", "-p", f"TasksMax={spec.tasks_max}",
            "-p", "OOMPolicy=continue",   # an over-limit kernel is killed alone; the gateway and the other kernels survive
            "-p", "KillMode=control-group", "-p", "TimeoutStopSec=8",
            *[f"--setenv={k}={v}" for k, v in env.items()],
            "--", self.python, "-m", "kernel_gateway", "--JupyterWebsocketPersonality.list_kernels=True", "--KernelGatewayApp.default_kernel_name=python3",
            "--JupyterApp.answer_yes=True", "--log-level=WARN",
        ]
        code, out = await _run(*argv)
        if code != 0:
            raise RuntimeError(f"systemd-run failed ({code}): {out.strip()[:300]}")
        return unit

    async def stop(self, unit: str) -> None:
        await _run("systemctl", "--user", "stop", unit, timeout=30)

    async def is_active(self, unit: str) -> bool:
        code, out = await _run("systemctl", "--user", "is-active", unit)
        return out.strip() in ("active", "activating")

    async def _cgroup(self, unit: str) -> Path | None:
        code, out = await _run("systemctl", "--user", "show", unit, "-p", "ControlGroup", "--value")
        rel = out.strip()
        return CGROOT / rel.lstrip("/") if code == 0 and rel else None

    async def usage(self, unit: str) -> Usage:
        cg = await self._cgroup(unit)
        if not cg or not cg.exists():
            return Usage(None, None, [])
        try:
            ram = int((cg / "memory.current").read_text()) // (1024 * 1024)
            cpu = next((int(line.split()[1]) for line in (cg / "cpu.stat").read_text().splitlines() if line.startswith("usage_usec")), None)
            pids = [int(p) for p in (cg / "cgroup.procs").read_text().split()]
        except (OSError, ValueError):
            return Usage(None, None, [])
        return Usage(ram, cpu, pids)

    async def list_units(self) -> list[str]:
        code, out = await _run("systemctl", "--user", "list-units", f"{PREFIX}*", "--all", "--no-legend", "--plain", "--no-pager")
        return [line.split()[0] for line in out.splitlines() if line.strip().startswith(PREFIX)] if code == 0 else []

    async def logs(self, unit: str, lines: int = 15) -> str:
        _, out = await _run("journalctl", "--user", "-u", unit, "-n", str(lines), "--no-pager", "-o", "cat")
        return out.strip()



