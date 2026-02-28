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
from utils.helpers import load_config, load_prompts, setup_logging, categorizer

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
STRING_SESSION = config["telegram"].get("string_session")
if not STRING_SESSION:
    raise ValueError("telegram.string_session is required in config.yaml but was not found or is empty.")

SCHEDULER = None
client: TelegramClient = None  # Set in main()

# Pre-resolved map: numeric_channel_id → [collection_names]
# Built at startup and rebuilt on every config change.
# Avoids username-based matching which breaks for private channels (no username).
_source_channel_map: dict = {}


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
            logger.info(f"[JOIN] Joined via invite link: {stripped}")
        except UserAlreadyParticipantError:
            pass
        except InviteHashInvalidError:
            logger.warning(f"[JOIN] Invalid invite hash: {stripped}")
        except Exception as e:
            logger.warning(f"[JOIN] Could not join via invite '{stripped}': {e}")
        return

    # @username channel
    try:
        await client(JoinChannelRequest(stripped))
        logger.info(f"[JOIN] Joined channel: {stripped}")
    except UserAlreadyParticipantError:
        pass
    except ChannelPrivateError:
        logger.warning(f"[JOIN] Channel is private (invite needed): {stripped}")
    except Exception as e:
        logger.warning(f"[JOIN] Could not join '{stripped}': {e}")


async def build_source_channel_map(cfg):
    """
    Resolve every source_channel in the config to its numeric Telegram ID.
    Handles @username, @+invitelink, and plain numeric IDs.
    Auto-joins any channel the userbot is not already a member of.
    Updates the module-level _source_channel_map dict in-place.
    """
    global _source_channel_map
    new_map: dict = {}
    for coll_name, coll_data in cfg.get('collections', {}).items():
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
                logger.info(f"[MAP] {ch_identifier} → id={num_id} → collections={new_map[num_id]}")
            except Exception as e:
                logger.warning(f"[MAP] Could not resolve '{ch_identifier}': {e}")
    _source_channel_map = new_map
    logger.info(f"[MAP] Source channel map ready: {len(new_map)} channel(s) resolved")


async def save_dialogs_to_db():
    """
    Iterate all userbot dialogs and cache them in the DB.
    Called at startup so the channel validator UI can show membership
    without needing to open a second Telegram connection.
    """
    logger.info("[DIALOGS] Fetching dialog list from Telegram…")
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
        logger.info(f"[DIALOGS] Cached {len(channels)} dialogs to DB")
    except Exception as e:
        logger.warning(f"[DIALOGS] Failed to cache dialogs: {e}", exc_info=True)


