from fastapi import APIRouter, Body
from fastapi import Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

router = APIRouter()

@router.get("/collections")
def get_collections(request: Request):
    db = get_db()
    if is_admin_request(request):
        return db.get_all_collections()
    user_id = get_request_user_id(request)
    if not user_id:
        return {}
    return db.get_user_collections(user_id)

@router.post("/collection/save")
def save_collection(request: Request, data: dict = Body(...)):
    collection_name = data.get("collection_name")
    if not collection_name:
        return {"status": "error", "message": "Missing collection_name"}

    if is_admin_request(request):
        target_channels = data.get("target_channels", [])
        if not target_channels or not isinstance(target_channels, list):
            return {"status": "error", "message": "At least one target channel required"}
        db = get_db()
        db.save_collection(collection_name, {
            "name": data.get("name", collection_name),
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
        "name": data.get("name", collection_name),
        "source_channels": data.get("source_channels", []),
        "target_channels": data.get("target_channels", []),
        "enabled": data.get("enabled", True),
    })
    return {"status": "ok", "collection_name": collection_name}

@router.post("/collection/delete")
def delete_collection(request: Request, data: dict = Body(...)):
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

@router.post("/collection/toggle")
def toggle_collection(request: Request, data: dict = Body(...)):
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
