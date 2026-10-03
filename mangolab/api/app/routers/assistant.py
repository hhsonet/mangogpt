import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.deps import LabAccess, User, require_lab
from app.errors import ApiError
from app.services import assistant as svc
from app.services import ollama
from app.services.assistant_context import NotebookContext
from app.services.projects import get_owned_project
from app.services.runtime_manager import manager

router = APIRouter(prefix="/projects/{project_id}/assistant")
MAX_THREADS_PER_PROJECT = 100


def _enabled() -> None:
    if not get_settings().assistant_enabled:
        raise ApiError(404, "assistant_off", "The assistant is turned off on this server.")


class ThreadCreate(BaseModel):
    path: str | None = Field(default=None, max_length=500)


class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    model: str | None = Field(default=None, max_length=100)
    think: bool = False
    mode: Literal["chat", "explain", "fix", "optimize", "generate"] = "chat"
    context: NotebookContext | None = None


class ActionPatch(BaseModel):
    status: Literal["proposed", "applied", "rejected"]
    prev: str | None = Field(default=None, max_length=60000)   # what an applied edit replaced, so it can be undone after a reload


async def _thread(db: AsyncSession, user: User, project_id: uuid.UUID, thread_id: uuid.UUID):
    row = (await db.execute(text("SELECT id, title, notebook_id, created_at FROM mangolab.ai_threads WHERE id = :t AND user_id = :u AND project_id = :p"), {"t": thread_id, "u": user.id, "p": project_id})).first()
    if not row:
        raise ApiError(404, "not_found", "Conversation not found.")
    return row


