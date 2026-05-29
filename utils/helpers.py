import asyncio
import collections
import copy
import datetime
import io
import math
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import yaml
import logging
from logging.handlers import RotatingFileHandler

# ==================== In-memory log buffer ====================

class _MemoryLogHandler(logging.Handler):
    """Keeps the last `maxlen` log records in a deque for the UI logs page."""

    def __init__(self, maxlen: int = 1000):
        super().__init__()
        self._records: collections.deque = collections.deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord):
        try:
            self._records.append({
                'time':    datetime.datetime.fromtimestamp(record.created).strftime('%Y-%m-%d %H:%M:%S'),
                'level':   record.levelname,
                'name':    record.name,
                'message': record.getMessage(),
            })
        except Exception:
            pass  # Never crash the logging system

    def get_records(self, level: str = None, search: str = None, limit: int = 500):
        records = list(self._records)
        if level:
            records = [r for r in records if r['level'] == level]
        if search:
            s = search.lower()
            records = [r for r in records
                       if s in r['message'].lower() or s in r['name'].lower()]
        # Return most-recent last; caller can reverse for newest-first display
        return records[-limit:]

    def clear(self):
        self._records.clear()


_memory_handler: _MemoryLogHandler = None  # type: ignore[assignment]


# ── Sensitive-data redaction ─────────────────────────────────────
class _RedactingFilter(logging.Filter):
    """Redact obvious secrets from log messages before they hit any handler.
    Operates on the formatted message (so it catches both `%s`-style and
    f-string usage). Best-effort — designed not to crash the logger."""

    # Long b64-ish strings that follow a "session"/"string_session" key,
    # bare Telethon session strings (start with "1" + 350+ b64 chars),
    # API keys (Google/OpenAI prefixes + assignment patterns), and DB
    # passwords embedded in a DSN.
    _PATTERNS = [
        (re.compile(r'(?i)((?:string_)?session(?:_string)?["\']?\s*[:=]\s*["\']?)([A-Za-z0-9+/=_\-]{40,})'),
         r'\1[REDACTED_SESSION]'),
        (re.compile(r'\b1[A-Za-z0-9_\-]{300,}=*\b'),  # raw Telethon session
         '[REDACTED_SESSION]'),
        (re.compile(r'(?i)(api[_-]?key["\']?\s*[:=]\s*["\']?)([A-Za-z0-9_\-]{16,})'),
         r'\1[REDACTED_API_KEY]'),
        (re.compile(r'\bAIza[0-9A-Za-z_\-]{30,}\b'),  # Google API key
         '[REDACTED_API_KEY]'),
        (re.compile(r'\bsk-[A-Za-z0-9]{20,}\b'),  # OpenAI key
         '[REDACTED_API_KEY]'),
        (re.compile(r'(?i)(password["\']?\s*[:=]\s*["\']?)([^\s"\',}]+)'),
         r'\1[REDACTED]'),
        (re.compile(r'(?i)(bearer\s+)([A-Za-z0-9._\-]{10,})'),
         r'\1[REDACTED_TOKEN]'),
        (re.compile(r'(postgres(?:ql)?://[^:/\s]+:)([^@\s]+)(@)'),
         r'\1[REDACTED]\3'),
    ]

    def _redact(self, text: str) -> str:
        try:
            for pattern, replacement in self._PATTERNS:
                text = pattern.sub(replacement, text)
        except Exception:
            pass
        return text

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            # Pre-render and store on the record so every handler sees the same
            # redacted text. Format here once instead of per-handler.
            msg = record.getMessage()
            redacted = self._redact(msg)
            if redacted != msg:
                record.msg = redacted
                record.args = ()
        except Exception:
            pass
        return True


_redacting_filter = _RedactingFilter()


def install_redaction_filter() -> None:
    """Attach the sensitive-data redaction filter to every handler on the root
    logger. Logger-level filters in Python don't apply to records that
    propagate from descendant loggers, so the filter MUST live on the
    handlers to actually catch everything. Idempotent."""
    root = logging.getLogger()
    for h in root.handlers:
        if not any(isinstance(f, _RedactingFilter) for f in h.filters):
            h.addFilter(_redacting_filter)


