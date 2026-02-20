import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import load_config, save_config, start_bot_subprocess, stop_bot_subprocess

logger = logging.getLogger("system_router")
router = APIRouter()

@router.get("/system/status")
def get_system_status(request: Request):
    """Get system-wide status"""
    cfg = load_config()
    bot_process = getattr(request.app.state, 'bot_process', None)
    bot_running = bot_process is not None and bot_process.poll() is None
    return {
        "enabled": cfg.get("system", {}).get("enabled", True),
        "bot_running": bot_running,
        "bots_count": len(cfg.get("bots", {})),
        "collections_count": len(cfg.get("collections", {}))
    }

@router.post("/system/toggle")
def toggle_system(request: Request, enabled: bool = Body(..., embed=True)):
    """Toggle entire system on/off - also starts/stops the bot process"""
    cfg = load_config()
    cfg.setdefault("system", {})["enabled"] = enabled
    save_config(cfg)

    bot_lock = request.app.state.bot_lock

    if enabled:
        # Start the bot process
        with bot_lock:
            existing = getattr(request.app.state, 'bot_process', None)
            if existing and existing.poll() is None:
                logger.info("Bot already running, skipping start")
                return {"status": "ok", "enabled": True, "message": "System enabled (bot already running)"}

        proc = start_bot_subprocess(request.app.state)
        if proc is None:
            return {"status": "error", "enabled": True, "message": "Bot crashed on startup"}
    else:
        # Stop the bot process
        stop_bot_subprocess(request.app.state, bot_lock)

    return {
        "status": "ok",
        "enabled": enabled,
        "message": f"System {'enabled' if enabled else 'disabled'}"
    }
