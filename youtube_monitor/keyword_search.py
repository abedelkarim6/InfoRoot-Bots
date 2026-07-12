"""
YouTube keyword search via Data API v3 with filtering pipeline.
Runs as a daily cron job.
"""

import logging
import re
from datetime import datetime, timedelta, timezone

from googleapiclient.discovery import build

from youtube_monitor import yt_memory_cache
from youtube_monitor.db import get_yt_db, record_api_usage, get_quota_limit

logger = logging.getLogger(__name__)


def _get_default_targets() -> list:
    """Read global default telegram targets from config.yaml."""
    try:
        from utils.helpers import load_config
        cfg = load_config()
        return cfg.get("youtube", {}).get("default_targets", []) or []
    except Exception:
        return []


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
    return build('youtube', 'v3', developerKey=_youtube_data_api_key, cache=yt_memory_cache)


def _date_window_bounds(keyword_config: dict):
    """Return (published_after, published_before) ISO strings for the config."""
    date_window = keyword_config.get('date_window_days', 1)
    now = datetime.now(timezone.utc)
    return (now - timedelta(days=date_window)).isoformat(), now.isoformat()


def _search_one_term(youtube, keyword_config: dict, search_term: str,
                     published_after: str, published_before: str):
    """Run a single search.list call for one term (100 quota units).
    Returns (ordered list of video_ids, {video_id: snippet})."""
    search_params = {
        'q': search_term,
        'part': 'snippet',
        'publishedAfter': published_after,
        'publishedBefore': published_before,
        'maxResults': 50,
        'order': 'date',
    }
    lang = keyword_config.get('language')
    if lang:
        search_params['relevanceLanguage'] = lang

    upload_type = keyword_config.get('upload_type', 'video')
    if upload_type == 'live':
        search_params['eventType'] = 'live'
        search_params['type'] = 'video'
    elif upload_type == 'completed':
        search_params['eventType'] = 'completed'
        search_params['type'] = 'video'
    else:
        search_params['type'] = 'video'

    try:
        search_response = youtube.search().list(**search_params).execute()
    except Exception as e:
        logger.error(f"[YT-SEARCH] search.list failed for '{search_term}': {e}")
        return [], {}

    items = search_response.get('items', [])
    video_ids = []
    snippets = {}
    for item in items:
        vid = item['id'].get('videoId')
        if vid and vid not in snippets:
            video_ids.append(vid)
            snippets[vid] = item['snippet']

    # 100 quota units charged whether or not there are results. video_count =
    # how many videos this word found, which feeds the per-keyword yield metric.
    record_api_usage('search.list', context=search_term, source='keyword_search',
                     keyword_id=keyword_config.get('id'), video_count=len(video_ids))
    if not items:
        logger.info(f"[YT-SEARCH] No results for '{search_term}'")
    return video_ids, snippets


