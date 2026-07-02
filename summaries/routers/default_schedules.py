"""
Global default schedules — shared across every summaries bot.

Endpoints:
  GET    /api/default-schedules              → list
  POST   /api/default-schedules/add          → create
  POST   /api/default-schedules/update       → update by id
  POST   /api/default-schedules/delete       → delete by id
"""

import logging

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

logger = logging.getLogger(__name__)
router = APIRouter()


def _owner_id(request: Request):
    if is_admin_request(request):
        return None
    return get_request_user_id(request)


@router.get("/default-schedules")
def list_defaults(request: Request):
    try:
        if not is_admin_request(request):
            uid = get_request_user_id(request)
            if not uid:
                return {"status": "ok", "schedules": []}
            return {"status": "ok", "schedules": get_db().list_default_schedules(owner_id=uid)}
        return {"status": "ok", "schedules": get_db().list_default_schedules(owner_id=None)}
    except Exception as e:
        logger.exception("[DEFAULT-SCHED] list_defaults failed")
        return {"status": "error", "message": str(e)}


@router.post("/default-schedules/add")
def add_default(request: Request, data: dict = Body(...)):
    try:
        if not (data.get('name') or '').strip():
            return {"status": "error", "message": "name is required"}
        ds_id = get_db().add_default_schedule(data, owner_id=_owner_id(request))
        if not ds_id:
            return {"status": "error", "message": "Could not create default schedule"}
        return {"status": "ok", "id": ds_id}
    except Exception as e:
        logger.exception("[DEFAULT-SCHED] add_default failed")
        return {"status": "error", "message": str(e)}


@router.post("/default-schedules/update")
def update_default(request: Request, data: dict = Body(...)):
    try:
        ds_id = data.get('id')
        if not ds_id:
            return {"status": "error", "message": "id is required"}
        ok = get_db().update_default_schedule(int(ds_id), data, owner_id=_owner_id(request))
        if not ok:
            return JSONResponse({"status": "error", "message": "Not found"}, status_code=404)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[DEFAULT-SCHED] update_default failed")
        return {"status": "error", "message": str(e)}


@router.post("/default-schedules/delete")
def delete_default(request: Request, data: dict = Body(...)):
    try:
        ds_id = data.get('id')
        if not ds_id:
            return {"status": "error", "message": "id is required"}
        ok = get_db().delete_default_schedule(int(ds_id), owner_id=_owner_id(request))
        if not ok:
            return JSONResponse({"status": "error", "message": "Not found"}, status_code=404)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[DEFAULT-SCHED] delete_default failed")
        return {"status": "error", "message": str(e)}
