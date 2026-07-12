"""
Auth router — Keycloak-only.

All authentication is delegated to Keycloak. The backend only verifies signed
JWTs against the realm's JWKS and maps the token's `preferred_username` claim
to a row in the local `users` table (auto-provisioning on first sight).

Public surface (kept stable for the rest of the codebase):
  validate_token(token, ua="", ip="") -> bool
  get_token_user_id(token)            -> int | None
  get_request_user_id(request)        -> int | None
  is_admin_request(request)           -> bool
  revoke_token(token)
  revoke_all_tokens_for_user(user_id)
  hash_password(password)             -> str    (legacy shim — admin seed)
  _get_bearer(request)                -> str | None
"""

import hashlib
import secrets
import time
import logging
import re
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from utils.helpers import load_config
from utils.database import get_db
from routers.keycloak_auth import verify_keycloak_jwt, is_keycloak_enabled, KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Keycloak JWT cache ───────────────────────────────────────────────────────
# Each verified JWT is cached until its `exp` so repeat requests don't hit
# the JWKS / signature-verify path on every call. The cache key is the raw
# token string (JWTs are large but unique per session).
#
# Schema: token -> {"user_id": int|None, "exp": float}
_kc_tokens: dict[str, dict] = {}


def _cleanup_expired_kc_tokens() -> None:
    now = time.time()
    for tok in [k for k, v in _kc_tokens.items() if v["exp"] < now]:
        _kc_tokens.pop(tok, None)


def _resolve_db_user(claims: dict) -> Optional[int]:
    """Find the DB user row matching the JWT's preferred_username,
    auto-provisioning a row on first sight. Returns the user id or None."""
    username = (
        claims.get("preferred_username")
        or claims.get("email")
        or claims.get("sub")
    )
    if not username:
        return None
    db = get_db()
    try:
        user = db.get_user_by_username(username)
        if user:
            return user["id"]
        # First Keycloak sighting — provision a row so per-user features
        # (bot inheritance, AI usage tracking) have somewhere to attach.
        cfg_admin = (load_config().get("admin", {}) or {}).get("username", "")
        role = "admin" if username == cfg_admin else "user"
        user_id = db.create_user(username, password_hash="!keycloak!")
        if role == "admin":
            try:
                db._get_cursor().execute(
                    "UPDATE users SET role = %s WHERE id = %s", (role, user_id)
                )
                db._commit()
            except Exception as e:
                logger.warning(f"[KEYCLOAK] failed to set admin role for {username}: {e}")
        logger.info(f"[KEYCLOAK] auto-provisioned DB user '{username}' (id={user_id}, role={role})")
        return user_id
    except Exception as e:
        logger.warning(f"[KEYCLOAK] DB user lookup/create failed for '{username}': {e}")
        return None


def validate_token(token: str, user_agent: str = "", ip_address: str = "") -> bool:
    """Verify a Keycloak JWT. Cached on success until the JWT's exp.

    user_agent and ip_address are accepted for signature compatibility with the
    legacy native-token path but are not used (Keycloak owns session policy).
    """
    if not token:
        return False
    if not is_keycloak_enabled():
        logger.warning("[auth] validate_token called but Keycloak is not configured")
        return False
    # Cache hit?
    cached = _kc_tokens.get(token)
    now = time.time()
    if cached and cached["exp"] > now:
        return True
    if cached:
        _kc_tokens.pop(token, None)
    # Verify fresh
    claims = verify_keycloak_jwt(token)
    if not claims:
        return False
    exp = float(claims.get("exp") or 0)
    if exp <= now:
        return False
    user_id = _resolve_db_user(claims)
    _kc_tokens[token] = {"user_id": user_id, "exp": exp}
    _cleanup_expired_kc_tokens()
    return True


def revoke_token(token: str):
    """Forget our cached entry for this JWT. Keycloak's own session
    invalidation (e.g. via end_session) is what actually disables the token."""
    _kc_tokens.pop(token, None)


def revoke_all_tokens_for_user(user_id: int):
    """Drop all cached entries for a given DB user (e.g. on deactivation).
    Note: this only forgets our local cache. The user's Keycloak session
    must be invalidated separately via Keycloak admin if you want to lock
    them out immediately rather than at next access-token expiry."""
    to_revoke = [t for t, v in list(_kc_tokens.items()) if v.get("user_id") == user_id]
    for t in to_revoke:
        _kc_tokens.pop(t, None)


def get_token_user_id(token: str) -> Optional[int]:
    entry = _kc_tokens.get(token)
    return entry["user_id"] if entry else None


