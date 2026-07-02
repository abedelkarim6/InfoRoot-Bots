import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import start_bot_task, stop_bot_task
from utils.database import get_db
from routers.auth import is_admin_request

logger = logging.getLogger("system_router")
router = APIRouter()

@router.get("/system/status")
def get_system_status(request: Request):
    try:
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
    except Exception as e:
        logger.exception("[SYSTEM] get_system_status failed")
        return {"status": "error", "message": str(e)}

@router.post("/system/toggle")
async def toggle_system(request: Request, enabled: bool = Body(..., embed=True)):
    try:
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
    except Exception as e:
        logger.exception("[SYSTEM] toggle_system failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/gemini-usage")
def get_gemini_usage():
    """Return current Gemini API usage counters (RPM, TPM, RPD)."""
    try:
        from utils.gemini_usage import get_gemini_usage as _get
        return {"status": "ok", **_get()}
    except Exception as e:
        logger.exception("[SYSTEM] get_gemini_usage failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/gemini-thinking")
def get_gemini_thinking(request: Request):
    """Return the current Gemini thinking toggle. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        db = get_db()
        val = db.get_setting("gemini_thinking") or {}
        return {
            "status": "ok",
            "enabled": bool(val.get("enabled", False)),
            # -1 = dynamic (model decides), 0 = off, positive = max tokens cap.
            # We default to -1 when enabled so the model self-regulates.
            "budget": int(val.get("budget", -1)),
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_gemini_thinking failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/gemini-thinking")
def set_gemini_thinking(request: Request, data: dict = Body(...)):
    """Update the Gemini thinking toggle. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        enabled = bool(data.get("enabled", False))
        try:
            budget = int(data.get("budget", -1))
        except (TypeError, ValueError):
            budget = -1
        db = get_db()
        db.set_setting("gemini_thinking", {"enabled": enabled, "budget": budget})
        return {"status": "ok", "enabled": enabled, "budget": budget}
    except Exception as e:
        logger.exception("[SYSTEM] set_gemini_thinking failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/gemini-model")
def get_gemini_model_setting(request: Request):
    """Return the primary model, the compare list, and the options. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.gemini_models import get_gemini_model_config
        return {"status": "ok", **get_gemini_model_config()}
    except Exception as e:
        logger.exception("[SYSTEM] get_gemini_model_setting failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/gemini-model")
def set_gemini_model_setting(request: Request, data: dict = Body(...)):
    """Update the primary model + compare list. Admin only.

    Body: {"primary": "<model>", "compare": ["<model>", ...]}. The primary is
    the output sent to Telegram; every model in `compare` is also run by the
    scheduler for side-by-side testing (extra token cost — one full generation
    per compare model). Legacy {"model": "..."} is accepted as primary-only.
    All values must be in the allowed options.
    """
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.gemini_models import get_available_models
        from fastapi.responses import JSONResponse

        # Validate against the models the project can actually call, so a model
        # that 404s can't be saved and silently break all summarization.
        allowed = get_available_models()
        primary = (data.get("primary") or data.get("model") or "").strip()
        if primary not in allowed:
            return JSONResponse(
                {"status": "error",
                 "message": f"Model not available to this project: {primary!r}"},
                status_code=400,
            )

        compare = []
        for m in (data.get("compare") or []):
            m = (m or "").strip()
            if m not in allowed:
                return JSONResponse(
                    {"status": "error",
                     "message": f"Model not available to this project: {m!r}"},
                    status_code=400,
                )
            if m != primary and m not in compare:
                compare.append(m)

        get_db().set_setting("gemini_model", {"primary": primary, "compare": compare})
        return {"status": "ok", "primary": primary, "compare": compare}
    except Exception as e:
        logger.exception("[SYSTEM] set_gemini_model_setting failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/summary-thoughts")
def get_summary_thoughts(request: Request, id: int):
    """Return the saved thinking trace for a single summary. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        db = get_db()
        try:
            cursor = db._get_cursor()
            cursor.execute(
                "SELECT id, thoughts FROM summaries WHERE id = %s",
                (id,)
            )
            row = cursor.fetchone()
        finally:
            db._commit()
        if not row:
            return {"status": "error", "message": "Summary not found"}
        return {"status": "ok", "id": row["id"], "thoughts": row.get("thoughts") or ""}
    except Exception as e:
        logger.exception("[SYSTEM] get_summary_thoughts failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/youtube-quota-details")
def get_youtube_quota_details(request: Request):
    """Return YouTube Data API quota usage: today's units vs limit, hourly
    breakdown, and the most recent API calls. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from youtube_monitor.db import get_yt_db, get_quota_limit, QUOTA_COST
        ydb = get_yt_db()
        if ydb is None:
            return {"status": "error", "message": "YouTube DB not initialized"}
        return {
            "status": "ok",
            "today": ydb.get_quota_today(),
            "limit": get_quota_limit(),
            "hourly": ydb.get_hourly_api_usage(hours=24),
            "recent": ydb.get_recent_api_calls(limit=100),
            "costs": QUOTA_COST,
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_youtube_quota_details failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/ai-usage-details")
def get_ai_usage_details(request: Request):
    """Return full AI usage breakdown: live meters + hourly stats + recent summaries. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
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
    except Exception as e:
        logger.exception("[SYSTEM] get_ai_usage_details failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/fixed-prefix")
def get_summaries_fixed_prefix(request: Request):
    """Return the active summaries system prompt and fixed prefix (admin only)."""
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        from summaries.prompts import (get_system_prompt, get_fixed_prefix, get_bullet_points_suffix,
                                        _DEFAULT_SYSTEM_PROMPT, _DEFAULT_FIXED_PREFIX, _DEFAULT_BULLET_POINTS_SUFFIX)
        from utils.helpers import load_system_prompts
        active_bp_suffix = load_system_prompts().get("bullet_points_suffix", "") or _DEFAULT_BULLET_POINTS_SUFFIX
        return {
            "status": "ok",
            "system_prompt": get_system_prompt(),
            "fixed_prefix": get_fixed_prefix(),
            "bullet_points_suffix": active_bp_suffix,
            "default_system_prompt": _DEFAULT_SYSTEM_PROMPT,
            "default_fixed_prefix": _DEFAULT_FIXED_PREFIX,
            "default_bullet_points_suffix": _DEFAULT_BULLET_POINTS_SUFFIX,
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_summaries_fixed_prefix failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/fixed-prefix/save")
async def save_summaries_fixed_prefix(request: Request):
    """Save overrides for the summaries system prompt and fixed prefix (admin only)."""
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        from utils.helpers import load_system_prompts, save_system_prompts
        data = await request.json()
        prompts = load_system_prompts()
        if "system_prompt" in data:
            prompts["summaries_system"] = data["system_prompt"]
        if "fixed_prefix" in data:
            prompts["summaries_prefix"] = data["fixed_prefix"]
        if "bullet_points_suffix" in data:
            prompts["bullet_points_suffix"] = data["bullet_points_suffix"]
        save_system_prompts(prompts)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SYSTEM] save_summaries_fixed_prefix failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/restart")
async def restart_bot(request: Request):
    """Stop and restart the bot task (used after session changes)."""
    try:
        await stop_bot_task(request.app.state)
        start_bot_task(request.app.state)
        return {"status": "ok", "message": "Bot restarted successfully"}
    except Exception as e:
        logger.exception("[SYSTEM] restart_bot failed")
        return {"status": "error", "message": str(e)}
