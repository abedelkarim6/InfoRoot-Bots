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
        """
        self.dsn = dsn
        self.pool = psycopg2.pool.ThreadedConnectionPool(minconn=1, maxconn=20, dsn=dsn)
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
        finally:
            self._commit()

    def _migrate_comma_keywords(self):
        try:
            """One-time migration: split any keyword rows that contain commas into separate rows."""
            cursor = self._get_cursor()
            cursor.execute("SELECT id, bot_name, category_name, topic_name, keyword FROM topic_keywords WHERE keyword LIKE '%,%'")
            bad_rows = cursor.fetchall()
            if not bad_rows:
                return
            fixed = 0
            for row in bad_rows:
                parts = [kw.strip() for kw in row['keyword'].split(',') if kw.strip()]
                # Delete the bad row first
                cursor.execute("DELETE FROM topic_keywords WHERE id = %s", (row['id'],))
                # Insert each part
                for part in parts:
                    cursor.execute("""
                        INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                        VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING
                    """, (row['bot_name'], row['category_name'], row['topic_name'], part))
                fixed += 1
            if fixed:
                logger.info(f"[KEYWORDS] Migrated {fixed} comma-separated keyword rows into individual entries")
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

    def add_message(self, channel_id, text, countries=None, regions=None,
                    keywords=None, bot_name=None, original_text=None, replaced_text=None,
                    topics=None, categories=None, channel_username=None, collection_name=None):
        try:
            countries_str = ",".join(countries) if countries else None
            regions_str = ",".join(regions) if regions else None
            keywords_str = ",".join(keywords) if keywords else None
            topics_str = ",".join(topics) if topics else None
            categories_str = ",".join(categories) if categories else None

            cursor = self._get_cursor()
            cursor.execute(
                """INSERT INTO messages
                   (channel_id, text, countries, regions, topics, categories, keywords_found,
                    bot_name, original_text, replaced_text, channel_username, collection_name)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                (channel_id, text, countries_str, regions_str, topics_str, categories_str, keywords_str,
                 bot_name, original_text, replaced_text, channel_username, collection_name)
            )
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def get_messages_for_schedule(self, schedule_type: str, bot_name: str, topic_name: str):
        try:
            """Get messages not yet summarized for this specific (bot, topic, schedule_type) combo."""
            cursor = self._get_cursor()
            # Filter by topic in SQL to avoid fetching thousands of unrelated messages.
            # topics field is comma-separated; match topic_name in any position.
            cursor.execute(
                """SELECT m.* FROM messages m
                   WHERE m.bot_name = %s
                     AND (
                         m.topics = %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                     )
                     AND NOT EXISTS (
                         SELECT 1 FROM message_summarizations ms
                         WHERE ms.message_id = m.id
                           AND ms.bot_name = %s
                           AND ms.topic_name = %s
                           AND ms.schedule_type = %s
                     )""",
                (
                    bot_name,
                    topic_name,                        # exact (single topic)
                    topic_name + ',%',                 # topic at start
                    '%,' + topic_name + ',%',          # topic in middle
                    '%,' + topic_name,                 # topic at end
                    bot_name, topic_name, schedule_type,
                )
            )
            return [dict(row) for row in cursor.fetchall()]
        finally:
            self._commit()

    def mark_as_summarized(self, message_ids: List[int], schedule_type: str,
                           bot_name: str, topic_name: str, status: str = 'summarized'):
        try:
            """Mark messages for a specific (bot, topic, schedule_type) with the given status."""
            if not message_ids:
                return
            cursor = self._get_cursor()
            for mid in message_ids:
                cursor.execute(
                    """INSERT INTO message_summarizations
                           (message_id, bot_name, topic_name, schedule_type, status)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (message_id, bot_name, topic_name, schedule_type) DO NOTHING""",
                    (mid, bot_name, topic_name, schedule_type, status)
                )
        finally:
            self._commit()

    def mark_as_missed(self, message_ids: List[int], schedule_type: str,
                       bot_name: str, topic_name: str):
        """Mark messages as missed (outside schedule window) so they are never re-processed."""
        self.mark_as_summarized(message_ids, schedule_type, bot_name, topic_name, status='missed')

    # ──────────────────────────────────────────────────────────────────────────
    # Interim (rolling 25-message batch) summarization
    # ──────────────────────────────────────────────────────────────────────────

    def get_unsummarized_count_for_interim(self, bot_name: str, topic_name: str) -> int:
        """Count messages for (bot, topic) not yet consumed by the interim summarizer."""
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """SELECT COUNT(*) AS cnt FROM messages m
                   WHERE m.bot_name = %s
                     AND (
                         m.topics = %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                     )
                     AND NOT EXISTS (
                         SELECT 1 FROM message_summarizations ms
                         WHERE ms.message_id = m.id
                           AND ms.bot_name = %s
                           AND ms.topic_name = %s
                           AND ms.schedule_type = 'interim'
                     )""",
                (
                    bot_name,
                    topic_name,
                    topic_name + ',%',
                    '%,' + topic_name + ',%',
                    '%,' + topic_name,
                    bot_name, topic_name,
                )
            )
            row = cursor.fetchone()
            return row['cnt'] if row else 0
        finally:
            self._commit()

    def get_messages_for_interim(self, bot_name: str, topic_name: str, limit: int = 25) -> list:
        """Get the oldest `limit` messages for (bot, topic) not yet interim-summarized."""
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """SELECT m.* FROM messages m
                   WHERE m.bot_name = %s
                     AND (
                         m.topics = %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                     )
                     AND NOT EXISTS (
                         SELECT 1 FROM message_summarizations ms
                         WHERE ms.message_id = m.id
                           AND ms.bot_name = %s
                           AND ms.topic_name = %s
                           AND ms.schedule_type = 'interim'
                     )
                   ORDER BY m.timestamp ASC
                   LIMIT %s""",
                (
                    bot_name,
                    topic_name,
                    topic_name + ',%',
                    '%,' + topic_name + ',%',
                    '%,' + topic_name,
                    bot_name, topic_name,
                    limit,
                )
            )
            return [dict(row) for row in cursor.fetchall()]
        finally:
            self._commit()

    def save_interim_summary(self, bot_name: str, topic_name: str,
                             summary_text: str, message_count: int) -> int:
        """Insert a new interim summary and return its id."""
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """INSERT INTO topic_interim_summaries
                       (bot_name, topic_name, summary_text, message_count)
                   VALUES (%s, %s, %s, %s)
                   RETURNING id""",
                (bot_name, topic_name, summary_text, message_count)
            )
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def get_unsent_interim_summaries(self, bot_name: str, topic_name: str,
                                     since_dt) -> list:
        """Return all unsent interim summaries for (bot, topic) created after since_dt."""
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """SELECT * FROM topic_interim_summaries
                   WHERE bot_name = %s
                     AND topic_name = %s
                     AND sent_at IS NULL
                     AND created_at >= %s
                   ORDER BY created_at ASC""",
                (bot_name, topic_name, since_dt)
            )
            return [dict(row) for row in cursor.fetchall()]
        finally:
            self._commit()

    def mark_interim_summaries_sent(self, ids: List[int]):
        """Mark interim summaries as included in a final send."""
        if not ids:
            return
        try:
            cursor = self._get_cursor()
            cursor.execute(
                "UPDATE topic_interim_summaries SET sent_at = NOW() WHERE id = ANY(%s)",
                (ids,)
            )
        finally:
            self._commit()

    def get_old_unsummarized_messages(self, before_dt) -> list:
        """Return all messages older than before_dt that have no interim tracking record."""
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """SELECT m.id, m.bot_name, m.topics FROM messages m
                   WHERE m.timestamp < %s
                     AND m.bot_name IS NOT NULL
                     AND NOT EXISTS (
                         SELECT 1 FROM message_summarizations ms
                         WHERE ms.message_id = m.id AND ms.schedule_type = 'interim'
                     )""",
                (before_dt,)
            )
            return [dict(row) for row in cursor.fetchall()]
        finally:
            self._commit()

    def save_summary(self, summary_text: str, message_count: int,
                     summary_type: str, target_entity: str,
                     bot_name: str = None, topic_name: str = None,
                     message_ids: list = None) -> int:
        try:
            """Save a generated summary and return its id."""
            ids_str = ",".join(str(i) for i in message_ids) if message_ids else None
            cursor = self._get_cursor()
            cursor.execute(
                """INSERT INTO summaries
                   (summary_text, message_count, summary_type, target_entity, bot_name, topic_name, message_ids)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                (summary_text, message_count, summary_type, target_entity, bot_name, topic_name, ids_str)
            )
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def get_pending_counts(self, allowed_bot_names: list = None):
        try:
            """Returns pending message counts per bot per topic for each schedule type."""
            cursor = self._get_cursor()
            if allowed_bot_names is not None:
                cursor.execute("""
                    SELECT m.id, m.bot_name, m.topics
                    FROM messages m
                    WHERE m.bot_name IS NOT NULL AND m.topics IS NOT NULL AND m.topics != ''
                      AND m.bot_name = ANY(%s)
                """, (allowed_bot_names,))
            else:
                cursor.execute("""
                    SELECT m.id, m.bot_name, m.topics
                    FROM messages m
                    WHERE m.bot_name IS NOT NULL AND m.topics IS NOT NULL AND m.topics != ''
                """)
            rows = cursor.fetchall()

            # Get all existing summarizations (done = summarized/missed per schedule)
            cursor.execute("SELECT message_id, bot_name, topic_name, schedule_type, status FROM message_summarizations")
            done = set()
            missed = set()  # (message_id, bot_name, topic_name) — missed for any schedule
            for r in cursor.fetchall():
                done.add((r['message_id'], r['bot_name'], r['topic_name'], r['schedule_type']))
                if r['status'] == 'missed':
                    missed.add((r['message_id'], r['bot_name'], r['topic_name']))

            counts = {}  # bot_name -> topic -> {hourly, daily, minute, ...}
            for row in rows:
                bn = row['bot_name'] or 'unknown'
                topics_str = row['topics'] or ''
                topics = [t.strip() for t in topics_str.split(',') if t.strip()]

                if bn not in counts:
                    counts[bn] = {}

                for topic in topics:
                    if topic not in counts[bn]:
                        counts[bn][topic] = {'hourly': 0, 'daily': 0, 'minute': 0, 'interval': 0, 'interval_minutes': 0, 'speeches_interval': 0}
                    # Skip if this message was marked missed for any schedule type
                    if (row['id'], bn, topic) in missed:
                        continue
                    for stype in ('hourly', 'daily', 'minute', 'interval', 'interval_minutes', 'speeches_interval'):
                        if (row['id'], bn, topic, stype) not in done:
                            counts[bn][topic][stype] += 1

            return counts
        finally:
            self._commit()


    def get_recent_summaries(self, limit: int = 100, allowed_bot_names: list = None,
                             days: int = None, topic: str = None, bot_name: str = None):
        try:
            """Returns recent summaries ordered newest first. Optional filters: days, topic, bot_name."""
            cursor = self._get_cursor()
            conditions = []
            params = []

            if allowed_bot_names is not None:
                conditions.append("bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            if bot_name:
                conditions.append("bot_name ILIKE %s")
                params.append(f"%{bot_name}%")
            if topic:
                conditions.append("topic_name ILIKE %s")
                params.append(f"%{topic}%")
            if days:
                from datetime import datetime, timedelta
                conditions.append("timestamp >= %s")
                params.append(datetime.utcnow() - timedelta(days=days))

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params.append(limit)
            cursor.execute(
                f"""SELECT id, bot_name, topic_name, summary_type, target_entity,
                           message_count, timestamp, summary_text, message_ids
                    FROM summaries
                    {where}
                    ORDER BY timestamp DESC
                    LIMIT %s""",
                params,
            )
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                txt = d.pop('summary_text', '') or ''
                d['preview'] = txt[:300]
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def get_messages_by_ids(self, message_ids: list):
        try:
            """Return messages matching the given IDs."""
            if not message_ids:
                return []
            cursor = self._get_cursor()
            cursor.execute(
                """SELECT id, channel_id, channel_username, collection_name, bot_name,
                          topics, categories, keywords_found, timestamp, text
                   FROM messages
                   WHERE id = ANY(%s)
                   ORDER BY timestamp ASC""",
                (message_ids,)
            )
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                txt = d.pop('text', '') or ''
                d['preview'] = txt[:300]
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def cleanup_uncollected_messages(self):
        try:
            """Delete messages that have no collection_name (old rows pre-dating the column)."""
            cursor = self._get_cursor()
            cursor.execute(
                "DELETE FROM messages WHERE collection_name IS NULL OR collection_name = ''"
            )
        finally:
            self._commit()

    def get_recent_messages(self, limit: int = 200, offset: int = 0, allowed_bot_names: list = None,
                            topic: str = None, bot_name: str = None, days: int = None,
                            source: str = None):
        try:
            """Returns the most recent messages with optional filters for topic, bot, days, source."""
            cursor = self._get_cursor()
            clauses = ["collection_name IS NOT NULL AND collection_name != ''"]
            params = []

            if allowed_bot_names is not None:
                clauses.append("bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            if bot_name:
                clauses.append("bot_name ILIKE %s")
                params.append(f"%{bot_name}%")
            if topic:
                clauses.append("topics ILIKE %s")
                params.append(f"%{topic}%")
            if source:
                clauses.append("channel_username ILIKE %s")
                params.append(f"%{source}%")
            if days:
                clauses.append("timestamp >= NOW() - (%s * INTERVAL '1 day')")
                params.append(days)

            where = " AND ".join(clauses)
            params.extend([limit, offset])
            cursor.execute(
                f"""SELECT id, channel_id, channel_username, collection_name, bot_name,
                           topics, categories, keywords_found, timestamp, text
                    FROM messages
                    WHERE {where}
                    ORDER BY timestamp DESC
                    LIMIT %s OFFSET %s""",
                params,
            )
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                txt = d.pop('text', '') or ''
                d['preview'] = txt[:220]
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def get_unclassified_messages(self, limit: int = 500, offset: int = 0,
                                   bot_name: str = None,
                                   collection: str = None, search: str = None,
                                   allowed_bot_names: list = None):
        try:
            """Returns messages that were not classified into any topic."""
            cursor = self._get_cursor()
            clauses = ["collection_name IS NOT NULL AND collection_name != ''",
                       "(topics IS NULL OR topics = '')"]
            params = []
            if allowed_bot_names is not None:
                clauses.append("bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            if bot_name:
                clauses.append("bot_name = %s")
                params.append(bot_name)
            if collection:
                clauses.append("collection_name = %s")
                params.append(collection)
            if search:
                clauses.append("text ILIKE %s")
                params.append(f"%{search}%")
            where = " AND ".join(clauses)
            params.extend([limit, offset])
            cursor.execute(
                f"""SELECT id, channel_id, channel_username, collection_name, bot_name,
                           timestamp, text
                    FROM messages
                    WHERE {where}
                    ORDER BY timestamp DESC
                    LIMIT %s OFFSET %s""",
                tuple(params)
            )
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                d['preview'] = (d.pop('text', '') or '')[:300]
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def get_unclassified_stats(self, allowed_bot_names: list = None, since: str = None):
        try:
            """Return counts for unclassified messages grouped by bot and collection."""
            cursor = self._get_cursor()
            where = "collection_name IS NOT NULL AND collection_name != '' AND (topics IS NULL OR topics = '')"
            params = []
            if allowed_bot_names is not None:
                where += " AND bot_name = ANY(%s)"
                params.append(allowed_bot_names)
            if since:
                where += " AND timestamp > %s::timestamptz"
                params.append(since)
            cursor.execute(f"""
                SELECT bot_name, collection_name, COUNT(*) AS cnt
                FROM messages
                WHERE {where}
                GROUP BY bot_name, collection_name
                ORDER BY cnt DESC
            """, params or None)
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_missed_messages(self, limit: int = 50, offset: int = 0,
                             bot_name: str = None, topic_name: str = None,
                             search: str = None, allowed_bot_names: list = None):
        try:
            """Returns messages marked as missed (outside schedule window)."""
            cursor = self._get_cursor()
            clauses = ["ms.status = 'missed'"]
            params = []
            if allowed_bot_names is not None:
                clauses.append("ms.bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            if bot_name:
                clauses.append("ms.bot_name = %s")
                params.append(bot_name)
            if topic_name:
                clauses.append("ms.topic_name = %s")
                params.append(topic_name)
            if search:
                clauses.append("m.text ILIKE %s")
                params.append(f"%{search}%")
            where = " AND ".join(clauses)
            params.extend([limit, offset])
            cursor.execute(f"""
                SELECT m.id, m.channel_id, m.channel_username, m.collection_name,
                       ms.bot_name, ms.topic_name, ms.schedule_type, m.timestamp, m.text
                FROM message_summarizations ms
                JOIN messages m ON m.id = ms.message_id
                WHERE {where}
                ORDER BY m.timestamp DESC
                LIMIT %s OFFSET %s
            """, tuple(params))
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                d['preview'] = (d.pop('text', '') or '')[:300]
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def get_missed_stats(self, allowed_bot_names: list = None, since: str = None):
        try:
            """Return counts for missed messages grouped by bot and topic."""
            cursor = self._get_cursor()
            where = "ms.status = 'missed'"
            params = []
            if allowed_bot_names is not None:
                where += " AND ms.bot_name = ANY(%s)"
                params.append(allowed_bot_names)
            if since:
                where += " AND ms.message_id IN (SELECT id FROM messages WHERE timestamp > %s::timestamptz)"
                params.append(since)
            cursor.execute(f"""
                SELECT ms.bot_name, ms.topic_name, COUNT(*) AS cnt
                FROM message_summarizations ms
                WHERE {where}
                GROUP BY ms.bot_name, ms.topic_name
                ORDER BY cnt DESC
            """, params or None)
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_dashboard_stats(self, days: int = 14, filter_source: str = None, filter_topic: str = None, filter_bot_names: list = None) -> dict:
        try:
            """Return comprehensive analytics for the dashboard page."""
            days = max(1, min(365, int(days)))
            cursor = self._get_cursor()

            iv = "(%s * INTERVAL '1 day')"

            # Build optional filter clauses
            src_clause   = " AND channel_username = %s" if filter_source else ""
            topic_clause = " AND TRIM(t.topic) = %s"    if filter_topic  else ""
            bot_clause   = " AND bot_name = ANY(%s)"    if filter_bot_names is not None else ""

            def p(*base):
                """Append filter params (source, topic, bot_names) for messages queries."""
                extra = []
                if filter_source:    extra.append(filter_source)
                if filter_topic:     extra.append(filter_topic)
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            def p_sum(*base):
                """Append filter params (bot_names) for summaries queries."""
                extra = []
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            # Helper for queries that join on the topics lateral (need topic filter inline)
            def p_topic(*base):
                extra = []
                if filter_source:    extra.append(filter_source)
                if filter_topic:     extra.append(filter_topic)
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            # --- Dropdown population: filtered by bot access ---
            cursor.execute(f"""
                SELECT DISTINCT channel_username AS source FROM messages
                WHERE channel_username IS NOT NULL AND channel_username != ''
                  AND timestamp >= NOW() - {iv}{bot_clause}
                ORDER BY source LIMIT 200
            """, (days,) + ((filter_bot_names,) if filter_bot_names is not None else ()))
            all_sources = [r['source'] for r in cursor.fetchall()]

            cursor.execute(f"""
                SELECT DISTINCT TRIM(t.topic) AS topic
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE topics IS NOT NULL AND topics != ''
                  AND TRIM(t.topic) != ''
                  AND timestamp >= NOW() - {iv}{bot_clause}
                ORDER BY topic LIMIT 200
            """, (days,) + ((filter_bot_names,) if filter_bot_names is not None else ()))
            all_topics = [r['topic'] for r in cursor.fetchall()]

            # 1. Totals
            cursor.execute(f"SELECT COUNT(*) AS cnt FROM messages WHERE 1=1{bot_clause}", p_sum())
            total_messages = cursor.fetchone()['cnt']

            cursor.execute(f"SELECT COUNT(*) AS cnt FROM messages WHERE timestamp >= NOW() - {iv}{src_clause}{bot_clause}",
                           p(days))
            period_messages = cursor.fetchone()['cnt']

            cursor.execute(f"SELECT COUNT(*) AS cnt FROM summaries WHERE 1=1{bot_clause}", p_sum())
            total_summaries = cursor.fetchone()['cnt']

            cursor.execute(f"""
                SELECT COUNT(DISTINCT channel_username) AS cnt FROM messages
                WHERE channel_username IS NOT NULL AND channel_username != ''
                  AND timestamp >= NOW() - {iv}{src_clause}{bot_clause}
            """, p(days))
            active_sources = cursor.fetchone()['cnt']

            # 2. Messages per day
            if filter_topic:
                cursor.execute(f"""
                    SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE topics IS NOT NULL AND topics != ''
                      AND timestamp >= NOW() - {iv}{src_clause}{topic_clause}{bot_clause}
                    GROUP BY day ORDER BY day
                """, p_topic(days))
            else:
                cursor.execute(f"""
                    SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
                    FROM messages WHERE timestamp >= NOW() - {iv}{src_clause}{bot_clause}
                    GROUP BY day ORDER BY day
                """, p(days))
            messages_per_day = [{'day': str(r['day']), 'count': r['cnt']} for r in cursor.fetchall()]

            # 3. Messages per topic — top 20
            cursor.execute(f"""
                SELECT TRIM(t.topic) AS topic, COUNT(*) AS cnt
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE topics IS NOT NULL AND topics != ''
                  AND TRIM(t.topic) != '' AND timestamp >= NOW() - {iv}{src_clause}{topic_clause}{bot_clause}
                GROUP BY topic ORDER BY cnt DESC LIMIT 20
            """, p_topic(days))
            messages_per_topic = [{'topic': r['topic'], 'count': r['cnt']} for r in cursor.fetchall()]

            # 4. Topic trend — top 6 only
            top6 = [r['topic'] for r in messages_per_topic[:6]]
            if top6:
                extra_trend = ((filter_source,) if filter_source else ()) + \
                              ((filter_bot_names,) if filter_bot_names is not None else ())
                cursor.execute(f"""
                    SELECT DATE(timestamp) AS day, TRIM(t.topic) AS topic, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE topics IS NOT NULL AND topics != ''
                      AND TRIM(t.topic) = ANY(%s) AND timestamp >= NOW() - {iv}{src_clause}{bot_clause}
                    GROUP BY day, topic ORDER BY day, topic
                """, (top6, days) + extra_trend)
                topic_trend = [{'day': str(r['day']), 'topic': r['topic'], 'count': r['cnt']}
                               for r in cursor.fetchall()]
            else:
                topic_trend = []

            # 5. Top 20 sources by message count
            if filter_topic:
                cursor.execute(f"""
                    SELECT channel_username AS source, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE channel_username IS NOT NULL AND channel_username != ''
                      AND topics IS NOT NULL AND topics != ''
                      AND timestamp >= NOW() - {iv}{src_clause}{topic_clause}{bot_clause}
                    GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
                """, p_topic(days))
            else:
                cursor.execute(f"""
                    SELECT channel_username AS source, COUNT(*) AS cnt
                    FROM messages
                    WHERE channel_username IS NOT NULL AND channel_username != ''
                      AND timestamp >= NOW() - {iv}{src_clause}{bot_clause}
                    GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
                """, p(days))
            messages_per_source = [{'source': r['source'], 'count': r['cnt']} for r in cursor.fetchall()]

            # 6. Source × topic matrix
            top_sources = [r['source'] for r in messages_per_source[:15]]
            top_topics  = [r['topic']  for r in messages_per_topic[:10]]
            if top_sources and top_topics:
                matrix_extra = ((filter_bot_names,) if filter_bot_names is not None else ())
                cursor.execute(f"""
                    SELECT channel_username AS source, TRIM(t.topic) AS topic, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE channel_username IS NOT NULL AND channel_username != ''
                      AND topics IS NOT NULL AND topics != ''
                      AND channel_username = ANY(%s) AND TRIM(t.topic) = ANY(%s)
                      AND timestamp >= NOW() - {iv}{bot_clause}
                    GROUP BY source, topic ORDER BY source, cnt DESC
                """, (top_sources, top_topics, days) + matrix_extra)
                source_topic = [{'source': r['source'], 'topic': r['topic'], 'count': r['cnt']}
                                for r in cursor.fetchall()]
            else:
                source_topic = []

            # 7. Summaries per type in period
            cursor.execute(f"""
                SELECT summary_type, COUNT(*) AS cnt FROM summaries
                WHERE timestamp >= NOW() - {iv}{bot_clause}
                GROUP BY summary_type ORDER BY cnt DESC
            """, p_sum(days))
            summaries_per_type = [{'type': r['summary_type'], 'count': r['cnt']} for r in cursor.fetchall()]

            return {
                'total_messages':         total_messages,
                'period_messages':        period_messages,
                'total_summaries':        total_summaries,
                'active_sources':         active_sources,
                'messages_per_day':       messages_per_day,
                'messages_per_topic':     messages_per_topic,
                'topic_trend':            topic_trend,
                'messages_per_source':    messages_per_source,
                'source_topic_breakdown': source_topic,
                'summaries_per_type':     summaries_per_type,
                'days':                   days,
                'all_sources':            all_sources,
                'all_topics':             all_topics,
                'filter_source':          filter_source,
                'filter_topic':           filter_topic,
            }
        finally:
            self._commit()

    def save_userbot_dialogs(self, channels: list):
        try:
            """Cache the list of channels/groups the userbot is subscribed to."""
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM userbot_dialogs")
            for ch in channels:
                cursor.execute("""
                    INSERT INTO userbot_dialogs (id, title, username, is_broadcast, is_megagroup, can_post, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                """, (ch['id'], ch['title'], ch.get('username'),
                      ch.get('is_broadcast', False), ch.get('is_megagroup', False),
                      ch.get('can_post', False)))
        finally:
            self._commit()

    def get_userbot_dialogs(self) -> dict:
        try:
            """Return cached dialogs + when they were last saved."""
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM userbot_dialogs ORDER BY title")
            channels = [dict(row) for row in cursor.fetchall()]
            cursor.execute("SELECT MAX(updated_at) AS ts FROM userbot_dialogs")
            row = cursor.fetchone()
            updated_at = row['ts'].isoformat() if row and row['ts'] else None
            return {'channels': channels, 'updated_at': updated_at}
        finally:
            self._commit()

    def close(self):
        conn = getattr(self._local, 'connection', None)
        if conn:
            try:
                self.pool.putconn(conn)
            except Exception:
                pass
            self._local.connection = None

    def get_stats(self):
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT COUNT(*) AS total FROM messages")
            total = cursor.fetchone()['total']
            cursor.execute(
                "SELECT COUNT(DISTINCT message_id) AS cnt FROM message_summarizations"
            )
            summarized = cursor.fetchone()['cnt']
            return {
                "total_messages": total,
                "summarized_messages": summarized
            }
        finally:
            self._commit()

    # ==================== Keyword Management ====================

    def seed_keywords_from_config(self, config):
        try:
            """Seed topic_keywords from config.yaml — only runs if the table is empty."""
            cursor = self._get_cursor()
            cursor.execute("SELECT COUNT(*) AS cnt FROM topic_keywords")
            if cursor.fetchone()['cnt'] > 0:
                logger.info("[KEYWORDS] DB already has keywords — skipping seed from config")
                return

            bots = config.get('bots', {})
            inserted = 0
            for bot_name, bot_data in bots.items():
                for category_name, category_data in bot_data.get('categories', {}).items():
                    for topic_name, topic_data in category_data.get('topics', {}).items():
                        for kw in self._split_keywords(topic_data.get('keywords', [])):
                            cursor.execute("""
                                INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                                VALUES (%s, %s, %s, %s)
                                ON CONFLICT DO NOTHING
                            """, (bot_name, category_name, topic_name, kw))
                            inserted += 1
            logger.info(f"[KEYWORDS] Seeded {inserted} keywords from config into DB")
        finally:
            self._commit()

    def migrate_config_to_db(self, config):
        try:
            """Migrate bots, categories, and collections from config.yaml to database."""
            cursor = self._get_cursor()
        
            # Check if bots table is already populated
            cursor.execute("SELECT COUNT(*) AS cnt FROM bots")
            if cursor.fetchone()['cnt'] > 0:
                logger.info("[MIGRATE] DB already has bots — skipping migration from config")
                return

            bots = config.get('bots', {})
            collections = config.get('collections', {})
        
            migrated_bots = 0
            migrated_cats = 0
            migrated_topics = 0
            migrated_scheds = 0
            migrated_colls = 0

            # Migrate bots with their categories and topics
            for bot_name, bot_data in bots.items():
                cursor.execute("""
                    INSERT INTO bots (name, enabled, minimum_messages, collection_names, rules)
                    VALUES (%s, %s, %s, %s, %s) RETURNING id
                """, (
                    bot_name,
                    bot_data.get('enabled', True),
                    bot_data.get('minimum_messages', 5),
                    json.dumps(bot_data.get('collections', [])),
                    json.dumps(bot_data.get('rules', {'remove': [], 'replace': []})),
                ))
                bot_id = cursor.fetchone()['id']
                migrated_bots += 1

                # Migrate categories
                for cat_name, cat_data in bot_data.get('categories', {}).items():
                    cursor.execute("""
                        INSERT INTO categories (bot_id, name, enabled) VALUES (%s, %s, %s) RETURNING id
                    """, (bot_id, cat_name, cat_data.get('enabled', True)))
                    cat_id = cursor.fetchone()['id']
                    migrated_cats += 1

                    # Migrate topics
                    for topic_name, topic_data in cat_data.get('topics', {}).items():
                        cursor.execute("""
                            INSERT INTO topics (category_id, name, enabled, linked_topics)
                            VALUES (%s, %s, %s, %s) RETURNING id
                        """, (
                            cat_id,
                            topic_name,
                            topic_data.get('enabled', True),
                            json.dumps(topic_data.get('linked_topics', [])),
                        ))
                        topic_id = cursor.fetchone()['id']
                        migrated_topics += 1

                        # Migrate schedules (can be list or dict)
                        schedules_data = topic_data.get('schedules', [])
                        if isinstance(schedules_data, dict):
                            # Dictionary format: {sched_name: sched_data}
                            schedules_items = schedules_data.items()
                        else:
                            # List format: [{name: ..., type: ..., ...}]
                            schedules_items = [(s.get('name', f'schedule_{i}'), s) for i, s in enumerate(schedules_data)]
                    
                        for sched_name, sched_data in schedules_items:
                            cursor.execute("""
                                INSERT INTO schedules 
                                (topic_id, name, type, enabled, prompt_key, header, header_datetime,
                                 minute, hour, hours, minutes, start_hour, start_minute)
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            """, (
                                topic_id,
                                sched_name,
                                sched_data.get('type', 'hourly'),
                                sched_data.get('enabled', True),
                                sched_data.get('prompt_key'),
                                sched_data.get('header'),
                                sched_data.get('header_datetime', False),
                                sched_data.get('minute'),
                                sched_data.get('hour'),
                                sched_data.get('hours'),
                                sched_data.get('minutes'),
                                sched_data.get('start_hour'),
                                sched_data.get('start_minute'),
                            ))
                            migrated_scheds += 1

            # Migrate collections
            for coll_name, coll_data in collections.items():
                cursor.execute("""
                    INSERT INTO collections (name, display_name, source_channels, target_channels, enabled)
                    VALUES (%s, %s, %s, %s, %s)
                """, (
                    coll_name,
                    coll_data.get('name', coll_name),
                    json.dumps(coll_data.get('source_channels', [])),
                    json.dumps(coll_data.get('target_channels', [])),
                    coll_data.get('enabled', True),
                ))
                migrated_colls += 1

            logger.info(f"[MIGRATE] Migrated {migrated_bots} bots, {migrated_cats} categories, "
                       f"{migrated_topics} topics, {migrated_scheds} schedules, {migrated_colls} collections")
        finally:
            self._commit()


    def get_topic_keywords(self, bot_name: str, category_name: str, topic_name: str) -> list:
        try:
            """Return the keyword list for a specific topic, always split into individual entries."""
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT keyword FROM topic_keywords
                WHERE bot_name = %s AND category_name = %s AND topic_name = %s
                ORDER BY id
            """, (bot_name, category_name, topic_name))
            return self._split_keywords([row['keyword'] for row in cursor.fetchall()])
        finally:
            self._commit()

    @staticmethod
    def _split_keywords(raw: list) -> list:
        """Flatten a list that may contain comma-separated strings into individual keywords."""
        result = []
        seen = set()
        for item in raw:
            for kw in str(item).split(','):
                kw = kw.strip()
                if kw and kw not in seen:
                    seen.add(kw)
                    result.append(kw)
        return result

    def set_topic_keywords(self, bot_name: str, category_name: str, topic_name: str, keywords: list):
        try:
            """Replace all keywords for a topic with the given list."""
            cursor = self._get_cursor()
            cursor.execute("""
                DELETE FROM topic_keywords
                WHERE bot_name = %s AND category_name = %s AND topic_name = %s
            """, (bot_name, category_name, topic_name))
            for kw in self._split_keywords(keywords):
                cursor.execute("""
                    INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (bot_name, category_name, topic_name, kw))
        finally:
            self._commit()

    def add_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> bool:
        try:
            """Add one or more keywords (splits comma-separated input). Returns True if any were inserted."""
            cursor = self._get_cursor()
            total_inserted = 0
            for kw in self._split_keywords([keyword]):
                cursor.execute("""
                    INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (bot_name, category_name, topic_name, kw))
                total_inserted += cursor.rowcount
            if total_inserted > 0:
                self._bump_config_version()
            return total_inserted > 0
        finally:
            self._commit()

    def delete_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> bool:
        try:
            """Remove a single keyword. Returns True if deleted."""
            cursor = self._get_cursor()
            cursor.execute("""
                DELETE FROM topic_keywords
                WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND keyword = %s
            """, (bot_name, category_name, topic_name, keyword.strip()))
            deleted = cursor.rowcount
            if deleted > 0:
                self._bump_config_version()
            return deleted > 0
        finally:
            self._commit()


    # ==================== Config DAL (replaces config.yaml) ====================

    def _bump_config_version(self, cursor=None):
        try:
            """Increment the config version counter so watchers detect changes."""
            if cursor is None:
                cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO system_settings (key, value, updated_at)
                VALUES ('config_version', '1', NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = (COALESCE(system_settings.value::text::int, 0) + 1)::text::jsonb,
                    updated_at = NOW()
            """)
        finally:
            self._commit()

    def get_config_version(self) -> int:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT value FROM system_settings WHERE key = 'config_version'")
            row = cursor.fetchone()
            return int(row['value']) if row else 0
        finally:
            self._commit()

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

    def get_global_rules(self) -> dict:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT value FROM system_settings WHERE key = 'global_rules'")
            row = cursor.fetchone()
            return row['value'] if row else {"remove": [], "replace": []}
        finally:
            self._commit()

    def set_global_rules(self, rules: dict):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO system_settings (key, value, updated_at)
                VALUES ('global_rules', %s, NOW())
                ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = NOW()
            """, (json.dumps(rules), json.dumps(rules)))
            self._bump_config_version()
        finally:
            self._commit()

    # --- Collections ---
    def get_all_collections(self) -> dict:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT * FROM collections ORDER BY id")
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

    def save_collection(self, name: str, data: dict):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO collections (name, source_channels, target_channels, enabled)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (name) DO UPDATE SET
                    source_channels = EXCLUDED.source_channels,
                    target_channels = EXCLUDED.target_channels,
                    enabled = EXCLUDED.enabled
            """, (
                name,
                json.dumps(data.get('source_channels', [])),
                json.dumps(data.get('target_channels', [])),
                data.get('enabled', True),
            ))
            self._bump_config_version()
        finally:
            self._commit()

    def delete_collection(self, name: str) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM collections WHERE name = %s", (name,))
            deleted = cursor.rowcount > 0
            if deleted:
                cursor.execute("DELETE FROM messages WHERE collection_name = %s", (name,))
                self._bump_config_version()
            return deleted
        finally:
            self._commit()

    def rename_collection(self, old_name: str, new_name: str) -> dict:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT 1 FROM collections WHERE name = %s", (new_name,))
            if cursor.fetchone():
                return {'status': 'error', 'message': f'Collection "{new_name}" already exists'}
            cursor.execute("UPDATE collections SET name = %s WHERE name = %s", (new_name, old_name))
            if cursor.rowcount == 0:
                return {'status': 'error', 'message': 'Collection not found'}
            cursor.execute(
                "SELECT id, collection_names FROM bots WHERE collection_names @> %s::jsonb",
                (json.dumps([old_name]),)
            )
            for bot in cursor.fetchall():
                updated = [new_name if n == old_name else n for n in (bot['collection_names'] or [])]
                cursor.execute(
                    "UPDATE bots SET collection_names = %s::jsonb WHERE id = %s",
                    (json.dumps(updated), bot['id'])
                )
            cursor.execute(
                "UPDATE messages SET collection_name = %s WHERE collection_name = %s",
                (new_name, old_name)
            )
            self._bump_config_version()
            return {'status': 'ok'}
        finally:
            self._commit()

    def toggle_collection(self, name: str, enabled: bool) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute("UPDATE collections SET enabled = %s WHERE name = %s", (enabled, name))
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def get_bots_flat(self):
        try:
            """Return [{id, name, enabled, owner_id}, ...] — lightweight list for UIs."""
            cursor = self._get_cursor()
            cursor.execute("SELECT id, name, enabled, owner_id FROM bots WHERE owner_id IS NULL ORDER BY name")
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_categories_topics_flat(self):
        try:
            """Return categories with their topics, each row including bot_id."""
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT c.id AS category_id, c.name AS category_name, c.enabled,
                       b.id AS bot_id, b.name AS bot_name
                FROM categories c JOIN bots b ON b.id = c.bot_id
                WHERE b.owner_id IS NULL
                ORDER BY b.name, c.name
            """)
            cats = [dict(r) for r in cursor.fetchall()]
            cursor.execute("""
                SELECT t.id, t.name, t.enabled, c.id AS category_id
                FROM topics t JOIN categories c ON c.id = t.category_id
                ORDER BY c.name, t.name
            """)
            topics = [dict(r) for r in cursor.fetchall()]
            # nest topics into categories
            cat_map = {c["category_id"]: c for c in cats}
            for c in cats:
                c["topics"] = []
            for t in topics:
                cid = t["category_id"]
                if cid in cat_map:
                    cat_map[cid]["topics"].append(t)
            return cats
        finally:
            self._commit()

    # --- Bots ---
    def get_all_bots_config(self, owner_id: int = None, _admin_only: bool = True) -> dict:
        """Return the full nested bots config (bots > categories > topics > schedules + keywords).

        If _admin_only is True (default): returns only admin-managed bots (owner_id IS NULL).
        If owner_id is provided: returns only bots owned by that user.
        """
        try:
            cursor = self._get_cursor()

            if _admin_only and owner_id is None:
                owner_filter = "b.owner_id IS NULL"
                bot_filter   = "owner_id IS NULL"
                params       = []
            else:
                owner_filter = "b.owner_id = %s"
                bot_filter   = "owner_id = %s"
                params       = [owner_id]

            cursor.execute(f"SELECT * FROM bots WHERE {bot_filter} ORDER BY id", params)
            bots_rows = cursor.fetchall()

            cursor.execute(f"""
                SELECT c.*, b.name AS bot_name FROM categories c
                JOIN bots b ON b.id = c.bot_id
                WHERE {owner_filter} ORDER BY c.id
            """, params)
            cats_rows = cursor.fetchall()

            cursor.execute(f"""
                SELECT t.*, c.name AS category_name, b.name AS bot_name
                FROM topics t
                JOIN categories c ON c.id = t.category_id
                JOIN bots b ON b.id = c.bot_id
                WHERE {owner_filter}
                ORDER BY t.id
            """, params)
            topics_rows = cursor.fetchall()

            cursor.execute(f"""
                SELECT s.*, t.name AS topic_name, c.name AS category_name, b.name AS bot_name
                FROM schedules s
                JOIN topics t ON t.id = s.topic_id
                JOIN categories c ON c.id = t.category_id
                JOIN bots b ON b.id = c.bot_id
                WHERE {owner_filter}
                ORDER BY s.id
            """, params)
            schedules_rows = cursor.fetchall()

            # Build nested structure
            result = {}
            for b in bots_rows:
                result[b['name']] = {
                    'enabled': b['enabled'],
                    'collections': b['collection_names'] or [],
                    'minimum_messages': b['minimum_messages'],
                    'rules': b['rules'] or {'remove': [], 'replace': []},
                    'default_schedules': b.get('default_schedules') or [],
                    'categories': {},
                }

            for c in cats_rows:
                bn = c['bot_name']
                if bn in result:
                    result[bn]['categories'][c['name']] = {
                        'enabled': c['enabled'],
                        'topics': {},
                    }

            for t in topics_rows:
                bn, cn = t['bot_name'], t['category_name']
                if bn in result and cn in result[bn]['categories']:
                    kws = self.get_topic_keywords(bn, cn, t['name'])
                    result[bn]['categories'][cn]['topics'][t['name']] = {
                        'enabled': t['enabled'],
                        'catch_all': bool(t.get('catch_all')),
                        'linked_topics': t['linked_topics'] or [],
                        'keywords': kws,
                        'schedules': [],
                    }

            for s in schedules_rows:
                bn, cn, tn = s['bot_name'], s['category_name'], s['topic_name']
                if (bn in result and cn in result[bn]['categories']
                        and tn in result[bn]['categories'][cn]['topics']):
                    sch = {
                        'id': s['id'],
                        'name': s['name'],
                        'type': s['type'],
                        'enabled': s['enabled'],
                        'prompt_key': s['prompt_key'],
                        'header': s['header'],
                        'header_datetime': s['header_datetime'] or False,
                        'header_date_arabic': s.get('header_date_arabic') or False,
                        'header_time_arabic': s.get('header_time_arabic') or False,
                        'telegram_targets': _parse_jsonb_list(s.get('telegram_targets')),
                    }
                    # Add type-specific fields
                    if s['minute'] is not None:
                        sch['minute'] = s['minute']
                    if s['hour'] is not None:
                        sch['hour'] = s['hour']
                    if s['hours'] is not None:
                        sch['hours'] = s['hours']
                    if s['minutes'] is not None:
                        sch['minutes'] = s['minutes']
                    if s['start_hour'] is not None:
                        sch['start_hour'] = s['start_hour']
                    if s['start_minute'] is not None:
                        sch['start_minute'] = s['start_minute']
                    result[bn]['categories'][cn]['topics'][tn]['schedules'].append(sch)

            return result
        finally:
            self._commit()

    def get_filtered_bots_config(self, user_id: int) -> dict:
        """Return bot config for a non-admin user: owned bots (full) + inherited bots (filtered)."""
        import copy

        # Collections this user actually has access to — used to strip unavailable ones from bots
        user_coll_names = set(self.get_user_collections(user_id).keys())

        # Owned bots — user has full access with no restrictions
        result = self.get_owned_bots_config(user_id)

        # Strip any collection references the user doesn't have access to (owned bots)
        for bot_cfg in result.values():
            bot_cfg['collections'] = [c for c in bot_cfg.get('collections', []) if c in user_coll_names]

        inheritances = self.get_user_bot_inheritances(user_id)
        if not inheritances:
            return result

        # Build id→name maps and (bot_name, cat_name, topic_name)→topic_id reverse map
        cats_flat = self.get_categories_topics_flat()
        cat_id_to_name   = {c['category_id']: c['category_name'] for c in cats_flat}
        topic_id_to_name = {}
        topic_key_to_id  = {}  # (bot_name, cat_name, topic_name) -> topic_id
        for c in cats_flat:
            for t in c.get('topics', []):
                topic_id_to_name[t['id']] = t['name']
                topic_key_to_id[(c['bot_name'], c['category_name'], t['name'])] = t['id']

        full_config = self.get_all_bots_config()

        for inh in inheritances:
            bot_name = inh['bot_name']
            if bot_name not in full_config:
                continue
            # Skip if already included as an owned bot (full access takes priority)
            if bot_name in result:
                continue

            bot_cfg = copy.deepcopy(full_config[bot_name])

            allowed_cat_ids = set(inh.get('inherit_categories') or [])
            allowed_top_ids = set(inh.get('inherit_topics') or [])

            # Filter categories (empty list = all allowed)
            if allowed_cat_ids:
                allowed_cat_names = {cat_id_to_name[cid] for cid in allowed_cat_ids if cid in cat_id_to_name}
                bot_cfg['categories'] = {k: v for k, v in bot_cfg['categories'].items()
                                          if k in allowed_cat_names}

            # Filter topics within each remaining category (empty list = all allowed)
            if allowed_top_ids:
                allowed_top_names = {topic_id_to_name[tid] for tid in allowed_top_ids if tid in topic_id_to_name}
                for cat_data in bot_cfg['categories'].values():
                    cat_data['topics'] = {k: v for k, v in cat_data['topics'].items()
                                          if k in allowed_top_names}

            # Strip inherited config based on flags
            if not inh.get('inherit_keywords', True):
                for cat in bot_cfg['categories'].values():
                    for topic in cat['topics'].values():
                        topic['keywords'] = []
            if not inh.get('inherit_rules', True):
                bot_cfg['rules'] = {'remove': [], 'replace': []}

            # Apply per-topic SEO masking: hide keyword text for topics where seo_visible=False
            ts_map = {ts['topic_id']: ts for ts in (inh.get('topic_settings') or [])}
            if ts_map:
                for cat_name, cat_data in bot_cfg['categories'].items():
                    for topic_name, topic in cat_data['topics'].items():
                        tid = topic_key_to_id.get((bot_name, cat_name, topic_name))
                        if tid and not ts_map.get(tid, {}).get('seo_visible', True):
                            kws = topic.get('keywords') or []
                            topic['_keyword_count'] = len(kws)
                            topic['keywords'] = []

            # Only show collections the user actually has access to
            bot_cfg['collections'] = [c for c in bot_cfg.get('collections', []) if c in user_coll_names]

            result[bot_name] = bot_cfg

        return result

    def get_full_config(self) -> dict:
        """Return the full config dict matching the old /api/config shape."""
        return {
            'system': {'enabled': self.get_system_enabled()},
            'bots': self.get_all_bots_config(),
            'collections': self.get_all_collections(),
        }

    def save_bot(self, name: str, data: dict, owner_id: int = None):
        try:
            cursor = self._get_cursor()
            vals = (
                name,
                data.get('enabled', True),
                data.get('minimum_messages', 5),
                json.dumps(data.get('collections', [])),
                json.dumps(data.get('rules', {'remove': [], 'replace': []})),
                json.dumps(data.get('default_schedules', [])),
                owner_id,
            )
            if owner_id is None:
                # Admin bot — conflict on name among admin bots (owner_id IS NULL)
                cursor.execute("""
                    INSERT INTO bots (name, enabled, minimum_messages, collection_names, rules, default_schedules, owner_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (name) WHERE owner_id IS NULL DO UPDATE SET
                        enabled = EXCLUDED.enabled,
                        minimum_messages = EXCLUDED.minimum_messages,
                        collection_names = EXCLUDED.collection_names,
                        rules = EXCLUDED.rules,
                        default_schedules = EXCLUDED.default_schedules
                """, vals)
            else:
                # User bot — conflict on (name, owner_id)
                cursor.execute("""
                    INSERT INTO bots (name, enabled, minimum_messages, collection_names, rules, default_schedules, owner_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (name, owner_id) WHERE owner_id IS NOT NULL DO UPDATE SET
                        enabled = EXCLUDED.enabled,
                        minimum_messages = EXCLUDED.minimum_messages,
                        collection_names = EXCLUDED.collection_names,
                        rules = EXCLUDED.rules,
                        default_schedules = EXCLUDED.default_schedules
                """, vals)
            self._bump_config_version()
        finally:
            self._commit()

    def get_bot_owner_id(self, name: str, requesting_user_id: int = None):
        """Return owner_id for the bot with the given name.

        If requesting_user_id is provided, look for a bot owned by that user first;
        fall back to admin bot (owner_id IS NULL) if not found.
        """
        try:
            cursor = self._get_cursor()
            if requesting_user_id is not None:
                cursor.execute(
                    "SELECT owner_id FROM bots WHERE name = %s AND owner_id = %s",
                    (name, requesting_user_id),
                )
                row = cursor.fetchone()
                if row:
                    return row['owner_id']
            # Fall back to admin bot
            cursor.execute(
                "SELECT owner_id FROM bots WHERE name = %s AND owner_id IS NULL",
                (name,),
            )
            row = cursor.fetchone()
            return row['owner_id'] if row else None
        finally:
            self._commit()

    def get_owned_bots_config(self, user_id: int) -> dict:
        """Return full config for all bots owned by this user."""
        return self.get_all_bots_config(owner_id=user_id, _admin_only=False)

    def toggle_bot(self, name: str, enabled: bool, owner_id: int = None) -> bool:
        try:
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("UPDATE bots SET enabled = %s WHERE name = %s AND owner_id IS NULL", (enabled, name))
            else:
                cursor.execute("UPDATE bots SET enabled = %s WHERE name = %s AND owner_id = %s", (enabled, name, owner_id))
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def delete_bot(self, name: str, owner_id: int = None) -> bool:
        try:
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("DELETE FROM bots WHERE name = %s AND owner_id IS NULL", (name,))
            else:
                cursor.execute("DELETE FROM bots WHERE name = %s AND owner_id = %s", (name, owner_id))
            deleted = cursor.rowcount > 0
            if deleted:
                cursor.execute("DELETE FROM messages WHERE bot_name = %s", (name,))
                self._bump_config_version()
            return deleted
        finally:
            self._commit()

    def rename_bot(self, old_name: str, new_name: str, owner_id: int = None) -> bool:
        try:
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("UPDATE bots SET name = %s WHERE name = %s AND owner_id IS NULL", (new_name, old_name))
            else:
                cursor.execute("UPDATE bots SET name = %s WHERE name = %s AND owner_id = %s", (new_name, old_name, owner_id))
            updated = cursor.rowcount > 0
            if updated:
                # Cascade rename to all tables that reference bot_name
                cursor.execute("UPDATE prompts SET bot_name = %s WHERE bot_name = %s", (new_name, old_name))
                cursor.execute("UPDATE topic_keywords SET bot_name = %s WHERE bot_name = %s", (new_name, old_name))
                cursor.execute("UPDATE messages SET bot_name = %s WHERE bot_name = %s", (new_name, old_name))
                cursor.execute("UPDATE summaries SET bot_name = %s WHERE bot_name = %s", (new_name, old_name))
                cursor.execute("UPDATE message_summarizations SET bot_name = %s WHERE bot_name = %s", (new_name, old_name))
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def _get_bot_id(self, bot_name: str, owner_id: int = None):
        """Return the DB id for a bot.

        If owner_id is None → look for an admin bot (owner_id IS NULL).
        If owner_id is set  → look for a user-owned bot first, then admin bot.
        """
        try:
            cursor = self._get_cursor()
            if owner_id is not None:
                cursor.execute(
                    "SELECT id FROM bots WHERE name = %s AND owner_id = %s",
                    (bot_name, owner_id),
                )
                row = cursor.fetchone()
                if row:
                    return row['id']
            # Admin bot fallback (or direct lookup when owner_id is None)
            cursor.execute(
                "SELECT id FROM bots WHERE name = %s AND owner_id IS NULL",
                (bot_name,),
            )
            row = cursor.fetchone()
            return row['id'] if row else None
        finally:
            self._commit()

    # --- Categories ---
    def add_category(self, bot_name: str, category_name: str, owner_id: int = None) -> bool:
        try:
            bot_id = self._get_bot_id(bot_name, owner_id)
            if not bot_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO categories (bot_id, name) VALUES (%s, %s)
                ON CONFLICT DO NOTHING
            """, (bot_id, category_name))
            inserted = cursor.rowcount > 0
            if inserted:
                self._bump_config_version()
            return inserted
        finally:
            self._commit()

    def delete_category(self, bot_name: str, category_name: str, owner_id: int = None) -> bool:
        try:
            bot_id = self._get_bot_id(bot_name, owner_id)
            if not bot_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM categories WHERE bot_id = %s AND name = %s", (bot_id, category_name))
            deleted = cursor.rowcount > 0
            if deleted:
                self._bump_config_version()
            return deleted
        finally:
            self._commit()

    def toggle_category(self, bot_name: str, category_name: str, enabled: bool, owner_id: int = None) -> bool:
        try:
            bot_id = self._get_bot_id(bot_name, owner_id)
            if not bot_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("UPDATE categories SET enabled = %s WHERE bot_id = %s AND name = %s",
                           (enabled, bot_id, category_name))
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def _get_category_id(self, bot_name: str, category_name: str, owner_id: int = None):
        try:
            bot_id = self._get_bot_id(bot_name, owner_id)
            if not bot_id:
                return None
            cursor = self._get_cursor()
            cursor.execute("SELECT id FROM categories WHERE bot_id = %s AND name = %s", (bot_id, category_name))
            row = cursor.fetchone()
            return row['id'] if row else None
        finally:
            self._commit()

    # --- Topics ---
    def add_topic(self, bot_name: str, category_name: str, topic_name: str, owner_id: int = None) -> bool:
        try:
            cat_id = self._get_category_id(bot_name, category_name, owner_id)
            if not cat_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO topics (category_id, name) VALUES (%s, %s)
                ON CONFLICT DO NOTHING
            """, (cat_id, topic_name))
            inserted = cursor.rowcount > 0
            if inserted:
                # Auto-create default schedules from bot config
                cursor.execute("SELECT id FROM topics WHERE category_id = %s AND name = %s", (cat_id, topic_name))
                topic_row = cursor.fetchone()
                if topic_row:
                    topic_id = topic_row['id']
                    cursor.execute("SELECT default_schedules FROM bots WHERE name = %s", (bot_name,))
                    bot_row = cursor.fetchone()
                    default_schedules = (bot_row['default_schedules'] if bot_row else None) or []
                    for ds in default_schedules:
                        # Replace {topic_name} in header
                        header = (ds.get('header') or '').replace('{topic_name}', topic_name)
                        cursor.execute("""
                            INSERT INTO schedules (topic_id, name, type, enabled, prompt_key, header,
                                                   header_datetime, header_date_arabic, header_time_arabic,
                                                   minute, hour, hours, minutes, start_hour, start_minute,
                                                   telegram_targets)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """, (
                            topic_id,
                            (ds.get('name') or '').replace('{topic_name}', topic_name),
                            ds.get('type', 'hourly'),
                            ds.get('enabled', True),
                            ds.get('prompt_key'),
                            header,
                            ds.get('header_datetime', False),
                            ds.get('header_date_arabic', False),
                            ds.get('header_time_arabic', False),
                            ds.get('minute'),
                            ds.get('hour'),
                            ds.get('hours'),
                            ds.get('minutes'),
                            ds.get('start_hour'),
                            ds.get('start_minute'),
                            json.dumps(_parse_jsonb_list(ds.get('telegram_targets'))),
                        ))
                        if ds.get('telegram_targets'):
                            logger.info(f"[DEFAULT-SCH] Applied schedule '{ds.get('name')}' to topic '{topic_name}' with targets: {ds.get('telegram_targets')}")
                self._bump_config_version()
            return inserted
        finally:
            self._commit()

    def delete_topic(self, bot_name: str, category_name: str, topic_name: str, owner_id: int = None) -> bool:
        try:
            cat_id = self._get_category_id(bot_name, category_name, owner_id)
            if not cat_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM topics WHERE category_id = %s AND name = %s", (cat_id, topic_name))
            deleted = cursor.rowcount > 0
            if deleted:
                self._bump_config_version()
            return deleted
        finally:
            self._commit()

    def rename_topic(self, bot_name: str, category_name: str, old_name: str, new_name: str, owner_id: int = None) -> bool:
        try:
            cat_id = self._get_category_id(bot_name, category_name, owner_id)
            if not cat_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("UPDATE topics SET name = %s WHERE category_id = %s AND name = %s",
                           (new_name, cat_id, old_name))
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def rename_prompt_key_in_schedules(self, bot_name: str, old_key: str, new_key: str) -> int:
        try:
            """Update prompt_key in all schedules of a bot when a prompt is renamed."""
            cursor = self._get_cursor()
            cursor.execute("""
                UPDATE schedules SET prompt_key = %s
                WHERE prompt_key = %s
                  AND topic_id IN (
                      SELECT s.id FROM topics s
                      JOIN categories c ON s.category_id = c.id
                      JOIN bots b ON c.bot_id = b.id
                      WHERE b.name = %s
                  )
            """, (new_key, old_key, bot_name))
            count = cursor.rowcount
            if count > 0:
                self._bump_config_version()
            return count
        finally:
            self._commit()

    def toggle_topic(self, bot_name: str, category_name: str, topic_name: str, enabled: bool, owner_id: int = None) -> bool:
        try:
            cat_id = self._get_category_id(bot_name, category_name, owner_id)
            if not cat_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("UPDATE topics SET enabled = %s WHERE category_id = %s AND name = %s",
                           (enabled, cat_id, topic_name))
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def set_topic_catch_all(self, bot_name: str, category_name: str, topic_name: str, value: bool) -> bool:
        try:
            cat_id = self._get_category_id(bot_name, category_name)
            if not cat_id:
                return False
            cursor = self._get_cursor()
            cursor.execute("UPDATE topics SET catch_all = %s WHERE category_id = %s AND name = %s",
                           (value, cat_id, topic_name))
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def update_topic_linked(self, bot_name: str, category_name: str, topic_name: str, linked_topics: list):
        try:
            cat_id = self._get_category_id(bot_name, category_name)
            if not cat_id:
                return
            cursor = self._get_cursor()
            cursor.execute("UPDATE topics SET linked_topics = %s WHERE category_id = %s AND name = %s",
                           (json.dumps(linked_topics), cat_id, topic_name))
            self._bump_config_version()
        finally:
            self._commit()

    def _get_topic_id(self, bot_name: str, category_name: str, topic_name: str):
        try:
            cat_id = self._get_category_id(bot_name, category_name)
            if not cat_id:
                return None
            cursor = self._get_cursor()
            cursor.execute("SELECT id FROM topics WHERE category_id = %s AND name = %s", (cat_id, topic_name))
            row = cursor.fetchone()
            return row['id'] if row else None
        finally:
            self._commit()

    # --- Schedules ---
    def add_schedule(self, bot_name: str, category_name: str, topic_name: str, schedule: dict) -> int:
        try:
            topic_id = self._get_topic_id(bot_name, category_name, topic_name)
            if not topic_id:
                return None
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO schedules (topic_id, name, type, enabled, prompt_key, header, header_datetime,
                                       header_date_arabic, header_time_arabic,
                                       minute, hour, hours, minutes, start_hour, start_minute,
                                       telegram_targets, wait_time, end_hour, end_minute)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (
                topic_id,
                schedule.get('name', ''),
                schedule.get('type', 'hourly'),
                schedule.get('enabled', True),
                schedule.get('prompt_key'),
                schedule.get('header'),
                schedule.get('header_datetime', False),
                schedule.get('header_date_arabic', False),
                schedule.get('header_time_arabic', False),
                schedule.get('minute'),
                schedule.get('hour'),
                schedule.get('hours'),
                schedule.get('minutes'),
                schedule.get('start_hour'),
                schedule.get('start_minute'),
                json.dumps(_parse_jsonb_list(schedule.get('telegram_targets'))),
                schedule.get('wait_time'),
                schedule.get('end_hour'),
                schedule.get('end_minute'),
            ))
            row = cursor.fetchone()
            self._bump_config_version()
            return row['id'] if row else None
        finally:
            self._commit()

    def update_schedule(self, schedule_id: int, schedule: dict) -> bool:
        try:
            allowed = {'name', 'type', 'enabled', 'prompt_key', 'header',
                       'header_datetime', 'header_date_arabic', 'header_time_arabic',
                       'minute', 'hour', 'hours', 'minutes',
                       'start_hour', 'start_minute', 'telegram_targets', 'wait_time',
                       'end_hour', 'end_minute'}
            fields = {k: v for k, v in schedule.items() if k in allowed}
            if not fields:
                return False
            # Normalize and JSON-serialize list fields for JSONB columns
            if 'telegram_targets' in fields:
                fields['telegram_targets'] = json.dumps(_parse_jsonb_list(fields['telegram_targets']))
            set_clause = ", ".join(f"{k} = %s" for k in fields)
            values = list(fields.values()) + [schedule_id]
            cursor = self._get_cursor()
            cursor.execute(f"UPDATE schedules SET {set_clause} WHERE id = %s", values)
            updated = cursor.rowcount > 0
            if updated:
                self._bump_config_version()
            return updated
        finally:
            self._commit()

    def delete_schedule(self, schedule_id: int) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM schedules WHERE id = %s", (schedule_id,))
            deleted = cursor.rowcount > 0
            if deleted:
                self._bump_config_version()
            return deleted
        finally:
            self._commit()

    # --- Prompts ---
    def get_all_prompts(self) -> dict:
        try:
            """Return prompts grouped by bot_name: {bot_name: {key: {text: ...}}}"""
            cursor = self._get_cursor()
            cursor.execute("SELECT bot_name, key, text FROM prompts ORDER BY id")
            result = {}
            for row in cursor.fetchall():
                bn = row['bot_name']
                if bn not in result:
                    result[bn] = {}
                result[bn][row['key']] = {'text': row['text']}
            return result
        finally:
            self._commit()

    def get_bot_prompts(self, bot_name: str) -> dict:
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT key, text FROM prompts WHERE bot_name = %s ORDER BY id", (bot_name,))
            return {row['key']: {'text': row['text']} for row in cursor.fetchall()}
        finally:
            self._commit()

    def save_prompt(self, bot_name: str, key: str, text: str):
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO prompts (bot_name, key, text) VALUES (%s, %s, %s)
                ON CONFLICT (bot_name, key) DO UPDATE SET text = EXCLUDED.text
            """, (bot_name, key, text))
        finally:
            self._commit()

    def delete_prompt(self, bot_name: str, key: str) -> bool:
        try:
            cursor = self._get_cursor()
            cursor.execute("DELETE FROM prompts WHERE bot_name = %s AND key = %s", (bot_name, key))
            deleted = cursor.rowcount > 0
            return deleted
        finally:
            self._commit()

    # ── Dependency checks ────────────────────────────────────────────────────

    def get_collection_bots(self, collection_name: str) -> list:
        try:
            """Return list of bot names whose collection_names include this collection."""
            cursor = self._get_cursor()
            cursor.execute(
                "SELECT name FROM bots WHERE collection_names::jsonb @> %s::jsonb ORDER BY name",
                (json.dumps([collection_name]),)
            )
            return [r['name'] for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_prompt_schedules(self, bot_name: str, key: str) -> list:
        try:
            """Return schedules (with topic/category context) that reference this prompt key."""
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT s.name AS schedule_name, t.name AS topic_name, c.name AS category_name
                FROM schedules s
                JOIN topics t ON t.id = s.topic_id
                JOIN categories c ON c.id = t.category_id
                JOIN bots b ON b.id = c.bot_id
                WHERE b.name = %s AND s.prompt_key = %s
                ORDER BY c.name, t.name, s.name
            """, (bot_name, key))
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_all_dependency_warnings(self) -> list:
        try:
            """
            Return actionable dependency warnings covering:
            - Orphaned prompt key (schedule references missing prompt)
            - Orphaned collection (bot references missing collection)
            - Bot has no collections assigned
            - Bot has no categories / topics
            - Bot has topics but no schedules
            - Collection has no source channels
            - Collection has no target channels
            """
            warnings = []
            cursor = self._get_cursor()

            # ── Schedules referencing a missing prompt key ──────────────────
            cursor.execute("""
                SELECT DISTINCT b.name AS bot_name, s.prompt_key,
                                t.name AS topic_name, c.name AS category_name
                FROM schedules s
                JOIN topics t ON t.id = s.topic_id
                JOIN categories c ON c.id = t.category_id
                JOIN bots b ON b.id = c.bot_id
                WHERE b.owner_id IS NULL
                  AND s.prompt_key IS NOT NULL AND s.prompt_key != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM prompts p
                      WHERE p.bot_name = b.name AND p.key = s.prompt_key
                  )
                ORDER BY b.name, s.prompt_key
            """)
            for r in cursor.fetchall():
                warnings.append({
                    'type': 'orphaned_prompt',
                    'level': 'error',
                    'message': (
                        f"Bot \"{r['bot_name']}\" — schedule in "
                        f"{r['category_name']} / {r['topic_name']} references "
                        f"missing prompt \"{r['prompt_key']}\""
                    ),
                    'bot_name': r['bot_name'],
                })

            # ── Bots referencing collections that don't exist ───────────────
            cursor.execute("SELECT name, collection_names FROM bots WHERE collection_names IS NOT NULL AND owner_id IS NULL")
            bots = cursor.fetchall()
            cursor.execute("SELECT name, source_channels, target_channels FROM collections")
            coll_rows = cursor.fetchall()
            existing_colls = {r['name']: r for r in coll_rows}

            for bot in bots:
                cnames = bot['collection_names'] or []
                for cname in cnames:
                    if cname not in existing_colls:
                        warnings.append({
                            'type': 'orphaned_collection',
                            'level': 'warning',
                            'message': f"Bot \"{bot['name']}\" references missing collection \"{cname}\"",
                            'bot_name': bot['name'],
                        })

            # ── Bots with no collections assigned ──────────────────────────
            cursor.execute("""
                SELECT name FROM bots
                WHERE enabled = true AND owner_id IS NULL
                  AND (collection_names IS NULL
                    OR collection_names = '[]'::jsonb
                    OR jsonb_array_length(collection_names) = 0)
            """)
            for r in cursor.fetchall():
                warnings.append({
                    'type': 'no_collections',
                    'level': 'warning',
                    'message': f"Bot \"{r['name']}\" has no collections — it won't receive or send any messages",
                    'bot_name': r['name'],
                })

            # ── Bots with no categories (can't classify messages) ───────────
            cursor.execute("""
                SELECT b.name FROM bots b
                WHERE b.enabled = true AND b.owner_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.bot_id = b.id)
            """)
            for r in cursor.fetchall():
                warnings.append({
                    'type': 'no_categories',
                    'level': 'warning',
                    'message': f"Bot \"{r['name']}\" has no categories or topics defined — messages can't be classified",
                    'bot_name': r['name'],
                })

            # ── Bots that have topics but no schedules ──────────────────────
            cursor.execute("""
                SELECT DISTINCT b.name FROM bots b
                WHERE b.enabled = true AND b.owner_id IS NULL
                  AND EXISTS (SELECT 1 FROM categories c WHERE c.bot_id = b.id)
                  AND NOT EXISTS (
                      SELECT 1 FROM schedules s
                      JOIN topics t ON t.id = s.topic_id
                      JOIN categories c ON c.id = t.category_id
                      WHERE c.bot_id = b.id
                  )
            """)
            for r in cursor.fetchall():
                warnings.append({
                    'type': 'no_schedules',
                    'level': 'warning',
                    'message': f"Bot \"{r['name']}\" has no schedules — summaries will never be sent",
                    'bot_name': r['name'],
                })

            # ── Collections with no source channels ─────────────────────────
            for coll in coll_rows:
                src = coll['source_channels'] or []
                tgt = coll['target_channels'] or []
                if not src:
                    warnings.append({
                        'type': 'no_source_channels',
                        'level': 'warning',
                        'message': f"Collection \"{coll['name']}\" has no source channels — no messages will be received",
                        'collection_name': coll['name'],
                    })
                if not tgt:
                    warnings.append({
                        'type': 'no_target_channels',
                        'level': 'warning',
                        'message': f"Collection \"{coll['name']}\" has no target channels — summaries have nowhere to go",
                        'collection_name': coll['name'],
                    })

            return warnings
        finally:
            self._commit()

    def search_messages(self, topic_filter: str = None, source_filter: str = None,
                         days: int = 7, limit: int = 50, allowed_bot_names: list = None):
        try:
            """Search messages by topic and/or source within a date range."""
            cursor = self._get_cursor()
            clauses = ["collection_name IS NOT NULL AND collection_name != ''"]
            params = []

            if allowed_bot_names is not None:
                clauses.append("bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            if days:
                clauses.append("timestamp >= NOW() - (%s * INTERVAL '1 day')")
                params.append(days)
            if topic_filter:
                clauses.append("topics ILIKE %s")
                params.append(f"%{topic_filter}%")
            if source_filter:
                clauses.append("channel_username ILIKE %s")
                params.append(f"%{source_filter}%")

            limit = min(limit, 100)
            params.append(limit)

            where = " AND ".join(clauses)
            cursor.execute(f"""
                SELECT id, channel_id, channel_username, collection_name, bot_name,
                       topics, categories, keywords_found, timestamp, text
                FROM messages
                WHERE {where}
                ORDER BY timestamp DESC
                LIMIT %s
            """, tuple(params))

            result = []
            for row in cursor.fetchall():
                d = dict(row)
                txt = d.pop('text', '') or ''
                d['preview'] = txt[:300]
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
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
        """Restore a prompt."""
        self.save_prompt(data['bot_name'], data['key'], data.get('text', ''))

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