@router.get("/models")
async def models(project_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    _enabled()
    user, _ = lab
    await get_owned_project(db, user, project_id)
    try:
        ms = await ollama.list_models()
        default = (await ollama.pick_model(None))["name"]
    except ollama.OllamaError as e:
        raise ApiError(503, e.code, e.message)
    return {"models": ms, "default": default}


@router.get("/threads")
async def threads(project_id: uuid.UUID, path: str | None = Query(default=None, max_length=500), lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    _enabled()
    user, _ = lab
    await get_owned_project(db, user, project_id)
    nb = (await db.execute(text("SELECT id FROM mangolab.notebooks WHERE project_id = :p AND path = :path"), {"p": project_id, "path": path})).first() if path else None
    rows = (await db.execute(text(
        "SELECT t.id, t.title, t.created_at, (SELECT max(created_at) FROM mangolab.ai_messages m WHERE m.thread_id = t.id) AS last_at FROM mangolab.ai_threads t "
        "WHERE t.user_id = :u AND t.project_id = :p AND (CAST(:n AS uuid) IS NULL AND t.notebook_id IS NULL OR t.notebook_id = CAST(:n AS uuid)) ORDER BY coalesce((SELECT max(created_at) FROM mangolab.ai_messages m WHERE m.thread_id = t.id), t.created_at) DESC LIMIT 30"),
        {"u": user.id, "p": project_id, "n": nb.id if nb else None})).all()
    return {"threads": [{"id": str(r.id), "title": r.title, "created_at": r.created_at.isoformat(), "last_at": (r.last_at or r.created_at).isoformat()} for r in rows]}


@router.post("/threads", status_code=201)
async def create_thread(project_id: uuid.UUID, body: ThreadCreate, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    _enabled()
    user, _ = lab
    await get_owned_project(db, user, project_id)
    n = (await db.execute(text("SELECT count(*) FROM mangolab.ai_threads WHERE user_id = :u AND project_id = :p"), {"u": user.id, "p": project_id})).scalar_one()
    if n >= MAX_THREADS_PER_PROJECT:
        raise ApiError(409, "too_many_threads", "You have a lot of conversations in this project. Delete some old ones first.")
    nb = (await db.execute(text("SELECT id FROM mangolab.notebooks WHERE project_id = :p AND path = :path"), {"p": project_id, "path": body.path})).first() if body.path else None
    tid = uuid.uuid4()
    await db.execute(text("INSERT INTO mangolab.ai_threads (id, user_id, project_id, notebook_id) VALUES (:id, :u, :p, :n)"), {"id": tid, "u": user.id, "p": project_id, "n": nb.id if nb else None})
    await db.commit()
    return {"id": str(tid), "title": "New conversation"}


@router.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(project_id: uuid.UUID, thread_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> None:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    await _thread(db, user, project_id, thread_id)
    await db.execute(text("DELETE FROM mangolab.ai_threads WHERE id = :t"), {"t": thread_id})
    await db.commit()


@router.get("/threads/{thread_id}/messages")
async def messages(project_id: uuid.UUID, thread_id: uuid.UUID, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    user, _ = lab
    await get_owned_project(db, user, project_id)
    await _thread(db, user, project_id, thread_id)
    rows = (await db.execute(text("SELECT id, role, content, context_meta, model, created_at FROM mangolab.ai_messages WHERE thread_id = :t AND role IN ('user','assistant') ORDER BY created_at, id"), {"t": thread_id})).all()
    acts = (await db.execute(text("SELECT a.id, a.message_id, a.type, a.payload, a.status FROM mangolab.ai_actions a JOIN mangolab.ai_messages m ON m.id = a.message_id WHERE m.thread_id = :t ORDER BY a.id"), {"t": thread_id})).all()
    by_msg: dict[uuid.UUID, list[dict]] = {}
    for a in acts:
        by_msg.setdefault(a.message_id, []).append({"id": str(a.id), "type": a.type, "payload": a.payload, "status": a.status})
    return {"messages": [{"id": str(r.id), "role": r.role, "content": r.content, "model": r.model, "tools": (r.context_meta or {}).get("tools", []), "actions": by_msg.get(r.id, []), "created_at": r.created_at.isoformat()} for r in rows]}


@router.post("/threads/{thread_id}/chat")
async def chat(project_id: uuid.UUID, thread_id: uuid.UUID, body: ChatBody, request: Request, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> StreamingResponse:
    """Streams newline-delimited JSON events: meta, thinking, content, tool, action, done, error. Closing the connection stops the answer."""
    _enabled()
    user, _ = lab
    project = await get_owned_project(db, user, project_id)
    await _thread(db, user, project_id, thread_id)
    if len(body.message.strip()) == 0:
        raise ApiError(422, "bad_request", "Type a question first.")
    svc.acquire(user)  # raises 429 when this person already has a question running, or the server is busy

    async def stream():
        try:
            async for ev in svc.run_turn(user=user, project=project, thread_id=thread_id, message=body.message.strip(), mode=body.mode, ctx=body.context, model_name=body.model, think=body.think, manager=manager):
                yield svc.ndjson(ev)
        finally:
            svc.release(user)

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.patch("/actions/{action_id}")
async def patch_action(project_id: uuid.UUID, action_id: uuid.UUID, body: ActionPatch, lab: tuple[User, LabAccess] = Depends(require_lab), db: AsyncSession = Depends(get_db)) -> dict:
    """Records what the person decided. The change itself is applied in the browser (to the notebook they are looking at)."""
    user, _ = lab
    await get_owned_project(db, user, project_id)
    row = (await db.execute(text(
        "SELECT a.id, a.payload FROM mangolab.ai_actions a JOIN mangolab.ai_messages m ON m.id = a.message_id JOIN mangolab.ai_threads t ON t.id = m.thread_id "
        "WHERE a.id = :a AND t.user_id = :u AND t.project_id = :p"), {"a": action_id, "u": user.id, "p": project_id})).first()
    if not row:
        raise ApiError(404, "not_found", "That suggestion no longer exists.")
    payload = dict(row.payload or {})
    if body.status == "applied" and body.prev is not None:
        payload["applied_prev"] = body.prev
    await db.execute(text("UPDATE mangolab.ai_actions SET status = :s, payload = CAST(:p AS jsonb), decided_at = CASE WHEN :s = 'proposed' THEN NULL ELSE now() END WHERE id = :a"),
                     {"s": body.status, "p": json.dumps(payload), "a": action_id})
    await db.commit()
    return {"id": str(action_id), "status": body.status, "payload": payload}
