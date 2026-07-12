"""AI model pricing + cost estimation + per-user monthly cost caps.

Pricing is $ per 1M tokens, split input/output. Defaults below are editable at
runtime via the `ai_model_pricing` system setting (admin → AI Usage page):
    {"models": {"gemini-2.5-flash": {"input": 0.30, "output": 2.50}, ...},
     "input_ratio": 0.85}

Cost precision by feature:
- youtube:  exact — yt_summaries stores input_tokens/output_tokens (+ model).
- chatbot / seo: exact — ai_usage_log stores input/output per run.
- summaries: ESTIMATE — summaries.tokens_used is one combined total across all
  calls of a run (interims, chunk merges, A/B compare models), so cost uses a
  blended rate: input_ratio of the tokens priced as input, the rest as output.

Caps: users.cost_caps (JSONB) = {"total": 10.0, "summaries": ..., "youtube":
..., "chatbot": ..., "seo": ...} in USD per calendar month; absent/null key =
unlimited. Enforced on the user-triggered features (chatbot, seo suggest);
summaries/youtube run under the admin's scheduler so caps there are
informational (shown on the AI Usage page) rather than blocking.
"""

import logging

logger = logging.getLogger(__name__)

# $ per 1M tokens. Keep keys aligned with utils/gemini_models.py options plus
# the pinned helper models. "default" prices unknown/NULL models.
DEFAULT_MODEL_PRICING = {
    "gemini-2.5-pro":         {"input": 1.25, "output": 10.00},
    "gemini-2.5-flash":       {"input": 0.30, "output": 2.50},
    "gemini-2.5-flash-lite":  {"input": 0.10, "output": 0.40},
    "gemini-2.0-flash-001":   {"input": 0.10, "output": 0.40},
    "gemini-3-flash-preview": {"input": 0.50, "output": 3.00},
    "gemini-3.1-pro-preview": {"input": 2.00, "output": 12.00},
    "default":                {"input": 0.30, "output": 2.50},
}

# Share of a combined token total assumed to be input when only the total is
# known (summaries rows). News summarization is input-heavy.
DEFAULT_INPUT_RATIO = 0.85

FEATURES = ("summaries", "youtube", "chatbot", "seo")

PRICING_SETTING_KEY = "ai_model_pricing"


class TokenUsage(int):
    """A total token count that also carries the input/output split.

    Subclasses int so every existing `total += tokens` call site keeps working
    unchanged; cost-aware callers read `.input` / `.output` for exact pricing.
    Note: arithmetic results (e.g. `a + b`) degrade to plain int — accumulate
    the splits explicitly where they matter.
    """
    def __new__(cls, total, input_tokens=0, output_tokens=0):
        obj = super().__new__(cls, int(total or 0))
        obj.input = int(input_tokens or 0)
        obj.output = int(output_tokens or 0)
        return obj


def client_model(llm) -> str:
    """Model name of a GeminiClient (`model_name`) or OpenAIClient (`model`)."""
    return getattr(llm, 'model_name', None) or getattr(llm, 'model', None)


def get_pricing(db=None) -> dict:
    """Return {"models": {...}, "input_ratio": float} — defaults merged with
    the admin's `ai_model_pricing` system-setting override."""
    models = {k: dict(v) for k, v in DEFAULT_MODEL_PRICING.items()}
    ratio = DEFAULT_INPUT_RATIO
    try:
        if db is None:
            from utils.database import get_db
            db = get_db()
        stored = db.get_setting(PRICING_SETTING_KEY) if db else None
        if isinstance(stored, dict):
            for m, rates in (stored.get("models") or {}).items():
                if not isinstance(rates, dict):
                    continue
                try:
                    models[m] = {"input": float(rates.get("input", 0) or 0),
                                 "output": float(rates.get("output", 0) or 0)}
                except (TypeError, ValueError):
                    continue
            try:
                r = float(stored.get("input_ratio"))
                if 0 <= r <= 1:
                    ratio = r
            except (TypeError, ValueError):
                pass
    except Exception as e:
        logger.warning(f"[AI-PRICING] setting lookup failed: {e}")
    return {"models": models, "input_ratio": ratio}


def resolve_rates(model: str, pricing: dict = None) -> dict:
    """Return {input, output} $/1M for a model — exact match, then prefix
    match (longest first), then the 'default' entry."""
    p = (pricing or get_pricing())["models"]
    if model and model in p:
        return p[model]
    if model:
        for key in sorted(p, key=len, reverse=True):
            if key != "default" and model.startswith(key):
                return p[key]
    return p["default"]


def cost_usd(model: str, input_tokens: int, output_tokens: int, pricing: dict = None) -> float:
    """Exact cost for a run with a known input/output split."""
    rates = resolve_rates(model, pricing)
    return ((input_tokens or 0) * rates["input"] + (output_tokens or 0) * rates["output"]) / 1_000_000


def blended_cost_usd(model: str, total_tokens: int, pricing: dict = None) -> float:
    """Estimated cost when only a combined token total is known — the
    input_ratio share is priced as input, the rest as output."""
    p = pricing or get_pricing()
    ratio = p["input_ratio"]
    total = total_tokens or 0
    return cost_usd(model, int(total * ratio), total - int(total * ratio), p)


# ── Per-user monthly cost caps ───────────────────────────────────────────────

def get_user_month_costs(db, user_id: int, pricing: dict = None) -> dict:
    """Month-to-date USD cost per feature for one user.

    Returns {"summaries": $, "youtube": $, "chatbot": $, "seo": $, "total": $}.
    Sources: summaries (attributed via bot ownership, blended estimate) and
    ai_usage_log (chatbot/seo, exact). YouTube has no per-user ownership so it
    is always 0 for a specific user.
    """
    p = pricing or get_pricing(db)
    out = {f: 0.0 for f in FEATURES}
    try:
        for row in db.get_user_month_ai_tokens(user_id):
            feature = row.get("feature")
            if feature not in out:
                continue
            if row.get("input_tokens") is not None or row.get("output_tokens") is not None:
                out[feature] += cost_usd(row.get("model"), row.get("input_tokens") or 0,
                                         row.get("output_tokens") or 0, p)
            else:
                out[feature] += blended_cost_usd(row.get("model"), row.get("tokens") or 0, p)
    except Exception as e:
        logger.warning(f"[AI-PRICING] month cost lookup failed for user {user_id}: {e}")
    out["total"] = sum(out[f] for f in FEATURES)
    return out


def check_user_cost_cap(db, user_id: int, feature: str):
    """Return (allowed: bool, message: str|None).

    Blocks when the user's month-to-date cost reaches their cap for `feature`
    or their overall cap. No cap configured (or any error) → allowed — cost
    limiting must never break the feature on a DB hiccup.
    """
    if not user_id:
        return True, None
    try:
        caps = db.get_user_cost_caps(user_id)
        if not caps:
            return True, None
        feature_cap = caps.get(feature)
        total_cap = caps.get("total")
        if feature_cap is None and total_cap is None:
            return True, None
        costs = get_user_month_costs(db, user_id)
        if feature_cap is not None and costs.get(feature, 0.0) >= float(feature_cap):
            return False, (f"Monthly {feature} cost cap reached "
                           f"(${costs[feature]:.2f} of ${float(feature_cap):.2f}).")
        if total_cap is not None and costs.get("total", 0.0) >= float(total_cap):
            return False, (f"Monthly AI cost cap reached "
                           f"(${costs['total']:.2f} of ${float(total_cap):.2f}).")
        return True, None
    except Exception as e:
        logger.warning(f"[AI-PRICING] cost cap check failed for user {user_id}: {e}")
        return True, None
