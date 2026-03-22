"""
System Control Toolkits — write-capable tools for the system chatbot.
Each toolkit wraps existing config/DB operations and logs actions for UI feedback.
"""

import json
import logging
from agno.tools import Toolkit

from utils.database import get_db
from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)


class SystemControlToolkit(Toolkit):
    """Control system-level settings, bots, and collections."""

    def __init__(self, action_log: list):
        super().__init__(name="SystemControlToolkit", tools=[
            self.get_system_overview,
            self.toggle_system,
            self.get_bots_status,
            self.toggle_collection,
        ])
        self.action_log = action_log

    def get_system_overview(self) -> str:
        """Get full system status: system enabled state, all bots with their enabled state, all collections with enabled state."""
        db = get_db()
        system_enabled = db.get_system_enabled()
        all_bots = db.get_all_bots_config()
        bots = {}
        for name, bot in all_bots.items():
            cats = {}
            for cname, cat in (bot.get("categories") or {}).items():
                topics = {}
                for tname, topic in (cat.get("topics") or {}).items():
                    topics[tname] = {"enabled": topic.get("enabled", True)}
                cats[cname] = {"enabled": cat.get("enabled", True), "topics": topics}
            bots[name] = {"enabled": bot.get("enabled", True), "categories": cats}
        all_collections = db.get_all_collections()
        collections = {}
        for cname, col in all_collections.items():
            collections[cname] = {"enabled": col.get("enabled", True)}
        return json.dumps({"system_enabled": system_enabled, "bots": bots, "collections": collections})

    def toggle_system(self, enabled: bool) -> str:
        """Toggle the entire system on or off. Pass enabled=true to turn on, enabled=false to turn off."""
        db = get_db()
        old = db.get_system_enabled()
        db.set_system_enabled(enabled)
        self.action_log.append({
            "type": "toggle", "entity": "System", "name": "System",
            "field": "enabled", "old_value": old, "new_value": enabled, "status": "success"
        })
        return json.dumps({"status": "ok", "enabled": enabled})

    def get_bots_status(self) -> str:
        """Get all bots with their enabled status, categories, and topic counts."""
        db = get_db()
        all_bots = db.get_all_bots_config()
        result = []
        for name, bot in all_bots.items():
            cats = list((bot.get("categories") or {}).keys())
            result.append({"name": name, "enabled": bot.get("enabled", True), "categories": cats})
        return json.dumps(result)

    def toggle_collection(self, collection_name: str, enabled: bool) -> str:
        """Enable or disable a collection. Pass the collection name and enabled=true/false."""
        db = get_db()
        collections = db.get_all_collections()
        if collection_name not in collections:
            return json.dumps({"status": "error", "message": f"Collection '{collection_name}' not found"})
        old = collections[collection_name].get("enabled", True)
        db.toggle_collection(collection_name, enabled)
        self.action_log.append({
            "type": "toggle", "entity": "Collection", "name": collection_name,
            "field": "enabled", "old_value": old, "new_value": enabled, "status": "success"
        })
        return json.dumps({"status": "ok", "collection": collection_name, "enabled": enabled})


