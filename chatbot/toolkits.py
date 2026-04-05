"""
Agno Toolkits for the Agent Chatbot.
Each toolkit wraps existing DB methods as read-only tools.
All toolkits accept allowed_bot_names to scope queries to the current user's bots.
None = admin (unrestricted). [] = no bots (no data). [list] = scoped.
"""

import json
import logging
from agno.tools import Toolkit

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SummaryToolkit — summaries of processed topic groups
# ---------------------------------------------------------------------------

class SummaryToolkit(Toolkit):
    """Tools for querying generated summaries (digests of grouped messages per topic)."""

    def __init__(self, db, allowed_bot_names=None, **kwargs):
        self.db = db
        self.allowed_bot_names = allowed_bot_names
        super().__init__(
            name="summary_tools",
            tools=[
                self.get_recent_summaries,
                self.search_summaries,
                self.get_summary_by_id,
                self.get_system_stats,
                self.get_pending_summary_counts,
            ],
            **kwargs,
        )

    def get_recent_summaries(self, limit: int = 20, days: int = None,
                             topic: str = "", bot_name: str = "") -> str:
        """Get recently generated summaries. A summary is an AI-generated digest of multiple
        messages grouped under a topic. Each has: id, bot_name, topic_name, summary_type,
        message_count, timestamp, preview (first 300 chars of the summary text).

        Use get_summary_by_id to read the full text of a specific entry.

        Args:
            limit: Max number of summaries to return (max 50).
            days: Only return summaries from the last N days (e.g. 3 for last 3 days, 7 for a week).
            topic: Filter by topic name (partial match, optional).
            bot_name: Filter by bot name (partial match, optional).

        Returns:
            JSON list of summary objects.
        """
        limit = min(max(1, limit), 50)
        rows = self.db.get_recent_summaries(
            limit=limit,
            days=days or None,
            topic=topic or None,
            bot_name=bot_name or None,
            allowed_bot_names=self.allowed_bot_names,
        )
        return json.dumps(rows, ensure_ascii=False)

    def search_summaries(self, topic: str = "", bot_name: str = "",
                         days: int = 7, limit: int = 20) -> str:
        """Search generated summaries by topic and/or bot within a date range.
        Use this when the user asks for summaries filtered by a specific topic, bot, or time window.

        Args:
            topic: Topic name to filter by (partial match).
            bot_name: Bot name to filter by (partial match).
            days: Look back N days (default 7).
            limit: Max results (max 50).

        Returns:
            JSON list of matching summary objects with preview text.
        """
        limit = min(max(1, limit), 50)
        rows = self.db.get_recent_summaries(
            limit=limit,
            days=days,
            topic=topic or None,
            bot_name=bot_name or None,
            allowed_bot_names=self.allowed_bot_names,
        )
        return json.dumps(rows, ensure_ascii=False)

    def get_summary_by_id(self, summary_id: int) -> str:
        """Get the full text of a specific generated summary by its ID.

        Args:
            summary_id: The summary ID (from get_recent_summaries or search_summaries results).

        Returns:
            JSON object with full summary_text and all metadata, or error message.
        """
        cursor = self.db._get_cursor()
        query = (
            "SELECT id, bot_name, topic_name, summary_type, target_entity, "
            "message_count, timestamp, summary_text FROM summaries WHERE id = %s"
        )
        params = [summary_id]
        # Enforce ownership — user can only fetch summaries from their own bots
        if self.allowed_bot_names is not None:
            query += " AND bot_name = ANY(%s)"
            params.append(self.allowed_bot_names)
        cursor.execute(query, tuple(params))
        row = cursor.fetchone()
        if not row:
            return json.dumps({"error": "Summary not found"})
        d = dict(row)
        if d.get("timestamp"):
            d["timestamp"] = d["timestamp"].isoformat()
        return json.dumps(d, ensure_ascii=False)

    def get_system_stats(self) -> str:
        """Get overall system counts: total messages ingested and total summaries generated.

        Returns:
            JSON with total_messages and summarized_messages.
        """
        stats = self.db.get_stats()
        return json.dumps(stats, ensure_ascii=False)

    def get_pending_summary_counts(self) -> str:
        """Get how many messages are waiting to be summarized, broken down by bot, topic,
        and schedule type (hourly, daily, minute, interval).

        Returns:
            JSON dict: {bot_name: {topic_name: {hourly: N, daily: N, minute: N, interval: N}}}.
        """
        counts = self.db.get_pending_counts(allowed_bot_names=self.allowed_bot_names)
        return json.dumps(counts, ensure_ascii=False)


