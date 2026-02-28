import sys
import logging
import threading
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

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import RedirectResponse

from routers import bot, category, telegram, prompts, rules, system, collection, topic, monitor, auth
from routers.auth import validate_token
from utils.database import Database, set_db_instance
from utils.helpers import load_config as _load_cfg, start_bot_subprocess, stop_bot_subprocess

_cfg = _load_cfg()
db = Database(_cfg["database"]["dsn"])
set_db_instance(db)
db.seed_keywords_from_config(_cfg)


class TokenAuthMiddleware(BaseHTTPMiddleware):
    _OPEN = {"/login", "/api/auth/login", "/favicon.ico"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

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

# Global bot process management
bot_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    """Auto-start the bot on server startup, stop it on shutdown."""
    start_bot_subprocess(app.state)
    yield
    stop_bot_subprocess(app.state, bot_lock)


app = FastAPI(title="Telegram Bot Admin", lifespan=lifespan)
app.add_middleware(TokenAuthMiddleware)

# Make these available to routers
app.state.bot_process = None
app.state.bot_lock = bot_lock

# Serve static HTML/JS/CSS
app.mount("/static", StaticFiles(directory="static"), name="static")

# Include routers
app.include_router(system.router, prefix="/api", tags=["system"])
app.include_router(collection.router, prefix="/api", tags=["collection"])
app.include_router(bot.router, prefix="/api", tags=["bot"])
app.include_router(topic.router, prefix="/api", tags=["topic"])
app.include_router(category.router, prefix="/api", tags=["category"])
app.include_router(telegram.router, prefix="/api", tags=["telegram"])
app.include_router(prompts.router, prefix="/api", tags=["prompts"])
app.include_router(rules.router, prefix="/api", tags=["rules"])
app.include_router(monitor.router, prefix="/api", tags=["monitor"])
app.include_router(auth.router, prefix="/api", tags=["auth"])

# Serve static pages
@app.get("/login")
def login_page():
    return FileResponse("static/login.html")

@app.get("/")
def main_page():
    return FileResponse("static/index.html")

@app.get("/api/config")
def get_config():
    from utils.helpers import load_config
    cfg = load_config()
    return {
        "system":      cfg.get("system", {}),
        "bots":        cfg.get("bots", {}),
        "collections": cfg.get("collections", {}),
    }
