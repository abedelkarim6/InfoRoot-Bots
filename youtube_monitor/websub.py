"""
WebSub (PubSubHubbub) subscription management and callback handler
for YouTube channel monitoring.
"""

import logging
import hashlib
import hmac
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import httpx

from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)

def _get_default_targets() -> list:
    """Read global default telegram targets from config.yaml."""
    try:
        from utils.helpers import load_config
        cfg = load_config()
        return cfg.get("youtube", {}).get("default_targets", []) or []
    except Exception:
        return []


def _get_websub_secret() -> str:
    """Return the configured WebSub HMAC secret, or '' if not set.
    When set, callbacks are signed by the hub and verified here. When unset,
    behavior is unchanged (callbacks accepted) so existing deployments keep working."""
    try:
        from utils.helpers import load_config
        cfg = load_config()
        return (cfg.get("youtube", {}) or {}).get("websub_secret", "") or ""
    except Exception:
        return ""


def verify_signature(body: bytes, signature_header: str) -> bool:
    """Verify the X-Hub-Signature header against the configured secret.
    Returns True when the signature matches. Always returns True if no secret
    is configured (opt-in mode). Returns False if a secret is set but signature
    is missing or wrong."""
    secret = _get_websub_secret()
    if not secret:
        # Opt-in: no secret configured → accept (and warn elsewhere)
        return True
    sig = (signature_header or "").strip()
    if not sig.startswith("sha1=") and not sig.startswith("sha256="):
        return False
    if sig.startswith("sha1="):
        algo = "sha1"
        expected = sig[5:]
        digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()
    else:
        algo = "sha256"
        expected = sig[7:]
        digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.lower(), digest.lower())


WEBSUB_HUB = "https://pubsubhubbub.appspot.com/subscribe"
YOUTUBE_TOPIC_BASE = "https://www.youtube.com/xml/feeds/videos.xml?channel_id="

# Lease we REQUEST from the hub. YouTube's hub ignores this and grants its own
# (~5 days) — the real value is read back in handle_verification. Renewal runs
# every 4 days (see renew_websub.py / app.py) to stay under the real lease.
LEASE_SECONDS = 9 * 24 * 3600


async def subscribe_channel(channel_id: str, callback_url: str, secret: str = None):
    """
    Send a WebSub subscription request for a YouTube channel.
    If `secret` is not provided, falls back to the configured `youtube.websub_secret`.
    """
    topic_url = f"{YOUTUBE_TOPIC_BASE}{channel_id}"
    data = {
        "hub.callback": callback_url,
        "hub.topic": topic_url,
        "hub.verify": "async",
        "hub.mode": "subscribe",
        "hub.lease_seconds": str(LEASE_SECONDS),
    }
    effective_secret = secret if secret else _get_websub_secret()
    if effective_secret:
        data["hub.secret"] = effective_secret

    async with httpx.AsyncClient() as client:
        resp = await client.post(WEBSUB_HUB, data=data, timeout=30)

    if resp.status_code in (202, 204):
        db = get_yt_db()
        now = datetime.utcnow()
        # NOTE: expires_at here is provisional — it assumes the requested
        # LEASE_SECONDS. The hub's verification callback overwrites it with the
        # REAL granted lease (see handle_verification). The callback_url is
        # persisted so the renewal job can re-subscribe without config.yaml.
        db.update_websub_status(
            channel_id,
            subscribed_at=now,
            expires_at=now + timedelta(seconds=LEASE_SECONDS),
            callback_url=callback_url,
        )
        logger.info(f"[WEBSUB] Subscription request accepted for {channel_id}")
        return True
    else:
        logger.error(f"[WEBSUB] Subscription failed for {channel_id}: {resp.status_code} {resp.text}")
        return False


