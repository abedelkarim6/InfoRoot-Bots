import logging

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/rules")
def get_rules():
    try:
        db = get_db()
        return db.get_global_rules()
    except Exception as e:
        logger.exception("[RULES] get_rules failed")
        return {"status": "error", "message": str(e)}

@router.post("/rules/update")
def update_rules(request: Request, data: dict = Body(...)):
    try:
        if not is_admin_request(request):
            return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)
        db = get_db()
        db.set_global_rules(data)
        return {"status": "updated"}
    except Exception as e:
        logger.exception("[RULES] update_rules failed")
        return {"status": "error", "message": str(e)}
