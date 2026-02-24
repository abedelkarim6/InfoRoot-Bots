"""
Authentication router — login/logout with in-memory token store.
Tokens are 64-char hex strings that expire after 24 hours.
Failed logins are rate-limited: 5 attempts → 15-minute lockout per IP.
"""

import hmac
import time
import secrets
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from utils.helpers import load_config

router = APIRouter()

# ── Token store ──────────────────────────────────
# token -> expiry unix timestamp
_tokens: dict[str, float] = {}
TOKEN_TTL = 86400  # 24 hours


def create_token() -> str:
    token = secrets.token_hex(32)
    _tokens[token] = time.time() + TOKEN_TTL
    _cleanup_expired()
    return token


def validate_token(token: str) -> bool:
    if not token:
        return False
    expiry = _tokens.get(token)
    if expiry is None:
        return False
    if time.time() > expiry:
        _tokens.pop(token, None)
        return False
    return True


def revoke_token(token: str):
    _tokens.pop(token, None)


def _cleanup_expired():
    now = time.time()
    for t in [k for k, v in _tokens.items() if v < now]:
        _tokens.pop(t, None)


# ── Rate limiting ────────────────────────────────
# ip -> {"count": int, "locked_until": float}
_failed: dict[str, dict] = {}
MAX_ATTEMPTS   = 5
LOCKOUT_SECS   = 15 * 60  # 15 minutes


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── Endpoints ────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
def login(req: LoginRequest, request: Request):
    ip  = _client_ip(request)
    now = time.time()

    info = _failed.get(ip, {"count": 0, "locked_until": 0.0})

    # Locked out?
    if info["locked_until"] > now:
        remaining_mins = int((info["locked_until"] - now) / 60) + 1
        return JSONResponse(
            {"error": f"Too many failed attempts. Try again in {remaining_mins} min.", "locked": True},
            status_code=429,
        )

    cfg           = load_config()
    admin         = cfg.get("admin", {})
    expected_user = admin.get("username", "admin")
    expected_pass = admin.get("password", "admin")

    valid = (
        hmac.compare_digest(req.username, expected_user) and
        hmac.compare_digest(req.password, expected_pass)
    )

    if not valid:
        info["count"] = info.get("count", 0) + 1
        attempts_left = max(0, MAX_ATTEMPTS - info["count"])

        if info["count"] >= MAX_ATTEMPTS:
            info["locked_until"] = now + LOCKOUT_SECS
            _failed[ip] = info
            return JSONResponse(
                {"error": f"Account locked for {LOCKOUT_SECS // 60} minutes after too many failed attempts.", "locked": True},
                status_code=429,
            )

        _failed[ip] = info
        return JSONResponse(
            {
                "error": f"Invalid credentials. {attempts_left} attempt{'s' if attempts_left != 1 else ''} remaining.",
                "attempts_used": info["count"],
            },
            status_code=401,
        )

    # Success — clear fail record
    _failed.pop(ip, None)
    token = create_token()
    return {"token": token}


@router.post("/auth/logout")
def logout(request: Request):
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        revoke_token(auth[7:])
    return {"ok": True}
