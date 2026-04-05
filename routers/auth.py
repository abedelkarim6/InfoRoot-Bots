"""
Authentication router — login / logout / register with in-memory token store.
Tokens are 64-char hex strings that expire after 24 hours.
Failed logins are rate-limited: 5 attempts → 15-minute lockout per IP.
"""

import hashlib
import hmac
import time
import secrets
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import logging

from utils.helpers import load_config
from utils.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Token store ──────────────────────────────────
# token -> expiry unix timestamp
_tokens: dict[str, float] = {}
# token -> user_id  (None for the admin account)
_token_users: dict[str, Optional[int]] = {}
TOKEN_TTL = 86400  # 24 hours


def create_token(user_id: Optional[int] = None) -> str:
    token = secrets.token_hex(32)
    _tokens[token] = time.time() + TOKEN_TTL
    _token_users[token] = user_id
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
        _token_users.pop(token, None)
        return False
    return True


def revoke_token(token: str):
    _tokens.pop(token, None)
    _token_users.pop(token, None)


def revoke_all_tokens_for_user(user_id: int):
    """Invalidate all active sessions for a given DB user (e.g. when deactivated)."""
    to_revoke = [t for t, uid in list(_token_users.items()) if uid == user_id]
    for t in to_revoke:
        _tokens.pop(t, None)
        _token_users.pop(t, None)


def get_token_user_id(token: str) -> Optional[int]:
    return _token_users.get(token)


def _cleanup_expired():
    now = time.time()
    for t in [k for k, v in _tokens.items() if v < now]:
        _tokens.pop(t, None)
        _token_users.pop(t, None)


# ── Password hashing (PBKDF2-HMAC-SHA256, stdlib only) ───────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"pbkdf2:sha256:{salt}:{h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        parts = stored.split(":")
        if len(parts) != 4 or parts[0] != "pbkdf2":
            return False
        _, _, salt, expected = parts
        h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
        return hmac.compare_digest(h.hex(), expected)
    except Exception:
        return False


# ── Rate limiting ────────────────────────────────
# ip -> {"count": int, "locked_until": float}
_failed: dict[str, dict] = {}
MAX_ATTEMPTS = 5
LOCKOUT_SECS = 15 * 60  # 15 minutes


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _get_bearer(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else None


def get_request_user_id(request: Request) -> Optional[int]:
    """Return DB user_id for the token, or None for legacy admin / unauthenticated."""
    token = _get_bearer(request)
    if not token or not validate_token(token):
        return None
    return get_token_user_id(token)


def is_admin_request(request: Request) -> bool:
    """Return True if the request belongs to an admin user (config admin or DB admin)."""
    token = _get_bearer(request)
    if not token or not validate_token(token):
        return False
    uid = get_token_user_id(token)
    if uid is None:
        return True  # legacy config-admin token
    try:
        from utils.database import get_db
        user = get_db().get_user_by_id(uid)
        return bool(user and user.get("role") == "admin")
    except Exception:
        return False


# ── Pending Telegram OTP sessions ────────────────
# phone -> {"client": TelegramClient, "hash": str, "user_id": int, "needs_2fa": bool}
_pending_tg: dict[str, dict] = {}


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

    # Check admin account from config
    cfg           = load_config()
    admin         = cfg.get("admin", {})
    expected_user = admin.get("username", "admin")
    expected_pass = admin.get("password", "admin")

    valid   = (
        hmac.compare_digest(req.username, expected_user) and
        hmac.compare_digest(req.password, expected_pass)
    )
    user_id: Optional[int] = None

    # If config admin matched, resolve their DB user_id (seeded at startup)
    if valid:
        try:
            db_user = get_db().get_user_by_username(req.username)
            if db_user:
                user_id = db_user["id"]
        except Exception:
            pass  # fall back to legacy None user_id

    # Check registered users in DB if admin check failed
    if not valid:
        try:
            db      = get_db()
            db_user = db.get_user_by_username(req.username)
            if db_user and verify_password(req.password, db_user["password_hash"]):
                if not db_user.get("is_active", True):
                    return JSONResponse(
                        {"error": "This account has been deactivated. Contact an administrator."},
                        status_code=403,
                    )
                valid   = True
                user_id = db_user["id"]
        except Exception:
            pass

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
    token = create_token(user_id=user_id)
    return {"token": token}


@router.post("/auth/logout")
def logout(request: Request):
    token = _get_bearer(request)
    if token:
        revoke_token(token)
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request):
    token = _get_bearer(request)
    if not token:
        return JSONResponse({"error": "Token missing"}, status_code=401)

    if not validate_token(token):
        return JSONResponse({"error": "Invalid token"}, status_code=401)

    user_id = get_token_user_id(token)
    db = get_db()

    if user_id is None:
        cfg = load_config()
        admin_username = cfg.get("admin", {}).get("username", "admin")
        user = db.get_user_by_username(admin_username)
        if user:
            user_id = user["id"]
        else:
            return {
                "user_id": None,
                "username": admin_username,
                "role": "admin",
                "has_bot_access": True,
                "telegram_phone": None,
                "created_at": None,
            }

    user = db.get_user_by_id(user_id)
    if not user:
        return JSONResponse({"error": "User not found"}, status_code=404)

    has_bot_access = bool(
        user.get("bots_on")
        or db.get_user_bot_inheritances(user["id"])
        or db.get_owned_bots_config(user["id"])
    )

    plan = db.get_plan_for_user(user["id"]) if user.get("ai_plan_id") else None

    return {
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "is_active": user["is_active"],
        "bots_on": bool(user.get("bots_on")),
        "youtube_on": user["youtube_on"],
        "yt_chat_on": bool(user.get("yt_chat_on")),
        "agents_on": user["agents_on"],
        "sys_bot_on": bool(user.get("sys_bot_on")),
        "telegram_phone": user.get("telegram_phone"),
        "telegram_session": user.get("telegram_session"),
        "created_at": str(user["created_at"]) if user.get("created_at") else None,
        "has_bot_access": has_bot_access,
        "ai_plan": {
            "id": plan["id"],
            "name": plan["name"],
            "monthly_limit": plan["monthly_limit"],
            "description": plan.get("description", ""),
        } if plan else None,
    }


