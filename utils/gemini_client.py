"""
Gemini client for generating summaries via Vertex AI.
Authentication uses Application Default Credentials (ADC) set by:
    gcloud auth application-default login
"""

import time
import random
import logging
import google.genai as genai
from google.genai import types
from summaries.prompts import get_system_prompt


def _resolve_thinking_config():
    """Read the admin's `gemini_thinking` system_setting and translate it into
    a `types.ThinkingConfig` object — or `None` if thinking is disabled.

    Returning None lets us pass the same code path through whether the toggle
    is on or off; the SDK simply omits the thinking_config field.

    When enabled, we always set `include_thoughts=True` so the response
    surfaces the model's reasoning trace; the caller separates thought parts
    from answer parts and stores them on the summary row.
    """
    try:
        from utils.database import get_db
        cfg = get_db().get_setting("gemini_thinking") or {}
        if not cfg.get("enabled"):
            return None
        # Default budget = -1 (dynamic — the model picks how much to think).
        budget = cfg.get("budget", -1)
        try:
            budget = int(budget)
        except (TypeError, ValueError):
            budget = -1
        return types.ThinkingConfig(thinking_budget=budget, include_thoughts=True)
    except Exception as e:
        # Settings table missing / DB unavailable shouldn't break summarization.
        logger.warning(f"[GEMINI] thinking config lookup failed: {e}")
        return None


def _split_response_parts(response):
    """Split a generate_content response into (answer_text, thoughts_text).

    When `include_thoughts=True` was sent, Vertex returns multiple parts on
    the candidate, marking thought summaries with `part.thought == True`.
    Older SDKs / models that don't surface thoughts return a single part —
    in that case `thoughts_text` is an empty string.
    """
    answer_chunks = []
    thought_chunks = []
    try:
        candidates = getattr(response, "candidates", None) or []
        if candidates:
            content = getattr(candidates[0], "content", None)
            parts = getattr(content, "parts", None) or []
            for p in parts:
                txt = getattr(p, "text", None)
                if not txt:
                    continue
                if getattr(p, "thought", False):
                    thought_chunks.append(txt)
                else:
                    answer_chunks.append(txt)
    except Exception:
        pass

    answer = "".join(answer_chunks).strip()
    thoughts = "\n\n".join(thought_chunks).strip()
    # Fallback: when the SDK returns only response.text and no parts.
    if not answer:
        answer = (getattr(response, "text", "") or "").strip()
    return answer, thoughts

logger = logging.getLogger(__name__)

# 429 retry base delays with full jitter (actual sleep = random(0, base)).
# Jitter prevents overlapping schedule jobs from all retrying simultaneously.
# Base delays exceed the 60s RPM window so a rate-limited retry has a fair chance.
_RETRY_BASE_DELAYS = [65, 130]


class GeminiClient:
    """Client for interacting with Gemini via Vertex AI."""

    def __init__(self, project: str, location: str = "global", model: str = "gemini-2.5-flash",
                 user_id: int | None = None):
        self.project    = project
        self.location   = location
        self.model_name = model
        self.user_id    = user_id
        # "global" spreads load across regions and reduces 429s from per-region capacity limits.
        self.client     = genai.Client(vertexai=True, project=project, location=location)
        # Last-call thinking trace. Populated by generate_summary when the
        # admin's "Extended Thinking" toggle is on; callers that want to
        # persist the trace read this immediately after the call.
        self.last_thoughts: str = ""
        logger.info(f"Gemini (Vertex AI) client initialized — project={project} model={model} location={location}")

    def generate_summary(self, prompt: str) -> tuple[str, int]:
        """Generate a summary. Returns (summary_text, total_tokens).

        When the admin's "Extended Thinking" toggle is enabled, Gemini's
        reasoning trace is captured and exposed via `self.last_thoughts` —
        the schedule runner reads it after the call to persist alongside the
        summary row.
        """
        full_prompt = f"{get_system_prompt()}\n\n{prompt}"
        labels = {"service": "bots"}
        if self.user_id is not None:
            labels["user_id"] = str(self.user_id)

        last_exc = None
        for attempt, base_delay in enumerate([0] + _RETRY_BASE_DELAYS):
            if base_delay:
                jittered = random.uniform(0, base_delay)
                logger.warning(
                    f"[GEMINI] 429 rate-limited — retrying in {jittered:.0f}s "
                    f"(attempt {attempt}/{len(_RETRY_BASE_DELAYS)})"
                )
                time.sleep(jittered)
            try:
                thinking_cfg = _resolve_thinking_config()
                gen_config_kwargs = {"labels": labels}
                if thinking_cfg is not None:
                    gen_config_kwargs["thinking_config"] = thinking_cfg
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents={"text": full_prompt},
                    config=types.GenerateContentConfig(**gen_config_kwargs),
                )
                summary, thoughts = _split_response_parts(response)
                # Stash on the instance so the caller (bot.py) can persist it
                # alongside the summary row when "Extended Thinking" is on.
                self.last_thoughts = thoughts

                # TokenUsage is an int (the total) that also carries the
                # input / answer-output / thinking split for per-model,
                # per-SKU cost accounting (thinking is its own billing line).
                from utils.ai_pricing import TokenUsage, extract_gemini_tokens
                inp = out = think = audio = 0
                try:
                    inp, out, think, audio = extract_gemini_tokens(
                        getattr(response, "usage_metadata", None))
                    if not (inp or out or think):
                        inp = len(full_prompt) // 4
                        out = len(summary) // 4
                    from utils.gemini_usage import record_gemini_request
                    record_gemini_request(total_tokens=inp + out + think)
                except Exception:
                    pass

                # audio is inside inp — not added to the total
                return summary, TokenUsage(inp + out + think, inp, out, think, audio)

            except Exception as e:
                last_exc = e
                err_str = str(e)
                if '429' in err_str or 'RESOURCE_EXHAUSTED' in err_str or 'quota' in err_str.lower():
                    continue  # retry
                logger.error(f"Error generating Vertex AI summary: {e}")
                raise

        logger.error(f"[GEMINI] All {len(_RETRY_BASE_DELAYS) + 1} attempts exhausted after 429 errors: {last_exc}")
        raise last_exc
