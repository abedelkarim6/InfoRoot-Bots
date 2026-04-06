import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import start_bot_subprocess, stop_bot_subprocess
from utils.database import get_db
from routers.auth import is_admin_request

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


@router.get("/system/fixed-prefix")
def get_summaries_fixed_prefix(request: Request):
    """Return the active summaries system prompt and fixed prefix (admin only)."""
    if not is_admin_request(request):
        return {"status": "error", "message": "Admin only"}
    from utils.prompts import get_system_prompt, get_fixed_prefix, _DEFAULT_SYSTEM_PROMPT, _DEFAULT_FIXED_PREFIX
    return {
        "status": "ok",
        "system_prompt": get_system_prompt(),
        "fixed_prefix": get_fixed_prefix(),
        "default_system_prompt": _DEFAULT_SYSTEM_PROMPT,
        "default_fixed_prefix": _DEFAULT_FIXED_PREFIX,
    }


@router.post("/system/fixed-prefix/save")
async def save_summaries_fixed_prefix(request: Request):
    """Save overrides for the summaries system prompt and fixed prefix (admin only)."""
    if not is_admin_request(request):
        return {"status": "error", "message": "Admin only"}
    import yaml
    from utils.helpers import load_config
    data = await request.json()
    cfg = load_config()
    if "system_prompts" not in cfg:
        cfg["system_prompts"] = {}
    if "system_prompt" in data:
        cfg["system_prompts"]["summaries_system"] = data["system_prompt"]
    if "fixed_prefix" in data:
        cfg["system_prompts"]["summaries_prefix"] = data["fixed_prefix"]
    with open("config.yaml", "w", encoding="utf-8") as f:
        yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    return {"status": "ok"}


@router.post("/system/restart")
def restart_bot(request: Request):
    """Stop and restart the bot subprocess (used after session changes)."""
    bot_lock = request.app.state.bot_lock
    stop_bot_subprocess(request.app.state, bot_lock)
    proc = start_bot_subprocess(request.app.state)
    if proc is None:
        return {"status": "error", "message": "Bot failed to start after restart"}
    return {"status": "ok", "message": "Bot restarted successfully"}
