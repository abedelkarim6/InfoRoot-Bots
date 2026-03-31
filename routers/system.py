import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import start_bot_subprocess, stop_bot_subprocess
from utils.database import get_db

logger = logging.getLogger("system_router")
router = APIRouter()

@router.get("/system/status")
def get_system_status(request: Request):
    db = get_db()
    full_cfg = db.get_full_config()
    bot_process = getattr(request.app.state, 'bot_process', None)
    bot_running = bot_process is not None and bot_process.poll() is None
    return {
        "enabled": full_cfg.get("system", {}).get("enabled", True),
        "bot_running": bot_running,
        "bots_count": len(full_cfg.get("bots", {})),
        "collections_count": len(full_cfg.get("collections", {}))
    }

@router.post("/system/toggle")
def toggle_system(request: Request, enabled: bool = Body(..., embed=True)):
    db = get_db()
    db.set_system_enabled(enabled)

    bot_lock = request.app.state.bot_lock

    if enabled:
        with bot_lock:
            existing = getattr(request.app.state, 'bot_process', None)
            if existing and existing.poll() is None:
                logger.info("Bot already running, skipping start")
                return {"status": "ok", "enabled": True, "message": "System enabled (bot already running)"}

        proc = start_bot_subprocess(request.app.state)
        if proc is None:
            return {"status": "error", "enabled": True, "message": "Bot crashed on startup"}
    else:
        stop_bot_subprocess(request.app.state, bot_lock)

    return {
        "status": "ok",
        "enabled": enabled,
        "message": f"System {'enabled' if enabled else 'disabled'}"
    }


@router.get("/system/gemini-usage")
def get_gemini_usage():
    """Return current Gemini API usage counters (RPM, TPM, RPD)."""
    from utils.gemini_usage import get_gemini_usage as _get
    return {"status": "ok", **_get()}


@router.post("/system/restart")
def restart_bot(request: Request):
    """Stop and restart the bot subprocess (used after session changes)."""
    bot_lock = request.app.state.bot_lock
    stop_bot_subprocess(request.app.state, bot_lock)
    proc = start_bot_subprocess(request.app.state)
    if proc is None:
        return {"status": "error", "message": "Bot failed to start after restart"}
    return {"status": "ok", "message": "Bot restarted successfully"}
