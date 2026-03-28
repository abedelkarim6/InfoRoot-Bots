"""
Admin accounts management router.
All endpoints require the requesting user to have role = 'admin'.
"""

import json
import logging
from typing import Optional, List

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from utils.database import get_db
from routers.auth import validate_token, get_token_user_id, _get_bearer

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Admin guard ───────────────────────────────────────────────────────────────

def _require_admin(request: Request):
    token = _get_bearer(request)
    if not token or not validate_token(token):
        raise HTTPException(401, "Not authenticated")
    user_id = get_token_user_id(token)
    if user_id is None:
        return  # legacy admin token (pre-DB-migration) — allow
    db   = get_db()
    user = db.get_user_by_id(user_id)
    if not user or user["role"] != "admin":
        raise HTTPException(403, "Admin access required")


# ── List / detail ─────────────────────────────────────────────────────────────

@router.get("/admin/accounts")
def list_accounts(request: Request):
    _require_admin(request)
    db = get_db()

    users = db.get_all_users()

    # Attach inheritance data to each user
    for user in users:
        user["bot_inheritances"] = db.get_user_bot_inheritances(user["id"])
        user["yt_inheritances"]  = db.get_user_yt_inheritances(user["id"])

    # Available resources for the admin to assign
    bots       = db.get_bots_flat()
    categories = db.get_categories_topics_flat()

    # YouTube resources (from yt_db)
    yt_channels, yt_keywords = [], []
    try:
        from youtube_monitor.db import get_yt_db
        yt_db        = get_yt_db()
        yt_channels  = yt_db.get_channels()
        yt_keywords  = yt_db.get_keywords()
    except Exception:
        pass

    return {
        "users":          users,
        "available_bots": bots,
        "categories":     categories,
        "yt_channels":    yt_channels,
        "yt_keywords":    yt_keywords,
    }


# ── Update user settings ──────────────────────────────────────────────────────

class UpdateUserRequest(BaseModel):
    is_active:   Optional[bool] = None
    youtube_on:  Optional[bool] = None
    agents_on:   Optional[bool] = None
    agents_limit: Optional[dict] = None   # {"type": "money"|"calls", "value": 10.0}


@router.post("/admin/accounts/{user_id}/update")
def update_user(user_id: int, req: UpdateUserRequest, request: Request):
    _require_admin(request)
    db = get_db()
    if not db.get_user_by_id(user_id):
        raise HTTPException(404, "User not found")

    kwargs = {k: v for k, v in req.dict().items() if v is not None}
    if not kwargs:
        return {"status": "ok"}
    db.update_user(user_id, **kwargs)
    return {"status": "ok"}


# ── Delete user ───────────────────────────────────────────────────────────────

@router.post("/admin/accounts/{user_id}/delete")
def delete_user(user_id: int, request: Request):
    _require_admin(request)
    db   = get_db()
    user = db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user["role"] == "admin":
        raise HTTPException(400, "Cannot delete the admin account")
    db.delete_user(user_id)
    return {"status": "ok"}


# ── Bot inheritance ───────────────────────────────────────────────────────────

class BotInheritanceRequest(BaseModel):
    inherit_categories: List[int] = []      # empty = all
    inherit_topics:     List[int] = []      # empty = all
    inherit_keywords:   bool = True
    inherit_rules:      bool = True
    inherit_prompts:    bool = True
    inherit_messages_db: bool = False


@router.post("/admin/accounts/{user_id}/bots/{bot_id}")
def grant_bot(user_id: int, bot_id: int, req: BotInheritanceRequest, request: Request):
    _require_admin(request)
    db = get_db()
    if not db.get_user_by_id(user_id):
        raise HTTPException(404, "User not found")
    db.upsert_user_bot_inheritance(user_id, bot_id, req.dict())
    return {"status": "ok"}


@router.post("/admin/accounts/{user_id}/bots/{bot_id}/delete")
def revoke_bot(user_id: int, bot_id: int, request: Request):
    _require_admin(request)
    db = get_db()
    db.delete_user_bot_inheritance(user_id, bot_id)
    return {"status": "ok"}


# ── YouTube inheritance ───────────────────────────────────────────────────────

class PushYtRequest(BaseModel):
    source_type: str   # 'channel' | 'keyword'
    source_id:   int
    source_name: str
    continuous:  bool = False


@router.post("/admin/accounts/{user_id}/youtube")
def push_youtube(user_id: int, req: PushYtRequest, request: Request):
    _require_admin(request)
    db = get_db()
    if not db.get_user_by_id(user_id):
        raise HTTPException(404, "User not found")
    if req.source_type not in ("channel", "keyword"):
        raise HTTPException(400, "source_type must be 'channel' or 'keyword'")
    inh_id = db.push_yt_inheritance(
        user_id, req.source_type, req.source_id, req.source_name, req.continuous
    )
    return {"status": "ok", "id": inh_id}


class UpdateYtRequest(BaseModel):
    continuous: Optional[bool] = None
    status:     Optional[str]  = None   # 'pending' | 'confirmed' | 'rejected'


@router.post("/admin/accounts/{user_id}/youtube/{inh_id}/update")
def update_youtube(user_id: int, inh_id: int, req: UpdateYtRequest, request: Request):
    _require_admin(request)
    db = get_db()
    kwargs = {k: v for k, v in req.dict().items() if v is not None}
    if kwargs:
        db.update_yt_inheritance(inh_id, **kwargs)
    return {"status": "ok"}


@router.post("/admin/accounts/{user_id}/youtube/{inh_id}/delete")
def delete_youtube(user_id: int, inh_id: int, request: Request):
    _require_admin(request)
    db = get_db()
    db.delete_yt_inheritance(inh_id)
    return {"status": "ok"}
