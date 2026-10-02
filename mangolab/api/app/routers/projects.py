import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.errors import ApiError
from app.models import Project
from app.services import notebooks_io
from app.services.runtime_manager import manager
from app.services.projects import MAX_PROJECTS_PER_USER, forget_usage, get_owned_project, fs_for, projects_root, project_usage, slugify, workspace_dir
from app.services.safefs import SafeFS
from app.usage import log_event

router = APIRouter(prefix="/projects")


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    template: Literal["blank", "welcome"] = "welcome"


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    archived: bool | None = None


def view(p: Project, *, notebooks: int | None = None, used: int | None = None) -> dict:
    return {
        "id": str(p.id), "name": p.name, "slug": p.slug, "description": p.description, "archived": p.archived,
        "created_at": p.created_at.isoformat(), "updated_at": p.updated_at.isoformat(),
        "last_opened_at": p.last_opened_at.isoformat() if p.last_opened_at else None,
        **({"notebook_count": notebooks} if notebooks is not None else {}), **({"used_bytes": used} if used is not None else {}),
    }


@router.get("")
async def list_projects(archived: bool = False, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    rows = (await db.execute(select(Project).where(Project.owner_id == user.id, Project.archived == archived).order_by(func.coalesce(Project.last_opened_at, Project.created_at).desc()))).scalars().all()
    counts = dict((await db.execute(text("SELECT project_id, count(*) FROM mangolab.notebooks WHERE project_id IN (SELECT id FROM mangolab.projects WHERE owner_id = :u) GROUP BY project_id"), {"u": user.id})).all())
    out = [view(p, notebooks=int(counts.get(p.id, 0)), used=await project_usage(p)) for p in rows]
    return {"projects": out, "limits": {"max_projects": MAX_PROJECTS_PER_USER, "disk_quota_mb": access.disk_quota_mb}}


@router.post("", status_code=201)
async def create_project(body: ProjectCreate, request: Request, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    name = body.name.strip()
    if not name:
        raise ApiError(422, "bad_request", "Give the project a name.")
    count = (await db.execute(select(func.count()).select_from(Project).where(Project.owner_id == user.id))).scalar_one()
    if count >= MAX_PROJECTS_PER_USER:
        raise ApiError(409, "limit_reached", f"You can have up to {MAX_PROJECTS_PER_USER} projects. Delete one first.")
    project_id = uuid.uuid4()
    base = slugify(name)
    slug, n = base, 1
    taken = set((await db.execute(select(Project.slug).where(Project.owner_id == user.id))).scalars().all())
    while slug in taken:
        n += 1
        slug = f"{base}-{n}"
    wdir = workspace_dir(user.id, project_id)
    wdir.mkdir(parents=True, mode=0o700)
    fs = SafeFS(wdir)
    fs.internal().mkdir(".mangolab")
    fs.write_atomic("README.md", f"# {name}\n\n{body.description}\n".encode(), exclusive=True)
    if body.template == "welcome":
        fs.write_atomic("welcome.ipynb", notebooks_io.dumps(notebooks_io.welcome_notebook()), exclusive=True)
    p = Project(id=project_id, owner_id=user.id, name=name, slug=slug, description=body.description.strip(), workspace_path=f"users/{user.id}/projects/{project_id}")
    db.add(p)
    try:
        await db.flush()
    except IntegrityError as e:
        raise ApiError(409, "exists", "A project with that name already exists.") from e
    await log_event(db, type="lab", user_id=user.id, username=user.username, detail=f"created project “{name}”", ip=request.client.host if request.client else None)
    await db.commit()
    await db.refresh(p)
    return view(p, notebooks=0, used=await project_usage(p))


@router.get("/{project_id}")
async def get_project(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    p = await get_owned_project(db, user, project_id)
    p.last_opened_at = datetime.now(timezone.utc)
    await db.commit()
    used = await project_usage(p)
    return {**view(p, used=used), "limits": {"disk_quota_mb": access.disk_quota_mb}}


@router.patch("/{project_id}")
async def patch_project(project_id: uuid.UUID, body: ProjectPatch, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    if body.name is not None:
        if not body.name.strip():
            raise ApiError(422, "bad_request", "Give the project a name.")
        p.name = body.name.strip()
    if body.description is not None:
        p.description = body.description.strip()
    if body.archived is not None:
        p.archived = body.archived
    p.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return view(p)


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, request: Request, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> None:
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    # Phase 2 will stop the project's runtime here first.
    await manager.stop(p.id, reason="project_deleted", actor=user)  # never leave a runtime running on a deleted workspace
    await run_in_threadpool(SafeFS(projects_root(user.id)).remove, str(p.id))  # removes the folder tree; links inside are deleted, never followed
    await db.delete(p)
    await log_event(db, type="lab", user_id=user.id, username=user.username, detail=f"deleted project “{p.name}”", ip=request.client.host if request.client else None)
    await db.commit()
    forget_usage(p.id)
