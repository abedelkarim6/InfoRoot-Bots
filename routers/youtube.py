"""
YouTube Monitor API router.
All endpoints under /api/youtube/...
"""

import re
import logging
from fastapi import APIRouter, Request, Query
from fastapi.responses import PlainTextResponse

from youtube_monitor.db import get_yt_db
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
async def youtube_overview():
    db = get_yt_db()
    return {"status": "ok", **db.get_system_overview()}


# ── Channels ─────────────────────────────────────────────────────

@router.get("/channels")
async def list_channels():
    db = get_yt_db()
    channels = db.get_channels()
    for ch in channels:
        ch['last_video'] = db.get_channel_last_video(ch['channel_id'])
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

    try:
        db = get_yt_db()
        row_id = db.add_channel(channel_id, channel_name, telegram_targets, prompt)
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
    db = get_yt_db()
    db.update_channel(
        channel_id,
        channel_name=data.get("channel_name"),
        telegram_targets=data.get("telegram_targets") or [],
        prompt=data.get("prompt"),
    )
    return {"status": "ok"}


@router.post("/channels/toggle")
async def toggle_channel(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.toggle_channel(data.get("channel_id"), data.get("active", True))
    return {"status": "ok"}


@router.post("/channels/delete")
async def delete_channel(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.delete_channel(data.get("channel_id"))
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
async def list_keywords():
    db = get_yt_db()
    return {"status": "ok", "keywords": db.get_keywords()}


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
    db = get_yt_db()
    db.delete_keyword(data.get("id"))
    return {"status": "ok"}


@router.post("/keywords/toggle")
async def toggle_keyword(request: Request):
    data = await request.json()
    db = get_yt_db()
    db.toggle_keyword(data.get("id"), data.get("active", True))
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
    prompt = cfg.get("youtube", {}).get("prompt", "")
    return {"status": "ok", "prompt": prompt, "default_prompt": DEFAULT_PROMPT}


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


# ── Videos (unified queue + summaries) ────────────────────────────

@router.get("/videos")
async def get_videos_unified(
    status: str = Query(None),
    channel: str = Query(None),
    source: str = Query(None),
    limit: int = Query(50),
    offset: int = Query(0),
    date_from: str = Query(None),
    date_to: str = Query(None),
):
    db = get_yt_db()
    stats = db.get_queue_stats()
    result = db.get_videos_unified(
        limit=limit, offset=offset, status_filter=status,
        channel_filter=channel, source_filter=source,
        date_from=date_from, date_to=date_to,
    )
    return {"status": "ok", "stats": stats, "items": result["items"], "total": result["total"]}


# ── Queue ────────────────────────────────────────────────────────

@router.get("/queue")
async def get_queue():
    db = get_yt_db()
    stats = db.get_queue_stats()
    items = db.get_queue_items(limit=200)
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
        success = await process_queue_item(item)
        return {"status": "ok", "success": success}
    except Exception as e:
        return {"status": "error", "message": str(e)}


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
    channel_name: str = Query(None),
    transcript_source: str = Query(None),
    telegram_sent: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    limit: int = Query(100),
):
    db = get_yt_db()
    summaries = db.get_summaries(
        limit=limit, channel_name=channel_name,
        transcript_source=transcript_source, telegram_sent=telegram_sent,
        date_from=date_from, date_to=date_to,
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

    try:
        reply = await send_chat_message(session_id, message)
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
