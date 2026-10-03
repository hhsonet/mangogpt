"""WebSocket endpoints. Browsers do not apply CORS to WebSockets, so every handshake checks the cookie AND the Origin."""
import asyncio
import json
import logging
import time
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import text

from app import db
from app.config import get_settings
from app.deps import lab_access_for, User
from app.errors import ApiError
from app.security import verify_session_token
from app.services.kernel_bridge import KernelError
from app.services.projects import get_owned_project
from app.services.runtime_manager import Client, manager
from app.services.safefs import FsError, clean_path
from app.services.terminals import terminals

log = logging.getLogger("mangolab.ws")

router = APIRouter()

# Close codes (4000-4999 are application defined)
UNAUTHORIZED, FORBIDDEN, NO_ACCESS = 4401, 4403, 4404


async def authenticate_ws(ws: WebSocket) -> User | None:
    """Accept the handshake only for a signed-in user with MangoLab access, from our own origin. Returns the user or closes the socket."""
    s = get_settings()
    origin = ws.headers.get("origin")
    host = ws.headers.get("x-forwarded-host") or ws.headers.get("host", "")
    if origin and urlparse(origin).netloc != host:
        await ws.close(code=FORBIDDEN, reason="origin")
        return None
    session = verify_session_token(ws.cookies.get(s.session_cookie), s.auth_secret)
    if not session:
        await ws.close(code=UNAUTHORIZED, reason="unauthorized")
        return None
    async with db.session() as conn:
        row = (await conn.execute(text('SELECT id, username, role, status FROM public."User" WHERE id = :id'), {"id": session.user_id})).first()
        if not row or row.status != "active":
            await ws.close(code=UNAUTHORIZED, reason="unauthorized")
            return None
        user = User(id=row.id, username=row.username, role="admin" if row.role == "admin" else "user")
        if not (await lab_access_for(conn, user)).enabled:
            await ws.close(code=NO_ACCESS, reason="no lab access")
            return None
    return user


@router.websocket("/lab-ws/v1/ping")
async def ping(ws: WebSocket) -> None:
    """Connectivity check used by the UI: proves cookie, origin, gateway and WebSocket framing all work."""
    user = await authenticate_ws(ws)
    if not user:
        return
    await ws.accept()
    await ws.send_json({"type": "hello", "user": user.username, "t": time.time()})
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong", "t": time.time(), "echo": msg.get("data")})
    except (WebSocketDisconnect, ValueError):
        return


RECHECK_S = 60


def _nb_path(raw: object) -> str:
    if not isinstance(raw, str):
        raise KernelError("bad_request", "Missing notebook path.")
    try:
        path = "/".join(clean_path(raw))
    except FsError as e:
        raise KernelError("bad_request", e.message) from e
    if not path.endswith(".ipynb"):
        raise KernelError("bad_request", "Only notebooks can run code.")
    return path


