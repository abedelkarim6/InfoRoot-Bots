"""
Telegram userbot that generates scheduled summaries using OpenAI/Gemini.
Runs as a user account (MTProto via Telethon) instead of a bot.
"""
import os
import re
import sys
import asyncio

# Force UTF-8 on Windows so log messages with Unicode (→, emojis, Arabic, etc.) don't crash.
# errors='replace' means any still-unencodable char becomes ? instead of raising.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from utils.database import Database, set_db_instance
from utils.openai_client import OpenAIClient
from utils.gemini_client import GeminiClient
from utils.prompts import get_summary_prompt
from utils.helpers import load_config, setup_logging, categorizer

import datetime
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.types import Channel as TelegramChannel
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.errors import UserAlreadyParticipantError, InviteHashInvalidError, ChannelPrivateError


# ==================== UTF-8 Config ====================
# Force UTF-8 encoding on Windows to handle Arabic/emoji text
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')

# ==================== Global Variables ====================
config = load_config()
logger = setup_logging(config)

# Initialize components
db = Database(config["database"]["dsn"])
set_db_instance(db)
db.seed_keywords_from_config(config)
if not config.get("gemini"):
    llm_client = OpenAIClient(
        api_key=config["openai"]["api_key"],
        model=config["openai"]["model"],
        max_tokens=config["openai"]["max_tokens"],
        temperature=config["openai"]["temperature"]
    )
else:
    llm_client = GeminiClient(
        api_key=config["gemini"]["api_key"],
        model=config["gemini"].get("model"))

# Telegram userbot settings
API_ID = config["telegram"]["api_id"]
API_HASH = config["telegram"]["api_hash"]
STRING_SESSION = config["telegram"].get("string_session")  # fallback; DB value preferred at runtime

SCHEDULER = None
client: TelegramClient = None  # Set in main()

# Pre-resolved map: numeric_channel_id → [collection_names]
# Built at startup and rebuilt on every config change.
# Avoids username-based matching which breaks for private channels (no username).
_source_channel_map: dict = {}

_ARABIC_DIGITS = str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩')

def _to_arabic_numerals(s: str) -> str:
    return s.translate(_ARABIC_DIGITS)


async def _try_join_channel(ch_identifier: str):
    """
    Attempt to join a channel by @username or invite link.
    Silently ignores if already a member or if it's a numeric ID (already joined).
    """
    stripped = ch_identifier.strip()

    # Numeric ID — we're already a member, nothing to do
    if stripped.lstrip('-').isdigit():
        return

    # Invite link: t.me/+HASH or t.me/joinchat/HASH
    if '+' in stripped or 'joinchat' in stripped:
        try:
            # Extract just the hash portion
            hash_part = stripped.split('+')[-1] if '+' in stripped else stripped.split('joinchat/')[-1]
            hash_part = hash_part.split('?')[0].strip('/')
            await client(ImportChatInviteRequest(hash_part))
            # logger.info(f"[JOIN] Joined via invite link: {stripped}")
        except UserAlreadyParticipantError:
            pass
        except InviteHashInvalidError:
            # logger.warning(f"[JOIN] Invalid invite hash: {stripped}")
            pass
        except Exception as e:
            # logger.warning(f"[JOIN] Could not join via invite '{stripped}': {e}")
            pass
        return

    # @username channel
    try:
        await client(JoinChannelRequest(stripped))
        # logger.info(f"[JOIN] Joined channel: {stripped}")
    except UserAlreadyParticipantError:
        pass
    except ChannelPrivateError:
        # logger.warning(f"[JOIN] Channel is private (invite needed): {stripped}")
        pass
    except Exception as e:
        # logger.warning(f"[JOIN] Could not join '{stripped}': {e}")
        pass


async def build_source_channel_map():
    """
    Resolve every source_channel in the DB collections to its numeric Telegram ID.
    Handles @username, @+invitelink, and plain numeric IDs.
    Auto-joins any channel the userbot is not already a member of.
    Updates the module-level _source_channel_map dict in-place.
    """
    global _source_channel_map
    new_map: dict = {}
    collections_cfg = db.get_all_collections()
    for coll_name, coll_data in collections_cfg.items():
        for ch_identifier in coll_data.get('source_channels', []):
            if not ch_identifier:
                continue
            try:
                await _try_join_channel(ch_identifier)
                entity = await client.get_entity(ch_identifier)
                num_id = entity.id
                if num_id not in new_map:
                    new_map[num_id] = []
                if coll_name not in new_map[num_id]:
                    new_map[num_id].append(coll_name)
            except Exception as e:
                logger.warning(f"[CHANNEL_MAP] Failed to resolve {ch_identifier}: {e}")
    _source_channel_map = new_map


