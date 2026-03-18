"""
WebSub (PubSubHubbub) subscription management and callback handler
for YouTube channel monitoring.
"""

import logging
import hashlib
import hmac
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import httpx

from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)

WEBSUB_HUB = "https://pubsubhubbub.appspot.com/subscribe"
YOUTUBE_TOPIC_BASE = "https://www.youtube.com/xml/feeds/videos.xml?channel_id="

# Subscription lease is ~10 days; we renew every 9
LEASE_SECONDS = 9 * 24 * 3600


async def subscribe_channel(channel_id: str, callback_url: str, secret: str = None):
    """
    Send a WebSub subscription request for a YouTube channel.
    """
    topic_url = f"{YOUTUBE_TOPIC_BASE}{channel_id}"
    data = {
        "hub.callback": callback_url,
        "hub.topic": topic_url,
        "hub.verify": "async",
        "hub.mode": "subscribe",
        "hub.lease_seconds": str(LEASE_SECONDS),
    }
    if secret:
        data["hub.secret"] = secret

    async with httpx.AsyncClient() as client:
        resp = await client.post(WEBSUB_HUB, data=data, timeout=30)

    if resp.status_code in (202, 204):
        db = get_yt_db()
        now = datetime.utcnow()
        db.update_websub_status(
            channel_id,
            subscribed_at=now,
            expires_at=now + timedelta(seconds=LEASE_SECONDS),
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


def handle_verification(mode: str, topic: str, challenge: str, lease_seconds: str = None):
    """
    Handle the WebSub hub verification GET request.
    Returns the challenge string to confirm subscription.
    """
    logger.info(f"[WEBSUB] Verification: mode={mode}, topic={topic}")
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


def process_websub_notification(body: bytes):
    """
    Process a WebSub callback notification: parse, deduplicate, and enqueue new videos.
    Looks up the channel's telegram_target and prompt to pass to the queue.
    Returns the number of new videos enqueued.
    """
    db = get_yt_db()
    videos = parse_feed_notification(body)
    enqueued = 0

    for video in videos:
        vid = video['video_id']
        if db.is_video_seen(vid):
            continue

        # Look up the channel to get its telegram_targets and prompt
        yt_channel_id = video.get('channel_id')
        telegram_targets = []
        prompt = None
        if yt_channel_id:
            ch_row = db.get_channel_by_yt_id(yt_channel_id)
            if ch_row:
                telegram_targets = ch_row.get('telegram_targets') or []
                if not telegram_targets and ch_row.get('telegram_target'):
                    telegram_targets = [ch_row['telegram_target']]
                prompt = ch_row.get('prompt')

        db.mark_video_seen(
            video_id=vid,
            title=video.get('title'),
            channel_id=yt_channel_id,
            source='websub',
        )

        # Enqueue one row per target (or one with no target if none set)
        targets = telegram_targets if telegram_targets else [None]
        for tgt in targets:
            qid = db.enqueue_video(vid, telegram_target=tgt, prompt=prompt)
            if qid:
                enqueued += 1
        if enqueued:
            logger.info(f"[WEBSUB] Enqueued new video: {vid} — {video.get('title', '?')} → {telegram_targets or 'no target'}")
        else:
            logger.info(f"[WEBSUB] Skipped duplicate video: {vid}")

    return enqueued
