"""
Gemini client for generating summaries.
"""

import logging
import google.genai as genai
from utils.prompts import SYSTEM_PROMPT

logger = logging.getLogger(__name__)


class GeminiClient:
    """Client for interacting with Gemini API."""

    def __init__(self, api_key: str, model: str = "gemini-2.5-flash"):
        """
        Initialize Gemini client.

        Args:
            api_key: Gemini API key
            model: Gemini model to use
        """
        self.api_key = api_key
        self.model_name = model
        self.client = genai.Client(api_key=self.api_key)

        logger.info(f"Gemini client initialized with model: {self.model_name}")

    def generate_summary(self, prompt: str) -> str:
        """
        Generate a summary using Gemini API.

        Args:
            prompt: The prompt to send to Gemini

        Returns:
            Generated summary text
        """
        try:
            logger.debug(f"Sending request to Gemini with prompt length: {len(prompt)}")

            full_prompt = f"{SYSTEM_PROMPT}\n\n{prompt}"
            response = self.client.models.generate_content(
                        model='gemini-2.5-flash',
                        contents={'text': full_prompt})

            summary = response.text.strip()
            logger.info(f"Summary generated successfully (length: {len(summary)} chars)")

            try:
                from utils.gemini_usage import record_gemini_request
                tokens = 0
                if hasattr(response, 'usage_metadata') and response.usage_metadata:
                    um = response.usage_metadata
                    tokens = (getattr(um, 'prompt_token_count', 0) or 0) + \
                             (getattr(um, 'candidates_token_count', 0) or 0)
                if not tokens:
                    tokens = (len(full_prompt) + len(summary)) // 4
                record_gemini_request(total_tokens=tokens)
            except Exception:
                pass

            return summary

        except Exception as e:
            logger.error(f"Error generating gemini summary: {e}")
            raise
