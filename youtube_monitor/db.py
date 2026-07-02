"""
Database operations for the YouTube Monitor feature.
All new tables — does not touch existing tables.
"""

import functools
import hashlib
import logging
import json
import threading
from datetime import datetime

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

# Module-level singleton (set by app.py at startup)
_yt_db = None

# YouTube Data API daily quota budget (units). Google's default project quota
# is 10,000 units/day, resetting at midnight Pacific time. Override at startup
# from config.yaml youtube.daily_quota_limit via set_quota_limit().
_quota_limit = 10_000

# Fixed quota cost per API call (YouTube Data API v3).
QUOTA_COST = {'search.list': 100, 'videos.list': 1}


def set_yt_db(db):
    global _yt_db
    _yt_db = db


def get_yt_db():
    return _yt_db


def set_quota_limit(n: int):
    global _quota_limit
    try:
        _quota_limit = int(n)
    except (TypeError, ValueError):
        pass


def get_quota_limit() -> int:
    return _quota_limit


def record_api_usage(call_type: str, units: int = None, context: str = None,
                     source: str = None, video_count: int = 0, keyword_id: int = None):
    """Record one YouTube Data API call against the daily quota. Safe no-op if
    the DB isn't ready — quota tracking must never break a search."""
    db = get_yt_db()
    if db is None:
        return
    if units is None:
        units = QUOTA_COST.get(call_type, 1)
    db.record_api_usage(call_type, units, context=context, source=source,
                        video_count=video_count, keyword_id=keyword_id)


