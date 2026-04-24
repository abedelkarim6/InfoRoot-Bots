import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import start_bot_task, stop_bot_task
from utils.database import get_db
from routers.auth import is_admin_request

logger = logging.getLogger("system_router")
router = APIRouter()

@router.get("/system/status")
def get_system_status(request: Request):
    db = get_db()
    full_cfg = db.get_full_config()
    bot_task = getattr(request.app.state, 'bot_task', None)
    bot_running = bot_task is not None and not bot_task.done()
    return {
        "enabled": full_cfg.get("system", {}).get("enabled", True),
        "bot_running": bot_running,
        "bots_count": len(full_cfg.get("bots", {})),
        "collections_count": len(full_cfg.get("collections", {}))
    }

@router.post("/system/toggle")
async def toggle_system(request: Request, enabled: bool = Body(..., embed=True)):
    db = get_db()
    db.set_system_enabled(enabled)

    if enabled:
        existing = getattr(request.app.state, 'bot_task', None)
        if existing and not existing.done():
            logger.info("Bot already running, skipping start")
            return {"status": "ok", "enabled": True, "message": "System enabled (bot already running)"}
        start_bot_task(request.app.state)
    else:
        await stop_bot_task(request.app.state)

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


@router.get("/system/ai-usage-details")
def get_ai_usage_details():
    """Return full AI usage breakdown: live meters + hourly stats + recent summaries."""
    from utils.gemini_usage import get_gemini_usage as _get, RPM_LIMIT, TPM_LIMIT, RPD_LIMIT
    db = get_db()
    live = _get()
    hourly = db.get_hourly_ai_stats(hours=24)
    recent = db.get_recent_summaries_for_ai_page(limit=100)
    return {
        "status": "ok",
        "live": live,
        "limits": {"rpm": RPM_LIMIT, "tpm": TPM_LIMIT, "rpd": RPD_LIMIT},
        "hourly": hourly,
        "recent": recent,
    }


@router.get("/system/fixed-prefix")
def get_summaries_fixed_prefix(request: Request):
    """Return the active summaries system prompt and fixed prefix (admin only)."""
    if not is_admin_request(request):
        return {"status": "error", "message": "Admin only"}
    from summaries.prompts import get_system_prompt, get_fixed_prefix, _DEFAULT_SYSTEM_PROMPT, _DEFAULT_FIXED_PREFIX
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
async def restart_bot(request: Request):
    """Stop and restart the bot task (used after session changes)."""
    await stop_bot_task(request.app.state)
    start_bot_task(request.app.state)
    return {"status": "ok", "message": "Bot restarted successfully"}
