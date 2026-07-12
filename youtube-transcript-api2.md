# Migration: switch YouTube transcript + metadata to the external transcript API

**Goal:** Make the external IndustryLens transcript API (headless-browser scraper,
see `youtube-transcript-api.md`) the **primary** source for both the video
**transcript** and **metadata**. The YouTube Data API becomes the metadata
*fallback*; the `youtube-transcript-api` library becomes the transcript
*last-resort fallback*. **Gemini is unchanged** — it remains the summarizer
(the scraper only retrieves data, it does not summarize).

**Behavior when no token is configured:** the worker behaves exactly as before
(Data API metadata + library transcript). The feature is fully disabled until
`youtube.transcript_api.token` is set in `config.yaml`.

> Apply these to the latest code on the dev server. Anchor on the quoted
> surrounding code, not line numbers — adapt if the surrounding code differs.

---

## 1. NEW FILE — `youtube_monitor/transcript_api.py`

Create this file with the full content below:

```python
"""
Client for the external IndustryLens YouTube transcript API.

A headless-browser scraper that returns a video's transcript PLUS metadata
(title, channel, duration, views, description, chapters) in one call. It replaces
the gated `youtube-transcript-api` library as the primary transcript source — and
because it returns metadata too, the worker uses it in place of the YouTube Data
API metadata fetch when configured.

Endpoint contract (single-video mode) — see youtube-transcript-api.md:
    POST {base_url}  { "url": "<youtube watch url>", "lang"?: "en" }
    Authorization: Bearer <token>
  → 200 { status: "ok"|"empty"|..., videos: [ { ...metadata, transcript } ] }
  → 503 { status: "rate_limited", retry_after_seconds }   (consent/cookie wall)
  → 401 unauthorized / 503 no-token-configured

Synchronous (httpx.Client) by design — call it via loop.run_in_executor from the
async worker so a multi-second scrape never blocks the event loop.
"""
import logging
import httpx

logger = logging.getLogger(__name__)

# Configured once at startup by init_transcript_api()
_base_url = "https://api.industry-lens.com/youtube/transcript"
_lan_url = ""
_use_lan = False
_token = ""

# Single-video scrapes run ~5-15s; cap well under the public ~100s Cloudflare edge
# timeout so a stuck scrape fails fast instead of hanging the queue item.
_REQUEST_TIMEOUT = 90.0


def init_transcript_api(base_url: str = "", lan_url: str = "", token: str = "",
                        use_lan: bool = False):
    """Wire the endpoint config from config.yaml youtube.transcript_api."""
    global _base_url, _lan_url, _use_lan, _token
    if base_url:
        _base_url = base_url
    _lan_url = lan_url or ""
    _use_lan = bool(use_lan)
    _token = token or ""
    if _token:
        logger.info(f"[YT-TRANSCRIPT-API] configured — endpoint={_active_url()}")
    else:
        logger.warning("[YT-TRANSCRIPT-API] no token set (youtube.transcript_api.token) — "
                       "external transcript API disabled; falling back to Data API + library")


def is_configured() -> bool:
    """True when a token is set; otherwise the worker skips this path entirely."""
    return bool(_token)


def _active_url() -> str:
    return _lan_url if (_use_lan and _lan_url) else _base_url


class TranscriptApiRateLimited(Exception):
    """Raised on a 503 `rate_limited` response; carries retry_after_seconds."""
    def __init__(self, retry_after=None):
        self.retry_after = retry_after
        super().__init__(f"rate_limited (retry_after={retry_after})")


def fetch_video(video_id: str, lang: str = None) -> dict | None:
    """Fetch one video's transcript + metadata.

    Returns the `video` object (see module docstring) or None when the API is
    unconfigured, the video has no extractable data (`empty`), or the call fails.
    Raises TranscriptApiRateLimited on a 503 so the caller can back off and retry.
    """
    if not _token:
        return None
    payload = {"url": f"https://www.youtube.com/watch?v={video_id}"}
    if lang:
        payload["lang"] = lang
    headers = {"Authorization": f"Bearer {_token}", "Content-Type": "application/json"}

    try:
        with httpx.Client(timeout=_REQUEST_TIMEOUT) as client:
            resp = client.post(_active_url(), json=payload, headers=headers)
    except Exception as e:
        logger.warning(f"[YT-TRANSCRIPT-API] request failed for {video_id}: {e}")
        return None

    if resp.status_code == 503:
        retry_after = None
        try:
            retry_after = resp.json().get("retry_after_seconds")
        except Exception:
            pass
        raise TranscriptApiRateLimited(retry_after)
    if resp.status_code == 401:
        logger.error("[YT-TRANSCRIPT-API] 401 unauthorized — check youtube.transcript_api.token")
        return None
    if resp.status_code != 200:
        logger.warning(f"[YT-TRANSCRIPT-API] HTTP {resp.status_code} for {video_id}: {resp.text[:200]}")
        return None

    try:
        data = resp.json()
    except Exception as e:
        logger.warning(f"[YT-TRANSCRIPT-API] bad JSON for {video_id}: {e}")
        return None

    status = data.get("status")
    if status != "ok":
        # empty / failed — reachable but nothing usable was extracted
        logger.info(f"[YT-TRANSCRIPT-API] status={status} for {video_id} — no usable data")
        return None
    videos = data.get("videos") or []
    return videos[0] if videos else None


def extract_metadata(video: dict) -> dict:
    """Map a `video` object to the worker's metadata dict shape.

    Mirrors `_fetch_video_metadata`'s Data-API output, except duration arrives as
    `duration_seconds` (int) rather than an ISO-8601 `duration` string, and `tags`
    are not provided by the scraper.
    """
    if not video:
        return {}
    meta = {
        'title': video.get('title', ''),
        'description': video.get('description_text', ''),
        'channel_name': video.get('channel_name', ''),
        'published_at': video.get('published_at'),
        'tags': [],  # not surfaced by the scraper
    }
    dur = video.get('duration_seconds')
    if dur:
        try:
            meta['duration_seconds'] = int(dur)
        except (TypeError, ValueError):
            pass
    vc = video.get('view_count')
    if vc is not None:
        try:
            meta['view_count'] = int(vc)
        except (TypeError, ValueError):
            pass
    return meta


def extract_transcript_text(video: dict) -> str:
    """Return the joined transcript text, or '' when the video has no captions
    (`transcript` is null) — the caller then falls back to the library."""
    if not video:
        return ""
    t = video.get('transcript')
    if not t:
        return ""
    return (t.get('text') or "").strip()
```