@router.get("/me/ai-usage")
def me_ai_usage(request: Request):
    """Return current month's AI usage + plan for the authenticated user."""
    token = _get_bearer(request)
    if not token or not validate_token(token):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    user_id = get_token_user_id(token)
    db = get_db()

    if user_id is None:
        # Legacy admin token — no plan tracking
        return {"has_plan": False, "used": 0, "limit": None, "remaining": None,
                "plan_name": None, "plan_id": None, "year_month": None}

    user = db.get_user_by_id(user_id)
    if not user:
        return JSONResponse({"error": "User not found"}, status_code=404)

    return db.get_ai_usage_with_plan(user_id)


# ── Registration ─────────────────────────────────

class RegisterRequest(BaseModel):
    username: str
    password: str


@router.post("/auth/register")
def register(req: RegisterRequest):
    username = req.username.strip()
    if len(username) < 3:
        return JSONResponse({"error": "Username must be at least 3 characters."}, status_code=400)
    if len(req.password) < 6:
        return JSONResponse({"error": "Password must be at least 6 characters."}, status_code=400)

    db = get_db()
    if db.get_user_by_username(username):
        return JSONResponse({"error": "Username already taken."}, status_code=409)

    password_hash = hash_password(req.password)
    user_id = db.create_user(username, password_hash)
    token   = create_token(user_id=user_id)
    return {"token": token, "user_id": user_id}


# ── Telegram OTP linking ──────────────────────────

class TelegramSendCodeRequest(BaseModel):
    phone: str


@router.post("/auth/telegram/send-code")
async def telegram_send_code(req: TelegramSendCodeRequest, request: Request):
    token   = _get_bearer(request)
    user_id = get_token_user_id(token) if token else None
    # Legacy config-admin token has user_id=None — resolve from DB
    if user_id is None and token and validate_token(token):
        try:
            admin_username = load_config().get("admin", {}).get("username", "")
            admin_row = get_db().get_user_by_username(admin_username)
            if admin_row:
                user_id = admin_row["id"]
        except Exception:
            pass
    if not user_id:
        return JSONResponse({"error": "Not authenticated as a registered user."}, status_code=401)

    import re
    # Normalise to E.164: keep leading + and digits only
    phone = re.sub(r'[^\d+]', '', req.phone.strip())
    if not phone.startswith('+'):
        phone = '+' + phone

    cfg    = load_config()
    tg_cfg = cfg.get("telegram", {})

    from telethon import TelegramClient
    from telethon.sessions import StringSession

    client = TelegramClient(StringSession(), int(tg_cfg["api_id"]), tg_cfg["api_hash"])
    await client.connect()

    try:
        result = await client.send_code_request(phone)
    except Exception as e:
        logger.error(f"[TG-REG] send_code_request failed for {phone}: {e}")
        await client.disconnect()
        return JSONResponse({"error": f"Failed to send code: {e}"}, status_code=400)

    # Disconnect any previous pending session for this phone
    old = _pending_tg.get(phone)
    if old:
        try:
            await old["client"].disconnect()
        except Exception:
            pass

    _pending_tg[phone] = {
        "client":   client,
        "hash":     result.phone_code_hash,
        "user_id":  user_id,
        "needs_2fa": False,
    }

    return {"status": "ok", "message": "Verification code sent to your Telegram app."}


class TelegramVerifyCodeRequest(BaseModel):
    phone: str
    code: str