def init_memory_log_handler(maxlen: int = 1000) -> _MemoryLogHandler:
    """Attach a memory log handler to the root logger. Call once at app startup."""
    global _memory_handler
    _memory_handler = _MemoryLogHandler(maxlen=maxlen)
    _memory_handler.setLevel(logging.INFO)
    # Also apply the filter at the handler level — guarantees the buffered
    # records the UI displays are redacted, even if a handler is attached
    # elsewhere without the root-level filter.
    _memory_handler.addFilter(_redacting_filter)
    logging.getLogger().addHandler(_memory_handler)
    install_redaction_filter()
    return _memory_handler


def get_log_records(level: str = None, search: str = None, limit: int = 500):
    if _memory_handler is None:
        return []
    return _memory_handler.get_records(level=level, search=search, limit=limit)


def clear_log_records():
    if _memory_handler:
        _memory_handler.clear()


# ==================== Configuration ====================
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = os.path.join(_BASE_DIR, "config.yaml")
PROMPTS_FILE = os.path.join(_BASE_DIR, "prompts.yaml")

# Hot-reload cache: serves the parsed YAML if the file mtime hasn't changed,
# avoiding a disk read on every load_config() call (called per-request in many
# routers). Reload is automatic — no signal/restart needed.
_config_cache = None
_config_mtime = 0.0
_config_lock = threading.Lock()


def atomic_write_yaml(path: str, data) -> None:
    """Write YAML to `path` atomically (temp file + os.replace) so a crash
    mid-write can never leave a corrupt config behind. Cross-platform safe."""
    target_dir = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".cfg-", suffix=".tmp", dir=target_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
        os.replace(tmp_path, path)  # atomic on POSIX and Windows (Python 3.3+)
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass
        raise


def load_config(force_reload: bool = False):
    """Load configuration from YAML file. Caches the parsed dict and reloads
    only when the file mtime changes (or `force_reload=True`).

    Returns a deep copy so callers may freely mutate the result without
    polluting the cache (preserves the original "fresh dict per call"
    semantics)."""
    global _config_cache, _config_mtime
    with _config_lock:
        try:
            mtime = os.path.getmtime(CONFIG_FILE)
        except OSError:
            mtime = 0.0
        if force_reload or _config_cache is None or mtime != _config_mtime:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                _config_cache = yaml.safe_load(f) or {}
            # DATABASE_DSN env var overrides config.yaml's database.dsn — lets
            # the same image run in Docker (DSN points at the `postgres`
            # service hostname) without editing config.yaml.
            dsn_override = os.environ.get("DATABASE_DSN")
            if dsn_override:
                _config_cache.setdefault("database", {})["dsn"] = dsn_override
            _config_mtime = mtime
        return copy.deepcopy(_config_cache)


def save_config(cfg):
    """Persist the config atomically and invalidate the in-memory cache so the
    next load_config() reflects the change."""
    global _config_cache, _config_mtime
    atomic_write_yaml(CONFIG_FILE, cfg)
    with _config_lock:
        _config_cache = None
        _config_mtime = 0.0

def load_prompts():
    try:
        with open(PROMPTS_FILE, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}

def save_prompts(prompts):
    atomic_write_yaml(PROMPTS_FILE, prompts)

