from fastapi import APIRouter, Body
from utils.database import get_db

router = APIRouter()

# ==================== Category Operations ====================

@router.post("/category/add")
def add_category(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = (data.get('category_name') or '').strip()

    if not bot_name or not category_name:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.add_category(bot_name, category_name):
        return {"status": "ok", "category_name": category_name}
    return {"status": "error", "message": "Category already exists or bot not found"}

@router.post("/category/delete")
def delete_category(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')

    if not bot_name or not category_name:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.delete_category(bot_name, category_name):
        return {"status": "ok"}
    return {"status": "error", "message": "Category not found"}

@router.post("/category/toggle")
def toggle_category(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    enabled = data.get('enabled')

    if not bot_name or not category_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.toggle_category(bot_name, category_name, enabled):
        return {"status": "ok", "enabled": enabled}
    return {"status": "error", "message": "Category not found"}

# ==================== Topic Operations ====================

@router.post("/topic/add")
def add_topic(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = (data.get('topic_name') or '').strip()

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.add_topic(bot_name, category_name, topic_name):
        return {"status": "ok", "topic_name": topic_name}
    return {"status": "error", "message": "Topic already exists or category not found"}

@router.post("/topic/delete")
def delete_topic(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.delete_topic(bot_name, category_name, topic_name):
        return {"status": "ok"}
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/toggle")
def toggle_topic(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    enabled = data.get('enabled')

    if not bot_name or not category_name or not topic_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.toggle_topic(bot_name, category_name, topic_name, enabled):
        return {"status": "ok", "enabled": enabled}
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/update")
def update_topic(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keywords = data.get('keywords')
    linked_topics = data.get('linked_topics')

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

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
def add_topic_schedule(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    schedule = data.get('schedule')

    if not bot_name or not category_name or not topic_name or not schedule:
        return {"status": "error", "message": "Missing required fields"}

    schedule_type = schedule.get('type')
    if schedule_type not in ['minute', 'hourly', 'daily', 'interval', 'interval_minutes']:
        return {"status": "error", "message": "Invalid schedule type"}

    db = get_db()
    schedule_id = db.add_schedule(bot_name, category_name, topic_name, schedule)
    if schedule_id:
        schedule['id'] = schedule_id
        return {"status": "ok", "schedule": schedule}
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/schedule/delete")
def delete_topic_schedule(data: dict = Body(...)):
    schedule_id = data.get('schedule_id')

    if schedule_id is None:
        return {"status": "error", "message": "Missing schedule_id"}

    db = get_db()
    if db.delete_schedule(schedule_id):
        return {"status": "ok"}
    return {"status": "error", "message": "Schedule not found"}

@router.post("/topic/schedule/update")
def update_topic_schedule(data: dict = Body(...)):
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
def add_topic_keyword(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keyword = (data.get('keyword') or '').strip()

    if not bot_name or not category_name or not topic_name or not keyword:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    inserted = db.add_keyword(bot_name, category_name, topic_name, keyword)
    return {"status": "ok", "inserted": inserted, "keyword": keyword}

@router.post("/topic/keyword/delete")
def delete_topic_keyword(data: dict = Body(...)):
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keyword = (data.get('keyword') or '').strip()

    if not bot_name or not category_name or not topic_name or not keyword:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    deleted = db.delete_keyword(bot_name, category_name, topic_name, keyword)
    return {"status": "ok", "deleted": deleted, "keyword": keyword}
