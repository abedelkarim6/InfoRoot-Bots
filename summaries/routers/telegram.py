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


async def _live_fetch_admin_channels():
    """Live-fetch all channels the admin userbot is subscribed to, refresh the DB cache, and return them.
    Returns (result_dict, error_dict).
    """
    from utils.database import get_db
    from utils.helpers import load_config
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.types import Channel, Chat
    import datetime

    db = get_db()
    if db is None:
        return None, {"status": "error", "message": "Database not initialised"}

    admin = db.get_admin_user()
    session_str = admin.get("telegram_session") if admin else None
    if not session_str:
        return None, {"status": "error", "message": "No Telegram session found — link the admin account via the Telegram setup page"}

    cfg = load_config()
    tg_cfg = cfg.get("telegram", {})
    client = TelegramClient(StringSession(session_str), int(tg_cfg["api_id"]), tg_cfg["api_hash"])

    try:
        await asyncio.wait_for(client.connect(), timeout=15)
    except asyncio.TimeoutError:
        return None, {"status": "error", "message": "Connection timed out"}

    try:
        authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=15)
    except asyncio.TimeoutError:
        await client.disconnect()
        return None, {"status": "error", "message": "Authorization check timed out"}

    if not authorized:
        await client.disconnect()
        return None, {"status": "error", "message": "Session not authorized — re-run get_ss.py"}

    channels = []
    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        if isinstance(entity, (Channel, Chat)):
            is_broadcast = getattr(entity, 'broadcast', False)
            is_megagroup = getattr(entity, 'megagroup', False)
            can_post = getattr(entity, 'creator', False) or getattr(entity, 'admin_rights', None) is not None
            channels.append({
                'id': entity.id,
                'title': entity.title,
                'username': getattr(entity, 'username', None),
                'is_broadcast': is_broadcast,
                'is_megagroup': is_megagroup,
                'can_post': can_post,
                'participants_count': getattr(entity, 'participants_count', None),
            })

    await client.disconnect()

    # Refresh DB cache so bot.py and other callers stay in sync
    try:
        db.save_userbot_dialogs(channels)
    except Exception as e:
        logger.warning(f"[DIALOGS] Failed to update DB cache: {e}")

    updated_at = datetime.datetime.utcnow().isoformat()
    return {"channels": channels, "updated_at": updated_at}, None


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
async def get_admin_channels(request: Request):
    """Return all channels the userbot is a member of (live-fetched from Telegram).
    Available to any authenticated user — needed for the channel picker when
    creating or editing collections."""
    try:
        result, err = await _live_fetch_admin_channels()
        if err:
            return err
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("[TELEGRAM] get_admin_channels failed")
        return {"status": "error", "message": str(e)}


@router.post("/telegram/check_channel")
def check_channel(data: dict = Body(...)):
    """Check if the userbot is a member of a specific channel."""
    try:
        channel_id = (data.get('channel') or '').strip()
        if not channel_id:
            return {"status": "error", "message": "Missing channel"}

        result, err = _get_dialogs()
        if err:
            # DB not ready — treat as "not joined" rather than hard error
            return {"status": "ok", "joined": False, "channel": None}

        ch = _lookup_channel(result['channels'], channel_id)
        return {"status": "ok", "joined": ch is not None, "channel": ch}
    except Exception as e:
        logger.exception("[TELEGRAM] check_channel failed")
        return {"status": "error", "message": str(e)}


@router.post("/telegram/verify_channel")
def verify_channel(data: dict = Body(...)):
    """Verify a channel and return its full details from the userbot's joined list."""
    try:
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
    except Exception as e:
        logger.exception("[TELEGRAM] verify_channel failed")
        return {"status": "error", "message": str(e)}


