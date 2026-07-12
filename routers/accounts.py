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
    try:
        _require_admin(request)
        db = get_db()

        users = db.get_all_users()

        # Attach inheritance data to each user
        for user in users:
            user["bot_inheritances"]        = db.get_user_bot_inheritances(user["id"])
            user["yt_inheritances"]         = db.get_user_yt_inheritances(user["id"])
            user["collection_inheritances"] = db.get_user_collection_inheritances(user["id"])

        # Available resources for the admin to assign
        bots        = db.get_bots_flat()
        categories  = db.get_categories_topics_flat()
        collections = list(db.get_all_collections().keys())

        # YouTube resources (from yt_db)
        yt_channels, yt_keywords = [], []
        try:
            from youtube_monitor.db import get_yt_db
            yt_db        = get_yt_db()
            yt_channels  = yt_db.get_channels()
            yt_keywords  = yt_db.get_keywords()
        except Exception:
            pass

        plans = db.get_ai_plans()

        return {
            "users":                users,
            "available_bots":       bots,
            "categories":           categories,
            "available_collections": collections,
            "yt_channels":          yt_channels,
            "yt_keywords":          yt_keywords,
            "ai_plans":             plans,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] list_accounts failed")
        return {"status": "error", "message": str(e)}


# ── Update user settings ──────────────────────────────────────────────────────

class UpdateUserRequest(BaseModel):
    is_active:    Optional[bool] = None
    bots_on:      Optional[bool] = None
    youtube_on:   Optional[bool] = None
    yt_chat_on:   Optional[bool] = None
    agents_on:    Optional[bool] = None
    sys_bot_on:   Optional[bool] = None
    seo_visible:  Optional[bool] = None   # whether user can see full SEO keyword details
    agents_limit: Optional[dict] = None   # {"type": "money"|"calls", "value": 10.0}
    ai_plan_id:   Optional[int]  = None


@router.post("/admin/accounts/{user_id}/update")
def update_user(user_id: int, req: UpdateUserRequest, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        if not db.get_user_by_id(user_id):
            raise HTTPException(404, "User not found")

        # Include fields that were explicitly set (even if set to null, e.g. clearing ai_plan_id)
        kwargs = {k: v for k, v in req.dict().items() if k in req.__fields_set__}
        if not kwargs:
            return {"status": "ok"}
        db.update_user(user_id, **kwargs)
        # Kick out active sessions immediately when deactivating
        if kwargs.get("is_active") is False:
            from routers.auth import revoke_all_tokens_for_user
            revoke_all_tokens_for_user(user_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] update_user failed")
        return {"status": "error", "message": str(e)}


# ── AI Plans CRUD ─────────────────────────────────────────────────────────────

@router.get("/admin/plans")
def list_plans(request: Request):
    try:
        _require_admin(request)
        db = get_db()
        return {"plans": db.get_ai_plans()}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] list_plans failed")
        return {"status": "error", "message": str(e)}


class PlanRequest(BaseModel):
    name:          str
    description:   Optional[str] = ""
    monthly_limit: int


