"""
SEO Library router — write-through proxy over the external "telegram-api"
platform's SEO library (categories → keyword-groups → keywords).

The external platform is the source of truth. Each mutation here calls the
platform first (summaries/seo_external.py), then re-syncs our local mirror
(db.sync_seo_library) so the categorizer hot path + topic attachment keep
working. All ids exchanged with the frontend are the platform's UUIDs.

Access control:
  - Reading the library is allowed for any authenticated user (bot owners need
    it to attach groups to their topics).
  - Mutating the library is admin-only.
  - Attaching/detaching groups on a topic follows the bot's access rules.
"""

import logging

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from utils.database import get_db
from utils.helpers import invalidate_categorizer_cache
from routers.auth import is_admin_request
from summaries.routers.topic import _resolve_bot_access
from summaries import seo_external
from summaries.seo_external import ExternalSeoError

router = APIRouter()
logger = logging.getLogger(__name__)


def _admin_guard(request: Request):
    if not is_admin_request(request):
        return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
    return None


def _resync_mirror():
    """Pull the external library and reconcile our local mirror. Best-effort:
    logs but doesn't raise, so a mutation that already succeeded externally
    still returns ok."""
    try:
        cats = seo_external.list_categories()
        groups = seo_external.list_groups()
        get_db().sync_seo_library(cats, groups)
        invalidate_categorizer_cache()
    except Exception as e:
        logger.warning(f"[SEO] mirror re-sync failed: {e}")


def _resync_replace_mirror():
    """Pull the external replace-groups and reconcile our local mirror so the
    bots' message-rewrite step sees fresh pairs. Best-effort."""
    try:
        groups = seo_external.list_replace_groups()
        get_db().sync_replace_library(groups)
        invalidate_categorizer_cache()
    except Exception as e:
        logger.warning(f"[SEO] replace mirror re-sync failed: {e}")


def _err(e: ExternalSeoError):
    return JSONResponse({"status": "error", "message": f"Platform error: {e}"}, status_code=502)


def _kw_list(group: dict) -> list:
    out = []
    for k in (group.get("keywords") or []):
        kw = k.get("keyword") if isinstance(k, dict) else k
        if kw:
            out.append(kw)
    return out


# ==================== Library read ====================

@router.get("/seo/library")
def get_seo_library(request: Request):
    try:
        try:
            categories = seo_external.list_categories()
            groups = seo_external.list_groups()
        except ExternalSeoError as e:
            return _err(e)

        db = get_db()
        db.sync_seo_library(categories, groups)
        invalidate_categorizer_cache()
        usage = db.get_seo_usage_by_ext()

        groups_by_cat: dict = {}
        uncategorized: list = []
        for g in groups:
            item = {
                "id": g.get("id"),
                "name": g.get("name"),
                "enabled": bool(g.get("enabled", True)),
                "position": g.get("order") or 0,
                "keywords": _kw_list(g),
                "used_by": usage.get(g.get("id"), []),
            }
            cid = g.get("categoryId")
            (groups_by_cat.setdefault(cid, []) if cid else uncategorized).append(item)

        out = []
        for c in sorted(categories, key=lambda x: (x.get("order") or 0)):
            cgroups = groups_by_cat.get(c.get("id"), [])
            # Hide categories that belong only to the Replace tab (have replace
            # groups but no keyword groups). Truly-empty categories stay visible so
            # you can still add the first group.
            if not cgroups and (c.get("_count") or {}).get("replaceGroups", 0):
                continue
            out.append({
                "id": c.get("id"),
                "name": c.get("name"),
                "position": c.get("order") or 0,
                "groups": cgroups,
            })
        if uncategorized:
            out.append({"id": None, "name": "Uncategorized", "position": 9999, "groups": uncategorized})
        return {"status": "ok", "categories": out}
    except Exception as e:
        logger.exception("[SEO] get_seo_library failed")
        return {"status": "error", "message": str(e)}


