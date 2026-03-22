"""
Agno Toolkits for the Agent Chatbot.
Each toolkit wraps existing DB methods as read-only tools.
"""

import json
import logging
from agno.tools import Toolkit

logger = logging.getLogger(__name__)


class SummaryToolkit(Toolkit):
    """Tools for querying Telegram news summaries."""

    def __init__(self, db, **kwargs):
        self.db = db
        super().__init__(
            name="summary_tools",
            tools=[self.get_recent_summaries, self.get_summary_by_id, self.get_system_stats],
            **kwargs,
        )

    def get_recent_summaries(self, limit: int = 30) -> str:
        """Get recent news summaries. Each has bot_name, topic_name, summary_type,
        preview (first 300 chars), message_count, and timestamp.
        Use get_summary_by_id to read the full text of a specific summary.

        Args:
            limit: Max number of summaries to return (max 50).

        Returns:
            JSON list of summary objects.
        """
        limit = min(max(1, limit), 50)
        rows = self.db.get_recent_summaries(limit=limit)
        return json.dumps(rows, ensure_ascii=False)

    def get_summary_by_id(self, summary_id: int) -> str:
        """Get the full text of a specific summary by its ID.

        Args:
            summary_id: The summary ID to fetch.

        Returns:
            JSON object with full summary_text, or error message.
        """
        cursor = self.db._get_cursor()
        cursor.execute(
            "SELECT id, bot_name, topic_name, summary_type, target_entity, "
            "message_count, timestamp, summary_text FROM summaries WHERE id = %s",
            (summary_id,),
        )
        row = cursor.fetchone()
        if not row:
            return json.dumps({"error": "Summary not found"})
        d = dict(row)
        if d.get("timestamp"):
            d["timestamp"] = d["timestamp"].isoformat()
        return json.dumps(d, ensure_ascii=False)

    def get_system_stats(self) -> str:
        """Get total message and summary counts for the system.

        Returns:
            JSON with total_messages and summarized_messages.
        """
        stats = self.db.get_stats()
        return json.dumps(stats, ensure_ascii=False)


class DashboardToolkit(Toolkit):
    """Tools for analytics and trend data."""

    def __init__(self, db, **kwargs):
        self.db = db
        super().__init__(
            name="dashboard_tools",
            tools=[self.get_analytics, self.get_pending_counts],
            **kwargs,
        )

    def get_analytics(self, days: int = 14, filter_source: str = "", filter_topic: str = "") -> str:
        """Get dashboard analytics: messages per day, per topic, per source, topic trends.
        Can filter by a specific source channel or topic.

        Args:
            days: Number of days to analyze (1-365, default 14).
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
        )
        # Strip large matrix to save tokens
        stats.pop("source_topic_breakdown", None)
        return json.dumps(stats, ensure_ascii=False, default=str)

    def get_pending_counts(self) -> str:
        """Get pending (unsummarized) message counts per bot and per topic.

        Returns:
            JSON dict: {bot_name: {topic_name: {hourly: N, daily: N, minute: N}}}.
        """
        counts = self.db.get_pending_counts()
        return json.dumps(counts, ensure_ascii=False)


class MessageToolkit(Toolkit):
    """Tools for searching and reading raw Telegram messages."""

    def __init__(self, db, **kwargs):
        self.db = db
        super().__init__(
            name="message_tools",
            tools=[self.get_recent_messages, self.search_messages],
            **kwargs,
        )

    def get_recent_messages(self, limit: int = 50) -> str:
        """Get the most recent raw messages from monitored channels.
        Each has channel_username, collection_name, topics, categories, preview text.

        Args:
            limit: Max messages to return (max 100).

        Returns:
            JSON list of message objects.
        """
        limit = min(max(1, limit), 100)
        rows = self.db.get_recent_messages(limit=limit)
        return json.dumps(rows, ensure_ascii=False)

    def search_messages(self, topic: str = "", source: str = "", days: int = 7, limit: int = 50) -> str:
        """Search messages by topic name and/or source channel within a date range.

        Args:
            topic: Topic name to search for (partial match).
            source: Source channel username to filter (partial match).
            days: Look back N days (default 7).
            limit: Max results (max 100).

        Returns:
            JSON list of matching messages.
        """
        rows = self.db.search_messages(
            topic_filter=topic or None,
            source_filter=source or None,
            days=days,
            limit=limit,
        )
        return json.dumps(rows, ensure_ascii=False)


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

    def get_video_summaries(self, limit: int = 30, channel_name: str = "",
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
        # Truncate summary text to save tokens
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
        # Slim down for token efficiency
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
