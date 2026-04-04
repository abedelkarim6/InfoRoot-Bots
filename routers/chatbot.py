"""
Agent Chatbot API router.
Endpoints under /api/chatbot/...
"""

import json
import logging
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from utils.database import get_db
from youtube_monitor.db import get_yt_db
from chatbot.service import create_session, send_message, get_session, delete_session, generate_suggestions, stream_message
from chatbot.system_service import create_system_session, send_system_message, delete_system_session, stream_system_message

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chatbot", tags=["chatbot"])


@router.post("/start")
async def chatbot_start():
    """Create a new chatbot session."""
    try:
        db = get_db()
        yt_db = get_yt_db()
        session_id = create_session(db, yt_db)
        return {"status": "ok", "session_id": session_id}
    except Exception as e:
        logger.error(f"[CHATBOT] Failed to create session: {e}")
        return {"status": "error", "message": str(e)}


@router.get("/suggestions")
async def chatbot_suggestions():
    """Generate AI question suggestions based on recent summaries."""
    try:
        db = get_db()
        result = await generate_suggestions(db)
        return {"status": "ok", "informative": result["informative"], "analytical": result["analytical"]}
    except Exception as e:
        logger.error(f"[CHATBOT] Failed to generate suggestions: {e}")
        return {"status": "ok", "informative": [], "analytical": []}


@router.post("/send")
async def chatbot_send(request: Request):
    """Send a message and get AI response."""
    data = await request.json()
    session_id = data.get("session_id", "").strip()
    message = data.get("message", "").strip()

    context = data.get("context")  # {type, value} or None

    if not session_id or not message:
        return {"status": "error", "message": "session_id and message are required"}

    try:
        reply = await send_message(session_id, message, context=context)
        return {"status": "ok", "reply": reply}
    except ValueError as e:
        return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.error(f"[CHATBOT] Error in session {session_id}: {e}")
        return {"status": "error", "message": str(e)}


@router.post("/stream")
async def chatbot_stream(request: Request):
    """Stream chatbot response via SSE (step / delta / done / error events)."""
    data = await request.json()
    session_id = data.get("session_id", "").strip()
    message = data.get("message", "").strip()
    if not session_id or not message:
        async def _err():
            yield f'data: {json.dumps({"type": "error", "message": "session_id and message are required"})}\n\n'
        return StreamingResponse(_err(), media_type="text/event-stream")
    context = data.get("context")
    return StreamingResponse(
        stream_message(session_id, message, context=context),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.post("/end")
async def chatbot_end(request: Request):
    """End a chatbot session."""
    data = await request.json()
    delete_session(data.get("session_id", ""))
    return {"status": "ok"}


# ==================== System Chatbot ====================

@router.post("/system/start")
async def system_chatbot_start():
    """Create a new system chatbot session."""
    try:
        session_id = create_system_session()
        return {"status": "ok", "session_id": session_id}
    except Exception as e:
        logger.error(f"[SYS-CHAT] Failed to create session: {e}")
        return {"status": "error", "message": str(e)}


@router.post("/system/send")
async def system_chatbot_send(request: Request):
    """Send a message to the system chatbot. Returns reply + actions performed."""
    data = await request.json()
    session_id = data.get("session_id", "").strip()
    message = data.get("message", "").strip()

    if not session_id or not message:
        return {"status": "error", "message": "session_id and message are required"}

    try:
        result = await send_system_message(session_id, message)
        return {"status": "ok", "reply": result["reply"], "actions": result["actions"]}
    except ValueError as e:
        return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.error(f"[SYS-CHAT] Error in session {session_id}: {e}")
        return {"status": "error", "message": str(e)}


@router.post("/system/stream")
async def system_chatbot_stream(request: Request):
    """Stream system chatbot response via SSE (step / delta / done / error events)."""
    data = await request.json()
    session_id = data.get("session_id", "").strip()
    message = data.get("message", "").strip()
    if not session_id or not message:
        async def _err():
            yield f'data: {json.dumps({"type": "error", "message": "session_id and message are required"})}\n\n'
        return StreamingResponse(_err(), media_type="text/event-stream")
    return StreamingResponse(
        stream_system_message(session_id, message),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.post("/system/end")
async def system_chatbot_end(request: Request):
    """End a system chatbot session."""
    data = await request.json()
    delete_system_session(data.get("session_id", ""))
    return {"status": "ok"}


# ==================== Shared ====================

@router.post("/refine")
async def chatbot_refine(request: Request):
    """Refine/polish text using Gemini (reuses video_chat's refine)."""
    from youtube_monitor.video_chat import refine_text

    data = await request.json()
    text = data.get("text", "").strip()
    instruction = data.get("instruction", "").strip()

    if not text:
        return {"status": "error", "message": "text is required"}

    try:
        result = await refine_text(text, instruction)
        return {"status": "ok", "result": result}
    except Exception as e:
        logger.error(f"[CHATBOT] Refine error: {e}")
        return {"status": "error", "message": str(e)}


@router.post("/send-telegram")
async def chatbot_send_telegram(request: Request):
    """Send composed text to a Telegram channel/chat."""
    from youtube_monitor.worker import _telegram_send_fn

    data = await request.json()
    text = data.get("text", "").strip()
    target = data.get("target", "").strip()

    if not text:
        return {"status": "error", "message": "text is required"}
    if not target:
        return {"status": "error", "message": "target (channel/chat) is required"}

    if not _telegram_send_fn:
        return {"status": "error", "message": "Telegram send not available (bot not running)"}

    try:
        await _telegram_send_fn(target, text)
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"[CHATBOT] Telegram send error: {e}")
        return {"status": "error", "message": str(e)}
