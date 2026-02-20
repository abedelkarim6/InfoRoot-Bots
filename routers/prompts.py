from fastapi import APIRouter, Body
from utils.helpers import load_prompts, save_prompts

router = APIRouter()

@router.get("/prompts")
def get_all_prompts():
    """Get all prompts organized by bot"""
    prompts = load_prompts()
    return prompts.get("bots", {})

@router.get("/prompts/{bot_name}")
def get_bot_prompts(bot_name: str):
    """Get prompts for a specific bot"""
    prompts = load_prompts()
    return prompts.get("bots", {}).get(bot_name, {})

@router.post("/prompts/update")
def update_prompt(data: dict = Body(...)):
    """Update or add a prompt for a specific bot"""
    bot_name = data.get("bot_name")
    key = data["key"]
    text = data["text"]

    if not bot_name:
        return {"status": "error", "message": "bot_name is required"}

    prompts = load_prompts()
    prompts.setdefault("bots", {}).setdefault(bot_name, {})[key] = text
    save_prompts(prompts)
    return {"status": "ok", "key": key, "bot_name": bot_name}

@router.post("/prompts/delete")
def delete_prompt(data: dict = Body(...)):
    """Delete a prompt from a specific bot"""
    bot_name = data.get("bot_name")
    key = data["key"]

    if not bot_name:
        return {"status": "error", "message": "bot_name is required"}

    prompts = load_prompts()
    if "bots" in prompts and bot_name in prompts["bots"] and key in prompts["bots"][bot_name]:
        del prompts["bots"][bot_name][key]
        save_prompts(prompts)
    return {"status": "ok"}
