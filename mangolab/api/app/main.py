import logging
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app import __version__, db
from app.config import get_settings
from app.errors import ApiError, api_error_handler
from app.routers import admin, health, me, ws

log = logging.getLogger("mangolab")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.engine()
    yield
    await db.dispose()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="MangoLab API", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def same_origin_for_writes(request: Request, call_next):
        # CSRF defence on top of the SameSite cookie: a browser request that changes data must come from our own origin.
        if request.method in UNSAFE:
            origin = request.headers.get("origin")
            host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
            if origin and urlparse(origin).netloc != host:
                return JSONResponse({"code": "forbidden", "message": "Cross-origin request refused."}, status_code=403)
        return await call_next(request)

    app.add_exception_handler(ApiError, api_error_handler)  # type: ignore[arg-type]

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        return JSONResponse({"code": "bad_request", "message": f"Invalid request: {'.'.join(str(p) for p in first.get('loc', [])[1:])} {first.get('msg', '')}".strip()}, status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.exception("unhandled error", exc_info=exc)
        return JSONResponse({"code": "server_error", "message": "Something went wrong. Please try again."}, status_code=500)

    for r in (health.router, me.router, admin.router):
        app.include_router(r, prefix=s.api_prefix)
    app.include_router(ws.router)  # WebSocket routes carry their own /lab-ws prefix
    return app


app = create_app()
