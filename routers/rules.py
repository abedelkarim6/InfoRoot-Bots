from fastapi import APIRouter, Body
from utils.database import get_db

router = APIRouter()

@router.get("/rules")
def get_rules():
    db = get_db()
    return db.get_global_rules()

@router.post("/rules/update")
def update_rules(data: dict = Body(...)):
    db = get_db()
    db.set_global_rules(data)
    return {"status": "updated"}
