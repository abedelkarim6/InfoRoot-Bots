from fastapi import APIRouter, Body
from utils.database import get_db

router = APIRouter()

@router.get("/collections")
def get_collections():
    db = get_db()
    return db.get_all_collections()

@router.post("/collection/save")
def save_collection(data: dict = Body(...)):
    collection_name = data.get("collection_name")
    target_channels = data.get("target_channels", [])

    if not collection_name:
        return {"status": "error", "message": "Missing collection_name"}
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

@router.post("/collection/delete")
def delete_collection(data: dict = Body(...)):
    collection_name = data.get("collection_name")
    if not collection_name:
        return {"status": "error", "message": "Missing collection_name"}

    db = get_db()
    if db.delete_collection(collection_name):
        return {"status": "ok"}
    return {"status": "error", "message": "Collection not found"}

@router.post("/collection/toggle")
def toggle_collection(data: dict = Body(...)):
    collection_name = data.get("collection_name")
    enabled = data.get("enabled")

    if not collection_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}

    db = get_db()
    if db.toggle_collection(collection_name, enabled):
        return {"status": "ok", "enabled": enabled}
    return {"status": "error", "message": "Collection not found"}
