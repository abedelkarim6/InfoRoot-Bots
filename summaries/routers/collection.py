import logging
from fastapi import APIRouter, Body
from fastapi import Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter()

@router.get("/collections")
def get_collections(request: Request):
    try:
        db = get_db()
        if is_admin_request(request):
            return db.get_all_collections()
        user_id = get_request_user_id(request)
        if not user_id:
            return {}
        return db.get_user_collections(user_id)
    except Exception as e:
        logger.exception("[COLLECTION] get_collections failed")
        return {"status": "error", "message": str(e)}

@router.post("/collection/save")
def save_collection(request: Request, data: dict = Body(...)):
    try:
        collection_name = data.get("collection_name")
        if not collection_name:
            return {"status": "error", "message": "Missing collection_name"}

        if is_admin_request(request):
            # Sources and destinations are now edited independently from the
            # per-bot Telegram Sources / Destinations buttons, so a collection
            # may be partially configured (sources without destinations or vice
            # versa). Both arrays default to empty.
            target_channels = data.get("target_channels", [])
            if not isinstance(target_channels, list):
                target_channels = []
            db = get_db()
            db.save_collection(collection_name, {
                "source_channels": data.get("source_channels", []),
                "target_channels": target_channels,
                "enabled": data.get("enabled", True),
            })
            return {"status": "ok", "collection_name": collection_name}

        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"status": "error", "message": "Not authenticated"}, status_code=401)
        db = get_db()
        db.save_user_collection(user_id, collection_name, {
            "source_channels": data.get("source_channels", []),
            "target_channels": data.get("target_channels", []),
            "enabled": data.get("enabled", True),
        })
        return {"status": "ok", "collection_name": collection_name}
    except Exception as e:
        logger.exception("[COLLECTION] save_collection failed")
        return {"status": "error", "message": str(e)}

@router.post("/collection/delete")
def delete_collection(request: Request, data: dict = Body(...)):
    try:
        collection_name = data.get("collection_name")
        if not collection_name:
            return {"status": "error", "message": "Missing collection_name"}

        if is_admin_request(request):
            db = get_db()
            used_by = db.get_collection_bots(collection_name)
            if used_by:
                return {
                    "status": "error",
                    "blocked": True,
                    "message": f"Cannot delete: collection is used by bot(s): {', '.join(used_by)}",
                    "used_by": used_by,
                }
            all_colls = db.get_all_collections()
            coll_data = all_colls.get(collection_name)
            if coll_data:
                db.recycle_bin_add('collection', collection_name, {**coll_data, 'name': collection_name})
            if db.delete_collection(collection_name):
                return {"status": "ok"}
            return {"status": "error", "message": "Collection not found"}

        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"status": "error", "message": "Not authenticated"}, status_code=401)
        db = get_db()
        if db.delete_user_collection(user_id, collection_name):
            return {"status": "ok"}
        return {"status": "error", "message": "Collection not found"}
    except Exception as e:
        logger.exception("[COLLECTION] delete_collection failed")
        return {"status": "error", "message": str(e)}

@router.post("/collection/rename")
def rename_collection(request: Request, data: dict = Body(...)):
    try:
        old_name = data.get("old_name")
        new_name = data.get("new_name", "").strip()
        if not old_name or not new_name:
            return {"status": "error", "message": "Missing old_name or new_name"}
        if old_name == new_name:
            return {"status": "ok"}

        if is_admin_request(request):
            db = get_db()
            return db.rename_collection(old_name, new_name)

        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"status": "error", "message": "Not authenticated"}, status_code=401)
        db = get_db()
        return db.rename_user_collection(user_id, old_name, new_name)
    except Exception as e:
        logger.exception("[COLLECTION] rename_collection failed")
        return {"status": "error", "message": str(e)}

@router.post("/collection/toggle")
def toggle_collection(request: Request, data: dict = Body(...)):
    try:
        collection_name = data.get("collection_name")
        enabled = data.get("enabled")
        if not collection_name or enabled is None:
            return {"status": "error", "message": "Missing required fields"}

        if is_admin_request(request):
            db = get_db()
            if db.toggle_collection(collection_name, enabled):
                return {"status": "ok", "enabled": enabled}
            return {"status": "error", "message": "Collection not found"}

        user_id = get_request_user_id(request)
        if not user_id:
            return JSONResponse({"status": "error", "message": "Not authenticated"}, status_code=401)
        db = get_db()
        if db.toggle_user_collection(user_id, collection_name, enabled):
            return {"status": "ok", "enabled": enabled}
        return {"status": "error", "message": "Collection not found"}
    except Exception as e:
        logger.exception("[COLLECTION] toggle_collection failed")
        return {"status": "error", "message": str(e)}
