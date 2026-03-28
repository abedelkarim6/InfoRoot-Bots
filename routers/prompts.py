from fastapi import APIRouter, Body
from utils.database import get_db

router = APIRouter()

@router.get("/prompts")
def get_all_prompts():
    db = get_db()
    return db.get_all_prompts()

@router.get("/prompts/{bot_name}")
def get_bot_prompts(bot_name: str):
    db = get_db()
    return db.get_bot_prompts(bot_name)

@router.post("/prompts/update")
def update_prompt(data: dict = Body(...)):
    bot_name = data.get("bot_name")
    key = data.get("key")
    text = data.get("text", "")

    if not bot_name:
        return {"status": "error", "message": "bot_name is required"}
    if not key:
        return {"status": "error", "message": "key is required"}

    db = get_db()
    db.save_prompt(bot_name, key, text)
    return {"status": "ok", "key": key, "bot_name": bot_name}

@router.post("/prompts/delete")
def delete_prompt(data: dict = Body(...)):
    bot_name = data.get("bot_name")
    key = data.get("key")

    if not bot_name:
        return {"status": "error", "message": "bot_name is required"}

    db = get_db()
    # Snapshot prompt for recycle bin
    prompts = db.get_bot_prompts(bot_name)
    if key in prompts:
        db.recycle_bin_add('prompt', f"{bot_name}/{key}", {
            'bot_name': bot_name, 'key': key, 'text': prompts[key].get('text', '')
        })

    db.delete_prompt(bot_name, key)
    return {"status": "ok"}
