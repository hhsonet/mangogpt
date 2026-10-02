from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

_engine: AsyncEngine | None = None
_maker: async_sessionmaker[AsyncSession] | None = None


def engine() -> AsyncEngine:
    global _engine, _maker
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, pool_size=10, max_overflow=5, pool_pre_ping=True)
        _maker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def get_db() -> AsyncIterator[AsyncSession]:
    engine()
    assert _maker is not None
    async with _maker() as session:
        yield session


async def dispose() -> None:
    if _engine is not None:
        await _engine.dispose()


def session() -> AsyncSession:
    """A standalone session for code outside request handling (WebSockets, background tasks). Use as `async with session() as db`."""
    engine()
    assert _maker is not None
    return _maker()
