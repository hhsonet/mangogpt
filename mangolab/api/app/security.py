"""Single sign-on with the MangoGPT app: verify its signed session cookie, then re-check the user in the database."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Session:
    user_id: str
    username: str
    role: str


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_session_token(token: str | None, secret: str, now: float | None = None) -> Session | None:
    """Same format as the MangoGPT app: `<base64url JSON {i,u,r,exp}>.<hex HMAC-SHA256 of that text>`."""
    if not token or not secret or token.count(".") != 1:
        return None
    payload, sig = token.split(".")
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        data = json.loads(_b64url_decode(payload))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict) or not data.get("i") or not data.get("u") or not data.get("exp"):
        return None
    if float(data["exp"]) < (now if now is not None else time.time()):
        return None
    return Session(user_id=str(data["i"]), username=str(data["u"]), role=str(data.get("r") or "user"))
