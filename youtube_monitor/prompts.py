"""
YouTube monitor prompt constants and builder functions.
Admins can override the fixed prefixes via the UI (stored in system_prompts.yaml).
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
    """Read the video fixed prefix from system_prompts.yaml, falling back to the hardcoded default."""
    from utils.helpers import load_system_prompts
    val = load_system_prompts().get("youtube_prefix_video", "")
    return val or _DEFAULT_FIXED_PREFIX_VIDEO


def _get_fixed_prefix_transcript() -> str:
    """Read the transcript fixed prefix from system_prompts.yaml, falling back to the hardcoded default."""
    from utils.helpers import load_system_prompts
    val = load_system_prompts().get("youtube_prefix_transcript", "")
    return val or _DEFAULT_FIXED_PREFIX_TRANSCRIPT


def _format_hms(secs: int) -> str:
    """Format a duration in seconds as H:MM:SS or M:SS."""
    secs = int(secs or 0)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_length_directive(target_chars: int, percent: int,
                           duration_secs: int = None, source_chars: int = None) -> str:
    """Return an instruction telling the model how long the video is and how long
    its summary should be — roughly `target_chars` characters (≈ `percent`% of the
    source content). Auto-inserted into the prompt so it applies to every strategy.
    Empty string when there is nothing to constrain."""
    if not target_chars or target_chars <= 0:
        return ""
    target_words = max(1, round(target_chars / 6))  # ~6 chars/word incl. spaces

    # Arabic block (matches the Arabic fixed-prefix prompts).
    ar = ["تعليمات الطول (مهمة):"]
    if duration_secs:
        ar.append(f"- مدة الفيديو: {_format_hms(duration_secs)} (أي {int(duration_secs)} ثانية).")
    src = f" من أصل {source_chars} حرف" if source_chars else ""
    ar.append(
        f"- الطول المتوقع للناتج: حوالي {target_chars} حرف (≈ {target_words} كلمة)، "
        f"أي ما يقارب {percent}%{src} من طول المحتوى الأصلي."
    )
    ar.append("- التزم بهذا الطول قدر الإمكان دون حذف النقاط الأساسية.")

    # English mirror.
    en = ["Length instruction:"]
    if duration_secs:
        en.append(f"- Video length: {_format_hms(duration_secs)} ({int(duration_secs)} seconds).")
    en.append(
        f"- Expected output: about {target_chars} characters (~{target_words} words), "
        f"roughly {percent}% of the source length."
    )

    return "\n\n---\n" + "\n".join(ar) + "\n\n" + "\n".join(en)


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
    table, or the hardcoded DEFAULT_PROMPT if none is stored."""
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
