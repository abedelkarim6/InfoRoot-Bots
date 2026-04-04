import asyncio
import logging

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

router = APIRouter()
logger = logging.getLogger(__name__)


def _get_dialogs():
    """Load cached dialogs from DB. Returns (result_dict, error_dict)."""
    from utils.database import get_db
    db = get_db()
    if db is None:
        return None, {"status": "error", "message": "Database not initialised"}
    result = db.get_userbot_dialogs()
    if not result['channels'] and result['updated_at'] is None:
        return None, {
            "status": "error",
            "message": "No dialog data yet — make sure the bot is running. It caches channel membership at startup."
        }
    return result, None


def _lookup_channel(channels: list, channel_id: str):
    """Find a channel in the cached list by @username or numeric ID."""
    stripped = channel_id.lstrip('@').strip()
    if stripped.lstrip('-').isdigit():
        num = int(stripped)
        if num < 0:
            s = str(-num)
            entity_id = int(s[3:]) if s.startswith('100') else -num
        else:
            entity_id = num
        for ch in channels:
            if ch['id'] == entity_id:
                return ch
        return None
    for ch in channels:
        if ch.get('username') and ch['username'].lower() == stripped.lower():
            return ch
    return None


@router.get("/telegram/admin_channels")
def get_admin_channels():
    """Return all channels the userbot is a member of (from DB cache)."""
    result, err = _get_dialogs()
    if err:
        return err
    return {"status": "ok", **result}


@router.post("/telegram/check_channel")
def check_channel(data: dict = Body(...)):
    """Check if the userbot is a member of a specific channel."""
    channel_id = (data.get('channel') or '').strip()
    if not channel_id:
        return {"status": "error", "message": "Missing channel"}

    result, err = _get_dialogs()
    if err:
        # DB not ready — treat as "not joined" rather than hard error
        return {"status": "ok", "joined": False, "channel": None}

    ch = _lookup_channel(result['channels'], channel_id)
    return {"status": "ok", "joined": ch is not None, "channel": ch}


@router.post("/telegram/verify_channel")
def verify_channel(data: dict = Body(...)):
    """Verify a channel and return its full details from the userbot's joined list."""
    channel_id = (data.get('channel') or '').strip()
    if not channel_id:
        return {"status": "error", "message": "Missing channel"}

    result, err = _get_dialogs()
    if err:
        return {"status": "not_found", "joined": False, "message": err["message"]}

    ch = _lookup_channel(result['channels'], channel_id)
    if ch is None:
        return {
            "status": "not_found",
            "joined": False,
            "message": f"Userbot is not a member of '{channel_id}', or not found in cache."
        }
    return {"status": "ok", "joined": True, "channel": ch}


@router.get("/telegram/userbot/dialogs")
def get_userbot_dialogs():
    """Return the cached list of Telegram channels the userbot is a member of."""
    result, err = _get_dialogs()
    if err:
        return err
    return {"status": "ok", **result}


# ── Userbot profile ───────────────────────────────────────────────────────────

@router.get("/telegram/userbot/me")
async def get_userbot_me(request: Request):
    """Fetch the actual Telegram profile (name, username, phone) using the stored session."""
    from routers.auth import get_request_user_id, is_admin_request
    from utils.database import get_db
    from utils.helpers import load_config

    db = get_db()
    if is_admin_request(request):
        admin = db.get_admin_user()
        session_str = admin.get("telegram_session") if admin else None
        if not session_str:
            cfg = load_config()
            session_str = cfg.get("telegram", {}).get("string_session", "")
    else:
        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"error": "Not authenticated"}, status_code=401)
        user = db.get_user_by_id(user_id)
        session_str = user.get("telegram_session") if user else None

    if not session_str:
        return {"status": "no_session"}

    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession

        cfg = load_config()
        tg_cfg = cfg.get("telegram", {})
        api_id   = int(tg_cfg["api_id"])
        api_hash = tg_cfg["api_hash"]

        client = TelegramClient(StringSession(session_str), api_id, api_hash)
        try:
            await asyncio.wait_for(client.connect(), timeout=15)
        except asyncio.TimeoutError:
            return {"status": "error", "message": "Connection timed out"}

        try:
            authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=15)
        except asyncio.TimeoutError:
            await client.disconnect()
            return {"status": "error", "message": "Authorization check timed out"}

        if not authorized:
            await client.disconnect()
            return {"status": "unauthorized"}

        me = await client.get_me()
        await client.disconnect()

        return {
            "status": "ok",
            "first_name": me.first_name or "",
            "last_name":  me.last_name  or "",
            "username":   me.username   or "",
            "phone":      me.phone      or "",
            "tg_user_id": me.id,
        }
    except Exception as e:
        logger.error(f"[TG-ME] {e}")
        return {"status": "error", "message": str(e)}


# ── Session status & test ─────────────────────────────────────────────────────

@router.get("/telegram/session/status")
def get_session_status(request: Request):
    """Return whether the admin has a session string stored in the DB."""
    from routers.auth import is_admin_request
    if not is_admin_request(request):
        return JSONResponse({"error": "Admin only"}, status_code=403)
    from utils.database import get_db
    db = get_db()
    admin = db.get_admin_user()
    has_session = bool(admin and admin.get("telegram_session"))
    phone = admin.get("telegram_phone") if admin else None
    return {"status": "ok", "has_session": has_session, "phone": phone}


@router.post("/telegram/session/test")
async def test_session(request: Request):
    """Try to connect with the stored session and return detailed logs."""
    from routers.auth import is_admin_request
    if not is_admin_request(request):
        return JSONResponse({"error": "Admin only"}, status_code=403)
    from utils.database import get_db
    from utils.helpers import load_config

    logs = []

    db = get_db()
    admin = db.get_admin_user()
    session_str = admin.get("telegram_session") if admin else None
    if not session_str:
        cfg = load_config()
        session_str = cfg.get("telegram", {}).get("string_session", "")

    if not session_str:
        return {"status": "error", "logs": ["[ERROR] No session string found in DB or config.yaml"]}

    logs.append("[INFO] Session string found")
    logs.append("[INFO] Connecting to Telegram...")

    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession

        cfg = load_config()
        tg_cfg = cfg.get("telegram", {})
        api_id = int(tg_cfg["api_id"])
        api_hash = tg_cfg["api_hash"]

        client = TelegramClient(StringSession(session_str), api_id, api_hash)

        try:
            await asyncio.wait_for(client.connect(), timeout=15)
            logs.append("[INFO] TCP connection established")
        except asyncio.TimeoutError:
            logs.append("[ERROR] Connection timed out (15s) — check network or session validity")
            return {"status": "error", "logs": logs}

        try:
            authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=15)
        except asyncio.TimeoutError:
            logs.append("[ERROR] Authorization check timed out (15s) — session may be invalid or expired")
            await client.disconnect()
            return {"status": "error", "logs": logs}

        if not authorized:
            logs.append("[ERROR] Session is not authorized — needs re-login")
            await client.disconnect()
            return {"status": "error", "logs": logs}

        me = await client.get_me()
        await client.disconnect()

        display = f"@{me.username}" if me.username else (me.first_name or "unknown")
        logs.append(f"[SUCCESS] Authorized as {display}")
        return {"status": "ok", "logs": logs, "me": display}

    except Exception as e:
        logs.append(f"[ERROR] {e}")
        logger.error(f"[TG-TEST] {e}")
        return {"status": "error", "logs": logs}
