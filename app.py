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
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from routers import bot, category, telegram, prompts, rules, system, collection, topic
from utils.database import Database
from utils.helpers import load_config as _load_cfg, start_bot_subprocess, stop_bot_subprocess

db = Database(_load_cfg()["database"]["dsn"])

# Global bot process management
bot_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    """Auto-start the bot on server startup, stop it on shutdown."""
    start_bot_subprocess(app.state)
    yield
    stop_bot_subprocess(app.state, bot_lock)


app = FastAPI(title="Telegram Bot Admin", lifespan=lifespan)

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

# Serve static pages
@app.get("/")
def main_page():
    return FileResponse("static/index_v2.html")

@app.get("/api/config")
def get_config():
    from utils.helpers import load_config
    return load_config()