async def unsubscribe_channel(channel_id: str, callback_url: str):
    """Send an unsubscribe request."""
    topic_url = f"{YOUTUBE_TOPIC_BASE}{channel_id}"
    data = {
        "hub.callback": callback_url,
        "hub.topic": topic_url,
        "hub.verify": "async",
        "hub.mode": "unsubscribe",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(WEBSUB_HUB, data=data, timeout=30)
    return resp.status_code in (202, 204)


def _channel_id_from_topic(topic: str) -> str:
    """Extract the YouTube channel_id from a topic feed URL."""
    if not topic:
        return ""
    m = re.search(r"channel_id=([^&]+)", topic)
    return m.group(1) if m else ""


def handle_verification(mode: str, topic: str, challenge: str, lease_seconds: str = None):
    """
    Handle the WebSub hub verification GET request.

    The hub IGNORES the lease we request in subscribe_channel and grants its
    own (YouTube's hub typically gives ~5 days). It reports the REAL granted
    lease here in `hub.lease_seconds` — so this is the only place the true
    expiry is known. We persist it to the DB so renewal scheduling is accurate.

    Returns the challenge string to confirm the subscription.
    """
    logger.info(f"[WEBSUB] Verification: mode={mode}, topic={topic}, "
                f"lease_seconds={lease_seconds}")

    if mode == "subscribe" and lease_seconds:
        channel_id = _channel_id_from_topic(topic)
        try:
            lease = int(lease_seconds)
        except (TypeError, ValueError):
            lease = 0
        if channel_id and lease > 0:
            try:
                now = datetime.utcnow()
                real_expiry = now + timedelta(seconds=lease)
                get_yt_db().update_websub_expiry(
                    channel_id, subscribed_at=now, expires_at=real_expiry)
                logger.info(
                    f"[WEBSUB] Real lease for {channel_id}: {lease}s "
                    f"(~{lease / 86400:.1f}d) — expires {real_expiry.isoformat()}")
            except Exception as e:
                logger.error(f"[WEBSUB] Failed to store real lease for "
                              f"{channel_id}: {e}")

    return challenge


def parse_feed_notification(body: bytes):
    """
    Parse a WebSub Atom feed notification from YouTube.
    Returns a list of dicts with video_id, channel_id, title, published.
    """
    videos = []
    try:
        root = ET.fromstring(body)
        ns = {
            'atom': 'http://www.w3.org/2005/Atom',
            'yt': 'http://www.youtube.com/xml/schemas/2015',
        }
        for entry in root.findall('atom:entry', ns):
            video_id = entry.find('yt:videoId', ns)
            channel_id = entry.find('yt:channelId', ns)
            title = entry.find('atom:title', ns)
            published = entry.find('atom:published', ns)

            if video_id is not None:
                videos.append({
                    'video_id': video_id.text,
                    'channel_id': channel_id.text if channel_id is not None else None,
                    'title': title.text if title is not None else None,
                    'published': published.text if published is not None else None,
                })
    except ET.ParseError as e:
        logger.error(f"[WEBSUB] Failed to parse feed: {e}")

    return videos


def _is_short(video_id: str) -> bool:
    """Detect whether a video is a YouTube Short.

    There's no direct field for this in the Data API, so we probe the canonical
    /shorts/{id} URL: YouTube serves it 200 for actual Shorts and 303-redirects
    everything else to /watch?v={id}. On any network error we return False (do
    not treat ambiguous probes as Shorts).
    """
    try:
        resp = httpx.head(
            f"https://www.youtube.com/shorts/{video_id}",
            follow_redirects=False,
            timeout=5,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        return resp.status_code == 200
    except Exception as e:
        logger.warning(f"[WEBSUB] Shorts probe failed for {video_id}: {e} — treating as non-short")
        return False


def _channel_filter_reject_reason(video_id: str, meta: dict, duration_secs: int,
                                  min_dur, max_dur, lang_filter, upload_type) -> str | None:
    """Return a human-readable rejection reason or None if the video passes."""
    if min_dur and duration_secs and duration_secs < min_dur:
        return f"too short ({duration_secs}s < {min_dur}s min)"
    if max_dur and duration_secs and duration_secs > max_dur:
        return f"too long ({duration_secs}s > {max_dur}s max)"
    if lang_filter:
        # Lenient: only reject when YouTube actually reports a language and it
        # disagrees. Many uploads don't set defaultAudio/DefaultLanguage at all.
        video_lang = (meta.get('language') or '').lower()
        if video_lang and not video_lang.startswith(lang_filter.lower()):
            return f"wrong language ({video_lang} != {lang_filter})"
    if upload_type and upload_type != 'video':
        lbc = meta.get('live_broadcast_content')
        if upload_type == 'live' and lbc != 'live':
            return "not currently live"
        if upload_type == 'completed' and not meta.get('actual_end_time'):
            return "not a completed live broadcast"
        if upload_type == 'short' and not _is_short(video_id):
            return "not a Short"
        if upload_type == 'regular' and _is_short(video_id):
            return "is a Short (regular videos only)"
    return None


def process_websub_notification(body: bytes):
    """
    Process a WebSub callback notification: parse, deduplicate, and enqueue new videos.
    Looks up the channel's telegram_target and prompt to pass to the queue.
    Returns the number of new videos enqueued.
    """
    from utils.database import get_db
    if not get_db().get_system_enabled():
        logger.info("[WEBSUB] System disabled — ignoring notification")
        return 0
    db = get_yt_db()
    videos = parse_feed_notification(body)
    enqueued = 0

    # Load global blocked keywords once
    blocked_keywords = db.get_blocked_keyword_list()

    for video in videos:
        vid = video['video_id']
        if db.is_video_seen(vid):
            continue

        # Check global blocked keywords against video title
        video_title = video.get('title', '')
        if blocked_keywords and video_title:
            title_lower = video_title.lower()
            blocked_match = next((bk for bk in blocked_keywords if bk.lower() in title_lower), None)
            if blocked_match:
                logger.info(f"[WEBSUB] Skipping {vid} — title matches blocked keyword '{blocked_match}'")
                continue

        # Look up the channel to get its telegram_targets and prompt
        yt_channel_id = video.get('channel_id')
        telegram_targets = []
        prompt = None
        if yt_channel_id:
            ch_row = db.get_channel_by_yt_id(yt_channel_id)
            if ch_row:
                # Skip inactive channels entirely (no processing, no Gemini calls)
                if not ch_row.get('active', True):
                    logger.info(f"[WEBSUB] Skipping video {vid} — channel {yt_channel_id} is inactive")
                    continue
                telegram_targets = ch_row.get('telegram_targets') or []
                if not telegram_targets and ch_row.get('telegram_target'):
                    telegram_targets = [ch_row['telegram_target']]
                # Resolve the channel's prompt_key → prompt text. None/missing
                # falls back to the first available youtube prompt.
                from youtube_monitor.prompts import resolve_yt_prompt
                prompt = resolve_yt_prompt(ch_row.get('prompt_key'))

                # Apply title filters immediately (title is in the notification)
                video_title = video.get('title', '')
                must_include = ch_row.get('title_must_include') or []
                must_exclude = ch_row.get('title_must_exclude') or []
                if must_include and not any(t.lower() in video_title.lower() for t in must_include):
                    logger.info(f"[WEBSUB] Skipping {vid} — title doesn't match include filter")
                    continue
                if must_exclude and any(t.lower() in video_title.lower() for t in must_exclude):
                    logger.info(f"[WEBSUB] Skipping {vid} — title matches exclude filter")
                    continue

                # Metadata-backed filters — fetch once if any are configured so
                # videos that wouldn't pass never enter the queue (no wasted
                # processing slot, no 'skipped' churn from the worker).
                # min_view_count is intentionally left to the worker: WebSub
                # fires within seconds of publish, so the count is always ~0
                # here and any non-zero threshold would reject everything.
                min_dur = ch_row.get('min_duration_seconds')
                max_dur = ch_row.get('max_duration_seconds')
                lang_filter = ch_row.get('language') or None
                upload_type = ch_row.get('upload_type') or None
                if min_dur or max_dur or lang_filter or (upload_type and upload_type != 'video'):
                    from youtube_monitor.worker import _fetch_video_metadata, _parse_duration
                    meta = _fetch_video_metadata(vid)
                    duration_secs = _parse_duration(meta.get('duration')) if meta.get('duration') else 0
                    reject_reason = _channel_filter_reject_reason(
                        vid, meta, duration_secs, min_dur, max_dur, lang_filter, upload_type,
                    )
                    if reject_reason:
                        logger.info(f"[WEBSUB] Skipping {vid} — {reject_reason}")
                        db.mark_video_seen(video_id=vid, title=video.get('title'),
                                           channel_id=yt_channel_id, source='websub')
                        continue

        db.mark_video_seen(
            video_id=vid,
            title=video.get('title'),
            channel_id=yt_channel_id,
            source='websub',
        )

        # Fall back to global default targets if none set on channel
        if not telegram_targets:
            telegram_targets = _get_default_targets()

        # Enqueue one row per target (or one with no target if none set)
        targets = telegram_targets if telegram_targets else [None]
        for tgt in targets:
            qid = db.enqueue_video(vid, telegram_target=tgt, prompt=prompt,
                                   source_channel_id=yt_channel_id)
            if qid:
                enqueued += 1
        if enqueued:
            logger.info(f"[WEBSUB] Enqueued new video: {vid} — {video.get('title', '?')} → {telegram_targets or 'no target'}")
        else:
            logger.info(f"[WEBSUB] Skipped duplicate video: {vid}")

    return enqueued
