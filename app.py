import os
import sys
import logging
from contextlib import asynccontextmanager

# Force UTF-8 on Windows
if sys.platform == 'win32':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(name)s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("app")
logging.getLogger("apscheduler.schedulers").setLevel(logging.WARNING)
logging.getLogger("apscheduler.executors").setLevel(logging.WARNING)

# Attach in-memory log buffer (used by the admin Logs page)
# Must be called after basicConfig so the root logger is already configured.
from utils.helpers import init_memory_log_handler as _init_mem_log
_init_mem_log(maxlen=1000)

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

# System routers (auth, user management — unchanged location)
from routers import auth, accounts, system, chatbot
from routers.auth import validate_token, hash_password, get_request_user_id, is_admin_request
# Summaries feature routers (moved to summaries/routers/)
from summaries.routers import bot, telegram, prompts, rules, collection, topic, monitor, recycle_bin
from summaries.db import SummariesDB
from utils.database import set_db_instance, get_db
from utils.helpers import (
    load_config as _load_cfg, start_bot_task, stop_bot_task,
    init_memory_log_handler, get_log_records, clear_log_records,
)

# YouTube monitor imports
from youtube_monitor.db import YouTubeDB, set_yt_db
from youtube_monitor.worker import init_worker
from youtube_monitor.keyword_search import init_keyword_search
from routers.youtube import router as youtube_router, websub_router
from youtube_monitor.renew_websub import renew_all_subscriptions
from youtube_monitor.cleanup import run_cleanup

_cfg = _load_cfg()
db = SummariesDB(_cfg["database"]["dsn"])
set_db_instance(db)
db.seed_keywords_from_config(_cfg)  # One-time seed; no-op if DB already has keywords
db.migrate_config_to_db(_cfg)  # Migrate bots and collections from config.yaml to DB

# Seed admin user from config.yaml into the DB (idempotent — safe to run every start)
_admin_cfg = _cfg.get("admin", {})
if _admin_cfg.get("username"):
    try:
        _admin_id = db.create_admin_user(_admin_cfg["username"], hash_password(_admin_cfg["password"]))
        logger.info(f"[AUTH] Admin user '{_admin_cfg['username']}' seeded/verified in DB")
        # Seed telegram session from config if DB row has none yet
        _tg_cfg = _cfg.get("telegram", {})
        _ss = _tg_cfg.get("string_session", "")
        if _ss and _admin_id:
            _admin_row = db.get_user_by_id(_admin_id)
            if _admin_row and not _admin_row.get("telegram_session"):
                _phone = _tg_cfg.get("phone", "") or ""
                db.update_user_telegram(_admin_id, _phone, _ss)
                logger.info(f"[AUTH] Admin telegram session seeded from config.yaml")
    except Exception as _e:
        logger.warning(f"[AUTH] Admin seed failed: {_e}")


# Initialize YouTube DB (new tables only — never touches existing tables)
yt_db = YouTubeDB(_cfg["database"]["dsn"])
set_yt_db(yt_db)

# Initialize YouTube feature — keys from config.yaml youtube section
_yt_cfg = _cfg.get("youtube", {})
init_keyword_search(youtube_data_api_key=_yt_cfg.get("data_api_key", ""))
async def _yt_telegram_send(target: str, text: str):
    """Send a Telegram message using a temporary Telethon client (userbot session)."""
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    tg_cfg = _cfg.get("telegram", {})
    # Prefer session stored in DB (set via Telegram setup page); fall back to config.yaml
    session_str = tg_cfg.get("string_session", "")
    try:
        admin_row = db.get_admin_user()
        if admin_row and admin_row.get("telegram_session"):
            session_str = admin_row["telegram_session"]
    except Exception:
        pass
    if not session_str:
        raise RuntimeError("[YT-TG] No string_session in config or DB — cannot send")
    client = TelegramClient(
        StringSession(session_str),
        int(tg_cfg["api_id"]),
        tg_cfg["api_hash"],
    )
    try:
        await client.connect()

        if not await client.is_user_authorized():
            raise RuntimeError("[YT-TG] Session is not authorized — regenerate string_session")

        # Split into ≤4096-char chunks so long summaries don't get silently dropped
        chunk_size = 4096
        chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]
        for i, chunk in enumerate(chunks):
            try:
                msg = await client.send_message(target, chunk, parse_mode='md')
            except Exception as md_err:
                # Markdown parse error — retry as plain text
                logger.warning(f"[YT-TG] Markdown send failed ({md_err}), retrying as plain text")
                msg = await client.send_message(target, chunk, parse_mode=None)
            if msg is None or not getattr(msg, 'id', None):
                raise RuntimeError(f"[YT-TG] send_message returned no message object for chunk {i+1}/{len(chunks)}")
        logger.info(f"[YT-TG] Sent {len(chunks)} chunk(s) to {target}")
    finally:
        await client.disconnect()

