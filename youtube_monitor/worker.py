"""
Queue worker: picks pending videos, runs Gemini summarization (tiered fallback),
sends results via Telegram, and marks items done/failed.
"""

import asyncio
import logging
import re
from datetime import datetime

import google.genai as genai
from google.genai import types

from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)

# Initialized once at startup
_gemini_client = None
_telegram_send_fn = None  # async callable(target, text) set by app.py
_youtube_data_api_key = ""

DEFAULT_PROMPT = """You are a video content summarizer. Provide a clear, concise summary of the following YouTube video.
Include the key points, main topics discussed, and any notable takeaways.
Keep the summary informative but concise (3-5 paragraphs).

IMPORTANT: Focus ONLY on the actual video content. Completely ignore and exclude any:
- Sponsored segments, ad reads, or paid promotions
- "This video is brought to you by..." sections
- Affiliate links or discount codes
- Merchandise plugs or self-promotion
- Intro/outro filler unrelated to the main topic
Do NOT mention any advertisements or sponsorships in your summary."""


def _get_global_prompt() -> str:
    """Read the global summarization prompt from config.yaml as fallback."""
    from utils.helpers import load_config
    cfg = load_config()
    return cfg.get("youtube", {}).get("prompt", "") or DEFAULT_PROMPT


def init_worker(youtube_gemini_api_key: str = "", youtube_data_api_key: str = "",
                telegram_send_fn=None):
    global _gemini_client, _telegram_send_fn, _youtube_data_api_key
    if youtube_gemini_api_key:
        _gemini_client = genai.Client(api_key=youtube_gemini_api_key)
        logger.info("[YT-WORKER] Gemini client initialized with youtube.gemini_api_key")
    else:
        logger.warning("[YT-WORKER] youtube.gemini_api_key not set — summarization disabled")

    _youtube_data_api_key = youtube_data_api_key or ""

    if telegram_send_fn:
        _telegram_send_fn = telegram_send_fn


def _is_rate_limited(exc: Exception) -> float | None:
    """If the exception is a Gemini 429, return the retry delay in seconds."""
    msg = str(exc)
    if '429' not in msg and 'RESOURCE_EXHAUSTED' not in msg:
        return None
    m = re.search(r'retryDelay.*?(\d+)', msg)
    return float(m.group(1)) if m else 40.0


