"""
Agent Chatbot service: session management and Agno Team construction.
"""

import asyncio
import json
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

TEAM_INSTRUCTIONS = """You are a data analysis assistant for a monitoring system that tracks Telegram channels and YouTube videos.

## Agents available
- **SummaryAgent** — AI-generated summaries (digests of grouped messages per topic), analytics, pending counts
- **MessageAgent** — raw individual Telegram messages, topic-filtered messages, missed/unclassified messages
- **YouTubeAgent** — YouTube video summaries, channels, keyword trackers

## Conversation continuity — CRITICAL
- You have access to the full conversation history. ALWAYS read it before responding.
- If the user sends a short confirmation such as "yes", "ok", "sure", "go ahead", "do it", "proceed", "yep", "yeah" — look at your previous message, identify the action or query you proposed, and execute it immediately. Do NOT ask "how can I help?" or restate the options.
- If the user's message is ambiguous but the conversation history makes the intent clear, act on that intent.
- Never lose context between turns.

## Key distinction — summaries vs messages
- **Summaries** = AI-generated digests produced after grouping many messages under a topic → **SummaryAgent**
- **Messages** = raw individual posts from Telegram channels → **MessageAgent**
- **Missed messages** = messages not matched to any topic keyword → **MessageAgent**
- "summaries", "digest", "what was summarized" → SummaryAgent
- "messages", "posts", "what was sent", "missed", "unclassified" → MessageAgent

## Assume-and-proceed rules
- NEVER ask the user for filters you can discover via a tool.
- If the user says "the topic", "my bot", "the channel" without naming one: have the agent fetch available options and act on the best match.
- Default time range: **7 days**. Default result limit: **20 items**.
- Date expressions → `days` integer: "last 3 days" → 3, "this week" → 7, "today" → 1, "last month" → 30.

## Output format rules — ALWAYS follow these
Structure every response using markdown:

**Lists (summaries, messages, videos):**
```
## 📰 [Section Title]
1. **[Topic Name]**
   📅 [date] · 📡 [source/bot]
   [One-line preview]
```

**Data tables (stats, counts):**
Markdown table with clear headers. Keep rows concise.

**Single item detail:**
`##` heading, then `**Field:** value` pairs, then `---`, then full content.

**Status overview:**
Short bullet list with ✅/❌/⚠️ indicators.

## General rules
- Always include timestamps and source names when showing content.
- Present numbers and stats in a table or labeled list — never in a paragraph.
- End analytical answers with a **📌 Key takeaway** line.
- Answer in the same language the user uses."""


def _load_gemini_config():
    """Read Vertex AI Gemini config from config.yaml."""
    from utils.helpers import load_config
    cfg = load_config()
    gemini_cfg = cfg.get("gemini", {})
    project  = gemini_cfg.get("project", "")
    location = gemini_cfg.get("location", "us-central1")
    model_id = gemini_cfg.get("model", "gemini-2.0-flash")
    return project, location, model_id


