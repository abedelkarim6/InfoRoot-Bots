from fastapi import APIRouter, Body
from utils.helpers import load_config, save_config

router = APIRouter()

@router.get("/rules")
def get_rules():
    cfg = load_config()
    return cfg.get('rules', {"remove": [], "replace": []})

@router.post("/rules/update")
def update_rules(data: dict = Body(...)):
    """Update message processing rules in config.yaml

    Expects: { remove: [keywords], replace: [{match, replace_with}, ...] }
    """
    cfg = load_config()
    cfg['rules'] = data
    save_config(cfg)
    return {"status": "updated"}
