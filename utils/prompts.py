"""
Prompts for OpenAI summarization.
Each format provides a different style of summary.
"""
from typing import List
from utils.database import get_db

SYSTEM_PROMPT = "أنت خبير في تلخيص الأخبار العربية بأسلوب صحفي دقيق وميجز."


def get_summary_prompt(texts: List[str], bot_name: str, prompt_key: str, topic_name: str = '') -> str:
    """
    Injects news messages into bot-specific prompt templates.

    Args:
        texts: List of message texts to summarize
        bot_name: Name of the bot (e.g., 'news_bot')
        prompt_key: Prompt template key (e.g., 'bullet_points', 'brief')
        topic_name: Name of the topic being summarized

    Returns:
        Final prompt with messages injected
    """
    combined_news = "\n---\n".join(texts)

    db = get_db()
    bot_prompts = db.get_bot_prompts(bot_name)

    if prompt_key not in bot_prompts:
        prompt_key = 'bullet_points' if 'bullet_points' in bot_prompts else list(bot_prompts.keys())[0] if bot_prompts else 'brief'
        if prompt_key not in bot_prompts:
            raise ValueError(f"No prompts found for bot '{bot_name}'")

    prompt_val = bot_prompts[prompt_key]

    if isinstance(prompt_val, dict):
        template = prompt_val.get('text', '')
    else:
        template = prompt_val

    final_prompt = template.format(messages=combined_news, topic_name=topic_name)

    return final_prompt
