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


# ── Send / Receive test ───────────────────────────────────────────────────────

async def _get_test_client(request):
    """Return (client, error_dict). Client is connected & authorized."""
    from routers.auth import is_admin_request
    if not is_admin_request(request):
        return None, {"status": "error", "message": "Admin only"}

    from utils.database import get_db
    from utils.helpers import load_config

    db = get_db()
    admin = db.get_admin_user()
    session_str = admin.get("telegram_session") if admin else None
    if not session_str:
        cfg = load_config()
        session_str = cfg.get("telegram", {}).get("string_session", "")
    if not session_str:
        return None, {"status": "error", "message": "No session string found in DB or config.yaml"}

    from telethon import TelegramClient
    from telethon.sessions import StringSession

    cfg = load_config()
    tg_cfg = cfg.get("telegram", {})
    client = TelegramClient(StringSession(session_str), int(tg_cfg["api_id"]), tg_cfg["api_hash"])

    try:
        await asyncio.wait_for(client.connect(), timeout=15)
    except asyncio.TimeoutError:
        return None, {"status": "error", "message": "Connection timed out (15s)"}

    try:
        authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=15)
    except asyncio.TimeoutError:
        await client.disconnect()
        return None, {"status": "error", "message": "Authorization check timed out (15s)"}

    if not authorized:
        await client.disconnect()
        return None, {"status": "error", "message": "Session is not authorized — re-run get_ss.py"}

    return client, None


@router.post("/telegram/test/send")
async def test_send(request: Request, data: dict = Body(...)):
    """Send a test message to a channel/user via the userbot session."""
    target = (data.get("target") or "").strip()
    message = (data.get("message") or "").strip()
    if not target:
        return {"status": "error", "message": "Missing target"}
    if not message:
        return {"status": "error", "message": "Missing message"}

    client, err = await _get_test_client(request)
    if err:
        return err

    try:
        await client.send_message(target, message)
        await client.disconnect()
        logger.info(f"[TG-TEST-SEND] Sent to {target}")
        return {"status": "ok", "message": f"Message delivered to {target}"}
    except Exception as e:
        await client.disconnect()
        logger.error(f"[TG-TEST-SEND] {e}")
        return {"status": "error", "message": str(e)}


@router.post("/telegram/test/receive")
async def test_receive(request: Request, data: dict = Body(...)):
    """Fetch recent messages from a channel/chat via the userbot session."""
    target = (data.get("target") or "").strip()
    limit = min(int(data.get("limit") or 10), 50)
    if not target:
        return {"status": "error", "message": "Missing target"}

    client, err = await _get_test_client(request)
    if err:
        return err

    try:
        from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument

        messages = []
        async for msg in client.iter_messages(target, limit=limit):
            sender = ""
            if msg.sender:
                if getattr(msg.sender, "username", None):
                    sender = f"@{msg.sender.username}"
                elif getattr(msg.sender, "first_name", None):
                    sender = msg.sender.first_name
                elif getattr(msg.sender, "title", None):
                    sender = msg.sender.title

            media_type = None
            if msg.media:
                if isinstance(msg.media, MessageMediaPhoto):
                    media_type = "photo"
                elif isinstance(msg.media, MessageMediaDocument):
                    media_type = "document"
                else:
                    media_type = "media"

            messages.append({
                "id": msg.id,
                "date": msg.date.isoformat() if msg.date else None,
                "sender": sender,
                "text": msg.text or "",
                "media_type": media_type,
            })

        await client.disconnect()
        return {"status": "ok", "messages": messages, "count": len(messages)}
    except Exception as e:
        await client.disconnect()
        logger.error(f"[TG-TEST-RECV] {e}")
        return {"status": "error", "message": str(e)}


# ── Summary generator tester ──────────────────────────────────────────────────

@router.post("/tester/summary/generate")
async def tester_generate_summary(request: Request, data: dict = Body(...)):
    """Test summary generation for a bot/topic/schedule without sending to Telegram."""
    from routers.auth import is_admin_request
    if not is_admin_request(request):
        return JSONResponse({"error": "Admin only"}, status_code=403)

    bot_name      = (data.get("bot_name")      or "").strip()
    topic_name    = (data.get("topic_name")     or "").strip()
    schedule_type = (data.get("schedule_type")  or "").strip()

    if not all([bot_name, topic_name, schedule_type]):
        return {"status": "error", "message": "Missing bot_name, topic_name or schedule_type"}

    from utils.database import get_db
    from utils.helpers import load_config

    db  = get_db()
    cfg = load_config()

    # Build LLM client
    try:
        if cfg.get("gemini"):
            from utils.gemini_client import GeminiClient
            llm = GeminiClient(
                project=cfg["gemini"]["project"],
                location=cfg["gemini"].get("location", "us-central1"),
                model=cfg["gemini"].get("model", "gemini-2.5-flash"),
            )
        else:
            from utils.openai_client import OpenAIClient
            oa = cfg["openai"]
            llm = OpenAIClient(
                api_key=oa["api_key"],
                model=oa["model"],
                max_tokens=oa["max_tokens"],
                temperature=oa["temperature"],
            )
    except Exception as e:
        return {"status": "error", "message": str(e), "stage": "init"}

    # Fetch pending messages
    try:
        messages = db.get_messages_for_schedule(schedule_type, bot_name, topic_name)
        topic_messages = [
            m for m in messages
            if topic_name in [t.strip() for t in (m.get("topics") or "").split(",")]
        ]
    except Exception as e:
        return {"status": "error", "message": str(e), "stage": "fetch"}

    if not topic_messages:
        return {
            "status": "ok",
            "warning": "No pending messages found for this combination",
            "message_count": 0,
        }

    # Resolve prompt_key from schedule config
    try:
        bots_cfg  = db.get_all_bots_config()
        prompt_key = "default"
        for cat in bots_cfg.get(bot_name, {}).get("categories", {}).values():
            topic_cfg = cat.get("topics", {}).get(topic_name)
            if topic_cfg:
                for sched in topic_cfg.get("schedules", []):
                    if sched.get("type") == schedule_type:
                        prompt_key = sched.get("prompt_key") or "default"
                        break
    except Exception:
        prompt_key = "default"

    # Generate
    try:
        from utils.prompts import get_summary_prompt
        texts  = [m["text"] for m in topic_messages]
        prompt = get_summary_prompt(texts, bot_name, prompt_key, topic_name=topic_name)
        summary = llm.generate_summary(prompt)
        return {
            "status": "ok",
            "summary": summary,
            "message_count": len(topic_messages),
            "prompt_key": prompt_key,
        }
    except Exception as e:
        logger.error(f"[TESTER-SUMMARY] {e}", exc_info=True)
        return {"status": "error", "message": str(e), "stage": "generate"}