async def save_dialogs_to_db():
    """
    Iterate all userbot dialogs and cache them in the DB.
    Called at startup so the channel validator UI can show membership
    without needing to open a second Telegram connection.
    """
    # logger.info("[DIALOGS] Fetching dialog list from Telegram…")
    try:
        channels = []
        async for dialog in client.iter_dialogs(limit=500):
            entity = dialog.entity
            if not isinstance(entity, TelegramChannel):
                continue
            channels.append({
                'id':           entity.id,
                'title':        entity.title,
                'username':     getattr(entity, 'username', None),
                'is_broadcast': bool(getattr(entity, 'broadcast', False)),
                'is_megagroup': bool(getattr(entity, 'megagroup', False)),
            })
        db.save_userbot_dialogs(channels)
        # logger.info(f"[DIALOGS] Cached {len(channels)} dialogs to DB")
    except Exception as e:
        logger.warning(f"[DIALOGS] Failed to cache dialogs: {e}")


# ==================== Message Handler ====================
async def read_channel_messages(event):
    """
    Handle incoming channel posts: save to database.
    Only processes broadcast channels (not groups/supergroups).
    """
    try:
        # Skip private/DM messages — they are never source channels
        if getattr(event, 'is_private', False):
            return

        chat = await event.get_chat()

        channel_id_numeric = chat.id
        channel_title = getattr(chat, 'title', '')
        channel_username = getattr(chat, 'username', None)
        channel_id = channel_username  # Used for collection matching

        text_intro = (event.message.message or event.message.text or '')[:80].replace('\n', ' ')
        # logger.info(f"[MSG] RECEIVED | id={channel_id_numeric} | @{channel_id} ({channel_title}) | \"{text_intro}\"")

        # Step 1: Find which collections include this channel as a source.
        # Use the pre-resolved numeric-ID map (handles private channels, invite links, etc.).
        # Fall back to username matching for any channels not yet in the map.
        matching_collections = list(_source_channel_map.get(channel_id_numeric, []))

        if not matching_collections and channel_username:
            collections_cfg = db.get_all_collections()
            for coll_name, coll_data in collections_cfg.items():
                source_channels = coll_data.get('source_channels', [])
                if channel_username in source_channels or f'@{channel_username}' in source_channels:
                    matching_collections.append(coll_name)

        if not matching_collections:
            # logger.warning(
            #     f"[SKIP] id={channel_id_numeric} (@{channel_id}) not in any collection — "
            #     f"map has {len(_source_channel_map)} entries {list(_source_channel_map.keys())}, "
            #     f"configured collections: {list(collections_cfg.keys())}"
            # )
            return

        # Step 2: Find which bots reference those collections
        bots_cfg = db.get_all_bots_config()
        matching_bots = [
            bname for bname, bcfg in bots_cfg.items()
            if bcfg.get('enabled', True)
            and any(coll in matching_collections for coll in bcfg.get('collections', []))
        ]

        if not matching_bots:
            # logger.warning(
            #     f"[SKIP] @{channel_id} → collections {matching_collections} not referenced "
            #     f"by any enabled bot — configured bots: {list(bots_cfg.keys())}"
            # )
            return

        # logger.info(f"[MATCH] @{channel_id} → Collections: {matching_collections} | Bots: {matching_bots}")

        # Extract text (text or caption for media messages)
        text = event.message.message or event.message.text

        if not text:
            # logger.warning(f"[SKIP] No text in message from @{channel_id}")
            return

        original_text = text
        collection_name_str = ",".join(matching_collections) if matching_collections else None

        for bot_name in matching_bots:
            # ── Per-bot rules ────────────────────────────────────────────
            bot_cfg_rules = bots_cfg.get(bot_name, {}).get('rules', {}) or {}

            # Remove rules: skip this bot if any keyword matches
            skipped = False
            for kw in bot_cfg_rules.get('remove', []):
                if not kw:
                    continue
                try:
                    if re.search(rf"\b{re.escape(kw)}\b", text, re.IGNORECASE):
                        # logger.info(f"[RULE] Remove rule '{kw}' matched — skipping Bot: {bot_name} | @{channel_id}")
                        skipped = True
                        break
                except re.error:
                    if kw in text:
                        # logger.info(f"[RULE] Remove rule '{kw}' matched — skipping Bot: {bot_name} | @{channel_id}")
                        skipped = True
                        break
            if skipped:
                continue

            # Replace rules: build per-bot replaced text
            replaced_text = text
            for rule in bot_cfg_rules.get('replace', []):
                match_word = rule.get('match')
                repl = rule.get('replace_with', '')
                if not match_word:
                    continue
                try:
                    replaced_text = re.sub(rf"\b{re.escape(match_word)}\b", repl, replaced_text, flags=re.IGNORECASE)
                except re.error:
                    replaced_text = replaced_text.replace(match_word, repl)
            # ─────────────────────────────────────────────────────────────

            topics, categories, keywords = categorizer(replaced_text, bot_name, db)

            # if not topics:
            #     logger.info(f"[CATEG] No topics matched | Bot: {bot_name} | @{channel_id} → {matching_collections}")
            # else:
            #     kw_display = keywords[:5] if keywords else []
            #     kw_extra = f" (+{len(keywords)-5} more)" if keywords and len(keywords) > 5 else ""
            #     logger.info(
            #         f"[CATEG] Bot: {bot_name} | @{channel_id} → {matching_collections} | "
            #         f"Topics: {topics} | Categories: {categories} | "
            #         f"Keywords [{len(keywords or [])}]: {kw_display}{kw_extra}"
            #     )

            message_id = db.add_message(
                channel_id=channel_id_numeric,
                text=replaced_text,
                countries=None,
                regions=None,
                topics=topics,
                categories=categories,
                keywords=keywords,
                bot_name=bot_name,
                original_text=original_text,
                replaced_text=replaced_text,
                channel_username=channel_username,
                collection_name=collection_name_str
            )
            # logger.info(f"[SAVED] msg#{message_id} | Bot: {bot_name} | @{channel_id} → {matching_collections}")

    except Exception as e:
        logger.error(f"Error in read_channel_messages: {e}", exc_info=True)


