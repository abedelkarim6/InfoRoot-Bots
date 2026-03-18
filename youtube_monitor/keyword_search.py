"""
YouTube keyword search via Data API v3 with filtering pipeline.
Runs as a daily cron job.
"""

import logging
import re
from datetime import datetime, timedelta, timezone

from googleapiclient.discovery import build

from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)

# Set by init_keyword_search() at startup
_youtube_data_api_key = ""


def init_keyword_search(youtube_data_api_key: str = ""):
    global _youtube_data_api_key
    _youtube_data_api_key = youtube_data_api_key or ""


def _parse_duration(iso_duration: str) -> int:
    """Convert ISO 8601 duration (PT1H2M3S) to total seconds."""
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso_duration or '')
    if not m:
        return 0
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def _build_youtube_service():
    if not _youtube_data_api_key:
        raise RuntimeError("youtube.data_api_key not set in config.yaml")
    return build('youtube', 'v3', developerKey=_youtube_data_api_key)


def run_keyword_search(keyword_config: dict) -> int:
    """
    Execute a keyword search for one keyword config row.
    Returns number of new videos enqueued.
    """
    db = get_yt_db()
    youtube = _build_youtube_service()

    keyword = keyword_config['keyword']
    date_window = keyword_config.get('date_window_days', 1)

    now = datetime.now(timezone.utc)
    published_after = (now - timedelta(days=date_window)).isoformat()
    published_before = now.isoformat()

    # Build search params
    search_params = {
        'q': keyword,
        'part': 'snippet',
        'type': keyword_config.get('upload_type', 'video') or 'video',
        'publishedAfter': published_after,
        'publishedBefore': published_before,
        'maxResults': 50,
        'order': 'date',
    }
    lang = keyword_config.get('language')
    if lang:
        search_params['relevanceLanguage'] = lang

    # Handle upload_type mapping for search
    upload_type = keyword_config.get('upload_type', 'video')
    if upload_type == 'live':
        search_params['eventType'] = 'live'
        search_params['type'] = 'video'
    elif upload_type == 'completed':
        search_params['eventType'] = 'completed'
        search_params['type'] = 'video'
    elif upload_type == 'any':
        search_params['type'] = 'video'
    else:
        search_params['type'] = 'video'

    try:
        search_response = youtube.search().list(**search_params).execute()
    except Exception as e:
        logger.error(f"[YT-SEARCH] search.list failed for '{keyword}': {e}")
        return 0

    items = search_response.get('items', [])
    if not items:
        logger.info(f"[YT-SEARCH] No results for '{keyword}'")
        return 0

    video_ids = [item['id']['videoId'] for item in items if item['id'].get('videoId')]
    if not video_ids:
        return 0

    # Snippet data from search results
    snippets = {}
    for item in items:
        vid = item['id'].get('videoId')
        if vid:
            snippets[vid] = item['snippet']

    # Batch fetch video details (contentDetails + statistics)
    video_details = {}
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i+50]
        try:
            details_resp = youtube.videos().list(
                part='contentDetails,statistics,snippet',
                id=','.join(batch)
            ).execute()
            for v in details_resp.get('items', []):
                video_details[v['id']] = v
        except Exception as e:
            logger.error(f"[YT-SEARCH] videos.list failed: {e}")

    # Apply filter pipeline
    enqueued = 0
    for vid in video_ids:
        detail = video_details.get(vid)
        if not detail:
            continue

        if not _passes_filters(detail, keyword_config, snippets.get(vid)):
            continue

        # Dedup check
        if db.is_video_seen(vid):
            continue

        # Mark seen and enqueue — carry over the keyword's telegram_targets and prompt
        title = detail.get('snippet', {}).get('title') or snippets.get(vid, {}).get('title')
        channel_id = detail.get('snippet', {}).get('channelId') or snippets.get(vid, {}).get('channelId')
        telegram_targets = keyword_config.get('telegram_targets') or []
        if not telegram_targets and keyword_config.get('telegram_target'):
            telegram_targets = [keyword_config['telegram_target']]
        prompt = keyword_config.get('prompt')

        db.mark_video_seen(vid, title=title, channel_id=channel_id, source='keyword_search')

        # Enqueue one row per target (or one with no target if none set)
        targets = telegram_targets if telegram_targets else [None]
        vid_enqueued = 0
        for tgt in targets:
            qid = db.enqueue_video(vid, telegram_target=tgt, prompt=prompt)
            if qid:
                vid_enqueued += 1
        if vid_enqueued:
            enqueued += vid_enqueued
            logger.info(f"[YT-SEARCH] Enqueued: {vid} — {title} → {telegram_targets or 'no target'}")
        else:
            logger.info(f"[YT-SEARCH] Skipped duplicate: {vid} — {title}")

    logger.info(f"[YT-SEARCH] Keyword '{keyword}': {len(items)} found, {enqueued} enqueued")
    return enqueued


