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
from youtube_monitor.keyword_search import _parse_duration

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

# Fixed prefix for strategy 1 (Gemini native video — URL sent directly, no transcript text).
# Not shown in the UI; prepended silently before the user's prompt.
_FIXED_PREFIX_VIDEO = """\
العنوان:
{title}

اسم القناة:
{channel_name}

اسم الضيف:
{guest}

الرابط:
{link}

المطلوب:

تحويل محتوى الفيديو إلى نص مترابط يغني عن مشاهدة الفيديو، مع الحفاظ التام على نفس العبارات وأسلوب المتحدث.

تنسيق الإخراج:

- {title}
- اسم الضيف
- التاريخ:
الخميس ١٩/٠٣/٢٠٢٦

ثم النص

في النهاية:

قناة: {channel_name}
لمشاهدة الحلقة كاملة: {link}

قواعد الميتاداتا:

- استخدام العنوان كما هو 100% بدون تعديل
- استخدام اسم القناة الصحيح فقط
- حذف أي قيمة مثل N/A
- عدم تكرار أي عنصر
---
User Prompt:
"""

# Fixed prefix for strategy 2 (transcript text — full transcript injected at {transcript}).
# Not shown in the UI; prepended silently before the user's prompt.
_FIXED_PREFIX_TRANSCRIPT = """\
المحتوى:
{transcript}

العنوان:
{title}

اسم القناة:
{channel_name}

اسم الضيف:
{guest}

الرابط:
{link}

المطلوب:

تحويل محتوى الفيديو إلى نص مترابط يغني عن مشاهدة الفيديو، مع الحفاظ التام على نفس العبارات وأسلوب المتحدث.

تنسيق الإخراج:

- {title}
- اسم الضيف
- التاريخ:
الخميس ١٩/٠٣/٢٠٢٦

ثم النص

في النهاية:

قناة: {channel_name}
لمشاهدة الحلقة كاملة: {link}

قواعد الميتاداتا:

- استخدام العنوان كما هو 100% بدون تعديل
- استخدام اسم القناة الصحيح فقط
- حذف أي قيمة مثل N/A
- عدم تكرار أي عنصر
---
User Prompt:
"""


def _build_yt_prompt(prefix_template: str, user_prompt: str,
                     title: str, channel_name: str, link: str,
                     guest: str = '') -> str:
    """Inject metadata into the fixed prefix and append the user prompt."""
    prefix = (prefix_template
              .replace('{title}', title or '')
              .replace('{channel_name}', channel_name or '')
              .replace('{link}', link or '')
              .replace('{guest}', guest or ''))
    return prefix + user_prompt


def _get_global_prompt() -> str:
    """Read the global summarization prompt from config.yaml as fallback."""
    from utils.helpers import load_config
    cfg = load_config()
    return cfg.get("youtube", {}).get("prompt", "") or DEFAULT_PROMPT


def init_worker(gemini_project: str = "", gemini_location: str = "us-central1",
                youtube_data_api_key: str = "", telegram_send_fn=None):
    global _gemini_client, _telegram_send_fn, _youtube_data_api_key
    if gemini_project:
        _gemini_client = genai.Client(vertexai=True, project=gemini_project, location=gemini_location)
        logger.info(f"[YT-WORKER] Vertex AI client initialized — project={gemini_project}")
    else:
        logger.warning("[YT-WORKER] youtube.gemini_project not set — summarization disabled")

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


def _extract_tokens(response) -> tuple[int, int]:
    """Return (input_tokens, output_tokens) from a Gemini response."""
    um = getattr(response, 'usage_metadata', None)
    if um:
        return (getattr(um, 'prompt_token_count', 0) or 0,
                getattr(um, 'candidates_token_count', 0) or 0)
    return 0, 0


_YT_LABELS = types.GenerateContentConfig(labels={"service": "youtube"})


