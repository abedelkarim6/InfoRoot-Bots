"""
Agent Chatbot service: session management and Agno Team construction.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from agno.agent import Agent
from agno.team import Team
from agno.models.google import Gemini

from chatbot.toolkits import SummaryToolkit, DashboardToolkit, MessageToolkit, YouTubeToolkit

logger = logging.getLogger(__name__)

# In-memory sessions: session_id -> {team, messages, created_at}
_sessions: dict = {}

SESSION_TTL_HOURS = 2

TEAM_INSTRUCTIONS = """You are a data analysis assistant for a news monitoring system that tracks both Telegram channels and YouTube videos.

You have access to specialized agents:
- NewsSummaryAgent: for analyzing news summaries from Telegram, topic trends, and system analytics
- MessageSearchAgent: for finding and reading specific raw messages from monitored Telegram channels
- YouTubeAgent: for YouTube video summaries, channel monitoring status, and keyword tracker data

Delegate to the appropriate agent(s) based on the user's question. For cross-domain questions (e.g. comparing news coverage with YouTube analysis), combine results from multiple agents.

Guidelines:
- Always provide clear, structured answers with concrete data
- When showing summaries or messages, include timestamps and source info
- For trend questions, use the analytics tool with appropriate day ranges
- If a user asks about a specific summary or video, fetch the full detail by ID
- Present numbers and stats clearly
- Answer in the same language the user uses"""


def _load_gemini_config():
    """Read Gemini config from config.yaml."""
    from utils.helpers import load_config
    cfg = load_config()
    gemini_cfg = cfg.get("gemini", {})
    api_key = gemini_cfg.get("api_key", "")
    model_id = gemini_cfg.get("model", "gemini-2.0-flash")
    return api_key, model_id


def _build_team(db, yt_db):
    """Construct an Agno Team with specialized agents."""
    api_key, model_id = _load_gemini_config()

    model = Gemini(id=model_id, api_key=api_key)

    news_agent = Agent(
        name="NewsSummaryAgent",
        role="News summary analyst — analyzes Telegram news summaries, trends, and system analytics",
        model=model,
        tools=[SummaryToolkit(db), DashboardToolkit(db)],
        instructions=[
            "You analyze news summaries and provide insights about topics, trends, and analytics.",
            "Use get_recent_summaries to see what summaries exist, then get_summary_by_id for full text.",
            "Use get_analytics for trend data over time periods.",
        ],
    )

    message_agent = Agent(
        name="MessageSearchAgent",
        role="Message search specialist — searches and retrieves raw Telegram messages",
        model=model,
        tools=[MessageToolkit(db)],
        instructions=[
            "You search and retrieve raw messages from monitored Telegram channels.",
            "Use search_messages with topic/source filters for targeted searches.",
            "Use get_recent_messages for a general overview of latest messages.",
        ],
    )

    youtube_agent = Agent(
        name="YouTubeAgent",
        role="YouTube content analyst — analyzes YouTube video summaries and monitoring data",
        model=model,
        tools=[YouTubeToolkit(yt_db)],
        instructions=[
            "You analyze YouTube video summaries and monitoring data.",
            "Use get_video_summaries to list summaries, get_video_summary_detail for full text.",
            "Use get_tracked_keywords to show what keyword searches are configured.",
            "Use get_youtube_overview for system stats.",
        ],
    )

    team = Team(
        name="DataAnalystTeam",
        model=model,
        members=[news_agent, message_agent, youtube_agent],
        mode="coordinate",
        share_member_interactions=True,
        markdown=True,
        instructions=[TEAM_INSTRUCTIONS],
    )

    return team


def _cleanup_old_sessions():
    """Remove sessions older than TTL."""
    cutoff = datetime.utcnow() - timedelta(hours=SESSION_TTL_HOURS)
    expired = [sid for sid, s in _sessions.items() if s["created_at"] < cutoff]
    for sid in expired:
        _sessions.pop(sid, None)
    if expired:
        logger.info(f"[CHATBOT] Cleaned up {len(expired)} expired session(s)")


def create_session(db, yt_db) -> str:
    """Create a new chatbot session with a fresh Team."""
    _cleanup_old_sessions()

    session_id = str(uuid.uuid4())[:8]
    team = _build_team(db, yt_db)
    _sessions[session_id] = {
        "team": team,
        "messages": [],
        "created_at": datetime.utcnow(),
    }
    logger.info(f"[CHATBOT] Session {session_id} created")
    return session_id


async def send_message(session_id: str, message: str, context: dict = None) -> str:
    """Send a user message to the team and get the AI response."""
    session = _sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")

    team = session["team"]

    # Prepend context instruction if a context filter is active
    full_message = message
    if context and context.get("type") and context.get("value"):
        ctx_type = context["type"]
        ctx_value = context["value"]
        label_map = {
            "topic": "topic",
            "category": "category",
            "yt-channel": "YouTube channel",
            "yt-keyword": "YouTube keyword",
        }
        label = label_map.get(ctx_type, ctx_type)
        full_message = (
            f"[Context: The user is focused on {label} \"{ctx_value}\". "
            f"Prioritize data related to this {label} in your answer.]\n\n{message}"
        )

    # Run in executor since Agno team.run() may block
    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(None, lambda: team.run(full_message))

    reply = response.content if response else "No response from the team."

    session["messages"].append({"role": "user", "text": message})
    session["messages"].append({"role": "assistant", "text": reply})

    return reply


def get_session(session_id: str) -> dict | None:
    """Get session info (without the team object)."""
    s = _sessions.get(session_id)
    if not s:
        return None
    return {
        "session_id": session_id,
        "messages": s["messages"],
        "created_at": s["created_at"].isoformat(),
    }


def delete_session(session_id: str):
    """Delete a session."""
    removed = _sessions.pop(session_id, None)
    if removed:
        logger.info(f"[CHATBOT] Session {session_id} ended")


# Suggestions cache: {informative: [...], analytical: [...], generated_at: datetime}
_suggestions_cache = {"informative": [], "analytical": [], "generated_at": None}
SUGGESTIONS_TTL_MINUTES = 10


async def generate_suggestions(db) -> dict:
    """Return cached AI suggestions or generate new ones. Returns {informative: [...], analytical: [...]}."""
    # Return cache if fresh
    if (_suggestions_cache["generated_at"]
            and datetime.utcnow() - _suggestions_cache["generated_at"] < timedelta(minutes=SUGGESTIONS_TTL_MINUTES)
            and (_suggestions_cache["informative"] or _suggestions_cache["analytical"])):
        return {"informative": _suggestions_cache["informative"], "analytical": _suggestions_cache["analytical"]}

    result = await _generate_suggestions_from_ai(db)
    return result


async def _generate_suggestions_from_ai(db) -> dict:
    """Generate suggestions via Gemini and update cache."""
    api_key, _ = _load_gemini_config()
    if not api_key:
        return {"informative": [], "analytical": []}

    summaries = db.get_recent_summaries(limit=15)
    if not summaries:
        return {"informative": [], "analytical": []}

    # Filter to last 2 days, fallback to latest 5
    cutoff = datetime.utcnow() - timedelta(days=2)
    recent = []
    for s in summaries:
        ts = s.get("timestamp")
        if ts:
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
                except Exception:
                    continue
            if ts >= cutoff:
                recent.append(s)
    if not recent:
        recent = summaries[:5]

    # Compact context — just topic + short preview, no timestamps
    lines = []
    for s in recent[:8]:
        topic = s.get("topic_name", "")
        preview = (s.get("preview", "") or "")[:120]
        lines.append(f"- {topic}: {preview}")
    context = "\n".join(lines)

    prompt = f"""Given these recent news summaries, generate exactly 6 short questions (under 70 chars each).

Data:
{context}

Return exactly 6 lines, no numbering, no bullets:
Lines 1-3: Informative questions (what happened, latest updates, key facts)
Lines 4-6: Analytical questions (trends, comparisons, patterns, why)"""

    try:
        import google.genai as genai
        client = genai.Client(api_key=api_key)
        loop = asyncio.get_event_loop()
        # Use flash-lite for speed — this is a simple generation task
        response = await loop.run_in_executor(
            None, lambda: client.models.generate_content(
                model="gemini-2.0-flash-lite",
                contents=prompt,
            )
        )
        text = response.text.strip()
        questions = [q.strip().lstrip("0123456789.-) ") for q in text.split("\n") if q.strip()]

        informative = questions[:3]
        analytical = questions[3:6]

        _suggestions_cache["informative"] = informative
        _suggestions_cache["analytical"] = analytical
        _suggestions_cache["generated_at"] = datetime.utcnow()

        return {"informative": informative, "analytical": analytical}
    except Exception as e:
        logger.error(f"[CHATBOT] Failed to generate suggestions: {e}")
        return {"informative": [], "analytical": []}
