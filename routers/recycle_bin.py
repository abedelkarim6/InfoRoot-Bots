import logging

from fastapi import APIRouter, Body
from utils.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/recycle-bin/list")
def list_recycle_bin():
    try:
        db = get_db()
        items = db.recycle_bin_list()
        return {"status": "ok", "items": items}
    except Exception as e:
        logger.error(f"[RECYCLE-BIN] list failed: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}


@router.post("/recycle-bin/restore")
def restore_item(data: dict = Body(...)):
    item_id = data.get("id")
    if item_id is None:
        return {"status": "error", "message": "Missing id"}

    db = get_db()
    # Fetch item from recycle bin
    cursor = db._get_cursor()
    cursor.execute("SELECT * FROM recycle_bin WHERE id = %s", (item_id,))
    row = cursor.fetchone()
    if not row:
        return {"status": "error", "message": "Item not found in recycle bin"}

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

    # Remove from recycle bin after successful restore
    db.recycle_bin_delete(item_id)
    return {"status": "ok", "entity_type": entity_type}


@router.post("/recycle-bin/delete")
def permanently_delete(data: dict = Body(...)):
    item_id = data.get("id")
    if item_id is None:
        return {"status": "error", "message": "Missing id"}

    db = get_db()
    if db.recycle_bin_delete(item_id):
        return {"status": "ok"}
    return {"status": "error", "message": "Item not found"}


@router.post("/recycle-bin/empty")
def empty_recycle_bin():
    db = get_db()
    cursor = db._get_cursor()
    cursor.execute("DELETE FROM recycle_bin")
    count = cursor.rowcount
    db.connection.commit()
    return {"status": "ok", "deleted": count}
