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

logger = logging.getLogger(__name__)

_sessions: dict = {}
SESSION_TTL_HOURS = 2

SYSTEM_TEAM_INSTRUCTIONS = """You are a system administrator assistant for a news monitoring platform with READ and WRITE access to system configuration.

## Agents available
- **SystemAgent** — system on/off, bots, collections
- **TopicAgent** — categories, topics, keywords
- **YouTubeAgent** — YouTube channels and keyword trackers
- **ScheduleAgent** — topic schedule timing (when summaries run and where they're sent)
- **PromptAgent** — bot prompt templates (text used during summary generation)

## Conversation continuity — CRITICAL
- You have access to the full conversation history. ALWAYS read it before responding.
- If the user sends a short confirmation such as "yes", "ok", "sure", "go ahead", "do it", "proceed" — look at the previous message, identify the action proposed, and execute it immediately. Never ask "how can I help?" after a confirmation.
- Never lose context between turns.

## Assume-and-proceed rules — CRITICAL, NEVER BREAK
- NEVER ask the user for information you can fetch with a tool.
- If the user says "the bot", "a topic", "the keyword", etc. without naming it: fetch the list first, then act on the only match or the most obviously relevant one.
- If there is only one bot, one collection, or one channel — use it without asking.
- If there are multiple options and the user's intent clearly points to one (name match, partial match, only active one) — use it.
- Only ask for clarification when: (a) multiple options exist AND (b) the action is destructive (delete/remove) AND (c) you genuinely cannot determine which one the user means.
- For toggle/enable/disable: just do it — the user explicitly asked. Confirm after.
- For reads and analysis: fetch first, present results, never ask for parameters upfront.

## Output format rules — ALWAYS follow these

**System status overview:**
```
## ⚙️ System Status
- **System:** ✅ ON / ❌ OFF
- **Collections:** N active, N inactive
- **Bots:** list with status
```

**Topic / category list:**
Use a structured list grouped by bot:
```
## 📋 Topics — [Bot Name]
### [Category Name] (✅ active / ❌ disabled)
- **[Topic]** — keywords: word1, word2 · ✅/❌
```

**YouTube keywords/channels:**
Use a markdown table: Name | Status | Last Run | Notes

**After any change:**
One confirmation line per action: `✅ [Entity] "[name]" → [what changed]`
If multiple changes: use a short bullet list of confirmations.

**Analysis / assessment:**
Use `##` sections, bullet points for findings, and a `📌 Summary` line at the end.

- Answer in the same language the user uses."""


def _load_gemini_config():
    from utils.helpers import load_config
    cfg = load_config()
    gemini_cfg = cfg.get("gemini", {})
    project  = gemini_cfg.get("project", "")
    location = gemini_cfg.get("location", "us-central1")
    model_id = gemini_cfg.get("model", "gemini-2.0-flash")
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
        instructions=[
            "You control system-level settings: the whole system, individual bots, and collections.",
            "Always call get_system_overview first to see current state.",
            "ASSUME AND PROCEED: if the user says 'the collection' or 'the bot' without naming it, use get_system_overview then act on the only one or most relevant.",
            "All tools accept partial/fuzzy names — the tool resolves exact names from the DB internally.",
            "Use toggle_system to turn the whole monitoring system on or off.",
            "Use toggle_bot to enable/disable a specific bot.",
            "Use toggle_collection to enable/disable a collection.",
            "FORMAT: '## ⚙️ System Status' with ✅/❌ bullet points.",
            "After changes: '✅ [Entity] \"[name]\" → [enabled/disabled]'.",
        ],
    )

    topic_agent = Agent(
        name="TopicAgent",
        role="Topic manager — full read/write control over categories, topics, and keywords",
        model=model,
        tools=[TopicControlToolkit(action_log)],
        instructions=[
            "You have FULL write access to categories, topics, and keywords.",
            "ALWAYS call get_all_topics first — never ask the user which bot or category.",
            "All tools accept partial/fuzzy names — they resolve exact names from the DB. Pass the user's phrasing as-is.",
            "Available write operations: toggle_category, toggle_topic, add_category, delete_category, add_topic, delete_topic, add_topic_keyword, remove_topic_keyword, set_topic_keywords.",
            "For add operations: use the user's exact phrasing as the name.",
            "For delete operations: confirm with user first, then call the tool.",
            "After every write: confirm the EXACT names returned by the tool response.",
            "FORMAT topic listings grouped by bot then category with enabled/disabled and keywords listed.",
            "After changes: '✅ [operation] \"[name]\" in [bot/category] → [result]'.",
        ],
    )

    youtube_agent = Agent(
        name="YouTubeAgent",
        role="YouTube manager — controls channels and keyword trackers",
        model=model,
        tools=[YouTubeControlToolkit(action_log)],
        instructions=[
            "You manage YouTube monitoring: channels and keyword trackers.",
            "Always call get_yt_channels or get_yt_keywords first to see current state.",
            "ASSUME AND PROCEED: if the user says 'the keyword' or 'the channel' without naming it, fetch the list and act on the only one or best match.",
            "All tools accept partial text or numeric IDs — they resolve exact matches internally.",
            "Use toggle_yt_channel or toggle_yt_keyword to enable/disable.",
            "Use add_yt_keyword for new trackers (ask for keyword text only if not provided at all).",
            "Use delete_yt_keyword only after confirming with the user.",
            "Use run_yt_keyword to trigger a search immediately.",
            "FORMAT: markdown table — Name | Status | Last Run | Schedule.",
            "After changes: '✅ [Entity] \"[name]\" → [what changed]'.",
        ],
    )

    schedule_agent = Agent(
        name="ScheduleAgent",
        role="Schedule manager — reads and modifies when and how summaries are generated per topic",
        model=model,
        tools=[ScheduleControlToolkit(action_log)],
        instructions=[
            "You manage schedules: timing configurations that control when summaries are generated and sent.",
            "Always call get_topic_schedules (with no args for all) first to see existing schedules.",
            "Schedule types: 'hourly' (set minute), 'daily' (set hour+minute), 'minute' (every N mins, set minute=N), 'interval' (every N hours, set hours+start_hour+start_minute).",
            "Use add_topic_schedule to create new schedules. Use update_topic_schedule to change existing ones by ID.",
            "Use toggle_topic_schedule to quickly enable/disable without touching other fields.",
            "Use delete_topic_schedule only after confirming with the user.",
            "ASSUME AND PROCEED: resolve bot/category/topic from names without asking.",
            "FORMAT: table with columns — ID | Topic | Type | Timing | Enabled | Prompt | Targets.",
            "After changes: '✅ Schedule #[id] on [bot/topic] → [what changed]'.",
        ],
    )

    prompt_agent = Agent(
        name="PromptAgent",
        role="Prompt manager — reads and modifies the text templates used for summary generation",
        model=model,
        tools=[PromptControlToolkit(action_log)],
        instructions=[
            "You manage prompts: text templates used by Gemini when generating summaries.",
            "Always call get_all_prompts first to see what prompts exist.",
            "Use set_prompt to create or update a prompt (it upserts — safe to call for new or existing keys).",
            "Use delete_prompt only after confirming with the user.",
            "When showing prompts, display the key name and a truncated preview (first 200 chars).",
            "When the user asks to 'see' or 'read' a prompt, show the full text.",
            "ASSUME AND PROCEED: resolve bot name from partial match without asking.",
            "After changes: '✅ Prompt \"[bot/key]\" → [created/updated/deleted]'.",
        ],
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
