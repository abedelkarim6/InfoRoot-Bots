import logging

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.helpers import start_bot_subprocess, stop_bot_subprocess
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

logger = logging.getLogger("bot_router")
router = APIRouter()


def _can_modify_bot(request: Request, bot_name: str) -> bool:
    """Return True if the requester owns the bot (admin only for owner_id IS NULL bots)."""
    if is_admin_request(request):
        owner_id = get_db().get_bot_owner_id(bot_name)
        return owner_id is None  # admin can only modify admin-managed bots
    user_id = get_request_user_id(request)
    if not user_id:
        return False
    owner_id = get_db().get_bot_owner_id(bot_name, requesting_user_id=user_id)
    return owner_id == user_id


def _get_request_owner_id(request: Request):
    """Return None for admin, user_id for regular users."""
    if is_admin_request(request):
        return None
    return get_request_user_id(request)


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
def list_bots(request: Request):
    db = get_db()
    if is_admin_request(request):
        return db.get_all_bots_config()
    user_id = get_request_user_id(request)
    return db.get_filtered_bots_config(user_id) if user_id else {}

@router.post("/bot/save")
def save_bot(request: Request, data: dict = Body(...)):
    name = data.get('name')
    if not name:
        return {"status": "error", "message": "Missing bot name"}

    create_only = bool(data.get('create_only'))
    db = get_db()

    if is_admin_request(request):
        # Admin path: operate on admin-managed bots
        all_bots = db.get_all_bots_config()
        existing = all_bots.get(name, {})
        is_new   = name not in all_bots
        if not is_new and create_only:
            return JSONResponse({"status": "error", "message": "A bot with this name already exists. Please choose a different name."}, status_code=409)
        if not is_new and not _can_modify_bot(request, name):
            return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)
        owner_id = None
    else:
        # User path: operate on this user's own bots (each user has their own namespace)
        user_id   = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"status": "error", "message": "Not authenticated"}, status_code=401)
        user_bots = db.get_owned_bots_config(user_id)
        existing  = user_bots.get(name, {})
        is_new    = name not in user_bots
        if not is_new and create_only:
            return JSONResponse({"status": "error", "message": "A bot with this name already exists. Please choose a different name."}, status_code=409)
        if not is_new and not _can_modify_bot(request, name):
            return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)
        owner_id = user_id

    db.save_bot(name, {
        'enabled': data.get('enabled', existing.get('enabled', True)),
        'collections': data.get('collections', existing.get('collections', [])),
        'minimum_messages': data.get('minimum_messages', existing.get('minimum_messages', 5)),
        'rules': data.get('rules', existing.get('rules', {'remove': [], 'replace': []})),
        'default_schedules': data.get('default_schedules', existing.get('default_schedules', [])),
    }, owner_id=owner_id)
    return {"status": "updated", "name": name}


@router.post("/bot/delete")
def delete_bot(request: Request, data: dict = Body(...)):
    name = data.get('name')
    if not name:
        return {"status": "error", "message": "Missing bot name"}

    if not _can_modify_bot(request, name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    owner_id = _get_request_owner_id(request)

    # Snapshot before deletion for recycle bin
    if owner_id is None:
        bot_data = db.get_all_bots_config().get(name)
    else:
        bot_data = db.get_owned_bots_config(owner_id).get(name)
    if bot_data:
        snapshot = {**bot_data, 'name': name}
        snapshot['prompts'] = db.get_bot_prompts(name)
        db.recycle_bin_add('bot', name, snapshot, owner_id=owner_id)

    if db.delete_bot(name, owner_id=owner_id):
        return {"status": "ok"}
    return {"status": "error", "message": "Bot not found"}


@router.post("/bot/rename")
def rename_bot(request: Request, data: dict = Body(...)):
    old_name = data.get('old_name')
    new_name = data.get('new_name')

    if not old_name or not new_name:
        return {"status": "error", "message": "Missing old_name or new_name"}

    if not new_name.replace('_', '').replace(' ', '').isalnum():
        return {"status": "error", "message": "Invalid bot name format"}

    if not _can_modify_bot(request, old_name):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    owner_id = _get_request_owner_id(request)

    if owner_id is None:
        bots = db.get_all_bots_config()
    else:
        bots = db.get_owned_bots_config(owner_id)

    if old_name not in bots:
        return {"status": "error", "message": "Bot not found"}
    if new_name in bots and new_name != old_name:
        return {"status": "error", "message": "New name already exists"}

    if db.rename_bot(old_name, new_name, owner_id=owner_id):
        return {"status": "ok", "old_name": old_name, "new_name": new_name}
    return {"status": "error", "message": "Rename failed"}
