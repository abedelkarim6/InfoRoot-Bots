from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request

router = APIRouter()

@router.get("/rules")
def get_rules():
    db = get_db()
    return db.get_global_rules()

@router.post("/rules/update")
def update_rules(request: Request, data: dict = Body(...)):
    if not is_admin_request(request):
        return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)
    db = get_db()
    db.set_global_rules(data)
    return {"status": "updated"}