_gemini_cfg = _cfg.get("gemini", {})
init_worker(
    gemini_project=_yt_cfg.get("gemini_project", "") or _gemini_cfg.get("project", ""),
    gemini_location=_yt_cfg.get("gemini_location", "") or _gemini_cfg.get("location", "us-central1"),
    youtube_data_api_key=_yt_cfg.get("data_api_key", ""),
    telegram_send_fn=_yt_telegram_send,
)


class TokenAuthMiddleware(BaseHTTPMiddleware):
    _OPEN = {"/login", "/api/auth/login", "/favicon.ico"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # WebSub callback is public (YouTube hub needs unauthenticated access)
        if path.startswith("/youtube/websub/"):
            return await call_next(request)

        # Page requests and static files pass through freely.
        # auth.js in the browser handles the /login redirect client-side.
        if not path.startswith("/api/") or path in self._OPEN:
            return await call_next(request)

        # Only API routes are protected server-side.
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else None

        if token and validate_token(token):
            return await call_next(request)

        return JSONResponse({"detail": "Not authenticated"}, status_code=401)

@asynccontextmanager
async def lifespan(app):
    """Auto-start the bot on server startup, start YouTube scheduler, stop on shutdown."""
    import asyncio
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.interval import IntervalTrigger
    from youtube_monitor.worker import process_pending_queue
    from youtube_monitor.keyword_search import run_due_keyword_searches

    start_bot_task(app.state)

    # YouTube auto-processing scheduler
    yt_scheduler = AsyncIOScheduler()

    # Process video queue every 5 minutes
    yt_scheduler.add_job(process_pending_queue, IntervalTrigger(minutes=5),
                         id='yt_process_queue', replace_existing=True)

    # Check for due keyword searches every 5 minutes (per-keyword scheduling)
    yt_scheduler.add_job(run_due_keyword_searches, IntervalTrigger(minutes=5),
                         id='yt_keyword_search', replace_existing=True)

    # Renew WebSub subscriptions every 9 days
    cb_url = _yt_cfg.get("callback_url", "").rstrip("/")
    if cb_url:
        full_cb = f"{cb_url}/youtube/websub/callback"
        yt_scheduler.add_job(renew_all_subscriptions, IntervalTrigger(days=9),
                             args=[full_cb], id='yt_websub_renew', replace_existing=True)

    # Weekly queue cleanup
    yt_scheduler.add_job(run_cleanup, IntervalTrigger(weeks=1),
                         id='yt_cleanup', replace_existing=True)

    # Recycle bin auto-purge (items older than 5 days)
    def _purge_recycle_bin():
        count = db.recycle_bin_purge(days=5)
        if count:
            logger.info(f"[RECYCLE] Purged {count} items older than 5 days")
    yt_scheduler.add_job(_purge_recycle_bin, IntervalTrigger(hours=12),
                         id='recycle_bin_purge', replace_existing=True)

    # Chatbot suggestion refresh — runs once at startup, then every hour
    from chatbot.service import refresh_suggestions as _refresh_suggestions

    async def _refresh_suggestions_job():
        try:
            await _refresh_suggestions(db)
            logger.info("[CHATBOT] Suggestions refreshed")
        except Exception as e:
            logger.warning(f"[CHATBOT] Suggestion refresh failed: {e}")

    yt_scheduler.add_job(_refresh_suggestions_job, IntervalTrigger(hours=1),
                         id='chatbot_suggestions', replace_existing=True)

    yt_scheduler.start()
    logger.info("[YT-SCHEDULER] YouTube auto-processing scheduler started")

    # Warm the suggestion cache immediately at startup (non-blocking)
    import asyncio
    asyncio.create_task(_refresh_suggestions_job())

    yield

    yt_scheduler.shutdown(wait=False)
    await stop_bot_task(app.state)


app = FastAPI(title="Telegram Bot Admin", lifespan=lifespan)
app.add_middleware(TokenAuthMiddleware)

# bot_task is set by start_bot_task() inside lifespan
app.state.bot_task = None

# Serve static HTML/JS/CSS (no-cache so browser always gets latest)
@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

app.mount("/static", StaticFiles(directory="static"), name="static")

# Include routers
app.include_router(system.router, prefix="/api", tags=["system"])
app.include_router(collection.router, prefix="/api", tags=["collection"])
app.include_router(bot.router, prefix="/api", tags=["bot"])
app.include_router(topic.router, prefix="/api", tags=["topic"])
# category.py is legacy (YAML-based) — all category routes are now in topic.py (DB-based)
app.include_router(telegram.router, prefix="/api", tags=["telegram"])
app.include_router(prompts.router, prefix="/api", tags=["prompts"])
app.include_router(rules.router, prefix="/api", tags=["rules"])
app.include_router(monitor.router, prefix="/api", tags=["monitor"])
app.include_router(auth.router, prefix="/api", tags=["auth"])
app.include_router(recycle_bin.router, prefix="/api", tags=["recycle_bin"])
app.include_router(accounts.router, prefix="/api", tags=["accounts"])

# Agent chatbot
app.include_router(chatbot.router, prefix="/api", tags=["chatbot"])

# YouTube monitor routes (API endpoints under /api/youtube/*)
app.include_router(youtube_router, prefix="/api", tags=["youtube"])
# WebSub callback route (public, no /api prefix — YouTube hub needs direct access)
app.include_router(websub_router)

# Serve static pages
@app.get("/login")
def login_page():
    return FileResponse("static/login.html")


@app.get("/")
def main_page():
    return FileResponse("static/index.html")

@app.get("/api/warnings")
def get_warnings(request: Request):
    """Return all system dependency warnings (orphaned prompts, orphaned collections)."""
    db = get_db()
    return {"warnings": db.get_all_dependency_warnings()}


@app.get("/api/logs")
def api_get_logs(
    request: Request,
    level: str = None,
    search: str = None,
    limit: int = 500,
):
    """Return buffered log records. Admin only."""
    if not is_admin_request(request):
        return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
    records = get_log_records(
        level=level or None,
        search=search or None,
        limit=min(limit, 1000),
    )
    # Newest first for the UI
    return {"status": "ok", "logs": list(reversed(records))}


@app.post("/api/logs/clear")
def api_clear_logs(request: Request):
    """Clear the in-memory log buffer. Admin only."""
    if not is_admin_request(request):
        return JSONResponse({"status": "error", "message": "Admin only"}, status_code=403)
    clear_log_records()
    return {"status": "ok"}


@app.get("/api/config")
def get_config(request: Request):
    db = get_db()
    if is_admin_request(request):
        return db.get_full_config()
    # Regular user: return only their inherited bots
    user_id = get_request_user_id(request)
    if not user_id:
        return {'system': {'enabled': db.get_system_enabled()}, 'bots': {}, 'collections': {}}
    user_row = db.get_user_by_id(user_id)
    seo_visible = bool(user_row.get('seo_visible', True)) if user_row else True
    bots = db.get_filtered_bots_config(user_id)
    return {
        'system': {'enabled': db.get_system_enabled()},
        'bots': bots,
        'collections': db.get_user_collections(user_id),
        'seo_visible': seo_visible,
    }