def _summarize_via_gemini_video(video_id: str, prompt: str) -> str:
    """Tier 1: Send YouTube URL directly to Gemini for native video understanding."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    response = _gemini_client.models.generate_content(
        model='gemini-2.5-flash',
        contents=types.Content(
            parts=[
                types.Part(file_data=types.FileData(file_uri=url)),
                types.Part(text=prompt),
            ]
        )
    )
    return response.text.strip()


def _summarize_via_transcript(video_id: str, prompt: str) -> str:
    """Tier 2: Fetch transcript via youtube-transcript-api, send text to Gemini."""
    from youtube_transcript_api import YouTubeTranscriptApi

    ytt_api = YouTubeTranscriptApi()
    # Try fetching transcript in any available language
    try:
        transcript_list = ytt_api.fetch(video_id)
    except Exception:
        # If default (English) fails, list available and pick the first one
        transcript_map = ytt_api.list(video_id)
        available = list(transcript_map)
        if not available:
            raise
        transcript_list = available[0].fetch()
    full_text = ' '.join(entry.text for entry in transcript_list)

    if len(full_text) > 30000:
        full_text = full_text[:30000] + "... [truncated]"

    response = _gemini_client.models.generate_content(
        model='gemini-2.5-flash',
        contents={'text': prompt + f"\n\nVideo transcript:\n\n{full_text}"}
    )
    return response.text.strip()


def _summarize_via_metadata(video_id: str, title: str, description: str, tags: list, prompt: str) -> str:
    """Tier 2: Summarize from metadata only (fallback when no transcript available)."""
    meta = f"Title: {title}\n\nDescription: {description or 'N/A'}\n\nTags: {', '.join(tags or [])}"
    response = _gemini_client.models.generate_content(
        model='gemini-2.5-flash',
        contents={'text': prompt + f"\n\nVideo metadata (no transcript available):\n\n{meta}"}
    )
    return response.text.strip()


def _fetch_video_metadata(video_id: str) -> dict:
    """Fetch video snippet from YouTube Data API for metadata fallback."""
    from googleapiclient.discovery import build
    api_key = _youtube_data_api_key
    if not api_key:
        logger.warning("[YT-WORKER] youtube.data_api_key not set — cannot fetch metadata")
        return {}
    youtube = build('youtube', 'v3', developerKey=api_key)
    resp = youtube.videos().list(part='snippet', id=video_id).execute()
    items = resp.get('items', [])
    if items:
        s = items[0]['snippet']
        return {
            'title': s.get('title', ''),
            'description': s.get('description', ''),
            'channel_name': s.get('channelTitle', ''),
            'published_at': s.get('publishedAt'),
            'tags': s.get('tags', []),
        }
    return {}


async def process_queue_item(queue_item: dict) -> bool:
    """
    Process a single queue item through the tiered summarization pipeline.
    Uses the per-item prompt (falls back to global config prompt).
    Sends to the per-item telegram_target.
    """
    if not _gemini_client:
        logger.error("[YT-WORKER] Gemini client not initialized")
        return False

    db = get_yt_db()
    queue_id = queue_item['id']
    video_id = queue_item['video_id']
    telegram_target = queue_item.get('telegram_target')
    # Per-item prompt from the queue row, fall back to global config prompt
    prompt = queue_item.get('prompt') or _get_global_prompt()

    # Mark as processing
    db.update_queue_status(queue_id, 'processing')

    # Fetch metadata for all tiers
    meta = _fetch_video_metadata(video_id)
    title = meta.get('title', video_id)
    channel_name = meta.get('channel_name', '')
    published_at = meta.get('published_at')
    tags = meta.get('tags', [])
    description = meta.get('description', '')

    summary_text = None
    transcript_source = None

    # Tier 1: Gemini native video understanding (best quality — sees actual video)
    try:
        summary_text = _summarize_via_gemini_video(video_id, prompt)
        transcript_source = 'gemini_video'
        logger.info(f"[YT-WORKER] Tier 1 (gemini video) success for {video_id}")
    except Exception as e:
        delay = _is_rate_limited(e)
        if delay:
            logger.info(f"[YT-WORKER] Rate limited, waiting {delay}s before next tier…")
            await asyncio.sleep(delay)
        logger.warning(f"[YT-WORKER] Tier 1 (gemini video) failed for {video_id}: {e}")

    # Tier 2: Transcript API text → Gemini
    if not summary_text:
        try:
            summary_text = _summarize_via_transcript(video_id, prompt)
            transcript_source = 'transcript_api'
            logger.info(f"[YT-WORKER] Tier 2 (transcript) success for {video_id}")
        except Exception as e:
            delay = _is_rate_limited(e)
            if delay:
                logger.info(f"[YT-WORKER] Rate limited, waiting {delay}s before next tier…")
                await asyncio.sleep(delay)
            logger.warning(f"[YT-WORKER] Tier 2 (transcript) failed for {video_id}: {e}")

    # Tier 3: Metadata only (last resort)
    if not summary_text:
        try:
            summary_text = _summarize_via_metadata(video_id, title, description, tags, prompt)
            transcript_source = 'metadata'
            logger.info(f"[YT-WORKER] Tier 3 (metadata) success for {video_id}")
        except Exception as e:
            logger.error(f"[YT-WORKER] All tiers failed for {video_id}: {e}")
            db.update_queue_status(queue_id, 'failed', error_log=str(e))
            return False

    # Save summary
    summary_id = db.save_summary(
        video_id=video_id,
        title=title,
        channel_name=channel_name,
        published_at=published_at,
        transcript_source=transcript_source,
        summary_text=summary_text,
        telegram_target=telegram_target,
    )

    # Send via Telegram if target is set and sender is available
    if telegram_target and _telegram_send_fn:
        try:
            url = f"https://www.youtube.com/watch?v={video_id}"
            tg_message = (
                f"**YouTube Summary**\n"
                f"{'—' * 20}\n\n"
                f"**{title}**\n"
                f"Channel: {channel_name}\n"
                f"Link: {url}\n\n"
                f"{summary_text}"
            )
            await _telegram_send_fn(telegram_target, tg_message)
            db.mark_telegram_sent(summary_id)
            logger.info(f"[YT-WORKER] Telegram sent for {video_id} → {telegram_target}")
        except Exception as e:
            logger.warning(f"[YT-WORKER] Telegram send failed for {video_id}: {e}")

    # Mark done
    db.update_queue_status(queue_id, 'done')
    return True


async def process_pending_queue():
    """
    Process all pending queue items (up to batch limit).
    Called by the scheduler every 5 minutes.
    """
    db = get_yt_db()
    items = db.get_pending_queue_items(limit=5)
    if not items:
        return 0

    processed = 0
    for item in items:
        if item.get('attempts', 0) >= 3:
            db.update_queue_status(item['id'], 'failed', error_log='Max attempts reached')
            continue
        try:
            success = await process_queue_item(item)
            if success:
                processed += 1
        except Exception as e:
            logger.error(f"[YT-WORKER] Unhandled error processing {item['video_id']}: {e}")
            db.update_queue_status(item['id'], 'failed', error_log=str(e))

    logger.info(f"[YT-WORKER] Processed {processed}/{len(items)} queue items")
    return processed
