"""
YouTube monitor prompt constants and builder functions.
Admins can override the fixed prefixes via the UI (stored in config.yaml under system_prompts).
"""

DEFAULT_PROMPT = """You are a video content summarizer. Provide a clear, concise summary of the following YouTube video.
Include the key points, main topics discussed, and any notable takeaways.
Keep the summary informative but concise (3-5 paragraphs).

IMPORTANT: Focus ONLY on the actual video content. Completely ignore and exclude any:
- Sponsored segments, ad reads, or paid promotions
- "This video is brought to you by..." sections
- Affiliate links or discount codes
- Merchandise plugs or self-promotion
- Intro/outro filler unrelated to the main topic
Do NOT mention any advertisements or sponsorships in your summary."""

# Hardcoded defaults for the fixed prefixes.
_DEFAULT_FIXED_PREFIX_VIDEO = """\
العنوان:
{title}

اسم القناة:
{channel_name}

اسم الضيف:
{guest}

الرابط:
{link}

المطلوب:

تحويل محتوى الفيديو إلى نص مترابط يغني عن مشاهدة الفيديو، مع الحفاظ التام على نفس العبارات وأسلوب المتحدث.

تنسيق الإخراج:

- {title}
- اسم الضيف
- التاريخ:
الخميس ١٩/٠٣/٢٠٢٦

ثم النص

في النهاية:

قناة: {channel_name}
لمشاهدة الحلقة كاملة: {link}

قواعد الميتاداتا:

- استخدام العنوان كما هو 100% بدون تعديل
- استخدام اسم القناة الصحيح فقط
- حذف أي قيمة مثل N/A
- عدم تكرار أي عنصر
---
User Prompt:
"""

_DEFAULT_FIXED_PREFIX_TRANSCRIPT = """\
المحتوى:
{transcript}

العنوان:
{title}

اسم القناة:
{channel_name}

اسم الضيف:
{guest}

الرابط:
{link}

المطلوب:

تحويل محتوى الفيديو إلى نص مترابط يغني عن مشاهدة الفيديو، مع الحفاظ التام على نفس العبارات وأسلوب المتحدث.

تنسيق الإخراج:

- {title}
- اسم الضيف
- التاريخ:
الخميس ١٩/٠٣/٢٠٢٦

ثم النص

في النهاية:

قناة: {channel_name}
لمشاهدة الحلقة كاملة: {link}

قواعد الميتاداتا:

- استخدام العنوان كما هو 100% بدون تعديل
- استخدام اسم القناة الصحيح فقط
- حذف أي قيمة مثل N/A
- عدم تكرار أي عنصر
---
User Prompt:
"""


def _get_fixed_prefix_video() -> str:
    """Read the video fixed prefix from config.yaml, falling back to the hardcoded default."""
    from utils.helpers import load_config
    cfg = load_config()
    val = cfg.get("system_prompts", {}).get("youtube_prefix_video", "")
    return val or _DEFAULT_FIXED_PREFIX_VIDEO


def _get_fixed_prefix_transcript() -> str:
    """Read the transcript fixed prefix from config.yaml, falling back to the hardcoded default."""
    from utils.helpers import load_config
    cfg = load_config()
    val = cfg.get("system_prompts", {}).get("youtube_prefix_transcript", "")
    return val or _DEFAULT_FIXED_PREFIX_TRANSCRIPT


def _build_yt_prompt(prefix_template: str, user_prompt: str,
                     title: str, channel_name: str, link: str,
                     guest: str = '') -> str:
    """Inject metadata into the fixed prefix and append the user prompt."""
    prefix = (prefix_template
              .replace('{title}', title or '')
              .replace('{channel_name}', channel_name or '')
              .replace('{link}', link or '')
              .replace('{guest}', guest or ''))
    return prefix + user_prompt


def _get_global_prompt() -> str:
    """Return the first YouTube prompt (the default) from the global prompts
    table. Falls back to the legacy config.yaml `youtube.prompt`, then to the
    hardcoded DEFAULT_PROMPT."""
    try:
        from utils.database import get_db
        db = get_db()
        prompts = db.get_prompts_by_type('youtube', owner_id=None)
        if prompts:
            first_key = next(iter(prompts))
            text = prompts[first_key].get('text', '') if isinstance(prompts[first_key], dict) else prompts[first_key]
            if text:
                return text
    except Exception:
        pass
    try:
        from utils.helpers import load_config
        cfg = load_config()
        return cfg.get("youtube", {}).get("prompt", "") or DEFAULT_PROMPT
    except Exception:
        return DEFAULT_PROMPT


def resolve_yt_prompt(prompt_key: str = None) -> str:
    """Resolve a YouTube prompt_key to its text, falling back to the first
    available youtube-type prompt when the key is missing or unknown."""
    try:
        from utils.database import get_db
        db = get_db()
        prompts = db.get_prompts_by_type('youtube', owner_id=None)
        if prompt_key and prompt_key in prompts:
            val = prompts[prompt_key]
            return val.get('text', '') if isinstance(val, dict) else (val or '')
        if prompts:
            first_key = next(iter(prompts))
            val = prompts[first_key]
            return val.get('text', '') if isinstance(val, dict) else (val or '')
    except Exception:
        pass
    return _get_global_prompt()
