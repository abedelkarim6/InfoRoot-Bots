"""
SummariesDB — Telegram summaries feature database layer.

Inherits from utils.database.Database (shared pool, connection management,
user/auth/plan/settings methods). This class owns all summaries-specific DB
operations: messages, summaries, bots, categories, topics, keywords, schedules,
collections, prompts, and analytics.
"""

import json
import logging
from typing import List

from utils.database import Database, _parse_jsonb_list

logger = logging.getLogger(__name__)


class SummariesDB(Database):
    """Summaries-feature DB layer.  Inherits pool + system methods from Database."""

    # ==================== Keyword helpers ====================

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
                cursor.execute("DELETE FROM topic_keywords WHERE id = %s", (row['id'],))
                for part in parts:
                    owner_id = row.get('owner_id')
                    cursor.execute("""
                        INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword, owner_id)
                        VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING
                    """, (row['bot_name'], row['category_name'], row['topic_name'], part, owner_id))
                fixed += 1
            if fixed:
                logger.info(f"[KEYWORDS] Migrated {fixed} comma-separated keyword rows into individual entries")
        finally:
            self._commit()

    # ==================== Messages ====================

    def add_message(self, channel_id, text, countries=None, regions=None,
                    keywords=None, bot_name=None, original_text=None, replaced_text=None,
                    topics=None, categories=None, channel_username=None, collection_name=None,
                    msg_timestamp=None):
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
                    bot_name, original_text, replaced_text, channel_username, collection_name,
                    timestamp)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           COALESCE(%s, CURRENT_TIMESTAMP))
                   RETURNING id""",
                (channel_id, text, countries_str, regions_str, topics_str, categories_str, keywords_str,
                 bot_name, original_text, replaced_text, channel_username, collection_name,
                 msg_timestamp)
            )
            row = cursor.fetchone()
            return row['id']
        finally:
            self._commit()

    def get_messages_for_schedule(self, schedule_type: str, bot_name: str, topic_name: str):
        try:
            """Get messages not yet summarized for this specific (bot, topic, schedule_type) combo."""
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
                           AND ms.schedule_type = %s
                     )""",
                (
                    bot_name,
                    topic_name,
                    topic_name + ',%',
                    '%,' + topic_name + ',%',
                    '%,' + topic_name,
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

    def clear_all_pending(self):
        """Mark every unsummarized message as missed across all bots/topics/schedule types."""
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                INSERT INTO message_summarizations (message_id, bot_name, topic_name, schedule_type, status)
                SELECT m.id, m.bot_name, t.topic_name, s.stype, 'missed'
                FROM messages m
                CROSS JOIN LATERAL unnest(string_to_array(m.topics, ',')) AS t(topic_name)
                CROSS JOIN (VALUES ('hourly'),('daily'),('minute'),('interval_hourly'),('interval_minutes'),('speeches_interval')) AS s(stype)
                WHERE m.topics IS NOT NULL AND m.topics != ''
                  AND m.bot_name IS NOT NULL
                ON CONFLICT (message_id, bot_name, topic_name, schedule_type) DO NOTHING
            """)
            return cursor.rowcount
        finally:
            self._commit()

    # ── Interim (rolling 25-message batch) summarization ─────────────────────

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

    def get_messages_for_interim(self, bot_name: str, topic_name: str,
                                limit: int = 25, after_dt=None) -> list:
        """Get the oldest `limit` messages for (bot, topic) not yet interim-summarized.
        If after_dt is provided, only messages with timestamp >= after_dt are returned
        (used by scheduled summaries to stay within their own window without marking
        out-of-window messages as missed, so wider-window schedules can still use them).
        """
        try:
            cursor = self._get_cursor()
            window_clause = "AND m.timestamp >= %s" if after_dt is not None else ""
            cursor.execute(
                f"""SELECT m.* FROM messages m
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
                     {window_clause}
                   ORDER BY m.timestamp ASC
                   LIMIT %s""",
                (
                    bot_name,
                    topic_name,
                    topic_name + ',%',
                    '%,' + topic_name + ',%',
                    '%,' + topic_name,
                    bot_name, topic_name,
                    *([after_dt] if after_dt is not None else []),
                    limit,
                )
            )
            return [dict(row) for row in cursor.fetchall()]
        finally:
            self._commit()

    def get_messages_for_schedule_window(self, bot_name: str, topic_name: str,
                                         schedule_type: str, after_dt=None) -> list:
        """Get ALL messages for (bot, topic) within window not yet consumed by this specific
        schedule_type. Unlike get_messages_for_interim, this filters by the concrete schedule
        type (hourly/daily/etc.) so that multiple schedules on the same topic each see their
        own independent message pool."""
        try:
            cursor = self._get_cursor()
            window_clause = "AND m.timestamp >= %s" if after_dt is not None else ""
            cursor.execute(
                f"""SELECT m.* FROM messages m
                   WHERE m.bot_name = %s
                     AND (m.collection_name IS NOT NULL AND m.collection_name != '')
                     AND (
                         m.topics = %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                         OR m.topics LIKE %s
                     )
                     AND NOT EXISTS (
                         SELECT 1 FROM message_summarizations ms
                         WHERE ms.message_id = m.id
                           AND ms.bot_name   = %s
                           AND ms.topic_name = %s
                           AND ms.schedule_type = %s
                     )
                     {window_clause}
                   ORDER BY m.timestamp ASC""",
                (
                    bot_name,
                    topic_name,
                    topic_name + ',%',
                    '%,' + topic_name + ',%',
                    '%,' + topic_name,
                    bot_name, topic_name, schedule_type,
                    *([after_dt] if after_dt is not None else []),
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
                """SELECT m.id, m.bot_name, m.topics, m.timestamp FROM messages m
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

    # ==================== Summaries ====================

    def save_summary(self, summary_text: str, message_count: int,
                     summary_type: str, target_entity: str,
                     bot_name: str = None, topic_name: str = None,
                     message_ids: list = None, tokens_used: int = 0) -> int:
        try:
            """Save a generated summary and return its id."""
            ids_str = ",".join(str(i) for i in message_ids) if message_ids else None
            cursor = self._get_cursor()
            cursor.execute(
                """INSERT INTO summaries
                   (summary_text, message_count, summary_type, target_entity, bot_name, topic_name, message_ids, tokens_used)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                (summary_text, message_count, summary_type, target_entity, bot_name, topic_name, ids_str, tokens_used or 0)
            )
            row = cursor.fetchone()
            return row['id']
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
                params.append(datetime.now() - timedelta(days=days))

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

    def get_hourly_ai_stats(self, hours: int = 24) -> list:
        """Returns per-hour summary counts and token totals for the last N hours."""
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT
                    DATE_TRUNC('hour', timestamp) AS hour_lbn,
                    COUNT(*)                                          AS summary_count,
                    SUM(COALESCE(tokens_used, 0))                    AS total_tokens,
                    SUM(COALESCE(message_count, 0))                  AS total_messages,
                    array_agg(DISTINCT bot_name) FILTER (WHERE bot_name IS NOT NULL) AS bots,
                    array_agg(DISTINCT topic_name) FILTER (WHERE topic_name IS NOT NULL) AS topics
                FROM summaries
                WHERE timestamp >= NOW() - (%s || ' hours')::INTERVAL
                GROUP BY 1
                ORDER BY 1 DESC
            """, (str(hours),))
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                d['hour_lbn'] = d['hour_lbn'].isoformat() if d['hour_lbn'] else None
                d['bots']   = [b for b in (d['bots']   or []) if b]
                d['topics'] = [t for t in (d['topics'] or []) if t]
                result.append(d)
            return result
        finally:
            self._commit()

    def get_recent_summaries_for_ai_page(self, limit: int = 100) -> list:
        """Returns recent summaries with token counts for the AI Usage page."""
        try:
            cursor = self._get_cursor()
            cursor.execute("""
                SELECT id, bot_name, topic_name, summary_type, target_entity,
                       message_count, COALESCE(tokens_used, 0) AS tokens_used, timestamp
                FROM summaries
                ORDER BY timestamp DESC
                LIMIT %s
            """, (limit,))
            result = []
            for row in cursor.fetchall():
                d = dict(row)
                if d['timestamp']:
                    d['timestamp'] = d['timestamp'].isoformat()
                result.append(d)
            return result
        finally:
            self._commit()

    def log_schedule_run(self, bot_name: str, topic_name: str, schedule_type: str,
                         status: str, message_count: int = 0, error_text: str = None,
                         rpm_at_failure: int = None, tpm_at_failure: int = None,
                         rpd_at_failure: int = None):
        try:
            cursor = self._get_cursor()
            cursor.execute(
                """INSERT INTO schedule_runs
                   (bot_name, topic_name, schedule_type, status, message_count, error_text,
                    rpm_at_failure, tpm_at_failure, rpd_at_failure)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (bot_name, topic_name, schedule_type, status, message_count, error_text,
                 rpm_at_failure, tpm_at_failure, rpd_at_failure)
            )
        finally:
            self._commit()

    def get_today_schedule_stats(self, allowed_bot_names: list = None) -> list:
        """Returns today's sent/failed counts per (bot_name, topic_name, schedule_type)."""
        try:
            cursor = self._get_cursor()
            conditions = ["fired_at >= CURRENT_DATE"]
            params = []
            if allowed_bot_names is not None:
                conditions.append("bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            where = " AND ".join(conditions)
            cursor.execute(
                f"""SELECT bot_name, topic_name, schedule_type,
                           COUNT(*) FILTER (WHERE status = 'success') AS sent,
                           COUNT(*) FILTER (WHERE status = 'failed')  AS failed
                    FROM schedule_runs
                    WHERE {where}
                    GROUP BY bot_name, topic_name, schedule_type""",
                params or None
            )
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_schedule_history(self, limit: int = 200, bot_name: str = None,
                             topic_name: str = None, status: str = None,
                             allowed_bot_names: list = None):
        try:
            cursor = self._get_cursor()
            conditions = []
            params = []
            if allowed_bot_names is not None:
                conditions.append("bot_name = ANY(%s)")
                params.append(allowed_bot_names)
            if bot_name:
                conditions.append("bot_name = %s")
                params.append(bot_name)
            if topic_name:
                conditions.append("topic_name = %s")
                params.append(topic_name)
            if status:
                conditions.append("status = %s")
                params.append(status)
            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params.append(limit)
            cursor.execute(
                f"""SELECT r.id, r.bot_name, r.topic_name, r.schedule_type, r.status,
                           r.message_count, r.error_text, r.fired_at,
                           r.rpm_at_failure, r.tpm_at_failure, r.rpd_at_failure,
                           matched.id           AS summary_id,
                           matched.summary_text AS summary_text,
                           (SELECT string_agg(DISTINCT s2.target_entity, ', ')
                            FROM summaries s2
                            WHERE s2.bot_name = r.bot_name
                              AND s2.topic_name = r.topic_name
                              AND s2.message_ids IS NOT NULL
                              AND ABS(EXTRACT(EPOCH FROM (s2.timestamp - r.fired_at))) < 300
                           ) AS target_entities
                    FROM schedule_runs r
                    LEFT JOIN LATERAL (
                        SELECT s.id, s.summary_text
                        FROM summaries s
                        WHERE s.bot_name = r.bot_name
                          AND s.topic_name = r.topic_name
                          AND s.message_ids IS NOT NULL
                          AND ABS(EXTRACT(EPOCH FROM (s.timestamp - r.fired_at))) < 300
                        ORDER BY ABS(EXTRACT(EPOCH FROM (s.timestamp - r.fired_at))) ASC
                        LIMIT 1
                    ) matched ON true
                    {where}
                    ORDER BY r.fired_at DESC LIMIT %s""",
                params or None
            )
            rows = cursor.fetchall()
            result = []
            for row in rows:
                d = dict(row)
                if d.get('fired_at'):
                    d['fired_at'] = d['fired_at'].isoformat()
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

    # ==================== Analytics ====================

    def get_pending_counts(self, allowed_bot_names: list = None, windows: dict = None):
        """Returns pending message counts per bot per topic for each schedule type.

        windows: optional dict of (bot_name, topic_name, schedule_type) -> datetime.datetime.
        When provided, a message only counts as pending for a given schedule type if its
        timestamp >= the corresponding window start. Fallback: 48-hour window.
        """
        try:
            cursor = self._get_cursor()
            if allowed_bot_names is not None:
                cursor.execute("""
                    SELECT m.id, m.bot_name, m.topics, m.timestamp
                    FROM messages m
                    WHERE m.bot_name IS NOT NULL AND m.topics IS NOT NULL AND m.topics != ''
                      AND (m.collection_name IS NOT NULL AND m.collection_name != '')
                      AND m.timestamp >= NOW() - INTERVAL '48 hours'
                      AND m.bot_name = ANY(%s)
                """, (allowed_bot_names,))
            else:
                cursor.execute("""
                    SELECT m.id, m.bot_name, m.topics, m.timestamp
                    FROM messages m
                    WHERE m.bot_name IS NOT NULL AND m.topics IS NOT NULL AND m.topics != ''
                      AND (m.collection_name IS NOT NULL AND m.collection_name != '')
                      AND m.timestamp >= NOW() - INTERVAL '48 hours'
                """)
            rows = cursor.fetchall()

            cursor.execute("""
                SELECT ms.message_id, ms.bot_name, ms.topic_name, ms.schedule_type, ms.status
                FROM message_summarizations ms
                JOIN messages m ON m.id = ms.message_id
                WHERE m.timestamp >= NOW() - INTERVAL '48 hours'
            """)
            done = set()
            missed = set()
            for r in cursor.fetchall():
                done.add((r['message_id'], r['bot_name'], r['topic_name'], r['schedule_type']))
                if r['status'] == 'missed':
                    missed.add((r['message_id'], r['bot_name'], r['topic_name']))

            counts = {}
            for row in rows:
                bn = row['bot_name'] or 'unknown'
                topics_str = row['topics'] or ''
                topics = [t.strip() for t in topics_str.split(',') if t.strip()]
                msg_ts = row['timestamp']

                if bn not in counts:
                    counts[bn] = {}

                for topic in topics:
                    if topic not in counts[bn]:
                        counts[bn][topic] = {'hourly': 0, 'daily': 0, 'minute': 0, 'interval_hourly': 0, 'interval_minutes': 0, 'speeches_interval': 0}
                    if (row['id'], bn, topic) in missed:
                        continue
                    for stype in ('hourly', 'daily', 'minute', 'interval_hourly', 'interval_minutes', 'speeches_interval'):
                        if (row['id'], bn, topic, stype) in done:
                            continue
                        if windows and msg_ts is not None:
                            win = windows.get((bn, topic, stype))
                            if win is not None:
                                import datetime as _dt
                                from zoneinfo import ZoneInfo
                                # messages.timestamp is TIMESTAMP (no tz) storing Beirut local time
                                msg_ts_cmp = msg_ts if msg_ts.tzinfo is not None else msg_ts.replace(tzinfo=ZoneInfo('Asia/Beirut'))
                                if msg_ts_cmp < win:
                                    continue
                        counts[bn][topic][stype] += 1

            return counts
        finally:
            self._commit()

    def get_dashboard_stats(self, days: int = 14, filter_source: str = None, filter_topic: str = None,
                            filter_bot_names: list = None, filter_channels: list = None) -> dict:
        try:
            """Return comprehensive analytics for the dashboard page."""
            days = max(1, min(365, int(days)))
            cursor = self._get_cursor()

            iv = "(%s * INTERVAL '1 day')"

            # channels_clause: multi-channel include filter (from filter_channels tag picker)
            channels_clause = " AND channel_username = ANY(%s)" if filter_channels else ""
            src_clause      = " AND channel_username = %s"      if filter_source   else ""
            topic_clause    = " AND TRIM(t.topic) = %s"         if filter_topic    else ""
            bot_clause      = " AND bot_name = ANY(%s)"         if filter_bot_names is not None else ""

            # p(): queries with channels + src + bot (no topic clause)
            def p(*base):
                extra = []
                if filter_channels:  extra.append(filter_channels)
                if filter_source:    extra.append(filter_source)
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            # p_sum(): queries with bot only (summaries table has no channel col)
            def p_sum(*base):
                extra = []
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            # p_topic(): queries with channels + src + topic + bot
            def p_topic(*base):
                extra = []
                if filter_channels:  extra.append(filter_channels)
                if filter_source:    extra.append(filter_source)
                if filter_topic:     extra.append(filter_topic)
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            # p_ch(): queries with channels + bot only (total_messages, no src/topic)
            def p_ch(*base):
                extra = []
                if filter_channels:  extra.append(filter_channels)
                if filter_bot_names is not None: extra.append(filter_bot_names)
                return tuple(base) + tuple(extra)

            # all_sources: no time filter — channels from deleted collections always appear
            all_src_params = (filter_bot_names,) if filter_bot_names is not None else ()
            cursor.execute(f"""
                SELECT DISTINCT channel_username AS source FROM messages
                WHERE channel_username IS NOT NULL AND channel_username != ''
                {bot_clause}
                ORDER BY source LIMIT 500
            """, all_src_params or None)
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

            cursor.execute(f"SELECT COUNT(*) AS cnt FROM messages WHERE 1=1{channels_clause}{bot_clause}",
                           p_ch() or None)
            total_messages = cursor.fetchone()['cnt']

            cursor.execute(f"SELECT COUNT(*) AS cnt FROM messages WHERE timestamp >= NOW() - {iv}{channels_clause}{src_clause}{bot_clause}",
                           p(days))
            period_messages = cursor.fetchone()['cnt']

            cursor.execute(f"SELECT COUNT(*) AS cnt FROM summaries WHERE 1=1{bot_clause}", p_sum() or None)
            total_summaries = cursor.fetchone()['cnt']

            cursor.execute(f"""
                SELECT COUNT(DISTINCT channel_username) AS cnt FROM messages
                WHERE channel_username IS NOT NULL AND channel_username != ''
                  AND timestamp >= NOW() - {iv}{channels_clause}{src_clause}{bot_clause}
            """, p(days))
            active_sources = cursor.fetchone()['cnt']

            if filter_topic:
                cursor.execute(f"""
                    SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE topics IS NOT NULL AND topics != ''
                      AND timestamp >= NOW() - {iv}{channels_clause}{src_clause}{topic_clause}{bot_clause}
                    GROUP BY day ORDER BY day
                """, p_topic(days))
            else:
                cursor.execute(f"""
                    SELECT DATE(timestamp) AS day, COUNT(*) AS cnt
                    FROM messages WHERE timestamp >= NOW() - {iv}{channels_clause}{src_clause}{bot_clause}
                    GROUP BY day ORDER BY day
                """, p(days))
            messages_per_day = [{'day': str(r['day']), 'count': r['cnt']} for r in cursor.fetchall()]

            cursor.execute(f"""
                SELECT TRIM(t.topic) AS topic, COUNT(*) AS cnt
                FROM messages,
                     LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                WHERE topics IS NOT NULL AND topics != ''
                  AND TRIM(t.topic) != '' AND timestamp >= NOW() - {iv}{channels_clause}{src_clause}{topic_clause}{bot_clause}
                GROUP BY topic ORDER BY cnt DESC LIMIT 20
            """, p_topic(days))
            messages_per_topic = [{'topic': r['topic'], 'count': r['cnt']} for r in cursor.fetchall()]

            top6 = [r['topic'] for r in messages_per_topic[:6]]
            if top6:
                extra_trend = ((filter_channels,) if filter_channels else ()) + \
                              ((filter_source,)   if filter_source   else ()) + \
                              ((filter_bot_names,) if filter_bot_names is not None else ())
                cursor.execute(f"""
                    SELECT DATE(timestamp) AS day, TRIM(t.topic) AS topic, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE topics IS NOT NULL AND topics != ''
                      AND TRIM(t.topic) = ANY(%s) AND timestamp >= NOW() - {iv}{channels_clause}{src_clause}{bot_clause}
                    GROUP BY day, topic ORDER BY day, topic
                """, (top6, days) + extra_trend)
                topic_trend = [{'day': str(r['day']), 'topic': r['topic'], 'count': r['cnt']}
                               for r in cursor.fetchall()]
            else:
                topic_trend = []

            if filter_topic:
                cursor.execute(f"""
                    SELECT channel_username AS source, COUNT(*) AS cnt
                    FROM messages,
                         LATERAL UNNEST(STRING_TO_ARRAY(topics, ',')) AS t(topic)
                    WHERE channel_username IS NOT NULL AND channel_username != ''
                      AND topics IS NOT NULL AND topics != ''
                      AND timestamp >= NOW() - {iv}{channels_clause}{src_clause}{topic_clause}{bot_clause}
                    GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
                """, p_topic(days))
            else:
                cursor.execute(f"""
                    SELECT channel_username AS source, COUNT(*) AS cnt
                    FROM messages
                    WHERE channel_username IS NOT NULL AND channel_username != ''
                      AND timestamp >= NOW() - {iv}{channels_clause}{src_clause}{bot_clause}
                    GROUP BY channel_username ORDER BY cnt DESC LIMIT 20
                """, p(days))
            messages_per_source = [{'source': r['source'], 'count': r['cnt']} for r in cursor.fetchall()]

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
                'filter_channels':        filter_channels or [],
            }
        finally:
            self._commit()

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

    # ==================== Userbot dialogs ====================

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
                                INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword, owner_id)
                                VALUES (%s, %s, %s, %s, NULL)
                                ON CONFLICT DO NOTHING
                            """, (bot_name, category_name, topic_name, kw))
                            inserted += 1
            logger.info(f"[KEYWORDS] Seeded {inserted} keywords from config into DB")
        finally:
            self._commit()

    def get_topic_keywords(self, bot_name: str, category_name: str, topic_name: str, owner_id: int = None) -> list:
        try:
            """Return the keyword list for a specific topic, always split into individual entries."""
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("""
                    SELECT keyword FROM topic_keywords
                    WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND owner_id IS NULL
                    ORDER BY id
                """, (bot_name, category_name, topic_name))
            else:
                cursor.execute("""
                    SELECT keyword FROM topic_keywords
                    WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND owner_id = %s
                    ORDER BY id
                """, (bot_name, category_name, topic_name, owner_id))
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

    def set_topic_keywords(self, bot_name: str, category_name: str, topic_name: str, keywords: list, owner_id: int = None):
        try:
            """Replace all keywords for a topic with the given list."""
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("""
                    DELETE FROM topic_keywords
                    WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND owner_id IS NULL
                """, (bot_name, category_name, topic_name))
            else:
                cursor.execute("""
                    DELETE FROM topic_keywords
                    WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND owner_id = %s
                """, (bot_name, category_name, topic_name, owner_id))
            for kw in self._split_keywords(keywords):
                cursor.execute("""
                    INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword, owner_id)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (bot_name, category_name, topic_name, kw, owner_id))
            self._bump_config_version()
        finally:
            self._commit()

    def add_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str, owner_id: int = None) -> bool:
        try:
            """Add one or more keywords (splits comma-separated input). Returns True if any were inserted."""
            cursor = self._get_cursor()
            total_inserted = 0
            for kw in self._split_keywords([keyword]):
                cursor.execute("""
                    INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword, owner_id)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (bot_name, category_name, topic_name, kw, owner_id))
                total_inserted += cursor.rowcount
            if total_inserted > 0:
                self._bump_config_version()
            return total_inserted > 0
        finally:
            self._commit()

    def delete_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str, owner_id: int = None) -> bool:
        try:
            """Remove a single keyword. Returns True if deleted."""
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("""
                    DELETE FROM topic_keywords
                    WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND keyword = %s AND owner_id IS NULL
                """, (bot_name, category_name, topic_name, keyword.strip()))
            else:
                cursor.execute("""
                    DELETE FROM topic_keywords
                    WHERE bot_name = %s AND category_name = %s AND topic_name = %s AND keyword = %s AND owner_id = %s
                """, (bot_name, category_name, topic_name, keyword.strip(), owner_id))
            deleted = cursor.rowcount
            if deleted > 0:
                self._bump_config_version()
            return deleted > 0
        finally:
            self._commit()

    # ==================== Config DAL ====================

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

    def migrate_config_to_db(self, config):
        try:
            """Migrate bots, categories, and collections from config.yaml to database."""
            cursor = self._get_cursor()

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

                for cat_name, cat_data in bot_data.get('categories', {}).items():
                    cursor.execute("""
                        INSERT INTO categories (bot_id, name, enabled) VALUES (%s, %s, %s) RETURNING id
                    """, (bot_id, cat_name, cat_data.get('enabled', True)))
                    cat_id = cursor.fetchone()['id']
                    migrated_cats += 1

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

                        schedules_data = topic_data.get('schedules', [])
                        if isinstance(schedules_data, dict):
                            schedules_items = schedules_data.items()
                        else:
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

    # ==================== Collections ====================

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

    # ==================== Bots ====================

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
                    kws = self.get_topic_keywords(bn, cn, t['name'], owner_id=owner_id)
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
                    if s['end_hour'] is not None:
                        sch['end_hour'] = s['end_hour']
                    if s['end_minute'] is not None:
                        sch['end_minute'] = s['end_minute']
                    result[bn]['categories'][cn]['topics'][tn]['schedules'].append(sch)

            return result
        finally:
            self._commit()

    def get_filtered_bots_config(self, user_id: int) -> dict:
        """Return bot config for a non-admin user: owned bots (full) + inherited bots (filtered)."""
        import copy

        user_coll_names = set(self.get_user_collections(user_id).keys())

        result = self.get_owned_bots_config(user_id)

        for bot_cfg in result.values():
            bot_cfg['collections'] = [c for c in bot_cfg.get('collections', []) if c in user_coll_names]

        inheritances = self.get_user_bot_inheritances(user_id)
        if not inheritances:
            return result

        cats_flat = self.get_categories_topics_flat()
        cat_id_to_name   = {c['category_id']: c['category_name'] for c in cats_flat}
        topic_id_to_name = {}
        topic_key_to_id  = {}
        for c in cats_flat:
            for t in c.get('topics', []):
                topic_id_to_name[t['id']] = t['name']
                topic_key_to_id[(c['bot_name'], c['category_name'], t['name'])] = t['id']

        full_config = self.get_all_bots_config()

        for inh in inheritances:
            bot_name = inh['bot_name']
            if bot_name not in full_config:
                continue
            if bot_name in result:
                continue

            bot_cfg = copy.deepcopy(full_config[bot_name])

            allowed_cat_ids = set(inh.get('inherit_categories') or [])
            allowed_top_ids = set(inh.get('inherit_topics') or [])

            if allowed_cat_ids:
                allowed_cat_names = {cat_id_to_name[cid] for cid in allowed_cat_ids if cid in cat_id_to_name}
                bot_cfg['categories'] = {k: v for k, v in bot_cfg['categories'].items()
                                          if k in allowed_cat_names}

            if allowed_top_ids:
                allowed_top_names = {topic_id_to_name[tid] for tid in allowed_top_ids if tid in topic_id_to_name}
                for cat_data in bot_cfg['categories'].values():
                    cat_data['topics'] = {k: v for k, v in cat_data['topics'].items()
                                          if k in allowed_top_names}

            if not inh.get('inherit_keywords', True):
                for cat in bot_cfg['categories'].values():
                    for topic in cat['topics'].values():
                        topic['keywords'] = []
            if not inh.get('inherit_rules', True):
                bot_cfg['rules'] = {'remove': [], 'replace': []}

            ts_map = {ts['topic_id']: ts for ts in (inh.get('topic_settings') or [])}
            if ts_map:
                for cat_name, cat_data in bot_cfg['categories'].items():
                    for topic_name, topic in cat_data['topics'].items():
                        tid = topic_key_to_id.get((bot_name, cat_name, topic_name))
                        if tid and not ts_map.get(tid, {}).get('seo_visible', True):
                            kws = topic.get('keywords') or []
                            topic['_keyword_count'] = len(kws)
                            topic['keywords'] = []

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
        """Return owner_id for the bot with the given name."""
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

    def clone_bot_for_user(self, bot_name: str, user_id: int) -> bool:
        """Copy an admin-managed bot into the user's own namespace (copy-on-write).

        Returns True if a new copy was created, False if the user already owns one.
        """
        try:
            cursor = self._get_cursor()
            cursor.execute("SELECT id FROM bots WHERE name = %s AND owner_id = %s", (bot_name, user_id))
            if cursor.fetchone():
                return False

            cursor.execute("SELECT * FROM bots WHERE name = %s AND owner_id IS NULL", (bot_name,))
            admin_bot = cursor.fetchone()
            if not admin_bot:
                return False
            admin_bot_id = admin_bot['id']

            cursor.execute("""
                INSERT INTO bots (name, enabled, minimum_messages, collection_names, rules, default_schedules, owner_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
            """, (bot_name, admin_bot['enabled'], admin_bot['minimum_messages'],
                  admin_bot['collection_names'], admin_bot['rules'],
                  admin_bot['default_schedules'], user_id))
            new_bot_id = cursor.fetchone()['id']

            cursor.execute("SELECT * FROM categories WHERE bot_id = %s ORDER BY id", (admin_bot_id,))
            categories = cursor.fetchall()
            for cat in categories:
                cursor.execute("""
                    INSERT INTO categories (bot_id, name, enabled) VALUES (%s, %s, %s) RETURNING id
                """, (new_bot_id, cat['name'], cat['enabled']))
                new_cat_id = cursor.fetchone()['id']

                cursor.execute("SELECT * FROM topics WHERE category_id = %s ORDER BY id", (cat['id'],))
                topics = cursor.fetchall()
                for topic in topics:
                    cursor.execute("""
                        INSERT INTO topics (category_id, name, enabled, catch_all, linked_topics)
                        VALUES (%s, %s, %s, %s, %s) RETURNING id
                    """, (new_cat_id, topic['name'], topic['enabled'],
                          topic.get('catch_all', False), topic.get('linked_topics', '[]')))
                    new_topic_id = cursor.fetchone()['id']

                    cursor.execute("SELECT * FROM schedules WHERE topic_id = %s", (topic['id'],))
                    schedules = cursor.fetchall()
                    for sch in schedules:
                        cursor.execute("""
                            INSERT INTO schedules
                                (topic_id, name, type, enabled, prompt_key, header, header_datetime,
                                 header_date_arabic, header_time_arabic, minute, hour, hours, minutes,
                                 start_hour, start_minute, wait_time, end_hour, end_minute, telegram_targets)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        """, (new_topic_id, sch['name'], sch['type'], sch['enabled'],
                              sch.get('prompt_key'), sch.get('header'), sch.get('header_datetime', False),
                              sch.get('header_date_arabic', False), sch.get('header_time_arabic', False),
                              sch.get('minute'), sch.get('hour'), sch.get('hours'), sch.get('minutes'),
                              sch.get('start_hour'), sch.get('start_minute'), sch.get('wait_time'),
                              sch.get('end_hour'), sch.get('end_minute'),
                              json.dumps(sch.get('telegram_targets') or [])))

            cursor.execute("""
                INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword, owner_id)
                SELECT bot_name, category_name, topic_name, keyword, %s
                FROM topic_keywords WHERE bot_name = %s AND owner_id IS NULL
                ON CONFLICT DO NOTHING
            """, (user_id, bot_name))

            cursor.execute("""
                INSERT INTO prompts (bot_name, key, text, owner_id)
                SELECT bot_name, key, text, %s
                FROM prompts WHERE bot_name = %s AND owner_id IS NULL
                ON CONFLICT DO NOTHING
            """, (user_id, bot_name))

            self._bump_config_version()
            return True
        finally:
            self._commit()

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
        """Return the DB id for a bot."""
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
            cursor.execute(
                "SELECT id FROM bots WHERE name = %s AND owner_id IS NULL",
                (bot_name,),
            )
            row = cursor.fetchone()
            return row['id'] if row else None
        finally:
            self._commit()

    # ==================== Categories ====================

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
                if enabled:
                    cursor.execute("""
                        UPDATE topics SET enabled = TRUE
                        WHERE category_id = (
                            SELECT id FROM categories WHERE bot_id = %s AND name = %s
                        )
                    """, (bot_id, category_name))
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

    # ==================== Topics ====================

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
                cursor.execute("SELECT id FROM topics WHERE category_id = %s AND name = %s", (cat_id, topic_name))
                topic_row = cursor.fetchone()
                if topic_row:
                    topic_id = topic_row['id']
                    cursor.execute("SELECT default_schedules FROM bots WHERE name = %s", (bot_name,))
                    bot_row = cursor.fetchone()
                    default_schedules = (bot_row['default_schedules'] if bot_row else None) or []
                    for ds in default_schedules:
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

    def rename_prompt_key_in_schedules(self, bot_name: str, old_key: str, new_key: str, owner_id: int = None) -> int:
        try:
            """Update prompt_key in all schedules of a bot when a prompt is renamed."""
            cursor = self._get_cursor()
            if owner_id is None:
                owner_filter = "b.owner_id IS NULL"
                params = (new_key, old_key, bot_name)
            else:
                owner_filter = "b.owner_id = %s"
                params = (new_key, old_key, bot_name, owner_id)
            cursor.execute(f"""
                UPDATE schedules SET prompt_key = %s
                WHERE prompt_key = %s
                  AND topic_id IN (
                      SELECT s.id FROM topics s
                      JOIN categories c ON s.category_id = c.id
                      JOIN bots b ON c.bot_id = b.id
                      WHERE b.name = %s AND {owner_filter}
                  )
            """, params)
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

    # ==================== Schedules ====================

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

    # ==================== Prompts ====================

    def get_all_prompts(self, owner_id: int = None) -> dict:
        try:
            """Return prompts grouped by bot_name: {bot_name: {key: {text: ...}}}"""
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("SELECT bot_name, key, text FROM prompts WHERE owner_id IS NULL ORDER BY id")
            else:
                cursor.execute("SELECT bot_name, key, text FROM prompts WHERE owner_id = %s ORDER BY id", (owner_id,))
            result = {}
            for row in cursor.fetchall():
                bn = row['bot_name']
                if bn not in result:
                    result[bn] = {}
                result[bn][row['key']] = {'text': row['text']}
            return result
        finally:
            self._commit()

    def get_bot_prompts(self, bot_name: str, owner_id: int = None) -> dict:
        try:
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("SELECT key, text FROM prompts WHERE bot_name = %s AND owner_id IS NULL ORDER BY id", (bot_name,))
            else:
                cursor.execute("SELECT key, text FROM prompts WHERE bot_name = %s AND owner_id = %s ORDER BY id", (bot_name, owner_id))
            return {row['key']: {'text': row['text']} for row in cursor.fetchall()}
        finally:
            self._commit()

    def save_prompt(self, bot_name: str, key: str, text: str, owner_id: int = None):
        try:
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("""
                    INSERT INTO prompts (bot_name, key, text, owner_id) VALUES (%s, %s, %s, NULL)
                    ON CONFLICT (bot_name, key) WHERE owner_id IS NULL DO UPDATE SET text = EXCLUDED.text
                """, (bot_name, key, text))
            else:
                cursor.execute("""
                    INSERT INTO prompts (bot_name, key, text, owner_id) VALUES (%s, %s, %s, %s)
                    ON CONFLICT (bot_name, key, owner_id) WHERE owner_id IS NOT NULL DO UPDATE SET text = EXCLUDED.text
                """, (bot_name, key, text, owner_id))
        finally:
            self._commit()

    def delete_prompt(self, bot_name: str, key: str, owner_id: int = None) -> bool:
        try:
            cursor = self._get_cursor()
            if owner_id is None:
                cursor.execute("DELETE FROM prompts WHERE bot_name = %s AND key = %s AND owner_id IS NULL", (bot_name, key))
            else:
                cursor.execute("DELETE FROM prompts WHERE bot_name = %s AND key = %s AND owner_id = %s", (bot_name, key, owner_id))
            deleted = cursor.rowcount > 0
            return deleted
        finally:
            self._commit()

    # ==================== Dependency checks ====================

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

    def get_prompt_schedules(self, bot_name: str, key: str, owner_id: int = None) -> list:
        try:
            """Return schedules (with topic/category context) that reference this prompt key."""
            cursor = self._get_cursor()
            if owner_id is None:
                owner_filter = "b.owner_id IS NULL"
                params = (bot_name, key)
            else:
                owner_filter = "b.owner_id = %s"
                params = (bot_name, key, owner_id)
            cursor.execute(f"""
                SELECT s.name AS schedule_name, t.name AS topic_name, c.name AS category_name
                FROM schedules s
                JOIN topics t ON t.id = s.topic_id
                JOIN categories c ON c.id = t.category_id
                JOIN bots b ON b.id = c.bot_id
                WHERE b.name = %s AND s.prompt_key = %s AND {owner_filter}
                ORDER BY c.name, t.name, s.name
            """, params)
            return [dict(r) for r in cursor.fetchall()]
        finally:
            self._commit()

    def get_all_dependency_warnings(self) -> list:
        try:
            """Return actionable dependency warnings for admin bots."""
            warnings = []
            cursor = self._get_cursor()

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
