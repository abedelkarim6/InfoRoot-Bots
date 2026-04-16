from fastapi import APIRouter, Query
from fastapi import Body
from starlette.requests import Request
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

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


@router.get("/monitor/data")
def get_monitor_data(request: Request):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        pending_counts = db.get_pending_counts(allowed_bot_names=allowed_bots)
        recent_summaries = db.get_recent_summaries(limit=100, allowed_bot_names=allowed_bots)

        if allowed_bots is None:
            bots_cfg = db.get_all_bots_config()
        else:
            user_id = get_request_user_id(request)
            bots_cfg = db.get_filtered_bots_config(user_id) if user_id else {}

        bots_data = {}
        for bot_name, bot in bots_cfg.items():
            bot_pending = pending_counts.get(bot_name, {})
            categories_data = {}

            for cat_name, cat in bot.get('categories', {}).items():
                topics_data = {}
                for topic_name, topic in cat.get('topics', {}).items():
                    topics_data[topic_name] = {
                        'enabled': topic.get('enabled', True),
                        'pending': bot_pending.get(topic_name, {'hourly': 0, 'daily': 0, 'minute': 0, 'interval': 0, 'interval_minutes': 0}),
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
        return {'status': 'error', 'message': str(e)}
    finally:
        db._commit()


@router.get("/monitor/messages")
def get_monitor_messages(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        if offset == 0:
            db.cleanup_uncollected_messages()
        messages = db.get_recent_messages(limit=limit, offset=offset, allowed_bot_names=allowed_bots)

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
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/schedule-history")
def get_schedule_history(
    request: Request,
    bot: str = Query(default=None),
    topic: str = Query(default=None),
    status: str = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
):
    db = get_db()
    try:
        allowed_bots = _get_allowed_bots(request)
        runs = db.get_schedule_history(
            limit=limit, bot_name=bot, topic_name=topic,
            status=status, allowed_bot_names=allowed_bots
        )
        return {'status': 'ok', 'runs': runs}
    except Exception as e:
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
        data = db.get_dashboard_stats(
            days,
            filter_source=filter_source,
            filter_topic=filter_topic,
            filter_bot_names=allowed_bots,
            filter_channels=channels_list,
        )
        return {'status': 'ok', **data}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}
