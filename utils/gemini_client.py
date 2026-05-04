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
        logger.info(f"Gemini (Vertex AI) client initialized — project={project} model={model} location={location}")

    def generate_summary(self, prompt: str) -> tuple[str, int]:
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
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents={"text": full_prompt},
                    config=types.GenerateContentConfig(labels=labels),
                )
                summary = response.text.strip()

                tokens = 0
                try:
                    from utils.gemini_usage import record_gemini_request
                    if hasattr(response, "usage_metadata") and response.usage_metadata:
                        um = response.usage_metadata
                        tokens = (getattr(um, "prompt_token_count", 0) or 0) + \
                                 (getattr(um, "candidates_token_count", 0) or 0)
                    if not tokens:
                        tokens = (len(full_prompt) + len(summary)) // 4
                    record_gemini_request(total_tokens=tokens)
                except Exception:
                    pass

                return summary, tokens

            except Exception as e:
                last_exc = e
                err_str = str(e)
                if '429' in err_str or 'RESOURCE_EXHAUSTED' in err_str or 'quota' in err_str.lower():
                    continue  # retry
                logger.error(f"Error generating Vertex AI summary: {e}")
                raise

        logger.error(f"[GEMINI] All {len(_RETRY_BASE_DELAYS) + 1} attempts exhausted after 429 errors: {last_exc}")
        raise last_exc