# ---------------------------------------------------------------------------
# MessageToolkit — raw Telegram messages
# ---------------------------------------------------------------------------

class MessageToolkit(Toolkit):
    """Tools for searching and reading raw Telegram messages before they are summarized."""

    def __init__(self, db, allowed_bot_names=None, **kwargs):
        self.db = db
        self.allowed_bot_names = allowed_bot_names
        super().__init__(
            name="message_tools",
            tools=[
                self.get_recent_messages,
                self.get_messages_by_topic,
                self.search_messages,
                self.get_missed_messages,
                self.get_missed_messages_stats,
            ],
            **kwargs,
        )

    def get_recent_messages(self, limit: int = 30, days: int = None,
                            source: str = "") -> str:
        """Get the most recent raw messages from monitored channels across all topics.
        Each message has: id, channel_username, collection_name, bot_name, topics,
        categories, keywords_found, timestamp, preview.

        Args:
            limit: Max messages to return (max 100).
            days: Only messages from the last N days (optional).
            source: Filter by channel username (partial match, optional).

        Returns:
            JSON list of message objects.
        """
        limit = min(max(1, limit), 100)
        rows = self.db.get_recent_messages(
            limit=limit,
            days=days or None,
            source=source or None,
            allowed_bot_names=self.allowed_bot_names,
        )
        return json.dumps(rows, ensure_ascii=False)

    def get_messages_by_topic(self, topic: str, days: int = 7,
                              limit: int = 30, source: str = "") -> str:
        """Get raw messages for a specific topic within a date range.
        Use this when the user asks about messages related to a particular topic.

        Args:
            topic: Topic name to filter by (partial match — use the topic name as-is from config).
            days: Look back N days (default 7).
            limit: Max results (max 100).
            source: Optionally also filter by channel username (partial match).

        Returns:
            JSON list of message objects matching the topic.
        """
        limit = min(max(1, limit), 100)
        rows = self.db.get_recent_messages(
            limit=limit,
            topic=topic,
            days=days,
            source=source or None,
            allowed_bot_names=self.allowed_bot_names,
        )
        return json.dumps(rows, ensure_ascii=False)

    def search_messages(self, topic: str = "", source: str = "",
                        days: int = 7, limit: int = 30) -> str:
        """Search messages by topic name and/or source channel within a date range.
        More targeted than get_recent_messages — use when user specifies both a topic and a source.

        Args:
            topic: Topic name to search for (partial match).
            source: Source channel username to filter (partial match).
            days: Look back N days (default 7).
            limit: Max results (max 100).

        Returns:
            JSON list of matching messages.
        """
        limit = min(max(1, limit), 100)
        rows = self.db.search_messages(
            topic_filter=topic or None,
            source_filter=source or None,
            days=days,
            limit=limit,
            allowed_bot_names=self.allowed_bot_names,
        )
        return json.dumps(rows, ensure_ascii=False)

    def get_missed_messages(self, bot_name: str = "", collection: str = "",
                            search: str = "", limit: int = 30) -> str:
        """Get messages that were NOT classified into any topic (missed/unclassified messages).
        These are messages the system received but could not match to any configured topic keyword.
        Useful for identifying gaps in keyword coverage or missed news items.

        Args:
            bot_name: Filter by bot name (optional).
            collection: Filter by collection name (optional).
            search: Free text search within the message content (optional).
            limit: Max results (max 100).

        Returns:
            JSON list of unclassified message objects with preview text.
        """
        limit = min(max(1, limit), 100)
        rows = self.db.get_unclassified_messages(
            limit=limit,
            bot_name=bot_name or None,
            collection=collection or None,
            search=search or None,
            allowed_bot_names=self.allowed_bot_names,
        )
        return json.dumps(rows, ensure_ascii=False)

    def get_missed_messages_stats(self) -> str:
        """Get counts of missed/unclassified messages grouped by bot and collection.
        Use this to see how many messages are being missed overall before fetching details.

        Returns:
            JSON list of {bot_name, collection_name, cnt} rows ordered by count descending.
        """
        rows = self.db.get_unclassified_stats(allowed_bot_names=self.allowed_bot_names)
        return json.dumps(rows, ensure_ascii=False)