def _enqueue_videos(youtube, keyword_config: dict, all_video_ids: list,
                    snippets: dict, global_blocked_ids: set) -> int:
    """Fetch details for found videos, apply filters, dedup and enqueue.
    Returns number of new videos enqueued."""
    if not all_video_ids:
        return 0
    db = get_yt_db()

    # Batch fetch video details (contentDetails + statistics)
    video_details = {}
    for i in range(0, len(all_video_ids), 50):
        batch = all_video_ids[i:i+50]
        try:
            details_resp = youtube.videos().list(
                part='contentDetails,statistics,snippet',
                id=','.join(batch)
            ).execute()
            for v in details_resp.get('items', []):
                video_details[v['id']] = v
            record_api_usage('videos.list', context=f'{len(batch)} videos',
                             source='keyword_search', video_count=len(batch))
        except Exception as e:
            logger.error(f"[YT-SEARCH] videos.list failed: {e}")

    # Apply filter pipeline
    enqueued = 0
    for vid in all_video_ids:
        detail = video_details.get(vid)
        if not detail:
            continue

        if not _passes_filters(detail, keyword_config, snippets.get(vid), global_blocked_ids):
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
        # Fall back to global default targets
        if not telegram_targets:
            telegram_targets = _get_default_targets()
        # Resolve the keyword's prompt_key → prompt text. None falls back to
        # the first available youtube prompt.
        from youtube_monitor.prompts import resolve_yt_prompt
        prompt = resolve_yt_prompt(keyword_config.get('prompt_key'))

        db.mark_video_seen(vid, title=title, channel_id=channel_id, source='keyword_search')

        # Enqueue one row per target (or one with no target if none set)
        targets = telegram_targets if telegram_targets else [None]
        vid_enqueued = 0
        for tgt in targets:
            qid = db.enqueue_video(vid, telegram_target=tgt, prompt=prompt,
                                   source_keyword_id=keyword_config.get('id'))
            if qid:
                vid_enqueued += 1
        if vid_enqueued:
            enqueued += vid_enqueued
            logger.info(f"[YT-SEARCH] Enqueued: {vid} — {title} → {telegram_targets or 'no target'}")
        else:
            logger.info(f"[YT-SEARCH] Skipped duplicate: {vid} — {title}")

    return enqueued


def run_keyword_search(keyword_config: dict, global_blocked_ids: set = None) -> int:
    """
    Execute a keyword search for one keyword config row (+ sub-keywords),
    searching all terms together. Used for manual / immediate runs.
    Returns number of new videos enqueued.
    """
    db = get_yt_db()
    youtube = _build_youtube_service()

    # Load global blocked channels if not passed in
    if global_blocked_ids is None:
        global_blocked_ids = db.get_blocked_channel_ids()

    # Collect all search terms: main keyword + sub-keywords
    main_keyword = keyword_config['keyword']
    sub_keywords = keyword_config.get('sub_keywords') or []
    all_keywords = [main_keyword] + [sk for sk in sub_keywords if sk]

    published_after, published_before = _date_window_bounds(keyword_config)

    # Search each term, collecting + deduping results across terms
    all_video_ids = []  # preserve order, dedup later
    snippets = {}
    for search_term in all_keywords:
        vids, snips = _search_one_term(youtube, keyword_config, search_term,
                                       published_after, published_before)
        for vid in vids:
            if vid not in snippets:
                all_video_ids.append(vid)
                snippets[vid] = snips[vid]

    if not all_video_ids:
        logger.info(f"[YT-SEARCH] No results for '{main_keyword}' (+ {len(sub_keywords)} sub-keywords)")
        # Still record that these words ran so the per-word scheduler waits a
        # full interval before retrying them.
        if keyword_config.get('id'):
            for term in all_keywords:
                db.update_word_last_run(keyword_config['id'], term)
        return 0

    enqueued = _enqueue_videos(youtube, keyword_config, all_video_ids, snippets, global_blocked_ids)

    # Mark every searched word as just-run so the per-word hourly scheduler
    # doesn't immediately re-search them after a manual run.
    if keyword_config.get('id'):
        for term in all_keywords:
            db.update_word_last_run(keyword_config['id'], term)

    sub_info = f" (+ {len(sub_keywords)} sub-keywords)" if sub_keywords else ""
    logger.info(f"[YT-SEARCH] Keyword '{main_keyword}'{sub_info}: {len(all_video_ids)} found, {enqueued} enqueued")
    return enqueued


