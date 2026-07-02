import logging
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter()


def _owner_id(request: Request):
    """Admin → None (global scope). Authenticated user → their user id."""
    if is_admin_request(request):
        return None
    return get_request_user_id(request)


@router.get("/prompts")
def get_all_prompts(request: Request):
    """Return {summaries: {...}, youtube: {...}} for the caller's scope."""
    try:
        db = get_db()
        if is_admin_request(request):
            return db.get_all_prompts(owner_id=None)
        user_id = get_request_user_id(request)
        if not user_id:
            return {'summaries': {}, 'youtube': {}}
        return db.get_all_prompts(owner_id=user_id)
    except Exception as e:
        logger.exception("[PROMPTS] get_all_prompts failed")
        return {"status": "error", "message": str(e)}


@router.get("/prompts/{prompt_type}")
def get_prompts_by_type(request: Request, prompt_type: str):
    try:
        if prompt_type not in ('summaries', 'youtube'):
            return JSONResponse({"status": "error", "message": "Invalid type"}, status_code=400)
        if is_admin_request(request):
            owner_id = None
        else:
            owner_id = get_request_user_id(request)
            if not owner_id:
                return {}
        return get_db().get_prompts_by_type(prompt_type, owner_id=owner_id)
    except Exception as e:
        logger.exception("[PROMPTS] get_prompts_by_type failed")
        return {"status": "error", "message": str(e)}


@router.post("/prompts/update")
def update_prompt(request: Request, data: dict = Body(...)):
    try:
        key = (data.get("key") or "").strip()
        text = data.get("text", "")
        name = data.get("name")
        prompt_type = data.get("type", "summaries")

        if not key:
            return {"status": "error", "message": "key is required"}
        if prompt_type not in ('summaries', 'youtube'):
            return {"status": "error", "message": "type must be 'summaries' or 'youtube'"}

        owner_id = _owner_id(request)
        db = get_db()
        db.save_prompt(key, text, owner_id=owner_id, prompt_type=prompt_type, name=name)
        return {"status": "ok", "key": key, "type": prompt_type}
    except Exception as e:
        logger.exception("[PROMPTS] update_prompt failed")
        return {"status": "error", "message": str(e)}


@router.post("/prompts/rename-cascade")
def rename_prompt_cascade(request: Request, data: dict = Body(...)):
    """Rewire schedules referencing old_key to new_key. Only meaningful for
    summaries prompts; YouTube channels/keywords are updated separately via
    /api/youtube/* endpoints."""
    try:
        old_key = (data.get("old_key") or "").strip()
        new_key = (data.get("new_key") or "").strip()
        prompt_type = data.get("type", "summaries")

        if not old_key or not new_key:
            return {"status": "error", "message": "old_key and new_key are required"}

        owner_id = _owner_id(request)
        db = get_db()
        schedules_updated = 0
        yt_updated = 0
        if prompt_type == 'summaries':
            schedules_updated = db.rename_prompt_key_in_schedules(old_key, new_key, owner_id=owner_id)
        else:
            # YouTube: rewire channels/keywords pointing at old_key
            from youtube_monitor.db import get_yt_db
            ydb = get_yt_db()
            if ydb:
                cur = ydb._get_cursor()
                cur.execute("UPDATE yt_channels SET prompt_key = %s WHERE prompt_key = %s", (new_key, old_key))
                yt_updated += cur.rowcount
                cur.execute("UPDATE yt_keywords SET prompt_key = %s WHERE prompt_key = %s", (new_key, old_key))
                yt_updated += cur.rowcount
                ydb.connection.commit()
        return {"status": "ok",
                "updated_schedules": schedules_updated,
                "updated_youtube_refs": yt_updated}
    except Exception as e:
        logger.exception("[PROMPTS] rename_prompt_cascade failed")
        return {"status": "error", "message": str(e)}


@router.post("/prompts/delete")
def delete_prompt(request: Request, data: dict = Body(...)):
    try:
        key = (data.get("key") or "").strip()
        prompt_type = data.get("type", "summaries")
        if not key:
            return {"status": "error", "message": "key is required"}
        if prompt_type not in ('summaries', 'youtube'):
            return {"status": "error", "message": "type must be 'summaries' or 'youtube'"}

        owner_id = _owner_id(request)
        db = get_db()

        # Block deletion when other entities reference this prompt.
        if prompt_type == 'summaries':
            schedules = db.get_prompt_schedules(key, owner_id=owner_id)
            if schedules:
                details = ', '.join(
                    f"{s['bot_name']}/{s['category_name']}/{s['topic_name']}/{s['schedule_name']}"
                    for s in schedules
                )
                return {
                    "status": "error",
                    "blocked": True,
                    "message": f"Cannot delete: prompt is used by {len(schedules)} schedule(s): {details}",
                    "used_in": schedules,
                }
        else:  # youtube
            from youtube_monitor.db import get_yt_db
            ydb = get_yt_db()
            refs = []
            if ydb:
                cur = ydb._get_cursor()
                cur.execute("SELECT channel_id, channel_name FROM yt_channels WHERE prompt_key = %s", (key,))
                for r in cur.fetchall():
                    refs.append(f"channel:{r['channel_name'] or r['channel_id']}")
                cur.execute("SELECT id, keyword FROM yt_keywords WHERE prompt_key = %s", (key,))
                for r in cur.fetchall():
                    refs.append(f"keyword:{r['keyword']}")
            if refs:
                return {
                    "status": "error",
                    "blocked": True,
                    "message": f"Cannot delete: prompt is used by {len(refs)} item(s): {', '.join(refs)}",
                    "used_in": refs,
                }

        prompts = db.get_prompts_by_type(prompt_type, owner_id=owner_id)
        if key in prompts:
            user_id = get_request_user_id(request)
            db.recycle_bin_add(
                'prompt',
                f"{prompt_type}/{key}",
                {'type': prompt_type, 'key': key, 'text': prompts[key].get('text', ''),
                 'name': prompts[key].get('name', key)},
                owner_id=user_id,
            )

        db.delete_prompt(key, owner_id=owner_id, prompt_type=prompt_type)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[PROMPTS] delete_prompt failed")
        return {"status": "error", "message": str(e)}
