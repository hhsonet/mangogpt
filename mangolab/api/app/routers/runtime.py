import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.services.projects import get_owned_project
from app.services.runtime_manager import manager

router = APIRouter()


@router.get("/projects/{project_id}/runtime")
async def runtime_status(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    await get_owned_project(db, user, project_id)
    return {**manager.status(project_id), "limits_allowed": {"max_runtimes": access.max_runtimes, "idle_timeout_min": access.idle_timeout_min}}


@router.post("/projects/{project_id}/runtime", status_code=202)
async def start_runtime(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    """Starts the project's runtime in the background and returns at once; progress arrives on the project WebSocket (or poll GET)."""
    user, access = lab
    project = await get_owned_project(db, user, project_id)
    rt = await manager.start(project, user, access)
    return rt.view()


@router.delete("/projects/{project_id}/runtime")
async def stop_runtime(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    await manager.stop(project_id, reason="user", actor=user)
    return {"status": "none"}


@router.get("/runtimes")
async def my_runtimes(lab: tuple[User, LabAccess] = Depends(require_lab)) -> dict:
    """The caller's running runtimes, so the UI can say which one to stop when the limit is reached."""
    user, _ = lab
    return {"runtimes": [r.view() for r in manager.for_user(user.id)]}


@router.get("/projects/{project_id}/runtime/history")
async def runtime_history(project_id: uuid.UUID, minutes: int = Query(default=15, ge=1, le=1440), lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    """RAM, GPU and CPU samples for the charts (every 5 s for the last 30 minutes, every 15 s up to a day)."""
    user, _ = lab
    await get_owned_project(db, user, project_id)
    return {"samples": await manager.history(project_id, minutes)}
