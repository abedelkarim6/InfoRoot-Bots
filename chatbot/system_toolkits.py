"""
System Control Toolkits — write-capable tools for the system chatbot.
All write operations validate exact names from the DB before acting.
"""

import json
import logging
from agno.tools import Toolkit

from utils.database import get_db
from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)


def _ok(data: dict = None) -> str:
    return json.dumps({"status": "ok", **(data or {})})

def _err(msg: str) -> str:
    return json.dumps({"status": "error", "message": msg})

def _resolve_topic(all_bots: dict, bot_name: str, category_name: str, topic_name: str):
    """Find exact (bot, category, topic) names using case-insensitive matching.
    Returns (exact_bot, exact_cat, exact_topic) or raises ValueError with a helpful message.
    """
    # Find bot
    bot_key = None
    for k in all_bots:
        if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
            bot_key = k
            break
    if not bot_key:
        available = list(all_bots.keys())
        raise ValueError(f"Bot '{bot_name}' not found. Available: {available}")

    categories = all_bots[bot_key].get("categories", {})

    # Find category
    cat_key = None
    for k in categories:
        if k.lower() == category_name.lower() or category_name.lower() in k.lower():
            cat_key = k
            break
    if not cat_key:
        available = list(categories.keys())
        raise ValueError(f"Category '{category_name}' not found in bot '{bot_key}'. Available: {available}")

    topics = categories[cat_key].get("topics", {})

    # Find topic
    topic_key = None
    for k in topics:
        if k.lower() == topic_name.lower() or topic_name.lower() in k.lower():
            topic_key = k
            break
    if not topic_key:
        available = list(topics.keys())
        raise ValueError(f"Topic '{topic_name}' not found in {bot_key}/{cat_key}. Available: {available}")

    return bot_key, cat_key, topic_key


