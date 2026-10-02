"""WebSocket endpoints. Browsers do not apply CORS to WebSockets, so every handshake checks the cookie AND the Origin."""
import json
import time
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import text

from app import db
from app.config import get_settings
from app.deps import lab_access_for, User
from app.security import verify_session_token

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
