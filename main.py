"""
Telegram bot that generates hourly summaries using OpenAI.
"""
import os
import re
import sys

import asyncio
from collections import defaultdict

from utils.database import Database
from utils.openai_client import OpenAIClient
from utils.gemini_client import GeminiClient
from utils.prompts import get_summary_prompt
from utils.helpers import load_config, setup_logging, categorizer

from apscheduler.triggers.cron import CronTrigger
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from telegram import Update
from telegram.ext import CallbackContext, ApplicationBuilder, MessageHandler, filters, ContextTypes


# ==================== UTF-8 Config ====================
# Force UTF-8 encoding on Windows to handle Arabic/emoji text
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    # Reconfigure stdout/stderr to use UTF-8
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')

# ==================== Global Variables ====================
config = load_config()
logger = setup_logging(config)

# Initialize components
db = Database(config["database"]["dsn"])
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

# Telegram settings
BOT_TOKEN = config["telegram"]["bot_token"]
SCHEDULER = None


# ==================== Message Handler ====================
async def read_channel_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Handle incoming channel posts: forward and save to database.
    """
    try:
        # Check if this is a channel post
        if not update.channel_post:
            logger.debug("Update is not a channel post, skipping")
            return
        
        channel_id_numeric = update.effective_chat.id
        channel_title = update.effective_chat.title
        channel_username = update.effective_chat.username
        channel_id = channel_username  # Used for collection matching

        logger.info(f"[MSG] MESSAGE RECEIVED | Channel: {channel_id} ({channel_title})")
        
        # Load latest config and respect runtime toggle and channel settings
        current_cfg = load_config()

        # Determine matching bot profiles via collections
        # Step 1: Find which collections include this channel as a source
        collections_cfg = current_cfg.get('collections', {})
        matching_collections = []

        logger.info(f"[DEBUG] DEBUG | Looking for channel_id: '{channel_id}' in collections")
        logger.info(f"[DEBUG] DEBUG | Available collections: {list(collections_cfg.keys())}")

        for coll_name, coll_data in collections_cfg.items():
            source_channels = coll_data.get('source_channels', [])
            logger.info(f"[DEBUG] DEBUG | Collection '{coll_name}' has source_channels: {source_channels}")

            # Try both with and without @ symbol
            if channel_id in source_channels or f'@{channel_id}' in source_channels:
                matching_collections.append(coll_name)
                logger.info(f"[OK] MATCH | Collection '{coll_name}' matched!")

        logger.info(f"[DEBUG] DEBUG | Matching collections: {matching_collections}")

        # Step 2: Find which bots reference those collections
        bots_cfg = current_cfg.get('bots', {})
        matching_bots = []

        logger.info(f"[DEBUG] DEBUG | Available bots: {list(bots_cfg.keys())}")

        for bname, bcfg in bots_cfg.items():
            if not bcfg.get('enabled', True):
                logger.info(f"[SKIP] SKIP | Bot '{bname}' is disabled")
                continue
            bot_collections = bcfg.get('collections', [])
            logger.info(f"[DEBUG] DEBUG | Bot '{bname}' has collections: {bot_collections}")

            # Check if any of bot's collections match
            if any(coll in matching_collections for coll in bot_collections):
                matching_bots.append(bname)
                logger.info(f"[OK] MATCH | Bot '{bname}' matched!")

        logger.info(f"[DEBUG] DEBUG | Matching bots: {matching_bots}")

        if not matching_bots:
            logger.warning(f"[SKIP] SKIP | Channel '{channel_id}' not in any bot's collections")
            return
        
        # Extract text
        text = update.channel_post.text if update.channel_post.text else update.channel_post.caption
        
        if not text:
            logger.warning("No text found in channel post - skipping")
            return

        # Apply Message Rules (remove/replace) before categorization
        original_text = text
        rules = current_cfg.get('rules', {}) or {}

        # Remove rules: discard message if any remove keyword matches
        for kw in rules.get('remove', []):
            try:
                if re.search(rf"\b{re.escape(kw)}\b", text, re.IGNORECASE):
                    logger.info(f"Message discarded by remove rule: {kw}")
                    return
            except re.error:
                # fallback simple contains
                if kw in text:
                    logger.info(f"Message discarded by remove rule (contains): {kw}")
                    return

        # Replace rules: apply replacements to text
        replaced_text = text
        for rule in rules.get('replace', []):
            match = rule.get('match')
            repl = rule.get('replace_with', '')
            if not match:
                continue
            try:
                replaced_text = re.sub(rf"\b{re.escape(match)}\b", repl, replaced_text, flags=re.IGNORECASE)
            except re.error:
                replaced_text = replaced_text.replace(match, repl)

        # Save to database once per matching bot (so each bot has its own message rows)
        for bot_name in matching_bots:
            # Categorization is bot-specific (each bot has its own topics/keywords)
            topics, categories, keywords = categorizer(replaced_text, bot_name)

            # Save message with matched topics and categories
            message_id = db.add_message(
                channel_id=channel_id_numeric,
                text=replaced_text,
                countries=None,  # Legacy field, kept for backwards compatibility
                regions=None,    # Legacy field, kept for backwards compatibility
                topics=topics,
                categories=categories,
                keywords=keywords,
                bot_name=bot_name,
                original_text=original_text,
                replaced_text=replaced_text
            )
            text_preview = replaced_text[:100] + '...' if len(replaced_text) > 100 else replaced_text
            logger.info(f"[SAVE] DB SAVE | Bot: '{bot_name}' | ID: {message_id} | Channel: {channel_id} | Text: {text_preview} | Topics: {topics} | Categories: {categories} | Keywords: {keywords}")
    except Exception as e:
        logger.error(f"Error in read_channel_messages: {e}", exc_info=True)

# ==================== Summary Handler ====================
async def generate_and_send_summary(context: ContextTypes.DEFAULT_TYPE):
    """
    Generate and send summaries for topics based on their schedules.
    context.job.data: { 'schedule_type': str, 'bot_name': str, 'topic_name': str, 'category_name': str, 'prompt_key': str }
    """
    job_data = context.job.data if hasattr(context.job, 'data') else {}
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

        # Send summary to all target channels
        header_text = f"*** **{topic_name.upper()}** ({prompt_key})"
        if category_name:
            header_text = f"*** **{category_name.upper()} - {topic_name.upper()}** ({prompt_key})"

        message_text = f"{header_text}\n{'—'*20}\n\n{summary_text}"

        for target_chat in target_channels:
            try:
                await context.bot.send_message(
                    chat_id=target_chat,
                    text=message_text,
                    parse_mode="Markdown"
                )
                logger.info(f"[SENT] SUMMARY SENT | Bot: {bot_name} | Topic: {topic_name} | Target: {target_chat}")
            except Exception as e:
                logger.error(f"Failed to send summary to {target_chat}: {e}")

        # Mark messages as summarized
        msg_ids = [m['id'] for m in topic_messages]
        db.mark_as_summarized(msg_ids, schedule_type)
        logger.info(f"[DONE]  MARKED AS SUMMARIZED | Bot: {bot_name} | Topic: {topic_name} | Count: {len(msg_ids)} messages")

    except Exception as e:
        logger.error(f"Critical error in summary generation: {e}", exc_info=True)

async def trigger_summary(application, job_data):
    """Trigger summary generation with complete job data"""
    bot_name = job_data.get('bot_name')
    topic_name = job_data.get('topic_name')
    schedule_type = job_data.get('schedule_type')
    logger.info(f"[TRIGGER] SCHEDULE TRIGGER | Bot: {bot_name} | Topic: {topic_name} | Type: {schedule_type}")

    try:
        context = CallbackContext(application)
        context.job = type('obj', (object,), {'data': job_data})()
        await generate_and_send_summary(context)
    except Exception as e:
        logger.error(f"[ERROR] trigger_summary failed | Bot: {bot_name} | Topic: {topic_name} | Error: {e}", exc_info=True)

async def schedule_summaries(application):
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

    # Iterate through all bots
    for bot_name, bot in bots_cfg.items():
        if not bot.get('enabled', True):
            logger.debug(f"Bot '{bot_name}' is disabled, skipping")
            continue

        categories = bot.get('categories', {})

        # Iterate through categories → topics → schedules
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

                    # Build job data
                    job_data = {
                        'schedule_type': schedule_type,
                        'bot_name': bot_name,
                        'topic_name': topic_name,
                        'category_name': category_name,
                        'prompt_key': prompt_key
                    }

                    try:
                        # Build cron trigger based on schedule type
                        if schedule_type == "minute":
                            minute_interval = schedule.get('minute', 1)
                            trigger = CronTrigger(minute=f'*/{minute_interval}')
                        elif schedule_type == "hourly":
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(minute=minute)
                        elif schedule_type == "daily":
                            hour = schedule.get('hour', 0)
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(hour=hour, minute=minute)
                        else:
                            logger.error(f"Unknown schedule type: {schedule_type}")
                            continue

                        # Add job to scheduler
                        job_id = f"{bot_name}:{category_name}:{topic_name}:{schedule_name}"
                        SCHEDULER.add_job(
                            trigger_summary,
                            trigger,
                            args=[application, job_data],
                            id=job_id,
                            name=job_id,
                            replace_existing=True
                        )
                        job_count += 1
                        logger.info(f"[OK] Scheduled | Bot: {bot_name} | Topic: {topic_name} | Schedule: {schedule_name} ({schedule_type}) | Prompt: {prompt_key}")

                    except Exception as e:
                        logger.error(f"Failed to schedule {topic_name}/{schedule_name}: {e}", exc_info=True)

    logger.info(f"[SCHEDULER] Initialized with {job_count} jobs")   

async def scheduler_watcher(application):
    last_config = None
    while True:
        try:
            cfg = load_config()

            # Only rebuild the scheduler if config actually changed
            if cfg != last_config:
                await schedule_summaries(application)
                last_config = cfg
                logger.info("Scheduler rebuilt — config change detected")
            
        except Exception:
            logger.exception("Failed to reload config during watcher")

        await asyncio.sleep(2)

async def start_summarization(application):
    """
    Called after the application is initialized.
    Start the summary scheduler.
    """
    # asyncio.create_task(schedule_summaries(application))
    asyncio.create_task(scheduler_watcher(application))


# ==============================================
# ================= Main =======================
# ==============================================
def start_summarizer_bot():
    """Main entry point for the bot."""
    logger.info("="*60)
    logger.info("Starting Telegram Summarizer Bot")
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
    
    try:
        # Build application: post_init is what to do after initiliazation
        app = ApplicationBuilder().token(BOT_TOKEN).post_init(start_summarization).build()
        
        # Add message handler: tells bot what to do when a message arrives (in case we want from group not channel we change here)
        app.add_handler(MessageHandler(filters.ChatType.CHANNEL, read_channel_messages))
        
        logger.info("Bot is running... Press Ctrl+C to stop")
        
        # Run bot: starts the bot, listening for updates
        app.run_polling()
        
    except KeyboardInterrupt:
        logger.info("Bot stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
    finally:
        db.close()
        logger.info("Bot shutdown complete")


if __name__ == "__main__":
    start_summarizer_bot()