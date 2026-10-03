"""Each project gets its own Python environment, layered on the shared one.

The shared environment (CUDA PyTorch, NumPy, pandas, matplotlib...) is installed once. A project's *overlay* is a small virtual
environment inside its workspace (`.mangolab/venv`) with its own `pip`; a `.pth` file makes the shared packages visible, so `pip`
sees them as already installed (no second copy of PyTorch) and anything a project installs takes priority only for that project.
The kernel gateway runs on the overlay's Python, so notebooks, terminals and `%pip install` all see the same packages."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sysconfig
from pathlib import Path

from starlette.concurrency import run_in_threadpool

INTERNAL = ".mangolab"
UV = Path.home() / ".local" / "bin" / "uv"
LIST_CODE = "import importlib.metadata as m, json, sys; print(json.dumps(sorted({(d.metadata['Name'] or '').lower(): d.version for d in m.distributions(path=sys.argv[1:])}.items())))"
_creating: dict[str, asyncio.Lock] = {}
_base_cache: list[list[str]] | None = None


def base_python() -> Path:
    return Path(os.environ.get("MANGOLAB_BASE_PYTHON") or Path.home() / ".venvs/mangolab-base/bin/python")


def overlay_dir(workspace: Path) -> Path:
    return workspace / INTERNAL / "venv"


def overlay_python(workspace: Path) -> Path:
    return overlay_dir(workspace) / "bin" / "python"


def _purelib(python: Path) -> str:
    out = os.popen(f"{python} -c \"import sysconfig;print(sysconfig.get_paths()['purelib'])\"").read().strip()  # noqa: S605 - fixed command, path from our config
    return out


async def _run(*argv: str, timeout: float = 120) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(errors="replace")


async def _healthy(workspace: Path) -> bool:
    py = overlay_python(workspace)
    if not py.exists():
        return False
    code, out = await _run(str(py), "-c", "import kernel_gateway, ipykernel, sys; print('ok')", timeout=30)
    return code == 0 and out.strip() == "ok"


async def ensure_overlay(workspace: Path) -> Path:
    """Creates the project's overlay environment if it does not exist (about a second) and returns its Python."""
    lock = _creating.setdefault(str(workspace), asyncio.Lock())
    async with lock:
        if await _healthy(workspace):
            return overlay_python(workspace)
        d = overlay_dir(workspace)
        await run_in_threadpool(shutil.rmtree, d, True)
        d.parent.mkdir(parents=True, exist_ok=True)
        code, out = await _run(str(UV), "venv", "--python", str(base_python()), "--seed", "--quiet", str(d))
        if code != 0:
            raise RuntimeError(f"could not create the project environment: {out.strip()[:300]}")
        site = Path(_purelib(overlay_python(workspace)))
        (site / "mangolab_base.pth").write_text(_purelib(base_python()) + "\n")  # shared packages come after the project's own
        if not await _healthy(workspace):
            raise RuntimeError("the project environment does not see the shared packages")
        return overlay_python(workspace)


async def reset_overlay(workspace: Path) -> None:
    await run_in_threadpool(shutil.rmtree, overlay_dir(workspace), True)


async def list_overlay(workspace: Path) -> list[dict[str, str]]:
    """Packages installed in this project (not the shared ones)."""
    py = overlay_python(workspace)
    if not py.exists():
        return []
    site = await run_in_threadpool(_purelib, py)
    code, out = await _run(str(py), "-c", LIST_CODE, site, timeout=30)
    if code != 0:
        return []
    return [{"name": n, "version": v} for n, v in json.loads(out) if n not in ("pip", "setuptools", "wheel")]


async def list_shared() -> list[dict[str, str]]:
    global _base_cache
    if _base_cache is None:
        site = await run_in_threadpool(_purelib, base_python())
        code, out = await _run(str(base_python()), "-c", LIST_CODE, site, timeout=30)
        _base_cache = json.loads(out) if code == 0 else []
    return [{"name": n, "version": v} for n, v in _base_cache]
