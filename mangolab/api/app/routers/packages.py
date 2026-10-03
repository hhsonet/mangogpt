import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.errors import ApiError
from app.services import environments
from app.services.packages import packages
from app.services.projects import get_owned_project, workspace_dir
from app.services.runtime_manager import manager

router = APIRouter(prefix="/projects/{project_id}/packages")


class PackageRequest(BaseModel):
    specs: list[str] = Field(min_length=1, max_length=20)


def job_view(j) -> dict:
    return {"id": j.id, "action": j.action, "specs": j.specs, "status": j.status, "exit_code": j.exit_code}


@router.get("")
async def list_packages(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    ws = workspace_dir(p.owner_id, p.id)
    running = packages.running_for_project(p.id)
    return {"installed": await environments.list_overlay(ws), "shared": await environments.list_shared(), "job": job_view(running) if running else None}


@router.post("/install", status_code=202)
async def install(project_id: uuid.UUID, body: PackageRequest, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    p = await get_owned_project(db, user, project_id)
    return job_view(await packages.start(p, user, access, "install", body.specs, manager))


@router.post("/uninstall", status_code=202)
async def uninstall(project_id: uuid.UUID, body: PackageRequest, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    p = await get_owned_project(db, user, project_id)
    return job_view(await packages.start(p, user, access, "uninstall", body.specs, manager))


@router.get("/jobs/{job_id}")
async def job(project_id: uuid.UUID, job_id: str, offset: int = Query(default=0, ge=0), lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    j = packages.get(job_id, user, project_id)
    log, nxt = packages.read_log(j, offset)
    return {**job_view(j), "log": log, "next_offset": nxt}


@router.delete("/jobs/{job_id}")
async def cancel(project_id: uuid.UUID, job_id: str, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    j = packages.get(job_id, user, project_id)
    await packages.cancel(j)
    return job_view(j)


@router.delete("/environment")
async def reset_environment(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    """Removes everything installed in this project (the shared packages stay). The runtime must be disconnected first."""
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    if manager.get(p.id):
        raise ApiError(409, "runtime_running", "Disconnect the runtime first, then reset the packages.")
    if packages.running_for_project(p.id):
        raise ApiError(409, "busy", "A package job is still running.")
    await environments.reset_overlay(workspace_dir(p.owner_id, p.id))
    return {"installed": []}