@router.get("/seo/library/mirror")
def get_seo_library_mirror(request: Request):
    """Fast read of the SEO library from the local mirror only — no external
    platform call, no re-sync, no cache invalidation. Used by the topic
    'Attach SEO Groups' picker, which only needs group names + keyword counts.
    The mirror is refreshed by the full /seo/library endpoint (SEO Library page)."""
    try:
        return get_db().read_seo_library_mirror()
    except Exception as e:
        logger.exception("[SEO] get_seo_library_mirror failed")
        return {"status": "error", "message": str(e)}


# ==================== Categories ====================

@router.post("/seo/category/add")
def add_seo_category(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        name = (data.get("name") or "").strip()
        if not name:
            return {"status": "error", "message": "Category name required"}
        try:
            cat = seo_external.create_category(name)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok", "id": cat.get("id")}
    except Exception as e:
        logger.exception("[SEO] add_seo_category failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/category/rename")
def rename_seo_category(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        cat_id = data.get("id")
        name = (data.get("name") or "").strip()
        if not cat_id or not name:
            return {"status": "error", "message": "Missing required fields"}
        try:
            seo_external.update_category(cat_id, {"name": name})
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] rename_seo_category failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/category/delete")
def delete_seo_category(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        cat_id = data.get("id")
        if not cat_id:
            return {"status": "error", "message": "Missing category id"}
        try:
            seo_external.delete_category(cat_id)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] delete_seo_category failed")
        return {"status": "error", "message": str(e)}


# ==================== Groups ====================

@router.post("/seo/group/add")
def add_seo_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        category_id = data.get("category_id")
        name = (data.get("name") or "").strip()
        if not category_id or not name:
            return {"status": "error", "message": "Missing required fields"}
        try:
            g = seo_external.create_group(name, category_id)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok", "id": g.get("id")}
    except Exception as e:
        logger.exception("[SEO] add_seo_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/group/rename")
def rename_seo_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        name = (data.get("name") or "").strip()
        if not group_id or not name:
            return {"status": "error", "message": "Missing required fields"}
        try:
            seo_external.update_group(group_id, {"name": name})
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] rename_seo_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/group/toggle")
def toggle_seo_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        enabled = bool(data.get("enabled"))
        if not group_id:
            return {"status": "error", "message": "Missing group id"}
        try:
            seo_external.update_group(group_id, {"enabled": enabled})
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok", "enabled": enabled}
    except Exception as e:
        logger.exception("[SEO] toggle_seo_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/group/move")
def move_seo_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        category_id = data.get("category_id")
        if not group_id or not category_id:
            return {"status": "error", "message": "Missing required fields"}
        try:
            seo_external.move_group(group_id, category_id)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] move_seo_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/group/delete")
def delete_seo_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        if not group_id:
            return {"status": "error", "message": "Missing group id"}
        try:
            seo_external.delete_group(group_id)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] delete_seo_group failed")
        return {"status": "error", "message": str(e)}


# ==================== Group keywords ====================

@router.post("/seo/group/keywords/set")
def set_seo_group_keywords(request: Request, data: dict = Body(...)):
    """Reconcile a group's keywords to the given list by diffing against the
    platform's current set (the platform has no bulk-replace endpoint)."""
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("group_id")
        keywords = data.get("keywords")
        if not group_id or keywords is None:
            return {"status": "error", "message": "Missing required fields"}

        desired = []
        seen = set()
        for kw in keywords:
            kw = str(kw).strip()
            if kw and kw not in seen:
                seen.add(kw)
                desired.append(kw)

        try:
            group = seo_external.get_group(group_id)
            current = {}  # keyword text -> external keyword id
            for k in (group.get("keywords") or []):
                if isinstance(k, dict) and k.get("keyword"):
                    current[k["keyword"]] = k.get("id")
            to_add = [kw for kw in desired if kw not in current]
            to_remove = [(kw, kid) for kw, kid in current.items() if kw not in seen]
            if to_add:
                seo_external.add_keywords_bulk(group_id, to_add)
            for _kw, kid in to_remove:
                if kid:
                    seo_external.delete_keyword(group_id, kid)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] set_seo_group_keywords failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/group/keyword/add-bulk")