class YouTubeDB:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.connection = None
        # A single shared psycopg2 connection is NOT safe for concurrent use by
        # the web request handlers and the background scheduler/worker threads.
        # Interleaved cursors/commits/rollbacks on the same connection can wedge
        # it (the per-minute keyword scheduler made collisions frequent). This
        # reentrant lock serializes every public DB operation — see _install_lock.
        self._lock = threading.RLock()
        self._connect()
        self._create_tables()
        self._install_lock()

    def _install_lock(self):
        """Wrap every public method of this instance so it runs while holding
        self._lock. That makes each operation (get cursor → execute → commit)
        atomic across threads, so two threads can never interleave on the shared
        connection. Reentrant, so methods that call other public methods are fine.
        Private (_-prefixed) helpers like _get_cursor are intentionally left
        unwrapped — they only ever run inside an already-locked public method."""
        for name, fn in list(vars(type(self)).items()):
            if name.startswith('_') or not callable(fn):
                continue

            def _wrap(method):
                @functools.wraps(method)
                def wrapper(*args, **kwargs):
                    with self._lock:
                        try:
                            return method(*args, **kwargs)
                        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                            # The single shared connection died mid-operation
                            # (server restart, idle timeout, network blip). The
                            # failed statement never committed, so reconnecting
                            # and retrying the whole operation once is safe and
                            # turns a transient 500 into a successful response.
                            logger.warning(
                                f"[YT-DB] Connection error in {method.__name__}: {e!r}; "
                                f"reconnecting and retrying once")
                            self._connect()
                            return method(*args, **kwargs)
                return wrapper

            setattr(self, name, _wrap(getattr(self, name)))

    def _connect(self):
        self.connection = psycopg2.connect(self.dsn)
        self.connection.autocommit = False

    def _get_cursor(self):
        # Real liveness check: a connection dropped server-side (idle timeout,
        # PG restart, network blip) is NOT detected by a cached attribute access
        # like `isolation_level` — that never touches the socket. `poll()`
        # round-trips to the server and raises on a dead connection, so we can
        # reconnect BEFORE issuing the query instead of letting execute() 500.
        # Mirrors the proven health check in utils/database.py's pool.
        conn = self.connection
        healthy = conn is not None and not conn.closed
        if healthy:
            try:
                conn.poll()
            except Exception:
                healthy = False
        if not healthy:
            self._connect()
        try:
            if self.connection.get_transaction_status() != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
                self.connection.rollback()
        except Exception:
            pass
        return self.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def _create_tables(self):
        cursor = self._get_cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_channels (
                id                    SERIAL PRIMARY KEY,
                channel_id            TEXT UNIQUE NOT NULL,
                channel_name          TEXT,
                telegram_target       TEXT,
                prompt                TEXT,
                websub_subscribed_at  TIMESTAMP,
                websub_expires_at     TIMESTAMP,
                active                BOOLEAN DEFAULT TRUE,
                created_at            TIMESTAMP DEFAULT NOW()
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_keywords (
                id                    SERIAL PRIMARY KEY,
                keyword               TEXT NOT NULL,
                telegram_target       TEXT,
                prompt                TEXT,
                date_window_days      INTEGER DEFAULT 1,
                active                BOOLEAN DEFAULT TRUE,
                created_at            TIMESTAMP DEFAULT NOW(),
                min_duration_seconds  INTEGER,
                max_duration_seconds  INTEGER,
                channel_allowlist     JSONB DEFAULT '[]',
                channel_blocklist     JSONB DEFAULT '[]',
                title_must_include    JSONB DEFAULT '[]',
                title_must_exclude    JSONB DEFAULT '[]',
                min_view_count        INTEGER DEFAULT 0,
                language              TEXT,
                upload_type           TEXT DEFAULT 'video'
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_seen_videos (
                video_id       TEXT PRIMARY KEY,
                title          TEXT,
                channel_id     TEXT,
                discovered_at  TIMESTAMP DEFAULT NOW(),
                source         TEXT
            )
        """)

        # Per-video transcript cache, decoupled from summaries so any video
        # (Gemini-sourced, pending, or never summarized) can have its transcript
        # fetched once and served from the DB on subsequent requests.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_transcripts (
                video_id    TEXT PRIMARY KEY,
                text        TEXT NOT NULL,
                fetched_at  TIMESTAMP DEFAULT NOW()
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_video_queue (
                id              SERIAL PRIMARY KEY,
                video_id        TEXT NOT NULL,
                telegram_target TEXT,
                prompt          TEXT,
                status          TEXT DEFAULT 'pending',
                attempts        INTEGER DEFAULT 0,
                error_log       TEXT,
                created_at      TIMESTAMP DEFAULT NOW(),
                processed_at    TIMESTAMP
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_summaries (
                id                 SERIAL PRIMARY KEY,
                video_id           TEXT NOT NULL,
                title              TEXT,
                channel_name       TEXT,
                published_at       TIMESTAMP,
                transcript_source  TEXT,
                summary_text       TEXT,
                telegram_target    TEXT,
                telegram_sent      BOOLEAN DEFAULT FALSE,
                created_at         TIMESTAMP DEFAULT NOW()
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_blocked_channels (
                id            SERIAL PRIMARY KEY,
                channel_id    TEXT UNIQUE NOT NULL,
                channel_name  TEXT,
                created_at    TIMESTAMP DEFAULT NOW()
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_blocked_keywords (
                id            SERIAL PRIMARY KEY,
                keyword       TEXT UNIQUE NOT NULL,
                created_at    TIMESTAMP DEFAULT NOW()
            )
        """)

        # Per-word last-run tracking. Each individual search term (the main
        # keyword + every sub-keyword) is scheduled independently so searches
        # can be spread across the hour instead of bursting all at once.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_keyword_word_runs (
                keyword_id   INTEGER NOT NULL REFERENCES yt_keywords(id) ON DELETE CASCADE,
                word         TEXT NOT NULL,
                last_run_at  TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (keyword_id, word)
            )
        """)

        # One-shot migration markers
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_migrations (
                key         TEXT PRIMARY KEY,
                applied_at  TIMESTAMP DEFAULT NOW()
            )
        """)

        # YouTube Data API quota usage — one row per API call, so the admin
        # page can show how many of the daily quota units have been burned.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS yt_api_usage (
                id           SERIAL PRIMARY KEY,
                call_type    TEXT NOT NULL,        -- 'search.list' | 'videos.list'
                units        INTEGER NOT NULL,     -- quota units charged by this call
                context      TEXT,                 -- the word searched / video id
                source       TEXT,                 -- 'keyword_search' | 'worker' | 'video_chat'
                video_count  INTEGER DEFAULT 0,    -- videos returned/requested in the call
                keyword_id   INTEGER,              -- keyword this call belongs to (for yield)
                created_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS yt_api_usage_created_idx ON yt_api_usage (created_at DESC)"
        )

        # ── Safe column migrations ──────────────────────────────────
        def _ensure_col(table, col, col_type, default=None):
            self.connection.commit()  # flush any prior state before each migration
            cur = self.connection.cursor()
            cur.execute("""
                SELECT 1 FROM information_schema.columns
                WHERE table_name = %s AND column_name = %s
            """, (table, col))
            if not cur.fetchone():
                defstr = f" DEFAULT {default}" if default is not None else ""
                cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}{defstr}")
            self.connection.commit()

        _ensure_col('yt_channels', 'telegram_target', 'TEXT')
        _ensure_col('yt_channels', 'prompt', 'TEXT')
        _ensure_col('yt_channels', 'telegram_targets', "JSONB", "'[]'")
        _ensure_col('yt_keywords', 'telegram_target', 'TEXT')
        _ensure_col('yt_keywords', 'prompt', 'TEXT')
        _ensure_col('yt_keywords', 'telegram_targets', "JSONB", "'[]'")
        _ensure_col('yt_keywords', 'schedule_interval_minutes', 'INTEGER')
        _ensure_col('yt_keywords', 'last_run_at', 'TIMESTAMP')
        _ensure_col('yt_keywords', 'sub_keywords', 'JSONB', "'[]'")
        # Manual priority for quota-aware rotation: 1 = highest .. 5 = lowest.
        _ensure_col('yt_keywords', 'priority', 'INTEGER', '3')
        # Link each API call to its keyword so the SEO page can show per-keyword yield.
        _ensure_col('yt_api_usage', 'keyword_id', 'INTEGER')
        _ensure_col('yt_video_queue', 'telegram_target', 'TEXT')
        _ensure_col('yt_video_queue', 'prompt', 'TEXT')
        _ensure_col('yt_summaries', 'telegram_target', 'TEXT')
        _ensure_col('yt_summaries', 'duration_secs',  'INTEGER')
        _ensure_col('yt_summaries', 'input_tokens',   'INTEGER')
        _ensure_col('yt_summaries', 'output_tokens',  'INTEGER')
        _ensure_col('yt_video_queue', 'source_channel_id', 'TEXT')
        _ensure_col('yt_video_queue', 'source_keyword_id', 'INTEGER')
        _ensure_col('yt_video_queue', 'updated_at', 'TIMESTAMP', 'NOW()')
        _ensure_col('yt_video_queue', 'added_by_user_id', 'INTEGER')

        # Channel-level video filters (mirror of keyword filters)
        _ensure_col('yt_channels', 'min_duration_seconds', 'INTEGER')
        _ensure_col('yt_channels', 'max_duration_seconds', 'INTEGER')
        _ensure_col('yt_channels', 'title_must_include', 'JSONB', "'[]'")
        _ensure_col('yt_channels', 'title_must_exclude', 'JSONB', "'[]'")
        _ensure_col('yt_channels', 'min_view_count', 'INTEGER', '0')
        _ensure_col('yt_channels', 'language', 'TEXT')
        _ensure_col('yt_channels', 'upload_type', 'TEXT')
        _ensure_col('yt_summaries', 'prompt_hash', 'TEXT')
        # Cache the raw transcript text when Strategy 2 (transcript_api) is
        # used, so the export endpoint can serve it without re-hitting YouTube.
        _ensure_col('yt_summaries', 'transcript_text', 'TEXT')

        # Reference into the global prompts table (type='youtube'). NULL means
        # "use the first available YouTube prompt" — see prompts.resolve_yt_prompt.
        _ensure_col('yt_channels', 'prompt_key', 'TEXT')
        _ensure_col('yt_keywords', 'prompt_key', 'TEXT')

        # Output-length control: target summary length as a percentage of the
        # source transcript's character count. NULL means "no length constraint".
        # Resolution order at summarization time: queue row > source channel/
        # keyword > global default (system_settings 'yt_output_length_percent').
        _ensure_col('yt_channels', 'output_length_percent', 'INTEGER')
        _ensure_col('yt_keywords', 'output_length_percent', 'INTEGER')
        _ensure_col('yt_video_queue', 'output_length_percent', 'INTEGER')
        _ensure_col('yt_video_queue', 'processing_secs', 'INTEGER')
        # Forced summarization strategy for a queue item (manual adds let the
        # user pick): 'gemini_video' or 'transcript_api'. NULL = auto (try the
        # native video strategy first, fall back to transcript).
        _ensure_col('yt_video_queue', 'force_method', 'TEXT')
        _ensure_col('yt_summaries', 'output_length_percent', 'INTEGER')

        # Migrate old single telegram_target into new telegram_targets array
        cursor.execute("""
            UPDATE yt_channels
            SET telegram_targets = jsonb_build_array(telegram_target)
            WHERE telegram_target IS NOT NULL AND telegram_target != ''
              AND (telegram_targets IS NULL OR telegram_targets = '[]'::jsonb)
        """)
        cursor.execute("""
            UPDATE yt_keywords
            SET telegram_targets = jsonb_build_array(telegram_target)
            WHERE telegram_target IS NOT NULL AND telegram_target != ''
              AND (telegram_targets IS NULL OR telegram_targets = '[]'::jsonb)
        """)

        # New keywords default to hourly per-word scheduling.
        cursor.execute(
            "ALTER TABLE yt_keywords ALTER COLUMN schedule_interval_minutes SET DEFAULT 60"
        )

        # One-time backfill: switch every existing keyword to hourly per-word
        # scheduling (each main keyword + sub-keyword searched once per hour).
        cursor.execute("SELECT 1 FROM yt_migrations WHERE key = %s", ('word_hourly_all_60_v1',))
        if not cursor.fetchone():
            cursor.execute("UPDATE yt_keywords SET schedule_interval_minutes = 60")
            cursor.execute("INSERT INTO yt_migrations (key) VALUES (%s)", ('word_hourly_all_60_v1',))

        self.connection.commit()
        logger.info("[YT-DB] YouTube tables created/verified")

    # ── yt_channels ──────────────────────────────────────────────

    def get_channels(self, active_only=False):
        cursor = self._get_cursor()
        sql = "SELECT * FROM yt_channels"
        if active_only:
            sql += " WHERE active = TRUE"
        sql += " ORDER BY created_at DESC"
        cursor.execute(sql)
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            for k in ('websub_subscribed_at', 'websub_expires_at', 'created_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
            # Ensure telegram_targets is always a list
            if not r.get('telegram_targets'):
                r['telegram_targets'] = [r['telegram_target']] if r.get('telegram_target') else []
        return rows

    def add_channel(self, channel_id: str, data: dict):
        cursor = self._get_cursor()
        targets_json = json.dumps(data.get('telegram_targets') or [])
        title_inc = json.dumps(data.get('title_must_include') or [])
        title_exc = json.dumps(data.get('title_must_exclude') or [])
        cursor.execute("""
            INSERT INTO yt_channels (channel_id, channel_name, telegram_targets, prompt_key,
                min_duration_seconds, max_duration_seconds,
                title_must_include, title_must_exclude,
                min_view_count, language, upload_type, output_length_percent)
            VALUES (%s, %s, %s::jsonb, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s)
            ON CONFLICT (channel_id) DO UPDATE SET
                channel_name = COALESCE(EXCLUDED.channel_name, yt_channels.channel_name),
                telegram_targets = EXCLUDED.telegram_targets,
                prompt_key = EXCLUDED.prompt_key,
                min_duration_seconds = EXCLUDED.min_duration_seconds,
                max_duration_seconds = EXCLUDED.max_duration_seconds,
                title_must_include = EXCLUDED.title_must_include,
                title_must_exclude = EXCLUDED.title_must_exclude,
                min_view_count = EXCLUDED.min_view_count,
                language = EXCLUDED.language,
                upload_type = EXCLUDED.upload_type,
                output_length_percent = EXCLUDED.output_length_percent
            RETURNING id
        """, (channel_id, data.get('channel_name'), targets_json, data.get('prompt_key'),
              data.get('min_duration_seconds'), data.get('max_duration_seconds'),
              title_inc, title_exc,
              data.get('min_view_count', 0), data.get('language'), data.get('upload_type'),
              data.get('output_length_percent')))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def update_channel(self, channel_id: str, data: dict):
        cursor = self._get_cursor()
        targets_json = json.dumps(data.get('telegram_targets') or [])
        title_inc = json.dumps(data.get('title_must_include') or [])
        title_exc = json.dumps(data.get('title_must_exclude') or [])
        cursor.execute("""
            UPDATE yt_channels
            SET channel_name = %s, telegram_targets = %s::jsonb, prompt_key = %s,
                min_duration_seconds = %s, max_duration_seconds = %s,
                title_must_include = %s::jsonb, title_must_exclude = %s::jsonb,
                min_view_count = %s, language = %s, upload_type = %s,
                output_length_percent = %s
            WHERE channel_id = %s
        """, (data.get('channel_name'), targets_json, data.get('prompt_key'),
              data.get('min_duration_seconds'), data.get('max_duration_seconds'),
              title_inc, title_exc,
              data.get('min_view_count', 0), data.get('language'), data.get('upload_type'),
              data.get('output_length_percent'),
              channel_id))
        self.connection.commit()

    def toggle_channel(self, channel_id: str, active: bool):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_channels SET active = %s WHERE channel_id = %s", (active, channel_id))
        self.connection.commit()

    def toggle_all_channels(self, active: bool):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_channels SET active = %s", (active,))
        self.connection.commit()

    def delete_channel(self, channel_id: str):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_channels WHERE channel_id = %s", (channel_id,))
        self.connection.commit()

    def update_websub_status(self, channel_id: str, subscribed_at, expires_at):
        cursor = self._get_cursor()
        cursor.execute("""
            UPDATE yt_channels
            SET websub_subscribed_at = %s, websub_expires_at = %s
            WHERE channel_id = %s
        """, (subscribed_at, expires_at, channel_id))
        self.connection.commit()

    def get_channel_by_yt_id(self, yt_channel_id: str):
        """Look up a channel row by its YouTube channel_id."""
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM yt_channels WHERE channel_id = %s", (yt_channel_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

    def get_channels_needing_renewal(self):
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT * FROM yt_channels
            WHERE active = TRUE
              AND (websub_expires_at IS NULL
                   OR websub_expires_at < NOW() + INTERVAL '2 days')
        """)
        return [dict(r) for r in cursor.fetchall()]

    def get_channel_last_video(self, channel_id: str):
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT video_id, title, discovered_at FROM yt_seen_videos
            WHERE channel_id = %s ORDER BY discovered_at DESC LIMIT 1
        """, (channel_id,))
        row = cursor.fetchone()
        if row:
            d = dict(row)
            if d.get('discovered_at'):
                d['discovered_at'] = d['discovered_at'].isoformat()
            return d
        return None

    def get_channel_activity(self) -> dict:
        """Per-channel video activity in one pass: count of videos discovered
        today (server date) and the most-recent video timestamp. Keyed by
        channel_id. Used by the Schedules page channel-status panel."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT channel_id,
                   COUNT(*) FILTER (WHERE discovered_at >= CURRENT_DATE) AS videos_today,
                   MAX(discovered_at) AS last_video_at
            FROM yt_seen_videos
            WHERE channel_id IS NOT NULL
            GROUP BY channel_id
        """)
        out = {}
        for r in cursor.fetchall():
            last = r['last_video_at']
            out[r['channel_id']] = {
                'videos_today': r['videos_today'] or 0,
                'last_video_at': last.isoformat() if last else None,
            }
        return out

    # ── yt_keywords ──────────────────────────────────────────────

    def get_keywords(self, active_only=False):
        cursor = self._get_cursor()
        sql = "SELECT * FROM yt_keywords"
        if active_only:
            sql += " WHERE active = TRUE"
        sql += " ORDER BY created_at DESC"
        cursor.execute(sql)
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            for k in ('created_at', 'last_run_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
            # Ensure telegram_targets is always a list
            if not r.get('telegram_targets'):
                r['telegram_targets'] = [r['telegram_target']] if r.get('telegram_target') else []
        return rows

    def add_keyword(self, data: dict):
        cursor = self._get_cursor()
        targets = data.get('telegram_targets') or []
        cursor.execute("""
            INSERT INTO yt_keywords (
                keyword, telegram_targets, prompt_key,
                date_window_days, active,
                min_duration_seconds, max_duration_seconds,
                channel_allowlist, channel_blocklist,
                title_must_include, title_must_exclude,
                min_view_count, language, upload_type,
                schedule_interval_minutes, sub_keywords, priority,
                output_length_percent
            ) VALUES (%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)
            RETURNING id
        """, (
            data['keyword'],
            json.dumps(targets),
            data.get('prompt_key'),
            data.get('date_window_days', 1),
            data.get('active', True),
            data.get('min_duration_seconds'),
            data.get('max_duration_seconds'),
            json.dumps(data.get('channel_allowlist', [])),
            json.dumps(data.get('channel_blocklist', [])),
            json.dumps(data.get('title_must_include', [])),
            json.dumps(data.get('title_must_exclude', [])),
            data.get('min_view_count', 0),
            data.get('language'),
            data.get('upload_type', 'video'),
            data.get('schedule_interval_minutes') or 60,
            json.dumps(data.get('sub_keywords', [])),
            data.get('priority') or 3,
            data.get('output_length_percent'),
        ))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def update_keyword(self, kw_id: int, data: dict):
        cursor = self._get_cursor()
        targets = data.get('telegram_targets') or []
        cursor.execute("""
            UPDATE yt_keywords SET
                keyword = %s,
                telegram_targets = %s::jsonb,
                prompt_key = %s,
                date_window_days = %s,
                active = %s,
                min_duration_seconds = %s,
                max_duration_seconds = %s,
                channel_allowlist = %s,
                channel_blocklist = %s,
                title_must_include = %s,
                title_must_exclude = %s,
                min_view_count = %s,
                language = %s,
                upload_type = %s,
                schedule_interval_minutes = %s,
                sub_keywords = %s::jsonb,
                priority = %s,
                output_length_percent = %s
            WHERE id = %s
        """, (
            data['keyword'],
            json.dumps(targets),
            data.get('prompt_key'),
            data.get('date_window_days', 1),
            data.get('active', True),
            data.get('min_duration_seconds'),
            data.get('max_duration_seconds'),
            json.dumps(data.get('channel_allowlist', [])),
            json.dumps(data.get('channel_blocklist', [])),
            json.dumps(data.get('title_must_include', [])),
            json.dumps(data.get('title_must_exclude', [])),
            data.get('min_view_count', 0),
            data.get('language'),
            data.get('upload_type', 'video'),
            data.get('schedule_interval_minutes') or 60,
            json.dumps(data.get('sub_keywords', [])),
            data.get('priority') or 3,
            data.get('output_length_percent'),
            kw_id,
        ))
        self.connection.commit()

    def delete_keyword(self, kw_id: int):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_keywords WHERE id = %s", (kw_id,))
        self.connection.commit()

    def toggle_keyword(self, kw_id: int, active: bool):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_keywords SET active = %s WHERE id = %s", (active, kw_id))
        self.connection.commit()

    def toggle_all_keywords(self, active: bool):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_keywords SET active = %s", (active,))
        self.connection.commit()

    def get_keyword_by_id(self, kw_id: int):
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM yt_keywords WHERE id = %s", (kw_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

    def update_keyword_last_run(self, kw_id: int):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_keywords SET last_run_at = NOW() WHERE id = %s", (kw_id,))
        self.connection.commit()

    def get_due_keywords(self):
        """Return active keywords whose schedule_interval_minutes has elapsed since last_run_at."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT * FROM yt_keywords
            WHERE active = TRUE
              AND schedule_interval_minutes IS NOT NULL
              AND schedule_interval_minutes > 0
              AND (last_run_at IS NULL
                   OR last_run_at + (schedule_interval_minutes || ' minutes')::INTERVAL <= NOW())
        """)
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            if not r.get('telegram_targets'):
                r['telegram_targets'] = [r['telegram_target']] if r.get('telegram_target') else []
        return rows

    def get_due_keyword_words(self, limit: int = 1):
        """Return the most-overdue individual search words across all active
        keywords (main keyword + each sub-keyword) whose per-word interval has
        elapsed. Callers run only a few per scheduler tick, so search.list calls
        are spread across the hour instead of bursting together.
        Each row: {'keyword_id': int, 'word': str}."""
        cursor = self._get_cursor()
        cursor.execute("""
            WITH words AS (
                SELECT k.id AS keyword_id,
                       k.keyword AS word,
                       k.schedule_interval_minutes AS interval_min
                FROM yt_keywords k
                WHERE k.active = TRUE
                UNION ALL
                SELECT k.id,
                       sk.value,
                       k.schedule_interval_minutes
                FROM yt_keywords k,
                     jsonb_array_elements_text(COALESCE(k.sub_keywords, '[]'::jsonb)) AS sk(value)
                WHERE k.active = TRUE
            )
            SELECT w.keyword_id, w.word
            FROM words w
            LEFT JOIN yt_keyword_word_runs r
                   ON r.keyword_id = w.keyword_id AND r.word = w.word
            WHERE w.word IS NOT NULL AND w.word <> ''
              AND (w.interval_min IS NULL OR w.interval_min > 0)
              AND (r.last_run_at IS NULL
                   OR r.last_run_at + (COALESCE(w.interval_min, 60) || ' minutes')::INTERVAL <= NOW())
            ORDER BY r.last_run_at ASC NULLS FIRST
            LIMIT %s
        """, (limit,))
        return [dict(r) for r in cursor.fetchall()]

    def update_word_last_run(self, keyword_id: int, word: str):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_keyword_word_runs (keyword_id, word, last_run_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (keyword_id, word) DO UPDATE SET last_run_at = NOW()
        """, (keyword_id, word))
        self.connection.commit()

    def get_active_words(self) -> list:
        """Every individual search word (main keyword + each sub-keyword) of all
        active keywords, with its interval, priority, and minutes since last run
        (age_min is None if never run). Used for budget-aware rotation."""
        cursor = self._get_cursor()
        cursor.execute("""
            WITH words AS (
                SELECT k.id AS keyword_id, k.keyword AS word,
                       k.schedule_interval_minutes AS interval_min,
                       COALESCE(k.priority, 3) AS priority
                FROM yt_keywords k
                WHERE k.active = TRUE
                UNION ALL
                SELECT k.id, sk.value, k.schedule_interval_minutes, COALESCE(k.priority, 3)
                FROM yt_keywords k,
                     jsonb_array_elements_text(COALESCE(k.sub_keywords, '[]'::jsonb)) AS sk(value)
                WHERE k.active = TRUE
            )
            SELECT w.keyword_id, w.word, w.interval_min, w.priority,
                   EXTRACT(EPOCH FROM (NOW() - r.last_run_at)) / 60.0 AS age_min
            FROM words w
            LEFT JOIN yt_keyword_word_runs r
                   ON r.keyword_id = w.keyword_id AND r.word = w.word
            WHERE w.word IS NOT NULL AND w.word <> ''
        """)
        return [dict(r) for r in cursor.fetchall()]

    def get_keyword_yield(self, days: int = 7) -> dict:
        """Per-keyword search yield over the last N days, from recorded API calls.
        Returns {keyword_id: {'searches': int, 'found': int, 'yield': float}}."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT keyword_id,
                   COUNT(*)                      AS searches,
                   COALESCE(SUM(video_count), 0) AS found
            FROM yt_api_usage
            WHERE call_type = 'search.list'
              AND keyword_id IS NOT NULL
              AND created_at >= NOW() - (%s || ' days')::INTERVAL
            GROUP BY keyword_id
        """, (str(days),))
        out = {}
        for r in cursor.fetchall():
            searches = r['searches'] or 0
            found = r['found'] or 0
            out[r['keyword_id']] = {
                'searches': searches,
                'found': found,
                'yield': (found / searches) if searches else 0.0,
            }
        return out

    def get_keyword_searches_today(self) -> dict:
        """Count of search.list calls per keyword since local midnight today.
        Returns {keyword_id: searches_done_today}. Used for the Schedules
        'Summary' tab (sent vs remaining)."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT keyword_id, COUNT(*) AS searches
            FROM yt_api_usage
            WHERE call_type = 'search.list'
              AND keyword_id IS NOT NULL
              AND created_at >= CURRENT_DATE
            GROUP BY keyword_id
        """)
        return {r['keyword_id']: (r['searches'] or 0) for r in cursor.fetchall()}

    # ── yt_api_usage (YouTube Data API quota tracking) ──────────

    def record_api_usage(self, call_type: str, units: int, context: str = None,
                         source: str = None, video_count: int = 0, keyword_id: int = None):
        """Insert one API-call usage row. Wrapped so a tracking failure never
        propagates into the search/worker code path."""
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO yt_api_usage (call_type, units, context, source, video_count, keyword_id)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (call_type, units, context, source, video_count, keyword_id))
            self.connection.commit()
        except Exception as e:
            logger.error(f"[YT-DB] record_api_usage failed: {e}")

    def get_quota_today(self) -> dict:
        """Units used since midnight Pacific (YouTube's quota reset boundary)."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT
                COALESCE(SUM(units), 0)                                                  AS units,
                COALESCE(SUM(CASE WHEN call_type = 'search.list' THEN 1 ELSE 0 END), 0)  AS search_calls,
                COALESCE(SUM(CASE WHEN call_type = 'videos.list' THEN 1 ELSE 0 END), 0)  AS video_calls,
                COUNT(*)                                                                 AS total_calls
            FROM yt_api_usage
            WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles')
                                AT TIME ZONE 'America/Los_Angeles'
        """)
        return dict(cursor.fetchone())

    def get_hourly_api_usage(self, hours: int = 24) -> list:
        """Per-hour quota usage for the last N hours (hour labels in Beirut time)."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT
                date_trunc('hour', created_at AT TIME ZONE 'Asia/Beirut')               AS hour_lbn,
                COALESCE(SUM(units), 0)                                                  AS units,
                COALESCE(SUM(CASE WHEN call_type = 'search.list' THEN 1 ELSE 0 END), 0)  AS search_calls,
                COALESCE(SUM(CASE WHEN call_type = 'videos.list' THEN 1 ELSE 0 END), 0)  AS video_calls
            FROM yt_api_usage
            WHERE created_at >= NOW() - (%s || ' hours')::INTERVAL
            GROUP BY 1
            ORDER BY 1 DESC
        """, (str(hours),))
        return [dict(r) for r in cursor.fetchall()]

    def get_recent_api_calls(self, limit: int = 100) -> list:
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT id, call_type, units, context, source, video_count, created_at
            FROM yt_api_usage
            ORDER BY created_at DESC
            LIMIT %s
        """, (limit,))
        return [dict(r) for r in cursor.fetchall()]

    # ── yt_blocked_channels ─────────────────────────────────────

    def get_blocked_channels(self):
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM yt_blocked_channels ORDER BY created_at DESC")
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            if r.get('created_at'):
                r['created_at'] = r['created_at'].isoformat()
        return rows

    def add_blocked_channel(self, channel_id: str, channel_name: str = None):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_blocked_channels (channel_id, channel_name)
            VALUES (%s, %s)
            ON CONFLICT (channel_id) DO UPDATE SET channel_name = COALESCE(EXCLUDED.channel_name, yt_blocked_channels.channel_name)
            RETURNING id
        """, (channel_id, channel_name))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def delete_blocked_channel(self, channel_id: str):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_blocked_channels WHERE channel_id = %s", (channel_id,))
        self.connection.commit()

    def get_blocked_channel_ids(self) -> set:
        cursor = self._get_cursor()
        cursor.execute("SELECT channel_id FROM yt_blocked_channels")
        return {r['channel_id'] for r in cursor.fetchall()}

    # ── yt_blocked_keywords ─────────────────────────────────────

    def get_blocked_keywords(self):
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM yt_blocked_keywords ORDER BY created_at DESC")
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            if r.get('created_at'):
                r['created_at'] = r['created_at'].isoformat()
        return rows

    def add_blocked_keyword(self, keyword: str):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_blocked_keywords (keyword)
            VALUES (%s)
            ON CONFLICT (keyword) DO NOTHING
            RETURNING id
        """, (keyword,))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id'] if row else None

    def delete_blocked_keyword(self, keyword_id: int):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_blocked_keywords WHERE id = %s", (keyword_id,))
        self.connection.commit()

    def get_blocked_keyword_list(self) -> list:
        cursor = self._get_cursor()
        cursor.execute("SELECT keyword FROM yt_blocked_keywords")
        return [r['keyword'] for r in cursor.fetchall()]

    # ── yt_seen_videos ───────────────────────────────────────────

    def is_video_seen(self, video_id: str) -> bool:
        cursor = self._get_cursor()
        cursor.execute("SELECT 1 FROM yt_seen_videos WHERE video_id = %s", (video_id,))
        return cursor.fetchone() is not None

    def mark_video_seen(self, video_id: str, title: str = None, channel_id: str = None, source: str = None):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_seen_videos (video_id, title, channel_id, source)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (video_id) DO NOTHING
        """, (video_id, title, channel_id, source))
        self.connection.commit()

    # ── yt_video_queue ───────────────────────────────────────────

    def is_video_already_queued_or_summarized(self, video_id: str, prompt: str = None,
                                              check_summarized: bool = True) -> str | None:
        """Return a reason string if the video is already queued or summarized, else None.

        The 'already summarized' check is scoped to (video_id, prompt_hash) so that
        changing the prompt allows re-processing the same video. Pass
        check_summarized=False (manual re-runs) to allow summarizing a video that
        already has a summary — only the live queue (pending/processing) blocks.
        """
        cursor = self._get_cursor()
        # Check if already in the queue (pending or processing) regardless of prompt
        cursor.execute("""
            SELECT id, status FROM yt_video_queue
            WHERE video_id = %s AND status IN ('pending', 'processing')
            LIMIT 1
        """, (video_id,))
        row = cursor.fetchone()
        if row:
            return f"already in queue ({row['status']})"
        if not check_summarized:
            return None
        # Check if already summarized with the same prompt
        if prompt:
            ph = hashlib.md5(prompt.encode('utf-8')).hexdigest()
            cursor.execute("""
                SELECT id FROM yt_summaries WHERE video_id = %s AND prompt_hash = %s LIMIT 1
            """, (video_id, ph))
        else:
            # No prompt context — fall back to video_id-only check
            cursor.execute("""
                SELECT id FROM yt_summaries WHERE video_id = %s LIMIT 1
            """, (video_id,))
        if cursor.fetchone():
            return "already summarized"
        return None

    def enqueue_video(self, video_id: str, telegram_target: str = None, prompt: str = None,
                      source_channel_id: str = None, source_keyword_id: int = None,
                      added_by_user_id: int = None, output_length_percent: int = None,
                      force_method: str = None, allow_resummarize: bool = False):
        # Manual re-runs (allow_resummarize) only block on a live queue entry, so
        # the same video can be summarized again — possibly with a different
        # method/prompt. Monitoring keeps the stricter "already summarized" guard.
        reason = self.is_video_already_queued_or_summarized(
            video_id, prompt=prompt, check_summarized=not allow_resummarize)
        if reason:
            logger.info(f"[YT-DB] Skipping enqueue for {video_id}: {reason}")
            return None
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_video_queue (video_id, telegram_target, prompt, source_channel_id, source_keyword_id, added_by_user_id, output_length_percent, force_method)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (video_id, telegram_target, prompt, source_channel_id, source_keyword_id, added_by_user_id, output_length_percent, force_method))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def get_pending_queue_items(self, limit: int = 10):
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT * FROM yt_video_queue
            WHERE status = 'pending' AND attempts < 3
            ORDER BY created_at ASC
            LIMIT %s
        """, (limit,))
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            for k in ('created_at', 'processed_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
        return rows

    def update_queue_status(self, queue_id: int, status: str, error_log: str = None,
                            processing_secs: int = None):
        cursor = self._get_cursor()
        processed = datetime.utcnow() if status in ('done', 'failed') else None
        # Only increment attempts on done/failed, not on 'processing' transition
        if status in ('done', 'failed'):
            cursor.execute("""
                UPDATE yt_video_queue
                SET status = %s, error_log = %s, attempts = attempts + 1,
                    processed_at = %s, updated_at = NOW(),
                    processing_secs = COALESCE(%s, processing_secs)
                WHERE id = %s
            """, (status, error_log, processed, processing_secs, queue_id))
        else:
            cursor.execute("""
                UPDATE yt_video_queue
                SET status = %s, error_log = %s, updated_at = NOW()
                WHERE id = %s
            """, (status, error_log, queue_id))
        self.connection.commit()

    def reset_stuck_processing_items(self, stuck_minutes: int = 10) -> int:
        """Reset items stuck in 'processing' for longer than stuck_minutes back to 'pending'."""
        cursor = self._get_cursor()
        cursor.execute("""
            UPDATE yt_video_queue
            SET status = 'pending', error_log = 'Reset from stuck processing state'
            WHERE status = 'processing'
              AND updated_at < NOW() - INTERVAL '%s minutes'
        """, (stuck_minutes,))
        count = cursor.rowcount
        self.connection.commit()
        return count

    def reset_all_processing_to_failed(self) -> int:
        """Force all currently 'processing' items to 'failed' so they can be retried."""
        cursor = self._get_cursor()
        cursor.execute("""
            UPDATE yt_video_queue
            SET status = 'failed', error_log = 'Manually reset from stuck processing state',
                updated_at = NOW()
            WHERE status = 'processing'
        """)
        count = cursor.rowcount
        self.connection.commit()
        return count

    def retry_queue_item(self, queue_id: int):
        cursor = self._get_cursor()
        cursor.execute("""
            UPDATE yt_video_queue
            SET status = 'pending', error_log = NULL, attempts = 0
            WHERE id = %s
        """, (queue_id,))
        self.connection.commit()

    def get_queue_stats(self, yt_ch_ids=None, kw_ids=None, user_id=None):
        """Queue and daily summary stats.

        Pass yt_ch_ids (YouTube channel_id strings) and/or kw_ids (keyword DB IDs)
        to scope counts to a specific user. None = no filter (global).
        user_id additionally shows manually-added videos for that user.
        """
        scoped = yt_ch_ids is not None or kw_ids is not None
        ch_f = yt_ch_ids or []
        kw_f = kw_ids or []
        uid_f = user_id if user_id is not None else -1
        # Sentinel values that will never match real rows
        ch_sentinel = ['__none__']
        kw_sentinel = [-1]

        cursor = self._get_cursor()

        if scoped:
            cursor.execute("""
                SELECT status, COUNT(*) AS cnt
                FROM yt_video_queue
                WHERE source_channel_id = ANY(%s) OR source_keyword_id = ANY(%s)
                   OR added_by_user_id = %s
                GROUP BY status
            """, (ch_f or ch_sentinel, kw_f or kw_sentinel, uid_f))
        else:
            cursor.execute("SELECT status, COUNT(*) AS cnt FROM yt_video_queue GROUP BY status")
        stats = {r['status']: r['cnt'] for r in cursor.fetchall()}

        # Daily summaries (scoped via EXISTS check through queue)
        if scoped:
            cursor.execute("""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE s.transcript_source = 'transcript_api') AS transcript
                FROM yt_summaries s
                WHERE s.created_at >= CURRENT_DATE
                  AND EXISTS (
                      SELECT 1 FROM yt_video_queue q
                      WHERE q.video_id = s.video_id
                        AND (q.source_channel_id = ANY(%s) OR q.source_keyword_id = ANY(%s)
                             OR q.added_by_user_id = %s)
                  )
            """, (ch_f or ch_sentinel, kw_f or kw_sentinel, uid_f))
        else:
            cursor.execute("""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE transcript_source = 'transcript_api') AS transcript
                FROM yt_summaries
                WHERE created_at >= CURRENT_DATE
            """)
        daily = dict(cursor.fetchone())

        if scoped:
            cursor.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status = 'done' AND processed_at >= CURRENT_DATE) AS processed_today,
                    COUNT(*) FILTER (WHERE status = 'failed' AND processed_at >= CURRENT_DATE) AS failed_today,
                    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS queued_today
                FROM yt_video_queue
                WHERE source_channel_id = ANY(%s) OR source_keyword_id = ANY(%s)
            """, (ch_f or ch_sentinel, kw_f or kw_sentinel))
        else:
            cursor.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status = 'done' AND processed_at >= CURRENT_DATE) AS processed_today,
                    COUNT(*) FILTER (WHERE status = 'failed' AND processed_at >= CURRENT_DATE) AS failed_today,
                    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS queued_today
                FROM yt_video_queue
            """)
        daily_queue = dict(cursor.fetchone())

        return {
            'pending': stats.get('pending', 0),
            'processing': stats.get('processing', 0),
            'done': stats.get('done', 0),
            'failed': stats.get('failed', 0),
            'daily': {
                'summaries': daily.get('total', 0),
                'transcript': daily.get('transcript', 0),
                'processed': daily_queue.get('processed_today', 0),
                'failed': daily_queue.get('failed_today', 0),
                'queued': daily_queue.get('queued_today', 0),
            },
        }

    def get_system_overview(self, allowed_channel_db_ids=None, allowed_keyword_db_ids=None):
        """Lightweight overview for the System page.

        allowed_channel_db_ids: set/list of yt_channels.id integers to restrict to (None = all).
        allowed_keyword_db_ids: set/list of yt_keywords.id integers to restrict to (None = all).
        """
        cursor = self._get_cursor()
        scoped = (allowed_channel_db_ids is not None or allowed_keyword_db_ids is not None)

        # -- Channels ---------------------------------------------------------
        if allowed_channel_db_ids is not None:
            ids = list(allowed_channel_db_ids)
            if ids:
                cursor.execute(
                    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active "
                    "FROM yt_channels WHERE id = ANY(%s)", (ids,)
                )
                ch = dict(cursor.fetchone())
            else:
                ch = {'total': 0, 'active': 0}
        else:
            cursor.execute(
                "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM yt_channels"
            )
            ch = dict(cursor.fetchone())

        # -- Keywords ---------------------------------------------------------
        if allowed_keyword_db_ids is not None:
            ids = list(allowed_keyword_db_ids)
            if ids:
                cursor.execute(
                    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active "
                    "FROM yt_keywords WHERE id = ANY(%s)", (ids,)
                )
                kw = dict(cursor.fetchone())
            else:
                kw = {'total': 0, 'active': 0}
        else:
            cursor.execute(
                "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM yt_keywords"
            )
            kw = dict(cursor.fetchone())

        # -- Resolve channel YouTube IDs for queue filtering -------------------
        yt_channel_ids = None  # TEXT channel_id strings used in yt_video_queue
        if allowed_channel_db_ids is not None:
            db_ids = list(allowed_channel_db_ids)
            if db_ids:
                cursor.execute(
                    "SELECT channel_id FROM yt_channels WHERE id = ANY(%s)", (db_ids,)
                )
                yt_channel_ids = [r['channel_id'] for r in cursor.fetchall()]
            else:
                yt_channel_ids = []

        kw_ids = list(allowed_keyword_db_ids) if allowed_keyword_db_ids is not None else None

        # -- Queue stats -------------------------------------------------------
        if scoped:
            ch_filter = yt_channel_ids if yt_channel_ids else []
            kw_filter = kw_ids if kw_ids else []
            cursor.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
                    COUNT(*) FILTER (WHERE status = 'processing') AS processing,
                    COUNT(*) FILTER (WHERE status = 'done')       AS done,
                    COUNT(*) FILTER (WHERE status = 'failed')     AS failed
                FROM yt_video_queue
                WHERE source_channel_id = ANY(%s) OR source_keyword_id = ANY(%s)
            """, (ch_filter or ['__none__'], kw_filter or [-1]))
        else:
            cursor.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
                    COUNT(*) FILTER (WHERE status = 'processing') AS processing,
                    COUNT(*) FILTER (WHERE status = 'done')       AS done,
                    COUNT(*) FILTER (WHERE status = 'failed')     AS failed
                FROM yt_video_queue
            """)
        q = dict(cursor.fetchone())

        # -- Total summaries (approximated via done queue items for scoped view) --
        if scoped:
            ch_filter = yt_channel_ids if yt_channel_ids else []
            kw_filter = kw_ids if kw_ids else []
            cursor.execute("""
                SELECT COUNT(*) AS total FROM yt_video_queue
                WHERE status = 'done'
                  AND (source_channel_id = ANY(%s) OR source_keyword_id = ANY(%s))
            """, (ch_filter or ['__none__'], kw_filter or [-1]))
        else:
            cursor.execute("SELECT COUNT(*) AS total FROM yt_summaries")
        sm = dict(cursor.fetchone())

        # -- Today's activity -------------------------------------------------
        if scoped:
            ch_filter = yt_channel_ids if yt_channel_ids else []
            kw_filter = kw_ids if kw_ids else []
            cursor.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS queued_today,
                    COUNT(*) FILTER (WHERE status = 'done' AND processed_at >= CURRENT_DATE) AS done_today
                FROM yt_video_queue
                WHERE source_channel_id = ANY(%s) OR source_keyword_id = ANY(%s)
            """, (ch_filter or ['__none__'], kw_filter or [-1]))
        else:
            cursor.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS queued_today,
                    COUNT(*) FILTER (WHERE status = 'done' AND processed_at >= CURRENT_DATE) AS done_today
                FROM yt_video_queue
            """)
        today = dict(cursor.fetchone())

        return {
            'channels': ch,
            'keywords': kw,
            'queue': q,
            'summaries_total': sm['total'],
            'today': today,
        }

    def get_queue_items(self, limit: int = 100, yt_ch_ids=None, kw_ids=None, user_id=None):
        cursor = self._get_cursor()
        scoped = yt_ch_ids is not None or kw_ids is not None
        if scoped:
            ch_f = yt_ch_ids or ['__none__']
            kw_f = kw_ids or [-1]
            uid_f = user_id if user_id is not None else -1
            cursor.execute("""
                SELECT q.*, sv.title AS video_title,
                       COALESCE(ch.channel_name, sm.channel_name, sv.channel_id) AS video_channel_name
                FROM yt_video_queue q
                LEFT JOIN yt_seen_videos sv ON q.video_id = sv.video_id
                LEFT JOIN yt_channels ch ON sv.channel_id = ch.channel_id
                LEFT JOIN LATERAL (
                    SELECT channel_name FROM yt_summaries
                    WHERE video_id = q.video_id AND channel_name IS NOT NULL
                    LIMIT 1
                ) sm ON TRUE
                WHERE q.source_channel_id = ANY(%s) OR q.source_keyword_id = ANY(%s)
                   OR q.added_by_user_id = %s
                ORDER BY q.created_at DESC
                LIMIT %s
            """, (ch_f, kw_f, uid_f, limit))
        else:
            cursor.execute("""
                SELECT q.*, sv.title AS video_title,
                       COALESCE(ch.channel_name, sm.channel_name, sv.channel_id) AS video_channel_name
                FROM yt_video_queue q
                LEFT JOIN yt_seen_videos sv ON q.video_id = sv.video_id
                LEFT JOIN yt_channels ch ON sv.channel_id = ch.channel_id
                LEFT JOIN LATERAL (
                    SELECT channel_name FROM yt_summaries
                    WHERE video_id = q.video_id AND channel_name IS NOT NULL
                    LIMIT 1
                ) sm ON TRUE
                ORDER BY q.created_at DESC
                LIMIT %s
            """, (limit,))
        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            for k in ('created_at', 'processed_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
        return rows

    def get_videos_unified(self, limit: int = 50, offset: int = 0,
                           status_filter: str = None, channel_filter: str = None,
                           source_filter: str = None, keyword_filter: str = None,
                           date_from: str = None, date_to: str = None,
                           yt_ch_ids=None, kw_ids=None, user_id=None):
        """Return queue items joined with their summaries in one unified view with pagination.

        yt_ch_ids: list of YouTube channel_id strings to restrict to (None = all).
        kw_ids: list of keyword DB IDs to restrict to (None = all).
        user_id: also include videos manually added by this user.
        """
        cursor = self._get_cursor()
        clauses = []
        params = []

        # User-scope filter
        if yt_ch_ids is not None or kw_ids is not None:
            ch_f = yt_ch_ids or ['__none__']
            kw_f = kw_ids or [-1]
            uid_f = user_id if user_id is not None else -1
            clauses.append("(q.source_channel_id = ANY(%s) OR q.source_keyword_id = ANY(%s) OR q.added_by_user_id = %s)")
            params.extend([ch_f, kw_f, uid_f])

        if status_filter:
            clauses.append("q.status = %s")
            params.append(status_filter)
        if channel_filter:
            clauses.append("COALESCE(ch.channel_name, s.channel_name, sv.channel_id) ILIKE %s")
            params.append(f"%{channel_filter}%")
        if source_filter:
            clauses.append("s.transcript_source = %s")
            params.append(source_filter)
        if keyword_filter:
            clauses.append("kw.keyword ILIKE %s")
            params.append(f"%{keyword_filter}%")
        if date_from:
            clauses.append("q.created_at >= %s::date")
            params.append(date_from)
        if date_to:
            clauses.append("q.created_at < (%s::date + interval '1 day')")
            params.append(date_to)

        where = " WHERE " + " AND ".join(clauses) if clauses else ""

        base_query = f"""
            FROM yt_video_queue q
            LEFT JOIN yt_seen_videos sv ON q.video_id = sv.video_id
            LEFT JOIN yt_channels ch ON sv.channel_id = ch.channel_id
            LEFT JOIN yt_keywords kw ON q.source_keyword_id = kw.id
            LEFT JOIN LATERAL (
                SELECT id, title, channel_name, transcript_source, summary_text,
                       telegram_sent, duration_secs, input_tokens, output_tokens,
                       output_length_percent
                FROM yt_summaries
                WHERE video_id = q.video_id
                ORDER BY created_at DESC LIMIT 1
            ) s ON TRUE
            {where}
        """

        # Get total count
        count_params = list(params)
        cursor.execute(f"SELECT COUNT(*) AS cnt {base_query}", tuple(count_params))
        total = cursor.fetchone()['cnt']

        # Get page of items
        page_params = list(params)
        page_params.extend([limit, offset])
        cursor.execute(f"""
            SELECT q.id, q.video_id, q.telegram_target, q.status, q.attempts,
                   q.error_log, q.created_at, q.processed_at,
                   CASE WHEN q.status = 'processing' AND q.updated_at IS NOT NULL
                        THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - q.updated_at))::int)
                        ELSE q.processing_secs END AS processing_secs,
                   COALESCE(sv.title, s.title, q.video_id) AS title,
                   COALESCE(ch.channel_name, s.channel_name, sv.channel_id) AS channel_name,
                   s.id AS summary_id, s.transcript_source, s.summary_text,
                   s.telegram_sent, s.duration_secs, s.input_tokens, s.output_tokens,
                   COALESCE(s.output_length_percent, q.output_length_percent) AS output_length_percent,
                   q.source_keyword_id,
                   kw.keyword AS source_keyword_name,
                   q.source_channel_id
            {base_query}
            ORDER BY q.created_at DESC
            LIMIT %s OFFSET %s
        """, tuple(page_params))

        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            for k in ('created_at', 'processed_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
        return {"items": rows, "total": total}

    # ── yt_summaries ─────────────────────────────────────────────

    def save_summary(self, video_id: str, title: str, channel_name: str,
                     published_at, transcript_source: str, summary_text: str,
                     telegram_target: str = None,
                     duration_secs: int = None, input_tokens: int = None, output_tokens: int = None,
                     prompt: str = None, transcript_text: str = None,
                     output_length_percent: int = None):
        prompt_hash = hashlib.md5(prompt.encode('utf-8')).hexdigest() if prompt else None
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_summaries
                (video_id, title, channel_name, published_at, transcript_source, summary_text,
                 telegram_target, duration_secs, input_tokens, output_tokens, prompt_hash,
                 transcript_text, output_length_percent)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (video_id, title, channel_name, published_at, transcript_source, summary_text,
              telegram_target, duration_secs, input_tokens, output_tokens, prompt_hash,
              transcript_text, output_length_percent))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def get_cached_transcript(self, video_id: str) -> str | None:
        """Return a cached transcript for a video, or None.

        Checks the dedicated yt_transcripts cache first, then falls back to the
        legacy transcript_text saved on transcript_api summaries (so transcripts
        captured before the dedicated cache existed still serve from the DB)."""
        cursor = self._get_cursor()
        cursor.execute("SELECT text FROM yt_transcripts WHERE video_id = %s", (video_id,))
        row = cursor.fetchone()
        if row:
            return row['text']
        cursor.execute("""
            SELECT transcript_text FROM yt_summaries
            WHERE video_id = %s AND transcript_text IS NOT NULL
            ORDER BY created_at DESC LIMIT 1
        """, (video_id,))
        row = cursor.fetchone()
        return row['transcript_text'] if row else None

    def cache_transcript(self, video_id: str, text: str):
        """Upsert a fetched transcript into the dedicated cache so subsequent
        retrievals serve from the DB instead of re-hitting YouTube."""
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_transcripts (video_id, text)
            VALUES (%s, %s)
            ON CONFLICT (video_id) DO UPDATE
                SET text = EXCLUDED.text, fetched_at = NOW()
        """, (video_id, text))
        self.connection.commit()

    def mark_telegram_sent(self, summary_id: int):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_summaries SET telegram_sent = TRUE WHERE id = %s", (summary_id,))
        self.connection.commit()

    def get_summaries(self, limit: int = 100, channel_name: str = None,
                      transcript_source: str = None, telegram_sent: str = None,
                      date_from: str = None, date_to: str = None,
                      yt_ch_ids=None, kw_ids=None, user_id=None):
        cursor = self._get_cursor()
        clauses = []
        params = []

        # User-scope filter via video_id → queue source
        if yt_ch_ids is not None or kw_ids is not None:
            ch_f = yt_ch_ids or ['__none__']
            kw_f = kw_ids or [-1]
            uid_f = user_id if user_id is not None else -1
            clauses.append("""
                video_id IN (
                    SELECT video_id FROM yt_video_queue
                    WHERE source_channel_id = ANY(%s) OR source_keyword_id = ANY(%s)
                       OR added_by_user_id = %s
                )
            """)
            params.extend([ch_f, kw_f, uid_f])

        if channel_name:
            clauses.append("channel_name ILIKE %s")
            params.append(f"%{channel_name}%")
        if transcript_source:
            clauses.append("transcript_source = %s")
            params.append(transcript_source)
        if telegram_sent is not None and telegram_sent != '':
            clauses.append("telegram_sent = %s")
            params.append(telegram_sent == 'true')
        if date_from:
            clauses.append("created_at >= %s")
            params.append(date_from)
        if date_to:
            clauses.append("created_at <= %s")
            params.append(date_to)

        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        params.append(limit)

        cursor.execute(f"""
            SELECT * FROM yt_summaries {where}
            ORDER BY created_at DESC LIMIT %s
        """, tuple(params))

        rows = [dict(r) for r in cursor.fetchall()]
        for r in rows:
            for k in ('published_at', 'created_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
        return rows

    def get_summary_by_id(self, summary_id: int):
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM yt_summaries WHERE id = %s", (summary_id,))
        row = cursor.fetchone()
        if row:
            d = dict(row)
            for k in ('published_at', 'created_at'):
                if d.get(k):
                    d[k] = d[k].isoformat()
            return d
        return None

    def delete_queue_item(self, queue_id: int):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_video_queue WHERE id = %s", (queue_id,))
        self.connection.commit()

    def get_queue_item_by_id(self, queue_id: int):
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT q.*, sv.title AS video_title,
                   COALESCE(ch.channel_name, sm.channel_name, sv.channel_id) AS video_channel_name
            FROM yt_video_queue q
            LEFT JOIN yt_seen_videos sv ON q.video_id = sv.video_id
            LEFT JOIN yt_channels ch ON sv.channel_id = ch.channel_id
            LEFT JOIN LATERAL (
                SELECT channel_name FROM yt_summaries
                WHERE video_id = q.video_id AND channel_name IS NOT NULL
                LIMIT 1
            ) sm ON TRUE
            WHERE q.id = %s
        """, (queue_id,))
        row = cursor.fetchone()
        if row:
            d = dict(row)
            for k in ('created_at', 'processed_at'):
                if d.get(k):
                    d[k] = d[k].isoformat()
            return d
        return None

    def clear_queue(self):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_video_queue")
        deleted = cursor.rowcount
        self.connection.commit()
        return deleted

    def delete_queue_items_by_status(self, status: str) -> int:
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_video_queue WHERE status = %s", (status,))
        deleted = cursor.rowcount
        self.connection.commit()
        return deleted

    def delete_summary(self, summary_id: int):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_summaries WHERE id = %s", (summary_id,))
        self.connection.commit()

    def clear_summaries(self):
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM yt_summaries")
        deleted = cursor.rowcount
        self.connection.commit()
        return deleted

    # ── Cleanup ──────────────────────────────────────────────────

    def cleanup_old_queue(self, days: int = 30):
        cursor = self._get_cursor()
        cursor.execute("""
            DELETE FROM yt_video_queue
            WHERE status = 'failed' AND processed_at < NOW() - INTERVAL '%s days'
        """, (days,))
        deleted = cursor.rowcount
        cursor.execute("""
            DELETE FROM yt_video_queue
            WHERE status = 'done' AND processed_at < NOW() - INTERVAL '%s days'
        """, (days * 2,))
        deleted += cursor.rowcount
        self.connection.commit()
        return deleted

    def close(self):
        if self.connection:
            self.connection.close()