class TopicControlToolkit(Toolkit):
    """Control topics and categories — toggle, update keywords."""

    def __init__(self, action_log: list):
        super().__init__(name="TopicControlToolkit", tools=[
            self.get_topics,
            self.toggle_category,
            self.toggle_topic,
            self.add_topic_keyword,
            self.remove_topic_keyword,
        ])
        self.action_log = action_log

    def get_topics(self, bot_name: str) -> str:
        """Get all categories and topics for a bot, including enabled state and keywords."""
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot = all_bots.get(bot_name)
        if not bot:
            return json.dumps({"status": "error", "message": f"Bot '{bot_name}' not found"})
        result = {}
        for cname, cat in (bot.get("categories") or {}).items():
            topics = {}
            for tname, topic in (cat.get("topics") or {}).items():
                topics[tname] = {"enabled": topic.get("enabled", True), "keywords": topic.get("keywords", [])}
            result[cname] = {"enabled": cat.get("enabled", True), "topics": topics}
        return json.dumps(result)

    def toggle_category(self, bot_name: str, category_name: str, enabled: bool) -> str:
        """Enable or disable a category (affects all its topics)."""
        db = get_db()
        if not db.toggle_category(bot_name, category_name, enabled):
            return json.dumps({"status": "error", "message": f"Category '{category_name}' not found in bot '{bot_name}'"})
        self.action_log.append({
            "type": "toggle", "entity": "Category", "name": f"{bot_name}/{category_name}",
            "field": "enabled", "old_value": not enabled, "new_value": enabled, "status": "success"
        })
        return json.dumps({"status": "ok", "enabled": enabled})

    def toggle_topic(self, bot_name: str, category_name: str, topic_name: str, enabled: bool) -> str:
        """Enable or disable a specific topic."""
        db = get_db()
        if not db.toggle_topic(bot_name, category_name, topic_name, enabled):
            return json.dumps({"status": "error", "message": f"Topic '{topic_name}' not found"})
        self.action_log.append({
            "type": "toggle", "entity": "Topic", "name": f"{bot_name}/{category_name}/{topic_name}",
            "field": "enabled", "old_value": not enabled, "new_value": enabled, "status": "success"
        })
        return json.dumps({"status": "ok", "enabled": enabled})

    def add_topic_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> str:
        """Add a keyword to a topic's keyword list."""
        db = get_db()
        if not db:
            return json.dumps({"status": "error", "message": "Database not available"})
        existing = db.get_topic_keywords(bot_name, category_name, topic_name)
        if keyword in existing:
            return json.dumps({"status": "error", "message": f"Keyword '{keyword}' already exists"})
        db.add_keyword(bot_name, category_name, topic_name, keyword)
        self.action_log.append({
            "type": "add", "entity": "Keyword", "name": keyword,
            "detail": f"Added to {bot_name}/{category_name}/{topic_name}", "status": "success"
        })
        return json.dumps({"status": "ok", "keyword": keyword, "topic": topic_name})

    def remove_topic_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> str:
        """Remove a keyword from a topic's keyword list."""
        db = get_db()
        if not db:
            return json.dumps({"status": "error", "message": "Database not available"})
        db.delete_keyword(bot_name, category_name, topic_name, keyword)
        self.action_log.append({
            "type": "delete", "entity": "Keyword", "name": keyword,
            "detail": f"Removed from {bot_name}/{category_name}/{topic_name}", "status": "success"
        })
        return json.dumps({"status": "ok", "keyword": keyword, "topic": topic_name})