def add_seo_group_keywords_bulk(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("group_id")
        keywords = data.get("keywords") or []
        if not group_id or not keywords:
            return {"status": "error", "message": "Missing required fields"}
        clean = []
        seen = set()
        for kw in keywords:
            kw = str(kw).strip()
            if kw and kw not in seen:
                seen.add(kw)
                clean.append(kw)
        try:
            res = seo_external.add_keywords_bulk(group_id, clean)
        except ExternalSeoError as e:
            return _err(e)
        _resync_mirror()
        return {"status": "ok", "inserted": res.get("added", len(clean))}
    except Exception as e:
        logger.exception("[SEO] add_seo_group_keywords_bulk failed")
        return {"status": "error", "message": str(e)}


# ==================== AI keyword suggestion ====================

@router.post("/seo/group/suggest-seos")
async def suggest_group_seos(request: Request, data: dict = Body(...)):
    try:
        import json, re, asyncio, logging as _log
        _logger = _log.getLogger("suggest_group_seos")

        denied = _admin_guard(request)
        if denied:
            return denied

        group_id = data.get("group_id")
        group_name = (data.get("group_name") or "").strip()
        if not group_id:
            return {"status": "error", "message": "Missing group id"}

        count     = max(1, min(50, int(data.get("count") or 50)))
        languages = data.get("languages") or ["Arabic"]
        note      = (data.get("note") or "").strip()
        exclude   = data.get("exclude") or []

        try:
            existing_keywords = _kw_list(seo_external.get_group(group_id))
        except ExternalSeoError:
            existing_keywords = []
        topic_label = group_name or "this keyword group"

        from utils.helpers import load_config
        cfg = load_config()
        try:
            if cfg.get("gemini"):
                from utils.gemini_client import GeminiClient
                from utils.gemini_models import get_gemini_model
                llm = GeminiClient(
                    project=cfg["gemini"]["project"],
                    location=cfg["gemini"].get("location", "global"),
                    model=get_gemini_model(cfg),
                )
            else:
                from utils.openai_client import OpenAIClient
                oa = cfg["openai"]
                llm = OpenAIClient(
                    api_key=oa["api_key"], model=oa["model"],
                    max_tokens=oa["max_tokens"], temperature=oa["temperature"],
                )
        except Exception as e:
            return {"status": "error", "message": f"LLM not configured: {e}"}

        all_excluded = list(existing_keywords) + [str(e).strip() for e in exclude if e]
        excluded_str = ", ".join(all_excluded[:200]) if all_excluded else "none"

        lang_str  = ", ".join(languages) if languages else "Arabic"
        note_part = f"\n\nAdditional instructions: {note}" if note else ""

        prompt = f"""You are an SEO keyword expert for news monitoring.

Keyword group: {topic_label}

Keywords to EXCLUDE — already exist or were already suggested (do NOT return any of these):
{excluded_str}

Task: Suggest exactly {count} new, unique keywords for the keyword group "{topic_label}".
Rules:
- Keywords are used to match news messages to topics that use this group
- Use ONLY these languages: {lang_str}
- Include relevant variations, synonyms, related terms, and hashtag formats where appropriate
- Do NOT repeat any excluded keyword{note_part}
- Return ONLY a valid JSON array of strings — no explanation, no markdown, no extra text

Example: ["keyword1", "keyword2", ...]"""

        try:
            loop = asyncio.get_event_loop()
            response, _ = await loop.run_in_executor(None, llm.generate_summary, prompt)

            match = re.search(r'\[[\s\S]*\]', response)
            if not match:
                return {"status": "error", "message": "AI returned unexpected format — no JSON array found"}
            suggestions = json.loads(match.group(0))
            if not isinstance(suggestions, list):
                return {"status": "error", "message": "AI returned unexpected format"}

            excluded_lower = {kw.lower() for kw in all_excluded}
            seen: set = set()
            clean = []
            for s in suggestions:
                s = str(s).strip()
                if s and s.lower() not in excluded_lower and s.lower() not in seen:
                    seen.add(s.lower())
                    clean.append(s)

            return {"status": "ok", "suggestions": clean[:count]}
        except Exception as e:
            _logger.error(f"[SUGGEST-GROUP-SEOS] Error: {e}", exc_info=True)
            return {"status": "error", "message": f"AI error: {str(e)}"}
    except Exception as e:
        logger.exception("[SEO] suggest_group_seos failed")
        return {"status": "error", "message": str(e)}


# ==================== Replace-term groups ====================
#
# Same /seo/categories, but groups hold from→to "pairs" instead of keywords.
# Pure write-through to the platform (no local mirror — not consumed by our
# categorizer hot path). The platform requires ≥1 pair to create a group, and
# PATCH {pairs:[...]} fully replaces a group's pair set.

def _clean_pairs(raw) -> list:
    out = []
    for p in (raw or []):
        if not isinstance(p, dict):
            continue
        frm = str(p.get("from") or "").strip()
        to = str(p.get("to") or "")
        if not frm:
            continue
        out.append({"from": frm, "to": to, "enabled": bool(p.get("enabled", True))})
    return out


@router.get("/seo/replace-library")
def get_replace_library(request: Request):
    try:
        try:
            categories = seo_external.list_categories()
            groups = seo_external.list_replace_groups()
        except ExternalSeoError as e:
            return _err(e)

        db = get_db()
        db.sync_replace_library(groups)
        invalidate_categorizer_cache()
        usage = db.get_replace_usage_by_ext()

        groups_by_cat: dict = {}
        uncategorized: list = []
        for g in groups:
            pairs = [
                {"from": p.get("from", ""), "to": p.get("to", ""), "enabled": bool(p.get("enabled", True))}
                for p in (g.get("pairs") or [])
            ]
            item = {
                "id": g.get("id"),
                "name": g.get("name"),
                "description": g.get("description"),
                "enabled": bool(g.get("enabled", True)),
                "position": g.get("order") or 0,
                "pairs": pairs,
                "used_by": usage.get(g.get("id"), []),
            }
            cid = g.get("categoryId")
            (groups_by_cat.setdefault(cid, []) if cid else uncategorized).append(item)

        out = []
        for c in sorted(categories, key=lambda x: (x.get("order") or 0)):
            cgroups = groups_by_cat.get(c.get("id"), [])
            # Hide categories that belong only to the SEO Groups tab (have keyword
            # groups but no replace groups). Truly-empty categories stay visible.
            if not cgroups and (c.get("_count") or {}).get("keywordGroups", 0):
                continue
            out.append({
                "id": c.get("id"),
                "name": c.get("name"),
                "position": c.get("order") or 0,
                "groups": cgroups,
            })
        if uncategorized:
            out.append({"id": None, "name": "Uncategorized", "position": 9999, "groups": uncategorized})
        return {"status": "ok", "categories": out}
    except Exception as e:
        logger.exception("[SEO] get_replace_library failed")
        return {"status": "error", "message": str(e)}


@router.get("/seo/replace-library/mirror")
def get_replace_library_mirror(request: Request):
    """Fast read of the replace-group library from the local mirror only — no
    external platform call, no re-sync, no cache invalidation. Used by the bot
    'Attach Replace Groups' picker, which only needs group names + pair counts.
    The mirror is refreshed by the full /seo/replace-library endpoint."""
    try:
        return get_db().read_replace_library_mirror()
    except Exception as e:
        logger.exception("[SEO] get_replace_library_mirror failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/replace-group/add")
def add_replace_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        category_id = data.get("category_id")
        name = (data.get("name") or "").strip()
        pairs = _clean_pairs(data.get("pairs"))
        if not category_id or not name:
            return {"status": "error", "message": "Missing required fields"}
        if not pairs:
            return {"status": "error", "message": "At least one from→to pair is required"}
        try:
            g = seo_external.create_replace_group(name, category_id, pairs)
        except ExternalSeoError as e:
            return _err(e)
        _resync_replace_mirror()
        return {"status": "ok", "id": g.get("id")}
    except Exception as e:
        logger.exception("[SEO] add_replace_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/replace-group/rename")
def rename_replace_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        name = (data.get("name") or "").strip()
        if not group_id or not name:
            return {"status": "error", "message": "Missing required fields"}
        try:
            seo_external.update_replace_group(group_id, {"name": name})
        except ExternalSeoError as e:
            return _err(e)
        _resync_replace_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] rename_replace_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/replace-group/toggle")