def _build_team(db, yt_db):
    """Construct an Agno Team with specialized agents."""
    project, location, model_id = _load_gemini_config()

    import os
    if project:
        os.environ["GOOGLE_CLOUD_PROJECT"] = project
    os.environ["GOOGLE_CLOUD_LOCATION"] = location
    model = Gemini(id=model_id, vertexai=True)

    from agno.db.postgres import PostgresDb
    _agno_db_url = db.dsn.replace("postgresql://", "postgresql+psycopg2://", 1)
    agno_db = PostgresDb(db_url=_agno_db_url, session_table="agno_chatbot_sessions")

    summary_agent = Agent(
        name="SummaryAgent",
        role="Summary analyst — fetches and analyzes AI-generated summaries of grouped topic messages, trends, and pending counts",
        model=model,
        tools=[SummaryToolkit(db), DashboardToolkit(db)],
        instructions=[
            "You work with AI-generated summaries — these are digests produced after grouping multiple messages under a topic. They are NOT raw messages.",
            "ASSUME AND PROCEED: never claim you cannot filter by date — get_recent_summaries and search_summaries both accept a `days` parameter.",
            "Date range conversion (do this silently, never explain): 'last 3 days' → days=3, 'this week' → days=7, 'today' → days=1, 'last month' → days=30.",
            "Default days=7 and limit=20 when not specified.",
            "Workflow: call get_recent_summaries(days=N) or search_summaries(topic=X, days=N) first. Use get_summary_by_id only when the user asks for full text of a specific entry.",
            "For volume/trend stats: call get_analytics(days=N).",
            "For pending backlog: call get_pending_summary_counts().",
            "FORMAT summaries: '## 📋 Summaries — Last N Days' header, numbered list: **topic name**, '📅 date · 🤖 bot · 📨 N messages', one-sentence preview.",
            "FORMAT analytics: markdown table (Topic | Messages | Summaries | Trend). End with '📌 Key takeaway'.",
            "Never return unstructured text walls.",
        ],
    )

    message_agent = Agent(
        name="MessageAgent",
        role="Message analyst — searches raw Telegram messages by topic, source, or date; identifies missed/unclassified messages",
        model=model,
        tools=[MessageToolkit(db)],
        instructions=[
            "You work with raw individual Telegram messages — the original content before summarization.",
            "ASSUME AND PROCEED: never ask which topic or channel to use — fetch broadly and filter from results.",
            "Tool selection guide:",
            "  - User asks about messages for a topic → get_messages_by_topic(topic, days)",
            "  - User asks for recent messages with no filter → get_recent_messages(limit, days)",
            "  - User wants to search by topic AND source → search_messages(topic, source, days)",
            "  - User asks about missed/ignored/unclassified messages → get_missed_messages_stats() first, then get_missed_messages()",
            "Default days=7 when not specified.",
            "FORMAT: numbered list — **channel_username**, '📅 date · 🏷️ topics', message preview (2 lines max).",
            "Group by channel when returning 10+ messages.",
            "For missed messages: show stats table first (Bot | Collection | Count), then list examples.",
        ],
    )

    youtube_agent = Agent(
        name="YouTubeAgent",
        role="YouTube analyst — video summaries, channel monitoring, keyword tracker data",
        model=model,
        tools=[YouTubeToolkit(yt_db)],
        instructions=[
            "You analyze YouTube video summaries and monitoring configuration.",
            "ASSUME AND PROCEED: if no filter is given, call get_youtube_overview then get_video_summaries with defaults.",
            "Use get_video_summaries(date_from, date_to) for date-filtered video lists.",
            "Use get_tracked_keywords to show keyword tracker configs and schedules.",
            "Use get_video_summary_detail only when user asks for the full text of a specific video.",
            "FORMAT videos: numbered list — **title**, '📺 channel · 📅 date · 🔑 keyword', one-sentence preview.",
            "FORMAT keyword/channel status: markdown table (Name | Status | Last Run | Schedule).",
            "End multi-item answers with '📌 Key takeaway'.",
        ],
    )

    team = Team(
        name="DataAnalystTeam",
        model=model,
        members=[summary_agent, message_agent, youtube_agent],
        mode="coordinate",
        share_member_interactions=True,
        add_history_to_context=True,
        num_history_runs=10,
        markdown=True,
        instructions=[TEAM_INSTRUCTIONS],
        db=agno_db,
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


async def stream_message(session_id: str, message: str, context: dict = None):
    """Stream agent response as SSE events (step / delta / done / error)."""
    import json as _json

    def _sse(t, d):
        d['type'] = t
        return f"data: {_json.dumps(d, ensure_ascii=False)}\n\n"

    session = _sessions.get(session_id)
    if not session:
        yield _sse('error', {'message': f'Session {session_id} not found'})
        return

    team = session['team']

    full_message = message
    if context and context.get('type') and context.get('value'):
        ctx_type = context['type']
        ctx_value = context['value']
        label_map = {
            'topic': 'topic', 'category': 'category',
            'yt-channel': 'YouTube channel', 'yt-keyword': 'YouTube keyword',
        }
        label = label_map.get(ctx_type, ctx_type)
        full_message = (
            f"[Context: The user is focused on {label} \"{ctx_value}\". "
            f"Prioritize data related to this {label} in your answer.]\n\n{message}"
        )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _run():
        try:
            for evt in team.run(full_message, stream=True, stream_events=True, stream_member_events=True):
                loop.call_soon_threadsafe(queue.put_nowait, evt)
        except Exception as exc:
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, _run)

    content_parts = []

    while True:
        item = await queue.get()
        if item is None:
            break
        if isinstance(item, Exception):
            yield _sse('error', {'message': str(item)})
            return

        evt_str = str(getattr(item, 'event', ''))

        if 'ToolCallStarted' in evt_str:
            tool = getattr(item, 'tool', None)
            tool_name = (getattr(tool, 'tool_name', '') or '') if tool else ''
            agent_name = getattr(item, 'agent_name', '') or ''
            if 'transfer' in tool_name.lower():
                tool_args = (getattr(tool, 'tool_args', {}) or {}) if tool else {}
                target = tool_args.get('agent_name') or tool_args.get('member_name') or ''
                label = f"→ {target}" if target else "→ Routing to agent"
            elif agent_name:
                label = f"{agent_name}: {tool_name.replace('_', ' ')}"
            else:
                label = tool_name.replace('_', ' ') or evt_str
            yield _sse('step', {'icon': '🔧', 'label': label})

        elif 'ReasoningStep' in evt_str:
            rc = getattr(item, 'reasoning_content', '') or ''
            if rc:
                yield _sse('step', {'icon': '💭', 'label': rc[:120]})

        elif evt_str.endswith('RunContent') and 'Intermediate' not in evt_str:
            chunk = getattr(item, 'content', '') or ''
            if chunk:
                content_parts.append(chunk)
                yield _sse('delta', {'content': chunk})

    final_text = ''.join(content_parts)
    yield _sse('done', {'content': final_text})

    session['messages'].append({'role': 'user', 'text': message})
    session['messages'].append({'role': 'assistant', 'text': final_text})


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


async def generate_suggestions(db) -> dict:
    """Return cached suggestions immediately. Never blocks — background job keeps cache warm."""
    return {"informative": _suggestions_cache["informative"], "analytical": _suggestions_cache["analytical"]}


async def refresh_suggestions(db) -> dict:
    """Generate fresh suggestions and update the cache. Called by the hourly scheduler."""
    return await _generate_suggestions_from_ai(db)


async def _generate_suggestions_from_ai(db) -> dict:
    """Generate suggestions via Vertex AI Gemini and update cache."""
    project, location, _ = _load_gemini_config()
    if not project:
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
        from google.genai import types as gtypes
        client = genai.Client(vertexai=True, project=project, location=location)
        loop = asyncio.get_event_loop()
        # Use flash-lite for speed — this is a simple generation task
        response = await loop.run_in_executor(
            None, lambda: client.models.generate_content(
                model="gemini-2.5-flash-lite",
                # model="gemini-2.0-flash-001",
                contents=prompt,
                config=gtypes.GenerateContentConfig(labels={"service": "agents"}),
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
