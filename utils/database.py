"""
Database operations for storing messages and tracking summaries.
Uses PostgreSQL via psycopg2.
"""

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

        # Rollback any failed transaction
        try:
            if self.connection.get_transaction_status() != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
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

    def get_recent_messages(self, limit: int = 200):
        """Returns the most recent messages with categorization info (collection_name required)."""
        cursor = self._get_cursor()
        cursor.execute(
            """SELECT id, channel_id, channel_username, collection_name, bot_name,
                      topics, categories, keywords_found, timestamp, text
               FROM messages
               WHERE collection_name IS NOT NULL AND collection_name != ''
               ORDER BY timestamp DESC
               LIMIT %s""",
            (limit,)
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