# ==================== Message Handler ====================
async def read_channel_messages(event):
    """
    Handle incoming channel posts: save to database.
    Only processes broadcast channels (not groups/supergroups).
    """
    try:
        # Log every incoming event so we can confirm the handler fires
        is_channel = event.is_channel
        is_group   = getattr(event, 'is_group', False)
        is_private = getattr(event, 'is_private', False)
        logger.info(f"[EVENT] chat_id={event.chat_id} | is_channel={is_channel} | is_group={is_group} | is_private={is_private}")

        # Skip private/DM messages — they are never source channels
        if is_private:
            logger.info(f"[SKIP] Private/DM message — skipping")
            return

        chat = await event.get_chat()

        channel_id_numeric = chat.id
        channel_title = getattr(chat, 'title', '')
        channel_username = getattr(chat, 'username', None)
        channel_id = channel_username  # Used for collection matching

        text_intro = (event.message.message or event.message.text or '')[:80].replace('\n', ' ')
        logger.info(f"[MSG] RECEIVED | id={channel_id_numeric} | @{channel_id} ({channel_title}) | \"{text_intro}\"")

        # Load latest config
        current_cfg = load_config()
        collections_cfg = current_cfg.get('collections', {})

        # Step 1: Find which collections include this channel as a source.
        # Use the pre-resolved numeric-ID map (handles private channels, invite links, etc.).
        # Fall back to username matching for any channels not yet in the map.
        matching_collections = list(_source_channel_map.get(channel_id_numeric, []))

        if not matching_collections and channel_username:
            for coll_name, coll_data in collections_cfg.items():
                source_channels = coll_data.get('source_channels', [])
                if channel_username in source_channels or f'@{channel_username}' in source_channels:
                    matching_collections.append(coll_name)

        if not matching_collections:
            logger.warning(
                f"[SKIP] id={channel_id_numeric} (@{channel_id}) not in any collection — "
                f"map has {len(_source_channel_map)} entries {list(_source_channel_map.keys())}, "
                f"configured collections: {list(collections_cfg.keys())}"
            )
            return

        # Step 2: Find which bots reference those collections
        bots_cfg = current_cfg.get('bots', {})
        matching_bots = [
            bname for bname, bcfg in bots_cfg.items()
            if bcfg.get('enabled', True)
            and any(coll in matching_collections for coll in bcfg.get('collections', []))
        ]

        if not matching_bots:
            logger.warning(
                f"[SKIP] @{channel_id} → collections {matching_collections} not referenced "
                f"by any enabled bot — configured bots: {list(bots_cfg.keys())}"
            )
            return

        logger.info(f"[MATCH] @{channel_id} → Collections: {matching_collections} | Bots: {matching_bots}")

        # Extract text (text or caption for media messages)
        text = event.message.message or event.message.text

        if not text:
            logger.warning(f"[SKIP] No text in message from @{channel_id}")
            return

        original_text = text
        collection_name_str = ",".join(matching_collections) if matching_collections else None

        for bot_name in matching_bots:
            # ── Per-bot rules ────────────────────────────────────────────
            bot_cfg_rules = current_cfg.get('bots', {}).get(bot_name, {}).get('rules', {}) or {}

            # Remove rules: skip this bot if any keyword matches
            skipped = False
            for kw in bot_cfg_rules.get('remove', []):
                if not kw:
                    continue
                try:
                    if re.search(rf"\b{re.escape(kw)}\b", text, re.IGNORECASE):
                        logger.info(f"[RULE] Remove rule '{kw}' matched — skipping Bot: {bot_name} | @{channel_id}")
                        skipped = True
                        break
                except re.error:
                    if kw in text:
                        logger.info(f"[RULE] Remove rule '{kw}' matched — skipping Bot: {bot_name} | @{channel_id}")
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

            if not topics:
                logger.info(f"[CATEG] No topics matched | Bot: {bot_name} | @{channel_id} → {matching_collections}")
            else:
                kw_display = keywords[:5] if keywords else []
                kw_extra = f" (+{len(keywords)-5} more)" if keywords and len(keywords) > 5 else ""
                logger.info(
                    f"[CATEG] Bot: {bot_name} | @{channel_id} → {matching_collections} | "
                    f"Topics: {topics} | Categories: {categories} | "
                    f"Keywords [{len(keywords or [])}]: {kw_display}{kw_extra}"
                )

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
            logger.info(f"[SAVED] msg#{message_id} | Bot: {bot_name} | @{channel_id} → {matching_collections}")

    except Exception as e:
        logger.error(f"Error in read_channel_messages: {e}", exc_info=True)


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
        config = load_config()

        # Get all unsummarized messages for this bot and schedule type
        messages = db.get_messages_for_schedule(schedule_type, bot_name)

        if not messages:
            logger.debug(f"[SKIP]  SKIP | No messages | Bot: {bot_name} | Topic: {topic_name} | Schedule: {schedule_type}")
            return

        # Filter messages that match this specific topic
        topic_messages = []
        for msg in messages:
            if msg.get('topics'):
                msg_topics = msg['topics'].split(',') if isinstance(msg['topics'], str) else []
                if topic_name in msg_topics:
                    topic_messages.append(msg)

        if not topic_messages:
            logger.debug(f"[SKIP]  SKIP | No messages for topic | Bot: {bot_name} | Topic: {topic_name}")
            return

        # Check minimum messages requirement
        bot_cfg = config.get('bots', {}).get(bot_name, {})
        min_messages = bot_cfg.get('minimum_messages', 1)
        if len(topic_messages) < min_messages:
            logger.info(f"[SKIP]  SKIP | Not enough messages ({len(topic_messages)}/{min_messages}) | Bot: {bot_name} | Topic: {topic_name}")
            return

        logger.info(f"[SUMMARY] SUMMARY TASK START | Bot: {bot_name} | Topic: {topic_name} | Schedule: {schedule_type} | Messages: {len(topic_messages)}")

        # Extract message texts
        texts = [m['text'] for m in topic_messages]

        # Generate summary using bot-specific prompt
        prompt = get_summary_prompt(texts, bot_name, prompt_key)

        logger.info(f"[AI] SUMMARY GENERATION | Bot: {bot_name} | Topic: {topic_name} | Prompt: {prompt_key} | Messages: {len(texts)}")
        summary_text = llm_client.generate_summary(prompt)

        # Get target channels from bot's collections
        bot_collections = bot_cfg.get('collections', [])
        collections_cfg = config.get('collections', {})
        target_channels = []
        for coll_name in bot_collections:
            if coll_name in collections_cfg:
                targets = collections_cfg[coll_name].get('target_channels', [])
                target_channels.extend(targets)

        # Remove duplicates
        target_channels = list(set(target_channels))

        if not target_channels:
            logger.warning(f"No target channels found for bot {bot_name}")
            return

        # Build message text — use custom header from prompt if defined, else auto-generate
        prompts_cfg = load_prompts()
        prompt_val = prompts_cfg.get('bots', {}).get(bot_name, {}).get(prompt_key, {})
        custom_header = prompt_val.get('header', '').strip() if isinstance(prompt_val, dict) else ''

        if custom_header:
            message_text = f"{custom_header}\n{'—'*20}\n\n{summary_text}"
        else:
            header_text = f"{category_name.upper()} - {topic_name.upper()}" if category_name else topic_name.upper()
            message_text = f"{header_text}\n{'—'*20}\n\n{summary_text}"

        # Send summary to all target channels using the userbot client
        for target_chat in target_channels:
            try:
                await client.send_message(target_chat, message_text, parse_mode='md')
                logger.info(f"[SENT] SUMMARY SENT | Bot: {bot_name} | Topic: {topic_name} | Target: {target_chat}")
                db.save_summary(
                    summary_text=summary_text,
                    message_count=len(topic_messages),
                    summary_type=schedule_type,
                    target_entity=str(target_chat),
                    bot_name=bot_name,
                    topic_name=topic_name
                )
            except Exception as e:
                logger.error(f"Failed to send summary to {target_chat}: {e}")

        # Mark messages as summarized
        msg_ids = [m['id'] for m in topic_messages]
        db.mark_as_summarized(msg_ids, schedule_type)
        logger.info(f"[DONE]  MARKED AS SUMMARIZED | Bot: {bot_name} | Topic: {topic_name} | Count: {len(msg_ids)} messages")

    except Exception as e:
        logger.error(f"Critical error in summary generation: {e}", exc_info=True)

