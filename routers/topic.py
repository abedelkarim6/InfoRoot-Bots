from fastapi import APIRouter, Body
from utils.helpers import load_config, save_config
from utils.database import get_db

router = APIRouter()

# ==================== Category Operations ====================

@router.post("/category/add")
def add_category(data: dict = Body(...)):
    """Add a new category
    
    Expects: {
        bot_name: str,
        category_name: str
    }
    """
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    
    if not bot_name or not category_name:
        return {"status": "error", "message": "Missing required fields"}
    
    # Validate name format
    if not category_name.replace('_', '').replace('-', '').isalnum():
        return {"status": "error", "message": "Invalid category name"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    # Initialize categories if not exists
    if 'categories' not in bots[bot_name]:
        bots[bot_name]['categories'] = {}
    
    # Check if category already exists
    if category_name in bots[bot_name]['categories']:
        return {"status": "error", "message": "Category already exists"}
    
    # Create new category
    bots[bot_name]['categories'][category_name] = {
        'enabled': True,
        'topics': {}
    }
    
    save_config(cfg)
    return {"status": "ok", "category_name": category_name}

@router.post("/category/delete")
def delete_category(data: dict = Body(...)):
    """Delete a category and all its topics"""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    
    if not bot_name or not category_name:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name in categories:
        del categories[category_name]
        save_config(cfg)
        return {"status": "ok"}
    
    return {"status": "error", "message": "Category not found"}

@router.post("/category/toggle")
def toggle_category(data: dict = Body(...)):
    """Enable/disable entire category (affects all topics)"""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    enabled = data.get('enabled')
    
    if not bot_name or not category_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name in categories:
        categories[category_name]['enabled'] = enabled
        save_config(cfg)
        return {"status": "ok", "enabled": enabled}
    
    return {"status": "error", "message": "Category not found"}

# ==================== Topic Operations ====================

@router.post("/topic/add")
def add_topic(data: dict = Body(...)):
    """Add a new topic to a category
    
    Expects: {
        bot_name: str,
        category_name: str,
        topic_name: str
    }
    """
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    
    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}
    
    # Validate name format
    if not topic_name.replace('_', '').replace('-', '').isalnum():
        return {"status": "error", "message": "Invalid topic name"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}
    
    topics = categories[category_name].get('topics', {})
    if topic_name in topics:
        return {"status": "error", "message": "Topic already exists"}
    
    # Create new topic with default schedule (no keywords in config — stored in DB)
    topics[topic_name] = {
        'enabled': True,
        'linked_topics': [],
        'schedules': [
            {
                'name': 'Default Schedule',
                'type': 'hourly',
                'minute': 0,
                'prompt_key': 'brief_update',
                'enabled': True
            }
        ]
    }

    save_config(cfg)
    return {"status": "ok", "topic_name": topic_name}

@router.post("/topic/delete")
def delete_topic(data: dict = Body(...)):
    """Delete a topic"""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    
    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}
    
    topics = categories[category_name].get('topics', {})
    if topic_name in topics:
        del topics[topic_name]
        save_config(cfg)
        return {"status": "ok"}
    
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/toggle")
def toggle_topic(data: dict = Body(...)):
    """Enable/disable a topic"""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    enabled = data.get('enabled')
    
    if not bot_name or not category_name or not topic_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}
    
    topics = categories[category_name].get('topics', {})
    if topic_name in topics:
        topics[topic_name]['enabled'] = enabled
        save_config(cfg)
        return {"status": "ok", "enabled": enabled}
    
    return {"status": "error", "message": "Topic not found"}

@router.post("/topic/update")
def update_topic(data: dict = Body(...)):
    """Update topic keywords and linked topics

    Expects: {
        bot_name: str,
        category_name: str,
        topic_name: str,
        keywords: [str] | str (space-separated),
        linked_topics: [str]
    }

    Keywords can be either:
    - Array: ["keyword1", "keyword2"]
    - Comma-separated string: "keyword1, keyword2, keyword3"
    - Space-separated string: "keyword1 keyword2 keyword3"
    """
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keywords = data.get('keywords')
    linked_topics = data.get('linked_topics')

    if not bot_name or not category_name or not topic_name:
        return {"status": "error", "message": "Missing required fields"}

    cfg = load_config()
    bots = cfg.get('bots', {})

    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}

    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}

    topics = categories[category_name].get('topics', {})
    if topic_name not in topics:
        return {"status": "error", "message": "Topic not found"}

    # Update keywords if provided — stored in DB, not config
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

            db = get_db()
            if db is None:
                return {"status": "error", "message": "Database not available"}
            db.set_topic_keywords(bot_name, category_name, topic_name, unique_keywords)

    # Update linked topics if provided (still in config)
    if linked_topics is not None:
        topics[topic_name]['linked_topics'] = linked_topics

    save_config(cfg)
    return {"status": "ok"}

