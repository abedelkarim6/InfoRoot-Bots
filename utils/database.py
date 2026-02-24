"""
Database operations for storing messages and tracking summaries.
Uses PostgreSQL via psycopg2.
"""

import logging
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

    def get_messages_for_schedule(self, schedule_type: str, bot_name: str = None):
        if schedule_type == "minute":
            column = "summarized_minute"
        elif schedule_type == "hourly":
            column = "summarized_hourly"
        else:  # daily or other
            column = "summarized_daily"

        cursor = self._get_cursor()
        if bot_name:
            cursor.execute(
                f"SELECT * FROM messages WHERE {column} = FALSE AND bot_name = %s",
                (bot_name,)
            )
        else:
            cursor.execute(f"SELECT * FROM messages WHERE {column} = FALSE")

        return [dict(row) for row in cursor.fetchall()]

    def mark_as_summarized(self, message_ids: List[int], schedule_type: str):
        if not message_ids:
            return

        if schedule_type == "minute":
            column = "summarized_minute"
        elif schedule_type == "hourly":
            column = "summarized_hourly"
        else:  # daily or other
            column = "summarized_daily"

        cursor = self._get_cursor()
        cursor.execute(
            f"UPDATE messages SET {column} = TRUE WHERE id = ANY(%s)",
            (message_ids,)
        )
        self.connection.commit()

    def save_summary(self, summary_text: str, message_count: int,
                     summary_type: str, target_entity: str,
                     bot_name: str = None, topic_name: str = None) -> int:
        """Save a generated summary and return its id."""
        cursor = self._get_cursor()
        cursor.execute(
            """INSERT INTO summaries
               (summary_text, message_count, summary_type, target_entity, bot_name, topic_name)
               VALUES (%s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (summary_text, message_count, summary_type, target_entity, bot_name, topic_name)
        )
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

    def get_pending_counts(self):
        """Returns pending message counts per bot per topic for each schedule type."""
        cursor = self._get_cursor()
        cursor.execute("""
            SELECT bot_name, topics, summarized_hourly, summarized_daily, summarized_minute
            FROM messages
            WHERE summarized_hourly = FALSE OR summarized_daily = FALSE OR summarized_minute = FALSE
        """)
        rows = cursor.fetchall()

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
                if not row['summarized_hourly']:
                    counts[bn][topic]['hourly'] += 1
                if not row['summarized_daily']:
                    counts[bn][topic]['daily'] += 1
                if not row['summarized_minute']:
                    counts[bn][topic]['minute'] += 1

        return counts

    def get_recent_summaries(self, limit: int = 100):
        """Returns recent summaries ordered newest first."""
        cursor = self._get_cursor()
        cursor.execute(
            """SELECT id, bot_name, topic_name, summary_type, target_entity,
                      message_count, timestamp,
                      LEFT(summary_text, 300) AS preview
               FROM summaries
               ORDER BY timestamp DESC
               LIMIT %s""",
            (limit,)
        )
        result = []
        for row in cursor.fetchall():
            d = dict(row)
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

    def get_recent_messages(self, limit: int = 200):
        """Returns the most recent messages with categorization info (collection_name required)."""
        cursor = self._get_cursor()
        cursor.execute(
            """SELECT id, channel_id, channel_username, collection_name, bot_name,
                      topics, categories, keywords_found, timestamp,
                      LEFT(text, 220) AS preview
               FROM messages
               WHERE collection_name IS NOT NULL AND collection_name != ''
               ORDER BY timestamp DESC
               LIMIT %s""",
            (limit,)
        )
        result = []
        for row in cursor.fetchall():
            d = dict(row)
            if d['timestamp']:
                d['timestamp'] = d['timestamp'].isoformat()
            result.append(d)
        return result

    def get_dashboard_stats(self, days: int = 14) -> dict:
        """Return comprehensive analytics for the dashboard page."""
        days = max(1, min(365, int(days)))
        cursor = self._get_cursor()

        iv = "(%s * INTERVAL '1 day')"

        # 1. Totals
        cursor.execute("SELECT COUNT(*) AS cnt FROM messages")
        total_messages = cursor.fetchone()['cnt']

        cursor.execute(f"SELECT COUNT(*) AS cnt FROM messages WHERE timestamp >= NOW() - {iv}", (days,))
        period_messages = cursor.fetchone()['cnt']

        cursor.execute("SELECT COUNT(*) AS cnt FROM summaries")
        total_summaries = cursor.fetchone()['cnt']

        cursor.execute(f"""
            SELECT COUNT(DISTINCT channel_username) AS cnt FROM messages
            WHERE channel_username IS NOT NULL AND channel_username != ''
              AND timestamp >= NOW() - {iv}
        """, (days,))
        active_sources = cursor.fetchone()['cnt']

        # 2. Messages per day
        cursor.execute(f"""
            SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
            FROM messages WHERE timestamp >= NOW() - {iv}
            GROUP BY day ORDER BY day
        """, (days,))
        messages_per_day = [{'day': str(r['day']), 'count': r['cnt']} for r in cursor.fetchall()]

        # 3. Messages per topic — top 20
        cursor.execute(f"""
            SELECT TRIM(t.topic) AS topic, COUNT(*) AS cnt
            FROM messages,
                 LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
            WHERE topics IS NOT NULL AND topics != ''
              AND TRIM(t.topic) != '' AND timestamp >= NOW() - {iv}
            GROUP BY topic ORDER BY cnt DESC LIMIT 20
        """, (days,))
        messages_per_topic = [{'topic': r['topic'], 'count': r['cnt']} for r in cursor.fetchall()]

        # 4. Topic trend — top 6 only
        top6 = [r['topic'] for r in messages_per_topic[:6]]
        if top6:
            cursor.execute(f"""
                SELECT DATE(timestamp) AS day, TRIM(t.topic) AS topic, COUNT(*) AS cnt
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE topics IS NOT NULL AND topics != ''
                  AND TRIM(t.topic) = ANY(%s) AND timestamp >= NOW() - {iv}
                GROUP BY day, topic ORDER BY day, topic
            """, (top6, days))
            topic_trend = [{'day': str(r['day']), 'topic': r['topic'], 'count': r['cnt']}
                           for r in cursor.fetchall()]
        else:
            topic_trend = []

        # 5. Top 20 sources by message count
        cursor.execute(f"""
            SELECT channel_username AS source, COUNT(*) AS cnt
            FROM messages
            WHERE channel_username IS NOT NULL AND channel_username != ''
              AND timestamp >= NOW() - {iv}
            GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
        """, (days,))
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
        }

    def close(self):
        if self.connection:
            self.connection.close()

    def get_stats(self):
        cursor = self._get_cursor()
        cursor.execute("SELECT COUNT(*) AS total FROM messages")
        total = cursor.fetchone()['total']
        cursor.execute(
            "SELECT COUNT(*) AS cnt FROM messages "
            "WHERE summarized_hourly = TRUE OR summarized_daily = TRUE"
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
