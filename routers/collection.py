from fastapi import APIRouter, Body
from utils.helpers import load_config, save_config

router = APIRouter()

@router.get("/collections")
def get_collections():
    """Get all collections with auto-migration from old format"""
    cfg = load_config()
    collections = cfg.get("collections", {})

    # Auto-migrate old format (target_channel -> target_channels)
    for name, collection in collections.items():
        if "target_channel" in collection and "target_channels" not in collection:
            collection["target_channels"] = [collection["target_channel"]]
            del collection["target_channel"]

    save_config(cfg)
    return collections

@router.post("/collection/save")
def save_collection(data: dict = Body(...)):
    """Create or update a collection

    Expects: {
        name: str,
        collection_name: str,  # Unique identifier
        source_channels: [str],  # Array of source channel usernames/IDs
        target_channels: [str],  # Array of target channel usernames/IDs (multiple supported)
        enabled: bool
    }
    """
    collection_name = data.get("collection_name")
    target_channels = data.get("target_channels", [])

    if not collection_name:
        return {"status": "error", "message": "Missing collection_name"}

    # Validation: at least one target channel required
    if not target_channels or not isinstance(target_channels, list):
        return {"status": "error", "message": "At least one target channel required"}

    cfg = load_config()
    collections = cfg.setdefault("collections", {})

    collections[collection_name] = {
        "name": data.get("name", collection_name),
        "source_channels": data.get("source_channels", []),
        "target_channels": target_channels,  # Array instead of string
        "enabled": data.get("enabled", True)
    }

    save_config(cfg)

    return {
        "status": "ok",
        "collection_name": collection_name
    }

@router.post("/collection/delete")
def delete_collection(data: dict = Body(...)):
    """Delete a collection"""
    collection_name = data.get("collection_name")
    if not collection_name:
        return {"status": "error", "message": "Missing collection_name"}
    
    cfg = load_config()
    collections = cfg.get("collections", {})
    
    if collection_name in collections:
        del collections[collection_name]
        save_config(cfg)
        return {"status": "ok"}
    
    return {"status": "error", "message": "Collection not found"}

@router.post("/collection/toggle")
def toggle_collection(data: dict = Body(...)):
    """Enable/disable a collection"""
    collection_name = data.get("collection_name")
    enabled = data.get("enabled")
    
    if not collection_name or enabled is None:
        return {"status": "error", "message": "Missing required fields"}
    
    cfg = load_config()
    collections = cfg.get("collections", {})
    
    if collection_name in collections:
        collections[collection_name]["enabled"] = enabled
        save_config(cfg)
        return {"status": "ok", "enabled": enabled}
    
    return {"status": "error", "message": "Collection not found"}
