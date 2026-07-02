"""
YouTube Monitor API router.
All endpoints under /api/youtube/...
"""

import asyncio
import re
import logging
from fastapi import APIRouter, Request, Query
from fastapi.responses import PlainTextResponse

from youtube_monitor.db import get_yt_db
from routers.auth import is_admin_request, get_request_user_id
from youtube_monitor.websub import (
    subscribe_channel,
    unsubscribe_channel,
    handle_verification,
    process_websub_notification,
    verify_signature as _verify_websub_sig,
    _get_websub_secret as _websub_secret,
    _get_default_targets,
)
from youtube_monitor.keyword_search import (
    run_keyword_search, run_all_keyword_searches, compute_capacity_plan,
    compute_search_forecast, compute_schedule_summary,
)
from youtube_monitor.worker import process_pending_queue, process_queue_item
from youtube_monitor import transcript_api
from youtube_monitor.prompts import (
    DEFAULT_PROMPT,
    _DEFAULT_FIXED_PREFIX_VIDEO, _DEFAULT_FIXED_PREFIX_TRANSCRIPT,
    _get_fixed_prefix_video, _get_fixed_prefix_transcript,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/youtube", tags=["youtube"])


def _get_yt_chat_user_id(request: Request):
    try:
        from routers.auth import _get_bearer, validate_token, get_token_user_id
        token = _get_bearer(request)
        if not token or not validate_token(token):
            return None
        return get_token_user_id(token)
    except Exception:
        return None


def _check_yt_limit(request: Request):
    user_id = _get_yt_chat_user_id(request)
    if user_id is None:
        return True, None
    try:
        from utils.database import get_db
        result = get_db().check_ai_limit(user_id)
        if not result["allowed"]:
            used  = result["used"]
            limit = result["limit"]
            return False, f"Monthly AI request limit reached ({used}/{limit}). Your plan allows {limit} requests per month."
        return True, None
    except Exception as e:
        logger.warning(f"[YT-CHAT] Limit check failed: {e}")
        return True, None


def _track_yt_usage(request: Request):
    user_id = _get_yt_chat_user_id(request)
    if user_id is None:
        return
    try:
        from utils.database import get_db
        get_db().track_ai_request(user_id)
    except Exception as e:
        logger.warning(f"[YT-CHAT] Usage tracking failed: {e}")


def _get_yt_user_source_filter(request: Request):
    """Return (yt_ch_ids, kw_db_ids, user_id) scoped to the current user.

    Returns (None, None, None) for admin → no filter (global view).
    Returns ([], [], None) for unauthenticated → see nothing.
    Returns ([youtube_channel_id_strings], [keyword_db_int_ids], user_id) for regular users.
    The user_id allows manually-added videos to be visible to the user who added them.
    """
    if is_admin_request(request):
        return None, None, None
    user_id = get_request_user_id(request)
    if not user_id:
        return [], [], None
    from utils.database import get_db
    inheritances = get_db().get_user_yt_inheritances(user_id)
    ch_db_ids = [i['source_id'] for i in inheritances if i['source_type'] == 'channel']
    kw_db_ids = [i['source_id'] for i in inheritances if i['source_type'] == 'keyword']
    # Resolve integer DB IDs → YouTube channel_id TEXT strings used in queue rows
    yt_db = get_yt_db()
    yt_ch_ids = []
    if ch_db_ids:
        ch_id_map = {ch['id']: ch['channel_id'] for ch in yt_db.get_channels()}
        yt_ch_ids = [ch_id_map[i] for i in ch_db_ids if i in ch_id_map]
    return yt_ch_ids, kw_db_ids, user_id


def _get_callback_url(request: Request = None):
    """Build the WebSub callback URL. Tries config.yaml first, then derives from request."""
    from utils.helpers import load_config
    cfg = load_config()
    base = cfg.get("youtube", {}).get("callback_url", "").rstrip("/")
    if not base and request:
        # Derive from the incoming request's URL
        base = str(request.base_url).rstrip("/")
    if base:
        return f"{base}/youtube/websub/callback"
    return ""


# ── WebSub callback (public — no auth) ───────────────────────────

websub_router = APIRouter(tags=["youtube-websub"])


@websub_router.get("/youtube/websub/callback")
async def websub_verify(request: Request):
    params = request.query_params
    mode = params.get("hub.mode", "")
    topic = params.get("hub.topic", "")
    challenge = params.get("hub.challenge", "")
    lease = params.get("hub.lease_seconds", "")
    result = handle_verification(mode, topic, challenge, lease)
    return PlainTextResponse(result)


@websub_router.post("/youtube/websub/callback")
async def websub_notification(request: Request):
    body = await request.body()
    sig = request.headers.get("X-Hub-Signature-256") or request.headers.get("X-Hub-Signature") or ""
    if _websub_secret():
        # Strict mode: secret configured → require valid signature.
        if not _verify_websub_sig(body, sig):
            logger.warning("[WEBSUB] Rejected callback with missing/invalid signature")
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Invalid signature"}, status_code=401)
    else:
        # Opt-in mode: no secret set → accept but warn so operators know the gap.
        logger.warning("[WEBSUB] No youtube.websub_secret configured — accepting callback unverified")
    # The hub retries on any non-2xx response, so a processing error must not
    # bubble up as a 500 — that turns one bad notification into a retry storm.
    # Log the full traceback and acknowledge with 200 regardless.
    try:
        count = process_websub_notification(body)
        return {"status": "ok", "enqueued": count}
    except Exception:
        logger.exception("[WEBSUB] Failed to process notification — acknowledging anyway")
        return {"status": "error", "enqueued": 0}


# ── System Overview ───────────────────────────────────────────────

@router.get("/overview")
async def youtube_overview(request: Request):
    try:
        yt_db = get_yt_db()
        if is_admin_request(request):
            return {"status": "ok", **yt_db.get_system_overview()}
        user_id = get_request_user_id(request)
        if not user_id:
            return {"status": "ok", **yt_db.get_system_overview(
                allowed_channel_db_ids=[], allowed_keyword_db_ids=[]
            )}
        from utils.database import get_db
        inheritances = get_db().get_user_yt_inheritances(user_id)
        ch_ids = {i['source_id'] for i in inheritances if i['source_type'] == 'channel'}
        kw_ids = {i['source_id'] for i in inheritances if i['source_type'] == 'keyword'}
        return {"status": "ok", **yt_db.get_system_overview(
            allowed_channel_db_ids=ch_ids, allowed_keyword_db_ids=kw_ids
        )}
    except Exception as e:
        logger.exception("[YT] Failed to load system overview")
        return {"status": "error", "message": str(e)}


# ── Channels ─────────────────────────────────────────────────────

@router.get("/channels")
async def list_channels(request: Request):
    try:
        yt_db = get_yt_db()
        channels = yt_db.get_channels()
        for ch in channels:
            ch['last_video'] = yt_db.get_channel_last_video(ch['channel_id'])

        if not is_admin_request(request):
            user_id = get_request_user_id(request)
            if user_id:
                from utils.database import get_db
                inheritances = get_db().get_user_yt_inheritances(user_id)
                allowed_ids = {i['source_id'] for i in inheritances if i['source_type'] == 'channel'}
                channels = [ch for ch in channels if ch['id'] in allowed_ids]

        return {"status": "ok", "channels": channels}
    except Exception as e:
        logger.exception("[YT] Failed to list channels")
        return {"status": "error", "message": str(e)}


@router.post("/channels/add")
async def add_channel(request: Request):
    try:
        data = await request.json()
        channel_id = data.get("channel_id", "").strip()
        channel_name = data.get("channel_name", "").strip() or None
        telegram_targets = data.get("telegram_targets") or []
        prompt_key = (data.get("prompt_key") or "").strip() or None

        if not channel_id:
            return {"status": "error", "message": "channel_id is required"}

        # Accept any reference — UC id, @handle, /channel/ or /c/ or /user/ URL, a
        # bare custom slug, or even a video link — and resolve it to a canonical UC
        # channel id so the WebSub subscription topic is always valid.
        import re as _re
        if not _re.match(r"^UC[0-9A-Za-z_-]{22}$", channel_id):
            from youtube_monitor.resolve import resolve_channel
            resolved = await resolve_channel(channel_id)
            if not resolved or not resolved.get("channel_id"):
                return {"status": "error",
                        "message": f"Could not resolve '{channel_id}' to a YouTube channel. "
                                   f"Paste the channel URL, @handle, or a video link from it."}
            channel_id = resolved["channel_id"]
            if not channel_name:
                channel_name = resolved.get("channel_name") or channel_id

        min_dur_sec = data.get("min_duration_seconds")
        max_dur_sec = data.get("max_duration_seconds")

        channel_data = {
            'channel_name': channel_name,
            'telegram_targets': telegram_targets,
            'prompt_key': prompt_key,
            'min_duration_seconds': min_dur_sec,
            'max_duration_seconds': max_dur_sec,
            'title_must_include': data.get('title_must_include') or [],
            'title_must_exclude': data.get('title_must_exclude') or [],
            'min_view_count': data.get('min_view_count', 0),
            'language': data.get('language') or None,
            'upload_type': data.get('upload_type') or None,
            'output_length_percent': _clean_percent(data.get('output_length_percent')),
        }

        try:
            db = get_yt_db()
            row_id = db.add_channel(channel_id, channel_data)
        except Exception as e:
            logger.error(f"[YT] Failed to add channel {channel_id}: {e}")
            return {"status": "error", "message": f"Database error: {e}"}

        # Auto-subscribe via WebSub
        cb_url = _get_callback_url(request)
        subscribed = False
        if cb_url:
            try:
                subscribed = await subscribe_channel(channel_id, cb_url)
            except Exception as e:
                logger.warning(f"[YT] Auto-subscribe failed for {channel_id}: {e}")

        return {"status": "ok", "id": row_id, "subscribed": subscribed}
    except Exception as e:
        logger.exception("[YT] Failed to add channel")
        return {"status": "error", "message": str(e)}


@router.post("/channels/update")
async def update_channel(request: Request):
    try:
        data = await request.json()
        channel_id = data.get("channel_id")
        channel_data = {
            'channel_name': data.get('channel_name'),
            'telegram_targets': data.get('telegram_targets') or [],
            'prompt_key': (data.get('prompt_key') or '').strip() or None,
            'min_duration_seconds': data.get('min_duration_seconds'),
            'max_duration_seconds': data.get('max_duration_seconds'),
            'title_must_include': data.get('title_must_include') or [],
            'title_must_exclude': data.get('title_must_exclude') or [],
            'min_view_count': data.get('min_view_count', 0),
            'language': data.get('language') or None,
            'upload_type': data.get('upload_type') or None,
            'output_length_percent': _clean_percent(data.get('output_length_percent')),
        }
        db = get_yt_db()
        db.update_channel(channel_id, channel_data)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to update channel")
        return {"status": "error", "message": str(e)}


@router.post("/channels/toggle")
async def toggle_channel(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.toggle_channel(data.get("channel_id"), data.get("active", True))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to toggle channel")
        return {"status": "error", "message": str(e)}


@router.post("/channels/toggle-all")
async def toggle_all_channels(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.toggle_all_channels(data.get("active", True))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to toggle all channels")
        return {"status": "error", "message": str(e)}


@router.post("/channels/delete")
async def delete_channel(request: Request):
    try:
        data = await request.json()
        channel_id = data.get("channel_id")
        db = get_yt_db()
        # Snapshot channel for recycle bin
        ch = db.get_channel_by_yt_id(channel_id)
        if ch:
            from utils.database import get_db
            # Convert datetime objects to ISO strings for JSON serialization
            for k, v in ch.items():
                if hasattr(v, 'isoformat'):
                    ch[k] = v.isoformat()
            get_db().recycle_bin_add('yt_channel', ch.get('channel_name') or channel_id, ch)
        db.delete_channel(channel_id)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to delete channel")
        return {"status": "error", "message": str(e)}


@router.post("/channels/subscribe")
async def trigger_subscribe(request: Request):
    """Manually re-subscribe a channel via WebSub."""
    try:
        data = await request.json()
        channel_id = data.get("channel_id")
        cb_url = _get_callback_url(request)
        if not cb_url:
            return {"status": "error", "message": "Could not determine callback URL"}
        success = await subscribe_channel(channel_id, cb_url)
        return {"status": "ok" if success else "error", "subscribed": success}
    except Exception as e:
        logger.exception("[YT] Failed to subscribe channel")
        return {"status": "error", "message": str(e)}


# ── Keywords ─────────────────────────────────────────────────────

@router.get("/keywords")
async def list_keywords(request: Request):
    try:
        yt_db = get_yt_db()
        keywords = yt_db.get_keywords()

        if not is_admin_request(request):
            user_id = get_request_user_id(request)
            if not user_id:
                return {"status": "ok", "keywords": [], "seo_count": 0, "seo_visible": False}
            from utils.database import get_db
            db = get_db()
            inheritances = db.get_user_yt_inheritances(user_id)
            allowed_ids = {i['source_id'] for i in inheritances if i['source_type'] == 'keyword'}

            # Include SEOs created by the user
            user_created_seos = db.get_user_created_seos(user_id)
            allowed_ids.update({seo['id'] for seo in user_created_seos})

            keywords = [kw for kw in keywords if kw['id'] in allowed_ids]

            # Check if user has permission to see full SEO details
            user_row = db.get_user_by_id(user_id)
            seo_visible = bool(user_row.get('seo_visible', True)) if user_row else True
            if not seo_visible:
                return {"status": "ok", "keywords": [], "seo_count": len(keywords), "seo_visible": False}
            return {"status": "ok", "keywords": keywords, "seo_count": len(keywords), "seo_visible": True}

        return {"status": "ok", "keywords": keywords, "seo_count": len(keywords), "seo_visible": True}
    except Exception as e:
        logger.exception("[YT] Failed to list keywords")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/add")
async def add_keyword(request: Request):
    try:
        data = await request.json()
        if not data.get("keyword", "").strip():
            return {"status": "error", "message": "keyword is required"}
        data['output_length_percent'] = _clean_percent(data.get('output_length_percent'))
        db = get_yt_db()
        row_id = db.add_keyword(data)
        return {"status": "ok", "id": row_id}
    except Exception as e:
        logger.exception("[YT] Failed to add keyword")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/update")
async def update_keyword(request: Request):
    try:
        data = await request.json()
        kw_id = data.get("id")
        if not kw_id:
            return {"status": "error", "message": "id is required"}
        data['output_length_percent'] = _clean_percent(data.get('output_length_percent'))
        db = get_yt_db()
        db.update_keyword(kw_id, data)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to update keyword")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/delete")
async def delete_keyword(request: Request):
    try:
        data = await request.json()
        kw_id = data.get("id")
        db = get_yt_db()
        # Snapshot keyword tracker for recycle bin
        kw = db.get_keyword_by_id(kw_id)
        if kw:
            from utils.database import get_db
            # Convert datetime objects to ISO strings for JSON serialization
            for k, v in kw.items():
                if hasattr(v, 'isoformat'):
                    kw[k] = v.isoformat()
            get_db().recycle_bin_add('yt_keyword', kw.get('keyword') or f'keyword-{kw_id}', kw)
        db.delete_keyword(kw_id)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to delete keyword")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/toggle")
async def toggle_keyword(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.toggle_keyword(data.get("id"), data.get("active", True))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to toggle keyword")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/toggle-all")
async def toggle_all_keywords(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.toggle_all_keywords(data.get("active", True))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to toggle all keywords")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/run")
async def run_single_keyword(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        kw_cfg = db.get_keyword_by_id(data.get("id"))
        if not kw_cfg:
            return {"status": "error", "message": "Keyword config not found"}
        try:
            count = run_keyword_search(kw_cfg)
            db.update_keyword_last_run(kw_cfg['id'])
            return {"status": "ok", "enqueued": count}
        except Exception as e:
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to run keyword search")
        return {"status": "error", "message": str(e)}


@router.post("/keywords/run-all")
async def run_all_keywords():
    try:
        count = run_all_keyword_searches()
        return {"status": "ok", "enqueued": count}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/keywords/quota-capacity")
async def keywords_quota_capacity(request: Request):
    """Quota demand vs daily budget + the per-keyword rotation plan, so the SEO
    page can show whether more keywords fit and how words are rotating. Admin
    only — it spans the whole (shared) daily quota and all active keywords."""
    if not is_admin_request(request):
        return {"status": "error", "message": "Admin only"}
    try:
        return compute_capacity_plan()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/schedules/forecast")
async def schedules_forecast(request: Request):
    """Next-24h SEO search forecast (per word, budget-aware) plus channel
    monitoring status, for the YouTube Schedules page 'Forecast' tab."""
    if not is_admin_request(request):
        return {"status": "error", "message": "Admin only"}
    try:
        return compute_search_forecast()
    except Exception as e:
        logger.exception("[YT] schedules forecast failed")
        return {"status": "error", "message": str(e)}


@router.get("/schedules/summary")
async def schedules_summary(request: Request):
    """Per-keyword sent/remaining-today rollup + channel summary, for the
    YouTube Schedules page 'Summary' tab."""
    if not is_admin_request(request):
        return {"status": "error", "message": "Admin only"}
    try:
        return compute_schedule_summary()
    except Exception as e:
        logger.exception("[YT] schedules summary failed")
        return {"status": "error", "message": str(e)}


# ── Blocked Channels ────────────────────────────────────────────

@router.get("/blocked-channels")
async def list_blocked_channels():
    try:
        db = get_yt_db()
        return {"status": "ok", "channels": db.get_blocked_channels()}
    except Exception as e:
        logger.exception("[YT] Failed to list blocked channels")
        return {"status": "error", "message": str(e)}


@router.post("/blocked-channels/add")
async def add_blocked_channel(request: Request):
    try:
        data = await request.json()
        channel_id = (data.get("channel_id") or "").strip()
        channel_name = (data.get("channel_name") or "").strip() or None
        if not channel_id:
            return {"status": "error", "message": "channel_id is required"}
        try:
            db = get_yt_db()
            row_id = db.add_blocked_channel(channel_id, channel_name)
            return {"status": "ok", "id": row_id}
        except Exception as e:
            logger.error(f"[YT] Failed to add blocked channel: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to add blocked channel")
        return {"status": "error", "message": str(e)}


@router.post("/blocked-channels/delete")
async def delete_blocked_channel(request: Request):
    try:
        data = await request.json()
        channel_id = data.get("channel_id")
        try:
            db = get_yt_db()
            db.delete_blocked_channel(channel_id)
            return {"status": "ok"}
        except Exception as e:
            logger.error(f"[YT] Failed to delete blocked channel: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to delete blocked channel")
        return {"status": "error", "message": str(e)}


# ── Blocked Keywords (for channels) ─────────────────────────────

@router.get("/blocked-keywords")
async def list_blocked_keywords():
    try:
        db = get_yt_db()
        return {"status": "ok", "keywords": db.get_blocked_keywords()}
    except Exception as e:
        logger.exception("[YT] Failed to list blocked keywords")
        return {"status": "error", "message": str(e)}


@router.post("/blocked-keywords/add")
async def add_blocked_keyword(request: Request):
    try:
        data = await request.json()
        keyword = (data.get("keyword") or "").strip()
        if not keyword:
            return {"status": "error", "message": "keyword is required"}
        try:
            db = get_yt_db()
            row_id = db.add_blocked_keyword(keyword)
            return {"status": "ok", "id": row_id}
        except Exception as e:
            logger.error(f"[YT] Failed to add blocked keyword: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to add blocked keyword")
        return {"status": "error", "message": str(e)}


@router.post("/blocked-keywords/delete")
async def delete_blocked_keyword(request: Request):
    try:
        data = await request.json()
        try:
            db = get_yt_db()
            db.delete_blocked_keyword(data.get("id"))
            return {"status": "ok"}
        except Exception as e:
            logger.error(f"[YT] Failed to delete blocked keyword: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to delete blocked keyword")
        return {"status": "error", "message": str(e)}


# ── Manual Video Submission ──────────────────────────────────────

@router.post("/videos/add")
async def add_manual_video(request: Request):
    """Manually add a YouTube video URL to be summarized."""
    try:
        data = await request.json()
        url = (data.get("url") or "").strip()
        # The frontend sends telegram_target: null when "Use default targets" is
        # selected — `.get(key, "")` returns None (key present), not the default,
        # so `.strip()` on None must be guarded.
        telegram_target = (data.get("telegram_target") or "").strip() or None
        # Manual video may pass either a free-form prompt (back-compat) or a key
        # into the global youtube prompts.
        raw_prompt = (data.get("prompt") or "").strip()
        prompt_key = (data.get("prompt_key") or "").strip()
        if prompt_key:
            from youtube_monitor.prompts import resolve_yt_prompt
            prompt = resolve_yt_prompt(prompt_key)
        else:
            prompt = raw_prompt or None

        if not url:
            return {"status": "error", "message": "url is required"}

        video_id = _extract_video_id(url)
        if not video_id:
            return {"status": "error", "message": "Could not extract video ID from URL"}

        # Optional forced summarization strategy. Manual adds let the user pick
        # 'gemini_video' (watch the video) or 'transcript_api' (transcript only);
        # anything else (incl. blank) means auto.
        force_method = (data.get("method") or "").strip() or None
        if force_method not in (None, 'gemini_video', 'transcript_api'):
            return {"status": "error", "message": "Invalid method"}

        db = get_yt_db()
        # Manual adds may summarize the same video more than once (a different
        # prompt, method, or just a refresh), so the "already summarized" guard
        # is dropped here — only a live queue entry ('pending'/'processing')
        # blocks a duplicate add.
        reason = db.is_video_already_queued_or_summarized(
            video_id, prompt=prompt, check_summarized=False)
        if reason:
            return {"status": "error", "message": f"Video {video_id} is {reason}"}

        added_by = get_request_user_id(request)  # None for admin (legacy token)
        db.mark_video_seen(video_id, title=None, channel_id=None, source='manual')

        output_length_percent = _clean_percent(data.get('output_length_percent'))

        # No explicit target → fall back to the global default targets, enqueuing
        # one queue row per target (same behavior as websub/keyword monitoring).
        targets = [telegram_target] if telegram_target else (_get_default_targets() or [None])
        queue_id = None
        for tgt in targets:
            qid = db.enqueue_video(video_id, telegram_target=tgt, prompt=prompt,
                                   added_by_user_id=added_by,
                                   output_length_percent=output_length_percent,
                                   force_method=force_method, allow_resummarize=True)
            if qid and queue_id is None:
                queue_id = qid

        return {"status": "ok", "video_id": video_id, "queue_id": queue_id}
    except Exception as e:
        logger.exception("[YT] Failed to add manual video")
        return {"status": "error", "message": str(e)}


def _extract_video_id(url: str):
    m = re.search(r'[?&]v=([a-zA-Z0-9_-]{11})', url)
    if m:
        return m.group(1)
    m = re.search(r'youtu\.be/([a-zA-Z0-9_-]{11})', url)
    if m:
        return m.group(1)
    m = re.search(r'youtube\.com/shorts/([a-zA-Z0-9_-]{11})', url)
    if m:
        return m.group(1)
    if re.match(r'^[a-zA-Z0-9_-]{11}$', url):
        return url
    return None


# ── Prompt (global default) ──────────────────────────────────────

@router.get("/prompt")
async def get_prompt():
    try:
        # The global default YouTube prompt lives in the DB (prompts table, type='youtube').
        # default_targets is a separate config setting and stays in config.yaml.
        from utils.helpers import load_config
        from youtube_monitor.prompts import _get_global_prompt
        default_targets = load_config().get("youtube", {}).get("default_targets", [])
        return {"status": "ok", "prompt": _get_global_prompt(), "default_prompt": DEFAULT_PROMPT,
                "default_targets": default_targets}
    except Exception as e:
        logger.exception("[YT] Failed to load prompt")
        return {"status": "error", "message": str(e)}


@router.post("/prompt/save")
async def save_prompt(request: Request):
    try:
        # Writes the live global YouTube prompt (DB, type='youtube', key='default').
        # Admin-only because it edits the shared default used for all summarization.
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        data = await request.json()
        from utils.database import get_db
        get_db().save_prompt('default', data.get("prompt", ""), owner_id=None,
                             prompt_type='youtube', name='default')
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to save prompt")
        return {"status": "error", "message": str(e)}


@router.get("/fixed-prefix")
async def get_fixed_prefix(request: Request):
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        return {
            "status": "ok",
            "prefix_video": _get_fixed_prefix_video(),
            "prefix_transcript": _get_fixed_prefix_transcript(),
            "default_prefix_video": _DEFAULT_FIXED_PREFIX_VIDEO,
            "default_prefix_transcript": _DEFAULT_FIXED_PREFIX_TRANSCRIPT,
        }
    except Exception as e:
        logger.exception("[YT] Failed to load fixed prefix")
        return {"status": "error", "message": str(e)}


@router.post("/fixed-prefix/save")
async def save_fixed_prefix(request: Request):
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        from utils.helpers import load_config, save_config
        data = await request.json()
        cfg = load_config()
        if "system_prompts" not in cfg:
            cfg["system_prompts"] = {}
        if "prefix_video" in data:
            cfg["system_prompts"]["youtube_prefix_video"] = data["prefix_video"]
        if "prefix_transcript" in data:
            cfg["system_prompts"]["youtube_prefix_transcript"] = data["prefix_transcript"]
        save_config(cfg)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to save fixed prefix")
        return {"status": "error", "message": str(e)}


# ── Gemini Thinking (YouTube) ────────────────────────────────────
# Independent of the summaries feature's `gemini_thinking` setting so YouTube
# summarization can use Gemini 2.5 extended reasoning on its own.

@router.get("/gemini-thinking")
async def get_yt_gemini_thinking(request: Request):
    """Return the current YouTube Gemini thinking toggle. Admin only."""
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        from utils.database import get_db
        val = get_db().get_setting("yt_gemini_thinking") or {}
        return {
            "status": "ok",
            "enabled": bool(val.get("enabled", False)),
            # -1 = dynamic (model decides), 0 = off, positive = max thinking tokens.
            "budget": int(val.get("budget", -1)),
        }
    except Exception as e:
        logger.exception("[YT] Failed to load gemini thinking setting")
        return {"status": "error", "message": str(e)}


@router.post("/gemini-thinking")
async def set_yt_gemini_thinking(request: Request):
    """Update the YouTube Gemini thinking toggle. Admin only."""
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        data = await request.json()
        enabled = bool(data.get("enabled", False))
        try:
            budget = int(data.get("budget", -1))
        except (TypeError, ValueError):
            budget = -1
        from utils.database import get_db
        get_db().set_setting("yt_gemini_thinking", {"enabled": enabled, "budget": budget})
        return {"status": "ok", "enabled": enabled, "budget": budget}
    except Exception as e:
        logger.exception("[YT] Failed to save gemini thinking setting")
        return {"status": "error", "message": str(e)}


def _clean_percent(val):
    """Coerce an output-length percentage into an int in 1..100, or None."""
    if val in (None, "", 0, "0"):
        return None
    try:
        n = int(float(val))
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return min(n, 100)


@router.get("/output-length")
async def get_output_length():
    """Return the global default output-length percentage (0 = disabled)."""
    try:
        from utils.database import get_db
        val = get_db().get_setting("yt_output_length_percent") or {}
        pct = val.get("percent") if isinstance(val, dict) else val
        return {"status": "ok", "percent": int(pct) if pct else 0}
    except Exception as e:
        logger.exception("[YT] Failed to load output-length setting")
        return {"status": "error", "message": str(e)}


@router.post("/output-length")
async def set_output_length(request: Request):
    """Set the global default output-length percentage. 0/empty disables it."""
    try:
        data = await request.json()
        pct = _clean_percent(data.get("percent"))
        from utils.database import get_db
        get_db().set_setting("yt_output_length_percent", {"percent": pct or 0})
        return {"status": "ok", "percent": pct or 0}
    except Exception as e:
        logger.exception("[YT] Failed to save output-length setting")
        return {"status": "error", "message": str(e)}


@router.post("/default-targets/save")
async def save_default_targets(request: Request):
    try:
        from utils.helpers import load_config, save_config
        data = await request.json()
        cfg = load_config()
        if "youtube" not in cfg:
            cfg["youtube"] = {}
        cfg["youtube"]["default_targets"] = data.get("targets", [])
        save_config(cfg)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to save default targets")
        return {"status": "error", "message": str(e)}


# ── Videos (unified queue + summaries) ────────────────────────────

@router.get("/videos")
async def get_videos_unified(
    request: Request,
    status: str = Query(None),
    channel: str = Query(None),
    source: str = Query(None),
    keyword: str = Query(None),
    limit: int = Query(50),
    offset: int = Query(0),
    date_from: str = Query(None),
    date_to: str = Query(None),
):
    try:
        db = get_yt_db()
        yt_ch_ids, kw_ids, uid = _get_yt_user_source_filter(request)
        stats = db.get_queue_stats(yt_ch_ids=yt_ch_ids, kw_ids=kw_ids, user_id=uid)
        result = db.get_videos_unified(
            limit=limit, offset=offset, status_filter=status,
            channel_filter=channel, source_filter=source,
            keyword_filter=keyword,
            date_from=date_from, date_to=date_to,
            yt_ch_ids=yt_ch_ids, kw_ids=kw_ids, user_id=uid,
        )
        return {"status": "ok", "stats": stats, "items": result["items"], "total": result["total"]}
    except Exception as e:
        logger.exception("[YT] Failed to load videos")
        return {"status": "error", "message": f"Failed to load videos: {e}"}


@router.get("/videos/{video_id}/transcript")
async def get_video_transcript(video_id: str):
    """Return the transcript for a video.

    Serves the DB cache first; otherwise fetches via the external transcript API
    (primary — a headless scraper that isn't IP-blocked) and finally the
    youtube-transcript-api library (last-resort fallback), caching whatever it
    retrieves so the next request comes straight from the DB."""
    try:
        db = get_yt_db()
        cached = db.get_cached_transcript(video_id)
        if cached:
            return {"status": "ok", "video_id": video_id, "text": cached, "cached": True}

        loop = asyncio.get_event_loop()

        # Primary: external transcript API (headless scraper — not IP-blocked).
        if transcript_api.is_configured():
            try:
                video = await loop.run_in_executor(None, transcript_api.fetch_video, video_id)
            except transcript_api.TranscriptApiRateLimited as e:
                return {"status": "error",
                        "message": f"Transcript service busy — try again in {e.retry_after or 40}s"}
            except Exception as e:
                video = None
                logger.warning("[YT] Transcript API error for %s: %s", video_id, e)
            text = transcript_api.extract_transcript_text(video) if video else ""
            if text:
                try:
                    db.cache_transcript(video_id, text)
                except Exception:
                    logger.exception("[YT] Failed to cache transcript for %s", video_id)
                return {"status": "ok", "video_id": video_id, "text": text, "cached": False}

        # Fallback: youtube-transcript-api library (works from non-blocked IPs only).
        try:
            from youtube_transcript_api import YouTubeTranscriptApi
        except Exception as e:
            return {"status": "error", "message": f"transcript library unavailable: {e}"}

        def _fetch():
            ytt_api = YouTubeTranscriptApi()
            try:
                return ytt_api.fetch(video_id)
            except Exception:
                transcript_map = ytt_api.list(video_id)
                available = list(transcript_map)
                if not available:
                    raise
                return available[0].fetch()

        try:
            transcript_list = await loop.run_in_executor(None, _fetch)
        except Exception as e:
            return {"status": "error", "message": f"No transcript available: {e}"}

        text = '\n'.join(entry.text for entry in transcript_list)
        # Persist so the next request for this video serves from the DB.
        try:
            db.cache_transcript(video_id, text)
        except Exception:
            logger.exception("[YT] Failed to cache transcript for %s", video_id)
        return {"status": "ok", "video_id": video_id, "text": text, "cached": False}
    except Exception as e:
        logger.exception("[YT] Failed to get transcript")
        return {"status": "error", "message": str(e)}


# ── Queue ────────────────────────────────────────────────────────

@router.get("/queue")
async def get_queue(request: Request):
    try:
        db = get_yt_db()
        yt_ch_ids, kw_ids, uid = _get_yt_user_source_filter(request)
        stats = db.get_queue_stats(yt_ch_ids=yt_ch_ids, kw_ids=kw_ids, user_id=uid)
        items = db.get_queue_items(limit=200, yt_ch_ids=yt_ch_ids, kw_ids=kw_ids, user_id=uid)
        return {"status": "ok", "stats": stats, "items": items}
    except Exception as e:
        logger.exception("[YT] Failed to load queue")
        return {"status": "error", "message": str(e)}


@router.post("/queue/retry")
async def retry_queue_item(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.retry_queue_item(data.get("id"))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to retry queue item")
        return {"status": "error", "message": str(e)}


async def _run_queue_item_bg(queue_id: int, item: dict):
    """Background wrapper: writes a final 'failed' status row if
    process_queue_item itself crashes.

    No outer timeout: each summarization strategy is already capped at
    _ITEM_TIMEOUT_SECS inside process_queue_item, the item is marked 'done'
    the instant its summary is saved (before the best-effort Telegram send),
    and reset_stuck_processing_items recovers any genuinely wedged item.
    Wrapping this in asyncio.wait_for would cancel the post-summary
    bookkeeping and wrongly mark an already-saved summary as 'failed'."""
    try:
        await process_queue_item(item)
    except Exception as e:
        logger.error(f"[YT-PROCESS-ONE-BG] {queue_id}: {e}", exc_info=True)
        try:
            get_yt_db().update_queue_status(queue_id, 'failed', error_log=str(e))
        except Exception as ee:
            logger.error(f"[YT-PROCESS-ONE-BG] failed-update failed for {queue_id}: {ee}")


async def _run_pending_queue_bg():
    try:
        await process_pending_queue()
    except Exception as e:
        logger.error(f"[YT-PROCESS-BG] {e}", exc_info=True)


@router.post("/queue/process")
async def trigger_process_queue():
    """Kick off pending-queue processing in the background and return
    immediately so nginx (60s) doesn't 504. The table's auto-refresh
    surfaces results as items move through 'processing' → 'done'/'failed'."""
    try:
        asyncio.create_task(_run_pending_queue_bg())
        return {"status": "ok", "queued": True}
    except Exception as e:
        logger.exception("[YT] Failed to trigger queue processing")
        return {"status": "error", "message": str(e)}


@router.post("/queue/process-one")
async def process_single_queue_item(request: Request):
    """Schedule a single queue item to be processed in the background.
    Returns immediately; the row's status moves to 'processing' on the
    next refresh and to 'done'/'failed' once the worker finishes."""
    try:
        data = await request.json()
        queue_id = data.get("id")
        if not queue_id:
            return {"status": "error", "message": "id is required"}
        db = get_yt_db()
        item = db.get_queue_item_by_id(queue_id)
        if not item:
            return {"status": "error", "message": "Queue item not found"}
        if item['status'] not in ('pending', 'failed'):
            return {"status": "error", "message": f"Cannot process item with status '{item['status']}'"}

        # Reset to pending if failed (so attempts counter resets correctly)
        if item['status'] == 'failed':
            db.retry_queue_item(queue_id)
            item = db.get_queue_item_by_id(queue_id)

        asyncio.create_task(_run_queue_item_bg(queue_id, item))
        return {"status": "ok", "queued": True}
    except Exception as e:
        logger.exception("[YT] Failed to process single queue item")
        return {"status": "error", "message": str(e)}


@router.post("/queue/reset-stuck")
async def reset_stuck_queue_items():
    """Force all stuck 'processing' items to 'failed' so they can be retried."""
    try:
        db = get_yt_db()
        count = db.reset_all_processing_to_failed()
        return {"status": "ok", "reset": count}
    except Exception as e:
        logger.exception("[YT] Failed to reset stuck queue items")
        return {"status": "error", "message": str(e)}


@router.get("/queue/{queue_id}")
async def get_queue_item_detail(queue_id: int):
    try:
        db = get_yt_db()
        item = db.get_queue_item_by_id(queue_id)
        if not item:
            return {"status": "error", "message": "Queue item not found"}
        return {"status": "ok", "item": item}
    except Exception as e:
        logger.exception("[YT] Failed to load queue item detail")
        return {"status": "error", "message": str(e)}


@router.post("/queue/delete")
async def delete_queue_item(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.delete_queue_item(data.get("id"))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to delete queue item")
        return {"status": "error", "message": str(e)}


@router.post("/queue/clear")
async def clear_queue():
    try:
        db = get_yt_db()
        deleted = db.clear_queue()
        return {"status": "ok", "deleted": deleted}
    except Exception as e:
        logger.exception("[YT] Failed to clear queue")
        return {"status": "error", "message": str(e)}


@router.post("/queue/clear-failed")
async def clear_failed_queue_items():
    try:
        db = get_yt_db()
        deleted = db.delete_queue_items_by_status('failed')
        return {"status": "ok", "deleted": deleted}
    except Exception as e:
        logger.exception("[YT] Failed to clear failed queue items")
        return {"status": "error", "message": str(e)}


# ── Summaries ────────────────────────────────────────────────────

@router.get("/summaries")
async def get_summaries(
    request: Request,
    channel_name: str = Query(None),
    transcript_source: str = Query(None),
    telegram_sent: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    limit: int = Query(100),
):
    try:
        db = get_yt_db()
        yt_ch_ids, kw_ids, uid = _get_yt_user_source_filter(request)
        summaries = db.get_summaries(
            limit=limit, channel_name=channel_name,
            transcript_source=transcript_source, telegram_sent=telegram_sent,
            date_from=date_from, date_to=date_to,
            yt_ch_ids=yt_ch_ids, kw_ids=kw_ids, user_id=uid,
        )
        return {"status": "ok", "summaries": summaries}
    except Exception as e:
        logger.exception("[YT] Failed to load summaries")
        return {"status": "error", "message": str(e)}


@router.get("/summaries/{summary_id}")
async def get_summary_detail(summary_id: int):
    try:
        db = get_yt_db()
        summary = db.get_summary_by_id(summary_id)
        if not summary:
            return {"status": "error", "message": "Summary not found"}
        return {"status": "ok", "summary": summary}
    except Exception as e:
        logger.exception("[YT] Failed to load summary detail")
        return {"status": "error", "message": str(e)}


@router.post("/summaries/delete")
async def delete_summary(request: Request):
    try:
        data = await request.json()
        db = get_yt_db()
        db.delete_summary(data.get("id"))
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to delete summary")
        return {"status": "error", "message": str(e)}


@router.post("/summaries/clear")
async def clear_summaries():
    try:
        db = get_yt_db()
        deleted = db.clear_summaries()
        return {"status": "ok", "deleted": deleted}
    except Exception as e:
        logger.exception("[YT] Failed to clear summaries")
        return {"status": "error", "message": str(e)}


# ── Video Chat (Gemini context-cached conversations) ─────────

from youtube_monitor.video_chat import (
    create_chat_session,
    send_chat_message,
    get_chat_session,
    delete_chat_session,
    refine_text,
)


@router.post("/chat/start")
async def chat_start(request: Request):
    """Start a new chat session with a YouTube video."""
    try:
        data = await request.json()
        url = data.get("url", "").strip()
        if not url:
            return {"status": "error", "message": "url is required"}

        video_id = _extract_video_id(url)
        if not video_id:
            return {"status": "error", "message": "Could not extract video ID"}

        try:
            session = await create_chat_session(video_id)
            return {"status": "ok", "session": session}
        except Exception as e:
            logger.error(f"[YT-CHAT] Failed to start session for {video_id}: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to start chat session")
        return {"status": "error", "message": str(e)}


@router.post("/chat/send")
async def chat_send(request: Request):
    """Send a message in an existing chat session."""
    try:
        data = await request.json()
        session_id = data.get("session_id", "").strip()
        message = data.get("message", "").strip()

        if not session_id or not message:
            return {"status": "error", "message": "session_id and message are required"}

        allowed, err = _check_yt_limit(request)
        if not allowed:
            return {"status": "error", "message": err, "limit_reached": True}

        try:
            reply = await send_chat_message(session_id, message)
            _track_yt_usage(request)
            return {"status": "ok", "reply": reply}
        except Exception as e:
            logger.error(f"[YT-CHAT] Chat error in {session_id}: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to send chat message")
        return {"status": "error", "message": str(e)}


@router.post("/chat/refine")
async def chat_refine(request: Request):
    """Refine/merge text using Gemini (no video context needed)."""
    try:
        data = await request.json()
        text = data.get("text", "").strip()
        instruction = data.get("instruction", "").strip()

        if not text:
            return {"status": "error", "message": "text is required"}

        try:
            result = await refine_text(text, instruction)
            return {"status": "ok", "result": result}
        except Exception as e:
            logger.error(f"[YT-CHAT] Refine error: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to refine text")
        return {"status": "error", "message": str(e)}


@router.post("/chat/send-telegram")
async def chat_send_telegram(request: Request):
    """Send composed text to a Telegram channel/chat."""
    try:
        from youtube_monitor.worker import _telegram_send_fn
        data = await request.json()
        text = data.get("text", "").strip()
        target = data.get("target", "").strip()

        if not text:
            return {"status": "error", "message": "text is required"}
        if not target:
            return {"status": "error", "message": "target (channel/chat) is required"}
        if not _telegram_send_fn:
            return {"status": "error", "message": "Telegram sender not configured"}

        try:
            await _telegram_send_fn(target, text)
            return {"status": "ok"}
        except Exception as e:
            logger.error(f"[YT-CHAT] Telegram send failed to {target}: {e}")
            return {"status": "error", "message": str(e)}
    except Exception as e:
        logger.exception("[YT] Failed to send chat text to Telegram")
        return {"status": "error", "message": str(e)}


@router.post("/chat/end")
async def chat_end(request: Request):
    """End a chat session and free resources."""
    try:
        data = await request.json()
        session_id = data.get("session_id", "").strip()
        delete_chat_session(session_id)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[YT] Failed to end chat session")
        return {"status": "error", "message": str(e)}