# ==================== Schedule Window Helper ====================
def _compute_window_start(job_data) -> datetime.datetime:
    """
    Return the exact previous scheduled fire time so that only messages
    received after that moment are included in the current summary.

    Uses schedule anchor fields stored in job_data at scheduling time:
      sch_start_hour, sch_start_minute  – anchor origin for interval schedules
      sch_hours / sch_minutes           – interval length
      sch_hour / sch_minute             – target hour/minute for daily/hourly
    """
    import math

    schedule_type = job_data.get('schedule_type', '')
    now = datetime.datetime.now()

    try:
        if schedule_type == 'interval':
            # Interval in hours anchored to (start_hour, start_minute)
            start_h = int(job_data.get('sch_start_hour') or 0)
            start_m = int(job_data.get('sch_start_minute') or 0)
            hours   = int(job_data.get('sch_hours') or 1)

            # Build anchor as today's start time; if it's in the future, go back one day
            anchor = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
            if anchor > now:
                anchor -= datetime.timedelta(days=1)

            # How many complete intervals have elapsed since the anchor?
            elapsed_seconds = (now - anchor).total_seconds()
            n = math.floor(elapsed_seconds / (hours * 3600))
            window_start = anchor + datetime.timedelta(hours=n * hours)
            return window_start

        elif schedule_type == 'interval_minutes':
            start_h = int(job_data.get('sch_start_hour') or 0)
            start_m = int(job_data.get('sch_start_minute') or 0)
            minutes = int(job_data.get('sch_minutes') or 1)

            anchor = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
            if anchor > now:
                anchor -= datetime.timedelta(days=1)

            elapsed_seconds = (now - anchor).total_seconds()
            n = math.floor(elapsed_seconds / (minutes * 60))
            window_start = anchor + datetime.timedelta(minutes=n * minutes)
            return window_start

        elif schedule_type == 'hourly':
            # Every hour at :MM
            target_m = int(job_data.get('sch_minute') or 0)
            candidate = now.replace(minute=target_m, second=0, microsecond=0)
            if candidate > now:
                candidate -= datetime.timedelta(hours=1)
            return candidate

        elif schedule_type == 'daily':
            target_h = int(job_data.get('sch_hour') or 0)
            target_m = int(job_data.get('sch_minute') or 0)
            candidate = now.replace(hour=target_h, minute=target_m, second=0, microsecond=0)
            if candidate > now:
                candidate -= datetime.timedelta(days=1)
            return candidate

        elif schedule_type == 'minute':
            # Every N minutes — floor current minutes to nearest N
            n = int(job_data.get('sch_minute') or 1)
            floored_m = (now.minute // n) * n
            window_start = now.replace(minute=floored_m, second=0, microsecond=0)
            return window_start

    except Exception as e:
        logger.warning(f"[WINDOW] Could not compute window_start for {job_data}: {e}")

    # Fallback: last 24 hours
    return now - datetime.timedelta(hours=24)


# ==================== Summary Handler ====================
async def generate_and_send_summary(job_data):
    """
    Generate and send summaries for topics based on their schedules.
    job_data: { 'schedule_type': str, 'bot_name': str, 'topic_name': str, 'category_name': str, 'prompt_key': str }
    """
    schedule_type = job_data.get('schedule_type')
    bot_name = job_data.get('bot_name')
    topic_name = job_data.get('topic_name')
    category_name = job_data.get('category_name')
    prompt_key = job_data.get('prompt_key')

    if not all([schedule_type, bot_name, topic_name, prompt_key]):
        logger.error(f"Missing required job data: {job_data}")
        return

    try:
        # Get unsummarized messages for this specific (bot, topic, schedule_type)
        messages = db.get_messages_for_schedule(schedule_type, bot_name, topic_name)

        # Filter to only messages that actually have this topic in their topics list
        topic_messages = []
        for msg in messages:
            if msg.get('topics'):
                msg_topics = [t.strip() for t in msg['topics'].split(',')]
                if topic_name in msg_topics:
                    topic_messages.append(msg)

        if not topic_messages:
            return

        # ── Time-window enforcement ──────────────────────────────────────────
        # Only messages received within the schedule's interval window are eligible.
        # window_start is anchored to the PREVIOUS scheduled fire time so the window
        # is always [prev_fire_time, now], not a rolling "last N seconds".
        window_start = _compute_window_start(job_data)

        in_window = []
        expired   = []
        for msg in topic_messages:
            ts = msg.get('timestamp')
            if ts:
                # timestamp may be a string (ISO) or datetime object
                if isinstance(ts, str):
                    try:
                        ts = datetime.datetime.fromisoformat(ts)
                    except ValueError:
                        ts = None
                if ts and ts < window_start:
                    expired.append(msg)
                    continue
            in_window.append(msg)

        # Permanently mark expired messages so they are never reconsidered
        if expired:
            expired_ids = [m['id'] for m in expired]
            db.mark_as_missed(expired_ids, schedule_type, bot_name, topic_name)
            logger.info(f"[MISSED] {len(expired_ids)} messages outside window marked as missed | "
                        f"Bot: {bot_name} | Topic: {topic_name} | window_start: {window_start}")

        topic_messages = in_window
        if not topic_messages:
            return

        # Check minimum messages requirement
        bots_cfg = db.get_all_bots_config()
        bot_cfg = bots_cfg.get(bot_name, {})
        min_messages = bot_cfg.get('minimum_messages', 1)
        if len(topic_messages) < min_messages:
            # logger.info(f"[SKIP]  SKIP | Not enough messages ({len(topic_messages)}/{min_messages}) | Bot: {bot_name} | Topic: {topic_name}")
            return

        # logger.info(f"[SUMMARY] SUMMARY TASK START | Bot: {bot_name} | Topic: {topic_name} | Schedule: {schedule_type} | Messages: {len(topic_messages)}")

        # Extract message texts
        texts = [m['text'] for m in topic_messages]

        # Generate summary using bot-specific prompt
        prompt = get_summary_prompt(texts, bot_name, prompt_key, topic_name=topic_name)

        # logger.info(f"[AI] SUMMARY GENERATION | Bot: {bot_name} | Topic: {topic_name} | Prompt: {prompt_key} | Messages: {len(texts)}")
        summary_text = llm_client.generate_summary(prompt)

        # Get target channels: per-schedule override, or fall back to bot's collections
        schedule_targets = [t for t in job_data.get('telegram_targets', []) if t]
        if schedule_targets:
            target_channels = list(set(schedule_targets))
            logger.info(f"[TARGETS] Using schedule targets for {bot_name}/{topic_name}: {target_channels}")
        else:
            bot_collections = bot_cfg.get('collections', [])
            collections_cfg = db.get_all_collections()
            target_channels = []
            for coll_name in bot_collections:
                if coll_name in collections_cfg:
                    targets = collections_cfg[coll_name].get('target_channels', [])
                    target_channels.extend(targets)
            target_channels = list(set(target_channels))

        if not target_channels:
            logger.warning(f"No target channels found for bot {bot_name}")
            return

        # Build message text — use per-schedule header (defaults to *schedule_name*)
        header_text = job_data.get('header', '').strip()
        if header_text:
            # Optionally append date-time line under the header
            if job_data.get('header_datetime'):
                ar_days = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد']
                now = datetime.datetime.now()
                day_name = ar_days[now.weekday()]
                hour_12 = now.hour % 12 or 12
                am_pm = 'ص' if now.hour < 12 else 'م'

                date_str = f"{now.year}/{now.month:02d}/{now.day:02d}"
                time_str = f"{hour_12:02d}:{now.minute:02d} {am_pm}"

                if job_data.get('header_date_arabic'):
                    date_str = _to_arabic_numerals(date_str)
                if job_data.get('header_time_arabic'):
                    time_str = _to_arabic_numerals(time_str)

                dt_line = f"{day_name} {date_str}  ؛  {time_str}"
                header_text = f"{header_text}\n{dt_line}"
            message_text = f"{header_text}\n{'—'*20}\n\n{summary_text}"
        else:
            message_text = summary_text

        # Send summary to all target channels using the userbot client
        msg_ids = [m['id'] for m in topic_messages]
        for target_chat in target_channels:
            try:
                await client.send_message(target_chat, message_text, parse_mode='md')
                # logger.info(f"[SENT] SUMMARY SENT | Bot: {bot_name} | Topic: {topic_name} | Target: {target_chat}")
                db.save_summary(
                    summary_text=summary_text,
                    message_count=len(topic_messages),
                    summary_type=schedule_type,
                    target_entity=str(target_chat),
                    bot_name=bot_name,
                    topic_name=topic_name,
                    message_ids=msg_ids
                )
            except Exception as e:
                logger.error(f"Failed to send summary to {target_chat}: {e}")

        # Mark messages as summarized for this specific (bot, topic, schedule_type)
        db.mark_as_summarized(msg_ids, schedule_type, bot_name, topic_name)
        # logger.info(f"[DONE]  MARKED AS SUMMARIZED | Bot: {bot_name} | Topic: {topic_name} | Count: {len(msg_ids)} messages")

    except Exception as e:
        logger.error(f"Critical error in summary generation: {e}", exc_info=True)

async def trigger_summary(job_data):
    """Trigger summary generation with complete job data."""
    try:
        await generate_and_send_summary(job_data)
    except Exception as e:
        logger.error(f"[ERROR] trigger_summary failed | Bot: {job_data.get('bot_name')} | Topic: {job_data.get('topic_name')} | Error: {e}", exc_info=True)

async def schedule_summaries():
    """
    Set up APScheduler jobs for all enabled topic schedules.
    Iterates through: bots → categories → topics → schedules
    """
    global SCHEDULER
    if SCHEDULER and SCHEDULER.running:
        SCHEDULER.remove_all_jobs()
    else:
        SCHEDULER = AsyncIOScheduler()
        SCHEDULER.start()

    bots_cfg = db.get_all_bots_config()

    if not bots_cfg:
        # logger.warning("No bots configured")
        return

    job_count = 0

    for bot_name, bot in bots_cfg.items():
        if not bot.get('enabled', True):
            # logger.debug(f"Bot '{bot_name}' is disabled, skipping")
            continue

        categories = bot.get('categories', {})

        for category_name, category_data in categories.items():
            if not category_data.get('enabled', True):
                # logger.debug(f"Category '{category_name}' in bot '{bot_name}' is disabled, skipping")
                continue

            topics = category_data.get('topics', {})

            for topic_name, topic_data in topics.items():
                if not topic_data.get('enabled', True):
                    # logger.debug(f"Topic '{topic_name}' is disabled, skipping")
                    continue

                schedules = topic_data.get('schedules', [])

                for schedule in schedules:
                    if not schedule.get('enabled', True):
                        continue

                    schedule_type = schedule.get('type')
                    prompt_key = schedule.get('prompt_key')
                    schedule_name = schedule.get('name', schedule_type)

                    if not schedule_type or not prompt_key:
                        # logger.warning(f"Invalid schedule for topic '{topic_name}': missing type or prompt_key")
                        continue

                    schedule_header = schedule.get('header', f"*{schedule_name}*")
                    header_datetime = schedule.get('header_datetime', False)

                    job_data = {
                        'schedule_type': schedule_type,
                        'bot_name': bot_name,
                        'topic_name': topic_name,
                        'category_name': category_name,
                        'prompt_key': prompt_key,
                        'header': schedule_header,
                        'header_datetime': header_datetime,
                        'header_date_arabic': schedule.get('header_date_arabic', False),
                        'header_time_arabic': schedule.get('header_time_arabic', False),
                        'telegram_targets': schedule.get('telegram_targets', []),
                        # Schedule anchor fields — used to compute exact previous fire time at runtime
                        'sch_minute':       schedule.get('minute'),
                        'sch_hour':         schedule.get('hour'),
                        'sch_hours':        schedule.get('hours'),
                        'sch_minutes':      schedule.get('minutes'),
                        'sch_start_hour':   schedule.get('start_hour', 0),
                        'sch_start_minute': schedule.get('start_minute', 0),
                    }

                    try:
                        if schedule_type == "minute":
                            minute_interval = schedule.get('minute', 1)
                            trigger = CronTrigger(minute=f'*/{minute_interval}')
                        elif schedule_type == "hourly":
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(minute=minute)
                        elif schedule_type == "interval_minutes":
                            interval_mins = schedule.get('minutes', 30)
                            start_hour   = schedule.get('start_hour', 0)
                            start_minute = schedule.get('start_minute', 0)
                            now = datetime.datetime.now()
                            start_dt = now.replace(hour=start_hour, minute=start_minute, second=0, microsecond=0)
                            if start_dt <= now:
                                start_dt += datetime.timedelta(minutes=interval_mins)
                                while start_dt <= now:
                                    start_dt += datetime.timedelta(minutes=interval_mins)
                            trigger = IntervalTrigger(minutes=interval_mins, start_date=start_dt)
                        elif schedule_type == "interval":
                            interval_hours = schedule.get('hours', 1)
                            start_hour   = schedule.get('start_hour', 0)
                            start_minute = schedule.get('start_minute', 0)
                            # Build a start_date anchored to today's start time
                            now = datetime.datetime.now()
                            start_dt = now.replace(hour=start_hour, minute=start_minute, second=0, microsecond=0)
                            # If that time already passed today, bump to next occurrence
                            if start_dt <= now:
                                start_dt += datetime.timedelta(hours=interval_hours)
                                # Keep bumping until it's in the future
                                while start_dt <= now:
                                    start_dt += datetime.timedelta(hours=interval_hours)
                            trigger = IntervalTrigger(hours=interval_hours, start_date=start_dt)
                        elif schedule_type == "daily":
                            hour = schedule.get('hour', 0)
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(hour=hour, minute=minute)
                        else:
                            logger.error(f"Unknown schedule type: {schedule_type}")
                            continue

                        job_id = f"{bot_name}:{category_name}:{topic_name}:{schedule_name}"
                        SCHEDULER.add_job(
                            trigger_summary,
                            trigger,
                            args=[job_data],
                            id=job_id,
                            name=job_id,
                            replace_existing=True
                        )
                        job_count += 1
                        # logger.info(f"[OK] Scheduled | Bot: {bot_name} | Topic: {topic_name} | Schedule: {schedule_name} ({schedule_type}) | Prompt: {prompt_key}")

                    except Exception as e:
                        logger.error(f"Failed to schedule {topic_name}/{schedule_name}: {e}", exc_info=True)

    # logger.info(f"[SCHEDULER] Initialized with {job_count} jobs")

async def scheduler_watcher():
    last_version = None
    while True:
        try:
            current_version = db.get_config_version()

            if current_version != last_version:
                await schedule_summaries()
                await build_source_channel_map()
                last_version = current_version
                asyncio.create_task(save_dialogs_to_db())

        except Exception as e:
            logger.warning(f"[SCHEDULER_WATCHER] Error: {e}")

        await asyncio.sleep(2)


# ==============================================
# ================= Main =======================
# ==============================================
async def main():
    global client

    # logger.info("="*60)
    # logger.info("Starting Telegram Summarizer Userbot")
    # logger.info("="*60)

    # Log configuration
    collections = db.get_all_collections()
    bots = db.get_all_bots_config()

    # logger.info(f"[CONFIG] COLLECTIONS: {len(collections)} configured")
    # for coll_name, coll_data in collections.items():
    #     sources = coll_data.get('source_channels', [])
    #     targets = coll_data.get('target_channels', [])
    #     logger.info(f"   - {coll_name}: Sources={sources}, Targets={targets}")

    # logger.info(f"[AI] BOTS: {len(bots)} configured")
    # for bot_name, bot_data in bots.items():
    #     enabled = bot_data.get('enabled', True)
    #     bot_colls = bot_data.get('collections', [])
    #     logger.info(f"   - {bot_name}: Enabled={enabled}, Collections={bot_colls}")

    # logger.info("="*60)

    # Prefer session string from DB (admin user), fall back to config.yaml
    _db_session = None
    try:
        from utils.database import get_db as _get_db
        _admin_user = _get_db().get_admin_user()
        if _admin_user and _admin_user.get('telegram_session'):
            _db_session = _admin_user['telegram_session']
    except Exception as _e:
        logger.debug(f"[SESSION] Could not load session from DB: {_e}")
    active_session = _db_session or STRING_SESSION
    if not active_session:
        logger.warning("[SESSION] No Telegram session configured. Set one via the System page → Session Setup.")
        return
    if _db_session:
        logger.info("[SESSION] Using session string from DB")
    else:
        logger.info("[SESSION] Using session string from config.yaml (no DB session found)")
    client = TelegramClient(StringSession(active_session), API_ID, API_HASH)

    # Register message handler for all new messages
    @client.on(events.NewMessage)
    async def message_handler(event):
        await read_channel_messages(event)

    try:
        # Connect and verify the session — don't call start() which blocks on auth prompts.
        # logger.info("[AUTH] Connecting to Telegram…")
        await client.connect()
        # logger.info("[AUTH] TCP connected — checking session authorization (30s timeout)…")
        try:
            authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=30)
        except asyncio.TimeoutError:
            # logger.error(
            #     "[FATAL] is_user_authorized() timed out after 30s. "
            #     "The session is likely expired or the auth key is invalid. "
            #     "Run get_ss.py to generate a new string_session."
            # )
            return
        if not authorized:
            # logger.error(
            #     "[FATAL] Userbot session is NOT authorized. "
            #     "The string_session in config.yaml is invalid or expired. "
            #     "Run get_ss.py to generate a new session string."
            # )
            return
        # logger.info("Userbot connected successfully")

        # Pre-resolve all source channels to numeric IDs so private channels work
        await build_source_channel_map()

        # Cache dialog list in DB so the channel validator UI can read it without
        # opening a second Telegram connection. Awaited directly so the cache is
        # guaranteed to be populated before the bot starts accepting events.
        await save_dialogs_to_db()

        # Start scheduler watcher (also rebuilds the channel map on config changes)
        asyncio.create_task(scheduler_watcher())

        # logger.info("Userbot is running... Press Ctrl+C to stop")
        await client.run_until_disconnected()

    except KeyboardInterrupt:
        # logger.info("Userbot stopped by user")
        pass
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
    finally:
        db.close()
        if SCHEDULER and SCHEDULER.running:
            SCHEDULER.shutdown()
        # logger.info("Userbot shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
