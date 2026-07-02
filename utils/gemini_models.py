"""Central registry + resolver for the Gemini model(s) used across the app.

There is one **primary** model (the output that gets sent to Telegram and used
everywhere a single model is needed) plus an optional list of **compare**
models. When compare models are set, the scheduled summarizer runs each of them
on the same input as a side-by-side test — those extra outputs are stored and
viewable in the History popup / export, but never sent to Telegram.

The primary model is resolved with this precedence:
  1. The admin's `gemini_model` system_setting (set via the AI Usage page picker)
  2. config.yaml → gemini.model
  3. DEFAULT_GEMINI_MODEL

Only models in GEMINI_MODEL_OPTIONS are honoured for the admin override — an
unknown / stale stored value falls through to the config/default so a bad
setting can never break live Gemini calls.

Stored setting shape (JSONB):
    {"primary": "gemini-2.5-flash", "compare": ["gemini-3-pro-preview", ...]}
Legacy shapes still accepted on read: {"model": "..."} or a bare "..." string.

Specialised cheap-and-fast calls (e.g. the flash-lite used for chatbot search
expansion and suggestions) intentionally pin their own model and do NOT go
through this resolver.
"""

import logging

logger = logging.getLogger(__name__)

# Models offered in the admin picker. Order = display order in the dropdown.
# Gemini 3 models are preview + global-endpoint only. The startup probe hides
# any the project can't currently call, so a renamed/retired preview ID can't
# break the picker. (gemini-3-pro-preview was retired 2026-03-26 → 3.1-pro.)
GEMINI_MODEL_OPTIONS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
]

# Hard fallback when neither the DB setting nor config.yaml yields a model.
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"

# Set of models this Vertex project can actually call, discovered by probing at
# startup (init_available_models). None = not probed yet → treat the full static
# list as available so the picker is never empty and behaviour matches pre-probe.
_available_models: set[str] | None = None


def get_available_models() -> list[str]:
    """Models the project can access, in picker order.

    Falls back to the full static list until the startup probe completes (or if
    it was never run), so the picker is never empty and resolution is unchanged
    before the probe finishes."""
    if not _available_models:
        return list(GEMINI_MODEL_OPTIONS)
    return [m for m in GEMINI_MODEL_OPTIONS if m in _available_models]


def _probe_available_models(project: str, location: str):
    """Probe each candidate model with a 1-token call and record which succeed.

    A 404/403 means the project isn't granted that model → hide it from the
    picker. Any other error (429, network) is transient → keep the model listed
    rather than hiding a good model on a blip."""
    global _available_models
    try:
        import google.genai as genai
        from google.genai import types
        client = genai.Client(vertexai=True, project=project, location=location)
    except Exception as e:
        logger.warning(f"[GEMINI-MODEL] probe client init failed: {e}")
        return
    available = set()
    for model in GEMINI_MODEL_OPTIONS:
        try:
            client.models.generate_content(
                model=model, contents="ping",
                config=types.GenerateContentConfig(max_output_tokens=1))
            available.add(model)
        except Exception as e:
            msg = str(e)
            if any(t in msg for t in ("404", "NOT_FOUND", "403", "PERMISSION_DENIED")):
                logger.warning(f"[GEMINI-MODEL] {model} not accessible to project "
                               f"{project} — hiding from picker")
            else:
                logger.info(f"[GEMINI-MODEL] probe inconclusive for {model}: "
                            f"{msg[:100]} — keeping listed")
                available.add(model)
    _available_models = available
    logger.info(f"[GEMINI-MODEL] picker models available: {sorted(available)}")


def init_available_models(project: str, location: str = "global"):
    """Kick off the model-availability probe in a background thread at startup.

    Backgrounded so 4 tiny Vertex calls never delay boot; until it finishes the
    picker shows the full static list. No-op when no project is configured."""
    if not project:
        return
    import threading
    threading.Thread(target=_probe_available_models, args=(project, location),
                     daemon=True, name="gemini-model-probe").start()


def _read_setting() -> dict:
    """Return the raw `gemini_model` system_setting normalised to a dict, or {}.

    Tolerates the canonical {"primary","compare"} shape, the legacy
    {"model": "..."} shape, and a bare string. Returns {} on any error so
    callers fall through to config — a DB hiccup must never break summarization.
    """
    try:
        from utils.database import get_db
        db = get_db()
        if db is None:
            return {}
        val = db.get_setting("gemini_model")
        if isinstance(val, dict):
            return val
        if isinstance(val, str):
            return {"primary": val}
    except Exception as e:
        logger.warning(f"[GEMINI-MODEL] setting lookup failed: {e}")
    return {}


def _primary_from_setting(setting: dict) -> str | None:
    """Pull a valid primary model out of a normalised setting dict, or None.

    Validated against the *available* models, so a stored model the project
    can't access (e.g. a stale gemini-3 pick) falls through to config/default
    instead of 404-ing every call."""
    model = setting.get("primary") or setting.get("model")
    return model if isinstance(model, str) and model in get_available_models() else None


def get_gemini_model(config: dict | None = None) -> str:
    """Resolve the effective (primary) Gemini model name.

    Precedence: DB override → config.yaml → default. Pass an already-loaded
    `config` dict to avoid a redundant load_config().
    """
    override = _primary_from_setting(_read_setting())
    if override:
        return override

    try:
        if config is None:
            from utils.helpers import load_config
            config = load_config()
        cfg_model = (config.get("gemini") or {}).get("model")
        if cfg_model:
            return cfg_model
    except Exception as e:
        logger.warning(f"[GEMINI-MODEL] config lookup failed: {e}")

    return DEFAULT_GEMINI_MODEL


def get_gemini_compare_models() -> list[str]:
    """Return the extra models to run alongside the primary for A/B comparison.

    Validated against GEMINI_MODEL_OPTIONS, de-duplicated, and with the primary
    model removed (no point comparing a model against itself). Empty list means
    "single-model mode" — zero extra cost, behaviour identical to before.
    """
    setting = _read_setting()
    primary = get_gemini_model()
    available = get_available_models()
    out = []
    for m in setting.get("compare") or []:
        if m in available and m != primary and m not in out:
            out.append(m)
    return out


def get_gemini_model_config() -> dict:
    """Return {"primary","compare","options"} for the admin picker UI."""
    return {
        "primary": get_gemini_model(),
        "compare": get_gemini_compare_models(),
        "options": get_available_models(),
    }
