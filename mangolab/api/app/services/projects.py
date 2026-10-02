"""Projects: a workspace directory per project plus a row in mangolab.projects."""
from __future__ import annotations

import re
import time
import unicodedata
import uuid
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.deps import LabAccess, User
from app.errors import ApiError
from app.models import Project
from app.services.safefs import SafeFS

MAX_PROJECTS_PER_USER = 50
_usage_cache: dict[uuid.UUID, tuple[float, int]] = {}
USAGE_TTL_S = 15


def projects_root(user_id: str) -> Path:
    return get_settings().data_dir / "users" / user_id / "projects"


def workspace_dir(user_id: str, project_id: uuid.UUID) -> Path:
    return projects_root(user_id) / str(project_id)


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:48] or "project"


async def get_owned_project(db: AsyncSession, user: User, project_id: uuid.UUID) -> Project:
    """Owner-only for now (sharing comes later). Someone else's project looks exactly like one that doesn't exist."""
    p = (await db.execute(select(Project).where(Project.id == project_id, Project.owner_id == user.id))).scalar_one_or_none()
    if not p:
        raise ApiError(404, "not_found", "Project not found.")
    return p


def fs_for(project: Project) -> SafeFS:
    return SafeFS(workspace_dir(project.owner_id, project.id))


async def project_usage(project: Project) -> int:
    hit = _usage_cache.get(project.id)
    if hit and time.monotonic() - hit[0] < USAGE_TTL_S:
        return hit[1]
    used = await run_in_threadpool(fs_for(project).disk_usage)
    _usage_cache[project.id] = (time.monotonic(), used)
    return used


def forget_usage(project_id: uuid.UUID) -> None:
    _usage_cache.pop(project_id, None)


async def user_usage(db: AsyncSession, user: User) -> int:
    projects = (await db.execute(select(Project).where(Project.owner_id == user.id))).scalars().all()
    return sum([await project_usage(p) for p in projects])


async def ensure_quota(db: AsyncSession, user: User, access: LabAccess, incoming: int) -> None:
    quota = access.disk_quota_mb * 1024 * 1024
    if await user_usage(db, user) + max(incoming, 0) > quota:
        raise ApiError(413, "quota_exceeded", f"This would exceed your {access.disk_quota_mb // 1024} GiB workspace limit. Delete some files first.")


async def rewrite_notebook_paths(db: AsyncSession, project_id: uuid.UUID, old: str, new: str | None) -> None:
    """Keep notebook rows in step with the file system when a path is renamed (new set) or deleted (new is None)."""
    if new is None:
        await db.execute(text("DELETE FROM mangolab.notebooks WHERE project_id = :p AND (path = :o OR starts_with(path, :o || '/'))"), {"p": project_id, "o": old})
    else:
        await db.execute(text(
            "UPDATE mangolab.notebooks SET path = :n || substr(path, length(:o) + 1), name = CASE WHEN path = :o THEN :name ELSE name END "
            "WHERE project_id = :p AND (path = :o OR starts_with(path, :o || '/'))"
        ), {"p": project_id, "o": old, "n": new, "name": new.rsplit("/", 1)[-1]})