@router.get("/telegram/userbot/dialogs")
async def get_userbot_dialogs(request: Request):
    """Return Telegram channels.
    Admin: returns cached DB dialogs (fast).
    Non-admin with session: live-fetches their own subscribed channels.
    Non-admin without session: returns status=no_session.
    """
    try:
        from routers.auth import is_admin_request, get_request_user_id
        from utils.database import get_db

        if is_admin_request(request):
            result, err = await _live_fetch_admin_channels()
            if err:
                return err
            return {"status": "ok", **result}

        # Non-admin path
        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"error": "Not authenticated"}, status_code=401)

        db = get_db()
        user = db.get_user_by_id(user_id)
        session_str = user.get("telegram_session") if user else None
        if not session_str:
            return {"status": "no_session"}

        try:
            from telethon import TelegramClient
            from telethon.sessions import StringSession
            from telethon.tl.types import Channel, Chat
            from utils.helpers import load_config

            cfg = load_config()
            tg_cfg = cfg.get("telegram", {})
            client = TelegramClient(
                StringSession(session_str),
                int(tg_cfg["api_id"]),
                tg_cfg["api_hash"],
            )
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

            channels = []
            async for dialog in client.iter_dialogs():
                entity = dialog.entity
                if isinstance(entity, (Channel, Chat)):
                    can_post = getattr(entity, 'creator', False) or getattr(entity, 'admin_rights', None) is not None
                    channels.append({
                        "id": entity.id,
                        "title": entity.title,
                        "username": getattr(entity, "username", None),
                        "is_broadcast": getattr(entity, 'broadcast', False),
                        "is_megagroup": getattr(entity, "megagroup", False),
                        "can_post": can_post,
                        "participants_count": getattr(entity, "participants_count", None),
                    })

            await client.disconnect()
            return {"status": "ok", "channels": channels, "updated_at": None}

        except Exception as e:
            logger.error(f"[TG-DIALOGS-USER] {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[TELEGRAM] get_userbot_dialogs failed")
        return {"status": "error", "message": str(e)}


# ── Userbot profile ───────────────────────────────────────────────────────────

@router.get("/telegram/userbot/me")
async def get_userbot_me(request: Request):
    """Fetch the actual Telegram profile (name, username, phone) using the stored session."""
    try:
        from routers.auth import get_request_user_id, is_admin_request
        from utils.database import get_db
        from utils.helpers import load_config

        db = get_db()
        if is_admin_request(request):
            admin = db.get_admin_user()
            session_str = admin.get("telegram_session") if admin else None
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
    except Exception as e:
        logger.exception("[TELEGRAM] get_userbot_me failed")
        return {"status": "error", "message": str(e)}


# ── Session status & test ─────────────────────────────────────────────────────

@router.get("/telegram/session/status")
def get_session_status(request: Request):
    """Return whether the admin has a session string stored in the DB."""
    try:
        from routers.auth import is_admin_request
        if not is_admin_request(request):
            return JSONResponse({"error": "Admin only"}, status_code=403)
        from utils.database import get_db
        db = get_db()
        admin = db.get_admin_user()
        has_session = bool(admin and admin.get("telegram_session"))
        phone = admin.get("telegram_phone") if admin else None
        return {"status": "ok", "has_session": has_session, "phone": phone}
    except Exception as e:
        logger.exception("[TELEGRAM] get_session_status failed")
        return {"status": "error", "message": str(e)}


@router.post("/telegram/session/test")
async def test_session(request: Request):
    """Try to connect with the stored session and return detailed logs."""
    try:
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
            return {"status": "error", "logs": ["[ERROR] No Telegram session found — link the admin account via the Telegram setup page"]}

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
    except Exception as e:
        logger.exception("[TELEGRAM] test_session failed")
        return {"status": "error", "message": str(e)}


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
        return None, {"status": "error", "message": "No Telegram session found — link the admin account via the Telegram setup page"}

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
    try:
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
    except Exception as e:
        logger.exception("[TELEGRAM] test_send failed")
        return {"status": "error", "message": str(e)}


@router.post("/telegram/test/receive")
async def test_receive(request: Request, data: dict = Body(...)):
    """Fetch recent messages from a channel/chat via the userbot session."""
    try:
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
    except Exception as e:
        logger.exception("[TELEGRAM] test_receive failed")
        return {"status": "error", "message": str(e)}


# ── Summary generator tester ──────────────────────────────────────────────────

def _log_tester_usage(llm, tokens, context: str):
    """Record a manual tester generation for cost tracking (feature 'summaries',
    admin-attributed). These are real Gemini calls that were previously invisible
    in AI usage. Best-effort — never breaks the tester."""
    try:
        from utils.database import get_db
        from utils.ai_pricing import client_model
        db = get_db()
        if db is not None:
            db.log_ai_usage(None, 'summaries', client_model(llm),
                            getattr(tokens, 'input', 0) or int(tokens or 0),
                            getattr(tokens, 'output', 0),
                            context=context,
                            thinking_tokens=getattr(tokens, 'thinking', 0),
                            audio_tokens=getattr(tokens, 'audio', 0))
    except Exception as e:
        logger.warning(f"[TESTER] usage logging failed: {e}")