def setup_logging(config):
    """Setup logging with file rotation."""
    log_config = config["logging"]
    
    # Create logger
    logger = logging.getLogger()
    logger.setLevel(getattr(logging, log_config["level"]))
    
    # Console handler — explicitly use UTF-8 so Unicode chars (→, Arabic, etc.)
    # don't crash on Windows where sys.stderr defaults to CP1252.
    if hasattr(sys.stderr, 'buffer'):
        _stream = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True)
    else:
        _stream = sys.stderr
    console_handler = logging.StreamHandler(_stream)
    console_handler.setLevel(logging.INFO)
    console_format = logging.Formatter(
        '%(asctime)s | %(levelname)s | %(name)s | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler.setFormatter(console_format)
    
    # File handler with rotation (DISABLED)
    # file_handler = RotatingFileHandler(
    #     log_config["file"],
    #     maxBytes=log_config["max_file_size_mb"] * 1024 * 1024,
    #     backupCount=log_config["backup_count"],
    #     encoding='utf-8',
    # )
    # file_handler.setLevel(getattr(logging, log_config["level"]))
    # file_format = logging.Formatter(
    #     '%(asctime)s | %(levelname)s | %(name)s | %(message)s',
    #     datefmt='%Y-%m-%d %H:%M:%S'
    # )
    # file_handler.setFormatter(file_format)
    
    # Add handlers
    logger.addHandler(console_handler)
    # logger.addHandler(file_handler)
    
    return logger

_BOT_RESTART_DELAY = 5  # seconds before auto-restart after unexpected exit

def start_bot_task(app_state):
    """Start run_bot() as an asyncio Task and attach it to app_state.bot_task.

    A supervisor wrapper restarts the task automatically after unexpected exits
    (anything that is not a CancelledError).  Called from app.py lifespan and
    the bot management router.
    """
    _logger = logging.getLogger("bot_task")

    async def _supervisor():
        from summaries.bot import run_bot
        while True:
            _logger.info("[BOT] Starting bot task…")
            try:
                await run_bot()
                # run_bot() returned normally — shouldn't happen; restart anyway
                _logger.warning("[BOT] run_bot() returned unexpectedly; restarting in %ss", _BOT_RESTART_DELAY)
            except asyncio.CancelledError:
                _logger.info("[BOT] Bot task cancelled — shutting down")
                raise  # propagate so the task truly stops
            except Exception as exc:
                _logger.error("[BOT] run_bot() crashed (%s: %s); restarting in %ss",
                              type(exc).__name__, exc, _BOT_RESTART_DELAY)
            await asyncio.sleep(_BOT_RESTART_DELAY)

    task = asyncio.create_task(_supervisor(), name="bot_supervisor")
    app_state.bot_task = task
    return task


async def stop_bot_task(app_state):
    """Cancel the bot asyncio Task and wait for it to finish.

    Called from app.py lifespan shutdown and the bot management router.
    """
    _logger = logging.getLogger("bot_task")
    task = getattr(app_state, 'bot_task', None)
    if task is None or task.done():
        app_state.bot_task = None
        return False
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    app_state.bot_task = None
    _logger.info("[BOT] Bot task stopped.")
    return True

# ==================== Categorizer cache ====================

_BOTS_CACHE_TTL: float = 30.0  # seconds between DB fetches

_bots_cache: dict = {}
_bots_cache_time: float = 0.0
# bot_name → cat_name → topic_name → (compiled_pattern | None, {lower_kw: original_kw})
_topic_patterns: dict = {}


def _build_topic_pattern(keywords: list):
    """
    Compile a single combined regex for all keywords in a topic.
    No \\b word boundaries — Arabic attached particles (بالحرب, للحرب, etc.) must
    match even without surrounding spaces. re.escape + IGNORECASE for safety.
    Returns (compiled_re | None, {lower: original}).
    """
    kw_lower_map: dict = {}
    valid_escaped: list = []
    for kw in keywords:
        if not kw:
            continue
        kw_lower_map[kw.lower()] = kw
        valid_escaped.append(re.escape(kw))
    if not valid_escaped:
        return None, kw_lower_map
    pattern = re.compile('(' + '|'.join(valid_escaped) + ')', re.IGNORECASE)
    return pattern, kw_lower_map


def _refresh_bots_cache(db=None):
    """Fetch bots config, compile per-topic patterns, and store in module globals."""
    global _bots_cache, _bots_cache_time, _topic_patterns

    if db is not None:
        bots = db.get_all_bots_config()
    else:
        cfg = load_config()
        bots = cfg.get('bots', {})

    patterns: dict = {}
    for bot_name, bot_data in bots.items():
        patterns[bot_name] = {}
        categories = bot_data.get('categories', {})

        # First pass: flat keyword map for linked_topics resolution
        all_topic_keywords: dict = {}
        for cat_data in categories.values():
            for t_name, t_data in cat_data.get('topics', {}).items():
                all_topic_keywords[t_name] = t_data.get('keywords', [])

        # Second pass: compile one regex per topic
        for cat_name, cat_data in categories.items():
            patterns[bot_name][cat_name] = {}
            for t_name, t_data in cat_data.get('topics', {}).items():
                own_kws = t_data.get('keywords', [])
                linked_kws: list = []
                for lt in (t_data.get('linked_topics') or []):
                    linked_kws.extend(all_topic_keywords.get(lt, []))
                pat, kw_map = _build_topic_pattern(own_kws + linked_kws)
                patterns[bot_name][cat_name][t_name] = (pat, kw_map)

    _bots_cache = bots
    _bots_cache_time = time.monotonic()
    _topic_patterns = patterns
    return bots


def _get_bots_cached(db=None) -> dict:
    """Return bots config from cache, refreshing at most once per TTL window."""
    if _bots_cache and (time.monotonic() - _bots_cache_time) < _BOTS_CACHE_TTL:
        return _bots_cache
    return _refresh_bots_cache(db)


def invalidate_categorizer_cache():
    """Force the next categorizer call to re-fetch bot config from DB.
    Call this after any mutation that changes keywords, topics, or categories."""
    global _bots_cache_time
    _bots_cache_time = 0.0


# ==================== Categorizer ====================
def categorizer(text, bot_name, db=None):
    """
    Match message text against topics' keywords for a specific bot.
    Uses a TTL-cached bot config and pre-compiled per-topic regexes so that
    the hot path (called on every incoming Telegram message) is O(topics)
    regex evals instead of O(topics × keywords).

    Returns: (matched_topics, matched_categories, matched_keywords)
    """
    found_topics: list = []
    found_categories: list = []
    found_keywords: list = []
    found_kw_set: set = set()  # dedup guard

    bots = _get_bots_cached(db)
    if bot_name not in bots:
        return None, None, None

    categories = bots[bot_name].get('categories', {})
    bot_patterns = _topic_patterns.get(bot_name, {})

    for category_name, category_data in categories.items():
        if not category_data.get('enabled', True):
            continue

        cat_patterns = bot_patterns.get(category_name, {})

        for topic_name, topic_data in category_data.get('topics', {}).items():
            if not topic_data.get('enabled', True):
                continue

            topic_matched = False
            pattern, kw_lower_map = cat_patterns.get(topic_name, (None, {}))

            if pattern is not None:
                # Single regex call replaces N individual re.search() calls
                matches = pattern.findall(text)
                if matches:
                    topic_matched = True
                    if topic_name not in found_topics:
                        found_topics.append(topic_name)
                    for m in matches:
                        orig = kw_lower_map.get(m.lower(), m)
                        if orig not in found_kw_set:
                            found_kw_set.add(orig)
                            found_keywords.append(orig)

            # Catch-all: match every message regardless of keywords
            if not topic_matched and topic_data.get('catch_all'):
                topic_matched = True
                if topic_name not in found_topics:
                    found_topics.append(topic_name)
                    import logging as _log
                    _log.getLogger(__name__).info(
                        f"[CATCH_ALL] Matched | Bot={bot_name} | Topic={topic_name} | text={text[:80]!r}"
                    )

            if topic_matched and category_name not in found_categories:
                found_categories.append(category_name)

    if not found_topics:
        return None, None, None

    return found_topics, found_categories, found_keywords


# ==================== Schedule Window ====================

def compute_window_start(job_data: dict, tz=None) -> datetime.datetime:
    """Return the previous scheduled fire time for a schedule, given its job_data dict.

    job_data fields mirror what bot.py passes to APScheduler:
      schedule_type, sch_start_hour, sch_start_minute, sch_hours, sch_minutes,
      sch_hour, sch_minute, sch_end_hour, sch_end_minute.

    tz: a ZoneInfo-compatible timezone. Defaults to Asia/Beirut.
    """
    if tz is None:
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo('Asia/Beirut')
        except Exception:
            tz = datetime.timezone.utc

    schedule_type = job_data.get('schedule_type', '')
    now = datetime.datetime.now(tz)

    try:
        if schedule_type == 'interval_hourly':
            start_h = int(job_data.get('sch_start_hour') or 0)
            start_m = int(job_data.get('sch_start_minute') or 0)
            hours   = int(job_data.get('sch_hours') or 1)
            end_h   = job_data.get('sch_end_hour')
            end_m   = job_data.get('sch_end_minute')
            # Interval schedules without an explicit end time stop at 23:59 (same default
            # as generate_and_send_summary). Required so the n==0 day-restart case works
            # correctly: the first fire at start_hour looks back to yesterday's 23:59
            # instead of returning window_start == now (which yields zero messages).
            if end_h is None:
                end_h, end_m = 23, 59

            anchor = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
            if anchor > now:
                anchor -= datetime.timedelta(days=1)

            elapsed_seconds = (now - anchor).total_seconds()
            n = math.floor(elapsed_seconds / (hours * 3600))

            if n == 0:
                # Overnight schedule: end time is before start time (e.g. start=08:00, end=02:00).
                # The previous cycle ended THIS morning at end_h:end_m, not yesterday.
                overnight = (int(end_h) * 60 + int(end_m)) < (start_h * 60 + start_m)
                if overnight:
                    return now.replace(hour=int(end_h), minute=int(end_m), second=0, microsecond=0)
                yesterday_anchor = anchor - datetime.timedelta(days=1)
                return yesterday_anchor.replace(hour=int(end_h), minute=int(end_m), second=0, microsecond=0)
            return anchor + datetime.timedelta(hours=(n - 1) * hours)

        elif schedule_type == 'interval_minutes':
            start_h = int(job_data.get('sch_start_hour') or 0)
            start_m = int(job_data.get('sch_start_minute') or 0)
            minutes = int(job_data.get('sch_minutes') or 1)
            end_h   = job_data.get('sch_end_hour')
            end_m   = job_data.get('sch_end_minute')
            if end_h is None:
                end_h, end_m = 23, 59

            anchor = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
            if anchor > now:
                anchor -= datetime.timedelta(days=1)

            elapsed_seconds = (now - anchor).total_seconds()
            n = math.floor(elapsed_seconds / (minutes * 60))

            if n == 0:
                overnight = (int(end_h) * 60 + int(end_m)) < (start_h * 60 + start_m)
                if overnight:
                    return now.replace(hour=int(end_h), minute=int(end_m), second=0, microsecond=0)
                yesterday_anchor = anchor - datetime.timedelta(days=1)
                return yesterday_anchor.replace(hour=int(end_h), minute=int(end_m), second=0, microsecond=0)
            return anchor + datetime.timedelta(minutes=(n - 1) * minutes)

        elif schedule_type == 'hourly':
            target_m = int(job_data.get('sch_minute') or 0)
            candidate = now.replace(minute=target_m, second=0, microsecond=0)
            if candidate > now:
                candidate -= datetime.timedelta(hours=1)
            return candidate - datetime.timedelta(hours=1)

        elif schedule_type == 'daily':
            target_h = int(job_data.get('sch_hour') or 0)
            target_m = int(job_data.get('sch_minute') or 0)
            candidate = now.replace(hour=target_h, minute=target_m, second=0, microsecond=0)
            if candidate > now:
                candidate -= datetime.timedelta(days=1)
            return candidate - datetime.timedelta(days=1)

        elif schedule_type == 'minute':
            n = int(job_data.get('sch_minute') or 1)
            floored_m = (now.minute // n) * n
            current_fire = now.replace(minute=floored_m, second=0, microsecond=0)
            return current_fire - datetime.timedelta(minutes=n)

    except Exception:
        pass

    return now - datetime.timedelta(hours=24)