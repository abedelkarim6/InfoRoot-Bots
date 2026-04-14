import asyncio
import collections
import datetime
import io
import os
import re
import sys
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


def init_memory_log_handler(maxlen: int = 1000) -> _MemoryLogHandler:
    """Attach a memory log handler to the root logger. Call once at app startup."""
    global _memory_handler
    _memory_handler = _MemoryLogHandler(maxlen=maxlen)
    _memory_handler.setLevel(logging.INFO)
    logging.getLogger().addHandler(_memory_handler)
    return _memory_handler


def get_log_records(level: str = None, search: str = None, limit: int = 500):
    if _memory_handler is None:
        return []
    return _memory_handler.get_records(level=level, search=search, limit=limit)


def clear_log_records():
    if _memory_handler:
        _memory_handler.clear()


# ==================== Configuration ====================
CONFIG_FILE = "config.yaml"
PROMPTS_FILE = "prompts.yaml"
# ==================== Configuration ====================
def load_config():
    """Load configuration from YAML file."""
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)

def load_prompts():
    try:
        with open(PROMPTS_FILE, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}

def save_prompts(prompts):
    with open(PROMPTS_FILE, "w", encoding="utf-8") as f:
        yaml.safe_dump(prompts, f, allow_unicode=True)

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

# ==================== Categorizer ====================
def categorizer(text, bot_name, db=None):
    """
    Match message text against topics' keywords for a specific bot.
    Uses the database for bot/category/topic structure and keywords when
    db is provided; falls back to config.yaml otherwise.

    Returns: (matched_topics, matched_categories, matched_keywords)
    """
    found_topics = []
    found_categories = []
    found_keywords = []

    # Get bot config from DB (primary) or config.yaml (fallback)
    if db is not None:
        bots = db.get_all_bots_config()
    else:
        config = load_config()
        bots = config.get('bots', {})

    if bot_name not in bots:
        return None, None, None

    bot = bots[bot_name]
    categories = bot.get('categories', {})

    # Build a flat name→keywords lookup so linked_topics resolution is O(1)
    all_topic_keywords: dict = {}
    for cat_data in categories.values():
        for t_name, t_data in cat_data.get('topics', {}).items():
            all_topic_keywords[t_name] = t_data.get('keywords', [])

    # Iterate through categories → topics → keywords
    for category_name, category_data in categories.items():
        if not category_data.get('enabled', True):
            continue

        topics = category_data.get('topics', {})
        for topic_name, topic_data in topics.items():
            if not topic_data.get('enabled', True):
                continue

            # Own keywords + keywords inherited from every linked topic
            own_keywords = topic_data.get('keywords', [])
            linked = topic_data.get('linked_topics') or []
            linked_keywords = []
            for lt in linked:
                linked_keywords.extend(all_topic_keywords.get(lt, []))
            keywords = own_keywords + linked_keywords

            topic_matched = False

            for kw in keywords:
                if not kw:
                    continue
                try:
                    if re.search(rf'\b{re.escape(kw)}\b', text, re.IGNORECASE):
                        if topic_name not in found_topics:
                            found_topics.append(topic_name)
                            topic_matched = True
                        if kw not in found_keywords:
                            found_keywords.append(kw)
                except re.error:
                    if kw.lower() in text.lower():
                        if topic_name not in found_topics:
                            found_topics.append(topic_name)
                            topic_matched = True
                        if kw not in found_keywords:
                            found_keywords.append(kw)

            # Catch-all: match every message regardless of keywords
            if not topic_matched and topic_data.get('catch_all'):
                found_topics.append(topic_name)
                topic_matched = True

            if topic_matched and category_name not in found_categories:
                found_categories.append(category_name)

    if not found_topics:
        return None, None, None

    return found_topics, found_categories, found_keywords