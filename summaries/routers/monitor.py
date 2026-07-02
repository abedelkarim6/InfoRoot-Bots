import logging
from fastapi import APIRouter, Query
from fastapi import Body
from starlette.requests import Request
from utils.database import get_db
from utils.helpers import compute_window_start
from routers.auth import is_admin_request, get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_allowed_bots(request: Request):
    """Returns None for admin (no filter), or list of bot names for regular users."""
    if is_admin_request(request):
        return None
    user_id = get_request_user_id(request)
    if not user_id:
        return ["__no_access__"]
    cfg = get_db().get_filtered_bots_config(user_id)
    return list(cfg.keys()) or ["__no_access__"]


def _build_schedule_windows(bots_cfg: dict) -> dict:
    """Build a dict of (bot_name, topic_name, schedule_type) -> window_start datetime
    using compute_window_start for each configured schedule. When multiple schedules of
    the same type exist on one topic, the earliest (furthest-back) window is kept so
    that pending messages covered by either schedule are counted."""
    windows = {}
    for bot_name, bot_data in bots_cfg.items():
        for cat_data in bot_data.get('categories', {}).values():
            for topic_name, topic_data in cat_data.get('topics', {}).items():
                for sch in topic_data.get('schedules', []):
                    stype = sch.get('type')
                    if not stype:
                        continue
                    job_data = {
                        'schedule_type':    stype,
                        'sch_minute':       sch.get('minute'),
                        'sch_hour':         sch.get('hour'),
                        'sch_hours':        sch.get('hours'),
                        'sch_minutes':      sch.get('minutes'),
                        'sch_start_hour':   sch.get('start_hour', 0),
                        'sch_start_minute': sch.get('start_minute', 0),
                        'sch_end_hour':     sch.get('end_hour'),
                        'sch_end_minute':   sch.get('end_minute'),
                    }
                    win = compute_window_start(job_data)
                    key = (bot_name, topic_name, stype)
                    if key not in windows or win < windows[key]:
                        windows[key] = win
    return windows


@router.get("/monitor/data")
def get_monitor_data(request: Request):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        recent_summaries = db.get_recent_summaries(limit=100, allowed_bot_names=allowed_bots)

        if allowed_bots is None:
            bots_cfg = db.get_all_bots_config()
        else:
            user_id = get_request_user_id(request)
            bots_cfg = db.get_filtered_bots_config(user_id) if user_id else {}

        windows = _build_schedule_windows(bots_cfg)
        pending_counts = db.get_pending_counts(allowed_bot_names=allowed_bots, windows=windows)

        bots_data = {}
        for bot_name, bot in bots_cfg.items():
            bot_pending = pending_counts.get(bot_name, {})
            categories_data = {}

            for cat_name, cat in bot.get('categories', {}).items():
                topics_data = {}
                for topic_name, topic in cat.get('topics', {}).items():
                    topics_data[topic_name] = {
                        'enabled': topic.get('enabled', True),
                        'pending': bot_pending.get(topic_name, {'hourly': 0, 'daily': 0, 'minute': 0, 'interval_hourly': 0, 'interval_minutes': 0}),
                        'schedules': topic.get('schedules', [])
                    }
                categories_data[cat_name] = {
                    'enabled': cat.get('enabled', True),
                    'topics': topics_data
                }

            bots_data[bot_name] = {
                'enabled': bot.get('enabled', True),
                'collections': bot.get('collections', []),
                'categories': categories_data
            }

        return {
            'status': 'ok',
            'bots': bots_data,
            'recent_summaries': recent_summaries
        }
    except Exception as e:
        logger.exception("[MONITOR] get_monitor_data failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/summary-messages")
def get_summary_messages(request: Request, id: int = Query(...)):
    db = get_db()
    try:
        cursor = db._get_cursor()
        # Verify user has access to the bot that generated this summary
        allowed_bots = _get_allowed_bots(request)
        if allowed_bots is not None:
            cursor.execute("SELECT message_ids, bot_name FROM summaries WHERE id = %s", (id,))
            row = cursor.fetchone()
            if not row:
                return {'status': 'ok', 'messages': []}
            if row['bot_name'] not in allowed_bots:
                return {'status': 'error', 'message': 'Access denied'}, 403
        else:
            cursor.execute("SELECT message_ids FROM summaries WHERE id = %s", (id,))
            row = cursor.fetchone()
            if not row:
                return {'status': 'ok', 'messages': []}

        if not row['message_ids']:
            return {'status': 'ok', 'messages': []}
        ids = [int(x) for x in row['message_ids'].split(',') if x.strip()]
        messages = db.get_messages_by_ids(ids)
        return {'status': 'ok', 'messages': messages}
    except Exception as e:
        logger.exception("[MONITOR] get_summary_messages failed")
        return {'status': 'error', 'message': str(e)}
    finally:
        db._commit()