---

## 2. EDIT — `youtube_monitor/worker.py`

### 2a. Add the import (top of file, with the other `youtube_monitor` imports)

```python
from youtube_monitor import transcript_api
from youtube_monitor.db import get_yt_db
from youtube_monitor.keyword_search import _parse_duration
```

### 2b. Replace `_summarize_via_transcript` — accept a prefetched transcript, keep the library as fallback

**BEFORE:**
```python
def _summarize_via_transcript(video_id: str, prompt: str) -> tuple[str, int, int, str]:
    """Strategy 2: Fetch transcript via youtube-transcript-api, send text to Gemini.
    Returns (summary_text, input_tokens, output_tokens, thoughts)."""
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
```

**AFTER:**
```python
def _summarize_via_transcript(video_id: str, prompt: str,
                              prefetched_text: str = "") -> tuple[str, int, int, str]:
    """Strategy 2: Summarize from a transcript.

    Primary source is the external transcript API (its text is fetched once,
    up-front in process_queue_item, and passed in as `prefetched_text`). When
    that text is empty — API unconfigured, video has no captions, or the call
    failed — fall back to the gated `youtube-transcript-api` library.
    Returns (summary_text, input_tokens, output_tokens, thoughts)."""
    full_text = (prefetched_text or "").strip()

    if not full_text:
        # Last-resort fallback: youtube-transcript-api library
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
        full_text = ' '.join(entry.text for entry in transcript_list).strip()

    if not full_text:
        raise RuntimeError("No transcript available (external API and library both empty)")

    if len(full_text) > 30_000:
        full_text = full_text[:30000] + "... [truncated]"
```

