import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.errors import ApiError
from app.services.projects import get_owned_project
from app.services.runtime_manager import manager
from app.services.terminals import terminals

router = APIRouter(prefix="/projects/{project_id}/terminals")


@router.get("")
async def list_terminals(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    rt = manager.get(project_id)
    return {"terminals": [t.view() for t in terminals.for_runtime(rt.runtime_id)] if rt else []}


@router.post("", status_code=201)
async def create_terminal(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    rt = manager.get(project_id)
    if not rt:
        raise ApiError(409, "no_runtime", "Connect a runtime first, then open a terminal.")
    t = await terminals.create(manager, rt)
    await manager._audit(user.id, user.username, "lab.terminal", f"opened in {rt.project_name}")  # noqa: SLF001
    return t.view()


@router.delete("/{terminal_id}")
async def close_terminal(project_id: uuid.UUID, terminal_id: str, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    rt = manager.get(project_id)
    t = terminals.get(rt, terminal_id) if rt else None
    if t:
        terminals.close(t)
    return {"closed": True}
