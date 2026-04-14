# SummariesBot v2

A multi-user platform that monitors Telegram channels and YouTube, then delivers AI-generated summaries on configurable schedules.

## Documentation

| Doc | Contents |
|-----|----------|
| [Architecture](docs/architecture.md) | Two-process design, how they interact, startup flow |
| [Concurrency & Processing](docs/concurrency.md) | Parallel scheduling, thread model, connection pool |
| [Multi-User Isolation](docs/multi-user.md) | How users are separated, owner_id pattern, access control |
| [File Structure](docs/file-structure.md) | Annotated directory and file tree |

## Quick Start

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Configure
Edit `config.yaml` — set your DB DSN, Telegram API credentials, and AI API keys (OpenAI or Gemini).

### 3. Run
```bash
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

`app.py` starts the web server and automatically launches `main.py` (the Telegram userbot) as a subprocess on startup.

Open `http://localhost:8000` to manage bots, collections, schedules, and view the monitor dashboard.

### 4. Regenerate Telegram session (if auth breaks)
```bash
python get_ss.py
```
Paste the output `string_session` into `config.yaml`.
