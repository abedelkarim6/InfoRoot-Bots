"""
Gemini client for generating summaries via Vertex AI.
Authentication uses Application Default Credentials (ADC) set by:
    gcloud auth application-default login
"""

import logging
import google.genai as genai
from google.genai import types
from utils.prompts import get_system_prompt

logger = logging.getLogger(__name__)


class GeminiClient:
    """Client for interacting with Gemini via Vertex AI."""

    def __init__(self, project: str, location: str = "us-central1", model: str = "gemini-2.5-flash",
                 user_id: int | None = None):
        self.project    = project
        self.location   = location
        self.model_name = model
        self.user_id    = user_id
        self.client     = genai.Client(vertexai=True, project=project, location=location)
        logger.info(f"Gemini (Vertex AI) client initialized — project={project} model={model}")

    def generate_summary(self, prompt: str) -> str:
        try:
            full_prompt = f"{get_system_prompt()}\n\n{prompt}"
            labels = {"service": "bots"}
            if self.user_id is not None:
                labels["user_id"] = str(self.user_id)
            response = self.client.models.generate_content(
                model=self.model_name,
                contents={"text": full_prompt},
                config=types.GenerateContentConfig(labels=labels),
            )
            summary = response.text.strip()

            try:
                from utils.gemini_usage import record_gemini_request
                tokens = 0
                if hasattr(response, "usage_metadata") and response.usage_metadata:
                    um = response.usage_metadata
                    tokens = (getattr(um, "prompt_token_count", 0) or 0) + \
                             (getattr(um, "candidates_token_count", 0) or 0)
                if not tokens:
                    tokens = (len(full_prompt) + len(summary)) // 4
                record_gemini_request(total_tokens=tokens)
            except Exception:
                pass

            return summary

        except Exception as e:
            logger.error(f"Error generating Vertex AI summary: {e}")
            raise