@router.websocket("/lab-ws/v1/projects/{project_id}/runtime")
async def project_socket(ws: WebSocket, project_id: str) -> None:
    """One socket per open project: runtime status and usage, plus kernel events for the notebooks the browser has attached.
    Client messages: attach, detach, execute, interrupt, restart, ack, ping. Everything else is ignored."""
    user = await authenticate_ws(ws)
    if not user:
        return
    try:
        pid = uuid.UUID(project_id)
        async with db.session() as conn:
            await get_owned_project(conn, user, pid)
    except (ValueError, ApiError):
        await ws.close(code=NO_ACCESS, reason="project not found")
        return
    await ws.accept()
    client = Client(user)
    manager.subscribe(pid, client)

    async def pump() -> None:
        while True:
            msg = await client.queue.get()
            await ws.send_json(msg)
            if client.overflowed:
                await ws.close(code=4408, reason="too slow")
                return

    async def recheck() -> None:
        while True:
            await asyncio.sleep(RECHECK_S)
            async with db.session() as conn:
                row = (await conn.execute(text('SELECT status FROM public."User" WHERE id = :id'), {"id": user.id})).first()
                ok = bool(row and row.status == "active") and (await lab_access_for(conn, user)).enabled
            if not ok:
                await ws.close(code=UNAUTHORIZED, reason="access ended")
                return

    pump_task, recheck_task = asyncio.create_task(pump()), asyncio.create_task(recheck())
    client.send({"type": "hello", "runtime": manager.status(pid)})
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            kind = msg.get("type")
            rt = manager.get(pid)
            try:
                if kind == "ping":
                    client.send({"type": "pong", "t": time.time()})
                elif kind == "attach":
                    path = _nb_path(msg.get("path"))
                    sess = rt.sessions.get(path) if rt else None
                    # Build the snapshot and mark the path attached with no await in between, so no event is missed or duplicated.
                    client.send(sess.snapshot() if sess else {"type": "snapshot", "path": path, "kernel": "none", "execution_count": 0, "executions": []})
                    client.attached.add(path)
                elif kind == "detach":
                    client.attached.discard(_nb_path(msg.get("path")))
                elif kind == "ack":
                    path = _nb_path(msg.get("path"))
                    if rt and path in rt.sessions and isinstance(msg.get("msg_id"), str):
                        rt.sessions[path].ack(msg["msg_id"])
                elif kind in ("execute", "interrupt", "restart"):
                    path = _nb_path(msg.get("path"))
                    if not rt or rt.status != "running":
                        raise KernelError("no_runtime", "Connect to a runtime first.")
                    sess = manager.session(rt, path)
                    if kind == "execute":
                        if not isinstance(msg.get("cell_id"), str) or not isinstance(msg.get("code"), str):
                            raise KernelError("bad_request", "Invalid run request.")
                        await sess.execute(msg["cell_id"], msg["code"])
                    elif kind == "interrupt":
                        await sess.interrupt()
                    else:
                        await sess.restart()
            except KernelError as e:
                client.send({"type": "error", "code": e.code, "message": e.message, "path": msg.get("path"), "cell_id": msg.get("cell_id")})
            except Exception:  # noqa: BLE001
                log.exception("socket message failed")
                client.send({"type": "error", "code": "server_error", "message": "Something went wrong. Please try again.", "path": msg.get("path"), "cell_id": msg.get("cell_id")})
    except WebSocketDisconnect:
        pass
    finally:
        pump_task.cancel()
        recheck_task.cancel()
        manager.unsubscribe(pid, client)


@router.websocket("/lab-ws/v1/projects/{project_id}/terminals/{terminal_id}")
async def terminal_socket(ws: WebSocket, project_id: str, terminal_id: str) -> None:
    """Keystrokes in, terminal output out. The shell keeps running when the page closes; reconnecting replays the recent output."""
    user = await authenticate_ws(ws)
    if not user:
        return
    try:
        pid = uuid.UUID(project_id)
        async with db.session() as conn:
            await get_owned_project(conn, user, pid)
    except (ValueError, ApiError):
        await ws.close(code=NO_ACCESS, reason="project not found")
        return
    rt = manager.get(pid)
    term = terminals.get(rt, terminal_id) if rt else None
    if not term:
        await ws.close(code=NO_ACCESS, reason="terminal not found")
        return
    await ws.accept()
    queue = terminals.subscribe(term)

    async def pump() -> None:
        while True:
            msg = await queue.get()
            if msg is None:
                await ws.close(code=1000, reason="terminal closed")
                return
            await ws.send_json(msg)

    async def recheck() -> None:
        while True:
            await asyncio.sleep(RECHECK_S)
            async with db.session() as conn:
                row = (await conn.execute(text('SELECT status FROM public."User" WHERE id = :id'), {"id": user.id})).first()
                ok = bool(row and row.status == "active") and (await lab_access_for(conn, user)).enabled
            if not ok:
                await ws.close(code=UNAUTHORIZED, reason="access ended")
                return

    pump_task, recheck_task = asyncio.create_task(pump()), asyncio.create_task(recheck())
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "input" and isinstance(msg.get("data"), str):
                terminals.write(term, msg["data"])
            elif msg.get("type") == "resize":
                try:
                    terminals.resize(term, int(msg["cols"]), int(msg["rows"]))
                except (KeyError, TypeError, ValueError):
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        pump_task.cancel()
        recheck_task.cancel()
        term.queues.discard(queue)