# ==================== Schedule Operations ====================

@router.post("/topic/schedule/add")
def add_topic_schedule(data: dict = Body(...)):
    """Add a schedule to a topic
    
    Expects: {
        bot_name: str,
        category_name: str,
        topic_name: str,
        schedule: {
            name: str,
            type: str,
            minute: int,
            hour: int (for daily),
            prompt_key: str,
            enabled: bool
        }
    }
    """
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    schedule = data.get('schedule')
    
    if not bot_name or not category_name or not topic_name or not schedule:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}
    
    topics = categories[category_name].get('topics', {})
    if topic_name not in topics:
        return {"status": "error", "message": "Topic not found"}

    # Validate schedule type
    schedule_type = schedule.get('type')
    if schedule_type not in ['minute', 'hourly', 'daily', 'interval']:
        return {"status": "error", "message": "Invalid schedule type"}

    # Validate interval fields
    if schedule_type == 'interval':
        hours = schedule.get('hours')
        if not hours or not isinstance(hours, int) or hours < 1 or hours > 24:
            return {"status": "error", "message": "Interval hours must be 1-24"}

    # Initialize schedules if not exists
    if 'schedules' not in topics[topic_name]:
        topics[topic_name]['schedules'] = []
    
    topics[topic_name]['schedules'].append(schedule)
    save_config(cfg)
    
    return {"status": "ok", "schedule": schedule}

@router.post("/topic/schedule/delete")
def delete_topic_schedule(data: dict = Body(...)):
    """Delete a schedule from a topic"""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    schedule_index = data.get('schedule_index')
    
    if not bot_name or not category_name or not topic_name or schedule_index is None:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}
    
    topics = categories[category_name].get('topics', {})
    if topic_name not in topics:
        return {"status": "error", "message": "Topic not found"}
    
    schedules = topics[topic_name].get('schedules', [])
    if schedule_index >= len(schedules):
        return {"status": "error", "message": "Invalid schedule index"}
    
    schedules.pop(schedule_index)
    save_config(cfg)
    
    return {"status": "ok"}

@router.get("/topic/keywords")
def get_topic_keywords(bot_name: str, category_name: str, topic_name: str):
    """Fetch keywords for a topic from the database."""
    db = get_db()
    if db is None:
        return {"status": "error", "message": "Database not available"}
    keywords = db.get_topic_keywords(bot_name, category_name, topic_name)
    return {"status": "ok", "keywords": keywords, "count": len(keywords)}


@router.post("/topic/keyword/add")
def add_topic_keyword(data: dict = Body(...)):
    """Add a single keyword to a topic in the database."""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keyword = (data.get('keyword') or '').strip()

    if not bot_name or not category_name or not topic_name or not keyword:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db is None:
        return {"status": "error", "message": "Database not available"}

    inserted = db.add_keyword(bot_name, category_name, topic_name, keyword)
    return {"status": "ok", "inserted": inserted, "keyword": keyword}


@router.post("/topic/keyword/delete")
def delete_topic_keyword(data: dict = Body(...)):
    """Delete a single keyword from a topic in the database."""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    keyword = (data.get('keyword') or '').strip()

    if not bot_name or not category_name or not topic_name or not keyword:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db is None:
        return {"status": "error", "message": "Database not available"}

    deleted = db.delete_keyword(bot_name, category_name, topic_name, keyword)
    return {"status": "ok", "deleted": deleted, "keyword": keyword}


@router.post("/topic/schedule/update")
def update_topic_schedule(data: dict = Body(...)):
    """Update a topic schedule"""
    bot_name = data.get('bot_name')
    category_name = data.get('category_name')
    topic_name = data.get('topic_name')
    schedule_index = data.get('schedule_index')
    schedule = data.get('schedule')
    
    if not bot_name or not category_name or not topic_name or schedule_index is None or not schedule:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    bots = cfg.get('bots', {})
    
    if bot_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    
    categories = bots[bot_name].get('categories', {})
    if category_name not in categories:
        return {"status": "error", "message": "Category not found"}
    
    topics = categories[category_name].get('topics', {})
    if topic_name not in topics:
        return {"status": "error", "message": "Topic not found"}
    
    schedules = topics[topic_name].get('schedules', [])
    if schedule_index >= len(schedules):
        return {"status": "error", "message": "Invalid schedule index"}
    
    schedules[schedule_index] = schedule
    save_config(cfg)

    return {"status": "ok", "schedule": schedule}