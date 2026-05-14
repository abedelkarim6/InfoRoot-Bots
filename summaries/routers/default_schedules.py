"""
Global default schedules — shared across every summaries bot.

Endpoints:
  GET    /api/default-schedules              → list
  POST   /api/default-schedules/add          → create
  POST   /api/default-schedules/update       → update by id
  POST   /api/default-schedules/delete       → delete by id
"""

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from utils.database import get_db
from routers.auth import is_admin_request, get_request_user_id

router = APIRouter()


def _owner_id(request: Request):
    if is_admin_request(request):
        return None
    return get_request_user_id(request)


@router.get("/default-schedules")
def list_defaults(request: Request):
    if not is_admin_request(request):
        uid = get_request_user_id(request)
        if not uid:
            return {"status": "ok", "schedules": []}
        return {"status": "ok", "schedules": get_db().list_default_schedules(owner_id=uid)}
    return {"status": "ok", "schedules": get_db().list_default_schedules(owner_id=None)}


@router.post("/default-schedules/add")
def add_default(request: Request, data: dict = Body(...)):
    if not (data.get('name') or '').strip():
        return {"status": "error", "message": "name is required"}
    ds_id = get_db().add_default_schedule(data, owner_id=_owner_id(request))
    if not ds_id:
        return {"status": "error", "message": "Could not create default schedule"}
    return {"status": "ok", "id": ds_id}


@router.post("/default-schedules/update")
def update_default(request: Request, data: dict = Body(...)):
    ds_id = data.get('id')
    if not ds_id:
        return {"status": "error", "message": "id is required"}
    ok = get_db().update_default_schedule(int(ds_id), data, owner_id=_owner_id(request))
    if not ok:
        return JSONResponse({"status": "error", "message": "Not found"}, status_code=404)
    return {"status": "ok"}


@router.post("/default-schedules/delete")
def delete_default(request: Request, data: dict = Body(...)):
    ds_id = data.get('id')
    if not ds_id:
        return {"status": "error", "message": "id is required"}
    ok = get_db().delete_default_schedule(int(ds_id), owner_id=_owner_id(request))
    if not ok:
        return JSONResponse({"status": "error", "message": "Not found"}, status_code=404)
    return {"status": "ok"}
