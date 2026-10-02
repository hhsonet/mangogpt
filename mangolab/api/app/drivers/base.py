from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class RuntimeSpec:
    runtime_id: str
    workspace: Path          # becomes the working directory of every kernel
    state_dir: Path          # private scratch for this runtime: jupyter runtime files, IPython dir, tmp (mode 700)
    port: int
    token: str
    cpu_quota_pct: int
    mem_max_mb: int
    gpu_budget_mib: int
    tasks_max: int = 1024


@dataclass(frozen=True)
class Usage:
    ram_mb: int | None
    cpu_usec: int | None     # cumulative CPU time, so callers can compute a rate
    pids: list[int]


class Driver(Protocol):
    name: str

    def unit_name(self, runtime_id: str) -> str: ...
    async def start(self, spec: RuntimeSpec) -> str: ...
    async def stop(self, unit: str) -> None: ...
    async def is_active(self, unit: str) -> bool: ...
    async def usage(self, unit: str) -> Usage: ...
    async def list_units(self) -> list[str]: ...
    async def logs(self, unit: str, lines: int = 15) -> str: ...
