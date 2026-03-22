from fastapi import APIRouter, Query
from utils.database import get_db

router = APIRouter()


@router.get("/monitor/data")
def get_monitor_data():
    db = get_db()
    try:
        pending_counts = db.get_pending_counts()
        recent_summaries = db.get_recent_summaries(limit=100)

        bots_cfg = db.get_all_bots_config()

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


@router.get("/monitor/summary-messages")
def get_summary_messages(id: int = Query(...)):
    db = get_db()
    try:
        cursor = db._get_cursor()
        cursor.execute("SELECT message_ids FROM summaries WHERE id = %s", (id,))
        row = cursor.fetchone()
        if not row or not row['message_ids']:
            return {'status': 'ok', 'messages': []}
        ids = [int(x) for x in row['message_ids'].split(',') if x.strip()]
        messages = db.get_messages_by_ids(ids)
        return {'status': 'ok', 'messages': messages}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


@router.get("/monitor/messages")
def get_monitor_messages(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    db = get_db()
    try:
        if offset == 0:
            db.cleanup_uncollected_messages()
        messages = db.get_recent_messages(limit=limit, offset=offset)

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
    bot: str = Query(default=None),
    collection: str = Query(default=None),
    search: str = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    db = get_db()
    try:
        messages = db.get_unclassified_messages(
            limit=limit, offset=offset, bot_name=bot, collection=collection, search=search)
        stats = db.get_unclassified_stats()
        return {'status': 'ok', 'messages': messages, 'stats': stats}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


@router.get("/dashboard/stats")
def get_dashboard_stats(
    days: int = Query(default=14, ge=1, le=365),
    filter_source: str = Query(default=None),
    filter_topic: str = Query(default=None),
):
    db = get_db()
    try:
        data = db.get_dashboard_stats(days, filter_source=filter_source, filter_topic=filter_topic)
        return {'status': 'ok', **data}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}
