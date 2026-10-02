from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import ADMIN_DEFAULTS, User, require_admin
from app.errors import ApiError
from app.usage import log_event

router = APIRouter(prefix="/admin")


class AccessUpdate(BaseModel):
    enabled: bool | None = None
    gpu_budget_mib: int | None = Field(default=None, ge=512, le=15360)
    cpu_quota_pct: int | None = Field(default=None, ge=50, le=1000)
    mem_max_mb: int | None = Field(default=None, ge=512, le=16384)
    disk_quota_mb: int | None = Field(default=None, ge=256, le=512000)
    max_runtimes: int | None = Field(default=None, ge=1, le=4)
    idle_timeout_min: int | None = Field(default=None, ge=5, le=1440)


@router.get("/users")
async def list_users(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)) -> dict:
    rows = (await db.execute(text(
        'SELECT u.id, u.username, u.role, u.status, a.enabled, a.gpu_budget_mib, a.cpu_quota_pct, a.mem_max_mb, a.disk_quota_mb, a.max_runtimes, a.idle_timeout_min '
        'FROM public."User" u LEFT JOIN mangolab.lab_access a ON a.user_id = u.id WHERE u.username <> \'local\' ORDER BY u.username'
    ))).all()
    return {"users": [
        {"id": r.id, "username": r.username, "role": r.role, "status": r.status,
         "lab_enabled": r.role == "admin" or bool(r.enabled), "explicit_grant": bool(r.enabled),
         "limits": {k: (getattr(r, k) if getattr(r, k) is not None else v) for k, v in ADMIN_DEFAULTS.items()}}
        for r in rows
    ]}


@router.put("/users/{user_id}/access")
async def set_access(user_id: str, body: AccessUpdate, request: Request, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)) -> dict:
    target = (await db.execute(text('SELECT id, username, role, status FROM public."User" WHERE id = :id AND username <> \'local\''), {"id": user_id})).first()
    if not target:
        raise ApiError(404, "not_found", "User not found.")
    cur = (await db.execute(text("SELECT * FROM mangolab.lab_access WHERE user_id = :u"), {"u": user_id})).mappings().first()
    merged = {"enabled": False, **ADMIN_DEFAULTS, **({k: v for k, v in cur.items() if k in ADMIN_DEFAULTS or k == "enabled"} if cur else {})}
    merged.update({k: v for k, v in body.model_dump().items() if v is not None})
    await db.execute(text(
        "INSERT INTO mangolab.lab_access (user_id, enabled, gpu_budget_mib, cpu_quota_pct, mem_max_mb, disk_quota_mb, max_runtimes, idle_timeout_min, granted_by, updated_at) "
        "VALUES (:u, :enabled, :gpu_budget_mib, :cpu_quota_pct, :mem_max_mb, :disk_quota_mb, :max_runtimes, :idle_timeout_min, :by, now()) "
        "ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, gpu_budget_mib = EXCLUDED.gpu_budget_mib, cpu_quota_pct = EXCLUDED.cpu_quota_pct, "
        "mem_max_mb = EXCLUDED.mem_max_mb, disk_quota_mb = EXCLUDED.disk_quota_mb, max_runtimes = EXCLUDED.max_runtimes, idle_timeout_min = EXCLUDED.idle_timeout_min, "
        "granted_by = EXCLUDED.granted_by, updated_at = now()"
    ), {"u": user_id, "by": admin.id, **merged})
    changed = ", ".join(f"{k}={v}" for k, v in body.model_dump().items() if v is not None)
    await log_event(db, type="admin", user_id=admin.id, username=admin.username, ip=request.client.host if request.client else None, detail=f"MangoLab access for {target.username}: {changed}")
    await db.commit()
    return {"user_id": user_id, "username": target.username, "lab_enabled": target.role == "admin" or bool(merged["enabled"]), "limits": {k: merged[k] for k in ADMIN_DEFAULTS}}