def _get_bearer(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else None


def get_request_user_id(request: Request) -> Optional[int]:
    token = _get_bearer(request)
    if not token or not validate_token(token):
        return None
    return get_token_user_id(token)


def is_admin_request(request: Request) -> bool:
    token = _get_bearer(request)
    if not token or not validate_token(token):
        return False
    uid = get_token_user_id(token)
    if uid is None:
        return False
    try:
        user = get_db().get_user_by_id(uid)
        return bool(user and user.get("role") == "admin")
    except Exception:
        return False


# ── Legacy admin seed shim ────────────────────────────────────────────────────
# The startup path in app.py still calls hash_password() to seed the
# config-admin row in the users table. With Keycloak owning passwords this is
# vestigial — but the row itself is useful (it gives the admin a stable user_id
# for ownership of bots, plans, etc., even before they first log in via SSO).
# We keep the function so app.py keeps working unchanged; the hash value is
# never used to authenticate anyone now.
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"pbkdf2:sha256:{salt}:{h.hex()}"


# ── Diagnostic endpoint ───────────────────────────────────────────────────────
# Exposes the running Keycloak configuration for sanity checking. No
# authentication required (it returns no secrets — just the public realm URL).
@router.get("/_debug/keycloak")
def debug_keycloak():
    return {
        "enabled": is_keycloak_enabled(),
        "issuer": KEYCLOAK_ISSUER or None,
        "jwks_url": KEYCLOAK_JWKS_URL or None,
        "cached_tokens": len(_kc_tokens),
    }


# ── /auth/me — current user ──────────────────────────────────────────────────

@router.get("/auth/me")
def me(request: Request):
    try:
        token = _get_bearer(request)
        if not token:
            return JSONResponse({"error": "Token missing"}, status_code=401)
        if not validate_token(token):
            return JSONResponse({"error": "Invalid token"}, status_code=401)
        user_id = get_token_user_id(token)
        if user_id is None:
            return JSONResponse({"error": "No DB user mapping for token"}, status_code=403)
        db = get_db()
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
    except Exception as e:
        logger.exception("[AUTH] /auth/me failed")
        return {"status": "error", "message": str(e)}


@router.get("/me/ai-usage")
def me_ai_usage(request: Request):
    """Return current month's AI usage + plan for the authenticated user."""
    try:
        token = _get_bearer(request)
        if not token or not validate_token(token):
            return JSONResponse({"error": "Not authenticated"}, status_code=401)
        user_id = get_token_user_id(token)
        if user_id is None:
            return JSONResponse({"error": "No DB user mapping for token"}, status_code=403)
        db = get_db()
        if not db.get_user_by_id(user_id):
            return JSONResponse({"error": "User not found"}, status_code=404)
        return db.get_ai_usage_with_plan(user_id)
    except Exception as e:
        logger.exception("[AUTH] /me/ai-usage failed")
        return {"status": "error", "message": str(e)}


# ── Pending Telegram OTP sessions ────────────────
# phone -> {"client": TelegramClient, "hash": str, "user_id": int, "needs_2fa": bool}
_pending_tg: dict[str, dict] = {}


class TelegramSendCodeRequest(BaseModel):
    phone: str


@router.post("/auth/telegram/send-code")
async def telegram_send_code(req: TelegramSendCodeRequest, request: Request):
    try:
        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"error": "Not authenticated."}, status_code=401)

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
    except Exception as e:
        logger.exception("[AUTH] /auth/telegram/send-code failed")
        return {"status": "error", "message": str(e)}


class TelegramVerifyCodeRequest(BaseModel):
    phone: str
    code: str


@router.post("/auth/telegram/verify-code")
async def telegram_verify_code(req: TelegramVerifyCodeRequest):
    try:
        phone = re.sub(r'[^\d+]', '', req.phone.strip())
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
    except Exception as e:
        logger.exception("[AUTH] /auth/telegram/verify-code failed")
        return {"status": "error", "message": str(e)}


class Telegram2FARequest(BaseModel):
    phone: str
    password: str


@router.post("/auth/telegram/verify-2fa")
async def telegram_verify_2fa(req: Telegram2FARequest):
    try:
        phone = re.sub(r'[^\d+]', '', req.phone.strip())
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
    except Exception as e:
        logger.exception("[AUTH] /auth/telegram/verify-2fa failed")
        return {"status": "error", "message": str(e)}


# ── Profile (Telegram session + Gemini projects) ─────────────────────────────

class UpdateSessionRequest(BaseModel):
    session_string: str
    phone: str = ""


@router.post("/auth/profile/update-session")
def update_session(req: UpdateSessionRequest, request: Request):
    """Directly set a telegram session string for the current user."""
    try:
        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"error": "Not authenticated."}, status_code=401)
        if not req.session_string.strip():
            return JSONResponse({"error": "Session string cannot be empty."}, status_code=400)
        get_db().update_user_telegram(user_id, req.phone.strip() or None, req.session_string.strip())
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[AUTH] /auth/profile/update-session failed")
        return {"status": "error", "message": str(e)}


@router.post("/auth/profile/disconnect-telegram")
def disconnect_telegram(request: Request):
    try:
        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"error": "Not authenticated."}, status_code=401)
        get_db().update_user_telegram(user_id, None, None)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[AUTH] /auth/profile/disconnect-telegram failed")
        return {"status": "error", "message": str(e)}


class ProfileGeminiProjectsRequest(BaseModel):
    gemini_project_bots:    Optional[str] = None
    gemini_project_youtube: Optional[str] = None
    gemini_project_agents:  Optional[str] = None


@router.post("/auth/profile/gemini-keys")
def profile_update_gemini_keys(req: ProfileGeminiProjectsRequest, request: Request):
    try:
        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"error": "Not authenticated"}, status_code=401)
        db = get_db()
        p1 = req.gemini_project_bots.strip()    if req.gemini_project_bots    else None
        p2 = req.gemini_project_youtube.strip() if req.gemini_project_youtube else None
        p3 = req.gemini_project_agents.strip()  if req.gemini_project_agents  else None
        db.update_user(user_id, gemini_project_bots=p1, gemini_project_youtube=p2, gemini_project_agents=p3)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[AUTH] /auth/profile/gemini-keys failed")
        return {"status": "error", "message": str(e)}
