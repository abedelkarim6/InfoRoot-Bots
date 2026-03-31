"""
Database operations for the YouTube Monitor feature.
All new tables — does not touch existing tables.
"""

import logging
import json
from datetime import datetime

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

# Module-level singleton (set by app.py at startup)
_yt_db = None


def set_yt_db(db):
    global _yt_db
    _yt_db = db


def get_yt_db():
    return _yt_db


class YouTubeDB:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.connection = None
        self._connect()
        self._create_tables()

    def _connect(self):
        self.connection = psycopg2.connect(self.dsn)
        self.connection.autocommit = False

    def _get_cursor(self):
        try:
            self.connection.isolation_level
        except Exception:
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

        # ── Safe column migrations ──────────────────────────────────
        def _ensure_col(table, col, col_type, default=None):
            cursor.execute("""
                SELECT 1 FROM information_schema.columns
                WHERE table_name = %s AND column_name = %s
            """, (table, col))
            if not cursor.fetchone():
                defstr = f" DEFAULT {default}" if default is not None else ""
                cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}{defstr}")

        _ensure_col('yt_channels', 'telegram_target', 'TEXT')
        _ensure_col('yt_channels', 'prompt', 'TEXT')
        _ensure_col('yt_channels', 'telegram_targets', "JSONB", "'[]'")
        _ensure_col('yt_keywords', 'telegram_target', 'TEXT')
        _ensure_col('yt_keywords', 'prompt', 'TEXT')
        _ensure_col('yt_keywords', 'telegram_targets', "JSONB", "'[]'")
        _ensure_col('yt_keywords', 'schedule_interval_minutes', 'INTEGER')
        _ensure_col('yt_keywords', 'last_run_at', 'TIMESTAMP')
        _ensure_col('yt_keywords', 'sub_keywords', 'JSONB', "'[]'")
        _ensure_col('yt_video_queue', 'telegram_target', 'TEXT')
        _ensure_col('yt_video_queue', 'prompt', 'TEXT')
        _ensure_col('yt_summaries', 'telegram_target', 'TEXT')
        _ensure_col('yt_summaries', 'duration_secs',  'INTEGER')
        _ensure_col('yt_summaries', 'input_tokens',   'INTEGER')
        _ensure_col('yt_summaries', 'output_tokens',  'INTEGER')
        _ensure_col('yt_video_queue', 'source_channel_id', 'TEXT')
        _ensure_col('yt_video_queue', 'source_keyword_id', 'INTEGER')

        # Channel-level video filters (mirror of keyword filters)
        _ensure_col('yt_channels', 'min_duration_seconds', 'INTEGER')
        _ensure_col('yt_channels', 'max_duration_seconds', 'INTEGER')
        _ensure_col('yt_channels', 'title_must_include', 'JSONB', "'[]'")
        _ensure_col('yt_channels', 'title_must_exclude', 'JSONB', "'[]'")
        _ensure_col('yt_channels', 'min_view_count', 'INTEGER', '0')
        _ensure_col('yt_channels', 'language', 'TEXT')
        _ensure_col('yt_channels', 'upload_type', 'TEXT')

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
            INSERT INTO yt_channels (channel_id, channel_name, telegram_targets, prompt,
                min_duration_seconds, max_duration_seconds,
                title_must_include, title_must_exclude,
                min_view_count, language, upload_type)
            VALUES (%s, %s, %s::jsonb, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
            ON CONFLICT (channel_id) DO UPDATE SET
                channel_name = COALESCE(EXCLUDED.channel_name, yt_channels.channel_name),
                telegram_targets = EXCLUDED.telegram_targets,
                prompt = COALESCE(EXCLUDED.prompt, yt_channels.prompt),
                min_duration_seconds = EXCLUDED.min_duration_seconds,
                max_duration_seconds = EXCLUDED.max_duration_seconds,
                title_must_include = EXCLUDED.title_must_include,
                title_must_exclude = EXCLUDED.title_must_exclude,
                min_view_count = EXCLUDED.min_view_count,
                language = EXCLUDED.language,
                upload_type = EXCLUDED.upload_type
            RETURNING id
        """, (channel_id, data.get('channel_name'), targets_json, data.get('prompt'),
              data.get('min_duration_seconds'), data.get('max_duration_seconds'),
              title_inc, title_exc,
              data.get('min_view_count', 0), data.get('language'), data.get('upload_type')))
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
            SET channel_name = %s, telegram_targets = %s::jsonb, prompt = %s,
                min_duration_seconds = %s, max_duration_seconds = %s,
                title_must_include = %s::jsonb, title_must_exclude = %s::jsonb,
                min_view_count = %s, language = %s, upload_type = %s
            WHERE channel_id = %s
        """, (data.get('channel_name'), targets_json, data.get('prompt'),
              data.get('min_duration_seconds'), data.get('max_duration_seconds'),
              title_inc, title_exc,
              data.get('min_view_count', 0), data.get('language'), data.get('upload_type'),
              channel_id))
        self.connection.commit()

    def toggle_channel(self, channel_id: str, active: bool):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_channels SET active = %s WHERE channel_id = %s", (active, channel_id))
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
                keyword, telegram_targets, prompt,
                date_window_days, active,
                min_duration_seconds, max_duration_seconds,
                channel_allowlist, channel_blocklist,
                title_must_include, title_must_exclude,
                min_view_count, language, upload_type,
                schedule_interval_minutes, sub_keywords
            ) VALUES (%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            RETURNING id
        """, (
            data['keyword'],
            json.dumps(targets),
            data.get('prompt'),
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
            data.get('schedule_interval_minutes'),
            json.dumps(data.get('sub_keywords', [])),
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
                prompt = %s,
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
                sub_keywords = %s::jsonb
            WHERE id = %s
        """, (
            data['keyword'],
            json.dumps(targets),
            data.get('prompt'),
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
            data.get('schedule_interval_minutes'),
            json.dumps(data.get('sub_keywords', [])),
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

    def is_video_already_queued_or_summarized(self, video_id: str) -> str | None:
        """Return a reason string if the video is already queued or summarized, else None."""
        cursor = self._get_cursor()
        # Check if already in the queue (pending or processing)
        cursor.execute("""
            SELECT id, status FROM yt_video_queue
            WHERE video_id = %s AND status IN ('pending', 'processing')
            LIMIT 1
        """, (video_id,))
        row = cursor.fetchone()
        if row:
            return f"already in queue ({row['status']})"
        # Check if already summarized
        cursor.execute("""
            SELECT id FROM yt_summaries WHERE video_id = %s LIMIT 1
        """, (video_id,))
        if cursor.fetchone():
            return "already summarized"
        return None

    def enqueue_video(self, video_id: str, telegram_target: str = None, prompt: str = None,
                      source_channel_id: str = None, source_keyword_id: int = None):
        reason = self.is_video_already_queued_or_summarized(video_id)
        if reason:
            logger.info(f"[YT-DB] Skipping enqueue for {video_id}: {reason}")
            return None
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_video_queue (video_id, telegram_target, prompt, source_channel_id, source_keyword_id)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
        """, (video_id, telegram_target, prompt, source_channel_id, source_keyword_id))
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

    def update_queue_status(self, queue_id: int, status: str, error_log: str = None):
        cursor = self._get_cursor()
        processed = datetime.utcnow() if status in ('done', 'failed') else None
        # Only increment attempts on done/failed, not on 'processing' transition
        if status in ('done', 'failed'):
            cursor.execute("""
                UPDATE yt_video_queue
                SET status = %s, error_log = %s, attempts = attempts + 1, processed_at = %s
                WHERE id = %s
            """, (status, error_log, processed, queue_id))
        else:
            cursor.execute("""
                UPDATE yt_video_queue
                SET status = %s, error_log = %s
                WHERE id = %s
            """, (status, error_log, queue_id))
        self.connection.commit()

    def retry_queue_item(self, queue_id: int):
        cursor = self._get_cursor()
        cursor.execute("""
            UPDATE yt_video_queue
            SET status = 'pending', error_log = NULL, attempts = 0
            WHERE id = %s
        """, (queue_id,))
        self.connection.commit()

    def get_queue_stats(self):
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT status, COUNT(*) AS cnt
            FROM yt_video_queue
            GROUP BY status
        """)
        stats = {r['status']: r['cnt'] for r in cursor.fetchall()}

        # Daily budget: summaries generated today, by source
        cursor.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE transcript_source = 'transcript_api') AS transcript,
                COUNT(*) FILTER (WHERE transcript_source = 'metadata') AS metadata
            FROM yt_summaries
            WHERE created_at >= CURRENT_DATE
        """)
        daily = dict(cursor.fetchone())

        # Daily queue activity
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
                'metadata': daily.get('metadata', 0),
                'processed': daily_queue.get('processed_today', 0),
                'failed': daily_queue.get('failed_today', 0),
                'queued': daily_queue.get('queued_today', 0),
            },
        }

    def get_system_overview(self):
        """Lightweight overview for the System page."""
        cursor = self._get_cursor()
        # Channels
        cursor.execute("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM yt_channels")
        ch = dict(cursor.fetchone())
        # Keywords
        cursor.execute("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM yt_keywords")
        kw = dict(cursor.fetchone())
        # Queue stats
        cursor.execute("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
                COUNT(*) FILTER (WHERE status = 'processing') AS processing,
                COUNT(*) FILTER (WHERE status = 'done')       AS done,
                COUNT(*) FILTER (WHERE status = 'failed')     AS failed
            FROM yt_video_queue
        """)
        q = dict(cursor.fetchone())
        # Total summaries
        cursor.execute("SELECT COUNT(*) AS total FROM yt_summaries")
        sm = dict(cursor.fetchone())
        # Today's activity
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

    def get_queue_items(self, limit: int = 100):
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
                           source_filter: str = None, date_from: str = None,
                           date_to: str = None):
        """Return queue items joined with their summaries in one unified view with pagination."""
        cursor = self._get_cursor()
        clauses = []
        params = []

        if status_filter:
            clauses.append("q.status = %s")
            params.append(status_filter)
        if channel_filter:
            clauses.append("COALESCE(ch.channel_name, s.channel_name, sv.channel_id) ILIKE %s")
            params.append(f"%{channel_filter}%")
        if source_filter:
            clauses.append("s.transcript_source = %s")
            params.append(source_filter)
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
            LEFT JOIN LATERAL (
                SELECT id, title, channel_name, transcript_source, summary_text, telegram_sent
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
                   COALESCE(sv.title, s.title, q.video_id) AS title,
                   COALESCE(ch.channel_name, s.channel_name, sv.channel_id) AS channel_name,
                   s.id AS summary_id, s.transcript_source, s.summary_text,
                   s.telegram_sent, s.duration_secs, s.input_tokens, s.output_tokens
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
                     duration_secs: int = None, input_tokens: int = None, output_tokens: int = None):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO yt_summaries
                (video_id, title, channel_name, published_at, transcript_source, summary_text,
                 telegram_target, duration_secs, input_tokens, output_tokens)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (video_id, title, channel_name, published_at, transcript_source, summary_text,
              telegram_target, duration_secs, input_tokens, output_tokens))
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def mark_telegram_sent(self, summary_id: int):
        cursor = self._get_cursor()
        cursor.execute("UPDATE yt_summaries SET telegram_sent = TRUE WHERE id = %s", (summary_id,))
        self.connection.commit()

    def get_summaries(self, limit: int = 100, channel_name: str = None,
                      transcript_source: str = None, telegram_sent: str = None,
                      date_from: str = None, date_to: str = None):
        cursor = self._get_cursor()
        clauses = []
        params = []

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
