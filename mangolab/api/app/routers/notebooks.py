import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.errors import ApiError
from app.services import notebooks_io
from app.services.projects import ensure_quota, forget_usage, fs_for, get_owned_project
from app.services.safefs import FsError, clean_path
from app.usage import log_event

router = APIRouter(prefix="/projects/{project_id}/notebooks")

REVISION_EVERY_S = 300
MAX_REVISIONS = 30
_locks: dict[tuple[uuid.UUID, str], asyncio.Lock] = {}


def lock_for(project_id: uuid.UUID, path: str) -> asyncio.Lock:
    """One save at a time per notebook, so the conflict check and the write can't interleave."""
    if len(_locks) > 2000:
        _locks.clear()
    return _locks.setdefault((project_id, path), asyncio.Lock())


def nb_path(raw: str) -> str:
    path = "/".join(clean_path(raw))
    if not path.endswith(".ipynb"):
        raise ApiError(422, "bad_request", "A notebook's name must end in .ipynb.")
    return path


async def ensure_row(db: AsyncSession, project_id: uuid.UUID, path: str) -> tuple[uuid.UUID, int]:
    row = (await db.execute(text(
        "INSERT INTO mangolab.notebooks (project_id, path, name) VALUES (:p, :path, :name) "
        "ON CONFLICT (project_id, path) DO UPDATE SET name = EXCLUDED.name RETURNING id, version"
    ), {"p": project_id, "path": path, "name": path.rsplit("/", 1)[-1]})).one()
    return row.id, row.version


def opened(nb_id: uuid.UUID, path: str, version: int, nb, data: bytes) -> dict:
    return {"id": str(nb_id), "path": path, "name": path.rsplit("/", 1)[-1], "etag": notebooks_io.etag(data), "version": version, "size": len(data), "notebook": json.loads(notebooks_io.dumps(nb))}


class CreateBody(BaseModel):
    path: str
    template: Literal["blank", "welcome"] = "blank"


class SaveBody(BaseModel):
    path: str
    notebook: dict
    base_etag: str | None = None
    force: bool = False  # overwrite even if the file changed elsewhere (the user chose "keep my version")


class PathQuery(BaseModel):
    path: str