def run_single_word_search(keyword_config: dict, search_term: str,
                           global_blocked_ids: set = None) -> int:
    """
    Search ONE individual word (the main keyword or a single sub-keyword) and
    enqueue matches. Used by the per-word hourly scheduler so search.list calls
    are spread across the hour instead of bursting all of a keyword's terms.
    Returns number of new videos enqueued.
    """
    db = get_yt_db()
    youtube = _build_youtube_service()

    if global_blocked_ids is None:
        global_blocked_ids = db.get_blocked_channel_ids()

    published_after, published_before = _date_window_bounds(keyword_config)
    video_ids, snippets = _search_one_term(youtube, keyword_config, search_term,
                                           published_after, published_before)
    enqueued = _enqueue_videos(youtube, keyword_config, video_ids, snippets, global_blocked_ids)
    logger.info(f"[YT-SEARCH] Word '{search_term}' (kw#{keyword_config.get('id')}): "
                f"{len(video_ids)} found, {enqueued} enqueued")
    return enqueued


def _passes_filters(detail: dict, config: dict, snippet: dict = None, global_blocked_ids: set = None) -> bool:
    """Apply all filtering rules. Returns True if video passes."""
    content = detail.get('contentDetails', {})
    stats = detail.get('statistics', {})
    snip = detail.get('snippet', {}) or snippet or {}
    title = snip.get('title', '')
    channel_id = snip.get('channelId', '')

    # 0. Global blocked channels
    if global_blocked_ids and channel_id in global_blocked_ids:
        return False

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
    global_blocked = db.get_blocked_channel_ids()
    total = 0
    for kw_cfg in keywords:
        try:
            count = run_keyword_search(kw_cfg, global_blocked)
            db.update_keyword_last_run(kw_cfg['id'])
            total += count
        except Exception as e:
            logger.error(f"[YT-SEARCH] Failed for keyword '{kw_cfg.get('keyword')}': {e}")
    logger.info(f"[YT-SEARCH] Daily run complete: {total} total videos enqueued")
    return total


def run_due_keyword_searches() -> int:
    """Run searches only for keywords whose schedule interval has elapsed."""
    from utils.database import get_db
    if not get_db().get_system_enabled():
        logger.debug("[YT-SEARCH] System disabled — skipping keyword searches")
        return 0
    db = get_yt_db()
    due_keywords = db.get_due_keywords()
    if not due_keywords:
        return 0
    global_blocked = db.get_blocked_channel_ids()
    total = 0
    for kw_cfg in due_keywords:
        try:
            count = run_keyword_search(kw_cfg, global_blocked)
            db.update_keyword_last_run(kw_cfg['id'])
            total += count
            logger.info(f"[YT-SEARCH] Scheduled run for '{kw_cfg['keyword']}': {count} enqueued")
        except Exception as e:
            logger.error(f"[YT-SEARCH] Scheduled run failed for '{kw_cfg.get('keyword')}': {e}")
    return total


# ── Quota-aware rotation ────────────────────────────────────────────────────
# One word search costs ~101 units (100 search.list + ~1 videos.list details).
WORD_SEARCH_COST = 101
# Hold back part of the daily quota for the worker (1 unit/video) and video chat.
QUOTA_RESERVE_FRAC = 0.05
QUOTA_RESERVE_MIN = 300
# Cap a stretched interval so the math stays sane (a word never waits > 7 days).
MAX_EFFECTIVE_INTERVAL_MIN = 7 * 24 * 60


def _usable_budget_units():
    """(usable_units, limit_units, reserve_units) for keyword searches today."""
    limit = get_quota_limit()
    reserve = max(QUOTA_RESERVE_MIN, int(limit * QUOTA_RESERVE_FRAC))
    return max(0, limit - reserve), limit, reserve


def _priority_weight(priority) -> float:
    """Higher priority (lower number) → much larger share of the budget."""
    p = priority if priority else 3
    p = min(5, max(1, int(p)))
    return float(2 ** (5 - p))   # P1=16, P2=8, P3=4, P4=2, P5=1


