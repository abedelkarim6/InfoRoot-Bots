from fastapi import APIRouter, Query
from utils.helpers import load_config
from utils.database import Database

router = APIRouter()


def _get_db():
    cfg = load_config()
    return Database(cfg["database"]["dsn"])


@router.get("/monitor/data")
def get_monitor_data():
    """
    Returns all data needed by the Monitor page:
    - Per-bot, per-topic pending message counts (hourly / daily / minute)
    - Schedule definitions so the frontend can compute next-run countdowns
    - 100 most recent summaries sent
    """
    cfg = load_config()
    db = _get_db()
    try:
        pending_counts = db.get_pending_counts()   # {bot -> topic -> {hourly,daily,minute}}
        recent_summaries = db.get_recent_summaries(limit=100)

        bots_cfg = cfg.get('bots', {})

        bots_data = {}
        for bot_name, bot in bots_cfg.items():
            bot_pending = pending_counts.get(bot_name, {})
            categories_data = {}

            for cat_name, cat in bot.get('categories', {}).items():
                topics_data = {}
                for topic_name, topic in cat.get('topics', {}).items():
                    topics_data[topic_name] = {
                        'enabled': topic.get('enabled', True),
                        'pending': bot_pending.get(topic_name, {'hourly': 0, 'daily': 0, 'minute': 0}),
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
    finally:
        db.close()


@router.get("/monitor/messages")
def get_monitor_messages():
    """
    Returns recent messages grouped by collection → channel_username.
    Adds a 'collection' field to each message based on config lookup.
    """
    cfg = load_config()
    db = _get_db()
    try:
        db.cleanup_uncollected_messages()
        messages = db.get_recent_messages(limit=200)

        # Build channel_id → username from messages that already have a username (fills gaps for old rows)
        id_to_username = {}
        for msg in messages:
            if msg.get('channel_username') and msg.get('channel_id'):
                id_to_username[msg['channel_id']] = msg['channel_username']
        for msg in messages:
            if not msg.get('channel_username') and msg.get('channel_id'):
                msg['channel_username'] = id_to_username.get(msg['channel_id'])

        # Build username → collection name map
        channel_to_collection = {}
        for coll_name, coll_data in cfg.get('collections', {}).items():
            for ch in coll_data.get('source_channels', []):
                username = ch.lstrip('@').lower()
                channel_to_collection[username] = coll_name

        for msg in messages:
            # Prefer the stored collection_name (set since v2); fall back to config lookup for old rows
            if msg.get('collection_name'):
                msg['collection'] = msg['collection_name']
            else:
                username = (msg.get('channel_username') or '').lower().lstrip('@')
                msg['collection'] = channel_to_collection.get(username, '—')

        return {'status': 'ok', 'messages': messages}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}
    finally:
        db.close()


@router.get("/dashboard/stats")
def get_dashboard_stats(
    days: int = Query(default=14, ge=1, le=365),
    filter_source: str = Query(default=None),
    filter_topic: str = Query(default=None),
):
    """Return all analytics data needed by the Dashboard page."""
    db = _get_db()
    try:
        data = db.get_dashboard_stats(days, filter_source=filter_source, filter_topic=filter_topic)
        return {'status': 'ok', **data}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}
    finally:
        db.close()
