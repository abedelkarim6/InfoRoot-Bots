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

        cursor.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'summaries'
        """)
        cols2 = [r['column_name'] for r in cursor.fetchall()]
        if 'bot_name' not in cols2:
            cursor.execute('ALTER TABLE summaries ADD COLUMN bot_name TEXT')

        self.connection.commit()

    def add_message(self, channel_id, text, countries=None, regions=None,
                    keywords=None, bot_name=None, original_text=None, replaced_text=None,
                    topics=None, categories=None):
        countries_str = ",".join(countries) if countries else None
        regions_str = ",".join(regions) if regions else None
        keywords_str = ",".join(keywords) if keywords else None
        topics_str = ",".join(topics) if topics else None
        categories_str = ",".join(categories) if categories else None

        cursor = self._get_cursor()
        cursor.execute(
            """INSERT INTO messages
               (channel_id, text, countries, regions, topics, categories, keywords_found, bot_name, original_text, replaced_text)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (channel_id, text, countries_str, regions_str, topics_str, categories_str, keywords_str,
             bot_name, original_text, replaced_text)
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
                     summary_type: str, target_entity: str, bot_name: str = None) -> int:
        """Save a generated summary and return its id."""
        cursor = self._get_cursor()
        cursor.execute(
            """INSERT INTO summaries
               (summary_text, message_count, summary_type, target_entity, bot_name)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING id""",
            (summary_text, message_count, summary_type, target_entity, bot_name)
        )
        row = cursor.fetchone()
        self.connection.commit()
        return row['id']

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