def toggle_replace_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        enabled = bool(data.get("enabled"))
        if not group_id:
            return {"status": "error", "message": "Missing group id"}
        try:
            seo_external.update_replace_group(group_id, {"enabled": enabled})
        except ExternalSeoError as e:
            return _err(e)
        _resync_replace_mirror()
        return {"status": "ok", "enabled": enabled}
    except Exception as e:
        logger.exception("[SEO] toggle_replace_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/replace-group/pairs/set")
def set_replace_group_pairs(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        pairs = _clean_pairs(data.get("pairs"))
        if not group_id:
            return {"status": "error", "message": "Missing group id"}
        if not pairs:
            return {"status": "error", "message": "At least one from→to pair is required"}
        try:
            seo_external.update_replace_group(group_id, {"pairs": pairs})
        except ExternalSeoError as e:
            return _err(e)
        _resync_replace_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] set_replace_group_pairs failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/replace-group/delete")
def delete_replace_group(request: Request, data: dict = Body(...)):
    try:
        denied = _admin_guard(request)
        if denied:
            return denied
        group_id = data.get("id")
        if not group_id:
            return {"status": "error", "message": "Missing group id"}
        try:
            seo_external.delete_replace_group(group_id)
        except ExternalSeoError as e:
            return _err(e)
        _resync_replace_mirror()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] delete_replace_group failed")
        return {"status": "error", "message": str(e)}