def _load_summary_composition(db, summary_id: int, allowed_bots):
    """Build the interim/remaining breakdown plus the final summary text for one
    summary. Shared by the single and batch composition endpoints.

    Raises PermissionError when the summary's bot is outside the caller's
    allowed set. Returns a dict with `interims`, `remaining_messages` and
    `summary_text` (the final generated output).
    """
    cursor = db._get_cursor()
    cursor.execute(
        "SELECT message_ids, bot_name, topic_name, schedule_id, summary_text "
        "FROM summaries WHERE id = %s",
        (summary_id,),
    )
    row = cursor.fetchone()
    if not row:
        return {'interims': [], 'remaining_messages': [], 'summary_text': ''}
    if allowed_bots is not None and row['bot_name'] not in allowed_bots:
        raise PermissionError('Access denied')

    summary_text = row.get('summary_text') or ''
    if not row['message_ids']:
        return {'interims': [], 'remaining_messages': [], 'summary_text': summary_text}

    ids = [int(x) for x in row['message_ids'].split(',') if x.strip()]
    interim_id_map = db.get_interim_ids_for_messages(
        ids, bot_name=row['bot_name'], topic_name=row['topic_name'],
        schedule_id=row['schedule_id'])

    seen: set = set()
    ordered_interim_ids: list = []
    for mid in ids:
        if mid in interim_id_map:
            iid = interim_id_map[mid]
            if iid not in seen:
                seen.add(iid)
                ordered_interim_ids.append(iid)

    interims = db.get_interims_by_ids(ordered_interim_ids)
    for interim in interims:
        interim['messages'] = db.get_interim_messages(interim['id'])

    remaining_ids = [mid for mid in ids if mid not in interim_id_map]
    remaining_messages = db.get_messages_by_ids(remaining_ids) if remaining_ids else []

    return {
        'interims': interims,
        'remaining_messages': remaining_messages,
        'summary_text': summary_text,
    }


@router.get("/monitor/summary-composition")
def get_summary_composition(request: Request, id: int = Query(...)):
    """Return the interims, remaining messages and final summary text that make
    up a summary."""
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        comp = _load_summary_composition(db, id, allowed_bots)
        return {'status': 'ok', **comp}
    except PermissionError:
        return {'status': 'error', 'message': 'Access denied'}, 403
    except Exception as e:
        logger.exception("[MONITOR] get_summary_composition failed")
        return {'status': 'error', 'message': str(e)}
    finally:
        db._commit()


@router.get("/monitor/summary-composition-batch")
def get_summary_composition_batch(request: Request, ids: str = Query(...)):
    """Return the composition (interims + remaining + final summary) for many
    summaries at once, keyed by summary id. Powers the History tab's
    "export with interims" so it doesn't have to call the single endpoint per
    run. Summaries outside the caller's allowed bots are silently omitted."""
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        id_list: list = []
        for x in ids.split(','):
            x = x.strip()
            if not x:
                continue
            try:
                id_list.append(int(x))
            except ValueError:
                continue
        # Cap to keep a single export request bounded.
        id_list = id_list[:300]

        compositions: dict = {}
        for sid in id_list:
            try:
                compositions[str(sid)] = _load_summary_composition(db, sid, allowed_bots)
            except PermissionError:
                continue
        return {'status': 'ok', 'compositions': compositions}
    except Exception as e:
        logger.exception("[MONITOR] get_summary_composition_batch failed")
        return {'status': 'error', 'message': str(e)}
    finally:
        db._commit()


