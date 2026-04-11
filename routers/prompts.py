from fastapi import APIRouter, Body
from fastapi import Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

router = APIRouter()


def _resolve_prompt_access(request: Request, bot_name: str):
    """Return (allowed, owner_id) — delegates to topic.py's copy-on-write logic."""
    from routers.topic import _resolve_bot_access
    return _resolve_bot_access(request, bot_name)


@router.get("/prompts")
def get_all_prompts(request: Request):
    db = get_db()
    if is_admin_request(request):
        return db.get_all_prompts(owner_id=None)
    user_id = get_request_user_id(request)
    if not user_id:
        return {}
    cfg = db.get_filtered_bots_config(user_id)
    return {bot_name: db.get_bot_prompts(bot_name, owner_id=user_id) for bot_name in cfg}

@router.get("/prompts/{bot_name}")
def get_bot_prompts(request: Request, bot_name: str):
    allowed, owner_id = _resolve_prompt_access(request, bot_name)
    if not allowed:
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)
    db = get_db()
    return db.get_bot_prompts(bot_name, owner_id=owner_id)

@router.post("/prompts/update")
def update_prompt(request: Request, data: dict = Body(...)):
    bot_name = data.get("bot_name")
    key = data.get("key")
    text = data.get("text", "")

    if not bot_name:
        return {"status": "error", "message": "bot_name is required"}
    if not key:
        return {"status": "error", "message": "key is required"}

    allowed, owner_id = _resolve_prompt_access(request, bot_name)
    if not allowed:
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    db.save_prompt(bot_name, key, text, owner_id=owner_id)
    return {"status": "ok", "key": key, "bot_name": bot_name}

@router.post("/prompts/rename-cascade")
def rename_prompt_cascade(request: Request, data: dict = Body(...)):
    """Update prompt_key in all schedules of the bot after a prompt is renamed."""
    bot_name = data.get("bot_name")
    old_key  = (data.get("old_key") or "").strip()
    new_key  = (data.get("new_key") or "").strip()

    if not bot_name or not old_key or not new_key:
        return {"status": "error", "message": "bot_name, old_key and new_key are required"}

    allowed, owner_id = _resolve_prompt_access(request, bot_name)
    if not allowed:
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    count = db.rename_prompt_key_in_schedules(bot_name, old_key, new_key, owner_id=owner_id)
    return {"status": "ok", "updated_schedules": count}

@router.post("/prompts/delete")
def delete_prompt(request: Request, data: dict = Body(...)):
    bot_name = data.get("bot_name")
    key = data.get("key")

    if not bot_name:
        return {"status": "error", "message": "bot_name is required"}

    allowed, owner_id = _resolve_prompt_access(request, bot_name)
    if not allowed:
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

    db = get_db()
    schedules = db.get_prompt_schedules(bot_name, key, owner_id=owner_id)
    if schedules:
        details = ', '.join(
            f"{s['category_name']}/{s['topic_name']}/{s['schedule_name']}"
            for s in schedules
        )
        return {
            "status": "error",
            "blocked": True,
            "message": f"Cannot delete: prompt is used by {len(schedules)} schedule(s): {details}",
            "used_in": schedules,
        }

    user_id = get_request_user_id(request)
    prompts = db.get_bot_prompts(bot_name, owner_id=owner_id)
    if key in prompts:
        db.recycle_bin_add('prompt', f"{bot_name}/{key}", {
            'bot_name': bot_name, 'key': key, 'text': prompts[key].get('text', '')
        }, owner_id=user_id)

    db.delete_prompt(bot_name, key, owner_id=owner_id)
    return {"status": "ok"}
