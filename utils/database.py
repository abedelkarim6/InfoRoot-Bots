"""
Database operations for storing messages and tracking summaries.
Uses PostgreSQL via psycopg2.
"""

import json
import logging
import re
from typing import List

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)


class Database:
    def __init__(self, dsn: str):
        """
        dsn: PostgreSQL connection string, e.g.:
             "postgresql://user:password@localhost:5432/botdb"
        """
        self.dsn = dsn
        self.connection = None
        self._connect()
        self._create_tables()

    def _connect(self):
        self.connection = psycopg2.connect(self.dsn)
        self.connection.autocommit = False

    def _get_cursor(self):
        # Reconnect if connection was lost or in failed transaction state
        try:
            self.connection.isolation_level  # ping
        except Exception:
            self._connect()

        # Rollback only failed (errored) transactions, not active ones
        try:
            status = self.connection.get_transaction_status()
            if status == psycopg2.extensions.TRANSACTION_STATUS_INERROR:
                self.connection.rollback()
        except Exception:
            pass

        return self.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def _create_tables(self):
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
                PRIMARY KEY (message_id, bot_name, topic_name, schedule_type)
            )
        """)

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

        self.connection.commit()

    def add_message(self, channel_id, text, countries=None, regions=None,
                    keywords=None, bot_name=None, original_text=None, replaced_text=None,
                    topics=None, categories=None, channel_username=None, collection_name=None):
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
        self.connection.commit()
        return row['id']

    def get_messages_for_schedule(self, schedule_type: str, bot_name: str, topic_name: str):
        """Get messages not yet summarized for this specific (bot, topic, schedule_type) combo."""
        cursor = self._get_cursor()
        cursor.execute(
            """SELECT m.* FROM messages m
               WHERE m.bot_name = %s
                 AND NOT EXISTS (
                     SELECT 1 FROM message_summarizations ms
                     WHERE ms.message_id = m.id
                       AND ms.bot_name = %s
                       AND ms.topic_name = %s
                       AND ms.schedule_type = %s
                 )""",
            (bot_name, bot_name, topic_name, schedule_type)
        )
        return [dict(row) for row in cursor.fetchall()]

    def mark_as_summarized(self, message_ids: List[int], schedule_type: str,
                           bot_name: str, topic_name: str):
        """Mark messages as summarized for a specific (bot, topic, schedule_type)."""
        if not message_ids:
            return

        cursor = self._get_cursor()
        for mid in message_ids:
            cursor.execute(
                """INSERT INTO message_summarizations (message_id, bot_name, topic_name, schedule_type)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT DO NOTHING""",
                (mid, bot_name, topic_name, schedule_type)
            )
        self.connection.commit()

    def save_summary(self, summary_text: str, message_count: int,
                     summary_type: str, target_entity: str,
                     bot_name: str = None, topic_name: str = None,
                     message_ids: list = None) -> int:
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
        self.connection.commit()
        return row['id']

    def get_pending_counts(self):
        """Returns pending message counts per bot per topic for each schedule type."""
        cursor = self._get_cursor()
        # Get all messages with their topics, then check what's NOT yet summarized
        cursor.execute("""
            SELECT m.id, m.bot_name, m.topics
            FROM messages m
            WHERE m.bot_name IS NOT NULL AND m.topics IS NOT NULL AND m.topics != ''
        """)
        rows = cursor.fetchall()

        # Get all existing summarizations
        cursor.execute("SELECT message_id, bot_name, topic_name, schedule_type FROM message_summarizations")
        done = set()
        for r in cursor.fetchall():
            done.add((r['message_id'], r['bot_name'], r['topic_name'], r['schedule_type']))

        counts = {}  # bot_name -> topic -> {hourly, daily, minute}
        for row in rows:
            bn = row['bot_name'] or 'unknown'
            topics_str = row['topics'] or ''
            topics = [t.strip() for t in topics_str.split(',') if t.strip()]

            if bn not in counts:
                counts[bn] = {}

            for topic in topics:
                if topic not in counts[bn]:
                    counts[bn][topic] = {'hourly': 0, 'daily': 0, 'minute': 0}
                for stype in ('hourly', 'daily', 'minute'):
                    if (row['id'], bn, topic, stype) not in done:
                        counts[bn][topic][stype] += 1

        return counts

    def get_recent_summaries(self, limit: int = 100):
        """Returns recent summaries ordered newest first."""
        cursor = self._get_cursor()
        cursor.execute(
            """SELECT id, bot_name, topic_name, summary_type, target_entity,
                      message_count, timestamp, summary_text, message_ids
               FROM summaries
               ORDER BY timestamp DESC
               LIMIT %s""",
            (limit,)
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

    def get_messages_by_ids(self, message_ids: list):
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

    def cleanup_uncollected_messages(self):
        """Delete messages that have no collection_name (old rows pre-dating the column)."""
        cursor = self._get_cursor()
        cursor.execute(
            "DELETE FROM messages WHERE collection_name IS NULL OR collection_name = ''"
        )
        self.connection.commit()

    def get_recent_messages(self, limit: int = 200, offset: int = 0):
        """Returns the most recent messages with categorization info (collection_name required)."""
        cursor = self._get_cursor()
        cursor.execute(
            """SELECT id, channel_id, channel_username, collection_name, bot_name,
                      topics, categories, keywords_found, timestamp, text
               FROM messages
               WHERE collection_name IS NOT NULL AND collection_name != ''
               ORDER BY timestamp DESC
               LIMIT %s OFFSET %s""",
            (limit, offset)
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

    def get_unclassified_messages(self, limit: int = 500, offset: int = 0,
                                   bot_name: str = None,
                                   collection: str = None, search: str = None):
        """Returns messages that were not classified into any topic."""
        cursor = self._get_cursor()
        clauses = ["collection_name IS NOT NULL AND collection_name != ''",
                   "(topics IS NULL OR topics = '')"]
        params = []
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

    def get_unclassified_stats(self):
        """Return counts for unclassified messages grouped by bot and collection."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT bot_name, collection_name, COUNT(*) AS cnt
            FROM messages
            WHERE collection_name IS NOT NULL AND collection_name != ''
              AND (topics IS NULL OR topics = '')
            GROUP BY bot_name, collection_name
            ORDER BY cnt DESC
        """)
        return [dict(r) for r in cursor.fetchall()]

    def get_dashboard_stats(self, days: int = 14, filter_source: str = None, filter_topic: str = None) -> dict:
        """Return comprehensive analytics for the dashboard page."""
        days = max(1, min(365, int(days)))
        cursor = self._get_cursor()

        iv = "(%s * INTERVAL '1 day')"

        # Build optional filter clauses
        src_clause   = " AND channel_username = %s" if filter_source else ""
        topic_clause = " AND TRIM(t.topic) = %s"    if filter_topic  else ""

        def p(*base):
            """Append filter params to a base param tuple."""
            extra = []
            if filter_source: extra.append(filter_source)
            if filter_topic:  extra.append(filter_topic)
            return tuple(base) + tuple(extra)

        # Helper for queries that join on the topics lateral (need topic filter inline)
        def p_topic(*base):
            extra = []
            if filter_source: extra.append(filter_source)
            if filter_topic:  extra.append(filter_topic)
            return tuple(base) + tuple(extra)

        # --- Dropdown population: always return full unfiltered lists ---
        cursor.execute(f"""
            SELECT DISTINCT channel_username AS source FROM messages
            WHERE channel_username IS NOT NULL AND channel_username != ''
              AND timestamp >= NOW() - {iv}
            ORDER BY source LIMIT 200
        """, (days,))
        all_sources = [r['source'] for r in cursor.fetchall()]

        cursor.execute(f"""
            SELECT DISTINCT TRIM(t.topic) AS topic
            FROM messages,
                 LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
            WHERE topics IS NOT NULL AND topics != ''
              AND TRIM(t.topic) != ''
              AND timestamp >= NOW() - {iv}
            ORDER BY topic LIMIT 200
        """, (days,))
        all_topics = [r['topic'] for r in cursor.fetchall()]

        # 1. Totals
        cursor.execute("SELECT COUNT(*) AS cnt FROM messages")
        total_messages = cursor.fetchone()['cnt']

        cursor.execute(f"SELECT COUNT(*) AS cnt FROM messages WHERE timestamp >= NOW() - {iv}{src_clause}",
                       p(days))
        period_messages = cursor.fetchone()['cnt']

        cursor.execute("SELECT COUNT(*) AS cnt FROM summaries")
        total_summaries = cursor.fetchone()['cnt']

        cursor.execute(f"""
            SELECT COUNT(DISTINCT channel_username) AS cnt FROM messages
            WHERE channel_username IS NOT NULL AND channel_username != ''
              AND timestamp >= NOW() - {iv}{src_clause}
        """, p(days))
        active_sources = cursor.fetchone()['cnt']

        # 2. Messages per day
        if filter_topic:
            cursor.execute(f"""
                SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE topics IS NOT NULL AND topics != ''
                  AND timestamp >= NOW() - {iv}{src_clause}{topic_clause}
                GROUP BY day ORDER BY day
            """, p_topic(days))
        else:
            cursor.execute(f"""
                SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
                FROM messages WHERE timestamp >= NOW() - {iv}{src_clause}
                GROUP BY day ORDER BY day
            """, p(days))
        messages_per_day = [{'day': str(r['day']), 'count': r['cnt']} for r in cursor.fetchall()]

        # 3. Messages per topic — top 20
        cursor.execute(f"""
            SELECT TRIM(t.topic) AS topic, COUNT(*) AS cnt
            FROM messages,
                 LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
            WHERE topics IS NOT NULL AND topics != ''
              AND TRIM(t.topic) != '' AND timestamp >= NOW() - {iv}{src_clause}{topic_clause}
            GROUP BY topic ORDER BY cnt DESC LIMIT 20
        """, p_topic(days))
        messages_per_topic = [{'topic': r['topic'], 'count': r['cnt']} for r in cursor.fetchall()]

        # 4. Topic trend — top 6 only
        top6 = [r['topic'] for r in messages_per_topic[:6]]
        if top6:
            cursor.execute(f"""
                SELECT DATE(timestamp) AS day, TRIM(t.topic) AS topic, COUNT(*) AS cnt
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE topics IS NOT NULL AND topics != ''
                  AND TRIM(t.topic) = ANY(%s) AND timestamp >= NOW() - {iv}{src_clause}
                GROUP BY day, topic ORDER BY day, topic
            """, (top6, days) + ((filter_source,) if filter_source else ()))
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
                  AND timestamp >= NOW() - {iv}{src_clause}{topic_clause}
                GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
            """, p_topic(days))
        else:
            cursor.execute(f"""
                SELECT channel_username AS source, COUNT(*) AS cnt
                FROM messages
                WHERE channel_username IS NOT NULL AND channel_username != ''
                  AND timestamp >= NOW() - {iv}{src_clause}
                GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
            """, p(days))
        messages_per_source = [{'source': r['source'], 'count': r['cnt']} for r in cursor.fetchall()]

        # 6. Source × topic matrix
        top_sources = [r['source'] for r in messages_per_source[:15]]
        top_topics  = [r['topic']  for r in messages_per_topic[:10]]
        if top_sources and top_topics:
            cursor.execute(f"""
                SELECT channel_username AS source, TRIM(t.topic) AS topic, COUNT(*) AS cnt
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE channel_username IS NOT NULL AND channel_username != ''
                  AND topics IS NOT NULL AND topics != ''
                  AND channel_username = ANY(%s) AND TRIM(t.topic) = ANY(%s)
                  AND timestamp >= NOW() - {iv}
                GROUP BY source, topic ORDER BY source, cnt DESC
            """, (top_sources, top_topics, days))
            source_topic = [{'source': r['source'], 'topic': r['topic'], 'count': r['cnt']}
                            for r in cursor.fetchall()]
        else:
            source_topic = []

        # 7. Summaries per type in period
        cursor.execute(f"""
            SELECT summary_type, COUNT(*) AS cnt FROM summaries
            WHERE timestamp >= NOW() - {iv}
            GROUP BY summary_type ORDER BY cnt DESC
        """, (days,))
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

    def save_userbot_dialogs(self, channels: list):
        """Cache the list of channels/groups the userbot is subscribed to."""
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM userbot_dialogs")
        for ch in channels:
            cursor.execute("""
                INSERT INTO userbot_dialogs (id, title, username, is_broadcast, is_megagroup, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
            """, (ch['id'], ch['title'], ch.get('username'),
                  ch.get('is_broadcast', False), ch.get('is_megagroup', False)))
        self.connection.commit()

    def get_userbot_dialogs(self) -> dict:
        """Return cached dialogs + when they were last saved."""
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM userbot_dialogs ORDER BY title")
        channels = [dict(row) for row in cursor.fetchall()]
        cursor.execute("SELECT MAX(updated_at) AS ts FROM userbot_dialogs")
        row = cursor.fetchone()
        updated_at = row['ts'].isoformat() if row and row['ts'] else None
        return {'channels': channels, 'updated_at': updated_at}

    def close(self):
        if self.connection:
            self.connection.close()

    def get_stats(self):
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

    # ==================== Keyword Management ====================

    def seed_keywords_from_config(self, config):
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
                    for kw in topic_data.get('keywords', []):
                        kw = str(kw).strip()
                        if not kw:
                            continue
                        cursor.execute("""
                            INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                            VALUES (%s, %s, %s, %s)
                            ON CONFLICT DO NOTHING
                        """, (bot_name, category_name, topic_name, kw))
                        inserted += 1
        self.connection.commit()
        logger.info(f"[KEYWORDS] Seeded {inserted} keywords from config into DB")

    def migrate_config_to_db(self, config):
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

        self.connection.commit()
        logger.info(f"[MIGRATE] Migrated {migrated_bots} bots, {migrated_cats} categories, "
                   f"{migrated_topics} topics, {migrated_scheds} schedules, {migrated_colls} collections")


    def get_topic_keywords(self, bot_name: str, category_name: str, topic_name: str) -> list:
        """Return the keyword list for a specific topic."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT keyword FROM topic_keywords
            WHERE bot_name = %s AND category_name = %s AND topic_name = %s
            ORDER BY id
        """, (bot_name, category_name, topic_name))
        return [row['keyword'] for row in cursor.fetchall()]

    def set_topic_keywords(self, bot_name: str, category_name: str, topic_name: str, keywords: list):
        """Replace all keywords for a topic with the given list."""
        cursor = self._get_cursor()
        cursor.execute("""
            DELETE FROM topic_keywords
            WHERE bot_name = %s AND category_name = %s AND topic_name = %s
        """, (bot_name, category_name, topic_name))
        for kw in keywords:
            kw = str(kw).strip()
            if kw:
                cursor.execute("""
                    INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (bot_name, category_name, topic_name, kw))
        self.connection.commit()

    def add_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> bool:
        """Add a single keyword. Returns True if inserted, False if already existed."""
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (bot_name, category_name, topic_name, keyword.strip()))
        inserted = cursor.rowcount
        self.connection.commit()
        return inserted > 0

    def delete_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> bool:
        """Remove a single keyword. Returns True if deleted."""
        cursor = self._get_cursor()
        cursor.execute("""
            DELETE FROM topic_keywords
            WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND keyword = %s
        """, (bot_name, category_name, topic_name, keyword.strip()))
        deleted = cursor.rowcount
        self.connection.commit()
        return deleted > 0


    # ==================== Config DAL (replaces config.yaml) ====================

    def _bump_config_version(self, cursor=None):
        """Increment the config version counter so watchers detect changes."""
        if cursor is None:
            cursor = self.connection.cursor()
        cursor.execute("""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('config_version', '1', NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = (COALESCE(system_settings.value::text::int, 0) + 1)::text::jsonb,
                updated_at = NOW()
        """)

    def get_config_version(self) -> int:
        cursor = self._get_cursor()
        cursor.execute("SELECT value FROM system_settings WHERE key = 'config_version'")
        row = cursor.fetchone()
        return int(row['value']) if row else 0

    # --- System settings ---
    def get_system_enabled(self) -> bool:
        cursor = self._get_cursor()
        cursor.execute("SELECT value FROM system_settings WHERE key = 'system_enabled'")
        row = cursor.fetchone()
        return bool(row['value']) if row else True

    def set_system_enabled(self, enabled: bool):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('system_enabled', %s, NOW())
            ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = NOW()
        """, (json.dumps(enabled), json.dumps(enabled)))
        self._bump_config_version()
        self.connection.commit()

    def get_global_rules(self) -> dict:
        cursor = self._get_cursor()
        cursor.execute("SELECT value FROM system_settings WHERE key = 'global_rules'")
        row = cursor.fetchone()
        return row['value'] if row else {"remove": [], "replace": []}

    def set_global_rules(self, rules: dict):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('global_rules', %s, NOW())
            ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = NOW()
        """, (json.dumps(rules), json.dumps(rules)))
        self._bump_config_version()
        self.connection.commit()

    # --- Collections ---
    def get_all_collections(self) -> dict:
        cursor = self._get_cursor()
        cursor.execute("SELECT * FROM collections ORDER BY id")
        result = {}
        for row in cursor.fetchall():
            result[row['name']] = {
                'name': row['display_name'] or row['name'],
                'source_channels': row['source_channels'] or [],
                'target_channels': row['target_channels'] or [],
                'enabled': row['enabled'],
            }
        return result

    def save_collection(self, name: str, data: dict):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO collections (name, display_name, source_channels, target_channels, enabled)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (name) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                source_channels = EXCLUDED.source_channels,
                target_channels = EXCLUDED.target_channels,
                enabled = EXCLUDED.enabled
        """, (
            name,
            data.get('name', name),
            json.dumps(data.get('source_channels', [])),
            json.dumps(data.get('target_channels', [])),
            data.get('enabled', True),
        ))
        self._bump_config_version()
        self.connection.commit()

    def delete_collection(self, name: str) -> bool:
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM collections WHERE name = %s", (name,))
        deleted = cursor.rowcount > 0
        if deleted:
            self._bump_config_version()
        self.connection.commit()
        return deleted

    def toggle_collection(self, name: str, enabled: bool) -> bool:
        cursor = self._get_cursor()
        cursor.execute("UPDATE collections SET enabled = %s WHERE name = %s", (enabled, name))
        updated = cursor.rowcount > 0
        if updated:
            self._bump_config_version()
        self.connection.commit()
        return updated

    # --- Bots ---
    def get_all_bots_config(self) -> dict:
        """Return the full nested bots config (bots > categories > topics > schedules + keywords)."""
        cursor = self._get_cursor()

        cursor.execute("SELECT * FROM bots ORDER BY id")
        bots_rows = cursor.fetchall()

        cursor.execute("""
            SELECT c.*, b.name AS bot_name FROM categories c
            JOIN bots b ON b.id = c.bot_id ORDER BY c.id
        """)
        cats_rows = cursor.fetchall()

        cursor.execute("""
            SELECT t.*, c.name AS category_name, b.name AS bot_name
            FROM topics t
            JOIN categories c ON c.id = t.category_id
            JOIN bots b ON b.id = c.bot_id
            ORDER BY t.id
        """)
        topics_rows = cursor.fetchall()

        cursor.execute("""
            SELECT s.*, t.name AS topic_name, c.name AS category_name, b.name AS bot_name
            FROM schedules s
            JOIN topics t ON t.id = s.topic_id
            JOIN categories c ON c.id = t.category_id
            JOIN bots b ON b.id = c.bot_id
            ORDER BY s.id
        """)
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
                    'telegram_targets': s.get('telegram_targets') or [],
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

    def get_full_config(self) -> dict:
        """Return the full config dict matching the old /api/config shape."""
        return {
            'system': {'enabled': self.get_system_enabled()},
            'bots': self.get_all_bots_config(),
            'collections': self.get_all_collections(),
        }

    def save_bot(self, name: str, data: dict):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO bots (name, enabled, minimum_messages, collection_names, rules, default_schedules)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (name) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                minimum_messages = EXCLUDED.minimum_messages,
                collection_names = EXCLUDED.collection_names,
                rules = EXCLUDED.rules,
                default_schedules = EXCLUDED.default_schedules
        """, (
            name,
            data.get('enabled', True),
            data.get('minimum_messages', 5),
            json.dumps(data.get('collections', [])),
            json.dumps(data.get('rules', {'remove': [], 'replace': []})),
            json.dumps(data.get('default_schedules', [])),
        ))
        self._bump_config_version()
        self.connection.commit()

    def delete_bot(self, name: str) -> bool:
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM bots WHERE name = %s", (name,))
        deleted = cursor.rowcount > 0
        if deleted:
            self._bump_config_version()
        self.connection.commit()
        return deleted

    def rename_bot(self, old_name: str, new_name: str) -> bool:
        cursor = self._get_cursor()
        cursor.execute("UPDATE bots SET name = %s WHERE name = %s", (new_name, old_name))
        updated = cursor.rowcount > 0
        if updated:
            self._bump_config_version()
        self.connection.commit()
        return updated

    def _get_bot_id(self, bot_name: str):
        cursor = self._get_cursor()
        cursor.execute("SELECT id FROM bots WHERE name = %s", (bot_name,))
        row = cursor.fetchone()
        return row['id'] if row else None

    # --- Categories ---
    def add_category(self, bot_name: str, category_name: str) -> bool:
        bot_id = self._get_bot_id(bot_name)
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
        self.connection.commit()
        return inserted

    def delete_category(self, bot_name: str, category_name: str) -> bool:
        bot_id = self._get_bot_id(bot_name)
        if not bot_id:
            return False
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM categories WHERE bot_id = %s AND name = %s", (bot_id, category_name))
        deleted = cursor.rowcount > 0
        if deleted:
            self._bump_config_version()
        self.connection.commit()
        return deleted

    def toggle_category(self, bot_name: str, category_name: str, enabled: bool) -> bool:
        bot_id = self._get_bot_id(bot_name)
        if not bot_id:
            return False
        cursor = self._get_cursor()
        cursor.execute("UPDATE categories SET enabled = %s WHERE bot_id = %s AND name = %s",
                       (enabled, bot_id, category_name))
        updated = cursor.rowcount > 0
        if updated:
            self._bump_config_version()
        self.connection.commit()
        return updated

    def _get_category_id(self, bot_name: str, category_name: str):
        bot_id = self._get_bot_id(bot_name)
        if not bot_id:
            return None
        cursor = self._get_cursor()
        cursor.execute("SELECT id FROM categories WHERE bot_id = %s AND name = %s", (bot_id, category_name))
        row = cursor.fetchone()
        return row['id'] if row else None

    # --- Topics ---
    def add_topic(self, bot_name: str, category_name: str, topic_name: str) -> bool:
        cat_id = self._get_category_id(bot_name, category_name)
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
                        json.dumps(ds.get('telegram_targets', [])),
                    ))
            self._bump_config_version()
        self.connection.commit()
        return inserted

    def delete_topic(self, bot_name: str, category_name: str, topic_name: str) -> bool:
        cat_id = self._get_category_id(bot_name, category_name)
        if not cat_id:
            return False
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM topics WHERE category_id = %s AND name = %s", (cat_id, topic_name))
        deleted = cursor.rowcount > 0
        if deleted:
            self._bump_config_version()
        self.connection.commit()
        return deleted

    def toggle_topic(self, bot_name: str, category_name: str, topic_name: str, enabled: bool) -> bool:
        cat_id = self._get_category_id(bot_name, category_name)
        if not cat_id:
            return False
        cursor = self._get_cursor()
        cursor.execute("UPDATE topics SET enabled = %s WHERE category_id = %s AND name = %s",
                       (enabled, cat_id, topic_name))
        updated = cursor.rowcount > 0
        if updated:
            self._bump_config_version()
        self.connection.commit()
        return updated

    def update_topic_linked(self, bot_name: str, category_name: str, topic_name: str, linked_topics: list):
        cat_id = self._get_category_id(bot_name, category_name)
        if not cat_id:
            return
        cursor = self._get_cursor()
        cursor.execute("UPDATE topics SET linked_topics = %s WHERE category_id = %s AND name = %s",
                       (json.dumps(linked_topics), cat_id, topic_name))
        self._bump_config_version()
        self.connection.commit()

    def _get_topic_id(self, bot_name: str, category_name: str, topic_name: str):
        cat_id = self._get_category_id(bot_name, category_name)
        if not cat_id:
            return None
        cursor = self._get_cursor()
        cursor.execute("SELECT id FROM topics WHERE category_id = %s AND name = %s", (cat_id, topic_name))
        row = cursor.fetchone()
        return row['id'] if row else None

    # --- Schedules ---
    def add_schedule(self, bot_name: str, category_name: str, topic_name: str, schedule: dict) -> int:
        topic_id = self._get_topic_id(bot_name, category_name, topic_name)
        if not topic_id:
            return None
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO schedules (topic_id, name, type, enabled, prompt_key, header, header_datetime,
                                   header_date_arabic, header_time_arabic,
                                   minute, hour, hours, minutes, start_hour, start_minute,
                                   telegram_targets)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            json.dumps(schedule.get('telegram_targets', [])),
        ))
        row = cursor.fetchone()
        self._bump_config_version()
        self.connection.commit()
        return row['id'] if row else None

    def update_schedule(self, schedule_id: int, schedule: dict) -> bool:
        allowed = {'name', 'type', 'enabled', 'prompt_key', 'header',
                   'header_datetime', 'header_date_arabic', 'header_time_arabic',
                   'minute', 'hour', 'hours', 'minutes',
                   'start_hour', 'start_minute', 'telegram_targets'}
        fields = {k: v for k, v in schedule.items() if k in allowed}
        if not fields:
            return False
        # JSON-serialize list/dict fields for JSONB columns
        for k in ('telegram_targets',):
            if k in fields and isinstance(fields[k], (list, dict)):
                fields[k] = json.dumps(fields[k])
        set_clause = ", ".join(f"{k} = %s" for k in fields)
        values = list(fields.values()) + [schedule_id]
        cursor = self._get_cursor()
        cursor.execute(f"UPDATE schedules SET {set_clause} WHERE id = %s", values)
        updated = cursor.rowcount > 0
        if updated:
            self._bump_config_version()
        self.connection.commit()
        return updated

    def delete_schedule(self, schedule_id: int) -> bool:
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM schedules WHERE id = %s", (schedule_id,))
        deleted = cursor.rowcount > 0
        if deleted:
            self._bump_config_version()
        self.connection.commit()
        return deleted

    # --- Prompts ---
    def get_all_prompts(self) -> dict:
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

    def get_bot_prompts(self, bot_name: str) -> dict:
        cursor = self._get_cursor()
        cursor.execute("SELECT key, text FROM prompts WHERE bot_name = %s ORDER BY id", (bot_name,))
        return {row['key']: {'text': row['text']} for row in cursor.fetchall()}

    def save_prompt(self, bot_name: str, key: str, text: str):
        cursor = self._get_cursor()
        cursor.execute("""
            INSERT INTO prompts (bot_name, key, text) VALUES (%s, %s, %s)
            ON CONFLICT (bot_name, key) DO UPDATE SET text = EXCLUDED.text
        """, (bot_name, key, text))
        self.connection.commit()

    def delete_prompt(self, bot_name: str, key: str) -> bool:
        cursor = self._get_cursor()
        cursor.execute("DELETE FROM prompts WHERE bot_name = %s AND key = %s", (bot_name, key))
        deleted = cursor.rowcount > 0
        self.connection.commit()
        return deleted

    def search_messages(self, topic_filter: str = None, source_filter: str = None,
                         days: int = 7, limit: int = 50):
        """Search messages by topic and/or source within a date range."""
        cursor = self._get_cursor()
        clauses = ["collection_name IS NOT NULL AND collection_name != ''"]
        params = []

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
