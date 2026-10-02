from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.db import get_db

router = APIRouter()


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    """Public liveness check: proves the service and its database connection work. Reveals nothing else."""
    await db.execute(text("SELECT 1"))
    return {"ok": True, "service": "mangolab-api", "version": __version__}
