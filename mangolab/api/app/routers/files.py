import os
import re
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.errors import ApiError
from app.services import notebooks_io
from app.services.runtime_manager import manager
from app.services.projects import ensure_quota, forget_usage, fs_for, get_owned_project, rewrite_notebook_paths
from app.services.safefs import Entry, FsError, clean_name, clean_path

router = APIRouter(prefix="/projects/{project_id}/files")

MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MAX_UPLOAD_FILES = 50
INLINE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}  # safe to show in an <img>; never svg/html


def entry_view(e: Entry) -> dict:
    return {"name": e.name, "path": e.path, "kind": e.kind, "size": e.size, "mtime": e.mtime, "is_notebook": e.kind == "file" and e.name.endswith(".ipynb")}


async def project_fs(project_id: uuid.UUID, lab: tuple[User, LabAccess], db: AsyncSession):
    user, access = lab
    p = await get_owned_project(db, user, project_id)
    return p, fs_for(p), user, access


@router.get("")
async def list_files(project_id: uuid.UUID, path: str = "", lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    _, fs, _, _ = await project_fs(project_id, lab, db)
    entries = await run_in_threadpool(fs.list_dir, path)
    return {"path": "/".join(clean_path(path, allow_empty=True)), "entries": [entry_view(e) for e in entries if not e.name.startswith(".tmp-")]}


@router.get("/content")
async def read_text(project_id: uuid.UUID, path: str, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    _, fs, _, _ = await project_fs(project_id, lab, db)
    data = await run_in_threadpool(fs.read_bytes, path, MAX_TEXT_BYTES)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ApiError(415, "not_text", "This isn't a text file. Download it instead.") from e
    st = await run_in_threadpool(fs.stat, path)
    return {"path": st.path, "content": text, "etag": notebooks_io.etag(data), "size": len(data), "mtime": st.mtime}


class WriteText(BaseModel):
    path: str
    content: str
    base_etag: str | None = None  # the version being edited; if the file changed since, the save is refused instead of overwriting
    create_only: bool = False


@router.put("/content")
async def write_text(project_id: uuid.UUID, body: WriteText, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    p, fs, user, access = await project_fs(project_id, lab, db)
    data = body.content.encode("utf-8")
    if len(data) > MAX_TEXT_BYTES:
        raise ApiError(413, "too_large", "That's too large to edit here (2 MB). Upload it as a file instead.")
    current: bytes | None = None
    try:
        current = await run_in_threadpool(fs.read_bytes, body.path, MAX_TEXT_BYTES * 8)
    except FsError as e:
        if e.code != "not_found":
            raise
    if current is not None and not body.create_only and body.base_etag != notebooks_io.etag(current):
        raise ApiError(409, "conflict", "This file changed somewhere else. Reload it before saving.")
    await ensure_quota(db, user, access, len(data) - len(current or b""))
    await run_in_threadpool(fs.write_atomic, body.path, data, create_parents=True, exclusive=body.create_only, max_bytes=MAX_TEXT_BYTES)
    forget_usage(p.id)
    return {"path": "/".join(clean_path(body.path)), "etag": notebooks_io.etag(data), "size": len(data)}


class PathBody(BaseModel):
    path: str


class RenameBody(BaseModel):
    from_path: str = Field(alias="from")
    to_path: str = Field(alias="to")
    model_config = {"populate_by_name": True}


@router.post("/mkdir", status_code=201)
async def make_dir(project_id: uuid.UUID, body: PathBody, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    _, fs, _, _ = await project_fs(project_id, lab, db)
    await run_in_threadpool(fs.mkdir, body.path)
    return {"path": "/".join(clean_path(body.path))}


@router.post("/rename")
async def rename(project_id: uuid.UUID, body: RenameBody, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    p, fs, _, _ = await project_fs(project_id, lab, db)
    src, dst = "/".join(clean_path(body.from_path)), "/".join(clean_path(body.to_path))
    await run_in_threadpool(fs.rename, src, dst)
    await rewrite_notebook_paths(db, p.id, src, dst)
    await manager.rename_notebook(p.id, src, dst)
    await db.commit()
    return {"path": dst}


@router.delete("", status_code=204)
async def delete(project_id: uuid.UUID, path: str, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> None:
    p, fs, _, _ = await project_fs(project_id, lab, db)
    target = "/".join(clean_path(path))
    await run_in_threadpool(fs.remove, target)
    await rewrite_notebook_paths(db, p.id, target, None)
    await manager.forget_notebook(p.id, target)
    await db.commit()
    forget_usage(p.id)


def _unique_name(name: str, taken: set[str]) -> str:
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".") if "." in name.lstrip(".") else (name, "", "")
    for i in range(1, 1000):
        cand = f"{stem} ({i}){dot}{ext}"
        if cand not in taken:
            return cand
    raise ApiError(409, "exists", "Too many files with that name.")


@router.post("/upload", status_code=201)
async def upload(project_id: uuid.UUID, dir: str = Form(""), files: list[UploadFile] = File(...), lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    p, fs, user, access = await project_fs(project_id, lab, db)
    if not files or len(files) > MAX_UPLOAD_FILES:
        raise ApiError(400, "bad_request", f"Upload between 1 and {MAX_UPLOAD_FILES} files at a time.")
    parts = clean_path(dir, allow_empty=True)
    try:
        taken = {e.name for e in await run_in_threadpool(fs.list_dir, "/".join(parts))}
    except FsError as e:
        if e.code != "not_found":
            raise
        taken = set()
    saved, rejected = [], []
    for f in files:
        try:
            name = clean_name(os.path.basename((f.filename or "").replace("\\", "/")) or "upload")
            size = f.size
            if size is not None and size > MAX_UPLOAD_BYTES:
                raise FsError("too_large", f"“{name}” is larger than {MAX_UPLOAD_BYTES // 1024 // 1024} MB.", 413)
            await ensure_quota(db, user, access, size or 0)
            final = _unique_name(name, taken)
            taken.add(final)
            stream = iter(lambda: f.file.read(1024 * 1024), b"")
            written = await run_in_threadpool(fs.write_atomic, "/".join([*parts, final]), stream, create_parents=True, exclusive=True, max_bytes=MAX_UPLOAD_BYTES)
            forget_usage(p.id)
            saved.append({"name": final, "path": "/".join([*parts, final]), "size": written, "renamed": final != name})
        except (FsError, ApiError) as e:
            rejected.append({"name": f.filename, "message": e.message, "code": e.code})
        finally:
            await f.close()
    if not saved and rejected:
        raise ApiError(rejected[0]["code"] == "quota_exceeded" and 413 or 400, rejected[0]["code"], rejected[0]["message"])
    return {"saved": saved, "rejected": rejected}


@router.get("/download")
async def download(project_id: uuid.UUID, path: str, inline: bool = False, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> StreamingResponse:
    _, fs, _, _ = await project_fs(project_id, lab, db)
    f = await run_in_threadpool(fs.open_read, path)
    name = clean_path(path)[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    size = os.fstat(f.fileno()).st_size
    as_image = inline and ext in INLINE_TYPES
    headers = {
        "Content-Length": str(size),
        "Content-Disposition": f"{'inline' if as_image else 'attachment'}; filename*=UTF-8''{quote(name)}",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",  # a downloaded/previewed file can never run scripts in our origin
        "Cache-Control": "private, no-store",
    }

    def chunks():
        with f:
            while True:
                b = f.read(1024 * 1024)
                if not b:
                    break
                yield b

    return StreamingResponse(chunks(), media_type=INLINE_TYPES[ext] if as_image else "application/octet-stream", headers=headers)
