import base64
import hashlib
import hmac
import json
import time

from app.security import verify_session_token

SECRET = "test-secret-0123456789abcdef"
# Produced by the MangoGPT app's algorithm (src/lib/auth/session.ts, Node Web Crypto) with the secret above.
NODE_TOKEN = "eyJpIjoidXNlcl8xMjMiLCJ1IjoiYWxpY2UiLCJyIjoidXNlciIsImV4cCI6NDEwMjQ0NDgwMH0.9a9bf2ff7e43e2c14e22e38f8e8f4b77b8e9bd10f57bb1ce482d65cf3b4ebd40"


def make(secret=SECRET, **over):
    d = {"i": "u1", "u": "alice", "r": "user", "exp": int(time.time()) + 600, **over}
    payload = base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{payload}.{hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()}"


def test_accepts_token_made_by_node_app():
    # Cross-language compatibility: the Node app signs, FastAPI verifies.
    s = verify_session_token(NODE_TOKEN, SECRET, now=1_700_000_000)
    assert s and (s.user_id, s.username, s.role) == ("user_123", "alice", "user")


def test_accepts_valid_token():
    s = verify_session_token(make(), SECRET)
    assert s and s.user_id == "u1" and s.role == "user"


def test_rejects_wrong_secret_tampering_and_expiry():
    assert verify_session_token(make(secret="other-secret-0123456789"), SECRET) is None
    good = make()
    payload, sig = good.split(".")
    forged = base64.urlsafe_b64encode(json.dumps({"i": "u1", "u": "alice", "r": "admin", "exp": 4102444800}).encode()).decode().rstrip("=")
    assert verify_session_token(f"{forged}.{sig}", SECRET) is None  # role changed, signature kept
    assert verify_session_token(make(exp=int(time.time()) - 1), SECRET) is None


def test_rejects_garbage():
    for bad in [None, "", "abc", "a.b.c", ".", "x." + "0" * 64, make()[:-3]]:
        assert verify_session_token(bad, SECRET) is None
    assert verify_session_token(make(), "") is None
    assert verify_session_token(make(i=""), SECRET) is None
