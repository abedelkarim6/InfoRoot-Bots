"""
OpenAI client for generating summaries.
"""

import openai
import logging
from summaries.prompts import get_system_prompt

logger = logging.getLogger(__name__)


class OpenAIClient:
    """Client for interacting with OpenAI API."""
    
    def __init__(self, api_key: str, model: str = "gpt-4o-mini", 
                 max_tokens: int = 1000, temperature: float = 0.7):
        """
        Initialize OpenAI client.
        
        Args:
            api_key: OpenAI API key
            model: Model to use for completion
            max_tokens: Maximum tokens in response
            temperature: Sampling temperature
        """
        self.api_key = api_key
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        
        # Set API key
        openai.api_key = self.api_key
        logger.info(f"OpenAI client initialized with model: {self.model}")
    
    def generate_summary(self, prompt: str) -> tuple[str, int]:
        """
        Generate a summary using OpenAI API.
        
        Args:
            prompt: The prompt to send to OpenAI
        
        Returns:
            Generated summary text
        """
        try:
            logger.debug(f"Sending request to OpenAI with prompt length: {len(prompt)}")
            
            response = openai.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": get_system_prompt()},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=self.max_tokens,
                temperature=self.temperature
            )
            
            summary = response.choices[0].message.content.strip()
            logger.info(f"Summary generated successfully (length: {len(summary)} chars)")
            tokens = 0
            if hasattr(response, 'usage') and response.usage:
                tokens = (response.usage.prompt_tokens or 0) + (response.usage.completion_tokens or 0)
            if not tokens:
                tokens = (len(prompt) + len(summary)) // 4
            return summary, tokens
            
        except Exception as e:
            logger.error(f"Error generating summary: {e}")
            raise
