# SummariesBotv2 — System Design Document

## Table of Contents
1. [Overview](#overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Module Breakdown](#module-breakdown)
4. [Database Layer](#database-layer)
5. [Telegram Summaries Pipeline](#telegram-summaries-pipeline)
6. [Scheduling System](#scheduling-system)
7. [YouTube Monitor Pipeline](#youtube-monitor-pipeline)
8. [AI / LLM Layer](#ai--llm-layer)
9. [Authentication & Multi-User Model](#authentication--multi-user-model)
10. [Frontend (SPA)](#frontend-spa)
11. [Background Jobs](#background-jobs)
12. [Data Flow Diagrams](#data-flow-diagrams)

---

## Overview

SummariesBotv2 is a Telegram userbot + web admin panel that:
- Monitors configured Telegram source channels
- Categorizes incoming messages by topic using keyword matching
- Periodically generates AI summaries and sends them to target Telegram channels
- Monitors YouTube channels/keywords for new videos and summarizes them
- Provides a multi-user admin interface for managing bots, collections, topics, schedules, prompts, and monitoring results

**Stack:** FastAPI (Python) · PostgreSQL · Telethon (Telegram MTProto) · APScheduler · Google Gemini / OpenAI · Vanilla JS SPA

---

## High-Level Architecture

```mermaid
graph TD
    subgraph Browser
        UI[Single-Page App\nstatic/index.html + modern.js]
    end

    subgraph FastAPI App [app.py — FastAPI]
        MW[TokenAuthMiddleware]
        ROUTERS[API Routers\n/api/*]
        STATIC[Static File Server\n/static/]
    end

    subgraph Bot Task [Asyncio Task — summaries/bot.py]
        TC[Telethon Client\nMTProto userbot]
        SCHED[APScheduler\nper-topic jobs]
        WATCHER[scheduler_watcher\npoll every 2s]
    end

    subgraph YouTube [Asyncio Scheduler — youtube_monitor/]
        YT_WORKER[Video Queue Worker\nevery 5 min]
        YT_KEYWORDS[Keyword Search\nevery 5 min]
        YT_WEBSUB[WebSub Push\nPubSubHubbub]
    end

    subgraph AI [LLM Clients]
        GEMINI[GeminiClient\nVertex AI]
        OAI[OpenAIClient]
    end

    DB[(PostgreSQL)]

    UI -->|JWT Bearer| MW
    MW --> ROUTERS
    ROUTERS --> DB
    Bot Task -->|get_db()| DB
    YouTube -->|get_yt_db()| DB
    SCHED -->|trigger_summary| AI
    YT_WORKER --> AI
    TC -->|NewMessage events| Bot Task
    WATCHER -->|get_config_version\nevery 2s| DB
    WATCHER -->|rebuild on change| SCHED
```

---

## Module Breakdown

```mermaid
graph LR
    APP[app.py] --> S_ROUTERS[summaries/routers/\n8 routers]
    APP --> SYS_ROUTERS[routers/\nauth · accounts · system · chatbot · youtube]
    APP --> HELPERS[utils/helpers.py\nstart/stop bot task\ncategorizer + cache]
    APP --> DB_INST[utils/database.py\nDatabase base class]

    S_ROUTERS --> SDB[summaries/db.py\nSummariesDB]
    SYS_ROUTERS --> SDB
    SDB --> DB_INST

    APP --> BOT[summaries/bot.py\nrun_bot coroutine]
    BOT --> PROMPTS_S[summaries/prompts.py\nget_summary_prompt]
    BOT --> HELPERS

    APP --> YT[youtube_monitor/\nworker · keyword_search · websub]
    YT --> YT_DB[youtube_monitor/db.py\nYouTubeDB]

    APP --> CHATBOT[chatbot/\nservice · prompts]
```

### Key Files

| File | Role |
|------|------|
| `app.py` | Entry point; mounts all routers; lifespan manages bot task + YouTube scheduler |
| `summaries/bot.py` | Telethon userbot; message handler; APScheduler setup; interim + scheduled summaries |
| `summaries/db.py` | `SummariesDB` — all summaries-specific DB queries |
| `summaries/prompts.py` | Prompt builder: fixed Arabic scope prefix + per-bot user template |
| `utils/database.py` | `Database` base class: pool, connection management, user/auth/plan methods |
| `utils/helpers.py` | `categorizer()` (TTL-cached + pre-compiled regex); `start_bot_task`/`stop_bot_task`; log buffer |
| `utils/gemini_client.py` | Gemini summarization client; returns `(text, tokens)` |
| `utils/openai_client.py` | OpenAI summarization client; returns `(text, tokens)` |
| `youtube_monitor/worker.py` | Picks pending YT videos; calls Gemini; sends via Telegram |
| `youtube_monitor/keyword_search.py` | Polls YouTube Data API for keyword matches |
| `routers/auth.py` | JWT login/validate; `is_admin_request` / `get_request_user_id` helpers |
| `static/js/modern.js` | All SPA UI logic (~7000 lines, vanilla JS) |

---

## Database Layer

```mermaid
classDiagram
    class Database {
        +dsn: str
        +pool: ThreadedConnectionPool
        +_get_cursor()
        +_commit()
        +create_admin_user()
        +get_user_by_id()
        +get_all_users()
        +validate_token()
        +get_ai_plans()
        +recycle_bin_purge()
        +get_system_enabled()
        +get_config_version()
        +_bump_config_version()
    }

    class SummariesDB {
        +add_message()
        +get_messages_for_schedule_window()
        +get_all_bots_config()
        +get_all_collections()
        +save_collection()
        +save_summary()
        +save_interim_summary()
        +mark_as_summarized()
        +log_schedule_run()
        +get_today_schedule_stats()
        +get_bot_prompts()
        +get_hourly_ai_stats()
        +get_userbot_dialogs()
        +save_userbot_dialogs()
    }

    Database <|-- SummariesDB
```

### Connection Pool Pattern

Every DB method follows this exact pattern — deviating causes pool exhaustion:

```python
def my_method(self, param):
    try:
        cursor = self._get_cursor()
        cursor.execute("...", (param,))
        return cursor.fetchall()
    finally:
        self._commit()   # always — returns connection to pool
```

`_commit()` is the only safe way to release a connection. Never use `db.connection.commit()`.

### Config Version

`config_version` is a counter in the DB incremented by every mutation (`_bump_config_version()`). The `scheduler_watcher` polls it every 2 seconds — any change triggers a full scheduler and channel-map rebuild, making new collections and topics take effect without a bot restart.

---

## Telegram Summaries Pipeline

```mermaid
flowchart TD
    TG[Telegram Channel\nPost] -->|MTProto push| HANDLER[read_channel_messages]

    HANDLER -->|chat_id lookup| MAP{_source_channel_map}
    MAP -->|not found| DROP[Drop message]
    MAP -->|found| RULES[Apply bot rules\nremove / replace]

    RULES --> CATEG[categorizer\nkeyword matching]
    CATEG -->|no topics| UNCLASSIFIED[Store unclassified]
    CATEG -->|topics matched| SAVE[db.add_message\nwith topics + keywords]

    SAVE --> INTERIM{≥25 unsummarized\nfor this topic?}
    INTERIM -->|yes| INTERIM_CALL[check_and_run_interim_summary\nasyncio task]
    INTERIM -->|no| WAIT[Wait for next message]

    INTERIM_CALL --> LLM1[LLM: summarize 25 msgs]
    LLM1 --> SAVE_INTERIM[db.save_interim_summary]

    SCHEDULER[APScheduler fires] --> GEN[generate_and_send_summary]
    GEN -->|fetch window msgs| DB_MSGS[db.get_messages_for_schedule_window]
    DB_MSGS --> BATCH{>25 messages?}
    BATCH -->|no| SINGLE[Single LLM call]
    BATCH -->|yes| CHUNKS[Chunk into 25s\n→ summarize each\n→ merge pass]
    SINGLE --> SEND
    CHUNKS --> SEND[client.send_message\nto target channels]
    SEND --> LOG[db.save_summary\ndb.mark_as_summarized\ndb.log_schedule_run]
```

### Categorizer

The categorizer runs on every incoming message. It uses a TTL cache (30s) and pre-compiled per-topic regex to stay fast:

```mermaid
flowchart LR
    MSG[Message text] --> CACHE{Cache fresh?\n<30s old}
    CACHE -->|no| FETCH[db.get_all_bots_config\ncompile regexes]
    CACHE -->|yes| HIT[Use cached patterns]
    FETCH --> HIT
    HIT --> LOOP[For each topic:\npattern.findall text]
    LOOP -->|match| FOUND[topics + keywords list]
    LOOP -->|catch_all flag| FOUND
    LOOP -->|no match| SKIP
```

### Message Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Unsummarized : add_message()
    Unsummarized --> InterimSummarized : mark_as_summarized('interim')
    Unsummarized --> ScheduleSummarized : mark_as_summarized(schedule_type)
    Unsummarized --> Missed : cleanup_message_backlog()
    InterimSummarized --> ScheduleSummarized : included in scheduled window
```

---

## Scheduling System

```mermaid
flowchart TD
    DB_CFG[DB: bots config] -->|scheduler_watcher\ndetects version change| REBUILD[schedule_summaries]
    REBUILD -->|for each enabled\nbot→category→topic→schedule| JOBS[APScheduler jobs]

    JOBS --> T1[CronTrigger\nminute: every N min]
    JOBS --> T2[CronTrigger\nhourly: each hour at :MM]
    JOBS --> T3[IntervalTrigger\ninterval_hourly: every N hours]
    JOBS --> T4[IntervalTrigger\ninterval_minutes: every N minutes]
    JOBS --> T5[CronTrigger\ndaily: at HH:MM]
    JOBS --> T6[IntervalTrigger 1min\nspeeches_interval]

    T1 & T2 & T3 & T4 & T5 --> TRIGGER_SUMMARY[trigger_summary\njob_data dict]
    T6 --> SPEECH[generate_speech_buckets\nwait_time countdown]

    TRIGGER_SUMMARY --> WINDOW[compute_window_start\nlook back to previous fire]
    WINDOW --> FETCH_MSGS[fetch messages in window]
```

### Schedule Types

| Type | Trigger | Config Fields |
|------|---------|---------------|
| `minute` | CronTrigger `*/N` | `minute` (interval N) |
| `hourly` | CronTrigger `:MM` | `minute` |
| `interval_hourly` | IntervalTrigger hours | `hours`, `start_hour`, `start_minute`, `end_hour`, `end_minute` |
| `interval_minutes` | IntervalTrigger mins | `minutes`, `start_hour`, `start_minute`, `end_hour`, `end_minute` |
| `daily` | CronTrigger HH:MM | `hour`, `minute` |
| `speeches_interval` | IntervalTrigger 1min | `wait_time` (minutes before sending) |

**Active window gate:** `interval_hourly` and `interval_minutes` schedules support `end_hour`/`end_minute`. Fires outside the window are silently skipped.

---

## YouTube Monitor Pipeline

```mermaid
flowchart TD
    subgraph Sources
        WEBSUB[YouTube WebSub\nPubSubHubbub push\n/youtube/websub/callback]
        KW_POLL[Keyword Poller\nevery 5 min via YouTube Data API]
    end

    WEBSUB -->|new video notification| QUEUE[yt_video_queue table\nstatus=pending]
    KW_POLL -->|matching videos| QUEUE

    QUEUE -->|process_pending_queue\nevery 5 min| WORKER[Video Worker]

    WORKER -->|fetch transcript| TRANSCRIPT{Transcript\navailable?}
    TRANSCRIPT -->|yes| GEMINI_T[Gemini: summarize transcript]
    TRANSCRIPT -->|no| GEMINI_V[Gemini: summarize video URL\ntiered fallback]

    GEMINI_T & GEMINI_V --> FORMAT[Format summary\nwith video metadata]
    FORMAT --> TG_SEND[_yt_telegram_send\nTelethon temp client]
    TG_SEND --> TARGET[Configured target\nTelegram channels]

    WORKER -->|done/failed| STATUS[Update queue status]
```

### WebSub Flow

YouTube's hub pushes a POST to `/youtube/websub/callback` when a subscribed channel publishes a video. The bot renews subscriptions every 9 days via APScheduler.

---

## AI / LLM Layer

```mermaid
flowchart LR
    BOT[bot.py] -->|generate_summary prompt| LLM{LLM client\nconfig.yaml}
    LLM -->|gemini key present| GEM[GeminiClient\nVertex AI]
    LLM -->|openai key| OAI[OpenAIClient]
    GEM & OAI --> RESULT["(summary_text, tokens_used)"]
    RESULT --> TOKENS[db.save_summary\ntokens_used column]
```

### Prompt Construction

```
[Fixed Arabic scope prefix]
  → injects {topic_name} and {messages}
  → scopes the LLM to relevant geographic/topic boundaries
---
User Prompt:
[Per-bot user-defined template from DB]
  → references {topic_name}
```

The system prompt is stored in `config.yaml` under `system_prompts.summaries_system` (overrides the hardcoded Arabic default). The fixed prefix and per-bot prompts are editable via the Prompts page.

### Chunked Summarization (>25 messages)

```mermaid
flowchart LR
    MSGS[N messages] -->|N ≤ 25| SINGLE[Single LLM call]
    MSGS -->|N > 25| SPLIT[Split into 25-msg chunks]
    SPLIT --> CHUNK_CALLS[LLM call per chunk\n3s delay between calls]
    CHUNK_CALLS --> MERGE[Merge pass:\nArabic merge prompt]
    MERGE --> FINAL[Final summary]
```

### Retry Logic

Network errors (`OSError`, `ConnectionError`, `TimeoutError`) are retried up to 3 times with exponential backoff: 5s → 15s → 45s.

---

## Authentication & Multi-User Model

```mermaid
flowchart TD
    LOGIN[POST /api/auth/login] -->|username + password| HASH[bcrypt verify]
    HASH -->|ok| JWT[JWT token\n24h expiry]
    JWT --> CLIENT[Browser stores\nin localStorage]

    CLIENT -->|Authorization: Bearer token| MW[TokenAuthMiddleware]
    MW -->|validate_token| ALLOW[Proceed to router]
    MW -->|invalid| 401[401 Unauthorized]
```

### Data Isolation

All major tables have an `owner_id` column:

| `owner_id` | Meaning |
|-----------|---------|
| `NULL` | Admin-owned (visible only to admin) |
| `<user_id>` | User-owned (visible only to that user) |

Every DB read/write method accepts `owner_id`. Admin passes `None` to see all data. Regular users pass their `user_id`.

Router pattern:
```python
if is_admin_request(request):
    owner_id = None          # admin sees everything
else:
    owner_id = get_request_user_id(request)
```

---

## Frontend (SPA)

```mermaid
flowchart TD
    LOAD[Page load\nindex.html] --> AUTH_CHECK[auth.js\ncheck JWT]
    AUTH_CHECK -->|no token| LOGIN[/login redirect]
    AUTH_CHECK -->|valid| INIT[modern.js\nloadAllData]

    INIT --> CFG[GET /api/config\nglobal bots + collections]
    INIT --> PRPTS[GET /api/prompts\nper-bot prompts]

    CFG & PRPTS --> NAV[Render nav\nSystem · Collections · Bots\nMonitor · Dashboard · etc.]

    NAV --> PAGE{Active page}
    PAGE --> BOTS[Bots page\nlazy-rendered categories + topics]
    PAGE --> MONITOR[Monitor page\nSchedules · Summaries · Messages\nUnclassified · Missed · History]
    PAGE --> DASH[Dashboard\ncharts + filters]
    PAGE --> YT_PAGE[YouTube page]
    PAGE --> CHATBOT_PAGE[Chatbot page]
```

### Key JS Patterns

| Pattern | Description |
|---------|-------------|
| `api(path, body?)` | GET if no body, POST if body; always checks `result.status === 'ok'` |
| `showConfirm / showAlert` | Custom dialogs — never use `window.confirm` |
| `escapeHtml / escapeHtmlSys` | XSS protection for table content vs HTML attributes |
| `_fmtLBN(iso)` | Formats any timestamp to Lebanon time (Asia/Beirut) |
| `_monTagsHtml(str, cls)` | Builds comma-separated `<span class="mon-tag">` chips |
| `renderBotsPage([topicId, catId])` | Re-renders bots page keeping accordions open |
| `loadAllData()` | Parallel fetch of config + prompts via `Promise.all` |
| Lazy body rendering | Category/topic boxes render header immediately; body on first open |
| `debounce(fn, 220ms)` | Wraps filter input handlers to avoid per-keystroke re-renders |

---

## Background Jobs

All background jobs are registered in `app.py`'s lifespan using a single `AsyncIOScheduler`:

| Job ID | Schedule | Purpose |
|--------|----------|---------|
| `yt_process_queue` | Every 5 min | Process pending YouTube video queue |
| `yt_keyword_search` | Every 5 min | Run due YouTube keyword searches |
| `yt_websub_renew` | Every 9 days | Renew YouTube WebSub subscriptions |
| `yt_cleanup` | Weekly | Purge old YouTube queue entries |
| `recycle_bin_purge` | Every 12h | Permanently delete recycle bin items >5 days old |
| `chatbot_suggestions` | Every 1h | Refresh AI chatbot suggestion cache |

The Telegram bot's own topic schedules live in a **separate** `AsyncIOScheduler` inside `bot.py`, rebuilt on every config version change.

---

## Data Flow Diagrams

### Full Message → Summary Flow

```mermaid
sequenceDiagram
    participant TG as Telegram Channel
    participant BOT as bot.py (Telethon)
    participant DB as PostgreSQL
    participant LLM as Gemini/OpenAI
    participant TARGET as Target Channel

    TG->>BOT: NewMessage event
    BOT->>BOT: Lookup chat_id in _source_channel_map
    BOT->>BOT: Apply remove/replace rules
    BOT->>BOT: categorizer() → topics + keywords
    BOT->>DB: add_message(text, topics, keywords, bot_name)
    BOT->>BOT: check_and_run_interim_summary (async task)

    Note over BOT,DB: Every 25 messages per topic
    BOT->>DB: get_messages_for_interim(limit=25)
    BOT->>LLM: generate_summary(25 texts)
    LLM-->>BOT: (summary_text, tokens)
    BOT->>DB: save_interim_summary
    BOT->>DB: mark_as_summarized('interim')

    Note over BOT,TARGET: On scheduled fire (e.g. hourly)
    BOT->>DB: get_messages_for_schedule_window(window_start)
    BOT->>LLM: generate_summary (chunked if >25)
    LLM-->>BOT: (final_summary, tokens)
    BOT->>TARGET: send_message(header + summary)
    BOT->>DB: save_summary(tokens_used)
    BOT->>DB: mark_as_summarized(schedule_type)
    BOT->>DB: log_schedule_run(status=success)
```

### Config Change → Scheduler Rebuild

```mermaid
sequenceDiagram
    participant UI as Browser
    participant API as FastAPI Router
    participant DB as PostgreSQL
    participant WATCHER as scheduler_watcher
    participant SCHED as APScheduler
    participant MAP as _source_channel_map

    UI->>API: POST /api/collection/save
    API->>DB: save_collection()
    DB->>DB: _bump_config_version()
    API-->>UI: {status: ok}

    Note over WATCHER: polls every 2s
    WATCHER->>DB: get_config_version()
    DB-->>WATCHER: new version
    WATCHER->>SCHED: schedule_summaries() — rebuild all jobs
    WATCHER->>MAP: build_source_channel_map() — re-resolve + auto-join channels
    WATCHER->>DB: cleanup_message_backlog()
```

### Bot Lifecycle

```mermaid
sequenceDiagram
    participant APP as app.py lifespan
    participant SUPER as bot_supervisor task
    participant BOT as run_bot()
    participant TG as Telegram MTProto

    APP->>SUPER: start_bot_task(app.state)
    SUPER->>BOT: await run_bot()
    BOT->>TG: connect()
    BOT->>TG: is_user_authorized() (30s timeout)
    TG-->>BOT: authorized
    BOT->>BOT: build_source_channel_map()
    BOT->>BOT: cleanup_message_backlog()
    BOT->>BOT: start scheduler_watcher task
    BOT->>TG: run_until_disconnected()

    Note over SUPER,BOT: On crash (not CancelledError)
    BOT-->>SUPER: Exception raised
    SUPER->>SUPER: sleep 5s
    SUPER->>BOT: await run_bot() (restart)

    Note over APP,SUPER: On shutdown
    APP->>SUPER: task.cancel()
    SUPER->>BOT: CancelledError propagates
    BOT->>TG: disconnect()
    BOT->>BOT: SCHEDULER.shutdown()
```
