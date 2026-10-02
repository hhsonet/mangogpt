"""Write to MangoGPT's shared usage/audit log so MangoLab activity shows on the existing admin page. Metadata only."""
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def log_event(db: AsyncSession, *, type: str, user_id: str | None, username: str | None, status: str = "ok", detail: str | None = None, ip: str | None = None,
                    duration_ms: int | None = None) -> None:
    await db.execute(
        text('INSERT INTO public."UsageEvent" (id, type, status, "userId", username, detail, ip, "durationMs") VALUES (:id, :t, :s, :u, :n, :d, :ip, :ms)'),
        {"id": uuid.uuid4().hex, "t": type, "s": status, "u": user_id, "n": username, "d": (detail or "")[:300] or None, "ip": ip, "ms": duration_ms},
    )