@router.get("/monitor/messages")
def get_monitor_messages(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    search: str = Query(default=None),
    bots: str = Query(default=None),       # comma-separated bot names
    channels: str = Query(default=None),   # comma-separated channel usernames (with or without @)
    topics: str = Query(default=None),     # comma-separated topic names
    date_from: str = Query(default=None),  # YYYY-MM-DD inclusive
    date_to: str = Query(default=None),    # YYYY-MM-DD inclusive
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        bots_list = [b.strip() for b in bots.split(',') if b.strip()] if bots else None
        channels_list = [c.strip().lstrip('@') for c in channels.split(',') if c.strip()] if channels else None
        topics_list = [t.strip() for t in topics.split(',') if t.strip()] if topics else None
        messages = db.get_recent_messages(
            limit=limit, offset=offset, allowed_bot_names=allowed_bots, search=search,
            bots=bots_list, channels=channels_list, topics=topics_list,
            date_from=date_from or None, date_to=date_to or None)

        id_to_username = {}
        for msg in messages:
            if msg.get('channel_username') and msg.get('channel_id'):
                id_to_username[msg['channel_id']] = msg['channel_username']
        for msg in messages:
            if not msg.get('channel_username') and msg.get('channel_id'):
                msg['channel_username'] = id_to_username.get(msg['channel_id'])

        collections_cfg = db.get_all_collections()
        channel_to_collection = {}
        for coll_name, coll_data in collections_cfg.items():
            for ch in coll_data.get('source_channels', []):
                username = ch.lstrip('@').lower()
                channel_to_collection[username] = coll_name

        for msg in messages:
            if msg.get('collection_name'):
                msg['collection'] = msg['collection_name']
            else:
                username = (msg.get('channel_username') or '').lower().lstrip('@')
                msg['collection'] = channel_to_collection.get(username, '—')

        return {'status': 'ok', 'messages': messages}
    except Exception as e:
        logger.exception("[MONITOR] get_monitor_messages failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/messages/facets")
def get_monitor_messages_facets(request: Request):
    """Distinct bot / channel / topic values for the Messages-tab filter dropdowns.
    Computed independently of the active filter so the dropdowns list the full
    universe of options rather than only what's on the currently loaded page."""
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        facets = db.get_message_filter_facets(allowed_bot_names=allowed_bots)
        return {'status': 'ok', **facets}
    except Exception as e:
        logger.exception("[MONITOR] get_monitor_messages_facets failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/unclassified")
def get_unclassified_messages(
    request: Request,
    bot: str = Query(default=None),
    collection: str = Query(default=None),
    search: str = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    since: str = Query(default=None),
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        messages = db.get_unclassified_messages(
            limit=limit, offset=offset, bot_name=bot, collection=collection,
            search=search, allowed_bot_names=allowed_bots)
        stats = db.get_unclassified_stats(allowed_bot_names=allowed_bots, since=since)
        return {'status': 'ok', 'messages': messages, 'stats': stats}
    except Exception as e:
        logger.exception("[MONITOR] get_unclassified_messages failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/missed")
def get_missed_messages(
    request: Request,
    bot: str = Query(default=None),
    topic: str = Query(default=None),
    search: str = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    since: str = Query(default=None),
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        messages = db.get_missed_messages(
            limit=limit, offset=offset, bot_name=bot, topic_name=topic,
            search=search, allowed_bot_names=allowed_bots)
        stats = db.get_missed_stats(allowed_bot_names=allowed_bots, since=since)
        return {'status': 'ok', 'messages': messages, 'stats': stats}
    except Exception as e:
        logger.exception("[MONITOR] get_missed_messages failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/schedule-stats")
def get_schedule_stats(request: Request):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        stats = db.get_today_schedule_stats(allowed_bot_names=allowed_bots)
        return {'status': 'ok', 'stats': stats}
    except Exception as e:
        logger.exception("[MONITOR] get_schedule_stats failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/pending-messages")
def get_pending_messages(
    request: Request,
    bot: str = Query(...),
    topic: str = Query(...),
    schedule_type: str = Query(...),
    sch_minute: str = Query(default=None),
    sch_hour: str = Query(default=None),
    sch_hours: str = Query(default=None),
    sch_minutes: str = Query(default=None),
    sch_start_hour: str = Query(default=None),
    sch_start_minute: str = Query(default=None),
    sch_end_hour: str = Query(default=None),
    sch_end_minute: str = Query(default=None),
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        if allowed_bots is not None and bot not in allowed_bots:
            return {'status': 'error', 'message': 'Access denied'}
        job_data = {
            'schedule_type':    schedule_type,
            'sch_minute':       sch_minute,
            'sch_hour':         sch_hour,
            'sch_hours':        sch_hours,
            'sch_minutes':      sch_minutes,
            'sch_start_hour':   sch_start_hour or 0,
            'sch_start_minute': sch_start_minute or 0,
            'sch_end_hour':     sch_end_hour,
            'sch_end_minute':   sch_end_minute,
        }
        after_dt = compute_window_start(job_data)
        messages = db.get_messages_for_schedule_window(bot, topic, schedule_type, after_dt=after_dt)
        result = []
        for m in messages:
            result.append({
                'id': m['id'],
                'timestamp': m['timestamp'].isoformat() if m.get('timestamp') else None,
                'channel_username': m.get('channel_username'),
                'collection_name': m.get('collection_name'),
                'preview': (m.get('text') or '')[:300],
            })
        return {'status': 'ok', 'messages': result}
    except Exception as e:
        logger.exception("[MONITOR] get_pending_messages failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/prompt-preview")
def get_prompt_preview(
    request: Request,
    bot_name: str = Query(...),
    prompt_key: str = Query(...),
):
    from summaries.prompts import get_system_prompt, get_fixed_prefix
    db = get_db()
    try:
        prompts = db.get_bot_prompts(bot_name)
        user_prompt = prompts.get(prompt_key, {}).get('text', '') if prompts else ''
        return {
            'status': 'ok',
            'prompt_name': prompt_key,
            'user_prompt': user_prompt,
            'system_prompt': get_system_prompt(),
            'fixed_prefix': get_fixed_prefix(),
        }
    except Exception as e:
        logger.exception("[MONITOR] get_prompt_preview failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/schedule-history")
def get_schedule_history(
    request: Request,
    bot: str = Query(default=None),
    topic: str = Query(default=None),
    status: str = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        runs = db.get_schedule_history(
            limit=limit, bot_name=bot, topic_name=topic,
            status=status, allowed_bot_names=allowed_bots, offset=offset
        )
        return {'status': 'ok', 'runs': runs}
    except Exception as e:
        logger.exception("[MONITOR] get_schedule_history failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/interims")
def get_interims(
    request: Request,
    bot: str = Query(default=None),
    topic: str = Query(default=None),
    status: str = Query(default=None),
    limit: int = Query(default=300, ge=1, le=1000),
):
    if not is_admin_request(request):
        from starlette.responses import JSONResponse
        return JSONResponse({'status': 'error', 'message': 'Access denied'}, status_code=403)
    db = get_db()
    try:
        rows = db.get_interims(bot_name=bot, topic_name=topic, limit=limit)
        if status == 'pending':
            rows = [r for r in rows if r['status'] == 'pending']
        elif status == 'done':
            rows = [r for r in rows if r['status'] == 'done']
        return {'status': 'ok', 'interims': rows}
    except Exception as e:
        logger.exception("[MONITOR] get_interims failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/interim-messages")
def get_interim_messages(request: Request, id: int = Query(...)):
    if not is_admin_request(request):
        from starlette.responses import JSONResponse
        return JSONResponse({'status': 'error', 'message': 'Access denied'}, status_code=403)
    db = get_db()
    try:
        messages = db.get_interim_messages(id)
        return {'status': 'ok', 'messages': messages}
    except Exception as e:
        logger.exception("[MONITOR] get_interim_messages failed")
        return {'status': 'error', 'message': str(e)}


@router.get("/dashboard/stats")
def get_dashboard_stats(
    request: Request,
    days: int = Query(default=14, ge=1, le=365),
    filter_source: str = Query(default=None),
    filter_topic: str = Query(default=None),
    filter_channels: str = Query(default=None),  # comma-separated channel usernames
):
    db = get_db()
    try:
        allowed_bots = None
        if not is_admin_request(request):
            user_id = get_request_user_id(request)
            if user_id:
                cfg = db.get_filtered_bots_config(user_id)
                allowed_bots = list(cfg.keys()) or ["__no_access__"]
            else:
                allowed_bots = ["__no_access__"]
        channels_list = [c.strip() for c in filter_channels.split(',') if c.strip()] if filter_channels else None
        sources_list  = [s.strip() for s in filter_source.split(',')   if s.strip()] if filter_source  else None
        topics_list   = [t.strip() for t in filter_topic.split(',')    if t.strip()] if filter_topic   else None
        data = db.get_dashboard_stats(
            days,
            filter_sources=sources_list,
            filter_topics=topics_list,
            filter_bot_names=allowed_bots,
            filter_channels=channels_list,
        )
        return {'status': 'ok', **data}
    except Exception as e:
        logger.exception("[MONITOR] get_dashboard_stats failed")
        return {'status': 'error', 'message': str(e)}