@router.post("/telegram/tester/summary/generate")
async def tester_generate_summary(request: Request, data: dict = Body(...)):
    """Test summary generation for a bot/topic/schedule without sending to Telegram."""
    try:
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
                from utils.gemini_models import get_gemini_model
                llm = GeminiClient(
                    project=cfg["gemini"]["project"],
                    location=cfg["gemini"].get("location", "global"),
                    model=get_gemini_model(cfg),
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
            from summaries.prompts import get_summary_prompt
            texts  = [m["text"] for m in topic_messages]
            prompt = get_summary_prompt(texts, bot_name, prompt_key, topic_name=topic_name)
            summary, _tk = llm.generate_summary(prompt)
            _log_tester_usage(llm, _tk, f"tester {bot_name}/{topic_name}")
            return {
                "status": "ok",
                "summary": summary,
                "message_count": len(topic_messages),
                "prompt_key": prompt_key,
            }
        except Exception as e:
            logger.error(f"[TESTER-SUMMARY] {e}", exc_info=True)
            return {"status": "error", "message": str(e), "stage": "generate"}
    except Exception as e:
        logger.exception("[TELEGRAM] tester_generate_summary failed")
        return {"status": "error", "message": str(e)}


# ── Manual summary tester ─────────────────────────────────────────────────────

@router.post("/telegram/tester/summary/manual")
async def tester_manual_summary(request: Request, data: dict = Body(...)):
    """Generate a summary from manually provided message texts (no DB reads)."""
    try:
        from routers.auth import is_admin_request
        if not is_admin_request(request):
            return JSONResponse({"error": "Admin only"}, status_code=403)

        texts      = data.get("texts") or []
        bot_name   = (data.get("bot_name")   or "").strip()
        topic_name = (data.get("topic_name") or "").strip()
        prompt_key = (data.get("prompt_key") or "default").strip()

        if not texts or not any(t.strip() for t in texts):
            return {"status": "error", "message": "No message texts provided"}

        texts = [t for t in texts if t.strip()]

        from utils.helpers import load_config
        from utils.database import get_db
        cfg = load_config()

        # Build LLM client
        try:
            if cfg.get("gemini"):
                from utils.gemini_client import GeminiClient
                from utils.gemini_models import get_gemini_model
                llm = GeminiClient(
                    project=cfg["gemini"]["project"],
                    location=cfg["gemini"].get("location", "global"),
                    model=get_gemini_model(cfg),
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

        # If bot_name/topic_name given, try to resolve a better prompt_key from config
        if bot_name and topic_name and prompt_key == "default":
            try:
                db = get_db()
                bots_cfg = db.get_all_bots_config()
                for cat in bots_cfg.get(bot_name, {}).get("categories", {}).values():
                    topic_cfg = cat.get("topics", {}).get(topic_name)
                    if topic_cfg:
                        first_sched = (topic_cfg.get("schedules") or [{}])[0]
                        if first_sched.get("prompt_key"):
                            prompt_key = first_sched["prompt_key"]
                        break
            except Exception:
                pass

        try:
            from summaries.prompts import get_summary_prompt
            prompt  = get_summary_prompt(texts, bot_name or "manual", prompt_key, topic_name=topic_name or None)
            summary, _tk = llm.generate_summary(prompt)
            _log_tester_usage(llm, _tk, f"manual-tester {bot_name or 'manual'}")
            return {
                "status": "ok",
                "summary": summary,
                "message_count": len(texts),
                "prompt_key": prompt_key,
            }
        except Exception as e:
            logger.error(f"[TESTER-MANUAL] {e}", exc_info=True)
            return {"status": "error", "message": str(e), "stage": "generate"}
    except Exception as e:
        logger.exception("[TELEGRAM] tester_manual_summary failed")
        return {"status": "error", "message": str(e)}


@router.post("/telegram/tester/summary/send")
async def tester_send_summary(request: Request, data: dict = Body(...)):
    """Send an arbitrary text to a Telegram channel via the userbot session."""
    try:
        target  = (data.get("target")  or "").strip()
        message = (data.get("message") or "").strip()
        if not target:
            return {"status": "error", "message": "Missing target channel"}
        if not message:
            return {"status": "error", "message": "Missing message text"}

        client, err = await _get_test_client(request)
        if err:
            return err

        try:
            await client.send_message(target, message, parse_mode='md')
            await client.disconnect()
            logger.info(f"[TESTER-SEND] Sent summary to {target}")
            return {"status": "ok", "message": f"Sent to {target}"}
        except Exception as e:
            await client.disconnect()
            logger.error(f"[TESTER-SEND] {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[TELEGRAM] tester_send_summary failed")
        return {"status": "error", "message": str(e)}
