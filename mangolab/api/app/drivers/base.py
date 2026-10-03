from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class RuntimeSpec:
    runtime_id: str
    workspace: Path          # becomes the working directory of every kernel and terminal
    state_dir: Path          # private scratch for this runtime: jupyter runtime files, IPython dir, tmp (mode 700)
    python: Path             # the project's Python (its overlay environment); runs the gateway, so kernels use it
    port: int
    token: str
    cpu_quota_pct: int
    mem_max_mb: int
    gpu_budget_mib: int
    tasks_max: int = 1024


@dataclass
class Usage:
    ram_mb: int | None = None
    cpu_usec: int | None = None      # cumulative CPU time, so callers can compute a rate
    oom_kills: int = 0               # cumulative number of processes the kernel's OOM killer ended in this runtime
    pids: list[int] = field(default_factory=list)  # every process in the runtime (kernels, terminals, installs)


class Driver(Protocol):
    name: str

    def unit_name(self, runtime_id: str) -> str: ...
    def slice_name(self, runtime_id: str) -> str: ...
    async def start(self, spec: RuntimeSpec) -> str: ...
    async def stop(self, runtime_id: str) -> None: ...
    async def stop_unit(self, name: str) -> None: ...
    async def is_active(self, unit: str) -> bool: ...
    async def usage(self, runtime_id: str) -> Usage: ...
    async def list_units(self) -> list[str]: ...
    async def logs(self, unit: str, lines: int = 15) -> str: ...
    def scope_argv(self, runtime_id: str, name: str, *, properties: list[str] | None = None) -> list[str]: ...