@router.post("/admin/plans")
def create_plan(req: PlanRequest, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        plan_id = db.create_ai_plan(req.name.strip(), req.description or "", req.monthly_limit)
        return {"status": "ok", "id": plan_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] create_plan failed")
        return {"status": "error", "message": str(e)}


class UpdatePlanRequest(BaseModel):
    name:          Optional[str] = None
    description:   Optional[str] = None
    monthly_limit: Optional[int] = None


@router.post("/admin/plans/{plan_id}/update")
def update_plan(plan_id: int, req: UpdatePlanRequest, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        if not db.get_ai_plan(plan_id):
            raise HTTPException(404, "Plan not found")
        kwargs = {k: v for k, v in req.dict().items() if v is not None}
        if kwargs:
            db.update_ai_plan(plan_id, **kwargs)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] update_plan failed")
        return {"status": "error", "message": str(e)}


@router.post("/admin/plans/{plan_id}/delete")
def delete_plan(plan_id: int, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        plan = db.get_ai_plan(plan_id)
        if not plan:
            raise HTTPException(404, "Plan not found")
        if plan.get("is_default"):
            raise HTTPException(400, "Cannot delete default plans — edit their limits instead")
        db.delete_ai_plan(plan_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] delete_plan failed")
        return {"status": "error", "message": str(e)}



# ── Delete user ───────────────────────────────────────────────────────────────

@router.post("/admin/accounts/{user_id}/delete")
def delete_user(user_id: int, request: Request):
    try:
        _require_admin(request)
        db   = get_db()
        user = db.get_user_by_id(user_id)
        if not user:
            raise HTTPException(404, "User not found")
        if user["role"] == "admin":
            raise HTTPException(400, "Cannot delete the admin account")
        db.delete_user(user_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] delete_user failed")
        return {"status": "error", "message": str(e)}


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
    try:
        _require_admin(request)
        db = get_db()
        if not db.get_user_by_id(user_id):
            raise HTTPException(404, "User not found")
        db.upsert_user_bot_inheritance(user_id, bot_id, req.dict())
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] grant_bot failed")
        return {"status": "error", "message": str(e)}


@router.post("/admin/accounts/{user_id}/bots/{bot_id}/delete")
def revoke_bot(user_id: int, bot_id: int, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        db.delete_user_bot_inheritance(user_id, bot_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] revoke_bot failed")
        return {"status": "error", "message": str(e)}


# ── Per-topic inheritance settings ────────────────────────────────────────────

class TopicSettingsRequest(BaseModel):
    include_schedules: Optional[bool] = None
    include_prompts:   Optional[bool] = None
    keyword_pct:       Optional[int]  = None   # 0-100
    seo_visible:       Optional[bool] = None


@router.post("/admin/accounts/{user_id}/bots/{bot_id}/topics/{topic_id}")
def update_topic_settings(user_id: int, bot_id: int, topic_id: int,
                           req: TopicSettingsRequest, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        inh_id = db.get_bot_inheritance_id(user_id, bot_id)
        if inh_id is None:
            raise HTTPException(404, "Bot inheritance not found")
        settings = {k: v for k, v in req.dict().items() if v is not None}
        db.upsert_topic_settings(inh_id, topic_id, settings)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] update_topic_settings failed")
        return {"status": "error", "message": str(e)}


@router.post("/admin/accounts/{user_id}/bots/{bot_id}/topics/{topic_id}/delete")
def delete_topic_settings(user_id: int, bot_id: int, topic_id: int, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        inh_id = db.get_bot_inheritance_id(user_id, bot_id)
        if inh_id is None:
            raise HTTPException(404, "Bot inheritance not found")
        db.delete_topic_settings(inh_id, topic_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] delete_topic_settings failed")
        return {"status": "error", "message": str(e)}


# ── Collection inheritance ────────────────────────────────────────────────────

@router.post("/admin/accounts/{user_id}/collections/{collection_name}")
def grant_collection(user_id: int, collection_name: str, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        if not db.get_user_by_id(user_id):
            raise HTTPException(404, "User not found")
        db.grant_collection_inheritance(user_id, collection_name)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] grant_collection failed")
        return {"status": "error", "message": str(e)}


@router.post("/admin/accounts/{user_id}/collections/{collection_name}/delete")
def revoke_collection(user_id: int, collection_name: str, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        db.revoke_collection_inheritance(user_id, collection_name)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] revoke_collection failed")
        return {"status": "error", "message": str(e)}


# ── YouTube inheritance ───────────────────────────────────────────────────────

class PushYtRequest(BaseModel):
    source_type: str   # 'channel' | 'keyword'
    source_id:   int
    source_name: str
    continuous:  bool = False


@router.post("/admin/accounts/{user_id}/youtube")
def push_youtube(user_id: int, req: PushYtRequest, request: Request):
    try:
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
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] push_youtube failed")
        return {"status": "error", "message": str(e)}


class UpdateYtRequest(BaseModel):
    continuous: Optional[bool] = None
    status:     Optional[str]  = None   # 'pending' | 'confirmed' | 'rejected'


@router.post("/admin/accounts/{user_id}/youtube/{inh_id}/update")
def update_youtube(user_id: int, inh_id: int, req: UpdateYtRequest, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        kwargs = {k: v for k, v in req.dict().items() if v is not None}
        if kwargs:
            db.update_yt_inheritance(inh_id, **kwargs)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] update_youtube failed")
        return {"status": "error", "message": str(e)}


@router.post("/admin/accounts/{user_id}/youtube/{inh_id}/delete")
def delete_youtube(user_id: int, inh_id: int, request: Request):
    try:
        _require_admin(request)
        db = get_db()
        db.delete_yt_inheritance(inh_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[ACCOUNTS] delete_youtube failed")
        return {"status": "error", "message": str(e)}