async def trigger_summary(job_data):
    """Trigger summary generation with complete job data."""
    bot_name = job_data.get('bot_name')
    topic_name = job_data.get('topic_name')
    schedule_type = job_data.get('schedule_type')
    logger.info(f"[TRIGGER] SCHEDULE TRIGGER | Bot: {bot_name} | Topic: {topic_name} | Type: {schedule_type}")

    try:
        await generate_and_send_summary(job_data)
    except Exception as e:
        logger.error(f"[ERROR] trigger_summary failed | Bot: {bot_name} | Topic: {topic_name} | Error: {e}", exc_info=True)

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

    config = load_config()
    bots_cfg = config.get('bots', {})

    if not bots_cfg:
        logger.warning("No bots configured")
        return

    job_count = 0

    for bot_name, bot in bots_cfg.items():
        if not bot.get('enabled', True):
            logger.debug(f"Bot '{bot_name}' is disabled, skipping")
            continue

        categories = bot.get('categories', {})

        for category_name, category_data in categories.items():
            if not category_data.get('enabled', True):
                logger.debug(f"Category '{category_name}' in bot '{bot_name}' is disabled, skipping")
                continue

            topics = category_data.get('topics', {})

            for topic_name, topic_data in topics.items():
                if not topic_data.get('enabled', True):
                    logger.debug(f"Topic '{topic_name}' is disabled, skipping")
                    continue

                schedules = topic_data.get('schedules', [])

                for schedule in schedules:
                    if not schedule.get('enabled', True):
                        continue

                    schedule_type = schedule.get('type')
                    prompt_key = schedule.get('prompt_key')
                    schedule_name = schedule.get('name', schedule_type)

                    if not schedule_type or not prompt_key:
                        logger.warning(f"Invalid schedule for topic '{topic_name}': missing type or prompt_key")
                        continue

                    job_data = {
                        'schedule_type': schedule_type,
                        'bot_name': bot_name,
                        'topic_name': topic_name,
                        'category_name': category_name,
                        'prompt_key': prompt_key
                    }

                    try:
                        if schedule_type == "minute":
                            minute_interval = schedule.get('minute', 1)
                            trigger = CronTrigger(minute=f'*/{minute_interval}')
                        elif schedule_type == "hourly":
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(minute=minute)
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
                        logger.info(f"[OK] Scheduled | Bot: {bot_name} | Topic: {topic_name} | Schedule: {schedule_name} ({schedule_type}) | Prompt: {prompt_key}")

                    except Exception as e:
                        logger.error(f"Failed to schedule {topic_name}/{schedule_name}: {e}", exc_info=True)

    logger.info(f"[SCHEDULER] Initialized with {job_count} jobs")

