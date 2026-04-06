"""
Prompts for OpenAI summarization.
Each format provides a different style of summary.
"""
from typing import List
from utils.database import get_db

SYSTEM_PROMPT = "أنت خبير في تلخيص الأخبار العربية بأسلوب صحفي دقيق وميجز."

# Fixed prefix injected before every user prompt — not shown in the UI.
_FIXED_PREFIX = """\
الموضوع:

{topic_name}

الرسائل:

{messages}

تحديد النطاق:
- التزم فقط بالأخبار المرتبطة بـ {topic_name}
يشمل:
- أحداث حصلت داخل {topic_name}
- أحداث استهدفت {topic_name}
- تصريحات صادرة من {topic_name}

استبعد:
- أي أحداث خارج {topic_name}
- أي عمليات قامت بها {topic_name} خارج نطاقها
- أي تصريحات من جهات أخرى عن {topic_name}
---
User Prompt:
"""


def get_summary_prompt(texts: List[str], bot_name: str, prompt_key: str, topic_name: str = '') -> str:
    """
    Injects news messages into bot-specific prompt templates.

    The final prompt is:
      [fixed Arabic scope prefix with topic_name + messages injected]
      ---
      User Prompt:
      [user-defined template rendered with topic_name]

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

    import string

    class _SafeDict(dict):
        def __missing__(self, key):
            return '{' + key + '}'

    fmt = string.Formatter()

    # Render fixed prefix (injects {topic_name} and {messages})
    prefix = fmt.vformat(
        _FIXED_PREFIX, (), _SafeDict(messages=combined_news, topic_name=topic_name)
    )

    # Render user prompt (only {topic_name} is meaningful here; {messages} already in prefix)
    user_part = fmt.vformat(
        template, (), _SafeDict(messages=combined_news, topic_name=topic_name)
    )

    return prefix + user_part
