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
)
from youtube_monitor.keyword_search import run_keyword_search, run_all_keyword_searches
from youtube_monitor.worker import process_pending_queue, process_queue_item, DEFAULT_PROMPT

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
    """Return (yt_ch_ids, kw_db_ids) scoped to the current user.

    Returns (None, None) for admin → no filter (global view).
    Returns ([], []) for unauthenticated → see nothing.
    Returns ([youtube_channel_id_strings], [keyword_db_int_ids]) for regular users.
    """
    if is_admin_request(request):
        return None, None
    user_id = get_request_user_id(request)
    if not user_id:
        return [], []
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
    return yt_ch_ids, kw_db_ids


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


async def _resolve_handle(handle: str):
    """Resolve a YouTube @handle to (channel_id, channel_name) using the Data API."""
    from utils.helpers import load_config
    cfg = load_config()
    api_key = cfg.get("youtube", {}).get("data_api_key", "")
    if not api_key:
        logger.warning("[YT] Cannot resolve @handle — youtube.data_api_key not set")
        return None
    try:
        import httpx
        url = "https://www.googleapis.com/youtube/v3/channels"
        params = {"part": "snippet", "forHandle": handle, "key": api_key}
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, params=params, timeout=15)
        data = resp.json()
        items = data.get("items", [])
        if items:
            ch = items[0]
            return ch["id"], ch["snippet"].get("title")
    except Exception as e:
        logger.error(f"[YT] Failed to resolve @{handle}: {e}")
    return None


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
    count = process_websub_notification(body)
    return {"status": "ok", "enqueued": count}


# ── System Overview ───────────────────────────────────────────────

@router.get("/overview")
async def youtube_overview(request: Request):
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


# ── Channels ─────────────────────────────────────────────────────

@router.get("/channels")
async def list_channels(request: Request):
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


