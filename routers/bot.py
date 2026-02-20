import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import load_config, save_config, start_bot_subprocess, stop_bot_subprocess

logger = logging.getLogger("bot_router")
router = APIRouter()

@router.post("/bot/enable")
def enable_bot(request: Request):
    bot_lock = request.app.state.bot_lock

    with bot_lock:
        existing = getattr(request.app.state, 'bot_process', None)
        if existing and existing.poll() is None:
            return {"status": "Bot already running"}

    proc = start_bot_subprocess(request.app.state)
    if proc is None:
        return {"status": "error", "message": "Bot crashed on startup"}
    return {"status": "Bot started", "pid": proc.pid}

@router.post("/bot/disable")
def disable_bot(request: Request):
    bot_lock = request.app.state.bot_lock

    stopped = stop_bot_subprocess(request.app.state, bot_lock)

    # Save runtime status
    cfg = load_config()
    cfg.setdefault("runtime", {})["bot_enabled"] = False
    save_config(cfg)

    if stopped:
        return {"status": "Bot stopped"}
    return {"status": "Bot is not running"}

@router.post("/bot/reload")
def reload_bot():
    """Signal the running bot to reload configuration and scheduler."""
    with open("reload.flag", "w") as f:
        f.write("reload")
    return {"status": "bot_reload_requested"}

@router.get("/bots")
def list_bots():
    cfg = load_config()
    return cfg.get('bots', {})

@router.post("/bot/save")
def save_bot(data: dict = Body(...)):
    """Create or update a logical bot profile.

    Expects: { name, enabled, collections, minimum_messages, categories }
    Note: source/target channels are defined in collections
    Note: prompts are stored in prompts.yaml
    Note: schedules are defined in topic.schedules
    """
    name = data.get('name')
    if not name:
        return {"status": "error", "message": "Missing bot name"}

    cfg = load_config()
    bots = cfg.setdefault('bots', {})

    # Get existing bot data or create new
    existing_bot = bots.get(name, {})

    # Update bot with all provided fields, preserving existing values if not provided
    bots[name] = {
        'enabled': data.get('enabled', existing_bot.get('enabled', True)),
        'categories': data.get('categories', existing_bot.get('categories', {})),
        'collections': data.get('collections', existing_bot.get('collections', [])),
        'minimum_messages': data.get('minimum_messages', existing_bot.get('minimum_messages', 5))
    }

    if 'bot_token' in data:
        bots[name]['bot_token'] = data.get('bot_token')

    save_config(cfg)
    return {"status": "updated", "name": name}

@router.post("/bot/delete")
def delete_bot(data: dict = Body(...)):
    name = data.get('name')
    if not name:
        return {"status": "error", "message": "Missing bot name"}
    cfg = load_config()
    bots = cfg.get('bots', {})
    if name in bots:
        del bots[name]
        save_config(cfg)
        return {"status": "ok"}
    return {"status": "error", "message": "Bot not found"}

@router.post("/bot/rename")
def rename_bot(data: dict = Body(...)):
    """Rename a bot

    Expects: { old_name: str, new_name: str }
    """
    old_name = data.get('old_name')
    new_name = data.get('new_name')

    if not old_name or not new_name:
        return {"status": "error", "message": "Missing old_name or new_name"}

    # Validate new name format
    if not new_name or not new_name.replace('_', '').isalnum():
        return {"status": "error", "message": "Invalid bot name format"}

    cfg = load_config()
    bots = cfg.get('bots', {})

    # Check if old exists and new doesn't
    if old_name not in bots:
        return {"status": "error", "message": "Bot not found"}

    if new_name in bots and new_name != old_name:
        return {"status": "error", "message": "New name already exists"}

    # Copy data to new name and delete old
    bots[new_name] = bots[old_name]
    if new_name != old_name:
        del bots[old_name]

    save_config(cfg)

    return {
        "status": "ok",
        "old_name": old_name,
        "new_name": new_name
    }
