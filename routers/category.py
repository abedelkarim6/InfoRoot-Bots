from fastapi import APIRouter, Body
from utils.helpers import load_config, save_config

router = APIRouter()

@router.post("/category/toggle")
def toggle_category(
    group: str = Body(...),
    name: str = Body(...),
    enabled: bool = Body(...)
):
    cfg = load_config()
    cfg["categories"][group][name]["enabled"] = enabled
    save_config(cfg)
    return {"status": "ok", "group": group, "name": name, "enabled": enabled}

@router.post("/category/schedule/update")
def update_schedule(data: dict = Body(...)):
    """Update category schedule"""
    group = data.get("group")
    name = data.get("name")
    schedule_type = data.get("type")
    minute = data.get("minute")
    hour = data.get("hour")
    
    cfg = load_config()

    sched = {"type": schedule_type}

    if schedule_type == "minute":
        sched["minute"] = minute if minute is not None else 0

    elif schedule_type == "hourly":
        sched["minute"] = minute if minute is not None else 0

    elif schedule_type == "daily":
        sched["hour"] = hour if hour is not None else 0
        sched["minute"] = minute if minute is not None else 0

    cfg["categories"][group][name]["schedule"] = sched
    save_config(cfg)

    return {"status": "updated", "schedule": sched}

@router.post("/scheduler/reload")
def reload_scheduler():
    """Signal to reload scheduler"""
    with open("reload.flag", "w") as f:
        f.write("reload")
    return {"status": "scheduler_reload_requested"}

@router.post("/category/update")
def update_category(data: dict = Body(...)):
    """Update category keywords and format"""
    group = data.get("group")
    name = data.get("name")
    keywords = data.get("keywords", [])
    format_type = data.get("format")
    
    if not group or not name or format_type is None:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    
    # Check if category exists
    if group not in cfg["categories"] or name not in cfg["categories"][group]:
        return {"status": "error", "message": f"Category {group}/{name} not found"}
    
    # Update the category
    cfg["categories"][group][name]["keywords"] = keywords
    cfg["categories"][group][name]["format"] = format_type
    
    save_config(cfg)
    return {"status": "updated", "group": group, "name": name}

@router.post("/category/header/update")
def update_category_header(data: dict = Body(...)):
    """Update category summary header"""
    group = data.get("group")
    name = data.get("name")
    header = data.get("header", "")
    
    if not group or not name:
        return {"status": "error", "message": "Missing group or name"}
    
    cfg = load_config()
    
    # Check if category exists
    if group not in cfg["categories"] or name not in cfg["categories"][group]:
        return {"status": "error", "message": f"Category {group}/{name} not found"}
    
    # Update the header
    cfg["categories"][group][name]["header"] = header
    
    save_config(cfg)
    return {"status": "updated", "group": group, "name": name, "header": header}

@router.post("/category/add")
def add_category(data: dict = Body(...)):
    """Add a new country or region"""
    group = data["group"]  # "countries" or "regions"
    name = data["name"]
    
    cfg = load_config()
    
    # Check if already exists
    if name in cfg["categories"][group]:
        return {"status": "error", "message": "Category already exists"}
    
    # Create new category with defaults
    cfg["categories"][group][name] = {
        "enabled": False,  # Default to disabled
        "keywords": data.get("keywords", []),
        "format": data.get("format", "bullet_points"),
        "schedule": data.get("schedule", {
            "type": "hourly",
            "minute": 0
        })
    }
    
    save_config(cfg)
    return {"status": "ok", "name": name}

@router.post("/category/delete")
def delete_category(data: dict = Body(...)):
    """Delete a country or region"""
    group = data["group"]
    name = data["name"]
    
    cfg = load_config()
    
    if name in cfg["categories"][group]:
        del cfg["categories"][group][name]
        save_config(cfg)
        return {"status": "ok"}
    
    return {"status": "error", "message": "Category not found"}

@router.post("/category/rename")
def rename_category(data: dict = Body(...)):
    """Rename a country or region"""
    group = data["group"]
    old_name = data["old_name"]
    new_name = data["new_name"]
    
    cfg = load_config()
    
    # Check if old exists and new doesn't
    if old_name not in cfg["categories"][group]:
        return {"status": "error", "message": "Category not found"}
    
    if new_name in cfg["categories"][group]:
        return {"status": "error", "message": "New name already exists"}
    
    # Copy data to new name and delete old
    cfg["categories"][group][new_name] = cfg["categories"][group][old_name]
    del cfg["categories"][group][old_name]
    
    save_config(cfg)
    return {"status": "ok", "old_name": old_name, "new_name": new_name}

@router.get("/category/keywords-expanded/{group}/{name}")
def get_expanded_keywords(group: str, name: str):
    """Get all keywords for a category including from linked topics"""
    from utils.linked_topics import get_category_keywords_with_links
    
    cfg = load_config()
    
    # Check if category exists
    if group not in cfg["categories"] or name not in cfg["categories"][group]:
        return {"status": "error", "message": "Category not found"}
    
    try:
        keywords = get_category_keywords_with_links(group, name, cfg)
        own_keywords = cfg["categories"][group][name].get("keywords", [])
        linked_keywords = [k for k in keywords if k not in own_keywords]
        
        return {
            "status": "ok",
            "total_keywords": len(keywords),
            "own_keywords": own_keywords,
            "linked_keywords": linked_keywords,
            "all_keywords": keywords
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
