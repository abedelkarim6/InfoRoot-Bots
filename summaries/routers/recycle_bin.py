import logging

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_allowed_owner_id(request: Request):
    """Returns None for admin (sees all), or the user's id for scoped access."""
    if is_admin_request(request):
        return None
    return get_request_user_id(request)


@router.get("/recycle-bin/list")
def list_recycle_bin(request: Request):
    try:
        db = get_db()
        owner_id = _get_allowed_owner_id(request)
        items = db.recycle_bin_list(owner_id=owner_id)
        return {"status": "ok", "items": items}
    except Exception as e:
        logger.error(f"[RECYCLE-BIN] list failed: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}


@router.post("/recycle-bin/restore")
def restore_item(request: Request, data: dict = Body(...)):
    try:
        item_id = data.get("id")
        if item_id is None:
            return {"status": "error", "message": "Missing id"}

        db = get_db()
        row = db.recycle_bin_get(item_id)
        if not row:
            return {"status": "error", "message": "Item not found in recycle bin"}

        # Non-admin can only restore their own items
        if not is_admin_request(request):
            user_id = get_request_user_id(request)
            if row['owner_id'] != user_id:
                return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

        entity_type = row['entity_type']
        entity_data = row['entity_data']

        try:
            if entity_type == 'bot':
                db.recycle_bin_restore_bot(entity_data)
            elif entity_type == 'category':
                db.recycle_bin_restore_category(entity_data)
            elif entity_type == 'topic':
                db.recycle_bin_restore_topic(entity_data)
            elif entity_type == 'collection':
                db.recycle_bin_restore_collection(entity_data)
            elif entity_type == 'prompt':
                db.recycle_bin_restore_prompt(entity_data)
            elif entity_type == 'schedule':
                db.recycle_bin_restore_schedule(entity_data)
            elif entity_type == 'yt_channel':
                db.recycle_bin_restore_yt_channel(entity_data)
            elif entity_type == 'yt_keyword':
                db.recycle_bin_restore_yt_keyword(entity_data)
            else:
                return {"status": "error", "message": f"Unknown entity type: {entity_type}"}
        except Exception as e:
            return {"status": "error", "message": f"Restore failed: {str(e)}"}

        db.recycle_bin_delete(item_id)
        return {"status": "ok", "entity_type": entity_type}
    except Exception as e:
        logger.exception("[RECYCLE] restore failed")
        return {"status": "error", "message": str(e)}


@router.post("/recycle-bin/delete")
def permanently_delete(request: Request, data: dict = Body(...)):
    try:
        item_id = data.get("id")
        if item_id is None:
            return {"status": "error", "message": "Missing id"}

        db = get_db()
        if not is_admin_request(request):
            row = db.recycle_bin_get(item_id)
            if not row:
                return {"status": "error", "message": "Item not found"}
            if row['owner_id'] != get_request_user_id(request):
                return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

        if db.recycle_bin_delete(item_id):
            return {"status": "ok"}
        return {"status": "error", "message": "Item not found"}
    except Exception as e:
        logger.exception("[RECYCLE] permanent delete failed")
        return {"status": "error", "message": str(e)}


@router.post("/recycle-bin/empty")
def empty_recycle_bin(request: Request):
    try:
        if not is_admin_request(request):
            return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)
        db = get_db()
        count = db.recycle_bin_purge(days=0)
        return {"status": "ok", "deleted": count}
    except Exception as e:
        logger.exception("[RECYCLE] empty failed")
        return {"status": "error", "message": str(e)}