class YouTubeControlToolkit(Toolkit):
    """Control YouTube channels and keyword trackers."""

    def __init__(self, action_log: list):
        super().__init__(name="YouTubeControlToolkit", tools=[
            self.get_yt_channels,
            self.toggle_yt_channel,
            self.get_yt_keywords,
            self.toggle_yt_keyword,
            self.add_yt_keyword,
            self.delete_yt_keyword,
            self.run_yt_keyword,
        ])
        self.action_log = action_log

    def get_yt_channels(self) -> str:
        """Get all YouTube channels with their active status and settings."""
        yt_db = get_yt_db()
        channels = yt_db.get_channels()
        result = []
        for ch in channels:
            result.append({
                "channel_id": ch.get("channel_id"),
                "channel_name": ch.get("channel_name"),
                "active": ch.get("active", True),
                "telegram_targets": ch.get("telegram_targets"),
            })
        return json.dumps(result)

    def toggle_yt_channel(self, channel_id: str, active: bool) -> str:
        """Enable or disable a YouTube channel. Pass the channel_id and active=true/false."""
        yt_db = get_yt_db()
        channels = yt_db.get_channels()
        ch = next((c for c in channels if c["channel_id"] == channel_id), None)
        if not ch:
            return json.dumps({"status": "error", "message": f"Channel '{channel_id}' not found"})
        old = ch.get("active", True)
        yt_db.toggle_channel(channel_id, active)
        name = ch.get("channel_name") or channel_id
        self.action_log.append({
            "type": "toggle", "entity": "YouTube Channel", "name": name,
            "field": "active", "old_value": old, "new_value": active, "status": "success"
        })
        return json.dumps({"status": "ok", "channel": name, "active": active})

    def get_yt_keywords(self) -> str:
        """Get all YouTube keyword trackers with their active status and settings."""
        yt_db = get_yt_db()
        keywords = yt_db.get_keywords()
        result = []
        for kw in keywords:
            result.append({
                "id": kw.get("id"),
                "keyword": kw.get("keyword"),
                "active": kw.get("active", True),
                "schedule_interval_minutes": kw.get("schedule_interval_minutes"),
                "telegram_targets": kw.get("telegram_targets"),
            })
        return json.dumps(result)

    def toggle_yt_keyword(self, keyword_id: int, active: bool) -> str:
        """Enable or disable a YouTube keyword tracker. Pass the keyword id and active=true/false."""
        yt_db = get_yt_db()
        keywords = yt_db.get_keywords()
        kw = next((k for k in keywords if k["id"] == keyword_id), None)
        if not kw:
            return json.dumps({"status": "error", "message": f"Keyword with id {keyword_id} not found"})
        old = kw.get("active", True)
        yt_db.toggle_keyword(keyword_id, active)
        name = kw.get("keyword", str(keyword_id))
        self.action_log.append({
            "type": "toggle", "entity": "YouTube Keyword", "name": name,
            "field": "active", "old_value": old, "new_value": active, "status": "success"
        })
        return json.dumps({"status": "ok", "keyword": name, "active": active})

    def add_yt_keyword(self, keyword: str, telegram_targets: str = "", schedule_interval_minutes: int = 360) -> str:
        """Add a new YouTube keyword tracker. Provide the keyword text, optional telegram_targets (comma-separated), and schedule_interval_minutes (default 360)."""
        yt_db = get_yt_db()
        targets = [t.strip() for t in telegram_targets.split(",") if t.strip()] if telegram_targets else []
        yt_db.add_keyword({
            "keyword": keyword,
            "telegram_targets": targets,
            "prompt": "",
            "date_window_days": 7,
            "schedule_interval_minutes": schedule_interval_minutes,
        })
        self.action_log.append({
            "type": "add", "entity": "YouTube Keyword", "name": keyword,
            "detail": f"Schedule: every {schedule_interval_minutes} min", "status": "success"
        })
        return json.dumps({"status": "ok", "keyword": keyword})

    def delete_yt_keyword(self, keyword_id: int) -> str:
        """Delete a YouTube keyword tracker by its id."""
        yt_db = get_yt_db()
        keywords = yt_db.get_keywords()
        kw = next((k for k in keywords if k["id"] == keyword_id), None)
        if not kw:
            return json.dumps({"status": "error", "message": f"Keyword with id {keyword_id} not found"})
        name = kw.get("keyword", str(keyword_id))
        yt_db.delete_keyword(keyword_id)
        self.action_log.append({
            "type": "delete", "entity": "YouTube Keyword", "name": name,
            "status": "success"
        })
        return json.dumps({"status": "ok", "deleted": name})

    def run_yt_keyword(self, keyword_id: int) -> str:
        """Manually trigger a YouTube keyword search. Returns number of new videos found."""
        yt_db = get_yt_db()
        keywords = yt_db.get_keywords()
        kw = next((k for k in keywords if k["id"] == keyword_id), None)
        if not kw:
            return json.dumps({"status": "error", "message": f"Keyword with id {keyword_id} not found"})
        name = kw.get("keyword", str(keyword_id))
        from youtube_monitor.keyword_search import run_keyword_search
        try:
            count = run_keyword_search(kw)
            self.action_log.append({
                "type": "run", "entity": "YouTube Keyword", "name": name,
                "status": "success", "detail": f"Found {count} new video(s)"
            })
            return json.dumps({"status": "ok", "keyword": name, "new_videos": count})
        except Exception as e:
            self.action_log.append({
                "type": "run", "entity": "YouTube Keyword", "name": name,
                "status": "error", "detail": str(e)
            })
            return json.dumps({"status": "error", "message": str(e)})
