"""
Prompts for OpenAI summarization.
Each format provides a different style of summary.
"""
from typing import List
from utils.helpers import load_prompts

SYSTEM_PROMPT = "أنت خبير في تلخيص الأخبار العربية بأسلوب صحفي دقيق وميجز."


def get_summary_prompt(texts: List[str], bot_name: str, prompt_key: str) -> str:
    """
    Injects news messages into bot-specific prompt templates.

    Args:
        texts: List of message texts to summarize
        bot_name: Name of the bot (e.g., 'news_bot')
        prompt_key: Prompt template key (e.g., 'bullet_points', 'brief')

    Returns:
        Final prompt with messages injected
    """
    # 1. Join all message texts with a clean separator
    combined_news = "\n---\n".join(texts)

    # 2. Get the bot-specific template from prompts.yaml
    prompts = load_prompts()
    bot_prompts = prompts.get('bots', {}).get(bot_name, {})

    if prompt_key not in bot_prompts:
        # Fallback to bullet_points if prompt not found
        prompt_key = 'bullet_points' if 'bullet_points' in bot_prompts else list(bot_prompts.keys())[0] if bot_prompts else 'brief'
        if prompt_key not in bot_prompts:
            raise ValueError(f"No prompts found for bot '{bot_name}'")

    template = bot_prompts[prompt_key]

    # 3. Use the .format() method to inject the messages into your {messages} placeholder
    final_prompt = template.format(messages=combined_news)

    return final_prompt