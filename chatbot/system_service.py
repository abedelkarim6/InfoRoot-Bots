"""
System Chatbot service: session management and Agno Team for system control.
Unlike the data chatbot, this one has WRITE access to system configuration.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta

from agno.agent import Agent
from agno.team import Team
from agno.models.google import Gemini

from chatbot.system_toolkits import (
    SystemControlToolkit, TopicControlToolkit, YouTubeControlToolkit,
    ScheduleControlToolkit, PromptControlToolkit,
)
from chatbot.prompts import (
    SYSTEM_TEAM_INSTRUCTIONS,
    SYSTEM_AGENT_INSTRUCTIONS,
    TOPIC_AGENT_INSTRUCTIONS,
    YOUTUBE_CONTROL_AGENT_INSTRUCTIONS,
    SCHEDULE_AGENT_INSTRUCTIONS,
    PROMPT_AGENT_INSTRUCTIONS,
)

logger = logging.getLogger(__name__)

_sessions: dict = {}
SESSION_TTL_HOURS = 2


def _load_gemini_config():
    from utils.helpers import load_config
    cfg = load_config()
    from utils.gemini_models import get_gemini_model
    gemini_cfg = cfg.get("gemini", {})
    project  = gemini_cfg.get("project", "")
    location = gemini_cfg.get("location", "global")
    model_id = get_gemini_model(cfg)
    return project, location, model_id


def _build_system_team(action_log: list):
    """Construct an Agno Team with system control agents."""
    project, location, model_id = _load_gemini_config()

    import os
    from utils.helpers import load_config
    from utils.database import get_db
    if project:
        os.environ["GOOGLE_CLOUD_PROJECT"] = project
    os.environ["GOOGLE_CLOUD_LOCATION"] = location
    model = Gemini(id=model_id, vertexai=True)

    from agno.db.postgres import PostgresDb
    _app_db = get_db()
    _agno_db_url = _app_db.dsn.replace("postgresql://", "postgresql+psycopg2://", 1)
    agno_db = PostgresDb(db_url=_agno_db_url, session_table="agno_syschat_sessions")


    system_agent = Agent(
        name="SystemAgent",
        role="System controller — manages system on/off, bots, and collections",
        model=model,
        tools=[SystemControlToolkit(action_log)],
        instructions=SYSTEM_AGENT_INSTRUCTIONS,
    )

    topic_agent = Agent(
        name="TopicAgent",
        role="Topic manager — full read/write control over categories, topics, and keywords",
        model=model,
        tools=[TopicControlToolkit(action_log)],
        instructions=TOPIC_AGENT_INSTRUCTIONS,
    )

    youtube_agent = Agent(
        name="YouTubeAgent",
        role="YouTube manager — controls channels and keyword trackers",
        model=model,
        tools=[YouTubeControlToolkit(action_log)],
        instructions=YOUTUBE_CONTROL_AGENT_INSTRUCTIONS,
    )

    schedule_agent = Agent(
        name="ScheduleAgent",
        role="Schedule manager — reads and modifies when and how summaries are generated per topic",
        model=model,
        tools=[ScheduleControlToolkit(action_log)],
        instructions=SCHEDULE_AGENT_INSTRUCTIONS,
    )

    prompt_agent = Agent(
        name="PromptAgent",
        role="Prompt manager — reads and modifies the text templates used for summary generation",
        model=model,
        tools=[PromptControlToolkit(action_log)],
        instructions=PROMPT_AGENT_INSTRUCTIONS,
    )

    team = Team(
        name="SystemControlTeam",
        model=model,
        members=[system_agent, topic_agent, youtube_agent, schedule_agent, prompt_agent],
        mode="coordinate",
        share_member_interactions=True,
        add_history_to_context=True,
        num_history_runs=10,
        markdown=True,
        instructions=[SYSTEM_TEAM_INSTRUCTIONS],
        db=agno_db,
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


async def stream_system_message(session_id: str, message: str):
    """Stream system agent response as SSE events (step / delta / done / error)."""
    import json as _json

    def _sse(t, d):
        d['type'] = t
        return f"data: {_json.dumps(d, ensure_ascii=False)}\n\n"

    session = _sessions.get(session_id)
    if not session:
        yield _sse('error', {'message': f'Session {session_id} not found'})
        return

    team = session['team']
    action_log = session['action_log']
    action_log.clear()

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _run():
        try:
            for evt in team.run(message, stream=True, stream_events=True, stream_member_events=True):
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
    yield _sse('done', {'content': final_text, 'actions': list(action_log)})

    session['messages'].append({'role': 'user', 'text': message})
    session['messages'].append({'role': 'assistant', 'text': final_text, 'actions': list(action_log)})


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