(The rest of the function — the `{transcript}` placeholder handling and the Gemini
call — is unchanged.)

### 2c. In `process_queue_item` — fetch transcript + metadata up-front from the new API

Find the metadata-fetch block (just after `user_prompt = queue_item.get('prompt') or _get_global_prompt()`).

**BEFORE:**
```python
    # Fetch metadata for all tiers
    meta = _fetch_video_metadata(video_id)
    title = meta.get('title', video_id)
    channel_name = meta.get('channel_name', '')
    published_at = meta.get('published_at')
    tags = meta.get('tags', [])
    description = meta.get('description', '')
```

**AFTER:**
```python
    loop = asyncio.get_event_loop()

    # Fetch transcript + metadata in one call from the external transcript API
    # (headless-browser scraper — replaces the gated youtube-transcript-api lib).
    # The transcript text is cached here and reused by Strategy 2 below, so a
    # successful scrape costs only one request. Metadata falls back to the
    # YouTube Data API when the scraper is unconfigured or returns nothing.
    external_transcript = ""
    ext_meta = {}
    if transcript_api.is_configured():
        external_video = None
        try:
            external_video = await loop.run_in_executor(None, transcript_api.fetch_video, video_id)
        except transcript_api.TranscriptApiRateLimited as e:
            wait = e.retry_after or 40
            logger.info(f"[YT-WORKER] Transcript API rate-limited for {video_id}; "
                        f"waiting {wait}s then retrying once")
            await asyncio.sleep(wait)
            try:
                external_video = await loop.run_in_executor(None, transcript_api.fetch_video, video_id)
            except Exception as e2:
                logger.warning(f"[YT-WORKER] Transcript API retry failed for {video_id}: {e2}")
        except Exception as e:
            logger.warning(f"[YT-WORKER] Transcript API error for {video_id}: {e}")
        if external_video:
            ext_meta = transcript_api.extract_metadata(external_video)
            external_transcript = transcript_api.extract_transcript_text(external_video)
            logger.info(f"[YT-WORKER] Transcript API returned for {video_id} "
                        f"(transcript chars={len(external_transcript)})")

    # Metadata: prefer the external scraper; fall back to the YouTube Data API.
    meta = ext_meta or _fetch_video_metadata(video_id)
    title = meta.get('title', video_id)
    channel_name = meta.get('channel_name', '')
    published_at = meta.get('published_at')
    tags = meta.get('tags', [])
    description = meta.get('description', '')
```