@router.post("/auth/telegram/verify-code")
async def telegram_verify_code(req: TelegramVerifyCodeRequest):
    import re as _re
    phone = _re.sub(r'[^\d+]', '', req.phone.strip())
    if not phone.startswith('+'):
        phone = '+' + phone
    pending = _pending_tg.get(phone)
    if not pending:
        return JSONResponse({"error": "No pending verification for this phone. Send a code first."}, status_code=400)

    from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PhoneCodeExpiredError

    client = pending["client"]
    try:
        await client.sign_in(phone, req.code, phone_code_hash=pending["hash"])

        session_str = client.session.save()
        await client.disconnect()

        db = get_db()
        db.update_user_telegram(pending["user_id"], phone, session_str)
        del _pending_tg[phone]

        return {"status": "ok", "message": "Telegram account linked successfully.", "session_string": session_str}

    except SessionPasswordNeededError:
        pending["needs_2fa"] = True
        return {"status": "needs_2fa", "message": "Two-factor authentication required."}

    except (PhoneCodeInvalidError, PhoneCodeExpiredError):
        return JSONResponse({"error": "Invalid or expired code. Please try again."}, status_code=400)

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


class Telegram2FARequest(BaseModel):
    phone: str
    password: str


@router.post("/auth/telegram/verify-2fa")
async def telegram_verify_2fa(req: Telegram2FARequest):
    import re as _re
    phone = _re.sub(r'[^\d+]', '', req.phone.strip())
    if not phone.startswith('+'):
        phone = '+' + phone
    pending = _pending_tg.get(phone)
    if not pending or not pending.get("needs_2fa"):
        return JSONResponse({"error": "No pending 2FA verification."}, status_code=400)

    from telethon.errors import PasswordHashInvalidError

    client = pending["client"]
    try:
        await client.sign_in(password=req.password)

        session_str = client.session.save()
        await client.disconnect()

        db = get_db()
        db.update_user_telegram(pending["user_id"], phone, session_str)
        del _pending_tg[phone]

        return {"status": "ok", "message": "Telegram account linked successfully.", "session_string": session_str}

    except PasswordHashInvalidError:
        return JSONResponse({"error": "Incorrect 2FA password. Please try again."}, status_code=400)

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ── Profile: change password ──────────────────────

class UpdateSessionRequest(BaseModel):
    session_string: str
    phone: str = ""


@router.post("/auth/profile/update-session")
def update_session(req: UpdateSessionRequest, request: Request):
    """Directly set a telegram session string for the current user (admin or DB user)."""
    token   = _get_bearer(request)
    user_id = get_token_user_id(token) if token else None

    db = get_db()

    if user_id is None:
        # Legacy config-admin token — resolve via DB (username match, fallback to role=admin)
        from utils.helpers import load_config
        admin_username = load_config().get("admin", {}).get("username", "")
        user = db.get_user_by_username(admin_username) or db.get_admin_user()
        if not user:
            return JSONResponse({"error": "Admin not found in DB."}, status_code=404)
        user_id = user["id"]

    if not req.session_string.strip():
        return JSONResponse({"error": "Session string cannot be empty."}, status_code=400)

    db.update_user_telegram(user_id, req.phone.strip() or None, req.session_string.strip())
    return {"status": "ok"}


class ProfileGeminiProjectsRequest(BaseModel):
    gemini_project_bots:    Optional[str] = None   # GCP project for Bots
    gemini_project_youtube: Optional[str] = None   # GCP project for YouTube
    gemini_project_agents:  Optional[str] = None   # GCP project for Agents


@router.post("/auth/profile/gemini-keys")
def profile_update_gemini_keys(req: ProfileGeminiProjectsRequest, request: Request):
    token   = _get_bearer(request)
    if not token or not validate_token(token):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    user_id = get_token_user_id(token)
    if not user_id:
        return JSONResponse({"error": "Not available for legacy admin token."}, status_code=400)

    db = get_db()
    p1 = req.gemini_project_bots.strip()    if req.gemini_project_bots    else None
    p2 = req.gemini_project_youtube.strip() if req.gemini_project_youtube else None
    p3 = req.gemini_project_agents.strip()  if req.gemini_project_agents  else None
    db.update_user(user_id, gemini_project_bots=p1, gemini_project_youtube=p2, gemini_project_agents=p3)
    return {"status": "ok"}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/profile/change-password")
def change_password(req: ChangePasswordRequest, request: Request):
    token   = _get_bearer(request)
    user_id = get_token_user_id(token) if token else None
    if not user_id:
        return JSONResponse({"error": "Not available for admin account."}, status_code=400)

    db   = get_db()
    user = db.get_user_by_id(user_id)
    if not user:
        return JSONResponse({"error": "User not found."}, status_code=404)

    if not verify_password(req.current_password, user["password_hash"]):
        return JSONResponse({"error": "Current password is incorrect."}, status_code=400)

    if len(req.new_password) < 6:
        return JSONResponse({"error": "New password must be at least 6 characters."}, status_code=400)

    new_hash = hash_password(req.new_password)
    db._get_cursor().execute(
        "UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user_id)
    )
    db.connection.commit()
    return {"status": "ok"}
