"""
Database operations for storing messages and tracking summaries.
Uses PostgreSQL via psycopg2.
"""

import json
import logging
import re
import threading
from contextlib import contextmanager
from typing import List

import psycopg2
import psycopg2.extras
import psycopg2.pool

logger = logging.getLogger(__name__)


def _parse_jsonb_list(val):
    """Safely parse a JSONB value that should be a list.
    Handles: None, list, or double-encoded JSON string."""
    if not val:
        return []
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass
        return [val]  # treat bare string as single-element list
    return []


class Database:
    def __init__(self, dsn: str):
        """
        dsn: PostgreSQL connection string, e.g.:
             "postgresql://user:password@localhost:5432/botdb"
        Pool sizes can be tuned via env vars without code changes:
        DB_MIN_CONNECTIONS (default 2), DB_MAX_CONNECTIONS (default 50).
        """
        import os
        self.dsn = dsn
        try:
            min_conn = max(1, int(os.environ.get("DB_MIN_CONNECTIONS", "2")))
        except ValueError:
            min_conn = 2
        try:
            max_conn = max(min_conn, int(os.environ.get("DB_MAX_CONNECTIONS", "50")))
        except ValueError:
            max_conn = 50
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=min_conn, maxconn=max_conn, dsn=dsn,
        )
        self._local = threading.local()
        self._create_tables()

    def _connect(self):
        """Fallback: only used if pool is unavailable."""
        conn = psycopg2.connect(self.dsn)
        conn.autocommit = False
        self._local.connection = conn

    @property
    def connection(self):
        return getattr(self._local, 'connection', None)

    @connection.setter
    def connection(self, value):
        self._local.connection = value
        if value is None:
            self._local.depth = 0

    def _get_cursor(self):
        # If this thread already holds a connection (nested call), reuse it.
        depth = getattr(self._local, 'depth', 0)
        if depth > 0 and getattr(self._local, 'connection', None) is not None:
            self._local.depth = depth + 1
            return self._local.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Outer call — get a fresh connection from the pool, discarding stale ones.
        for attempt in range(3):
            conn = self.pool.getconn()
            if conn.closed:
                try:
                    self.pool.putconn(conn, close=True)
                except Exception:
                    pass
                continue
            try:
                conn.poll()
            except psycopg2.OperationalError:
                try:
                    self.pool.putconn(conn, close=True)
                except Exception:
                    pass
                continue
            conn.autocommit = False
            self._local.connection = conn
            self._local.depth = 1
            return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # All health-check attempts exhausted — get one last time and let it fail naturally
        conn = self.pool.getconn()
        conn.autocommit = False
        self._local.connection = conn
        self._local.depth = 1
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def _commit(self):
        """Commit and release — but only when the outermost caller finishes (depth → 0)."""
        depth = getattr(self._local, 'depth', 0)
        if depth > 1:
            # Still inside a nested call chain — just decrement and leave connection open.
            self._local.depth = depth - 1
            return
        # Outermost caller: actually commit and return the connection to the pool.
        conn = getattr(self._local, 'connection', None)
        self._local.depth = 0
        self._local.connection = None
        if conn is not None:
            try:
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                try:
                    self.pool.putconn(conn)
                except Exception:
                    pass

    def _create_tables(self):
        try:
            cursor = self._get_cursor()

            # Keywords table: keywords per bot/category/topic
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS topic_keywords (
                    id SERIAL PRIMARY KEY,
                    bot_name TEXT NOT NULL,
                    category_name TEXT NOT NULL,
                    topic_name TEXT NOT NULL,
                    keyword TEXT NOT NULL,
                    UNIQUE(bot_name, category_name, topic_name, keyword)
                )
            """)

            # Main messages table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    channel_id BIGINT NOT NULL,
                    text TEXT NOT NULL,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    summarized_minute BOOLEAN DEFAULT FALSE,
                    summarized_hourly BOOLEAN DEFAULT FALSE,
                    summarized_daily BOOLEAN DEFAULT FALSE,
                    countries TEXT,
                    regions TEXT,
                    topics TEXT,
                    categories TEXT,
                    keywords_found TEXT,
                    bot_name TEXT,
                    original_text TEXT,
                    replaced_text TEXT
                )
            """)

            # Userbot dialog cache — populated by main.py at startup for the channel validator UI
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS userbot_dialogs (
                    id BIGINT PRIMARY KEY,
                    title TEXT,
                    username TEXT,
                    is_broadcast BOOLEAN DEFAULT FALSE,
                    is_megagroup BOOLEAN DEFAULT FALSE,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                ALTER TABLE userbot_dialogs
                ADD COLUMN IF NOT EXISTS can_post BOOLEAN DEFAULT FALSE
            """)

            # Tracking generated summaries
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS summaries (
                    id SERIAL PRIMARY KEY,
                    summary_text TEXT NOT NULL,
                    message_count INTEGER NOT NULL,
                    summary_type TEXT NOT NULL,
                    target_entity TEXT NOT NULL,
                    bot_name TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Per-topic summarization tracking (replaces the old boolean flags)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS message_summarizations (
                    message_id INTEGER NOT NULL,
                    bot_name TEXT NOT NULL,
                    topic_name TEXT NOT NULL,
                    schedule_type TEXT NOT NULL,
                    summarized_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    status TEXT DEFAULT 'summarized',
                    PRIMARY KEY (message_id, bot_name, topic_name, schedule_type)
                )
            """)

            # Interim (rolling 25-message batch) summaries — fed into the final schedule summary
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS topic_interim_summaries (
                    id SERIAL PRIMARY KEY,
                    bot_name TEXT NOT NULL,
                    topic_name TEXT NOT NULL,
                    summary_text TEXT NOT NULL,
                    message_count INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    sent_at TIMESTAMP
                )
            """)
            # Migrate: add status column if missing
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'message_summarizations'")
            ms_cols = [r['column_name'] for r in cursor.fetchall()]
            if ms_cols and 'status' not in ms_cols:
                cursor.execute("ALTER TABLE message_summarizations ADD COLUMN status TEXT DEFAULT 'summarized'")

            # Safe column migrations using information_schema
            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'messages'
            """)
            cols = [r['column_name'] for r in cursor.fetchall()]

            if 'bot_name' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN bot_name TEXT')
            if 'original_text' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN original_text TEXT')
            if 'replaced_text' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN replaced_text TEXT')
            if 'summarized_minute' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN summarized_minute BOOLEAN DEFAULT FALSE')
            if 'topics' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN topics TEXT')
            if 'categories' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN categories TEXT')
            if 'channel_username' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN channel_username TEXT')
            if 'collection_name' not in cols:
                cursor.execute('ALTER TABLE messages ADD COLUMN collection_name TEXT')

            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'summaries'
            """)
            cols2 = [r['column_name'] for r in cursor.fetchall()]
            if 'bot_name' not in cols2:
                cursor.execute('ALTER TABLE summaries ADD COLUMN bot_name TEXT')
            if 'topic_name' not in cols2:
                cursor.execute('ALTER TABLE summaries ADD COLUMN topic_name TEXT')
            if 'message_ids' not in cols2:
                cursor.execute('ALTER TABLE summaries ADD COLUMN message_ids TEXT')
            if 'tokens_used' not in cols2:
                cursor.execute('ALTER TABLE summaries ADD COLUMN tokens_used INTEGER DEFAULT 0')
            # `thoughts`: when Gemini's "Extended Thinking" toggle is on, we
            # capture the model's reasoning trace (parts where part.thought
            # is True) and store it here for inspection on the AI Usage page.
            if 'thoughts' not in cols2:
                cursor.execute('ALTER TABLE summaries ADD COLUMN thoughts TEXT')

            # ==================== Config tables (replaces config.yaml) ====================

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS system_settings (
                    key TEXT PRIMARY KEY,
                    value JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS collections (
                    id SERIAL PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL,
                    display_name TEXT,
                    source_channels JSONB DEFAULT '[]',
                    target_channels JSONB DEFAULT '[]',
                    enabled BOOLEAN DEFAULT TRUE
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bots (
                    id SERIAL PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    minimum_messages INTEGER DEFAULT 5,
                    collection_names JSONB DEFAULT '[]',
                    rules JSONB DEFAULT '{"remove":[],"replace":[]}',
                    default_schedules JSONB DEFAULT '[]'
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS categories (
                    id SERIAL PRIMARY KEY,
                    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    UNIQUE(bot_id, name)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS topics (
                    id SERIAL PRIMARY KEY,
                    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    linked_topics JSONB DEFAULT '[]',
                    UNIQUE(category_id, name)
                )
            """)
            # Migrate topics table — add columns introduced after initial creation
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'topics'")
            topic_cols = [r['column_name'] for r in cursor.fetchall()]
            if 'catch_all' not in topic_cols:
                cursor.execute("ALTER TABLE topics ADD COLUMN catch_all BOOLEAN DEFAULT FALSE")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS schedules (
                    id SERIAL PRIMARY KEY,
                    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    prompt_key TEXT,
                    header TEXT,
                    header_datetime BOOLEAN DEFAULT FALSE,
                    header_date_arabic BOOLEAN DEFAULT FALSE,
                    header_time_arabic BOOLEAN DEFAULT FALSE,
                    minute INTEGER,
                    hour INTEGER,
                    hours INTEGER,
                    minutes INTEGER,
                    start_hour INTEGER,
                    start_minute INTEGER,
                    telegram_targets JSONB DEFAULT '[]'
                )
            """)

            # Migrate: add new columns to schedules if missing
            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'schedules'
            """)
            sch_cols = [r['column_name'] for r in cursor.fetchall()]
            if sch_cols:  # table exists
                if 'header_date_arabic' not in sch_cols:
                    cursor.execute('ALTER TABLE schedules ADD COLUMN header_date_arabic BOOLEAN DEFAULT FALSE')
                if 'header_time_arabic' not in sch_cols:
                    cursor.execute('ALTER TABLE schedules ADD COLUMN header_time_arabic BOOLEAN DEFAULT FALSE')
                if 'telegram_targets' not in sch_cols:
                    cursor.execute("ALTER TABLE schedules ADD COLUMN telegram_targets JSONB DEFAULT '[]'")
                if 'wait_time' not in sch_cols:
                    cursor.execute('ALTER TABLE schedules ADD COLUMN wait_time INTEGER')
                if 'end_hour' not in sch_cols:
                    cursor.execute('ALTER TABLE schedules ADD COLUMN end_hour INTEGER')
                if 'end_minute' not in sch_cols:
                    cursor.execute('ALTER TABLE schedules ADD COLUMN end_minute INTEGER')

            # Migrate: add default_schedules to bots if missing
            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'bots'
            """)
            bot_cols = [r['column_name'] for r in cursor.fetchall()]
            if bot_cols and 'default_schedules' not in bot_cols:
                cursor.execute("ALTER TABLE bots ADD COLUMN default_schedules JSONB DEFAULT '[]'")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS prompts (
                    id SERIAL PRIMARY KEY,
                    bot_name TEXT NOT NULL,
                    key TEXT NOT NULL,
                    text TEXT NOT NULL DEFAULT '',
                    UNIQUE(bot_name, key)
                )
            """)

            # Auto-migrate prompts from prompts.yaml if table is empty
            cursor.execute("SELECT COUNT(*) AS cnt FROM prompts")
            if cursor.fetchone()['cnt'] == 0:
                try:
                    import yaml
                    with open("prompts.yaml", "r", encoding="utf-8") as f:
                        prompts_cfg = yaml.safe_load(f) or {}
                    # Build case-insensitive map from YAML bot names to actual DB bot names
                    cursor.execute("SELECT name FROM bots")
                    db_bots = {r['name'].lower(): r['name'] for r in cursor.fetchall()}
                    for yaml_bot_name, bot_prompts in prompts_cfg.get("bots", {}).items():
                        # Match to actual DB bot name (case-insensitive), fallback to yaml name
                        actual_name = db_bots.get(yaml_bot_name.lower(), yaml_bot_name)
                        for key, val in bot_prompts.items():
                            text = val.get("text", "") if isinstance(val, dict) else (val or "")
                            cursor.execute("""
                                INSERT INTO prompts (bot_name, key, text) VALUES (%s, %s, %s)
                                ON CONFLICT (bot_name, key) DO NOTHING
                            """, (actual_name, key, text))
                    logger.info("[DB] Auto-migrated prompts from prompts.yaml")
                except FileNotFoundError:
                    pass
                except Exception as e:
                    logger.warning(f"[DB] Could not auto-migrate prompts: {e}")

            # AI usage plans — must exist before users (FK dependency)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS ai_plans (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT DEFAULT '',
                    monthly_limit INTEGER NOT NULL DEFAULT 100,
                    is_default BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """)
            # Seed 3 default plans on first run
            cursor.execute("SELECT COUNT(*) as cnt FROM ai_plans WHERE is_default = TRUE")
            if cursor.fetchone()['cnt'] == 0:
                cursor.execute("""
                    INSERT INTO ai_plans (name, description, monthly_limit, is_default) VALUES
                    ('Basic',    '30 AI requests per month',   30,  TRUE),
                    ('Standard', '150 AI requests per month',  150, TRUE),
                    ('Pro',      '500 AI requests per month',  500, TRUE)
                    ON CONFLICT (name) DO NOTHING
                """)

            # Registered users (multi-user support) — must exist before recycle_bin (FK dependency)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    telegram_phone TEXT,
                    telegram_session TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Migrate users table — add columns introduced after initial creation
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")
            user_cols = [r['column_name'] for r in cursor.fetchall()]
            if 'role' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
            if 'is_active' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE")
            if 'youtube_on' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN youtube_on BOOLEAN DEFAULT FALSE")
            if 'agents_on' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN agents_on BOOLEAN DEFAULT FALSE")
            if 'bots_on' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN bots_on BOOLEAN DEFAULT FALSE")
            if 'agents_limit' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN agents_limit JSONB DEFAULT NULL")
            if 'yt_chat_on' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN yt_chat_on BOOLEAN DEFAULT FALSE")
            if 'sys_bot_on' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN sys_bot_on BOOLEAN DEFAULT FALSE")
            # Vertex AI per-user GCP project IDs (one per feature for billing isolation)
            if 'gemini_project_bots' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN gemini_project_bots TEXT DEFAULT NULL")
                if 'gemini_api_key_1' in user_cols:
                    cursor.execute("UPDATE users SET gemini_project_bots = gemini_api_key_1 WHERE gemini_api_key_1 IS NOT NULL")
            if 'gemini_project_youtube' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN gemini_project_youtube TEXT DEFAULT NULL")
                if 'gemini_api_key_2' in user_cols:
                    cursor.execute("UPDATE users SET gemini_project_youtube = gemini_api_key_2 WHERE gemini_api_key_2 IS NOT NULL")
            if 'gemini_project_agents' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN gemini_project_agents TEXT DEFAULT NULL")
                if 'gemini_api_key_3' in user_cols:
                    cursor.execute("UPDATE users SET gemini_project_agents = gemini_api_key_3 WHERE gemini_api_key_3 IS NOT NULL")
            if 'ai_plan_id' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN ai_plan_id INTEGER REFERENCES ai_plans(id) ON DELETE SET NULL DEFAULT NULL")
            if 'seo_visible' not in user_cols:
                cursor.execute("ALTER TABLE users ADD COLUMN seo_visible BOOLEAN DEFAULT TRUE")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS recycle_bin (
                    id SERIAL PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_name TEXT NOT NULL,
                    entity_data JSONB NOT NULL DEFAULT '{}',
                    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    deleted_at TIMESTAMP DEFAULT NOW()
                )
            """)

            # Migrate bots.owner_id — must run after users table exists
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'bots'")
            bot_cols2 = [r['column_name'] for r in cursor.fetchall()]
            if bot_cols2 and 'owner_id' not in bot_cols2:
                cursor.execute("ALTER TABLE bots ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL")

            # Migrate bots name uniqueness: replace global UNIQUE(name) with
            # two partial unique indexes so different users can share bot names.
            cursor.execute("""
                SELECT indexname FROM pg_indexes
                WHERE tablename = 'bots' AND indexname = 'bots_name_admin_idx'
            """)
            if not cursor.fetchone():
                # Drop the old global unique constraint (may be named differently)
                cursor.execute("""
                    SELECT conname FROM pg_constraint
                    WHERE conrelid = 'bots'::regclass AND contype = 'u'
                      AND conname LIKE '%name%'
                """)
                old_constraint = cursor.fetchone()
                if old_constraint:
                    cursor.execute(f"ALTER TABLE bots DROP CONSTRAINT IF EXISTS {old_constraint['conname']}")
                # Admin bots: name unique among rows where owner_id IS NULL
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS bots_name_admin_idx
                    ON bots(name) WHERE owner_id IS NULL
                """)
                # User bots: name unique per (name, owner_id) pair
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS bots_name_user_idx
                    ON bots(name, owner_id) WHERE owner_id IS NOT NULL
                """)

            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'recycle_bin'")
            rb_cols = [r['column_name'] for r in cursor.fetchall()]
            if rb_cols and 'owner_id' not in rb_cols:
                cursor.execute("ALTER TABLE recycle_bin ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL")

            # Migrate user_bot_topic_settings — add seo_visible column if missing
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'user_bot_topic_settings'")
            ubts_cols = [r['column_name'] for r in cursor.fetchall()]
            if ubts_cols and 'seo_visible' not in ubts_cols:
                cursor.execute("ALTER TABLE user_bot_topic_settings ADD COLUMN seo_visible BOOLEAN DEFAULT TRUE")

            # Migrate topic_keywords — add owner_id for per-user isolation
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'topic_keywords'")
            tk_cols = [r['column_name'] for r in cursor.fetchall()]
            if tk_cols and 'owner_id' not in tk_cols:
                cursor.execute("ALTER TABLE topic_keywords ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT NULL")
                # Replace the old global unique constraint with two partial indexes
                cursor.execute("""
                    SELECT conname FROM pg_constraint
                    WHERE conrelid = 'topic_keywords'::regclass AND contype = 'u'
                """)
                old_kw_constraint = cursor.fetchone()
                if old_kw_constraint:
                    cursor.execute(f"ALTER TABLE topic_keywords DROP CONSTRAINT IF EXISTS {old_kw_constraint['conname']}")
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS topic_keywords_admin_idx
                    ON topic_keywords(bot_name, category_name, topic_name, keyword)
                    WHERE owner_id IS NULL
                """)
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS topic_keywords_user_idx
                    ON topic_keywords(bot_name, category_name, topic_name, keyword, owner_id)
                    WHERE owner_id IS NOT NULL
                """)

            # Migrate prompts — add owner_id for per-user isolation
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'prompts'")
            pr_cols = [r['column_name'] for r in cursor.fetchall()]
            if pr_cols and 'owner_id' not in pr_cols:
                cursor.execute("ALTER TABLE prompts ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE DEFAULT NULL")
                cursor.execute("""
                    SELECT conname FROM pg_constraint
                    WHERE conrelid = 'prompts'::regclass AND contype = 'u'
                """)
                old_pr_constraint = cursor.fetchone()
                if old_pr_constraint:
                    cursor.execute(f"ALTER TABLE prompts DROP CONSTRAINT IF EXISTS {old_pr_constraint['conname']}")
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS prompts_admin_idx
                    ON prompts(bot_name, key) WHERE owner_id IS NULL
                """)
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS prompts_user_idx
                    ON prompts(bot_name, key, owner_id) WHERE owner_id IS NOT NULL
                """)

            # Migrate prompts to GLOBAL (no per-bot scoping). Adds:
            #   - type     (summaries | youtube)
            #   - name     (display name, defaults to key)
            # Renames each existing summaries key to "<bot_name>/<key>" so per-bot
            # texts are preserved, and rewires schedules.prompt_key to the new keys.
            # Also seeds a single 'default' youtube prompt from config.yaml.
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'prompts'")
            pr_cols2 = [r['column_name'] for r in cursor.fetchall()]
            if pr_cols2 and 'type' not in pr_cols2:
                cursor.execute("ALTER TABLE prompts ADD COLUMN type TEXT NOT NULL DEFAULT 'summaries'")
                cursor.execute("ALTER TABLE prompts ADD COLUMN name TEXT")
                cursor.execute("UPDATE prompts SET name = key WHERE name IS NULL")
                # bot_name was NOT NULL in the original schema — global prompts
                # (type='youtube' and renamed summaries entries) use NULL bot_name.
                cursor.execute("ALTER TABLE prompts ALTER COLUMN bot_name DROP NOT NULL")

                # Rewire schedules.prompt_key BEFORE renaming prompts so the join
                # against the un-prefixed key still matches. Uses the schedule's
                # owning bot to build the new "bot/key" form.
                cursor.execute("""
                    UPDATE schedules sch
                    SET prompt_key = b.name || '/' || sch.prompt_key
                    FROM topics t
                    JOIN categories c ON c.id = t.category_id
                    JOIN bots b      ON b.id = c.bot_id
                    WHERE sch.topic_id = t.id
                      AND sch.prompt_key IS NOT NULL AND sch.prompt_key <> ''
                      AND POSITION('/' IN sch.prompt_key) = 0
                """)

                # Rename existing summaries prompt keys to "<bot_name>/<key>".
                # Handles collisions (same bot_name/key already prefixed from a
                # prior partial run) via NOT EXISTS guard.
                cursor.execute("""
                    UPDATE prompts p
                    SET key = p.bot_name || '/' || p.key
                    WHERE p.type = 'summaries'
                      AND p.bot_name IS NOT NULL AND p.bot_name <> ''
                      AND POSITION('/' IN p.key) = 0
                      AND NOT EXISTS (
                        SELECT 1 FROM prompts p2
                        WHERE p2.id <> p.id
                          AND p2.type = 'summaries'
                          AND p2.key = p.bot_name || '/' || p.key
                          AND (p2.owner_id IS NOT DISTINCT FROM p.owner_id)
                      )
                """)
                # Refresh display name to match the new key (so the UI shows the
                # prefixed name as the prompt's title by default).
                cursor.execute("UPDATE prompts SET name = key WHERE type = 'summaries'")

                # Drop old (bot_name, key) indexes — replaced by (type, key).
                cursor.execute("DROP INDEX IF EXISTS prompts_admin_idx")
                cursor.execute("DROP INDEX IF EXISTS prompts_user_idx")
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS prompts_global_admin_idx
                    ON prompts(type, key) WHERE owner_id IS NULL
                """)
                cursor.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS prompts_global_user_idx
                    ON prompts(type, key, owner_id) WHERE owner_id IS NOT NULL
                """)

                # Seed a 'default' YouTube prompt from config.yaml if present.
                # Wrapped in a SAVEPOINT so any failure here can't abort the
                # surrounding migration transaction.
                try:
                    import yaml
                    with open("config.yaml", "r", encoding="utf-8") as f:
                        _cfg = yaml.safe_load(f) or {}
                    yt_prompt = (_cfg.get("youtube", {}) or {}).get("prompt", "") or ""
                    if yt_prompt.strip():
                        cursor.execute("SAVEPOINT yt_seed")
                        try:
                            cursor.execute("""
                                INSERT INTO prompts (bot_name, key, name, text, type, owner_id)
                                VALUES (NULL, 'default', 'default', %s, 'youtube', NULL)
                                ON CONFLICT DO NOTHING
                            """, (yt_prompt,))
                            cursor.execute("RELEASE SAVEPOINT yt_seed")
                            logger.info("[DB] Seeded default YouTube prompt from config.yaml")
                        except Exception as e:
                            cursor.execute("ROLLBACK TO SAVEPOINT yt_seed")
                            logger.warning(f"[DB] Could not seed YT default prompt: {e}")
                except FileNotFoundError:
                    pass
                except Exception as e:
                    logger.warning(f"[DB] Could not seed YT default prompt: {e}")

                logger.info("[DB] Migrated prompts to global schema (type + name columns)")

            # Idempotent cleanup: remove summaries prompts whose bot_name points
            # to a bot that no longer exists for the same owner. Runs every
            # startup — cheap, only deletes orphans.
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'prompts'")
            _cols_now = {r['column_name'] for r in cursor.fetchall()}
            if {'type', 'bot_name'}.issubset(_cols_now):
                cursor.execute("""
                    DELETE FROM prompts p
                    WHERE p.type = 'summaries'
                      AND p.bot_name IS NOT NULL
                      AND p.bot_name <> ''
                      AND NOT EXISTS (
                          SELECT 1 FROM bots b
                          WHERE b.name = p.bot_name
                            AND b.owner_id IS NOT DISTINCT FROM p.owner_id
                      )
                """)
                _orphans = cursor.rowcount
                if _orphans > 0:
                    logger.info(f"[DB] Cleaned up {_orphans} orphan prompt(s) from deleted bots")

            # Global default schedules (shared across all bots, owner-scoped).
            # Replaces per-bot `bots.default_schedules` JSONB lists.
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS default_schedules_global (
                    id                       SERIAL PRIMARY KEY,
                    owner_id                 INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name                     TEXT NOT NULL,
                    type                     TEXT NOT NULL DEFAULT 'hourly',
                    prompt_key               TEXT,
                    header                   TEXT,
                    header_datetime          BOOLEAN DEFAULT FALSE,
                    header_date_arabic       BOOLEAN DEFAULT FALSE,
                    header_time_arabic       BOOLEAN DEFAULT FALSE,
                    header_datetime_offset   INTEGER DEFAULT 0,
                    minute                   INTEGER,
                    hour                     INTEGER,
                    hours                    INTEGER,
                    minutes                  INTEGER,
                    start_hour               INTEGER,
                    start_minute             INTEGER,
                    end_hour                 INTEGER,
                    end_minute               INTEGER,
                    telegram_targets         JSONB DEFAULT '[]',
                    wait_time                INTEGER,
                    bullet_points            BOOLEAN DEFAULT FALSE,
                    bullet_points_count      INTEGER DEFAULT 0,
                    created_at               TIMESTAMP DEFAULT NOW()
                )
            """)
            cursor.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS ds_global_admin_idx
                ON default_schedules_global(name) WHERE owner_id IS NULL
            """)
            cursor.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS ds_global_user_idx
                ON default_schedules_global(name, owner_id) WHERE owner_id IS NOT NULL
            """)

            # One-time migration: pull each bot's default_schedules JSONB into
            # the global table, prefixing the name with the bot's name to avoid
            # collisions. Idempotent (skips rows that already exist).
            cursor.execute("""
                SELECT to_regclass('default_schedules_global') AS t
            """)
            if cursor.fetchone()['t']:
                cursor.execute("""
                    SELECT b.name, b.owner_id, b.default_schedules
                    FROM bots b
                    WHERE b.default_schedules IS NOT NULL
                      AND jsonb_array_length(b.default_schedules) > 0
                """)
                _migrated = 0
                for _row in cursor.fetchall():
                    _bn = _row['name']
                    _own = _row['owner_id']
                    for _sch in (_row['default_schedules'] or []):
                        if not isinstance(_sch, dict):
                            continue
                        _orig_name = _sch.get('name') or 'default'
                        _global_name = f"{_bn}/{_orig_name}"
                        cursor.execute("SAVEPOINT ds_seed")
                        try:
                            cursor.execute(
                                """
                                INSERT INTO default_schedules_global (
                                    owner_id, name, type, prompt_key, header,
                                    header_datetime, header_date_arabic, header_time_arabic,
                                    header_datetime_offset,
                                    minute, hour, hours, minutes,
                                    start_hour, start_minute, end_hour, end_minute,
                                    telegram_targets, wait_time,
                                    bullet_points, bullet_points_count
                                ) VALUES (
                                    %s, %s, %s, %s, %s,
                                    %s, %s, %s,
                                    %s,
                                    %s, %s, %s, %s,
                                    %s, %s, %s, %s,
                                    %s::jsonb, %s,
                                    %s, %s
                                )
                                ON CONFLICT DO NOTHING
                                """,
                                (
                                    _own, _global_name, _sch.get('type') or 'hourly',
                                    _sch.get('prompt_key'), _sch.get('header'),
                                    bool(_sch.get('header_datetime', False)),
                                    bool(_sch.get('header_date_arabic', False)),
                                    bool(_sch.get('header_time_arabic', False)),
                                    int(_sch.get('header_datetime_offset') or 0),
                                    _sch.get('minute'), _sch.get('hour'),
                                    _sch.get('hours'), _sch.get('minutes'),
                                    _sch.get('start_hour'), _sch.get('start_minute'),
                                    _sch.get('end_hour'), _sch.get('end_minute'),
                                    json.dumps(_sch.get('telegram_targets') or []),
                                    _sch.get('wait_time'),
                                    bool(_sch.get('bullet_points', False)),
                                    int(_sch.get('bullet_points_count') or 0),
                                ),
                            )
                            if cursor.rowcount:
                                _migrated += 1
                            cursor.execute("RELEASE SAVEPOINT ds_seed")
                        except Exception as e:
                            cursor.execute("ROLLBACK TO SAVEPOINT ds_seed")
                            logger.warning(f"[DB] Skipped default schedule '{_global_name}': {e}")
                if _migrated > 0:
                    logger.info(f"[DB] Migrated {_migrated} default schedule(s) to global table")

            # Per-user bot inheritance configuration
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_bot_inheritance (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
                    inherit_categories JSONB DEFAULT '[]',
                    inherit_topics    JSONB DEFAULT '[]',
                    inherit_keywords  BOOLEAN DEFAULT TRUE,
                    inherit_rules     BOOLEAN DEFAULT TRUE,
                    inherit_prompts   BOOLEAN DEFAULT TRUE,
                    inherit_messages_db BOOLEAN DEFAULT FALSE,
                    UNIQUE(user_id, bot_id)
                )
            """)

            # Per-topic settings for each bot inheritance (schedules, prompts, keyword %)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_bot_topic_settings (
                    id             SERIAL PRIMARY KEY,
                    inheritance_id INTEGER REFERENCES user_bot_inheritance(id) ON DELETE CASCADE,
                    topic_id       INTEGER REFERENCES topics(id) ON DELETE CASCADE,
                    include_schedules BOOLEAN DEFAULT TRUE,
                    include_prompts   BOOLEAN DEFAULT TRUE,
                    keyword_pct       INTEGER DEFAULT 100 CHECK (keyword_pct >= 0 AND keyword_pct <= 100),
                    UNIQUE(inheritance_id, topic_id)
                )
            """)

            # Per-user collection inheritance (tracks which global collections were granted)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_collection_inheritance (
                    id SERIAL PRIMARY KEY,
                    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    collection_name TEXT NOT NULL,
                    UNIQUE(user_id, collection_name)
                )
            """)

            # Per-user owned collections (independent copies, fully editable by user)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_collections (
                    id              SERIAL PRIMARY KEY,
                    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name            TEXT NOT NULL,
                    display_name    TEXT,
                    source_channels JSONB DEFAULT '[]',
                    target_channels JSONB DEFAULT '[]',
                    enabled         BOOLEAN DEFAULT TRUE,
                    UNIQUE(user_id, name)
                )
            """)

            # Per-user YouTube channel/tracker inheritance
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_yt_inheritance (
                    id SERIAL PRIMARY KEY,
                    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    source_type TEXT NOT NULL,
                    source_id   INTEGER NOT NULL,
                    source_name TEXT,
                    continuous  BOOLEAN DEFAULT FALSE,
                    status      TEXT DEFAULT 'pending',
                    pushed_at   TIMESTAMP DEFAULT NOW(),
                    responded_at TIMESTAMP,
                    UNIQUE(user_id, source_type, source_id)
                )
            """)

            # Per-user monthly AI request tracking
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS ai_usage (
                    id          SERIAL PRIMARY KEY,
                    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    year_month  TEXT NOT NULL,
                    request_count INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(user_id, year_month)
                )
            """)

            self._migrate_comma_keywords()

            # Schedule run history — one row per schedule fire (success or failed)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS schedule_runs (
                    id             SERIAL PRIMARY KEY,
                    bot_name       TEXT NOT NULL,
                    topic_name     TEXT NOT NULL,
                    schedule_type  TEXT,
                    status         TEXT NOT NULL,
                    message_count  INTEGER DEFAULT 0,
                    error_text     TEXT,
                    fired_at       TIMESTAMP DEFAULT NOW()
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS schedule_runs_fired_at_idx
                ON schedule_runs(fired_at DESC)
            """)
            # Add rate-limit-at-failure columns (idempotent; safe on existing DBs)
            cursor.execute("ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS rpm_at_failure INTEGER")
            cursor.execute("ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS tpm_at_failure INTEGER")
            cursor.execute("ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS rpd_at_failure INTEGER")

            # Migrate: rename schedule type 'interval' → 'interval_hourly' (one-time, idempotent)
            cursor.execute("UPDATE schedules SET type = 'interval_hourly' WHERE type = 'interval'")
            cursor.execute("UPDATE message_summarizations SET schedule_type = 'interval_hourly' WHERE schedule_type = 'interval'")
            cursor.execute("UPDATE schedule_runs SET schedule_type = 'interval_hourly' WHERE schedule_type = 'interval'")

            # Migrate: add interim_id to message_summarizations for per-interim message linkage
            cursor.execute("ALTER TABLE message_summarizations ADD COLUMN IF NOT EXISTS interim_id INTEGER")

            # Migrate: add header_datetime_offset to schedules (shift displayed time by N minutes)
            cursor.execute("ALTER TABLE schedules ADD COLUMN IF NOT EXISTS header_datetime_offset INTEGER DEFAULT 0")

            # Migrate: add bullet_points fields to schedules
            cursor.execute("ALTER TABLE schedules ADD COLUMN IF NOT EXISTS bullet_points BOOLEAN DEFAULT FALSE")
            cursor.execute("ALTER TABLE schedules ADD COLUMN IF NOT EXISTS bullet_points_count INTEGER DEFAULT 0")

            # Migrate: add schedule_name to topic_interim_summaries for display
            cursor.execute("ALTER TABLE topic_interim_summaries ADD COLUMN IF NOT EXISTS schedule_name TEXT")

            # Indexes for monitor-page hot queries. All tabs paginate by
            # `timestamp DESC` and filter by bot_name/collection_name/keywords_found.
            # Without these, every Messages/Unclassified/Schedules/History load
            # does a full table scan + sort on the messages and summaries tables.
            cursor.execute("CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp DESC)")
            cursor.execute("CREATE INDEX IF NOT EXISTS messages_bot_ts_idx ON messages (bot_name, timestamp DESC)")
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS messages_collection_ts_idx
                ON messages (collection_name, timestamp DESC)
                WHERE collection_name IS NOT NULL AND collection_name != ''
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS messages_unclassified_ts_idx
                ON messages (timestamp DESC)
                WHERE collection_name IS NOT NULL AND collection_name != ''
                  AND (keywords_found IS NULL OR keywords_found = '')
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS summaries_timestamp_idx ON summaries (timestamp DESC)")
            cursor.execute("CREATE INDEX IF NOT EXISTS summaries_bot_topic_ts_idx ON summaries (bot_name, topic_name, timestamp)")
            cursor.execute("CREATE INDEX IF NOT EXISTS ms_message_id_idx ON message_summarizations (message_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS ms_bot_topic_status_idx ON message_summarizations (bot_name, topic_name, status)")

        finally:
            self._commit()

    # ── User management ───────────────────────────────────────────────────────

    def create_user(self, username: str, password_hash: str) -> int:
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id",
                (username, password_hash)
            )
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def get_user_by_username(self, username: str):
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM users WHERE username = %s", (username,))
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            self._commit()

    def update_user_telegram(self, user_id: int, phone: str, session_string: str):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "UPDATE users SET telegram_phone = %s, telegram_session = %s WHERE id = %s",
                (phone, session_string, user_id)
            )
        finally:
            self._commit()

    def get_admin_user(self):
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM users WHERE role = 'admin' LIMIT 1")
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            self._commit()

    def create_admin_user(self, username: str, password_hash: str) -> int:
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "INSERT INTO users (username, password_hash, role, is_active) VALUES (%s, %s, 'admin', TRUE) "
                "ON CONFLICT (username) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash "
                "RETURNING id",
                (username, password_hash)
            )
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def get_all_users(self):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT u.id, u.username, u.role, u.is_active, u.bots_on, u.youtube_on,
                       u.yt_chat_on, u.agents_on, u.sys_bot_on, u.agents_limit,
                       u.telegram_phone, u.created_at, u.ai_plan_id, u.seo_visible,
                       p.name AS ai_plan_name, p.monthly_limit AS ai_plan_monthly_limit
                FROM users u
                LEFT JOIN ai_plans p ON p.id = u.ai_plan_id
                ORDER BY u.id
            """)
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_user_by_id(self, user_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            self._commit()

    def update_user(self, user_id: int, **fields):
        try:
            allowed = {'is_active', 'bots_on', 'youtube_on', 'yt_chat_on', 'agents_on', 'sys_bot_on', 'agents_limit', 'role', 'ai_plan_id', 'seo_visible'}
            updates = {k: v for k, v in fields.items() if k in allowed}
            if not updates:
                return
            cursor = self._get_cursor()
            set_clause = ', '.join(f"{k} = %s" for k in updates)
            vals = []
            for k, v in updates.items():
                vals.append(json.dumps(v) if isinstance(v, (dict, list)) else v)
            vals.append(user_id)
            cursor.execute(f"UPDATE users SET {set_clause} WHERE id = %s", vals)
        finally:
            self._commit()

    def change_username(self, user_id: int, new_username: str) -> dict:
        """Change a user's username. Returns {'ok': True} or {'error': 'reason'}."""
        try:
            cursor = self._get_cursor()
            # Check for duplicate (case-insensitive)
            cursor.execute("SELECT id FROM users WHERE LOWER(username) = LOWER(%s) AND id != %s", (new_username, user_id))
            if cursor.fetchone():
                return {'error': 'Username already taken'}
            cursor.execute("UPDATE users SET username = %s WHERE id = %s", (new_username, user_id))
            return {'ok': True}
        finally:
            self._commit()

    def delete_user(self, user_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
        finally:
            self._commit()

    # ── AI Plans ──────────────────────────────────────────────────────────────

    def get_ai_plans(self):
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM ai_plans ORDER BY monthly_limit, id")
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_ai_plan(self, plan_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM ai_plans WHERE id = %s", (plan_id,))
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            self._commit()

    def create_ai_plan(self, name: str, description: str, monthly_limit: int) -> int:
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "INSERT INTO ai_plans (name, description, monthly_limit, is_default) VALUES (%s, %s, %s, FALSE) RETURNING id",
                (name, description, monthly_limit)
            )
            plan_id = cursor.fetchone()['id']
            return plan_id
        finally:
            self._commit()

    def update_ai_plan(self, plan_id: int, **fields):
        try:
            allowed = {'name', 'description', 'monthly_limit'}
            updates = {k: v for k, v in fields.items() if k in allowed}
            if not updates:
                return
            cursor = self._get_cursor()
            set_clause = ', '.join(f"{k} = %s" for k in updates)
            vals = list(updates.values()) + [plan_id]
            cursor.execute(f"UPDATE ai_plans SET {set_clause} WHERE id = %s", vals)
        finally:
            self._commit()

    def delete_ai_plan(self, plan_id: int):
        try:
            cursor = self._get_cursor()
            # Unassign from users first
            cursor.execute("UPDATE users SET ai_plan_id = NULL WHERE ai_plan_id = %s", (plan_id,))
            cursor.execute("DELETE FROM ai_plans WHERE id = %s", (plan_id,))
        finally:
            self._commit()

    def get_plan_for_user(self, user_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT p.* FROM ai_plans p
                JOIN users u ON u.ai_plan_id = p.id
                WHERE u.id = %s
            """, (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            self._commit()

    # ── AI Usage tracking ─────────────────────────────────────────────────────

    def check_ai_limit(self, user_id: int) -> dict:
        """Return {allowed: bool, used: int, limit: int|None, remaining: int|None}.
        allowed=True when user has no plan (unlimited) or has remaining quota."""
        import datetime
        year_month = datetime.datetime.utcnow().strftime("%Y-%m")
        plan = self.get_plan_for_user(user_id)
        if plan is None:
            return {"allowed": True, "used": 0, "limit": None, "remaining": None}
        used = self.get_ai_usage(user_id, year_month)
        limit = plan["monthly_limit"]
        remaining = max(0, limit - used)
        return {"allowed": used < limit, "used": used, "limit": limit, "remaining": remaining}

    def track_ai_request(self, user_id: int) -> int:
        try:
            """Increment this month's request count for user. Returns new count."""
            import datetime
            year_month = datetime.datetime.utcnow().strftime("%Y-%m")
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO ai_usage (user_id, year_month, request_count)
                VALUES (%s, %s, 1)
                ON CONFLICT (user_id, year_month)
                DO UPDATE SET request_count = ai_usage.request_count + 1
                RETURNING request_count
            """, (user_id, year_month))
            row = cursor.fetchone()
            return row['request_count'] if row else 1
        finally:
            self._commit()

    def get_ai_usage(self, user_id: int, year_month: str = None) -> int:
        try:
            """Return request count for user in given month (default: current month)."""
            import datetime
            if year_month is None:
                year_month = datetime.datetime.utcnow().strftime("%Y-%m")
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT request_count FROM ai_usage WHERE user_id = %s AND year_month = %s",
                (user_id, year_month)
            )
            row = cursor.fetchone()
            return row['request_count'] if row else 0
        finally:
            self._commit()

    def get_ai_usage_with_plan(self, user_id: int) -> dict:
        """Return {used, limit, remaining, plan_name, year_month} for this month."""
        import datetime
        year_month = datetime.datetime.utcnow().strftime("%Y-%m")
        used = self.get_ai_usage(user_id, year_month)
        plan = self.get_plan_for_user(user_id)
        limit = plan['monthly_limit'] if plan else None
        return {
            "used":       used,
            "limit":      limit,
            "remaining":  max(0, limit - used) if limit is not None else None,
            "plan_name":  plan['name'] if plan else None,
            "plan_id":    plan['id'] if plan else None,
            "year_month": year_month,
            "has_plan":   plan is not None,
        }

    # ── Bot inheritance ───────────────────────────────────────────────────────

    def get_user_bot_inheritances(self, user_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT ubi.*, b.name AS bot_name
                FROM user_bot_inheritance ubi
                JOIN bots b ON b.id = ubi.bot_id
                WHERE ubi.user_id = %s
                ORDER BY b.name
            """, (user_id,))
            rows = [dict(r) for r in cursor.fetchall()]
            for row in rows:
                row['topic_settings'] = self.get_user_bot_topic_settings(row['id'])
            return rows
        finally:
            self._commit()

    def get_user_bot_topic_settings(self, inheritance_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT topic_id, include_schedules, include_prompts, keyword_pct, seo_visible "
                "FROM user_bot_topic_settings WHERE inheritance_id = %s",
                (inheritance_id,)
            )
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def upsert_topic_settings(self, inheritance_id: int, topic_id: int, settings: dict):
        try:
            allowed = {'include_schedules', 'include_prompts', 'keyword_pct', 'seo_visible'}
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT id FROM user_bot_topic_settings WHERE inheritance_id = %s AND topic_id = %s",
                (inheritance_id, topic_id)
            )
            if cursor.fetchone():
                parts, vals = [], []
                for k, v in settings.items():
                    if k in allowed:
                        parts.append(f"{k} = %s")
                        vals.append(v)
                if parts:
                    vals += [inheritance_id, topic_id]
                    cursor.execute(
                        f"UPDATE user_bot_topic_settings SET {', '.join(parts)} "
                        "WHERE inheritance_id = %s AND topic_id = %s", vals
                    )
            else:
                cursor.execute("""
                    INSERT INTO user_bot_topic_settings
                        (inheritance_id, topic_id, include_schedules, include_prompts, keyword_pct, seo_visible)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """, (
                    inheritance_id, topic_id,
                    settings.get('include_schedules', True),
                    settings.get('include_prompts', True),
                    settings.get('keyword_pct', 100),
                    settings.get('seo_visible', True),
                ))
        finally:
            self._commit()

    def delete_topic_settings(self, inheritance_id: int, topic_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "DELETE FROM user_bot_topic_settings WHERE inheritance_id = %s AND topic_id = %s",
                (inheritance_id, topic_id)
            )
        finally:
            self._commit()

    def user_has_bot_access(self, user_id: int, bot_name: str) -> bool:
        """True if user owns or has inherited the named bot."""
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """SELECT 1 FROM user_bot_inheritance ubi
                   JOIN bots b ON b.id = ubi.bot_id
                   WHERE ubi.user_id = %s AND b.name = %s
                   LIMIT 1""",
                (user_id, bot_name)
            )
            if cursor.fetchone():
                return True
            cursor.execute("SELECT 1 FROM bots WHERE name = %s AND owner_id = %s LIMIT 1",
                           (bot_name, user_id))
            return cursor.fetchone() is not None
        finally:
            self._commit()

    def get_bot_inheritance_id(self, user_id: int, bot_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT id FROM user_bot_inheritance WHERE user_id = %s AND bot_id = %s",
                (user_id, bot_id)
            )
            row = cursor.fetchone()
            return row['id'] if row else None
        finally:
            self._commit()

    def upsert_user_bot_inheritance(self, user_id: int, bot_id: int, settings: dict):
        try:
            allowed = {'inherit_categories', 'inherit_topics', 'inherit_keywords',
                       'inherit_rules', 'inherit_prompts', 'inherit_messages_db'}
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT id FROM user_bot_inheritance WHERE user_id = %s AND bot_id = %s",
                (user_id, bot_id)
            )
            if cursor.fetchone():
                parts, vals = [], []
                for k, v in settings.items():
                    if k in allowed:
                        parts.append(f"{k} = %s")
                        vals.append(json.dumps(v) if isinstance(v, (list, dict)) else v)
                if parts:
                    vals += [user_id, bot_id]
                    cursor.execute(
                        f"UPDATE user_bot_inheritance SET {', '.join(parts)} "
                        "WHERE user_id = %s AND bot_id = %s", vals
                    )
            else:
                cursor.execute("""
                    INSERT INTO user_bot_inheritance
                        (user_id, bot_id, inherit_categories, inherit_topics,
                         inherit_keywords, inherit_rules, inherit_prompts, inherit_messages_db)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    user_id, bot_id,
                    json.dumps(settings.get('inherit_categories', [])),
                    json.dumps(settings.get('inherit_topics', [])),
                    settings.get('inherit_keywords', True),
                    settings.get('inherit_rules', True),
                    settings.get('inherit_prompts', True),
                    settings.get('inherit_messages_db', False),
                ))
        finally:
            self._commit()

    def delete_user_bot_inheritance(self, user_id: int, bot_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "DELETE FROM user_bot_inheritance WHERE user_id = %s AND bot_id = %s",
                (user_id, bot_id)
            )
        finally:
            self._commit()

    # ── Collection inheritance ────────────────────────────────────────────────

    def get_user_collection_inheritances(self, user_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT collection_name FROM user_collection_inheritance WHERE user_id = %s ORDER BY collection_name",
                (user_id,)
            )
            return [r['collection_name'] for r in cursor.fetchall()]
        finally:
            self._commit()

    def grant_collection_inheritance(self, user_id: int, collection_name: str):
        # Record the grant
        try:
            all_colls = self.get_all_collections()
            coll_data = all_colls.get(collection_name, {})
            cursor = self._get_cursor()
            cursor.execute(
                "INSERT INTO user_collection_inheritance (user_id, collection_name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (user_id, collection_name)
            )
            # Copy collection data into user_collections (no overwrite if user already customised it)
            if coll_data:
                cursor.execute("""
                    INSERT INTO user_collections (user_id, name, display_name, source_channels, target_channels, enabled)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (user_id, name) DO NOTHING
                """, (
                    user_id,
                    collection_name,
                    coll_data.get('name', collection_name),
                    json.dumps(coll_data.get('source_channels', [])),
                    json.dumps([]),   # users set their own target channels
                    coll_data.get('enabled', True),
                ))
        finally:
            self._commit()

    def revoke_collection_inheritance(self, user_id: int, collection_name: str):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "DELETE FROM user_collection_inheritance WHERE user_id = %s AND collection_name = %s",
                (user_id, collection_name)
            )
            cursor.execute(
                "DELETE FROM user_collections WHERE user_id = %s AND name = %s",
                (user_id, collection_name)
            )
        finally:
            self._commit()

    # ── Per-user owned collections ────────────────────────────────────────────

    def get_user_collections(self, user_id: int) -> dict:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM user_collections WHERE user_id = %s ORDER BY id", (user_id,))
            result = {}
            for row in cursor.fetchall():
                result[row['name']] = {
                    'source_channels': row['source_channels'] or [],
                    'target_channels': row['target_channels'] or [],
                    'enabled': row['enabled'],
                }
            return result
        finally:
            self._commit()

    def save_user_collection(self, user_id: int, name: str, data: dict):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO user_collections (user_id, name, source_channels, target_channels, enabled)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (user_id, name) DO UPDATE SET
                    source_channels = EXCLUDED.source_channels,
                    target_channels = EXCLUDED.target_channels,
                    enabled         = EXCLUDED.enabled
            """, (
                user_id,
                name,
                json.dumps(data.get('source_channels', [])),
                json.dumps(data.get('target_channels', [])),
                data.get('enabled', True),
            ))
        finally:
            self._commit()

    def delete_user_collection(self, user_id: int, name: str) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "DELETE FROM user_collections WHERE user_id = %s AND name = %s",
                (user_id, name)
            )
            deleted = cursor.rowcount > 0
            return deleted
        finally:
            self._commit()

    def rename_user_collection(self, user_id: int, old_name: str, new_name: str) -> dict:
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT 1 FROM user_collections WHERE user_id = %s AND name = %s",
                (user_id, new_name)
            )
            if cursor.fetchone():
                return {'status': 'error', 'message': f'Collection "{new_name}" already exists'}
            cursor.execute(
                "UPDATE user_collections SET name = %s WHERE user_id = %s AND name = %s",
                (new_name, user_id, old_name)
            )
            if cursor.rowcount == 0:
                return {'status': 'error', 'message': 'Collection not found'}
            # Update collection_names in all bots owned by this user
            cursor.execute(
                "SELECT id, collection_names FROM bots WHERE owner_id = %s AND collection_names @> %s::jsonb",
                (user_id, json.dumps([old_name]))
            )
            for bot in cursor.fetchall():
                updated = [new_name if n == old_name else n for n in (bot['collection_names'] or [])]
                cursor.execute(
                    "UPDATE bots SET collection_names = %s::jsonb WHERE id = %s",
                    (json.dumps(updated), bot['id'])
                )
            return {'status': 'ok'}
        finally:
            self._commit()

    def toggle_user_collection(self, user_id: int, name: str, enabled: bool) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "UPDATE user_collections SET enabled = %s WHERE user_id = %s AND name = %s",
                (enabled, user_id, name)
            )
            updated = cursor.rowcount > 0
            return updated
        finally:
            self._commit()

    # ── YouTube inheritance ───────────────────────────────────────────────────

    def get_user_yt_inheritances(self, user_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT * FROM user_yt_inheritance WHERE user_id = %s ORDER BY pushed_at DESC",
                (user_id,)
            )
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def push_yt_inheritance(self, user_id: int, source_type: str, source_id: int,
                            source_name: str, continuous: bool = False) -> int:
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO user_yt_inheritance
                    (user_id, source_type, source_id, source_name, continuous, status)
                VALUES (%s, %s, %s, %s, %s, 'pending')
                ON CONFLICT (user_id, source_type, source_id)
                DO UPDATE SET continuous = EXCLUDED.continuous, status = 'pending',
                              pushed_at = NOW(), responded_at = NULL
                RETURNING id
            """, (user_id, source_type, source_id, source_name, continuous))
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def update_yt_inheritance(self, inh_id: int, **fields):
        try:
            allowed = {'continuous', 'status'}
            updates = {k: v for k, v in fields.items() if k in allowed}
            if not updates:
                return
            # If status is being set to confirmed/rejected, stamp responded_at
            if 'status' in updates and updates['status'] in ('confirmed', 'rejected'):
                updates['responded_at'] = 'NOW()'
            cursor = self._get_cursor()
            parts, vals = [], []
            for k, v in updates.items():
                if v == 'NOW()':
                    parts.append(f"{k} = NOW()")
                else:
                    parts.append(f"{k} = %s")
                    vals.append(v)
            vals.append(inh_id)
            cursor.execute(
                f"UPDATE user_yt_inheritance SET {', '.join(parts)} WHERE id = %s", vals
            )
        finally:
            self._commit()

    def delete_yt_inheritance(self, inh_id: int):
        try:
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM user_yt_inheritance WHERE id = %s", (inh_id,))
        finally:
            self._commit()

    # ─────────────────────────────────────────────────────────────────────────

    def close(self):
        conn = getattr(self._local, 'connection', None)
        if conn:
            try:
                self.pool.putconn(conn)
            except Exception:
                pass
            self._local.connection = None

    # --- System settings ---
    def get_setting(self, key: str):
        try:
            """Return the JSONB value for an arbitrary system_settings key, or None."""
            cursor = self._get_cursor()
            cursor.execute("SELECT value FROM system_settings WHERE key = %s", (key,))
            row = cursor.fetchone()
            return row['value'] if row else None
        finally:
            self._commit()

    def set_setting(self, key: str, value):
        try:
            """Upsert an arbitrary key into system_settings (no config-version bump)."""
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO system_settings (key, value, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = NOW()
            """, (key, json.dumps(value), json.dumps(value)))
        finally:
            self._commit()

    def get_system_enabled(self) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT value FROM system_settings WHERE key = 'system_enabled'")
            row = cursor.fetchone()
            return bool(row['value']) if row else True
        finally:
            self._commit()

    def set_system_enabled(self, enabled: bool):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO system_settings (key, value, updated_at)
                VALUES ('system_enabled', %s, NOW())
                ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = NOW()
            """, (json.dumps(enabled), json.dumps(enabled)))
            self._bump_config_version()
        finally:
            self._commit()

    # ==================== Recycle Bin ====================

    def recycle_bin_add(self, entity_type: str, entity_name: str, entity_data: dict, owner_id: int = None):
        try:
            """Save a snapshot of the deleted entity before hard-deleting it."""
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO recycle_bin (entity_type, entity_name, entity_data, owner_id)
                VALUES (%s, %s, %s, %s)
            """, (entity_type, entity_name, json.dumps(entity_data), owner_id))
        finally:
            self._commit()

    def recycle_bin_list(self, owner_id: int = None) -> list:
        try:
            """Return recycle bin items. Admin (owner_id=None) sees all; users see only their own."""
            cursor = self._get_cursor()
            if owner_id is not None:
                cursor.execute("""
                    SELECT id, entity_type, entity_name, entity_data, deleted_at
                    FROM recycle_bin WHERE owner_id = %s ORDER BY deleted_at DESC
                """, (owner_id,))
            else:
                cursor.execute("""
                    SELECT id, entity_type, entity_name, entity_data, deleted_at
                    FROM recycle_bin ORDER BY deleted_at DESC
                """)
            rows = cursor.fetchall()
            result = []
            for r in rows:
                d = dict(r)
                if d['deleted_at']:
                    d['deleted_at'] = d['deleted_at'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def recycle_bin_get(self, item_id: int) -> dict | None:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM recycle_bin WHERE id = %s", (item_id,))
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            self._commit()

    def recycle_bin_delete(self, item_id: int) -> bool:
        try:
            """Permanently delete an item from the recycle bin."""
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM recycle_bin WHERE id = %s", (item_id,))
            deleted = cursor.rowcount > 0
            return deleted
        finally:
            self._commit()

    def recycle_bin_purge(self, days: int = 5) -> int:
        try:
            """Remove items older than N days. Returns count deleted."""
            cursor = self._get_cursor()
            cursor.execute(
                "DELETE FROM recycle_bin WHERE deleted_at < NOW() - (%s * INTERVAL '1 day')",
                (days,)
            )
            count = cursor.rowcount
            return count
        finally:
            self._commit()

    def recycle_bin_restore_bot(self, data: dict):
        """Restore a bot from recycle bin snapshot."""
        self.save_bot(data['name'], data)
        # Restore prompts if included
        for key, val in data.get('prompts', {}).items():
            text = val.get('text', '') if isinstance(val, dict) else str(val)
            self.save_prompt(data['name'], key, text)

    def recycle_bin_restore_category(self, data: dict):
        """Restore a category (and its topics/schedules/keywords)."""
        bot_name = data['bot_name']
        self.add_category(bot_name, data['category_name'])
        for topic_name, topic_data in data.get('topics', {}).items():
            self.add_topic(bot_name, data['category_name'], topic_name)
            if topic_data.get('keywords'):
                self.set_topic_keywords(bot_name, data['category_name'], topic_name, topic_data['keywords'])
            for sch in topic_data.get('schedules', []):
                self.add_schedule(bot_name, data['category_name'], topic_name, sch)

    def recycle_bin_restore_topic(self, data: dict):
        """Restore a topic with its keywords and schedules."""
        bot_name = data['bot_name']
        cat_name = data['category_name']
        self.add_topic(bot_name, cat_name, data['topic_name'])
        if data.get('keywords'):
            self.set_topic_keywords(bot_name, cat_name, data['topic_name'], data['keywords'])
        for sch in data.get('schedules', []):
            self.add_schedule(bot_name, cat_name, data['topic_name'], sch)

    def recycle_bin_restore_collection(self, data: dict):
        """Restore a collection."""
        self.save_collection(data['name'], data)

    def recycle_bin_restore_prompt(self, data: dict):
        """Restore a global prompt. Newer snapshots include type/name; older
        per-bot snapshots are restored as summaries-type with the bot prefix
        re-applied to the key."""
        prompt_type = data.get('type') or 'summaries'
        key = data.get('key', '')
        if not data.get('type') and data.get('bot_name'):
            key = f"{data['bot_name']}/{key}"
        name = data.get('name') or key
        self.save_prompt(key, data.get('text', ''), prompt_type=prompt_type, name=name)

    def recycle_bin_restore_schedule(self, data: dict):
        """Restore a schedule."""
        self.add_schedule(data['bot_name'], data['category_name'], data['topic_name'], data['schedule'])

    def recycle_bin_restore_yt_channel(self, data: dict):
        """Restore a YouTube channel from recycle bin snapshot."""
        from youtube_monitor.db import get_yt_db
        yt_db = get_yt_db()
        channel_id = data.get('channel_id', '')
        yt_db.add_channel(channel_id, data)

    def recycle_bin_restore_yt_keyword(self, data: dict):
        """Restore a YouTube keyword tracker from recycle bin snapshot."""
        from youtube_monitor.db import get_yt_db
        yt_db = get_yt_db()
        yt_db.add_keyword(data)


# ==================== Module-level singleton ====================
# Both app.py and main.py register their Database instance here so
# that routers and helpers can call get_db() without needing to pass
# the instance around explicitly.

_db_instance: Database = None


def set_db_instance(db: Database):
    global _db_instance
    _db_instance = db


def get_db() -> Database:
    return _db_instance
