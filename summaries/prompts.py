"""
Prompts for OpenAI/Gemini summarization.
Each format provides a different style of summary.
"""
from typing import List
from utils.database import get_db

# Hardcoded defaults — used when no override is stored in config.yaml
_DEFAULT_SYSTEM_PROMPT = "أنت خبير في تلخيص الأخبار العربية بأسلوب صحفي دقيق وميجز."

# Fixed prefix injected before every user prompt — not shown in the UI.
_DEFAULT_FIXED_PREFIX = """\
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

# Backward-compatible aliases (modules that import SYSTEM_PROMPT directly still work)
SYSTEM_PROMPT = _DEFAULT_SYSTEM_PROMPT
_FIXED_PREFIX = _DEFAULT_FIXED_PREFIX


def get_system_prompt() -> str:
    """Return the active system prompt, reading override from system_prompts.yaml if set."""
    try:
        from utils.helpers import load_system_prompts
        val = load_system_prompts().get("summaries_system", "")
        return val or _DEFAULT_SYSTEM_PROMPT
    except Exception:
        return _DEFAULT_SYSTEM_PROMPT


def get_fixed_prefix() -> str:
    """Return the active fixed prefix, reading override from system_prompts.yaml if set."""
    try:
        from utils.helpers import load_system_prompts
        val = load_system_prompts().get("summaries_prefix", "")
        return val or _DEFAULT_FIXED_PREFIX
    except Exception:
        return _DEFAULT_FIXED_PREFIX


_DEFAULT_BULLET_POINTS_SUFFIX = (
    "---\n"
    "يجب أن يحتوي الملخص النهائي على {b} نقاط رئيسية حصراً، لا أكثر ولا أقل.\n"
    "اكتب كل نقطة في سطر مستقل مبدوءًا بـ •"
)


def get_bullet_points_suffix(b: int) -> str:
    """Returns the admin-enforced bullet points instruction appended after the user prompt."""
    try:
        from utils.helpers import load_system_prompts
        tmpl = load_system_prompts().get("bullet_points_suffix", "") or _DEFAULT_BULLET_POINTS_SUFFIX
    except Exception:
        tmpl = _DEFAULT_BULLET_POINTS_SUFFIX
    return tmpl.replace('{b}', str(b))


def get_summary_prompt(texts: List[str], bot_name: str, prompt_key: str,
                       topic_name: str = '', final_interim: str = '',
                       b: int = 0) -> str:
    """
    Injects news messages into a global summaries prompt template.

    `bot_name` is retained for backwards compatibility but is no longer used to
    scope the prompt — prompts are global across all bots.

    Supported placeholders (usable in the fixed prefix and/or user prompt template):
      {messages}      — the joined raw message texts
      {topic_name}    — the topic being summarized
      {final_interim} — the most recent rolling interim summary (empty string if none)

    If {final_interim} is not present in a template it is simply ignored.
    """
    combined_news = "\n---\n".join(texts)

    db = get_db()
    bot_prompts = db.get_prompts_by_type('summaries')

    if prompt_key not in bot_prompts:
        prompt_key = 'bullet_points' if 'bullet_points' in bot_prompts else (
            list(bot_prompts.keys())[0] if bot_prompts else None
        )
        if not prompt_key or prompt_key not in bot_prompts:
            raise ValueError("No summaries prompts found in the prompts table")

    prompt_val = bot_prompts[prompt_key]

    if isinstance(prompt_val, dict):
        template = prompt_val.get('text', '')
    else:
        template = prompt_val

    import string

    class _SafeDict(dict):
        def __missing__(self, key):
            return '{' + str(key) + '}'

    class _SafeFormatter(string.Formatter):
        """Like string.Formatter but keeps unknown/positional placeholders as literal text."""
        def get_value(self, key, args, kwargs):
            if isinstance(key, int):
                # Positional placeholder {0}, {1}, … — pass through as literal
                return '{' + str(key) + '}'
            try:
                return kwargs[key]
            except KeyError:
                return '{' + key + '}'

    fmt = _SafeFormatter()

    subs = _SafeDict(
        messages=combined_news,
        topic_name=topic_name,
        final_interim=final_interim,
        b=str(b) if b else '',
    )

    active_prefix = get_fixed_prefix()

    prefix    = fmt.vformat(active_prefix, (), subs)
    user_part = fmt.vformat(template, (), subs)

    return prefix + user_part