def _summarize_via_gemini_video(video_id: str, prompt: str) -> tuple[str, int, int]:
    """Strategy 1: Send YouTube URL directly to Gemini for native video understanding.
    Returns (summary_text, input_tokens, output_tokens)."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    response = _gemini_client.models.generate_content(
        model='gemini-2.5-flash',
        contents=types.Content(
            parts=[
                types.Part(file_data=types.FileData(file_uri=url)),
                types.Part(text=prompt),
            ]
        ),
        config=_YT_LABELS,
    )
    inp, out = _extract_tokens(response)
    return response.text.strip(), inp, out


def _summarize_via_transcript(video_id: str, prompt: str) -> tuple[str, int, int]:
    """Strategy 2: Fetch transcript via youtube-transcript-api, send text to Gemini.
    Returns (summary_text, input_tokens, output_tokens)."""
    from youtube_transcript_api import YouTubeTranscriptApi

    ytt_api = YouTubeTranscriptApi()
    try:
        transcript_list = ytt_api.fetch(video_id)
    except Exception:
        transcript_map = ytt_api.list(video_id)
        available = list(transcript_map)
        if not available:
            raise
        transcript_list = available[0].fetch()
    full_text = ' '.join(entry.text for entry in transcript_list)

    if len(full_text) > 30_000:
        full_text = full_text[:30000] + "... [truncated]"

    # If the prompt already has a {transcript} placeholder (from the fixed prefix),
    # replace it in-place; otherwise fall back to appending the transcript at the end.
    if '{transcript}' in prompt:
        final_prompt = prompt.replace('{transcript}', full_text)
    else:
        final_prompt = prompt + f"\n\nVideo transcript:\n\n{full_text}"

    response = _gemini_client.models.generate_content(
        model='gemini-2.5-flash',
        contents={'text': final_prompt},
        config=_YT_LABELS,
    )
    inp, out = _extract_tokens(response)
    return response.text.strip(), inp, out


# Per-item processing timeout (seconds). Gemini video can be slow but rarely > 3 min.
_ITEM_TIMEOUT_SECS = 180



def _fetch_video_metadata(video_id: str) -> dict:
    """Fetch video snippet from YouTube Data API for metadata fallback."""
    from googleapiclient.discovery import build
    from youtube_monitor import yt_memory_cache
    api_key = _youtube_data_api_key
    if not api_key:
        logger.warning("[YT-WORKER] youtube.data_api_key not set — cannot fetch metadata")
        return {}
    youtube = build('youtube', 'v3', developerKey=api_key, cache=yt_memory_cache)
    resp = youtube.videos().list(part='snippet,contentDetails,statistics', id=video_id).execute()
    items = resp.get('items', [])
    if items:
        item = items[0]
        s = item['snippet']
        result = {
            'title': s.get('title', ''),
            'description': s.get('description', ''),
            'channel_name': s.get('channelTitle', ''),
            'published_at': s.get('publishedAt'),
            'tags': s.get('tags', []),
        }
        cd = item.get('contentDetails', {})
        if cd.get('duration'):
            result['duration'] = cd['duration']
        st = item.get('statistics', {})
        if st.get('viewCount'):
            result['view_count'] = int(st['viewCount'])
        return result
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

    # Check if the source channel/keyword is still active before spending API credits
    source_channel_id = queue_item.get('source_channel_id')
    source_keyword_id = queue_item.get('source_keyword_id')
    if source_channel_id:
        ch_row = db.get_channel_by_yt_id(source_channel_id)
        if ch_row and not ch_row.get('active', True):
            logger.info(f"[YT-WORKER] Skipping {video_id} — source channel {source_channel_id} is inactive")
            db.update_queue_status(queue_id, 'skipped', error_log='Source channel inactive')
            return False
    if source_keyword_id:
        kw_row = db.get_keyword_by_id(source_keyword_id)
        if kw_row and not kw_row.get('active', True):
            logger.info(f"[YT-WORKER] Skipping {video_id} — source keyword #{source_keyword_id} is inactive")
            db.update_queue_status(queue_id, 'skipped', error_log='Source keyword inactive')
            return False

    # Per-item prompt from the queue row, fall back to global config prompt
    user_prompt = queue_item.get('prompt') or _get_global_prompt()

    # Mark as processing
    db.update_queue_status(queue_id, 'processing')

    # Fetch metadata for all tiers
    meta = _fetch_video_metadata(video_id)
    title = meta.get('title', video_id)
    channel_name = meta.get('channel_name', '')
    published_at = meta.get('published_at')
    tags = meta.get('tags', [])
    description = meta.get('description', '')

    # Build the two strategy-specific prompts (fixed prefix + user prompt, metadata injected).
    # {transcript} in the transcript prompt is resolved inside _summarize_via_transcript.
    video_link = f"https://www.youtube.com/watch?v={video_id}"
    prompt_video      = _build_yt_prompt(_FIXED_PREFIX_VIDEO,      user_prompt,
                                         title, channel_name, video_link)
    prompt_transcript = _build_yt_prompt(_FIXED_PREFIX_TRANSCRIPT, user_prompt,
                                         title, channel_name, video_link)

    # Compute duration_secs unconditionally (needed for video-hour tracking)
    duration_secs = _parse_duration(meta.get('duration')) if meta.get('duration') else 0

    # Apply channel-level duration/view filters (title filters already applied in WebSub)
    if source_channel_id:
        ch_filter = db.get_channel_by_yt_id(source_channel_id)
        if ch_filter:
            # Duration filter
            min_dur = ch_filter.get('min_duration_seconds')
            max_dur = ch_filter.get('max_duration_seconds')
            if min_dur and duration_secs and duration_secs < min_dur:
                reason = f'Video too short ({duration_secs}s < {min_dur}s min)'
                logger.info(f"[YT-WORKER] Filtered {video_id}: {reason}")
                db.update_queue_status(queue_id, 'skipped', error_log=reason)
                return False
            if max_dur and duration_secs and duration_secs > max_dur:
                reason = f'Video too long ({duration_secs}s > {max_dur}s max)'
                logger.info(f"[YT-WORKER] Filtered {video_id}: {reason}")
                db.update_queue_status(queue_id, 'skipped', error_log=reason)
                return False
            # View count filter
            min_views = ch_filter.get('min_view_count') or 0
            view_count = meta.get('view_count', 0)
            if min_views and view_count < min_views:
                reason = f'Not enough views ({view_count} < {min_views} min)'
                logger.info(f"[YT-WORKER] Filtered {video_id}: {reason}")
                db.update_queue_status(queue_id, 'skipped', error_log=reason)
                return False

    summary_text = None
    transcript_source = None
    inp_tokens = 0
    out_tokens = 0

    # Strategy 1: Gemini native video (URL) — best quality, sees/hears actual content
    # Guard: skip if daily 8-hour video quota is exhausted
    _video_allowed = True
    try:
        from utils.gemini_usage import get_gemini_video_seconds_used, VIDEO_SECS_LIMIT
        if get_gemini_video_seconds_used() + duration_secs > VIDEO_SECS_LIMIT:
            logger.warning(f"[YT-WORKER] Daily video-hour quota reached — skipping native video for {video_id}")
            _video_allowed = False
    except Exception:
        pass

    loop = asyncio.get_event_loop()
    try:
        if not _video_allowed:
            raise RuntimeError("Daily video-hour quota reached")
        summary_text, inp_tokens, out_tokens = await asyncio.wait_for(
            loop.run_in_executor(None, _summarize_via_gemini_video, video_id, prompt_video),
            timeout=_ITEM_TIMEOUT_SECS,
        )
        transcript_source = 'gemini_video'
        logger.info(f"[YT-WORKER] Strategy 1 (gemini video) success for {video_id}")
        try:
            from utils.gemini_usage import record_gemini_request, record_gemini_video_seconds
            record_gemini_video_seconds(duration_secs)
            record_gemini_request(total_tokens=inp_tokens + out_tokens)
        except Exception:
            pass
    except asyncio.TimeoutError:
        logger.warning(f"[YT-WORKER] Strategy 1 (gemini video) timed out after {_ITEM_TIMEOUT_SECS}s for {video_id}")
    except Exception as e:
        delay = _is_rate_limited(e)
        if delay:
            logger.info(f"[YT-WORKER] Rate limited, waiting {delay}s before next strategy…")
            await asyncio.sleep(delay)
        logger.warning(f"[YT-WORKER] Strategy 1 (gemini video) failed for {video_id}: {e}")

    # Strategy 2: Transcript text → Gemini (fallback — no video quota used)
    if not summary_text:
        try:
            summary_text, inp_tokens, out_tokens = await asyncio.wait_for(
                loop.run_in_executor(None, _summarize_via_transcript, video_id, prompt_transcript),
                timeout=_ITEM_TIMEOUT_SECS,
            )
            transcript_source = 'transcript_api'
            logger.info(f"[YT-WORKER] Strategy 2 (transcript) success for {video_id}")
            try:
                from utils.gemini_usage import record_gemini_request
                record_gemini_request(total_tokens=inp_tokens + out_tokens)
            except Exception:
                pass
        except asyncio.TimeoutError:
            logger.warning(f"[YT-WORKER] Strategy 2 (transcript) timed out after {_ITEM_TIMEOUT_SECS}s for {video_id}")
        except Exception as e:
            delay = _is_rate_limited(e)
            if delay:
                logger.info(f"[YT-WORKER] Rate limited, waiting {delay}s before next strategy…")
                await asyncio.sleep(delay)
            logger.warning(f"[YT-WORKER] Strategy 2 (transcript) failed for {video_id}: {e}")

    # All strategies exhausted — mark as failed so user can retry
    if not summary_text:
        reason = 'No transcript available (gemini video and transcript API both failed)'
        logger.warning(f"[YT-WORKER] All strategies failed for {video_id}: {reason}")
        db.update_queue_status(queue_id, 'failed', error_log=reason)
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
        duration_secs=int(duration_secs) if duration_secs else None,
        input_tokens=inp_tokens or None,
        output_tokens=out_tokens or None,
    )

    # Send via Telegram if target is set and sender is available
    if telegram_target and _telegram_send_fn:
        try:
            await _telegram_send_fn(telegram_target, summary_text)
            db.mark_telegram_sent(summary_id)
            logger.info(f"[YT-WORKER] Telegram sent for {video_id} → {telegram_target}")
        except Exception as e:
            logger.error(f"[YT-WORKER] Telegram send FAILED for {video_id} → {telegram_target}: {e}", exc_info=True)
    elif telegram_target and not _telegram_send_fn:
        logger.warning(f"[YT-WORKER] No Telegram send function registered — skipping send for {video_id}")

    # Mark done
    db.update_queue_status(queue_id, 'done')
    return True


async def process_pending_queue():
    """
    Process all pending queue items (up to batch limit).
    Called by the scheduler every 5 minutes.
    """
    from utils.database import get_db
    if not get_db().get_system_enabled():
        logger.debug("[YT-WORKER] System disabled — skipping queue processing")
        return 0
    db = get_yt_db()
    # Reset items stuck in 'processing' for >10 min (e.g. from a crashed run)
    stuck = db.reset_stuck_processing_items(stuck_minutes=10)
    if stuck:
        logger.warning(f"[YT-WORKER] Reset {stuck} stuck-processing item(s) back to pending")
    items = db.get_pending_queue_items(limit=3)
    if not items:
        return 0

    processed = 0
    for item in items:
        if item.get('attempts', 0) >= 3:
            db.update_queue_status(item['id'], 'failed', error_log='Max attempts reached')
            continue
        try:
            success = await asyncio.wait_for(process_queue_item(item), timeout=_ITEM_TIMEOUT_SECS + 30)
            if success:
                processed += 1
        except asyncio.TimeoutError:
            logger.error(f"[YT-WORKER] Item {item['video_id']} timed out in scheduler")
            db.update_queue_status(item['id'], 'failed', error_log=f'Scheduler timeout after {_ITEM_TIMEOUT_SECS + 30}s')
        except Exception as e:
            logger.error(f"[YT-WORKER] Unhandled error processing {item['video_id']}: {e}")
            db.update_queue_status(item['id'], 'failed', error_log=str(e))

    logger.info(f"[YT-WORKER] Processed {processed}/{len(items)} queue items")
    return processed
