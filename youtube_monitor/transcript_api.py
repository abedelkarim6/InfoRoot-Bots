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
