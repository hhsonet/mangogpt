from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import User, current_user, lab_access_for

router = APIRouter()


@router.get("/me")
async def me(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)) -> dict:
    """Who am I, and may I use MangoLab? The UI calls this first to decide what to show."""
    access = await lab_access_for(db, user)
    return {
        "user": {"id": user.id, "username": user.username, "role": user.role},
        "lab": {
            "enabled": access.enabled,
            "limits": {
                "gpu_budget_mib": access.gpu_budget_mib, "cpu_quota_pct": access.cpu_quota_pct, "mem_max_mb": access.mem_max_mb,
                "disk_quota_mb": access.disk_quota_mb, "max_runtimes": access.max_runtimes, "idle_timeout_min": access.idle_timeout_min,
            },
        },
    }