def _compute_word_plan(words: list, budget_searches: int) -> dict:
    """Map each (keyword_id, word) → its effective interval in minutes.

    If total demand fits the daily search budget everyone keeps their configured
    interval. Otherwise the budget is water-filled by priority weight (capped at
    what each word actually wants), so high-priority words stay on time and
    low-priority words get a longer effective interval — they rotate in and out
    rather than failing the quota."""
    items = []
    for w in words:
        interval = w.get('interval_min') or 60
        if interval < 1:
            interval = 60
        items.append({
            'key': (w['keyword_id'], w['word']),
            'desired': 1440.0 / interval,            # searches/day this word wants
            'weight': _priority_weight(w.get('priority')),
            'interval': interval,
        })
    plan = {}
    if budget_searches <= 0:
        return {i['key']: MAX_EFFECTIVE_INTERVAL_MIN for i in items}
    if sum(i['desired'] for i in items) <= budget_searches:
        return {i['key']: i['interval'] for i in items}   # everyone on time

    allowed = {}
    uncapped = list(items)
    remaining = float(budget_searches)
    for _ in range(12):
        wsum = sum(i['desired'] * i['weight'] for i in uncapped)
        if not uncapped or wsum <= 0 or remaining <= 1e-9:
            break
        newly_capped, rest = [], []
        for i in uncapped:
            share = remaining * (i['desired'] * i['weight']) / wsum
            if share >= i['desired']:        # wants less than its share → give what it wants
                allowed[i['key']] = i['desired']
                newly_capped.append(i)
            else:
                rest.append(i)
        if newly_capped:
            remaining -= sum(i['desired'] for i in newly_capped)
            uncapped = rest
        else:                                # nobody capped → split remainder by weight
            for i in uncapped:
                allowed[i['key']] = remaining * (i['desired'] * i['weight']) / wsum
            uncapped, remaining = [], 0.0
            break
    if uncapped:
        wsum = sum(i['desired'] * i['weight'] for i in uncapped) or 1.0
        for i in uncapped:
            allowed[i['key']] = remaining * (i['desired'] * i['weight']) / wsum

    for i in items:
        a = allowed.get(i['key'], 0.0)
        if a <= 0:
            plan[i['key']] = MAX_EFFECTIVE_INTERVAL_MIN
        else:
            plan[i['key']] = min(MAX_EFFECTIVE_INTERVAL_MIN, max(i['interval'], 1440.0 / a))
    return plan


