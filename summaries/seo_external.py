"""
Client for the external "telegram-api" platform's SEO library.

The SEO library (categories → keyword-groups → keywords) is owned by the
external platform; our SEOs page is a write-through proxy over it and our local
seo_* tables are a synced mirror used only by the categorizer hot path.

Notes:
  - Auth is a static `Bearer <token>` (from config `external_seo`).
  - The platform sits behind Cloudflare, which 403s the default Python
    User-Agent ("error code: 1010") — we send a browser-like UA.
  - Endpoints (discovered from the platform's /docs OpenAPI + live probing):
      GET    /seo/categories
      POST   /seo/categories                 {name}
      PATCH  /seo/categories/{id}            {name?, enabled?}
      DELETE /seo/categories/{id}
      GET    /keyword-groups                 -> {groups:[{...,categoryId,keywords:[{id,keyword}]}]}
      GET    /keyword-groups/{id}            -> {group:{...}}
      POST   /keyword-groups                 {name, categoryId}
      PATCH  /keyword-groups/{id}            {name?, enabled?}
      DELETE /keyword-groups/{id}
      POST   /keyword-groups/{id}/keywords          {keyword}
      POST   /keyword-groups/{id}/keywords/bulk     {keywords:[str]}
      DELETE /keyword-groups/{id}/keywords/{keywordId}
      PUT    /seo/groups/move                {id, toCategoryId}
"""

import logging
import requests

from utils.helpers import load_config

logger = logging.getLogger(__name__)

_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_TIMEOUT = 30


class ExternalSeoError(Exception):
    """Raised when the external SEO API returns an error or is unreachable."""


def _cfg():
    c = (load_config().get("external_seo") or {})
    base = (c.get("base_url") or "").rstrip("/")
    token = c.get("token") or ""
    if not base or not token:
        raise ExternalSeoError("external_seo.base_url / token not configured")
    return base, token


def _headers(has_body: bool):
    _, token = _cfg()
    h = {
        "Authorization": f"Bearer {token}",
        "User-Agent": _UA,
        "Accept": "application/json",
    }
    # Only advertise a JSON body when we actually send one — the platform
    # (Fastify) 400s a bodyless DELETE that carries Content-Type: application/json
    # (FST_ERR_CTP_EMPTY_JSON_BODY).
    if has_body:
        h["Content-Type"] = "application/json"
    return h


def _request(method: str, path: str, body=None):
    base, _ = _cfg()
    url = f"{base}{path}"
    try:
        kwargs = {"headers": _headers(body is not None), "timeout": _TIMEOUT}
        if body is not None:
            kwargs["json"] = body
        resp = requests.request(method, url, **kwargs)
    except requests.RequestException as e:
        raise ExternalSeoError(f"{method} {path} failed: {e}") from e
    if resp.status_code >= 400:
        snippet = (resp.text or "")[:300]
        raise ExternalSeoError(f"{method} {path} -> HTTP {resp.status_code}: {snippet}")
    if not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError:
        return {}


# ---- Reads ----

def list_categories() -> list:
    """Return the raw categories list from the platform."""
    data = _request("GET", "/seo/categories")
    return data.get("categories", data) if isinstance(data, dict) else (data or [])


def list_groups() -> list:
    """Return all keyword-groups (each with its keywords) from the platform."""
    data = _request("GET", "/keyword-groups")
    return data.get("groups", data) if isinstance(data, dict) else (data or [])


def get_group(group_id: str) -> dict:
    data = _request("GET", f"/keyword-groups/{group_id}")
    return data.get("group", data) if isinstance(data, dict) else {}


# ---- Categories ----

def create_category(name: str) -> dict:
    return (_request("POST", "/seo/categories", {"name": name}) or {}).get("category", {})


def update_category(cat_id: str, patch: dict) -> dict:
    return (_request("PATCH", f"/seo/categories/{cat_id}", patch) or {}).get("category", {})


def delete_category(cat_id: str) -> None:
    _request("DELETE", f"/seo/categories/{cat_id}")


# ---- Groups ----

def create_group(name: str, category_id: str) -> dict:
    return (_request("POST", "/keyword-groups", {"name": name, "categoryId": category_id}) or {}).get("group", {})


def update_group(group_id: str, patch: dict) -> dict:
    return (_request("PATCH", f"/keyword-groups/{group_id}", patch) or {}).get("group", {})


def delete_group(group_id: str) -> None:
    _request("DELETE", f"/keyword-groups/{group_id}")


def move_group(group_id: str, to_category_id: str) -> None:
    _request("PUT", "/seo/groups/move", {"id": group_id, "toCategoryId": to_category_id})


# ---- Keywords ----

def add_keyword(group_id: str, keyword: str) -> dict:
    return (_request("POST", f"/keyword-groups/{group_id}/keywords", {"keyword": keyword}) or {}).get("keyword", {})


def add_keywords_bulk(group_id: str, keywords: list) -> dict:
    """Returns {added, skipped} from the platform."""
    return _request("POST", f"/keyword-groups/{group_id}/keywords/bulk", {"keywords": keywords}) or {}


def delete_keyword(group_id: str, keyword_id: str) -> None:
    _request("DELETE", f"/keyword-groups/{group_id}/keywords/{keyword_id}")


# ---- Replace-term groups (same /seo/categories, but from→to pairs) ----

def list_replace_groups() -> list:
    """Return all replace-groups (each with its from→to pairs)."""
    data = _request("GET", "/replace-groups")
    return data.get("groups", data) if isinstance(data, dict) else (data or [])


def get_replace_group(group_id: str) -> dict:
    data = _request("GET", f"/replace-groups/{group_id}")
    return data.get("group", data) if isinstance(data, dict) else {}


def create_replace_group(name: str, category_id: str, pairs: list) -> dict:
    body = {"name": name, "categoryId": category_id, "pairs": pairs}
    return (_request("POST", "/replace-groups", body) or {}).get("group", {})


def update_replace_group(group_id: str, patch: dict) -> dict:
    """patch may carry {name}, {enabled}, and/or {pairs:[{from,to,enabled?}]}
    (pairs is a full replacement of the group's pair set)."""
    return (_request("PATCH", f"/replace-groups/{group_id}", patch) or {}).get("group", {})


def delete_replace_group(group_id: str) -> None:
    _request("DELETE", f"/replace-groups/{group_id}")