def _passes_filters(detail: dict, config: dict, snippet: dict = None) -> bool:
    """Apply all filtering rules. Returns True if video passes."""
    content = detail.get('contentDetails', {})
    stats = detail.get('statistics', {})
    snip = detail.get('snippet', {}) or snippet or {}
    title = snip.get('title', '')
    channel_id = snip.get('channelId', '')

    # 1. Duration filter
    duration_secs = _parse_duration(content.get('duration'))
    min_dur = config.get('min_duration_seconds')
    max_dur = config.get('max_duration_seconds')
    if min_dur is not None and duration_secs < min_dur:
        return False
    if max_dur is not None and duration_secs > max_dur:
        return False

    # 2. Channel blocklist
    blocklist = config.get('channel_blocklist') or []
    if isinstance(blocklist, str):
        import json
        blocklist = json.loads(blocklist)
    if channel_id in blocklist:
        return False

    # 3. Channel allowlist (only enforced if non-empty)
    allowlist = config.get('channel_allowlist') or []
    if isinstance(allowlist, str):
        import json
        allowlist = json.loads(allowlist)
    if allowlist and channel_id not in allowlist:
        return False

    # 4. Title must include (only enforced if non-empty)
    must_include = config.get('title_must_include') or []
    if isinstance(must_include, str):
        import json
        must_include = json.loads(must_include)
    if must_include:
        if not any(term.lower() in title.lower() for term in must_include):
            return False

    # 5. Title must exclude
    must_exclude = config.get('title_must_exclude') or []
    if isinstance(must_exclude, str):
        import json
        must_exclude = json.loads(must_exclude)
    if must_exclude:
        if any(term.lower() in title.lower() for term in must_exclude):
            return False

    # 6. Min view count
    min_views = config.get('min_view_count', 0) or 0
    view_count = int(stats.get('viewCount', 0))
    if view_count < min_views:
        return False

    return True


def run_all_keyword_searches() -> int:
    """Run search for all active keyword configs. Returns total enqueued."""
    db = get_yt_db()
    keywords = db.get_keywords(active_only=True)
    total = 0
    for kw_cfg in keywords:
        try:
            count = run_keyword_search(kw_cfg)
            db.update_keyword_last_run(kw_cfg['id'])
            total += count
        except Exception as e:
            logger.error(f"[YT-SEARCH] Failed for keyword '{kw_cfg.get('keyword')}': {e}")
    logger.info(f"[YT-SEARCH] Daily run complete: {total} total videos enqueued")
    return total


def run_due_keyword_searches() -> int:
    """Run searches only for keywords whose schedule interval has elapsed."""
    db = get_yt_db()
    due_keywords = db.get_due_keywords()
    if not due_keywords:
        return 0
    total = 0
    for kw_cfg in due_keywords:
        try:
            count = run_keyword_search(kw_cfg)
            db.update_keyword_last_run(kw_cfg['id'])
            total += count
            logger.info(f"[YT-SEARCH] Scheduled run for '{kw_cfg['keyword']}': {count} enqueued")
        except Exception as e:
            logger.error(f"[YT-SEARCH] Scheduled run failed for '{kw_cfg.get('keyword')}': {e}")
    return total