> NOTE: this introduces `loop = asyncio.get_event_loop()` near the top of the
> function. Later in the same function there is an existing
> `loop = asyncio.get_event_loop()` (just before Strategy 1) — **delete that
> later duplicate line** so `loop` is only assigned once. (If your version
> doesn't have it, ignore.)

### 2d. Duration calc — accept both `duration_seconds` (int) and ISO `duration`

**BEFORE:**
```python
    # Compute duration_secs unconditionally (needed for video-hour tracking)
    duration_secs = _parse_duration(meta.get('duration')) if meta.get('duration') else 0
```

**AFTER:**
```python
    # Compute duration_secs unconditionally (needed for video-hour tracking).
    # The external API returns duration_seconds (int); the Data API returns an
    # ISO-8601 duration string — handle whichever the metadata source provided.
    if meta.get('duration_seconds'):
        duration_secs = int(meta['duration_seconds'])
    elif meta.get('duration'):
        duration_secs = _parse_duration(meta['duration'])
    else:
        duration_secs = 0
```

### 2e. Strategy 2 call site — pass the prefetched transcript

**BEFORE:**
```python
            summary_text, inp_tokens, out_tokens, thoughts = await asyncio.wait_for(
                loop.run_in_executor(None, _summarize_via_transcript, video_id, prompt_transcript),
                timeout=_ITEM_TIMEOUT_SECS,
            )
```

**AFTER:**
```python
            summary_text, inp_tokens, out_tokens, thoughts = await asyncio.wait_for(
                loop.run_in_executor(None, _summarize_via_transcript, video_id,
                                     prompt_transcript, external_transcript),
                timeout=_ITEM_TIMEOUT_SECS,
            )
```

---

## 3. EDIT — `app.py`

### 3a. Add the import (next to `from youtube_monitor.worker import init_worker`)

```python
from youtube_monitor.worker import init_worker
from youtube_monitor.transcript_api import init_transcript_api
```

### 3b. Call `init_transcript_api()` right after the existing `init_worker(...)` call

Add this immediately after the `init_worker(...)` block:

```python
# External transcript API (headless-browser scraper) — primary transcript +
# metadata source. Disabled (worker falls back to Data API + library) until a
# token is set in config.yaml youtube.transcript_api.token.
_yt_transcript_cfg = _yt_cfg.get("transcript_api", {}) or {}
init_transcript_api(
    base_url=_yt_transcript_cfg.get("base_url", ""),
    lan_url=_yt_transcript_cfg.get("lan_url", ""),
    token=_yt_transcript_cfg.get("token", ""),
    use_lan=_yt_transcript_cfg.get("use_lan", False),
)
```

> `_yt_cfg` is the existing `_cfg.get("youtube", {})` variable used by `init_worker`.
> If it's named differently in the latest code, reuse whatever holds the
> `youtube:` config section.

---

## 4. EDIT — `config.yaml`

Add a `transcript_api` block under the existing `youtube:` section:

```yaml
youtube:
  # ...existing keys (gemini_project, data_api_key, callback_url, default_targets, ...)
  transcript_api:
    base_url: 'https://api.industry-lens.com/youtube/transcript'
    lan_url: 'http://raedzein-server.tail49ce21.ts.net:4001/youtube/transcript'
    use_lan: false
    token: ''  # YOUTUBE_API_TOKEN from Raed — leave empty to disable (falls back to Data API + library)
```

**Set `token` to the value from Raed** to activate. Flip `use_lan: true` only if
the server is on the IndustryLens Tailscale tailnet.

---

## 5. Summary of files

| File | Change |
|---|---|
| `youtube_monitor/transcript_api.py` | **NEW** — external transcript API client |
| `youtube_monitor/worker.py` | import; `_summarize_via_transcript` (prefetched text + library fallback); up-front transcript+metadata fetch; duration calc; Strategy 2 call site; remove duplicate `loop` assignment |
| `app.py` | import + `init_transcript_api()` call after `init_worker` |
| `config.yaml` | new `youtube.transcript_api` block |

## 6. Notes / caveats

- **Dependencies:** `httpx` is already used (websub). `youtube-transcript-api`
  stays installed (kept as fallback). No new packages.
- **Gemini is NOT replaced** — it's the summarizer. The scraper only retrieves
  data ("no summarization on our side").
- **Trade-off (current scope = transcript + metadata):** the scraper is called
  on *every* queue item, even when Strategy 1 (Gemini native video) would
  succeed without a transcript. If you'd rather only call the scraper when the
  transcript is actually needed, make the up-front fetch lazy (move it into the
  Strategy 2 branch) and keep `_fetch_video_metadata` as the primary metadata
  source.
- **Validation:** `python -m py_compile youtube_monitor/transcript_api.py
  youtube_monitor/worker.py app.py` and load `config.yaml` with PyYAML.
```