@router.post("", status_code=201)
async def create_notebook(project_id: uuid.UUID, body: CreateBody, request: Request, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    p = await get_owned_project(db, user, project_id)
    fs, path = fs_for(p), nb_path(body.path)
    nb = notebooks_io.welcome_notebook() if body.template == "welcome" else notebooks_io.blank_notebook()
    data = notebooks_io.dumps(nb)
    await ensure_quota(db, user, access, len(data))
    await run_in_threadpool(fs.write_atomic, path, data, create_parents=True, exclusive=True)
    forget_usage(p.id)
    nb_id, version = await ensure_row(db, p.id, path)
    await db.execute(text("UPDATE mangolab.notebooks SET size_bytes = :s, etag = :e, last_saved_by = :u, last_saved_at = now() WHERE id = :id"), {"s": len(data), "e": notebooks_io.etag(data), "u": user.id, "id": nb_id})
    await log_event(db, type="lab", user_id=user.id, username=user.username, detail="created a notebook", ip=request.client.host if request.client else None)
    await db.commit()
    return opened(nb_id, path, version, nb, data)


@router.get("")
async def open_notebook(project_id: uuid.UUID, path: str, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    path = nb_path(path)
    data = await run_in_threadpool(fs_for(p).read_bytes, path, notebooks_io.MAX_NOTEBOOK_BYTES)
    nb = notebooks_io.parse(data)
    nb_id, version = await ensure_row(db, p.id, path)
    await db.commit()
    return opened(nb_id, path, version, nb, data)


async def _snapshot(db: AsyncSession, fs, nb_id: uuid.UUID, user_id: str, data: bytes) -> None:
    """Keep a copy of the notebook at most every few minutes, newest 30."""
    last = (await db.execute(text("SELECT extract(epoch from max(created_at)) AS t FROM mangolab.notebook_revisions WHERE notebook_id = :n"), {"n": nb_id})).scalar()
    if last and time.time() - float(last) < REVISION_EVERY_S:
        return
    await _force_snapshot(db, fs, nb_id, user_id, data)


async def _force_snapshot(db: AsyncSession, fs, nb_id: uuid.UUID, user_id: str, data: bytes) -> None:
    rel = f".mangolab/revisions/{nb_id}/{int(time.time() * 1000)}.ipynb"
    await run_in_threadpool(fs.internal().write_atomic, rel, data, create_parents=True)
    await db.execute(text("INSERT INTO mangolab.notebook_revisions (notebook_id, created_by, size_bytes, sha256, storage_path) VALUES (:n, :u, :s, :h, :p)"),
                     {"n": nb_id, "u": user_id, "s": len(data), "h": notebooks_io.etag(data), "p": rel})
    old = (await db.execute(text("SELECT id, storage_path FROM mangolab.notebook_revisions WHERE notebook_id = :n ORDER BY created_at DESC OFFSET :k"), {"n": nb_id, "k": MAX_REVISIONS})).all()
    for r in old:
        try:
            await run_in_threadpool(fs.internal().remove, r.storage_path)
        except FsError:
            pass
        await db.execute(text("DELETE FROM mangolab.notebook_revisions WHERE id = :i"), {"i": r.id})


@router.put("")
async def save_notebook(project_id: uuid.UUID, body: SaveBody, request: Request, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, access = lab
    p = await get_owned_project(db, user, project_id)
    fs, path = fs_for(p), nb_path(body.path)
    nb = notebooks_io.normalize(body.notebook)
    data = notebooks_io.dumps(nb)
    if len(data) > notebooks_io.MAX_NOTEBOOK_BYTES:
        raise ApiError(413, "too_large", "That notebook is larger than 50 MB. Clear some outputs and try again.")
    async with lock_for(p.id, path):
        current: bytes | None = None
        try:
            current = await run_in_threadpool(fs.read_bytes, path, notebooks_io.MAX_NOTEBOOK_BYTES)
        except FsError as e:
            if e.code != "not_found":
                raise
        if not body.force:
            if current is not None and body.base_etag != notebooks_io.etag(current):
                raise ApiError(409, "conflict", "This notebook was changed somewhere else (another tab, the terminal or an upload).")
            if current is None and body.base_etag:
                raise ApiError(409, "deleted", "This notebook was deleted or moved while it was open.")
        await ensure_quota(db, user, access, len(data) - len(current or b""))
        await run_in_threadpool(fs.write_atomic, path, data, create_parents=True)
        forget_usage(p.id)
        nb_id, _ = await ensure_row(db, p.id, path)
        row = (await db.execute(text("UPDATE mangolab.notebooks SET version = version + 1, size_bytes = :s, etag = :e, last_saved_by = :u, last_saved_at = now() WHERE id = :id RETURNING version, last_saved_at"),
                                {"s": len(data), "e": notebooks_io.etag(data), "u": user.id, "id": nb_id})).one()
        await _snapshot(db, fs, nb_id, user.id, data)
        await db.commit()
    return {"etag": notebooks_io.etag(data), "version": row.version, "size": len(data), "saved_at": row.last_saved_at.isoformat()}


@router.get("/revisions")
async def list_revisions(project_id: uuid.UUID, path: str, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    path = nb_path(path)
    rows = (await db.execute(text(
        "SELECT r.id, r.size_bytes, r.created_at FROM mangolab.notebook_revisions r JOIN mangolab.notebooks n ON n.id = r.notebook_id "
        "WHERE n.project_id = :p AND n.path = :path ORDER BY r.created_at DESC"), {"p": p.id, "path": path})).all()
    return {"revisions": [{"id": str(r.id), "size": r.size_bytes, "created_at": r.created_at.isoformat()} for r in rows]}


class RestoreBody(BaseModel):
    path: str
    revision_id: uuid.UUID


@router.post("/revisions/restore")
async def restore_revision(project_id: uuid.UUID, body: RestoreBody, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    p = await get_owned_project(db, user, project_id)
    fs, path = fs_for(p), nb_path(body.path)
    rev = (await db.execute(text(
        "SELECT r.storage_path, n.id AS nb_id FROM mangolab.notebook_revisions r JOIN mangolab.notebooks n ON n.id = r.notebook_id "
        "WHERE r.id = :r AND n.project_id = :p AND n.path = :path"), {"r": body.revision_id, "p": p.id, "path": path})).first()
    if not rev:
        raise ApiError(404, "not_found", "That version doesn't exist.")
    snapshot = await run_in_threadpool(fs.internal().read_bytes, rev.storage_path, notebooks_io.MAX_NOTEBOOK_BYTES)
    nb = notebooks_io.parse(snapshot)
    async with lock_for(p.id, path):
        try:  # keep what is there now, so a restore can itself be undone
            current = await run_in_threadpool(fs.read_bytes, path, notebooks_io.MAX_NOTEBOOK_BYTES)
            await _force_snapshot(db, fs, rev.nb_id, user.id, current)
        except FsError:
            pass
        data = notebooks_io.dumps(nb)
        await run_in_threadpool(fs.write_atomic, path, data, create_parents=True)
        forget_usage(p.id)
        row = (await db.execute(text("UPDATE mangolab.notebooks SET version = version + 1, size_bytes = :s, etag = :e, last_saved_by = :u, last_saved_at = now() WHERE id = :id RETURNING version"),
                                {"s": len(data), "e": notebooks_io.etag(data), "u": user.id, "id": rev.nb_id})).one()
        await db.commit()
    return opened(rev.nb_id, path, row.version, nb, data)