@router.post("/seo/bot/replace-groups/set")
def set_bot_replace_groups(request: Request, data: dict = Body(...)):
    """Attach/detach reusable replace groups to a bot (by external UUID)."""
    try:
        bot_name = data.get("bot_name")
        group_ids = data.get("group_ids")  # external UUIDs
        if not bot_name or group_ids is None:
            return {"status": "error", "message": "Missing required fields"}

        allowed, owner_id = _resolve_bot_access(request, bot_name)
        if not allowed:
            return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

        db = get_db()
        bot_id = db.get_bot_id(bot_name, owner_id=owner_id)
        if bot_id is None:
            return {"status": "error", "message": "Bot not found"}
        db.set_bot_replace_groups(bot_id, group_ids)
        invalidate_categorizer_cache()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] set_bot_replace_groups failed")
        return {"status": "error", "message": str(e)}


# ==================== Topic ↔ group attachment ====================

@router.post("/seo/topic/groups/set")
def set_topic_seo_groups(request: Request, data: dict = Body(...)):
    try:
        bot_name = data.get("bot_name")
        category_name = data.get("category_name")
        topic_name = data.get("topic_name")
        group_ids = data.get("group_ids")  # external UUIDs
        if not bot_name or not category_name or not topic_name or group_ids is None:
            return {"status": "error", "message": "Missing required fields"}

        allowed, owner_id = _resolve_bot_access(request, bot_name)
        if not allowed:
            return JSONResponse({"status": "error", "message": "Access denied"}, status_code=403)

        db = get_db()
        topic_id = db.get_topic_id(bot_name, category_name, topic_name, owner_id=owner_id)
        if topic_id is None:
            return {"status": "error", "message": "Topic not found"}
        db.set_topic_seo_groups(topic_id, group_ids)
        invalidate_categorizer_cache()
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SEO] set_topic_seo_groups failed")
        return {"status": "error", "message": str(e)}