@router.post("/channels/add")
async def add_channel(request: Request):
    data = await request.json()
    channel_id = data.get("channel_id", "").strip()
    channel_name = data.get("channel_name", "").strip() or None
    telegram_targets = data.get("telegram_targets") or []
    prompt = (data.get("prompt") or "").strip() or None

    if not channel_id:
        return {"status": "error", "message": "channel_id is required"}

    # Bare @handle (e.g. "@MokhbirEqtisadi")
    if channel_id.startswith("@"):
        handle = channel_id[1:]
        resolved = await _resolve_handle(handle)
        if not resolved:
            return {"status": "error", "message": f"Could not resolve @{handle} to a channel ID"}
        channel_id, resolved_name = resolved
        if not channel_name:
            channel_name = resolved_name

    elif "youtube.com" in channel_id:
        if "/channel/" in channel_id:
            channel_id = channel_id.split("/channel/")[-1].split("/")[0].split("?")[0]
        elif "/@" in channel_id:
            handle = channel_id.split("/@")[-1].split("/")[0].split("?")[0]
            resolved = await _resolve_handle(handle)
            if not resolved:
                return {"status": "error", "message": f"Could not resolve @{handle} to a channel ID"}
            channel_id, resolved_name = resolved
            if not channel_name:
                channel_name = resolved_name

    min_dur_sec = data.get("min_duration_seconds")
    max_dur_sec = data.get("max_duration_seconds")

    channel_data = {
        'channel_name': channel_name,
        'telegram_targets': telegram_targets,
        'prompt': prompt,
        'min_duration_seconds': min_dur_sec,
        'max_duration_seconds': max_dur_sec,
        'title_must_include': data.get('title_must_include') or [],
        'title_must_exclude': data.get('title_must_exclude') or [],
        'min_view_count': data.get('min_view_count', 0),
        'language': data.get('language') or None,
        'upload_type': data.get('upload_type') or None,
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


@router.post("/channels/update")
async def update_channel(request: Request):
    data = await request.json()
    channel_id = data.get("channel_id")
    channel_data = {
        'channel_name': data.get('channel_name'),
        'telegram_targets': data.get('telegram_targets') or [],
        'prompt': data.get('prompt'),
        'min_duration_seconds': data.get('min_duration_seconds'),
        'max_duration_seconds': data.get('max_duration_seconds'),
        'title_must_include': data.get('title_must_include') or [],
        'title_must_exclude': data.get('title_must_exclude') or [],
        'min_view_count': data.get('min_view_count', 0),
        'language': data.get('language') or None,
        'upload_type': data.get('upload_type') or None,
    }
    db = get_yt_db()
    db.update_channel(channel_id, channel_data)
    return {"status": "ok"}


@router.post("/channels/toggle")
async def toggle_channel(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.toggle_channel(data.get("channel_id"), data.get("active", True))
    return {"status": "ok"}


@router.post("/channels/toggle-all")
async def toggle_all_channels(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.toggle_all_channels(data.get("active", True))
    return {"status": "ok"}


@router.post("/channels/delete")
async def delete_channel(request: Request):
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


@router.post("/channels/subscribe")
async def trigger_subscribe(request: Request):
    """Manually re-subscribe a channel via WebSub."""
    data = await request.json()
    channel_id = data.get("channel_id")
    cb_url = _get_callback_url(request)
    if not cb_url:
        return {"status": "error", "message": "Could not determine callback URL"}
    success = await subscribe_channel(channel_id, cb_url)
    return {"status": "ok" if success else "error", "subscribed": success}


# ── Keywords ─────────────────────────────────────────────────────

@router.get("/keywords")
async def list_keywords(request: Request):
    yt_db = get_yt_db()
    keywords = yt_db.get_keywords()

    if not is_admin_request(request):
        user_id = get_request_user_id(request)
        if user_id:
            from utils.database import get_db
            inheritances = get_db().get_user_yt_inheritances(user_id)
            allowed_ids = {i['source_id'] for i in inheritances if i['source_type'] == 'keyword'}
            keywords = [kw for kw in keywords if kw['id'] in allowed_ids]

    return {"status": "ok", "keywords": keywords}


@router.post("/keywords/add")
async def add_keyword(request: Request):
    data = await request.json()
    if not data.get("keyword", "").strip():
        return {"status": "error", "message": "keyword is required"}
    db = get_yt_db()
    row_id = db.add_keyword(data)
    return {"status": "ok", "id": row_id}


@router.post("/keywords/update")
async def update_keyword(request: Request):
    data = await request.json()
    kw_id = data.get("id")
    if not kw_id:
        return {"status": "error", "message": "id is required"}
    db = get_yt_db()
    db.update_keyword(kw_id, data)
    return {"status": "ok"}


@router.post("/keywords/delete")
async def delete_keyword(request: Request):
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


@router.post("/keywords/toggle")
async def toggle_keyword(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.toggle_keyword(data.get("id"), data.get("active", True))
    return {"status": "ok"}


@router.post("/keywords/toggle-all")
async def toggle_all_keywords(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.toggle_all_keywords(data.get("active", True))
    return {"status": "ok"}


@router.post("/keywords/run")
async def run_single_keyword(request: Request):
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


@router.post("/keywords/run-all")
async def run_all_keywords():
    try:
        count = run_all_keyword_searches()
        return {"status": "ok", "enqueued": count}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ── Blocked Channels ────────────────────────────────────────────

@router.get("/blocked-channels")
async def list_blocked_channels():
    db = get_yt_db()
    return {"status": "ok", "channels": db.get_blocked_channels()}


@router.post("/blocked-channels/add")
async def add_blocked_channel(request: Request):
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


@router.post("/blocked-channels/delete")
async def delete_blocked_channel(request: Request):
    data = await request.json()
    channel_id = data.get("channel_id")
    try:
        db = get_yt_db()
        db.delete_blocked_channel(channel_id)
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"[YT] Failed to delete blocked channel: {e}")
        return {"status": "error", "message": str(e)}


# ── Blocked Keywords (for channels) ─────────────────────────────

@router.get("/blocked-keywords")
async def list_blocked_keywords():
    db = get_yt_db()
    return {"status": "ok", "keywords": db.get_blocked_keywords()}


@router.post("/blocked-keywords/add")
async def add_blocked_keyword(request: Request):
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


@router.post("/blocked-keywords/delete")
async def delete_blocked_keyword(request: Request):
    data = await request.json()
    try:
        db = get_yt_db()
        db.delete_blocked_keyword(data.get("id"))
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"[YT] Failed to delete blocked keyword: {e}")
        return {"status": "error", "message": str(e)}


# ── Manual Video Submission ──────────────────────────────────────

@router.post("/videos/add")
async def add_manual_video(request: Request):
    """Manually add a YouTube video URL to be summarized."""
    data = await request.json()
    url = data.get("url", "").strip()
    telegram_target = data.get("telegram_target", "").strip() or None
    prompt = (data.get("prompt") or "").strip() or None

    if not url:
        return {"status": "error", "message": "url is required"}

    video_id = _extract_video_id(url)
    if not video_id:
        return {"status": "error", "message": "Could not extract video ID from URL"}

    db = get_yt_db()
    reason = db.is_video_already_queued_or_summarized(video_id)
    if reason:
        return {"status": "error", "message": f"Video {video_id} is {reason}"}

    db.mark_video_seen(video_id, title=None, channel_id=None, source='manual')
    queue_id = db.enqueue_video(video_id, telegram_target=telegram_target, prompt=prompt)

    return {"status": "ok", "video_id": video_id, "queue_id": queue_id}


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
    from utils.helpers import load_config
    cfg = load_config()
    yt_cfg = cfg.get("youtube", {})
    prompt = yt_cfg.get("prompt", "")
    default_targets = yt_cfg.get("default_targets", [])
    return {"status": "ok", "prompt": prompt, "default_prompt": DEFAULT_PROMPT,
            "default_targets": default_targets}


@router.post("/prompt/save")
async def save_prompt(request: Request):
    import yaml
    from utils.helpers import load_config
    data = await request.json()
    cfg = load_config()
    if "youtube" not in cfg:
        cfg["youtube"] = {}
    cfg["youtube"]["prompt"] = data.get("prompt", "")
    with open("config.yaml", "w", encoding="utf-8") as f:
        yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    return {"status": "ok"}


@router.post("/default-targets/save")
async def save_default_targets(request: Request):
    import yaml
    from utils.helpers import load_config
    data = await request.json()
    cfg = load_config()
    if "youtube" not in cfg:
        cfg["youtube"] = {}
    cfg["youtube"]["default_targets"] = data.get("targets", [])
    with open("config.yaml", "w", encoding="utf-8") as f:
        yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    return {"status": "ok"}


# ── Videos (unified queue + summaries) ────────────────────────────

@router.get("/videos")
async def get_videos_unified(
    request: Request,
    status: str = Query(None),
    channel: str = Query(None),
    source: str = Query(None),
    limit: int = Query(50),
    offset: int = Query(0),
    date_from: str = Query(None),
    date_to: str = Query(None),
):
    db = get_yt_db()
    yt_ch_ids, kw_ids = _get_yt_user_source_filter(request)
    stats = db.get_queue_stats(yt_ch_ids=yt_ch_ids, kw_ids=kw_ids)
    result = db.get_videos_unified(
        limit=limit, offset=offset, status_filter=status,
        channel_filter=channel, source_filter=source,
        date_from=date_from, date_to=date_to,
        yt_ch_ids=yt_ch_ids, kw_ids=kw_ids,
    )
    return {"status": "ok", "stats": stats, "items": result["items"], "total": result["total"]}


# ── Queue ────────────────────────────────────────────────────────

@router.get("/queue")
async def get_queue(request: Request):
    db = get_yt_db()
    yt_ch_ids, kw_ids = _get_yt_user_source_filter(request)
    stats = db.get_queue_stats(yt_ch_ids=yt_ch_ids, kw_ids=kw_ids)
    items = db.get_queue_items(limit=200, yt_ch_ids=yt_ch_ids, kw_ids=kw_ids)
    return {"status": "ok", "stats": stats, "items": items}


@router.post("/queue/retry")
async def retry_queue_item(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.retry_queue_item(data.get("id"))
    return {"status": "ok"}


@router.post("/queue/process")
async def trigger_process_queue():
    try:
        count = await process_pending_queue()
        return {"status": "ok", "processed": count}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/queue/process-one")
async def process_single_queue_item(request: Request):
    """Process a single queue item immediately."""
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
    try:
        # Reset to pending if failed
        if item['status'] == 'failed':
            db.retry_queue_item(queue_id)
            item = db.get_queue_item_by_id(queue_id)
        success = await asyncio.wait_for(process_queue_item(item), timeout=200)
        return {"status": "ok", "success": success}
    except asyncio.TimeoutError:
        db.update_queue_status(queue_id, 'failed', error_log='Processing timed out (200s)')
        return {"status": "error", "message": "Processing timed out — item marked failed, you can retry"}
    except Exception as e:
        db.update_queue_status(queue_id, 'failed', error_log=str(e))
        return {"status": "error", "message": str(e)}


@router.post("/queue/reset-stuck")
async def reset_stuck_queue_items():
    """Force all stuck 'processing' items to 'failed' so they can be retried."""
    db = get_yt_db()
    count = db.reset_all_processing_to_failed()
    return {"status": "ok", "reset": count}


@router.get("/queue/{queue_id}")
async def get_queue_item_detail(queue_id: int):
    db = get_yt_db()
    item = db.get_queue_item_by_id(queue_id)
    if not item:
        return {"status": "error", "message": "Queue item not found"}
    return {"status": "ok", "item": item}


@router.post("/queue/delete")
async def delete_queue_item(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.delete_queue_item(data.get("id"))
    return {"status": "ok"}


@router.post("/queue/clear")
async def clear_queue():
    db = get_yt_db()
    deleted = db.clear_queue()
    return {"status": "ok", "deleted": deleted}


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
    db = get_yt_db()
    yt_ch_ids, kw_ids = _get_yt_user_source_filter(request)
    summaries = db.get_summaries(
        limit=limit, channel_name=channel_name,
        transcript_source=transcript_source, telegram_sent=telegram_sent,
        date_from=date_from, date_to=date_to,
        yt_ch_ids=yt_ch_ids, kw_ids=kw_ids,
    )
    return {"status": "ok", "summaries": summaries}


@router.get("/summaries/{summary_id}")
async def get_summary_detail(summary_id: int):
    db = get_yt_db()
    summary = db.get_summary_by_id(summary_id)
    if not summary:
        return {"status": "error", "message": "Summary not found"}
    return {"status": "ok", "summary": summary}


@router.post("/summaries/delete")
async def delete_summary(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.delete_summary(data.get("id"))
    return {"status": "ok"}


@router.post("/summaries/clear")
async def clear_summaries():
    db = get_yt_db()
    deleted = db.clear_summaries()
    return {"status": "ok", "deleted": deleted}


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


@router.post("/chat/send")
async def chat_send(request: Request):
    """Send a message in an existing chat session."""
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


@router.post("/chat/refine")
async def chat_refine(request: Request):
    """Refine/merge text using Gemini (no video context needed)."""
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


@router.post("/chat/send-telegram")
async def chat_send_telegram(request: Request):
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
        return {"status": "error", "message": "Telegram sender not configured"}

    try:
        await _telegram_send_fn(target, text)
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"[YT-CHAT] Telegram send failed to {target}: {e}")
        return {"status": "error", "message": str(e)}


@router.post("/chat/end")
async def chat_end(request: Request):
    """End a chat session and free resources."""
    data = await request.json()
    session_id = data.get("session_id", "").strip()
    delete_chat_session(session_id)
    return {"status": "ok"}
