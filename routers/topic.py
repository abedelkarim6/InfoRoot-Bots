from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

router = APIRouter()


def _can_modify_bot(request: Request, bot_name: str) -> bool:
    if is_admin_request(request):
        return True
    user_id = get_request_user_id(request)
    if not user_id:
        return False
    return get_db().get_bot_owner_id(bot_name) == user_id


# ==================== Category Operations ====================

@router.post("/category/add")
def add_category(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = (data.get('category_name') or '').strip()

    if not bot_name or not category_name:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    if db.add_category(bot_name, category_name):
        return {"status": "ok", "category_name": category_name}
    return {"status": "error", "message": "Category already exists or bot not found"}

@router.post("/category/delete")
def delete_category(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')

    if not bot_name or not category_name:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    all_bots = db.get_all_bots_config()
    bot = all_bots.get(bot_name, {})
    cat_data = bot.get('categories', {}).get(category_name)
    if cat_data:
        db.recycle_bin_add('category', f"{bot_name}/{category_name}",
                           {'bot_name': bot_name, 'category_name': category_name, **cat_data},
                           owner_id=get_request_user_id(request))

    if db.delete_category(bot_name, category_name):
        return {"status": "ok"}
    return {"status": "error", "message": "Category not found"}

@router.post("/category/toggle")
def toggle_category(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    enabled = data.get('enabled')

    if not bot_name or not category_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    if db.toggle_category(bot_name, category_name, enabled):
        return {"status": "ok", "enabled": enabled}
    return {"status": "error", "message": "Category not found"}

# ==================== Topic Operations ====================

@router.post("/topic/add")
def add_topic(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = (data.get('topic_name') or '').strip()

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    if db.add_topic(bot_name, category_name, topic_name):
        return {"status": "ok", "topic_name": topic_name}
    return {"status": "error", "message": "Topic already exists or category not found"}

@router.post("/topic/rename")
def rename_topic(request: Request, data: dict = Body(...)):
    bot_name      = data.get('bot_name')
    category_name = data.get('category_name')
    old_name      = (data.get('old_name') or '').strip()
    new_name      = (data.get('new_name') or '').strip()

    if not bot_name or not category_name or not old_name or not new_name:
        return {"status": "error", "message": "Missing required fields"}
    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    if db.rename_topic(bot_name, category_name, old_name, new_name):
        return {"status": "ok"}
    return {"status": "error", "message": "Topic not found or name already taken"}

@router.post("/topic/delete")
def delete_topic(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    all_bots = db.get_all_bots_config()
    topic_data = (all_bots.get(bot_name, {}).get('categories', {})
                  .get(category_name, {}).get('topics', {}).get(topic_name))
    if topic_data:
        db.recycle_bin_add('topic', f"{bot_name}/{category_name}/{topic_name}", {
            'bot_name': bot_name, 'category_name': category_name,
            'topic_name': topic_name, **topic_data
        }, owner_id=get_request_user_id(request))

    if db.delete_topic(bot_name, category_name, topic_name):
        return {"status": "ok"}
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/catch_all")
def set_topic_catch_all(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    value = data.get('catch_all')

    if not bot_name or not category_name or not topic_name or value is None:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    if db.set_topic_catch_all(bot_name, category_name, topic_name, bool(value)):
        return {"status": "ok", "catch_all": bool(value)}
    return {"status": "error", "message": "Topic not found"}


@router.post("/topic/toggle")
def toggle_topic(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    enabled = data.get('enabled')

    if not bot_name or not category_name or not topic_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    if db.toggle_topic(bot_name, category_name, topic_name, enabled):
        return {"status": "ok", "enabled": enabled}
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/update")
def update_topic(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keywords = data.get('keywords')
    linked_topics = data.get('linked_topics')

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()

    if keywords is not None:
        if isinstance(keywords, str):
            if ',' in keywords:
                keywords = [kw.strip() for kw in keywords.split(',') if kw.strip()]
            else:
                keywords = [kw.strip() for kw in keywords.split() if kw.strip()]

        if isinstance(keywords, list):
            seen = set()
            unique_keywords = []
            for kw in keywords:
                kw = str(kw).strip()
                if kw and kw not in seen:
                    seen.add(kw)
                    unique_keywords.append(kw)
            db.set_topic_keywords(bot_name, category_name, topic_name, unique_keywords)

    if linked_topics is not None:
        db.update_topic_linked(bot_name, category_name, topic_name, linked_topics)

    return {"status": "ok"}

# ==================== Schedule Operations ====================

@router.post("/topic/schedule/add")
def add_topic_schedule(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    schedule = data.get('schedule')

    if not bot_name or not category_name or not topic_name or not schedule:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    schedule_type = schedule.get('type')
    if schedule_type not in ['minute', 'hourly', 'daily', 'interval', 'interval_minutes', 'speeches_interval']:
        return {"status": "error", "message": "Invalid schedule type"}

    db = get_db()
    schedule_id = db.add_schedule(bot_name, category_name, topic_name, schedule)
    if schedule_id:
        schedule['id'] = schedule_id
        return {"status": "ok", "schedule": schedule}
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/schedule/delete")
def delete_topic_schedule(request: Request, data: dict = Body(...)):
    schedule_id = data.get('schedule_id')
    bot_name = data.get('bot_name', '')
    category_name = data.get('category_name', '')
    topic_name = data.get('topic_name', '')

    if schedule_id is None:
        return {"status": "error", "message": "Missing schedule_id"}

    db = get_db()
    all_bots = db.get_all_bots_config()
    schedule_data = None
    for bn, bot in all_bots.items():
        for cn, cat in bot.get('categories', {}).items():
            for tn, topic in cat.get('topics', {}).items():
                for sch in topic.get('schedules', []):
                    if sch.get('id') == schedule_id:
                        schedule_data = sch
                        bot_name = bot_name or bn
                        category_name = category_name or cn
                        topic_name = topic_name or tn
                        break

    if bot_name and not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    if schedule_data:
        db.recycle_bin_add('schedule', schedule_data.get('name', f'schedule-{schedule_id}'), {
            'bot_name': bot_name, 'category_name': category_name,
            'topic_name': topic_name, 'schedule': schedule_data
        }, owner_id=get_request_user_id(request))

    if db.delete_schedule(schedule_id):
        return {"status": "ok"}
    return {"status": "error", "message": "Schedule not found"}

@router.post("/topic/schedule/update")
def update_topic_schedule(request: Request, data: dict = Body(...)):
    schedule_id = data.get('schedule_id')
    schedule = data.get('schedule')

    if schedule_id is None or not schedule:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.update_schedule(schedule_id, schedule):
        return {"status": "ok", "schedule": schedule}
    return {"status": "error", "message": "Schedule not found"}

# ==================== Keyword Operations ====================

@router.get("/topic/keywords")
def get_topic_keywords(bot_name: str, category_name: str, topic_name: str):
    db = get_db()
    keywords = db.get_topic_keywords(bot_name, category_name, topic_name)
    return {"status": "ok", "keywords": keywords, "count": len(keywords)}

@router.post("/topic/keyword/add")
def add_topic_keyword(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keyword = (data.get('keyword') or '').strip()

    if not bot_name or not category_name or not topic_name or not keyword:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    inserted = db.add_keyword(bot_name, category_name, topic_name, keyword)
    return {"status": "ok", "inserted": inserted, "keyword": keyword}

@router.post("/topic/keyword/delete")
def delete_topic_keyword(request: Request, data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keyword = (data.get('keyword') or '').strip()

    if not bot_name or not category_name or not topic_name or not keyword:
        return {"status": "error", "message": "Missing required fields"}

    if not _can_modify_bot(request, bot_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    deleted = db.delete_keyword(bot_name, category_name, topic_name, keyword)
    return {"status": "ok", "deleted": deleted, "keyword": keyword}
