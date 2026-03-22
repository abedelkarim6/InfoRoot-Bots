import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import start_bot_subprocess, stop_bot_subprocess
from utils.database import get_db

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
    if stopped:
        return {"status": "Bot stopped"}
    return {"status": "Bot is not running"}

@router.post("/bot/reload")
def reload_bot():
    with open("reload.flag", "w") as f:
        f.write("reload")
    return {"status": "bot_reload_requested"}

@router.get("/bots")
def list_bots():
    db = get_db()
    return db.get_all_bots_config()

@router.post("/bot/save")
def save_bot(data: dict = Body(...)):
    name = data.get('name')
    if not name:
        return {"status": "error", "message": "Missing bot name"}

    db = get_db()
    # Get existing bot data to preserve fields not provided
    all_bots = db.get_all_bots_config()
    existing = all_bots.get(name, {})

    db.save_bot(name, {
        'enabled': data.get('enabled', existing.get('enabled', True)),
        'collections': data.get('collections', existing.get('collections', [])),
        'minimum_messages': data.get('minimum_messages', existing.get('minimum_messages', 5)),
        'rules': data.get('rules', existing.get('rules', {'remove': [], 'replace': []})),
        'default_schedules': data.get('default_schedules', existing.get('default_schedules', [])),
    })
    return {"status": "updated", "name": name}

@router.post("/bot/delete")
def delete_bot(data: dict = Body(...)):
    name = data.get('name')
    if not name:
        return {"status": "error", "message": "Missing bot name"}

    db = get_db()
    if db.delete_bot(name):
        return {"status": "ok"}
    return {"status": "error", "message": "Bot not found"}

@router.post("/bot/rename")
def rename_bot(data: dict = Body(...)):
    old_name = data.get('old_name')
    new_name = data.get('new_name')

    if not old_name or not new_name:
        return {"status": "error", "message": "Missing old_name or new_name"}

    if not new_name or not new_name.replace('_', '').isalnum():
        return {"status": "error", "message": "Invalid bot name format"}

    db = get_db()
    all_bots = db.get_all_bots_config()

    if old_name not in all_bots:
        return {"status": "error", "message": "Bot not found"}
    if new_name in all_bots and new_name != old_name:
        return {"status": "error", "message": "New name already exists"}

    if db.rename_bot(old_name, new_name):
        return {"status": "ok", "old_name": old_name, "new_name": new_name}
    return {"status": "error", "message": "Rename failed"}
