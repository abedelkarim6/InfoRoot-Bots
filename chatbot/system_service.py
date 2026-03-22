"""
System Chatbot service: session management and Agno Team for system control.
Unlike the data chatbot, this one has WRITE access to system configuration.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from agno.agent import Agent
from agno.team import Team
from agno.models.google import Gemini

from chatbot.system_toolkits import SystemControlToolkit, TopicControlToolkit, YouTubeControlToolkit

logger = logging.getLogger(__name__)

_sessions: dict = {}
SESSION_TTL_HOURS = 2

SYSTEM_TEAM_INSTRUCTIONS = """You are a system administrator assistant for a news monitoring platform.
You can READ and MODIFY system configuration: toggle features on/off, manage YouTube keywords/channels, and control news topics.

You have access to specialized agents:
- SystemAgent: controls system-level settings (on/off), bots, and collections
- TopicAgent: manages news topics, categories, and their keywords
- YouTubeAgent: manages YouTube channels and keyword trackers

IMPORTANT RULES:
- Always confirm what the user wants before making destructive changes (deletes)
- For toggle actions, just do it — the user explicitly asked
- After any change, briefly confirm what was done
- When listing items, format them clearly with status indicators
- If the user asks to see status, use the get/list tools first
- Answer in the same language the user uses"""


def _load_gemini_config():
    from utils.helpers import load_config
    cfg = load_config()
    gemini_cfg = cfg.get("gemini", {})
    return gemini_cfg.get("api_key", ""), gemini_cfg.get("model", "gemini-2.0-flash")


def _build_system_team(action_log: list):
    """Construct an Agno Team with system control agents."""
    api_key, model_id = _load_gemini_config()
    model = Gemini(id=model_id, api_key=api_key)

    system_agent = Agent(
        name="SystemAgent",
        role="System controller — manages system on/off, bots, and collections",
        model=model,
        tools=[SystemControlToolkit(action_log)],
        instructions=[
            "You control system-level settings.",
            "Use get_system_overview to see current state before making changes.",
            "Use toggle_system to turn the whole system on or off.",
            "Use toggle_collection to enable/disable collections.",
        ],
    )

    topic_agent = Agent(
        name="TopicAgent",
        role="Topic manager — controls categories, topics, and keywords",
        model=model,
        tools=[TopicControlToolkit(action_log)],
        instructions=[
            "You manage news topics and categories.",
            "Use get_topics to see categories/topics for a bot.",
            "Use toggle_category or toggle_topic to enable/disable.",
            "Use add_topic_keyword or remove_topic_keyword to manage keywords.",
        ],
    )

    youtube_agent = Agent(
        name="YouTubeAgent",
        role="YouTube manager — controls channels and keyword trackers",
        model=model,
        tools=[YouTubeControlToolkit(action_log)],
        instructions=[
            "You manage YouTube monitoring configuration.",
            "Use get_yt_channels and get_yt_keywords to see current state.",
            "Use toggle_yt_channel or toggle_yt_keyword to enable/disable.",
            "Use add_yt_keyword to create new trackers, delete_yt_keyword to remove.",
            "Use run_yt_keyword to manually trigger a keyword search.",
        ],
    )

    team = Team(
        name="SystemControlTeam",
        model=model,
        members=[system_agent, topic_agent, youtube_agent],
        mode="coordinate",
        share_member_interactions=True,
        markdown=True,
        instructions=[SYSTEM_TEAM_INSTRUCTIONS],
    )

    return team


def create_system_session() -> str:
    _cleanup_old_sessions()
    session_id = "sys-" + str(uuid.uuid4())[:8]
    action_log = []
    team = _build_system_team(action_log)
    _sessions[session_id] = {
        "team": team,
        "action_log": action_log,
        "messages": [],
        "created_at": datetime.utcnow(),
    }
    logger.info(f"[SYS-CHAT] Session {session_id} created")
    return session_id


async def send_system_message(session_id: str, message: str) -> dict:
    """Send a message and return {reply, actions}."""
    session = _sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")

    team = session["team"]
    action_log = session["action_log"]

    # Clear action log before this message
    action_log.clear()

    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(None, lambda: team.run(message))

    reply = response.content if response else "No response from the team."

    # Collect actions performed during this message
    actions = list(action_log)

    session["messages"].append({"role": "user", "text": message})
    session["messages"].append({"role": "assistant", "text": reply, "actions": actions})

    return {"reply": reply, "actions": actions}


def delete_system_session(session_id: str):
    removed = _sessions.pop(session_id, None)
    if removed:
        logger.info(f"[SYS-CHAT] Session {session_id} ended")


def _cleanup_old_sessions():
    cutoff = datetime.utcnow() - timedelta(hours=SESSION_TTL_HOURS)
    expired = [sid for sid, s in _sessions.items() if s["created_at"] < cutoff]
    for sid in expired:
        _sessions.pop(sid, None)
    if expired:
        logger.info(f"[SYS-CHAT] Cleaned up {len(expired)} expired session(s)")