# ---------------------------------------------------------------------------
# DashboardToolkit — analytics and trends
# ---------------------------------------------------------------------------

class DashboardToolkit(Toolkit):
    """Tools for analytics, trend data, and dashboard statistics."""

    def __init__(self, db, allowed_bot_names=None, **kwargs):
        self.db = db
        self.allowed_bot_names = allowed_bot_names
        super().__init__(
            name="dashboard_tools",
            tools=[self.get_analytics],
            **kwargs,
        )

    def get_analytics(self, days: int = 7, filter_source: str = "", filter_topic: str = "") -> str:
        """Get dashboard analytics: messages per day, per topic, per source, topic trends.
        Can filter by a specific source channel or topic.

        Args:
            days: Number of days to analyze (1-365, default 7).
            filter_source: Optional source channel username to filter by.
            filter_topic: Optional topic name to filter by.

        Returns:
            JSON with total_messages, period_messages, active_sources,
            messages_per_day, messages_per_topic, topic_trend, messages_per_source,
            summaries_per_type, all_sources, all_topics.
        """
        stats = self.db.get_dashboard_stats(
            days=days,
            filter_source=filter_source or None,
            filter_topic=filter_topic or None,
            filter_bot_names=self.allowed_bot_names,
        )
        stats.pop("source_topic_breakdown", None)
        return json.dumps(stats, ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# YouTubeToolkit — video summaries and monitoring data
# ---------------------------------------------------------------------------

class YouTubeToolkit(Toolkit):
    """Tools for querying YouTube video summaries and monitoring data."""

    def __init__(self, yt_db, **kwargs):
        self.yt_db = yt_db
        super().__init__(
            name="youtube_tools",
            tools=[
                self.get_video_summaries,
                self.get_video_summary_detail,
                self.get_youtube_overview,
                self.get_tracked_keywords,
            ],
            **kwargs,
        )

    def get_video_summaries(self, limit: int = 20, channel_name: str = "",
                            date_from: str = "", date_to: str = "") -> str:
        """Get YouTube video summaries. Can filter by channel name and date range.

        Args:
            limit: Max summaries (max 50).
            channel_name: Filter by channel name (partial match).
            date_from: Start date (YYYY-MM-DD).
            date_to: End date (YYYY-MM-DD).

        Returns:
            JSON list with title, channel_name, transcript_source, summary preview, telegram_sent.
        """
        limit = min(max(1, limit), 50)
        rows = self.yt_db.get_summaries(
            limit=limit,
            channel_name=channel_name or None,
            date_from=date_from or None,
            date_to=date_to or None,
        )
        for r in rows:
            txt = r.get("summary_text", "") or ""
            r["summary_text"] = txt[:500] + ("…" if len(txt) > 500 else "")
        return json.dumps(rows, ensure_ascii=False)

    def get_video_summary_detail(self, summary_id: int) -> str:
        """Get the full summary text for a specific YouTube video by summary ID.

        Args:
            summary_id: The summary ID.

        Returns:
            JSON with full summary details including summary_text.
        """
        row = self.yt_db.get_summary_by_id(summary_id)
        if not row:
            return json.dumps({"error": "Summary not found"})
        return json.dumps(row, ensure_ascii=False)

    def get_youtube_overview(self) -> str:
        """Get YouTube system overview: channel counts, keyword counts, queue stats, today's activity.

        Returns:
            JSON with channels, keywords, queue, summaries_total, today stats.
        """
        overview = self.yt_db.get_system_overview()
        return json.dumps(overview, ensure_ascii=False)

    def get_tracked_keywords(self) -> str:
        """List all tracked YouTube keyword search configs with their filters and schedule info.

        Returns:
            JSON list of keyword tracker objects.
        """
        rows = self.yt_db.get_keywords()
        slim = []
        for kw in rows:
            slim.append({
                "id": kw["id"],
                "keyword": kw["keyword"],
                "active": kw["active"],
                "date_window_days": kw.get("date_window_days"),
                "upload_type": kw.get("upload_type"),
                "schedule_interval_minutes": kw.get("schedule_interval_minutes"),
                "last_run_at": kw.get("last_run_at"),
                "telegram_targets": kw.get("telegram_targets"),
            })
        return json.dumps(slim, ensure_ascii=False, default=str)