async def scheduler_watcher():
    last_config = None
    while True:
        try:
            cfg = load_config()

            if cfg != last_config:
                await schedule_summaries()
                await build_source_channel_map(cfg)
                last_config = cfg
                asyncio.create_task(save_dialogs_to_db())
                logger.info("Scheduler rebuilt + channel map refreshed — config change detected")

        except Exception:
            logger.exception("Failed to reload config during watcher")

        await asyncio.sleep(2)


# ==============================================
# ================= Main =======================
# ==============================================
async def main():
    global client

    logger.info("="*60)
    logger.info("Starting Telegram Summarizer Userbot")
    logger.info("="*60)

    # Log configuration
    cfg = load_config()
    collections = cfg.get('collections', {})
    bots = cfg.get('bots', {})

    logger.info(f"[CONFIG] COLLECTIONS: {len(collections)} configured")
    for coll_name, coll_data in collections.items():
        sources = coll_data.get('source_channels', [])
        targets = coll_data.get('target_channels', [])
        logger.info(f"   - {coll_name}: Sources={sources}, Targets={targets}")

    logger.info(f"[AI] BOTS: {len(bots)} configured")
    for bot_name, bot_data in bots.items():
        enabled = bot_data.get('enabled', True)
        bot_colls = bot_data.get('collections', [])
        logger.info(f"   - {bot_name}: Enabled={enabled}, Collections={bot_colls}")

    logger.info("="*60)

    # Create Telethon userbot client using the string session from config
    client = TelegramClient(StringSession(STRING_SESSION), API_ID, API_HASH)

    # Register message handler for all new messages
    @client.on(events.NewMessage)
    async def message_handler(event):
        await read_channel_messages(event)

    try:
        # Connect and verify the session — don't call start() which blocks on auth prompts.
        logger.info("[AUTH] Connecting to Telegram…")
        await client.connect()
        logger.info("[AUTH] TCP connected — checking session authorization (30s timeout)…")
        try:
            authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=30)
        except asyncio.TimeoutError:
            logger.error(
                "[FATAL] is_user_authorized() timed out after 30s. "
                "The session is likely expired or the auth key is invalid. "
                "Run get_ss.py to generate a new string_session."
            )
            return
        if not authorized:
            logger.error(
                "[FATAL] Userbot session is NOT authorized. "
                "The string_session in config.yaml is invalid or expired. "
                "Run get_ss.py to generate a new session string."
            )
            return
        logger.info("Userbot connected successfully")

        # Pre-resolve all source channels to numeric IDs so private channels work
        await build_source_channel_map(cfg)

        # Cache dialog list in DB so the channel validator UI can read it without
        # opening a second Telegram connection. Awaited directly so the cache is
        # guaranteed to be populated before the bot starts accepting events.
        await save_dialogs_to_db()

        # Start scheduler watcher (also rebuilds the channel map on config changes)
        asyncio.create_task(scheduler_watcher())

        logger.info("Userbot is running... Press Ctrl+C to stop")
        await client.run_until_disconnected()

    except KeyboardInterrupt:
        logger.info("Userbot stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
    finally:
        db.close()
        if SCHEDULER and SCHEDULER.running:
            SCHEDULER.shutdown()
        logger.info("Userbot shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
