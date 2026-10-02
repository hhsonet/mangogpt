"""Authentication and authorization dependencies."""
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.errors import ApiError
from app.security import verify_session_token

# Defaults for admins (who need no explicit grant). Mirrors the column defaults of mangolab.lab_access.
ADMIN_DEFAULTS = dict(gpu_budget_mib=4096, cpu_quota_pct=200, mem_max_mb=6144, disk_quota_mb=20480, max_runtimes=1, idle_timeout_min=60)


@dataclass(frozen=True)
class User:
    id: str
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass(frozen=True)
class LabAccess:
    enabled: bool
    gpu_budget_mib: int
    cpu_quota_pct: int
    mem_max_mb: int
    disk_quota_mb: int
    max_runtimes: int
    idle_timeout_min: int


async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    """The signed-in MangoGPT user. The database is re-checked every time, so disabling a user takes effect immediately."""
    s = get_settings()
    session = verify_session_token(request.cookies.get(s.session_cookie), s.auth_secret)
    if not session:
        raise ApiError(401, "unauthorized", "Please sign in.")
    row = (await db.execute(text('SELECT id, username, role, status FROM public."User" WHERE id = :id'), {"id": session.user_id})).first()
    if not row or row.status != "active":
        raise ApiError(401, "unauthorized", "Please sign in.")
    return User(id=row.id, username=row.username, role="admin" if row.role == "admin" else "user")


async def lab_access_for(db: AsyncSession, user: User) -> LabAccess:
    row = (await db.execute(text(
        "SELECT enabled, gpu_budget_mib, cpu_quota_pct, mem_max_mb, disk_quota_mb, max_runtimes, idle_timeout_min FROM mangolab.lab_access WHERE user_id = :u"
    ), {"u": user.id})).first()
    if row:
        return LabAccess(enabled=bool(row.enabled) or user.is_admin, gpu_budget_mib=row.gpu_budget_mib, cpu_quota_pct=row.cpu_quota_pct, mem_max_mb=row.mem_max_mb,
                         disk_quota_mb=row.disk_quota_mb, max_runtimes=row.max_runtimes, idle_timeout_min=row.idle_timeout_min)
    return LabAccess(enabled=user.is_admin, **ADMIN_DEFAULTS)


async def require_lab(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)) -> tuple[User, LabAccess]:
    """MangoLab runs user code, so it is opt-in: an admin must grant access."""
    access = await lab_access_for(db, user)
    if not access.enabled:
        raise ApiError(403, "no_lab_access", "MangoLab access hasn't been granted to your account. Ask an admin.")
    return user, access


async def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise ApiError(403, "forbidden", "Admins only.")
    return user