def run_due_keyword_words(limit: int = 1) -> int:
    """Per-word scheduled search with quota-aware rotation. Each tick:
      1. Stop if today's quota budget is already spent (hard cap → searches
         never fail with quotaExceeded).
      2. Stretch low-priority words' effective interval so total demand fits the
         daily budget; high-priority words keep their configured interval.
      3. Run the most-overdue due word(s) — `limit` per tick — spread over time."""
    from utils.database import get_db
    if not get_db().get_system_enabled():
        logger.debug("[YT-SEARCH] System disabled — skipping keyword word searches")
        return 0
    db = get_yt_db()

    usable_units, _limit_units, _reserve = _usable_budget_units()
    used_today = (db.get_quota_today() or {}).get('units', 0) or 0
    if used_today + WORD_SEARCH_COST > usable_units:
        logger.info(f"[YT-SEARCH] Daily quota budget reached "
                    f"({used_today}/{usable_units} usable units) — pausing searches")
        return 0

    words = db.get_active_words()
    if not words:
        return 0

    budget_searches = int(usable_units // WORD_SEARCH_COST)
    plan = _compute_word_plan(words, budget_searches)

    # Most-overdue relative to its (possibly stretched) effective interval.
    due = []
    for w in words:
        eff = float(plan.get((w['keyword_id'], w['word']), w.get('interval_min') or 60))
        age = w.get('age_min')
        if age is None:
            ratio = float('inf')          # never run → maximally overdue
        else:
            age = float(age)
            if age < eff:
                continue                   # not due yet
            ratio = age / eff
        due.append((ratio, w))
    if not due:
        return 0
    due.sort(key=lambda x: x[0], reverse=True)

    global_blocked = db.get_blocked_channel_ids()
    total = 0
    for _ratio, w in due[:limit]:
        kw_cfg = db.get_keyword_by_id(w['keyword_id'])
        if not kw_cfg:
            continue
        try:
            count = run_single_word_search(kw_cfg, w['word'], global_blocked)
            db.update_word_last_run(w['keyword_id'], w['word'])
            db.update_keyword_last_run(w['keyword_id'])
            total += count
            logger.info(f"[YT-SEARCH] Scheduled word run '{w['word']}' "
                        f"(kw#{w['keyword_id']}): {count} enqueued")
        except Exception as e:
            logger.error(f"[YT-SEARCH] Scheduled word run failed for '{w.get('word')}': {e}")
    return total


def compute_capacity_plan() -> dict:
    """Quota demand vs daily budget + per-keyword rotation plan, for the SEO
    page. Aggregates the per-word allocation back up to keywords."""
    db = get_yt_db()
    if db is None:
        return {'status': 'error', 'message': 'YouTube DB not initialized'}

    usable_units, limit_units, reserve = _usable_budget_units()
    budget_searches = int(usable_units // WORD_SEARCH_COST)
    words = db.get_active_words()
    plan = _compute_word_plan(words, budget_searches)
    yields = db.get_keyword_yield(days=7)
    name_by_id = {kw['id']: kw.get('keyword') for kw in db.get_keywords(active_only=True)}

    per_kw = {}
    total_demand_searches = 0.0
    for w in words:
        interval = w.get('interval_min') or 60
        if interval < 1:
            interval = 60
        eff = plan.get((w['keyword_id'], w['word']), interval)
        total_demand_searches += 1440.0 / interval
        e = per_kw.setdefault(w['keyword_id'], {
            'keyword_id': w['keyword_id'], 'word_count': 0,
            'configured_interval_min': interval, 'priority': w.get('priority') or 3,
            'effective_interval_min': eff,
        })
        e['word_count'] += 1
        e['effective_interval_min'] = eff   # all words of a keyword share this

    keywords_out = []
    for kid, e in per_kw.items():
        conf, eff = e['configured_interval_min'], e['effective_interval_min']
        y = yields.get(kid, {})
        keywords_out.append({
            **e,
            'keyword': name_by_id.get(kid, f'#{kid}'),
            'status': 'rotated' if eff > conf * 1.05 else 'on-time',
            'demand_units_day': round(e['word_count'] * (1440.0 / conf) * WORD_SEARCH_COST),
            'yield_per_search': round(y.get('yield', 0.0), 2),
            'searches_7d': y.get('searches', 0),
            'found_7d': y.get('found', 0),
        })
    keywords_out.sort(key=lambda k: (k['priority'], -k['demand_units_day']))

    total_demand_units = round(total_demand_searches * WORD_SEARCH_COST)
    return {
        'status': 'ok',
        'limit_units': limit_units,
        'usable_units': usable_units,
        'reserve_units': reserve,
        'used_today': (db.get_quota_today() or {}).get('units', 0) or 0,
        'total_demand_units': total_demand_units,
        'over_budget': total_demand_units > usable_units,
        'word_search_cost': WORD_SEARCH_COST,
        'total_words': len(words),
        'keywords': keywords_out,
    }


def compute_search_forecast() -> dict:
    """Per-word upcoming-search forecast for the YouTube Schedules 'Forecast'
    tab, plus channel monitoring status.

    SEO searches are interval-driven: each word's *effective* interval already
    accounts for quota pressure (the same budget-aware water-fill the scheduler
    uses), so `next_run_in_min = max(0, effective_interval - age)` is a faithful
    estimate the frontend can project across the next 24h and tick down live.

    Channels are push-based (WebSub) — there is no poll interval to forecast —
    so they are returned as status (last video, videos today, subscription
    expiry), not as scheduled searches."""
    db = get_yt_db()
    if db is None:
        return {'status': 'error', 'message': 'YouTube DB not initialized'}

    usable_units, limit_units, reserve = _usable_budget_units()
    budget_searches = int(usable_units // WORD_SEARCH_COST)
    words = db.get_active_words()
    plan = _compute_word_plan(words, budget_searches)
    name_by_id = {kw['id']: kw.get('keyword') for kw in db.get_keywords(active_only=True)}
    used_today = (db.get_quota_today() or {}).get('units', 0) or 0
    paused = used_today + WORD_SEARCH_COST > usable_units

    seo_words = []
    total_demand_searches = 0.0
    for w in words:
        interval = w.get('interval_min') or 60
        if interval < 1:
            interval = 60
        total_demand_searches += 1440.0 / interval
        eff = float(plan.get((w['keyword_id'], w['word']), interval))
        age = w.get('age_min')
        next_in = 0.0 if age is None else max(0.0, eff - float(age))
        kw_name = name_by_id.get(w['keyword_id'], f"#{w['keyword_id']}")
        seo_words.append({
            'keyword_id': w['keyword_id'],
            'keyword': kw_name,
            'word': w['word'],
            'is_sub': w['word'] != kw_name,
            'priority': w.get('priority') or 3,
            'configured_interval_min': interval,
            'effective_interval_min': round(eff, 1),
            'next_run_in_min': round(next_in, 2),
            'cost_units': WORD_SEARCH_COST,
        })
    seo_words.sort(key=lambda x: x['next_run_in_min'])

    activity = db.get_channel_activity()
    channels = []
    for ch in db.get_channels(active_only=False):
        act = activity.get(ch['channel_id'], {})
        channels.append({
            'channel_id': ch['channel_id'],
            'channel_name': ch.get('channel_name') or ch['channel_id'],
            'active': ch.get('active', True),
            'websub_expires_at': ch.get('websub_expires_at'),
            'last_video_at': act.get('last_video_at'),
            'videos_today': act.get('videos_today', 0),
        })
    channels.sort(key=lambda c: (not c['active'], -c['videos_today']))

    total_demand_units = round(total_demand_searches * WORD_SEARCH_COST)
    return {
        'status': 'ok',
        'seo_words': seo_words,
        'channels': channels,
        'budget': {
            'limit_units': limit_units,
            'usable_units': usable_units,
            'reserve_units': reserve,
            'used_today': used_today,
            'total_demand_units': total_demand_units,
            'over_budget': total_demand_units > usable_units,
            'paused': paused,
            'word_search_cost': WORD_SEARCH_COST,
        },
    }


def compute_schedule_summary() -> dict:
    """Per-keyword sent/remaining-today rollup + channel summary, for the
    YouTube Schedules 'Summary' tab. Builds on compute_capacity_plan() and
    adds today's actual search count vs. the budget-aware expected count."""
    plan = compute_capacity_plan()
    if plan.get('status') != 'ok':
        return plan
    db = get_yt_db()
    searches_today = db.get_keyword_searches_today()

    for k in plan['keywords']:
        eff = k.get('effective_interval_min') or k.get('configured_interval_min') or 60
        wc = k.get('word_count', 1)
        expected = round(wc * (1440.0 / eff)) if eff else 0
        done = searches_today.get(k['keyword_id'], 0)
        k['searches_today'] = done
        k['expected_today'] = expected
        k['remaining_today'] = max(0, expected - done)

    activity = db.get_channel_activity()
    channels = []
    for ch in db.get_channels(active_only=False):
        act = activity.get(ch['channel_id'], {})
        channels.append({
            'channel_id': ch['channel_id'],
            'channel_name': ch.get('channel_name') or ch['channel_id'],
            'active': ch.get('active', True),
            'videos_today': act.get('videos_today', 0),
            'last_video_at': act.get('last_video_at'),
            'websub_expires_at': ch.get('websub_expires_at'),
        })
    channels.sort(key=lambda c: (not c['active'], -c['videos_today']))
    plan['channels'] = channels
    return plan