def _resolve_bot_category(all_bots: dict, bot_name: str, category_name: str):
    """Find exact (bot, category) names. Returns (bot_key, cat_key) or raises ValueError."""
    bot_key = None
    for k in all_bots:
        if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
            bot_key = k
            break
    if not bot_key:
        raise ValueError(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")

    categories = all_bots[bot_key].get("categories", {})
    cat_key = None
    for k in categories:
        if k.lower() == category_name.lower() or category_name.lower() in k.lower():
            cat_key = k
            break
    if not cat_key:
        raise ValueError(f"Category '{category_name}' not found in bot '{bot_key}'. Available: {list(categories.keys())}")

    return bot_key, cat_key


# ===========================================================================
# SystemControlToolkit
# ===========================================================================

class SystemControlToolkit(Toolkit):
    """Control system-level settings, bots, and collections."""

    def __init__(self, action_log: list):
        super().__init__(name="SystemControlToolkit", tools=[
            self.get_system_overview,
            self.toggle_system,
            self.toggle_bot,
            self.toggle_collection,
        ])
        self.action_log = action_log

    def get_system_overview(self) -> str:
        """Get full system status: system on/off, all bots with enabled state, all collections with enabled state."""
        db = get_db()
        system_enabled = db.get_system_enabled()
        all_bots = db.get_all_bots_config()
        bots = {name: {"enabled": bot.get("enabled", True)} for name, bot in all_bots.items()}
        all_collections = db.get_all_collections()
        collections = {n: {"enabled": c.get("enabled", True)} for n, c in all_collections.items()}
        return json.dumps({"system_enabled": system_enabled, "bots": bots, "collections": collections})

    def toggle_system(self, enabled: bool) -> str:
        """Turn the entire monitoring system on or off.

        Args:
            enabled: true to turn on, false to turn off.
        """
        db = get_db()
        old = db.get_system_enabled()
        db.set_system_enabled(enabled)
        self.action_log.append({
            "type": "toggle", "entity": "System", "name": "System",
            "old_value": old, "new_value": enabled, "status": "success"
        })
        return _ok({"enabled": enabled})

    def toggle_bot(self, bot_name: str, enabled: bool) -> str:
        """Enable or disable a bot by name.

        Args:
            bot_name: Bot name (case-insensitive, partial match supported).
            enabled: true to enable, false to disable.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot_key = None
        for k in all_bots:
            if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
                bot_key = k
                break
        if not bot_key:
            return _err(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")
        old = all_bots[bot_key].get("enabled", True)
        db.toggle_bot(bot_key, enabled)
        self.action_log.append({
            "type": "toggle", "entity": "Bot", "name": bot_key,
            "old_value": old, "new_value": enabled, "status": "success"
        })
        return _ok({"bot": bot_key, "enabled": enabled})

    def toggle_collection(self, collection_name: str, enabled: bool) -> str:
        """Enable or disable a collection by name.

        Args:
            collection_name: Collection name (case-insensitive, partial match supported).
            enabled: true to enable, false to disable.
        """
        db = get_db()
        collections = db.get_all_collections()
        col_key = None
        for k in collections:
            if k.lower() == collection_name.lower() or collection_name.lower() in k.lower():
                col_key = k
                break
        if not col_key:
            return _err(f"Collection '{collection_name}' not found. Available: {list(collections.keys())}")
        old = collections[col_key].get("enabled", True)
        db.toggle_collection(col_key, enabled)
        self.action_log.append({
            "type": "toggle", "entity": "Collection", "name": col_key,
            "old_value": old, "new_value": enabled, "status": "success"
        })
        return _ok({"collection": col_key, "enabled": enabled})


# ===========================================================================
# TopicControlToolkit
# ===========================================================================

class TopicControlToolkit(Toolkit):
    """Full control over categories, topics, and keywords — read and write."""

    def __init__(self, action_log: list):
        super().__init__(name="TopicControlToolkit", tools=[
            self.get_all_topics,
            self.get_topics,
            self.toggle_category,
            self.toggle_topic,
            self.add_category,
            self.delete_category,
            self.add_topic,
            self.delete_topic,
            self.add_topic_keyword,
            self.remove_topic_keyword,
            self.set_topic_keywords,
        ])
        self.action_log = action_log

    def get_all_topics(self) -> str:
        """Get ALL categories, topics, and keywords across ALL bots.
        Always call this first when the user asks about topics — never ask the user which bot."""
        db = get_db()
        all_bots = db.get_all_bots_config()
        result = {}
        for bot_name, bot in all_bots.items():
            bot_data = {}
            for cname, cat in (bot.get("categories") or {}).items():
                topics = {}
                for tname, topic in (cat.get("topics") or {}).items():
                    topics[tname] = {"enabled": topic.get("enabled", True), "keywords": topic.get("keywords", [])}
                bot_data[cname] = {"enabled": cat.get("enabled", True), "topics": topics}
            result[bot_name] = bot_data
        return json.dumps(result)

    def get_topics(self, bot_name: str) -> str:
        """Get all categories and topics for a specific bot, including keywords.

        Args:
            bot_name: Exact bot name.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot = all_bots.get(bot_name)
        if not bot:
            return _err(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")
        result = {}
        for cname, cat in (bot.get("categories") or {}).items():
            topics = {}
            for tname, topic in (cat.get("topics") or {}).items():
                topics[tname] = {"enabled": topic.get("enabled", True), "keywords": topic.get("keywords", [])}
            result[cname] = {"enabled": cat.get("enabled", True), "topics": topics}
        return json.dumps(result)

    def toggle_category(self, bot_name: str, category_name: str, enabled: bool) -> str:
        """Enable or disable a category (affects all its topics).

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            enabled: true to enable, false to disable.
        """
        db = get_db()
        try:
            bot_key, cat_key = _resolve_bot_category(db.get_all_bots_config(), bot_name, category_name)
        except ValueError as e:
            return _err(str(e))
        if not db.toggle_category(bot_key, cat_key, enabled):
            return _err(f"Toggle failed for {bot_key}/{cat_key}")
        self.action_log.append({
            "type": "toggle", "entity": "Category", "name": f"{bot_key}/{cat_key}",
            "old_value": not enabled, "new_value": enabled, "status": "success"
        })
        return _ok({"bot": bot_key, "category": cat_key, "enabled": enabled})

    def toggle_topic(self, bot_name: str, category_name: str, topic_name: str, enabled: bool) -> str:
        """Enable or disable a specific topic.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            topic_name: Topic name (case-insensitive, partial match).
            enabled: true to enable, false to disable.
        """
        db = get_db()
        try:
            bot_key, cat_key, topic_key = _resolve_topic(db.get_all_bots_config(), bot_name, category_name, topic_name)
        except ValueError as e:
            return _err(str(e))
        if not db.toggle_topic(bot_key, cat_key, topic_key, enabled):
            return _err(f"Toggle failed for {bot_key}/{cat_key}/{topic_key}")
        self.action_log.append({
            "type": "toggle", "entity": "Topic", "name": f"{bot_key}/{cat_key}/{topic_key}",
            "old_value": not enabled, "new_value": enabled, "status": "success"
        })
        return _ok({"bot": bot_key, "category": cat_key, "topic": topic_key, "enabled": enabled})

    def add_category(self, bot_name: str, category_name: str) -> str:
        """Add a new category to a bot.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Name for the new category.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot_key = None
        for k in all_bots:
            if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
                bot_key = k
                break
        if not bot_key:
            return _err(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")
        if not db.add_category(bot_key, category_name):
            return _err(f"Category '{category_name}' already exists in bot '{bot_key}'")
        self.action_log.append({
            "type": "add", "entity": "Category", "name": category_name,
            "detail": f"Added to bot {bot_key}", "status": "success"
        })
        return _ok({"bot": bot_key, "category": category_name})

    def delete_category(self, bot_name: str, category_name: str) -> str:
        """Delete a category and all its topics from a bot. Confirm with the user before calling this.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
        """
        db = get_db()
        try:
            bot_key, cat_key = _resolve_bot_category(db.get_all_bots_config(), bot_name, category_name)
        except ValueError as e:
            return _err(str(e))
        if not db.delete_category(bot_key, cat_key):
            return _err(f"Delete failed for {bot_key}/{cat_key}")
        self.action_log.append({
            "type": "delete", "entity": "Category", "name": f"{bot_key}/{cat_key}", "status": "success"
        })
        return _ok({"deleted": f"{bot_key}/{cat_key}"})

    def add_topic(self, bot_name: str, category_name: str, topic_name: str) -> str:
        """Add a new topic to a category.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            topic_name: Name for the new topic.
        """
        db = get_db()
        try:
            bot_key, cat_key = _resolve_bot_category(db.get_all_bots_config(), bot_name, category_name)
        except ValueError as e:
            return _err(str(e))
        if not db.add_topic(bot_key, cat_key, topic_name):
            return _err(f"Topic '{topic_name}' already exists in {bot_key}/{cat_key}")
        self.action_log.append({
            "type": "add", "entity": "Topic", "name": topic_name,
            "detail": f"Added to {bot_key}/{cat_key}", "status": "success"
        })
        return _ok({"bot": bot_key, "category": cat_key, "topic": topic_name})

    def delete_topic(self, bot_name: str, category_name: str, topic_name: str) -> str:
        """Delete a topic and all its keywords. Confirm with the user before calling this.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            topic_name: Topic name (case-insensitive, partial match).
        """
        db = get_db()
        try:
            bot_key, cat_key, topic_key = _resolve_topic(db.get_all_bots_config(), bot_name, category_name, topic_name)
        except ValueError as e:
            return _err(str(e))
        if not db.delete_topic(bot_key, cat_key, topic_key):
            return _err(f"Delete failed for {bot_key}/{cat_key}/{topic_key}")
        self.action_log.append({
            "type": "delete", "entity": "Topic", "name": f"{bot_key}/{cat_key}/{topic_key}", "status": "success"
        })
        return _ok({"deleted": f"{bot_key}/{cat_key}/{topic_key}"})

    def add_topic_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> str:
        """Add a keyword to a topic's keyword list. Validates exact names from DB before writing.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            topic_name: Topic name (case-insensitive, partial match).
            keyword: The keyword to add.
        """
        db = get_db()
        try:
            bot_key, cat_key, topic_key = _resolve_topic(db.get_all_bots_config(), bot_name, category_name, topic_name)
        except ValueError as e:
            return _err(str(e))
        inserted = db.add_keyword(bot_key, cat_key, topic_key, keyword)
        if not inserted:
            return _err(f"Keyword '{keyword}' already exists in {bot_key}/{cat_key}/{topic_key}")
        self.action_log.append({
            "type": "add", "entity": "Keyword", "name": keyword,
            "detail": f"Added to {bot_key}/{cat_key}/{topic_key}", "status": "success"
        })
        return _ok({"keyword": keyword, "bot": bot_key, "category": cat_key, "topic": topic_key})

    def remove_topic_keyword(self, bot_name: str, category_name: str, topic_name: str, keyword: str) -> str:
        """Remove a keyword from a topic's keyword list.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            topic_name: Topic name (case-insensitive, partial match).
            keyword: The exact keyword to remove.
        """
        db = get_db()
        try:
            bot_key, cat_key, topic_key = _resolve_topic(db.get_all_bots_config(), bot_name, category_name, topic_name)
        except ValueError as e:
            return _err(str(e))
        deleted = db.delete_keyword(bot_key, cat_key, topic_key, keyword)
        if not deleted:
            existing = db.get_topic_keywords(bot_key, cat_key, topic_key)
            return _err(f"Keyword '{keyword}' not found in {bot_key}/{cat_key}/{topic_key}. Existing: {existing}")
        self.action_log.append({
            "type": "delete", "entity": "Keyword", "name": keyword,
            "detail": f"Removed from {bot_key}/{cat_key}/{topic_key}", "status": "success"
        })
        return _ok({"removed": keyword, "bot": bot_key, "category": cat_key, "topic": topic_key})

    def set_topic_keywords(self, bot_name: str, category_name: str, topic_name: str, keywords: list) -> str:
        """Replace ALL keywords for a topic with a new list. Use this to bulk-set keywords.

        Args:
            bot_name: Bot name (case-insensitive, partial match).
            category_name: Category name (case-insensitive, partial match).
            topic_name: Topic name (case-insensitive, partial match).
            keywords: Full list of keywords to set (replaces existing).
        """
        db = get_db()
        try:
            bot_key, cat_key, topic_key = _resolve_topic(db.get_all_bots_config(), bot_name, category_name, topic_name)
        except ValueError as e:
            return _err(str(e))
        db.set_topic_keywords(bot_key, cat_key, topic_key, keywords)
        self.action_log.append({
            "type": "update", "entity": "Keywords", "name": f"{bot_key}/{cat_key}/{topic_key}",
            "detail": f"Set {len(keywords)} keywords", "status": "success"
        })
        return _ok({"bot": bot_key, "category": cat_key, "topic": topic_key, "keywords": keywords})


# ===========================================================================
# ScheduleControlToolkit
# ===========================================================================

class ScheduleControlToolkit(Toolkit):
    """Read and modify topic schedules (when summaries are generated and sent)."""

    def __init__(self, action_log: list):
        super().__init__(name="ScheduleControlToolkit", tools=[
            self.get_topic_schedules,
            self.add_topic_schedule,
            self.update_topic_schedule,
            self.delete_topic_schedule,
            self.toggle_topic_schedule,
        ])
        self.action_log = action_log

    def get_topic_schedules(self, bot_name: str = "", category_name: str = "", topic_name: str = "") -> str:
        """Get schedules for a topic, category, or all topics.
        Leave all blank to get every schedule across all bots.
        Each schedule has: id, name, type, enabled, prompt_key, minute/hour/hours/start_hour/start_minute, telegram_targets.

        Args:
            bot_name: Bot name filter (optional, partial match).
            category_name: Category name filter (optional, partial match).
            topic_name: Topic name filter (optional, partial match).

        Returns:
            JSON list of schedule objects with their topic/category/bot context.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        results = []
        for bn, bot in all_bots.items():
            if bot_name and bot_name.lower() not in bn.lower():
                continue
            for cn, cat in (bot.get("categories") or {}).items():
                if category_name and category_name.lower() not in cn.lower():
                    continue
                for tn, topic in (cat.get("topics") or {}).items():
                    if topic_name and topic_name.lower() not in tn.lower():
                        continue
                    for sch in (topic.get("schedules") or []):
                        results.append({
                            "bot": bn, "category": cn, "topic": tn,
                            **sch,
                        })
        return json.dumps(results)

    def add_topic_schedule(self, bot_name: str, category_name: str, topic_name: str,
                           schedule_type: str, name: str = "",
                           enabled: bool = True, prompt_key: str = "",
                           telegram_targets: list = None,
                           minute: int = None, hour: int = None,
                           hours: int = None, start_hour: int = None, start_minute: int = None) -> str:
        """Add a new schedule to a topic.

        Schedule types:
          - 'hourly'   — runs every hour at :MM (set minute=30 for :30)
          - 'daily'    — runs once per day (set hour and minute)
          - 'minute'   — runs every N minutes (set minute=N)
          - 'interval_hourly' — runs every N hours (set hours, start_hour, start_minute)

        Args:
            bot_name: Bot name (partial match).
            category_name: Category name (partial match).
            topic_name: Topic name (partial match).
            schedule_type: One of 'hourly', 'daily', 'minute', 'interval_hourly'.
            name: Display name for the schedule (optional).
            enabled: Whether the schedule is active (default True).
            prompt_key: Prompt key to use for summary generation (optional).
            telegram_targets: List of Telegram channel usernames to send to.
            minute: Minute field (meaning depends on type).
            hour: Hour field for daily schedules.
            hours: Interval hours for interval schedules.
            start_hour: Start hour for interval schedules.
            start_minute: Start minute for interval schedules.

        Returns:
            JSON with new schedule id or error.
        """
        db = get_db()
        try:
            bot_key, cat_key, topic_key = _resolve_topic(db.get_all_bots_config(), bot_name, category_name, topic_name)
        except ValueError as e:
            return _err(str(e))
        schedule = {
            "name": name or schedule_type,
            "type": schedule_type,
            "enabled": enabled,
            "prompt_key": prompt_key or None,
            "telegram_targets": telegram_targets or [],
        }
        if minute is not None:
            schedule["minute"] = minute
        if hour is not None:
            schedule["hour"] = hour
        if hours is not None:
            schedule["hours"] = hours
        if start_hour is not None:
            schedule["start_hour"] = start_hour
        if start_minute is not None:
            schedule["start_minute"] = start_minute
        sch_id = db.add_schedule(bot_key, cat_key, topic_key, schedule)
        if not sch_id:
            return _err("Failed to create schedule — topic not found")
        self.action_log.append({
            "type": "add", "entity": "Schedule", "name": schedule["name"],
            "detail": f"Added to {bot_key}/{cat_key}/{topic_key}", "status": "success"
        })
        return _ok({"id": sch_id, "bot": bot_key, "category": cat_key, "topic": topic_key, "schedule": schedule})

    def update_topic_schedule(self, schedule_id: int, name: str = None, enabled: bool = None,
                              prompt_key: str = None, telegram_targets: list = None,
                              minute: int = None, hour: int = None,
                              hours: int = None, start_hour: int = None, start_minute: int = None) -> str:
        """Update fields on an existing schedule by its ID.
        Only the fields you pass will be changed; omit a field to leave it unchanged.

        Args:
            schedule_id: Schedule ID (from get_topic_schedules).
            name: New display name (optional).
            enabled: Enable or disable the schedule (optional).
            prompt_key: New prompt key (optional).
            telegram_targets: New list of Telegram targets (optional).
            minute / hour / hours / start_hour / start_minute: Timing fields (optional).

        Returns:
            JSON status or error.
        """
        db = get_db()
        updates = {}
        if name is not None:
            updates["name"] = name
        if enabled is not None:
            updates["enabled"] = enabled
        if prompt_key is not None:
            updates["prompt_key"] = prompt_key
        if telegram_targets is not None:
            updates["telegram_targets"] = telegram_targets
        if minute is not None:
            updates["minute"] = minute
        if hour is not None:
            updates["hour"] = hour
        if hours is not None:
            updates["hours"] = hours
        if start_hour is not None:
            updates["start_hour"] = start_hour
        if start_minute is not None:
            updates["start_minute"] = start_minute
        if not updates:
            return _err("No fields to update provided")
        if not db.update_schedule(schedule_id, updates):
            return _err(f"Schedule #{schedule_id} not found or update failed")
        self.action_log.append({
            "type": "update", "entity": "Schedule", "name": str(schedule_id),
            "detail": f"Updated fields: {list(updates.keys())}", "status": "success"
        })
        return _ok({"id": schedule_id, "updated": list(updates.keys())})

    def delete_topic_schedule(self, schedule_id: int) -> str:
        """Delete a schedule by its ID. Confirm with the user before calling this.

        Args:
            schedule_id: Schedule ID (from get_topic_schedules).

        Returns:
            JSON status or error.
        """
        db = get_db()
        if not db.delete_schedule(schedule_id):
            return _err(f"Schedule #{schedule_id} not found")
        self.action_log.append({
            "type": "delete", "entity": "Schedule", "name": str(schedule_id), "status": "success"
        })
        return _ok({"deleted_id": schedule_id})

    def toggle_topic_schedule(self, schedule_id: int, enabled: bool) -> str:
        """Enable or disable a schedule without touching other fields.

        Args:
            schedule_id: Schedule ID (from get_topic_schedules).
            enabled: true to enable, false to disable.

        Returns:
            JSON status or error.
        """
        db = get_db()
        if not db.update_schedule(schedule_id, {"enabled": enabled}):
            return _err(f"Schedule #{schedule_id} not found")
        self.action_log.append({
            "type": "toggle", "entity": "Schedule", "name": str(schedule_id),
            "old_value": not enabled, "new_value": enabled, "status": "success"
        })
        return _ok({"id": schedule_id, "enabled": enabled})


# ===========================================================================
# PromptControlToolkit
# ===========================================================================

class PromptControlToolkit(Toolkit):
    """Read and modify bot prompts (templates used during summary generation)."""

    def __init__(self, action_log: list):
        super().__init__(name="PromptControlToolkit", tools=[
            self.get_all_prompts,
            self.get_bot_prompts,
            self.set_prompt,
            self.delete_prompt,
        ])
        self.action_log = action_log

    def get_all_prompts(self) -> str:
        """Get all prompts across all bots.

        Returns:
            JSON dict: {bot_name: {prompt_key: {text: "..."}}}
        """
        db = get_db()
        return json.dumps(db.get_all_prompts(), ensure_ascii=False)

    def get_bot_prompts(self, bot_name: str) -> str:
        """Get all prompts for a specific bot.

        Args:
            bot_name: Bot name (case-insensitive, partial match supported).

        Returns:
            JSON dict: {prompt_key: {text: "..."}} or error.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot_key = None
        for k in all_bots:
            if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
                bot_key = k
                break
        if not bot_key:
            return _err(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")
        return json.dumps(db.get_bot_prompts(bot_key), ensure_ascii=False)

    def set_prompt(self, bot_name: str, prompt_key: str, text: str) -> str:
        """Create or update a prompt for a bot. Use this to add new prompts or edit existing ones.

        Args:
            bot_name: Bot name (case-insensitive, partial match supported).
            prompt_key: The prompt key/name (e.g. 'daily_summary', 'breaking_news').
            text: The full prompt text.

        Returns:
            JSON status or error.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot_key = None
        for k in all_bots:
            if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
                bot_key = k
                break
        if not bot_key:
            return _err(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")
        # Prompts are global now — store with the legacy "bot/key" naming so
        # the agent can still target a specific bot's prompt by name.
        global_key = f"{bot_key}/{prompt_key}" if '/' not in prompt_key else prompt_key
        existing = db.get_prompts_by_type('summaries')
        action = "update" if global_key in existing else "add"
        db.save_prompt(global_key, text, prompt_type='summaries')
        self.action_log.append({
            "type": action, "entity": "Prompt",
            "name": global_key,
            "detail": f"{len(text)} chars", "status": "success"
        })
        return _ok({"bot": bot_key, "key": global_key, "action": action})

    def delete_prompt(self, bot_name: str, prompt_key: str) -> str:
        """Delete a prompt from a bot. Confirm with the user before calling this.

        Args:
            bot_name: Bot name (case-insensitive, partial match supported).
            prompt_key: The prompt key to delete.

        Returns:
            JSON status or error.
        """
        db = get_db()
        all_bots = db.get_all_bots_config()
        bot_key = None
        for k in all_bots:
            if k.lower() == bot_name.lower() or bot_name.lower() in k.lower():
                bot_key = k
                break
        if not bot_key:
            return _err(f"Bot '{bot_name}' not found. Available: {list(all_bots.keys())}")
        global_key = f"{bot_key}/{prompt_key}" if '/' not in prompt_key else prompt_key
        prompts = db.get_prompts_by_type('summaries')
        if global_key not in prompts:
            return _err(f"Prompt '{global_key}' not found. Existing: {list(prompts.keys())}")
        db.delete_prompt(global_key, prompt_type='summaries')
        self.action_log.append({
            "type": "delete", "entity": "Prompt",
            "name": global_key, "status": "success"
        })
        return _ok({"deleted": global_key})


# ===========================================================================
# YouTubeControlToolkit
# ===========================================================================

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

    def _resolve_channel(self, channels: list, name_or_id: str):
        """Find channel by id or name (case-insensitive)."""
        for ch in channels:
            if (ch.get("channel_id", "").lower() == name_or_id.lower()
                    or name_or_id.lower() in (ch.get("channel_name") or "").lower()):
                return ch
        return None

    def _resolve_keyword(self, keywords: list, name_or_id) -> dict | None:
        """Find keyword by id (int) or keyword text (case-insensitive)."""
        for kw in keywords:
            if str(kw.get("id")) == str(name_or_id):
                return kw
            if isinstance(name_or_id, str) and name_or_id.lower() in kw.get("keyword", "").lower():
                return kw
        return None

    def get_yt_channels(self) -> str:
        """Get all YouTube channels with their active status and settings."""
        yt_db = get_yt_db()
        channels = yt_db.get_channels()
        result = [
            {
                "channel_id": ch.get("channel_id"),
                "channel_name": ch.get("channel_name"),
                "active": ch.get("active", True),
                "telegram_targets": ch.get("telegram_targets"),
            }
            for ch in channels
        ]
        return json.dumps(result)

    def toggle_yt_channel(self, channel: str, active: bool) -> str:
        """Enable or disable a YouTube channel by name or ID.

        Args:
            channel: Channel name or channel_id (partial match supported).
            active: true to enable, false to disable.
        """
        yt_db = get_yt_db()
        ch = self._resolve_channel(yt_db.get_channels(), channel)
        if not ch:
            return _err(f"Channel '{channel}' not found. Call get_yt_channels to see available channels.")
        old = ch.get("active", True)
        yt_db.toggle_channel(ch["channel_id"], active)
        name = ch.get("channel_name") or ch["channel_id"]
        self.action_log.append({
            "type": "toggle", "entity": "YouTube Channel", "name": name,
            "old_value": old, "new_value": active, "status": "success"
        })
        return _ok({"channel": name, "active": active})

    def get_yt_keywords(self) -> str:
        """Get all YouTube keyword trackers with their active status and schedule."""
        yt_db = get_yt_db()
        keywords = yt_db.get_keywords()
        result = [
            {
                "id": kw.get("id"),
                "keyword": kw.get("keyword"),
                "active": kw.get("active", True),
                "schedule_interval_minutes": kw.get("schedule_interval_minutes"),
                "telegram_targets": kw.get("telegram_targets"),
                "last_run_at": str(kw.get("last_run_at") or "never"),
            }
            for kw in keywords
        ]
        return json.dumps(result)

    def toggle_yt_keyword(self, keyword: str, active: bool) -> str:
        """Enable or disable a YouTube keyword tracker by name or ID.

        Args:
            keyword: Keyword text or numeric ID (partial match on text supported).
            active: true to enable, false to disable.
        """
        yt_db = get_yt_db()
        kw = self._resolve_keyword(yt_db.get_keywords(), keyword)
        if not kw:
            return _err(f"Keyword '{keyword}' not found. Call get_yt_keywords to see available keywords.")
        old = kw.get("active", True)
        yt_db.toggle_keyword(kw["id"], active)
        name = kw.get("keyword", str(kw["id"]))
        self.action_log.append({
            "type": "toggle", "entity": "YouTube Keyword", "name": name,
            "old_value": old, "new_value": active, "status": "success"
        })
        return _ok({"keyword": name, "active": active})

    def add_yt_keyword(self, keyword: str, telegram_targets: str = "",
                       schedule_interval_minutes: int = 360) -> str:
        """Add a new YouTube keyword tracker.

        Args:
            keyword: The keyword text to track.
            telegram_targets: Comma-separated Telegram channel usernames to send results to.
            schedule_interval_minutes: How often to run the search (default 360 = 6 hours).
        """
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
            "detail": f"Every {schedule_interval_minutes} min", "status": "success"
        })
        return _ok({"keyword": keyword, "schedule_interval_minutes": schedule_interval_minutes})

    def delete_yt_keyword(self, keyword: str) -> str:
        """Delete a YouTube keyword tracker by name or ID. Confirm with user first.

        Args:
            keyword: Keyword text or numeric ID (partial match on text).
        """
        yt_db = get_yt_db()
        kw = self._resolve_keyword(yt_db.get_keywords(), keyword)
        if not kw:
            return _err(f"Keyword '{keyword}' not found. Call get_yt_keywords to see available keywords.")
        name = kw.get("keyword", str(kw["id"]))
        yt_db.delete_keyword(kw["id"])
        self.action_log.append({
            "type": "delete", "entity": "YouTube Keyword", "name": name, "status": "success"
        })
        return _ok({"deleted": name})

    def run_yt_keyword(self, keyword: str) -> str:
        """Manually trigger a YouTube keyword search right now.

        Args:
            keyword: Keyword text or numeric ID (partial match on text).
        """
        yt_db = get_yt_db()
        kw = self._resolve_keyword(yt_db.get_keywords(), keyword)
        if not kw:
            return _err(f"Keyword '{keyword}' not found. Call get_yt_keywords to see available keywords.")
        name = kw.get("keyword", str(kw["id"]))
        from youtube_monitor.keyword_search import run_keyword_search
        try:
            count = run_keyword_search(kw)
            self.action_log.append({
                "type": "run", "entity": "YouTube Keyword", "name": name,
                "detail": f"Found {count} new video(s)", "status": "success"
            })
            return _ok({"keyword": name, "new_videos": count})
        except Exception as e:
            self.action_log.append({
                "type": "run", "entity": "YouTube Keyword", "name": name,
                "detail": str(e), "status": "error"
            })
            return _err(str(e))
