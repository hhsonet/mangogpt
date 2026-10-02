from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    """Raise anywhere; rendered as {code, message} like the MangoGPT API, never a stack trace."""

    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse({"code": exc.code, "message": exc.message}, status_code=exc.status)
