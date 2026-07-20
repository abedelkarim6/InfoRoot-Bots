"""
Queue worker: picks pending videos, runs Gemini summarization (tiered fallback),
sends results via Telegram, and marks items done/failed.
"""

import asyncio
import logging
import re
import time
from datetime import datetime

import google.genai as genai
from google.genai import types

from youtube_monitor import transcript_api
from youtube_monitor.db import get_yt_db, record_api_usage
from utils.gemini_models import get_gemini_model
from youtube_monitor.keyword_search import _parse_duration
from youtube_monitor.prompts import (
    DEFAULT_PROMPT,
    _build_yt_prompt,
    _get_fixed_prefix_video,
    _get_fixed_prefix_transcript,
    _get_global_prompt,
    build_length_directive,
)

# Rough speech density used only as a fallback when no transcript is available
# but an output-length percentage is requested — ~150 wpm × ~4.7 chars/word.
_CHARS_PER_SEC = 14

logger = logging.getLogger(__name__)

# Initialized once at startup
_gemini_client = None
_telegram_send_fn = None  # async callable(target, text) set by app.py
_youtube_data_api_key = ""


def init_worker(gemini_project: str = "", gemini_location: str = "global",
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


def _extract_tokens(response) -> tuple[int, int, int, int]:
    """Return (input_tokens, output_tokens, thinking_tokens, audio_tokens) from
    a Gemini response. `output` is the visible answer; `thinking` is the
    reasoning trace (Gemini's "Thinking Text Output" SKU — billed at the output
    rate); `audio` is the audio-modality share OF input (a subset, billed at a
    higher rate than text/video — native video ingestion tokenizes the
    soundtrack). See extract_gemini_tokens."""
    from utils.ai_pricing import extract_gemini_tokens
    return extract_gemini_tokens(getattr(response, 'usage_metadata', None))


def _resolve_yt_thinking_config():
    """Read the admin's `yt_gemini_thinking` setting and translate it into a
    `types.ThinkingConfig` — or `None` when thinking is disabled.

    Separate from the summaries feature's `gemini_thinking` so YouTube can be
    toggled independently. When enabled we set `include_thoughts=True` so the
    response carries the reasoning trace, which is stored on the summary row.
    """
    try:
        from utils.database import get_db
        cfg = get_db().get_setting("yt_gemini_thinking") or {}
        if not cfg.get("enabled"):
            return None
        budget = cfg.get("budget", -1)
        try:
            budget = int(budget)
        except (TypeError, ValueError):
            budget = -1
        return types.ThinkingConfig(thinking_budget=budget, include_thoughts=True)
    except Exception as e:
        logger.warning(f"[YT-WORKER] thinking config lookup failed: {e}")
        return None


def _split_response_parts(response) -> tuple[str, str]:
    """Split a generate_content response into (answer_text, thoughts_text).

    With `include_thoughts=True`, Vertex returns multiple parts and marks
    reasoning parts with `part.thought == True`. Models/SDKs that don't
    surface thoughts return a single part — `thoughts_text` is then empty.
    """
    answer_chunks, thought_chunks = [], []
    try:
        candidates = getattr(response, "candidates", None) or []
        if candidates:
            parts = getattr(getattr(candidates[0], "content", None), "parts", None) or []
            for p in parts:
                txt = getattr(p, "text", None)
                if not txt:
                    continue
                (thought_chunks if getattr(p, "thought", False) else answer_chunks).append(txt)
    except Exception:
        pass
    answer = "".join(answer_chunks).strip()
    thoughts = "\n\n".join(thought_chunks).strip()
    if not answer:
        answer = (getattr(response, "text", "") or "").strip()
    return answer, thoughts


def _yt_gen_config() -> types.GenerateContentConfig:
    """Build the Gemini config for a YouTube summarization call — service
    labels plus the thinking config when the YouTube thinking toggle is on."""
    kwargs = {"labels": {"service": "youtube"}}
    thinking_cfg = _resolve_yt_thinking_config()
    if thinking_cfg is not None:
        kwargs["thinking_config"] = thinking_cfg
    return types.GenerateContentConfig(**kwargs)


def _summarize_via_gemini_video(video_id: str, prompt: str) -> tuple[str, int, int, int, int, str]:
    """Strategy 1: Send YouTube URL directly to Vertex AI Gemini for native video understanding.
    Returns (summary_text, input_tokens, output_tokens, thinking_tokens, audio_tokens, thoughts).
    This is the path that incurs audio-input billing (Gemini tokenizes the
    video's soundtrack alongside the frames)."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    response = _gemini_client.models.generate_content(
        model=get_gemini_model(),
        contents=types.Content(
            role="user",
            parts=[
                types.Part(file_data=types.FileData(file_uri=url, mime_type="video/*")),
                types.Part(text=prompt),
            ]
        ),
        config=_yt_gen_config(),
    )
    inp, out, think, audio = _extract_tokens(response)
    answer, thoughts = _split_response_parts(response)
    return answer, inp, out, think, audio, thoughts


def _fetch_transcript_text(video_id: str) -> str:
    """Fetch the full transcript text for a video via youtube-transcript-api.
    Raises if no transcript is available."""
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
    return '\n'.join(entry.text for entry in transcript_list)


def _get_transcript_cached(video_id: str) -> str | None:
    """Return the transcript for a video, serving the DB cache first and
    otherwise fetching live and caching it. Returns None if unavailable.

    Called up front for every queue item so the transcript character count is
    always known (it's the basis for the output-length percentage) — even when
    Strategy 1 (native Gemini video) ends up producing the summary."""
    db = get_yt_db()
    cached = db.get_cached_transcript(video_id)
    if cached:
        return cached
    try:
        text = _fetch_transcript_text(video_id)
    except Exception as e:
        logger.info(f"[YT-WORKER] No transcript available for {video_id}: {e}")
        return None
    if text:
        try:
            db.cache_transcript(video_id, text)
        except Exception:
            pass
    return text


async def _fetch_external_video(video_id: str) -> dict | None:
    """Fetch transcript + metadata from the external transcript API.

    Runs the synchronous client in a thread and handles a single rate-limit
    backoff (503 → wait retry_after → retry once). Returns the video dict or
    None when the API is unconfigured, rate-limited twice, or errors."""
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, transcript_api.fetch_video, video_id)
    except transcript_api.TranscriptApiRateLimited as e:
        wait = e.retry_after or 40
        logger.info(f"[YT-WORKER] Transcript API rate-limited for {video_id}; "
                    f"waiting {wait}s then retrying once")
        await asyncio.sleep(wait)
        try:
            return await loop.run_in_executor(None, transcript_api.fetch_video, video_id)
        except Exception as e2:
            logger.warning(f"[YT-WORKER] Transcript API retry failed for {video_id}: {e2}")
            return None
    except Exception as e:
        logger.warning(f"[YT-WORKER] Transcript API error for {video_id}: {e}")
        return None


def _summarize_via_transcript(video_id: str, prompt: str,
                              transcript_text: str = None) -> tuple[str, str, int, int, int, int, str]:
    """Strategy 2: send transcript text to Gemini.
    Returns (summary_text, transcript_text, input_tokens, output_tokens, thinking_tokens, audio_tokens, thoughts).
    Text-only input, so audio_tokens is normally 0 — wired for correctness.
    The returned transcript_text is the full (untruncated) raw text so it can
    be cached for later export — the prompt itself still gets truncated.
    A pre-fetched transcript can be passed to avoid a second YouTube round-trip.
    `thoughts` is the Gemini reasoning trace (empty unless the YouTube thinking
    toggle is on)."""
    full_text = transcript_text if transcript_text is not None else _fetch_transcript_text(video_id)

    prompt_text = full_text
    if len(prompt_text) > 30_000:
        prompt_text = prompt_text[:30000] + "... [truncated]"

    # If the prompt already has a {transcript} placeholder (from the fixed prefix),
    # replace it in-place; otherwise fall back to appending the transcript at the end.
    if '{transcript}' in prompt:
        final_prompt = prompt.replace('{transcript}', prompt_text)
    else:
        final_prompt = prompt + f"\n\nVideo transcript:\n\n{prompt_text}"

    response = _gemini_client.models.generate_content(
        model=get_gemini_model(),
        contents={'text': final_prompt},
        config=_yt_gen_config(),
    )
    inp, out, think, audio = _extract_tokens(response)
    answer, thoughts = _split_response_parts(response)
    return answer, full_text, inp, out, think, audio, thoughts


# Per-item processing timeout (seconds). Gemini video can be slow but rarely > 3 min.
_ITEM_TIMEOUT_SECS = 180



def _fetch_video_metadata(video_id: str) -> dict:
    """Fetch video snippet from YouTube Data API for metadata fallback.

    Returns {} on quota exhaustion or any other API error — metadata is
    optional, both summarization strategies (Gemini video URL and transcript
    fetch) can run without it. Without this guard, a `quotaExceeded` 403
    aborts the whole queue item and is reported as a generic failure even
    though the actual summarization paths don't use the Data API quota."""
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
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
            'language': s.get('defaultAudioLanguage') or s.get('defaultLanguage'),
            'live_broadcast_content': s.get('liveBroadcastContent'),
        }
        cd = item.get('contentDetails', {})
        if cd.get('duration'):
            result['duration'] = cd['duration']
        st = item.get('statistics', {})
        if st.get('viewCount'):
            result['view_count'] = int(st['viewCount'])
        lsd = item.get('liveStreamingDetails') or {}
        if lsd.get('actualEndTime'):
            result['actual_end_time'] = lsd['actualEndTime']
        return result
    return {}


def _resolve_output_length_percent(db, queue_item: dict,
                                   source_channel_id: str = None,
                                   source_keyword_id: int = None) -> int | None:
    """Resolve the output-length percentage for a queue item.

    Most-specific wins: the queue row (manual add) overrides the source
    channel/keyword setting, which overrides the global default stored in
    system_settings under 'yt_output_length_percent'. None at every level
    means no length constraint."""
    pct = queue_item.get('output_length_percent')
    if pct:
        return int(pct)

    if source_keyword_id:
        kw = db.get_keyword_by_id(source_keyword_id)
        if kw and kw.get('output_length_percent'):
            return int(kw['output_length_percent'])
    if source_channel_id:
        ch = db.get_channel_by_yt_id(source_channel_id)
        if ch and ch.get('output_length_percent'):
            return int(ch['output_length_percent'])

    try:
        from utils.database import get_db
        val = get_db().get_setting('yt_output_length_percent') or {}
        gpct = val.get('percent') if isinstance(val, dict) else val
        if gpct:
            return int(gpct)
    except Exception:
        pass
    return None


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
    # Optional user-forced strategy (manual adds): 'gemini_video' or
    # 'transcript_api'. When set, only that strategy runs — no fallback.
    force_method = queue_item.get('force_method')
    t_start = time.monotonic()

    # Atomically claim the item (pending → processing). If another run — e.g.
    # the scheduler and a manual /queue/process trigger picking overlapping
    # batches — already claimed it, bail out. Without this the same video gets
    # summarized and sent to Telegram twice.
    if not db.claim_queue_item(queue_id):
        logger.info(f"[YT-WORKER] Skipping {video_id} — queue item {queue_id} already claimed by another run")
        return False

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

    # Fetch transcript + metadata up front — even when Strategy 1 (native Gemini
    # video) will produce the summary — so the transcript char count can serve as
    # the basis for the output-length percentage, and so it's cached for export.
    #
    # Primary source is the external transcript API (headless scraper): one call
    # returns both transcript and metadata, and unlike the gated library it isn't
    # IP-blocked. The DB cache is served first; metadata falls back to the Data
    # API and the transcript to the library when the scraper is off or empty.
    transcript_full = db.get_cached_transcript(video_id)
    ext_meta = {}
    if transcript_api.is_configured():
        external_video = await _fetch_external_video(video_id)
        if external_video:
            ext_meta = transcript_api.extract_metadata(external_video)
            if not transcript_full:
                ext_text = transcript_api.extract_transcript_text(external_video)
                if ext_text:
                    transcript_full = ext_text
                    try:
                        db.cache_transcript(video_id, ext_text)
                    except Exception:
                        logger.warning(f"[YT-WORKER] Failed to cache transcript for {video_id}")
            logger.info(f"[YT-WORKER] Transcript API returned for {video_id} "
                        f"(transcript chars={len(transcript_full or '')})")

    # Metadata: prefer the external scraper; fall back to the YouTube Data API.
    meta = ext_meta or _fetch_video_metadata(video_id)
    title = meta.get('title', video_id)
    channel_name = meta.get('channel_name', '')
    published_at = meta.get('published_at')
    tags = meta.get('tags', [])
    description = meta.get('description', '')

    # Compute duration_secs unconditionally (needed for video-hour tracking).
    # The external API returns duration_seconds (int); the Data API returns an
    # ISO-8601 duration string — handle whichever the metadata source provided.
    if meta.get('duration_seconds'):
        duration_secs = int(meta['duration_seconds'])
    elif meta.get('duration'):
        duration_secs = _parse_duration(meta['duration'])
    else:
        duration_secs = 0

    # Library last-resort fallback for the transcript (cache-first inside).
    if not transcript_full:
        transcript_full = _get_transcript_cached(video_id)

    # Resolve the output-length percentage: queue row > source channel/keyword
    # > global default. None at every level means "no length constraint".
    output_length_percent = _resolve_output_length_percent(db, queue_item,
                                                            source_channel_id, source_keyword_id)

    # Build a length directive from the transcript char count (fall back to a
    # duration-based estimate when no transcript is available).
    length_directive = ""
    if output_length_percent:
        base_chars = len(transcript_full) if transcript_full else int(duration_secs * _CHARS_PER_SEC)
        if base_chars > 0:
            target_chars = int(base_chars * output_length_percent / 100)
            length_directive = build_length_directive(
                target_chars, output_length_percent,
                duration_secs=duration_secs, source_chars=base_chars)
            logger.info(f"[YT-WORKER] {video_id}: output length {output_length_percent}% of "
                        f"{base_chars} chars → ~{target_chars} chars")
    user_prompt_with_len = user_prompt + length_directive

    # Build the two strategy-specific prompts (fixed prefix + user prompt, metadata injected).
    # {transcript} in the transcript prompt is resolved inside _summarize_via_transcript.
    video_link = f"https://www.youtube.com/watch?v={video_id}"
    prompt_video      = _build_yt_prompt(_get_fixed_prefix_video(),      user_prompt_with_len,
                                         title, channel_name, video_link)
    prompt_transcript = _build_yt_prompt(_get_fixed_prefix_transcript(), user_prompt_with_len,
                                         title, channel_name, video_link)

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
    # Persist the transcript we already fetched (if any) regardless of which
    # strategy ultimately produces the summary.
    transcript_text = transcript_full
    inp_tokens = 0
    out_tokens = 0
    think_tokens = 0  # thinking (reasoning) token count — its own billing SKU
    audio_tokens = 0  # audio share OF inp_tokens (subset) — higher-rate SKU
    thoughts = ''  # Gemini reasoning trace — populated when thinking is enabled
    strat1_err = None  # Gemini native-video reason-for-failure
    strat2_err = None  # Transcript reason-for-failure

    # Strategy 1: Gemini native video (URL) — best quality, sees/hears actual content
    # Guard: skip if daily 8-hour video quota is exhausted, or if the user forced
    # the transcript-only strategy for this item.
    _video_allowed = force_method != 'transcript_api'
    if _video_allowed:
        try:
            from utils.gemini_usage import get_gemini_video_seconds_used, VIDEO_SECS_LIMIT
            if get_gemini_video_seconds_used() + duration_secs > VIDEO_SECS_LIMIT:
                logger.warning(f"[YT-WORKER] Daily video-hour quota reached — skipping native video for {video_id}")
                _video_allowed = False
        except Exception:
            pass

    loop = asyncio.get_event_loop()
    t_s1 = time.monotonic()
    try:
        if not _video_allowed:
            raise RuntimeError("Daily video-hour quota reached")
        summary_text, inp_tokens, out_tokens, think_tokens, audio_tokens, thoughts = await asyncio.wait_for(
            loop.run_in_executor(None, _summarize_via_gemini_video, video_id, prompt_video),
            timeout=_ITEM_TIMEOUT_SECS,
        )
        transcript_source = 'gemini_video'
        logger.info(f"[YT-WORKER] Strategy 1 (gemini video) success for {video_id} "
                    f"in {time.monotonic() - t_s1:.1f}s")
        try:
            from utils.gemini_usage import record_gemini_request, record_gemini_video_seconds
            record_gemini_video_seconds(duration_secs)
            record_gemini_request(total_tokens=inp_tokens + out_tokens + think_tokens)
        except Exception:
            pass
    except asyncio.TimeoutError:
        strat1_err = f"timed out after {_ITEM_TIMEOUT_SECS}s"
        logger.warning(f"[YT-WORKER] Strategy 1 (gemini video) timed out after {_ITEM_TIMEOUT_SECS}s for {video_id}")
    except Exception as e:
        strat1_err = str(e) or e.__class__.__name__
        delay = _is_rate_limited(e)
        if delay:
            logger.info(f"[YT-WORKER] Rate limited, waiting {delay}s before next strategy…")
            await asyncio.sleep(delay)
        logger.warning(f"[YT-WORKER] Strategy 1 (gemini video) failed for {video_id} "
                       f"after {time.monotonic() - t_s1:.1f}s: {e}")

    # Strategy 2: Transcript text → Gemini (fallback — no video quota used).
    # Skipped when the user forced the native video strategy: an explicit method
    # choice should not silently fall back to the other one.
    if not summary_text and force_method != 'gemini_video':
        t_s2 = time.monotonic()
        try:
            summary_text, transcript_text, inp_tokens, out_tokens, think_tokens, audio_tokens, thoughts = await asyncio.wait_for(
                loop.run_in_executor(None, _summarize_via_transcript, video_id, prompt_transcript, transcript_full),
                timeout=_ITEM_TIMEOUT_SECS,
            )
            transcript_source = 'transcript_api'
            logger.info(f"[YT-WORKER] Strategy 2 (transcript) success for {video_id} "
                        f"in {time.monotonic() - t_s2:.1f}s")
            try:
                from utils.gemini_usage import record_gemini_request
                record_gemini_request(total_tokens=inp_tokens + out_tokens + think_tokens)
            except Exception:
                pass
        except asyncio.TimeoutError:
            strat2_err = f"timed out after {_ITEM_TIMEOUT_SECS}s"
            logger.warning(f"[YT-WORKER] Strategy 2 (transcript) timed out after {_ITEM_TIMEOUT_SECS}s for {video_id}")
        except Exception as e:
            strat2_err = str(e) or e.__class__.__name__
            delay = _is_rate_limited(e)
            if delay:
                logger.info(f"[YT-WORKER] Rate limited, waiting {delay}s before next strategy…")
                await asyncio.sleep(delay)
            logger.warning(f"[YT-WORKER] Strategy 2 (transcript) failed for {video_id} "
                           f"after {time.monotonic() - t_s2:.1f}s: {e}")

    # All strategies exhausted — mark as failed so user can retry. Keep both
    # per-strategy reasons in the error_log so the UI can show what actually
    # broke instead of the generic "both failed" string.
    if not summary_text:
        reason = 'No transcript available (gemini video and transcript API both failed)'
        if strat1_err or strat2_err:
            reason += f"\n\nStrategy 1 (gemini video): {strat1_err or 'not attempted'}" \
                      f"\nStrategy 2 (transcript): {strat2_err or 'not attempted'}"
        logger.warning(f"[YT-WORKER] All strategies failed for {video_id}: {reason}")
        db.update_queue_status(queue_id, 'failed', error_log=reason,
                               processing_secs=round(time.monotonic() - t_start))
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
        thinking_tokens=think_tokens or None,
        audio_tokens=audio_tokens or None,
        prompt=user_prompt,
        thoughts=thoughts or None,
        transcript_text=transcript_text,
        output_length_percent=output_length_percent,
        model=get_gemini_model(),
    )

    # Mark done the moment the summary is persisted, BEFORE the best-effort
    # Telegram send. This guarantees a generated summary can never be flipped
    # back to 'failed' by a slow/failing send, and (together with
    # claim_queue_item) that an overlapping run can't re-process and re-send it.
    elapsed = time.monotonic() - t_start
    db.update_queue_status(queue_id, 'done', processing_secs=round(elapsed))
    logger.info(f"[YT-WORKER] Done {video_id} via {transcript_source} in {elapsed:.1f}s total")

    # Send via Telegram if target is set and sender is available (best-effort —
    # a send failure must NOT change the item status; the summary is already saved)
    if telegram_target and _telegram_send_fn:
        try:
            await _telegram_send_fn(telegram_target, summary_text)
            db.mark_telegram_sent(summary_id)
            logger.info(f"[YT-WORKER] Telegram sent for {video_id} → {telegram_target}")
        except Exception as e:
            logger.error(f"[YT-WORKER] Telegram send FAILED for {video_id} → {telegram_target}: {e}", exc_info=True)
    elif telegram_target and not _telegram_send_fn:
        logger.warning(f"[YT-WORKER] No Telegram send function registered — skipping send for {video_id}")

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
    # Reset items stuck in 'processing' (e.g. from a crashed run). Must stay
    # comfortably above the worst-case live item time — both strategies can run
    # back-to-back at _ITEM_TIMEOUT_SECS each (300+300=10 min) plus fetch overhead
    # — so a still-running item is never wrongly reset (matters when a manual
    # process-queue trigger overlaps the scheduled run).
    stuck = db.reset_stuck_processing_items(stuck_minutes=15)
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
