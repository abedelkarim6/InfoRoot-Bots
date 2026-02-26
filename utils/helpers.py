import io
import os
import re
import sys
import time
import yaml
import logging
import threading
import subprocess
from logging.handlers import RotatingFileHandler

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
    
    # File handler with rotation
    file_handler = RotatingFileHandler(
        log_config["file"],
        maxBytes=log_config["max_file_size_mb"] * 1024 * 1024,
        backupCount=log_config["backup_count"],
        encoding='utf-8',
    )
    file_handler.setLevel(getattr(logging, log_config["level"]))
    file_format = logging.Formatter(
        '%(asctime)s | %(levelname)s | %(name)s | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    file_handler.setFormatter(file_format)
    
    # Add handlers
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)
    
    return logger

def stream_logs(pipe, pipe_name):
    bot_logger = logging.getLogger("bot_process")
    try:
        for line in iter(pipe.readline, ''):
            line = line.rstrip('\n\r')
            if line:
                bot_logger.info(f"[BOT] {line}")
    except Exception as e:
        bot_logger.error(f"stream_logs error: {e}")
    finally:
        pipe.close()


def start_bot_subprocess(app_state):
    """Start main.py as a subprocess and attach it to app state.

    Returns the Popen process on success, None on failure.
    Used by app.py lifespan, bot router, and system router.
    """
    _logger = logging.getLogger("bot_process")

    bot_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    main_path = os.path.join(bot_dir, "main.py")

    _logger.info(f"Starting bot: {sys.executable} -u {main_path} (cwd: {bot_dir})")

    proc = subprocess.Popen(
        [sys.executable, "-u", main_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
        encoding='utf-8',
        errors='replace',
        cwd=bot_dir,
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
    )

    # Wait briefly and check if process crashed immediately
    time.sleep(1)
    if proc.poll() is not None:
        stdout_out = proc.stdout.read()
        stderr_out = proc.stderr.read()
        _logger.error(f"Bot crashed on startup (exit code {proc.returncode})")
        _logger.error(f"STDOUT: {stdout_out}")
        _logger.error(f"STDERR: {stderr_out}")
        app_state.bot_process = None
        return None

    # Stream bot logs to the app's console
    threading.Thread(target=stream_logs, args=(proc.stdout, "BOT-OUT"), daemon=True).start()
    threading.Thread(target=stream_logs, args=(proc.stderr, "BOT-ERR"), daemon=True).start()

    app_state.bot_process = proc
    _logger.info(f"Bot started successfully (PID: {proc.pid})")
    return proc


def stop_bot_subprocess(app_state, bot_lock):
    """Stop the bot subprocess if running.

    Used by app.py lifespan, bot router, and system router.
    """
    _logger = logging.getLogger("bot_process")

    with bot_lock:
        bot_proc = getattr(app_state, 'bot_process', None)
        if not bot_proc or bot_proc.poll() is not None:
            app_state.bot_process = None
            return False

        try:
            bot_proc.terminate()
            bot_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            bot_proc.kill()
        except Exception as e:
            _logger.error(f"Error stopping bot: {e}")
        finally:
            app_state.bot_process = None
            _logger.info("Bot subprocess stopped.")
        return True

# ==================== Categorizer ====================
def categorizer(text, bot_name, db=None):
    """
    Match message text against topics' keywords for a specific bot.
    Keywords are read from the database when db is provided; falls back
    to config.yaml otherwise.

    Returns: (matched_topics, matched_categories, matched_keywords)
    """
    config = load_config()

    found_topics = []
    found_categories = []
    found_keywords = []

    # Get bot config (still needed for category/topic structure and enabled flags)
    bots = config.get('bots', {})
    if bot_name not in bots:
        return None, None, None

    bot = bots[bot_name]
    categories = bot.get('categories', {})

    # Iterate through categories → topics → keywords
    for category_name, category_data in categories.items():
        if not category_data.get('enabled', True):
            continue

        topics = category_data.get('topics', {})
        for topic_name, topic_data in topics.items():
            if not topic_data.get('enabled', True):
                continue

            # Keywords source: DB when available, config as fallback
            if db is not None:
                keywords = db.get_topic_keywords(bot_name, category_name, topic_name)
            else:
                keywords = topic_data.get('keywords', [])

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

            if topic_matched and category_name not in found_categories:
                found_categories.append(category_name)

    if not found_topics:
        return None, None, None

    return found_topics, found_categories, found_keywords