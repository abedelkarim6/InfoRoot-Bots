# SummariesBot v4

Telegram userbot that monitors channels and posts scheduled AI-generated summaries via OpenAI or Gemini.

---

## Requirements

- Python 3.11+
- PostgreSQL database

---

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
pip install psycopg2-binary
```

### 2. Configure

Copy the example config and fill in your values:

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` and set:

| Field | Where to get it |
|---|---|
| `openai.api_key` | https://platform.openai.com/api-keys |
| `gemini.api_key` | https://ai.google.dev/ |
| `database.dsn` | Your PostgreSQL connection string |

Example DSN: `postgresql://postgres:password@localhost:5432/summariesbotdb`

### 3. Seed the database

Run once on fresh setup (or to re-sync keywords from config):

```bash
python seed.py
```

This creates the required tables (`topic_keywords`, `messages`, `summaries`) and loads all keywords from `config.yaml` into the database. Safe to re-run — it wipes and re-inserts keywords only, never touches messages or summaries.

### 4. Run

```bash
python -m uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 to manage bots, categories, keywords, prompts, and rules.
