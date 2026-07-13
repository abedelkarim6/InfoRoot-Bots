import logging

from fastapi import APIRouter, Body, Request
from utils.helpers import start_bot_task, stop_bot_task
from utils.database import get_db
from routers.auth import is_admin_request

logger = logging.getLogger("system_router")
router = APIRouter()

@router.get("/system/status")
def get_system_status(request: Request):
    try:
        db = get_db()
        full_cfg = db.get_full_config()
        bot_task = getattr(request.app.state, 'bot_task', None)
        bot_running = bot_task is not None and not bot_task.done()
        return {
            "enabled": full_cfg.get("system", {}).get("enabled", True),
            "bot_running": bot_running,
            "bots_count": len(full_cfg.get("bots", {})),
            "collections_count": len(full_cfg.get("collections", {}))
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_system_status failed")
        return {"status": "error", "message": str(e)}

@router.post("/system/toggle")
async def toggle_system(request: Request, enabled: bool = Body(..., embed=True)):
    try:
        db = get_db()
        db.set_system_enabled(enabled)

        if enabled:
            existing = getattr(request.app.state, 'bot_task', None)
            if existing and not existing.done():
                logger.info("Bot already running, skipping start")
                return {"status": "ok", "enabled": True, "message": "System enabled (bot already running)"}
            start_bot_task(request.app.state)
        else:
            await stop_bot_task(request.app.state)

        return {
            "status": "ok",
            "enabled": enabled,
            "message": f"System {'enabled' if enabled else 'disabled'}"
        }
    except Exception as e:
        logger.exception("[SYSTEM] toggle_system failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/gemini-usage")
def get_gemini_usage():
    """Return current Gemini API usage counters (RPM, TPM, RPD)."""
    try:
        from utils.gemini_usage import get_gemini_usage as _get
        return {"status": "ok", **_get()}
    except Exception as e:
        logger.exception("[SYSTEM] get_gemini_usage failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/gemini-thinking")
def get_gemini_thinking(request: Request):
    """Return the current Gemini thinking toggle. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        db = get_db()
        val = db.get_setting("gemini_thinking") or {}
        return {
            "status": "ok",
            "enabled": bool(val.get("enabled", False)),
            # -1 = dynamic (model decides), 0 = off, positive = max tokens cap.
            # We default to -1 when enabled so the model self-regulates.
            "budget": int(val.get("budget", -1)),
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_gemini_thinking failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/gemini-thinking")
def set_gemini_thinking(request: Request, data: dict = Body(...)):
    """Update the Gemini thinking toggle. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        enabled = bool(data.get("enabled", False))
        try:
            budget = int(data.get("budget", -1))
        except (TypeError, ValueError):
            budget = -1
        db = get_db()
        db.set_setting("gemini_thinking", {"enabled": enabled, "budget": budget})
        return {"status": "ok", "enabled": enabled, "budget": budget}
    except Exception as e:
        logger.exception("[SYSTEM] set_gemini_thinking failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/gemini-model")
def get_gemini_model_setting(request: Request):
    """Return the primary model, the compare list, and the options. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.gemini_models import get_gemini_model_config
        return {"status": "ok", **get_gemini_model_config()}
    except Exception as e:
        logger.exception("[SYSTEM] get_gemini_model_setting failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/gemini-model")
def set_gemini_model_setting(request: Request, data: dict = Body(...)):
    """Update the primary model + compare list. Admin only.

    Body: {"primary": "<model>", "compare": ["<model>", ...]}. The primary is
    the output sent to Telegram; every model in `compare` is also run by the
    scheduler for side-by-side testing (extra token cost — one full generation
    per compare model). Legacy {"model": "..."} is accepted as primary-only.
    All values must be in the allowed options.
    """
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.gemini_models import get_available_models
        from fastapi.responses import JSONResponse

        # Validate against the models the project can actually call, so a model
        # that 404s can't be saved and silently break all summarization.
        allowed = get_available_models()
        primary = (data.get("primary") or data.get("model") or "").strip()
        if primary not in allowed:
            return JSONResponse(
                {"status": "error",
                 "message": f"Model not available to this project: {primary!r}"},
                status_code=400,
            )

        compare = []
        for m in (data.get("compare") or []):
            m = (m or "").strip()
            if m not in allowed:
                return JSONResponse(
                    {"status": "error",
                     "message": f"Model not available to this project: {m!r}"},
                    status_code=400,
                )
            if m != primary and m not in compare:
                compare.append(m)

        get_db().set_setting("gemini_model", {"primary": primary, "compare": compare})
        return {"status": "ok", "primary": primary, "compare": compare}
    except Exception as e:
        logger.exception("[SYSTEM] set_gemini_model_setting failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/summary-thoughts")
def get_summary_thoughts(request: Request, id: int):
    """Return the saved thinking trace for a single summary. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        db = get_db()
        try:
            cursor = db._get_cursor()
            cursor.execute(
                "SELECT id, thoughts FROM summaries WHERE id = %s",
                (id,)
            )
            row = cursor.fetchone()
        finally:
            db._commit()
        if not row:
            return {"status": "error", "message": "Summary not found"}
        return {"status": "ok", "id": row["id"], "thoughts": row.get("thoughts") or ""}
    except Exception as e:
        logger.exception("[SYSTEM] get_summary_thoughts failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/youtube-quota-details")
def get_youtube_quota_details(request: Request):
    """Return YouTube Data API quota usage: today's units vs limit, hourly
    breakdown, and the most recent API calls. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from youtube_monitor.db import get_yt_db, get_quota_limit, QUOTA_COST
        ydb = get_yt_db()
        if ydb is None:
            return {"status": "error", "message": "YouTube DB not initialized"}
        return {
            "status": "ok",
            "today": ydb.get_quota_today(),
            "limit": get_quota_limit(),
            "hourly": ydb.get_hourly_api_usage(hours=24),
            "recent": ydb.get_recent_api_calls(limit=100),
            "costs": QUOTA_COST,
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_youtube_quota_details failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/ai-usage-details")
def get_ai_usage_details(request: Request):
    """Return full AI usage breakdown: live meters + hourly stats + recent summaries. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.gemini_usage import get_gemini_usage as _get, RPM_LIMIT, TPM_LIMIT, RPD_LIMIT
        db = get_db()
        live = _get()
        hourly = db.get_hourly_ai_stats(hours=24)
        recent = db.get_recent_summaries_for_ai_page(limit=100)
        return {
            "status": "ok",
            "live": live,
            "limits": {"rpm": RPM_LIMIT, "tpm": TPM_LIMIT, "rpd": RPD_LIMIT},
            "hourly": hourly,
            "recent": recent,
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_ai_usage_details failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/ai-usage-history")
def get_ai_usage_history(request: Request, date_from: str = None, date_to: str = None,
                         granularity: str = "day", feature: str = "all", user: str = "all"):
    """Historical AI usage + estimated $ cost between two dates with feature
    and user filters. Admin only.

    - date_from/date_to: YYYY-MM-DD (inclusive); defaults to the current month.
    - granularity: day | month (bucket size of the time series).
    - feature: all | summaries | youtube | chatbot | seo.
    - user: all | admin | <user id>. YouTube usage has no per-user ownership,
      so it is attributed to admin (excluded when a specific user is selected).

    Cost precision: youtube/chatbot/seo price exact input/output token splits;
    summaries rows store one combined total, priced with the blended
    input_ratio from the pricing settings (estimate).
    """
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from datetime import date, datetime
        from utils.ai_pricing import get_pricing, cost_usd, blended_cost_usd, thinking_cost_usd

        def _parse(d, fallback):
            try:
                return datetime.strptime((d or '').strip(), '%Y-%m-%d').date().isoformat()
            except ValueError:
                return fallback

        today = date.today()
        date_from = _parse(date_from, today.replace(day=1).isoformat())
        date_to = _parse(date_to, today.isoformat())
        if date_from > date_to:
            date_from, date_to = date_to, date_from
        gran = granularity if granularity in ("day", "month") else "day"
        all_features = ("summaries", "youtube", "chatbot", "seo")
        feature = feature if feature in ("all",) + all_features else "all"
        wanted = all_features if feature == "all" else (feature,)

        owner_filter = 'all'
        if user == 'admin':
            owner_filter = 'admin'
        elif user not in (None, '', 'all'):
            try:
                owner_filter = int(user)
            except ValueError:
                pass

        db = get_db()
        pricing = get_pricing(db)

        def _row_cost(feat, r):
            """Exact cost of a row's recorded input/output/thinking split, plus a
            blended estimate for any legacy combined-only tokens."""
            c = cost_usd(r.get('model'), int(r.get('input_tokens') or 0),
                         int(r.get('output_tokens') or 0), int(r.get('thinking_tokens') or 0), pricing)
            legacy = int(r.get('legacy_tokens') or 0)
            if legacy:
                c += blended_cost_usd(r.get('model'), legacy, pricing)
            return c

        def _row_tokens(r):
            t = r.get('tokens')
            if t is not None:
                return int(t)
            return (r.get('input_tokens') or 0) + (r.get('output_tokens') or 0) + (r.get('thinking_tokens') or 0)

        def _fold_series(feat, rows):
            by_bucket = {}
            for r in rows:
                b = by_bucket.setdefault(r['bucket'], {'bucket': r['bucket'], 'runs': 0, 'tokens': 0, 'cost': 0.0})
                b['runs'] += int(r.get('runs') or 0)
                b['tokens'] += _row_tokens(r)
                b['cost'] += _row_cost(feat, r)
            out = sorted(by_bucket.values(), key=lambda x: x['bucket'] or '')
            for b in out:
                b['cost'] = round(b['cost'], 4)
            return out

        # ── collect model-grained rows per feature ──────────────────────────
        # ai_usage_log also carries 'summaries' rows for calls outside the
        # summary row itself (interims, compare models, speech, splits).
        agent_rows = []
        if set(wanted) & {'summaries', 'chatbot', 'seo'}:
            agent_rows = db.get_agent_usage_history(date_from, date_to, gran, owner_filter)

        features = {}
        summaries_by_user, summaries_by_bot = [], []
        if 'summaries' in wanted:
            hist = db.get_ai_usage_history(date_from, date_to, gran, owner_filter)
            sum_rows = hist['series'] + [r for r in agent_rows if r['feature'] == 'summaries']
            features['summaries'] = {'series': _fold_series('summaries', sum_rows)}
            summaries_by_user, summaries_by_bot = hist['by_user'], hist['by_bot']

        yt_rows = []
        if 'youtube' in wanted:
            if owner_filter in ('all', 'admin'):
                from youtube_monitor.db import get_yt_db
                ydb = get_yt_db()
                if ydb is not None:
                    yt_rows = ydb.get_ai_usage_history(date_from, date_to, gran)
            features['youtube'] = {'series': _fold_series('youtube', yt_rows)}

        for feat in ('chatbot', 'seo'):
            if feat in wanted:
                features[feat] = {'series': _fold_series(feat, [r for r in agent_rows if r['feature'] == feat])}

        for feat, blk in features.items():
            blk['total'] = {
                'runs': sum(b['runs'] for b in blk['series']),
                'tokens': sum(b['tokens'] for b in blk['series']),
                'cost': round(sum(b['cost'] for b in blk['series']), 4),
            }
        features.get('summaries', {})['estimate'] = True  # blended pricing

        # ── per-user × per-feature matrix ────────────────────────────────────
        matrix = {}

        def _user_cell(user_id, username, feat):
            row = matrix.setdefault(user_id, {
                'user_id': user_id, 'username': username,
                'features': {f: {'runs': 0, 'tokens': 0, 'cost': 0.0} for f in all_features},
            })
            return row['features'][feat]

        for r in summaries_by_user:
            cell = _user_cell(r['user_id'], r['username'], 'summaries')
            cell['runs'] += int(r.get('runs') or 0)
            cell['tokens'] += int(r.get('tokens') or 0)
            cell['cost'] += _row_cost('summaries', r)
        for r in agent_rows:
            if r['feature'] not in all_features or r['feature'] not in wanted:
                continue
            cell = _user_cell(r['user_id'], r['username'], r['feature'])
            cell['runs'] += int(r.get('runs') or 0)
            cell['tokens'] += _row_tokens(r)
            cell['cost'] += _row_cost(r['feature'], r)
        if 'youtube' in features:
            for b in features['youtube']['series']:
                cell = _user_cell(None, 'Admin', 'youtube')
                cell['runs'] += b['runs']
                cell['tokens'] += b['tokens']
                cell['cost'] += b['cost']

        all_users = db.get_all_users()
        caps_by_id = {u['id']: (u.get('cost_caps') or {}) for u in all_users}
        by_user = []
        for row in matrix.values():
            for f, cell in row['features'].items():
                cell['cost'] = round(cell['cost'], 4)
            row['total'] = {
                'runs': sum(c['runs'] for c in row['features'].values()),
                'tokens': sum(c['tokens'] for c in row['features'].values()),
                'cost': round(sum(c['cost'] for c in row['features'].values()), 4),
            }
            row['cost_caps'] = caps_by_id.get(row['user_id'], {}) if row['user_id'] is not None else {}
            by_user.append(row)
        by_user.sort(key=lambda r: r['total']['cost'], reverse=True)

        # ── top bots (summaries) with cost ───────────────────────────────────
        bots_fold = {}
        for r in summaries_by_bot:
            b = bots_fold.setdefault(r['bot_name'], {'bot_name': r['bot_name'], 'runs': 0, 'tokens': 0, 'cost': 0.0})
            b['runs'] += int(r.get('runs') or 0)
            b['tokens'] += int(r.get('tokens') or 0)
            b['cost'] += _row_cost('summaries', r)
        by_bot = sorted(bots_fold.values(), key=lambda b: b['tokens'], reverse=True)[:15]
        for b in by_bot:
            b['cost'] = round(b['cost'], 4)

        # ── per-model breakdown (usage + current rates + cost, incl. thinking) ─
        from utils.ai_pricing import resolve_rates
        model_fold = {}

        def _add_model_rows(feat, rows):
            for r in rows:
                m = r.get('model') or '(unknown)'
                e = model_fold.setdefault(m, {'model': m, 'runs': 0, 'tokens': 0, 'cost': 0.0,
                                              'thinking_tokens': 0, 'thinking_cost': 0.0})
                e['runs'] += int(r.get('runs') or 0)
                e['tokens'] += _row_tokens(r)
                e['cost'] += _row_cost(feat, r)
                th = int(r.get('thinking_tokens') or 0)
                e['thinking_tokens'] += th
                e['thinking_cost'] += thinking_cost_usd(r.get('model'), th, pricing)

        if 'summaries' in wanted:
            _add_model_rows('summaries', hist['series'])
        _add_model_rows('youtube', yt_rows)
        for feat in ('summaries', 'chatbot', 'seo'):
            if feat in wanted:
                _add_model_rows(feat, [r for r in agent_rows if r['feature'] == feat])
        by_model = sorted(model_fold.values(), key=lambda m: m['cost'], reverse=True)
        for m in by_model:
            m['cost'] = round(m['cost'], 4)
            m['thinking_cost'] = round(m['thinking_cost'], 4)
            rates = resolve_rates(None if m['model'] == '(unknown)' else m['model'], pricing)
            m['rate_input'] = rates['input']
            m['rate_output'] = rates['output']

        totals = {
            'thinking_tokens': sum(m['thinking_tokens'] for m in by_model),
            'thinking_cost': round(sum(m['thinking_cost'] for m in by_model), 4),
            'cost': round(sum(m['cost'] for m in by_model), 4),
        }

        users = [{"id": u["id"], "username": u["username"]} for u in all_users]
        return {
            "status": "ok",
            "date_from": date_from,
            "date_to": date_to,
            "granularity": gran,
            "features": features,
            "by_user": by_user,
            "by_bot": by_bot,
            "by_model": by_model,
            "totals": totals,
            "users": users,
            "pricing": pricing,
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_ai_usage_history failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/ai-pricing")
def get_ai_pricing(request: Request):
    """Current per-model $/1M pricing (defaults merged with admin overrides)."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.ai_pricing import get_pricing, DEFAULT_MODEL_PRICING, DEFAULT_INPUT_RATIO
        p = get_pricing(get_db())
        return {"status": "ok", "models": p["models"], "input_ratio": p["input_ratio"],
                "defaults": DEFAULT_MODEL_PRICING, "default_input_ratio": DEFAULT_INPUT_RATIO}
    except Exception as e:
        logger.exception("[SYSTEM] get_ai_pricing failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/ai-pricing")
def set_ai_pricing(request: Request, data: dict = Body(...)):
    """Save per-model pricing overrides + blended input_ratio. Admin only."""
    try:
        if not is_admin_request(request):
            from fastapi.responses import JSONResponse
            return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
        from utils.ai_pricing import PRICING_SETTING_KEY
        models = {}
        for m, rates in (data.get("models") or {}).items():
            if not isinstance(rates, dict):
                continue
            try:
                inp, out = float(rates.get("input", 0)), float(rates.get("output", 0))
            except (TypeError, ValueError):
                continue
            if inp < 0 or out < 0:
                continue
            models[str(m).strip()] = {"input": inp, "output": out}
        payload = {"models": models}
        try:
            ratio = float(data.get("input_ratio"))
            if 0 <= ratio <= 1:
                payload["input_ratio"] = ratio
        except (TypeError, ValueError):
            pass
        get_db().set_setting(PRICING_SETTING_KEY, payload)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SYSTEM] set_ai_pricing failed")
        return {"status": "error", "message": str(e)}


@router.get("/system/fixed-prefix")
def get_summaries_fixed_prefix(request: Request):
    """Return the active summaries system prompt and fixed prefix (admin only)."""
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        from summaries.prompts import (get_system_prompt, get_fixed_prefix, get_bullet_points_suffix,
                                        _DEFAULT_SYSTEM_PROMPT, _DEFAULT_FIXED_PREFIX, _DEFAULT_BULLET_POINTS_SUFFIX)
        from utils.helpers import load_system_prompts
        active_bp_suffix = load_system_prompts().get("bullet_points_suffix", "") or _DEFAULT_BULLET_POINTS_SUFFIX
        return {
            "status": "ok",
            "system_prompt": get_system_prompt(),
            "fixed_prefix": get_fixed_prefix(),
            "bullet_points_suffix": active_bp_suffix,
            "default_system_prompt": _DEFAULT_SYSTEM_PROMPT,
            "default_fixed_prefix": _DEFAULT_FIXED_PREFIX,
            "default_bullet_points_suffix": _DEFAULT_BULLET_POINTS_SUFFIX,
        }
    except Exception as e:
        logger.exception("[SYSTEM] get_summaries_fixed_prefix failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/fixed-prefix/save")
async def save_summaries_fixed_prefix(request: Request):
    """Save overrides for the summaries system prompt and fixed prefix (admin only)."""
    try:
        if not is_admin_request(request):
            return {"status": "error", "message": "Admin only"}
        from utils.helpers import load_system_prompts, save_system_prompts
        data = await request.json()
        prompts = load_system_prompts()
        if "system_prompt" in data:
            prompts["summaries_system"] = data["system_prompt"]
        if "fixed_prefix" in data:
            prompts["summaries_prefix"] = data["fixed_prefix"]
        if "bullet_points_suffix" in data:
            prompts["bullet_points_suffix"] = data["bullet_points_suffix"]
        save_system_prompts(prompts)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("[SYSTEM] save_summaries_fixed_prefix failed")
        return {"status": "error", "message": str(e)}


@router.post("/system/restart")
async def restart_bot(request: Request):
    """Stop and restart the bot task (used after session changes)."""
    try:
        await stop_bot_task(request.app.state)
        start_bot_task(request.app.state)
        return {"status": "ok", "message": "Bot restarted successfully"}
    except Exception as e:
        logger.exception("[SYSTEM] restart_bot failed")
        return {"status": "error", "message": str(e)}
