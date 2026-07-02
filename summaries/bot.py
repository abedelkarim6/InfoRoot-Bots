"""
Telegram userbot that generates scheduled summaries using OpenAI/Gemini.
Runs as a user account (MTProto via Telethon) instead of a bot.
"""
import os
import re
import sys
import time
import asyncio

# Force UTF-8 on Windows so log messages with Unicode (→, emojis, Arabic, etc.) don't crash.
# errors='replace' means any still-unencodable char becomes ? instead of raising.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from utils.database import get_db
from utils.openai_client import OpenAIClient
from utils.gemini_client import GeminiClient
from summaries.prompts import get_summary_prompt, get_bullet_points_suffix
from utils.helpers import load_config, categorizer

import datetime
from zoneinfo import ZoneInfo
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.schedulers.asyncio import AsyncIOScheduler

BEIRUT_TZ = ZoneInfo('Asia/Beirut')

from telethon import TelegramClient, events, utils as tg_utils
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

# ==================== Module-level state ====================
# Initialized inside run_bot() — not at import time (avoids side-effects when imported by app.py)
config = None
logger = None
db = None
llm_client = None
API_ID = None
API_HASH = None

SCHEDULER = None
client: TelegramClient = None  # Set in run_bot()


def get_bot_client():
    """Return the long-running userbot TelegramClient (or None if not started yet).

    Other parts of the app (e.g. the YouTube worker's Telegram sender) reuse this
    single connected client instead of opening a second connection on the same
    session string. Telethon explicitly warns against running one session from two
    concurrent clients — sharing this one client avoids that and the duplicate-send
    issues it caused. The client runs on the main event loop (started via
    asyncio.create_task in start_bot_task), so it is safe to call from any other
    coroutine on that same loop.
    """
    return client

# Pre-resolved map: numeric_channel_id → [collection_names]
# Built at startup and rebuilt on every config change.
# Avoids username-based matching which breaks for private channels (no username).
_source_channel_map: dict = {}

# State for speeches_interval schedules.
# Keyed by job_id; value: {buckets, msg_ids, send_task}
_speech_pending: dict = {}

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
        if not coll_data.get('enabled', True):
            continue
        for ch_identifier in coll_data.get('source_channels', []):
            if not ch_identifier:
                continue
            try:
                await _try_join_channel(ch_identifier)
                entity = await client.get_entity(ch_identifier)
                # Use get_peer_id so the key matches event.chat_id (negative for channels)
                num_id = tg_utils.get_peer_id(entity)
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
            is_broadcast = bool(getattr(entity, 'broadcast', False))
            is_megagroup = bool(getattr(entity, 'megagroup', False))
            is_creator   = bool(getattr(entity, 'creator', False))
            admin_rights = getattr(entity, 'admin_rights', None)
            if is_broadcast:
                # Broadcast channel: need post_messages admin right
                can_post = is_creator or (
                    admin_rights is not None and
                    bool(getattr(admin_rights, 'post_messages', False))
                )
            else:
                # Supergroup/megagroup/group: any member can send
                can_post = True
            channels.append({
                'id':           entity.id,
                'title':        entity.title,
                'username':     getattr(entity, 'username', None),
                'is_broadcast': is_broadcast,
                'is_megagroup': is_megagroup,
                'can_post':     can_post,
            })
        db.save_userbot_dialogs(channels)
        # logger.info(f"[DIALOGS] Cached {len(channels)} dialogs to DB")
    except Exception as e:
        logger.warning(f"[DIALOGS] Failed to cache dialogs: {e}")


# ==================== Message Handler ====================
async def read_channel_messages(event):
    """
    Handle incoming channel posts: save to database.
    Only processes messages from channels registered in collections.
    """
    try:
        # Fast pre-filter: skip anything not in the resolved source channel map.
        # event.chat_id is available immediately (no API call).
        # _source_channel_map is keyed by negative numeric IDs for channels.
        chat_id = event.chat_id
        if chat_id not in _source_channel_map:
            return

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
        # Use chat_id (negative peer ID from event) — consistent with map keys from build_source_channel_map.
        matching_collections = list(_source_channel_map.get(chat_id, []))
        if not matching_collections:
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
                # Substring search — no \b boundaries — so Arabic attached particles
                # (e.g. بالحرب, للحرب) are caught even without surrounding spaces.
                if kw.lower() in text.lower():
                    logger.info(f"[RULE] Remove '{kw}' matched — discarding | Bot={bot_name} | @{channel_id}")
                    skipped = True
                    break
            if skipped:
                continue

            # Replace rules: inline bot rules first, then pairs from any attached
            # reusable replace groups (enabled groups + enabled pairs only).
            bot_cfg = bots_cfg.get(bot_name, {}) or {}
            replaced_text = text
            replace_rules = list(bot_cfg_rules.get('replace', [])) + list(bot_cfg.get('replace_group_pairs', []))
            for rule in replace_rules:
                match_word = rule.get('match')
                repl = rule.get('replace_with', '')
                if not match_word:
                    continue
                # re.escape + IGNORECASE, no \b — handles Arabic attached forms correctly.
                new_text = re.sub(re.escape(match_word), repl, replaced_text, flags=re.IGNORECASE)
                if new_text != replaced_text:
                    logger.info(f"[RULE] Replace '{match_word}' → '{repl}' applied | Bot={bot_name} | @{channel_id}")
                replaced_text = new_text
            # ─────────────────────────────────────────────────────────────

            topics, categories, keywords = categorizer(replaced_text, bot_name, db)

            if not topics:
                logger.info(f"[CATEG] No topics matched | Bot={bot_name} | @{channel_id}")
            else:
                kw_display = (keywords or [])[:5]
                kw_extra = f" (+{len(keywords)-5} more)" if keywords and len(keywords) > 5 else ""
                logger.info(
                    f"[CATEG] Bot={bot_name} | @{channel_id} | "
                    f"Topics={topics} | Categories={categories} | "
                    f"Keywords[{len(keywords or [])}]={kw_display}{kw_extra}"
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
                collection_name=collection_name_str,
                msg_timestamp=event.message.date,
            )
            logger.info(f"[SAVED] msg#{message_id} | Bot={bot_name} | @{channel_id} | topics={topics}")

            # Trigger rolling 10-message interim summarization (fire-and-forget)
            if topics:
                for t in topics:
                    asyncio.create_task(check_and_run_interim_summary(bot_name, t))

    except Exception as e:
        logger.error(f"Error in read_channel_messages: {e}", exc_info=True)


# ==================== Schedule Window Helper ====================
from utils.helpers import compute_window_start as _compute_window_start


CHUNK_SIZE = 25  # messages per chunk before hierarchical summarization
INTER_CHUNK_DELAY = 3  # seconds between chunk API calls to avoid burst 429s

def _chunked_summarize(texts: list, bot_name: str, prompt_key: str, topic_name: str) -> tuple[str, int]:
    """
    If len(texts) <= CHUNK_SIZE: single LLM call (existing behaviour).
    Otherwise: split into CHUNK_SIZE chunks → summarize each (with delay) → merge.
    Returns (summary_text, total_tokens).
    """
    if len(texts) <= CHUNK_SIZE:
        prompt = get_summary_prompt(texts, bot_name, prompt_key, topic_name=topic_name)
        return llm_client.generate_summary(prompt)

    # --- Chunked path ---
    chunks = [texts[i:i + CHUNK_SIZE] for i in range(0, len(texts), CHUNK_SIZE)]
    logger.info(f"[CHUNK] {len(texts)} messages → {len(chunks)} chunks | Bot: {bot_name} | Topic: {topic_name}")

    intermediates = []
    total_tokens = 0
    for idx, chunk in enumerate(chunks, 1):
        if idx > 1:
            time.sleep(INTER_CHUNK_DELAY)
        prompt = get_summary_prompt(chunk, bot_name, prompt_key, topic_name=topic_name)
        part, tk = llm_client.generate_summary(prompt)
        total_tokens += tk
        logger.info(f"[CHUNK] Chunk {idx}/{len(chunks)} summarized ({len(chunk)} msgs)")
        intermediates.append(part)

    if len(intermediates) == 1:
        return intermediates[0], total_tokens

    # Merge pass: combine intermediate summaries in the same bot style
    merge_prompt = (
        "فيما يلي عدة ملخصات جزئية لمجموعة أخبار متعلقة بموضوع واحد. "
        "يرجى دمجها في ملخص واحد متكامل ومنسجم بنفس الأسلوب، مع تجنب التكرار:\n\n"
        + "\n---\n".join(intermediates)
    )
    logger.info(f"[CHUNK] Merging {len(intermediates)} intermediate summaries | Bot: {bot_name} | Topic: {topic_name}")
    merged_text, merge_tk = llm_client.generate_summary(merge_prompt)
    return merged_text, total_tokens + merge_tk


# ==================== LLM retry helper ====================
_RETRYABLE_NETWORK_ERRORS = (OSError, ConnectionError, TimeoutError)

async def _run_with_retry(fn, *args, max_attempts=3, base_delay=5):
    """Run a sync LLM call in a thread, retrying up to max_attempts on transient network errors."""
    last_exc = None
    for attempt in range(max_attempts):
        try:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, fn, *args)
        except _RETRYABLE_NETWORK_ERRORS as e:
            last_exc = e
            if attempt < max_attempts - 1:
                delay = base_delay * (3 ** attempt)  # 5s → 15s → 45s
                logger.warning(
                    f"[RETRY] Network error (attempt {attempt+1}/{max_attempts}), "
                    f"retrying in {delay}s: {e}"
                )
                await asyncio.sleep(delay)
    raise last_exc


# ==================== Telegram message splitting ====================
_TELEGRAM_MAX = 4096


def _paragraph_split(text):
    """Split text at the nearest paragraph (or line) break closest to the midpoint."""
    mid = len(text) // 2
    idx = text.rfind('\n\n', 0, mid)
    if idx == -1:
        idx = text.rfind('\n', 0, mid)
    if idx == -1:
        idx = mid
    return [text[:idx].strip(), text[idx:].strip()]


async def _send_with_split(client, target_chat, message_text):
    """Send message_text, auto-splitting via AI (with paragraph fallback) if > 4096 chars."""
    if len(message_text) <= _TELEGRAM_MAX:
        await client.send_message(target_chat, message_text, parse_mode='md')
        return

    logger.warning(
        f"[SPLIT] Message too long ({len(message_text)} chars) for {target_chat}, splitting via AI"
    )
    parts = None
    try:
        split_prompt = (
            "هذا الملخص طويل جداً للإرسال عبر تيليغرام (يتجاوز 4096 حرف). "
            "قسّمه إلى جزأين متوازنين تقريباً. "
            "أضف '(١/٢)' في نهاية الجزء الأول و'(٢/٢)' في نهاية الجزء الثاني. "
            "افصل بين الجزأين بكلمة SPLIT وحدها في سطر منفصل. "
            "لا تضف أي نص أو شرح آخر.\n\n"
            + message_text
        )
        split_text, _ = await _run_with_retry(llm_client.generate_summary, split_prompt)
        candidates = [p.strip() for p in split_text.split('SPLIT', 1) if p.strip()]
        if len(candidates) == 2 and all(len(p) <= _TELEGRAM_MAX for p in candidates):
            parts = candidates
        else:
            logger.warning(
                f"[SPLIT] AI returned {len(candidates)} part(s) or a part still too long — falling back"
            )
    except Exception as e:
        logger.warning(f"[SPLIT] AI split failed ({e}) — falling back to paragraph split")

    if parts is None:
        parts = _paragraph_split(message_text)
        parts[0] += '\n\n*(١/٢)*'
        parts[1] += '\n\n*(٢/٢)*'

    for part in parts:
        await client.send_message(target_chat, part, parse_mode='md')


# ==================== Summary Handler ====================
async def generate_and_send_summary(job_data):
    """
    Two-tier summary handler:
      Tier 1 (rolling): messages are batched into interim summaries every 10 msgs (see check_and_run_interim_summary).
      Tier 2 (this function): on schedule fire, merge all unsent interim summaries within the
      time window into one final summary and send it. If there are leftover raw messages
      (< 10, not yet interim-summarized), summarize them directly as well.
    """
    schedule_type = job_data.get('schedule_type')
    bot_name = job_data.get('bot_name')
    topic_name = job_data.get('topic_name')
    prompt_key = job_data.get('prompt_key')
    bullet_points = bool(job_data.get('bullet_points', False))
    b = int(job_data.get('bullet_points_count') or 0) if bullet_points else 0

    if not all([schedule_type, bot_name, topic_name, prompt_key]):
        logger.error(f"Missing required job data: {job_data}")
        return

    # ── Time-window gate: skip fires outside the configured active window ──
    _end_h = job_data.get('sch_end_hour')
    _end_m = job_data.get('sch_end_minute')
    if _end_h is not None and _end_m is not None:
        _now_local  = datetime.datetime.now(BEIRUT_TZ)
        _start_h    = int(job_data.get('sch_start_hour') or 0)
        _start_m    = int(job_data.get('sch_start_minute') or 0)
        _end_h_i    = int(_end_h)
        _end_m_i    = int(_end_m)
        _now_mins   = _now_local.hour * 60 + _now_local.minute
        _end_mins   = _end_h_i * 60 + _end_m_i
        _start_mins = _start_h * 60 + _start_m
        if _end_mins >= _start_mins:
            # Normal window (e.g. 08:00–20:00): dead if before start OR after end
            _in_dead = _now_mins > _end_mins or _now_mins < _start_mins
        else:
            # Overnight window (e.g. 20:00–02:00): dead period is between end and start
            _in_dead = _end_mins < _now_mins < _start_mins
        if _in_dead:
            logger.info(f"[SKIP] Outside active window {_start_h:02d}:{_start_m:02d}–{_end_h_i:02d}:{_end_m_i:02d} | Bot={bot_name} | Topic={topic_name}")
            return

    try:
        bots_cfg = db.get_all_bots_config()
        bot_cfg = bots_cfg.get(bot_name, {})

        # ── Runtime enabled guard — scheduler rebuild takes ~2s; this closes the race window ──
        if not bot_cfg.get('enabled', True):
            logger.info(f"[SKIP] Bot '{bot_name}' is disabled")
            return
        category_name = job_data.get('category_name')
        if category_name:
            cat_cfg = bot_cfg.get('categories', {}).get(category_name, {})
            if not cat_cfg.get('enabled', True):
                logger.info(f"[SKIP] Category '{category_name}' in bot '{bot_name}' is disabled")
                return
            topic_cfg = cat_cfg.get('topics', {}).get(topic_name, {})
            if not topic_cfg.get('enabled', True):
                logger.info(f"[SKIP] Topic '{topic_name}' in bot '{bot_name}' is disabled")
                return

        min_messages = int(bot_cfg.get('minimum_messages') or 1)

        # ── Compute time window ──────────────────────────────────────────────
        window_start = _compute_window_start(job_data)
        logger.debug(f"[FIRE] Bot={bot_name} | Topic={topic_name} | Type={schedule_type} | window_start={window_start}")

        # ── Fetch all raw messages in window not yet used by THIS schedule type ──
        # Each schedule type tracks its own consumed messages independently, so a topic
        # with both hourly and daily schedules correctly includes all messages in each.
        all_msgs = db.get_messages_for_schedule_window(
            bot_name, topic_name, schedule_type, after_dt=window_start
        )
        logger.info(f"[SUMMARY] raw_msgs={len(all_msgs)} | Bot={bot_name} | Topic={topic_name} | Type={schedule_type}")

        # Filter to messages with actual text content
        all_msgs = [m for m in all_msgs if (m.get('text') or '').strip()]
        total_msg_count = len(all_msgs)

        if total_msg_count == 0:
            logger.info(f"[SKIP] No messages with content | Bot={bot_name} | Topic={topic_name}")
            db.log_schedule_run(
                bot_name=bot_name, topic_name=topic_name, schedule_type=schedule_type,
                status='failed', message_count=0,
                error_text=f"number of messages 0 less than min_msgs {min_messages}",
            )
            return

        if total_msg_count < min_messages:
            logger.info(f"[SKIP] Not enough messages ({total_msg_count}/{min_messages}) | Bot={bot_name} | Topic={topic_name}")
            db.log_schedule_run(
                bot_name=bot_name, topic_name=topic_name, schedule_type=schedule_type,
                status='failed', message_count=total_msg_count,
                error_text=f"number of messages {total_msg_count} less than min_msgs {min_messages}",
            )
            return

        # ── Split messages: interim-covered vs. remaining raw ───────────────
        all_ids = [m['id'] for m in all_msgs]
        interim_id_map = db.get_interim_ids_for_messages(all_ids, bot_name=bot_name, topic_name=topic_name)

        # Collect interim IDs in the order their first message appears
        seen_interim_ids: set = set()
        ordered_interim_ids: list = []
        for mid in all_ids:
            if mid in interim_id_map:
                iid = interim_id_map[mid]
                if iid not in seen_interim_ids:
                    seen_interim_ids.add(iid)
                    ordered_interim_ids.append(iid)

        remaining_msgs = [m for m in all_msgs if m['id'] not in interim_id_map]

        # Use only the LAST interim — it already rolls up every prior interim.
        last_interim_text = ''
        if ordered_interim_ids:
            last_interims = db.get_interims_by_ids([ordered_interim_ids[-1]])
            if last_interims:
                last_interim_text = (last_interims[0].get('summary_text') or '').strip()

        logger.info(
            f"[INTERIM_TRACE] bot={bot_name} | topic={topic_name} | sched={schedule_type} "
            f"| total={total_msg_count} | covered={len(all_ids) - len(remaining_msgs)} "
            f"| remaining={len(remaining_msgs)} "
            f"| last_interim_id={ordered_interim_ids[-1] if ordered_interim_ids else None} "
            f"| last_interim_chars={len(last_interim_text)}"
        )

        BATCH = 25
        total_tokens = 0
        summary_text = ''
        empty_retry_attempts = 0
        MAX_EMPTY_RETRIES = 2
        # Multi-model A/B test (admin opt-in). When compare models are configured,
        # each is run on the same input as the primary; primary is what's sent.
        model_outputs = {}        # {model_name: text} — populated only when comparing
        primary_model_used = None

        if not remaining_msgs:
            # Pure interim path: the latest interim already represents the full
            # rolling summary across this window. Send it as-is — it was generated
            # with bullet_points_suffix at interim time, so no extra LLM call is
            # needed (and re-running would risk the LLM altering the formatting).
            if not last_interim_text:
                logger.warning(
                    f"[SKIP] No remaining msgs and last interim text is empty "
                    f"| Bot={bot_name} | Topic={topic_name}"
                )
                db.log_schedule_run(
                    bot_name=bot_name, topic_name=topic_name, schedule_type=schedule_type,
                    status='failed', message_count=total_msg_count,
                    error_text="last interim text empty"
                )
                return
            summary_text = last_interim_text
        else:
            # Rolling path: feed the user's template ONE batch of remaining messages
            # with {final_interim} = previous rolling summary. The template owns the
            # blend; bullet_points_suffix is always appended so the final output
            # matches the schedule's bullet config.
            rem_texts = [m['text'] for m in remaining_msgs]

            async def _gen_one(gen_fn):
                """Produce a summary from the current remaining-message batch using
                gen_fn (a model's generate_summary). Returns (text, tokens, retries).

                Mirrors the single-batch vs chunked logic and the empty-retry loop
                so every compared model sees identical inputs — a fair A/B."""
                _tokens = 0
                _text = ''
                _retries = 0
                for attempt in range(MAX_EMPTY_RETRIES + 1):
                    if len(rem_texts) <= BATCH:
                        prompt = get_summary_prompt(
                            rem_texts, bot_name, prompt_key,
                            topic_name=topic_name, final_interim=last_interim_text, b=b
                        )
                        if bullet_points and b:
                            prompt += '\n\n' + get_bullet_points_suffix(b)
                        s, tk = await _run_with_retry(gen_fn, prompt)
                        _tokens += tk
                        _text = (s or '').strip()
                    else:
                        # Rare: > BATCH remaining messages. Roll the {final_interim}
                        # forward through each chunk so the cumulative chain is
                        # preserved, then apply bullet_points_suffix only on the LAST.
                        rolling_text = last_interim_text
                        chunks = [rem_texts[i:i + BATCH] for i in range(0, len(rem_texts), BATCH)]
                        for idx, chunk in enumerate(chunks, 1):
                            is_last = (idx == len(chunks))
                            p = get_summary_prompt(
                                chunk, bot_name, prompt_key,
                                topic_name=topic_name, final_interim=rolling_text, b=b
                            )
                            if is_last and bullet_points and b:
                                p += '\n\n' + get_bullet_points_suffix(b)
                            s, tk = await _run_with_retry(gen_fn, p)
                            _tokens += tk
                            if (s or '').strip():
                                rolling_text = s.strip()
                        _text = (rolling_text or '').strip()
                        # Only counts as empty if it never advanced past the interim.
                        if _text == (last_interim_text or '').strip():
                            _text = ''

                    if _text:
                        break
                    if attempt < MAX_EMPTY_RETRIES:
                        _retries = attempt + 1
                return _text, _tokens, _retries

            # ── Primary model: this is what gets sent to Telegram ────────────
            summary_text, ptk, empty_retry_attempts = await _gen_one(llm_client.generate_summary)
            total_tokens += ptk
            if not summary_text and empty_retry_attempts:
                logger.warning(
                    f"[RETRY] AI returned empty summary after {empty_retry_attempts} "
                    f"retries | Bot={bot_name} | Topic={topic_name}"
                )

            # ── Compare models: run the same input through each, store only ───
            #    (admin opt-in; zero cost when no compare models are configured).
            if summary_text and isinstance(llm_client, GeminiClient):
                try:
                    from utils.gemini_models import get_gemini_compare_models, get_gemini_model
                    compare_models = get_gemini_compare_models()
                    if compare_models:
                        primary_model_used = get_gemini_model()
                        model_outputs[primary_model_used] = summary_text
                        for cm in compare_models:
                            try:
                                alt_client = GeminiClient(
                                    project=llm_client.project,
                                    location=llm_client.location,
                                    model=cm,
                                    user_id=getattr(llm_client, 'user_id', None),
                                )
                                alt_text, atk, _ = await _gen_one(alt_client.generate_summary)
                                total_tokens += atk
                                if alt_text:
                                    model_outputs[cm] = alt_text
                                logger.info(
                                    f"[COMPARE] {cm} done | Bot={bot_name} | "
                                    f"Topic={topic_name} | len={len(alt_text or '')}"
                                )
                            except Exception as ce:
                                logger.warning(
                                    f"[COMPARE] model {cm} failed | Bot={bot_name} | "
                                    f"Topic={topic_name}: {ce}"
                                )
                except Exception as e:
                    logger.warning(f"[COMPARE] multi-model comparison skipped: {e}")

        if not summary_text:
            retry_suffix = f" (retried {MAX_EMPTY_RETRIES} times)" if empty_retry_attempts else ""
            logger.warning(
                f"[SKIP] AI returned empty summary{retry_suffix} | Bot={bot_name} | Topic={topic_name}"
            )
            db.log_schedule_run(
                bot_name=bot_name, topic_name=topic_name, schedule_type=schedule_type,
                status='failed', message_count=total_msg_count,
                error_text=f"AI returned empty summary{retry_suffix}"
            )
            return

        logger.info(f"[AI] LLM done | Bot={bot_name} | Topic={topic_name} | summary_len={len(summary_text)} | tokens={total_tokens}")

        # ── Resolve target channels ──────────────────────────────────────────
        schedule_targets = [t for t in job_data.get('telegram_targets', []) if t]
        if schedule_targets:
            target_channels = list(set(schedule_targets))
        else:
            bot_collections = bot_cfg.get('collections', [])
            collections_cfg = db.get_all_collections()
            target_channels = []
            for coll_name in bot_collections:
                if coll_name in collections_cfg and collections_cfg[coll_name].get('enabled', True):
                    targets = collections_cfg[coll_name].get('target_channels', [])
                    target_channels.extend(targets)
            target_channels = list(set(target_channels))

        if not target_channels:
            logger.warning(f"[SKIP] No target channels for bot {bot_name}")
            return

        # ── Build header ─────────────────────────────────────────────────────
        header_text = job_data.get('header', '').strip()
        if header_text:
            if job_data.get('header_datetime'):
                ar_days = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد']
                offset_mins = int(job_data.get('header_datetime_offset') or 0)
                now = datetime.datetime.now(BEIRUT_TZ)
                if offset_mins:
                    now = now + datetime.timedelta(minutes=offset_mins)
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
            message_text = f"{header_text}\n\n{summary_text}"
        else:
            message_text = summary_text

        # ── Send ─────────────────────────────────────────────────────────────
        for target_chat in target_channels:
            try:
                await _send_with_split(client, target_chat, message_text)
                logger.info(f"[SENT] Bot={bot_name} | Topic={topic_name} | target={target_chat}")
            except Exception as e:
                logger.error(f"[ERROR] send_message to {target_chat}: {e}")
            # Always save to DB so the summary is visible in History regardless of send outcome
            db.save_summary(
                summary_text=summary_text,
                message_count=total_msg_count,
                summary_type=schedule_type,
                target_entity=str(target_chat),
                bot_name=bot_name,
                topic_name=topic_name,
                message_ids=all_ids,
                tokens_used=total_tokens,
                thoughts=getattr(llm_client, 'last_thoughts', '') or None,
                model_outputs=model_outputs or None,
                primary_model=primary_model_used,
            )

        # ── Mark all messages as consumed for this schedule type ─────────────
        db.mark_as_summarized(all_ids, schedule_type, bot_name, topic_name)
        if ordered_interim_ids:
            db.mark_interim_summaries_sent(ordered_interim_ids)
        db.log_schedule_run(bot_name=bot_name, topic_name=topic_name,
                            schedule_type=schedule_type, status='success',
                            message_count=total_msg_count)
        logger.debug(f"[DONE] Bot={bot_name} | Topic={topic_name} | msgs={total_msg_count}")

    except Exception as e:
        logger.error(f"[CRITICAL] summary generation failed | Bot={bot_name} | Topic={topic_name}: {e}", exc_info=True)
        try:
            from utils.gemini_usage import get_gemini_usage as _gu
            _usage = _gu()
            _rpm = _usage.get('rpm', {}).get('used')
            _tpm = _usage.get('tpm', {}).get('used')
            _rpd = _usage.get('rpd', {}).get('used')
        except Exception:
            _rpm = _tpm = _rpd = None
        db.log_schedule_run(bot_name=bot_name, topic_name=topic_name,
                            schedule_type=schedule_type, status='failed',
                            error_text=str(e),
                            rpm_at_failure=_rpm, tpm_at_failure=_tpm, rpd_at_failure=_rpd)

# ==================== Speeches Interval ====================

def _parse_speech_buckets(llm_response: str) -> list:
    """
    Split an LLM response into bucket messages.
    Uses '\\n---\\n' as the section separator (design your prompt to use ---).
    Falls back to a single bucket if no separator is present.
    """
    parts = re.split(r'\n\s*---\s*\n', llm_response.strip())
    buckets = [p.strip() for p in parts if p.strip()]
    return buckets if buckets else [llm_response.strip()]


async def _send_speech_buckets(job_id: str, job_data: dict, buckets: list,
                                msg_ids: list, wait_secs: float):
    """
    Sleep wait_secs then send each bucket as a separate Telegram message.
    Called as an asyncio task — cancels gracefully if a newer LLM run resets the timer.
    """
    try:
        await asyncio.sleep(wait_secs)
    except asyncio.CancelledError:
        return  # Timer was reset by a newer LLM run

    if job_id not in _speech_pending:
        return  # State was already cleared

    bot_name   = job_data['bot_name']
    topic_name = job_data['topic_name']
    schedule_type = job_data['schedule_type']
    header_text   = job_data.get('header', '').strip()

    try:
        bots_cfg = db.get_all_bots_config()
        bot_cfg  = bots_cfg.get(bot_name, {})

        schedule_targets = [t for t in job_data.get('telegram_targets', []) if t]
        if schedule_targets:
            target_channels = list(set(schedule_targets))
        else:
            collections_cfg = db.get_all_collections()
            target_channels = []
            for coll_name in bot_cfg.get('collections', []):
                if coll_name in collections_cfg and collections_cfg[coll_name].get('enabled', True):
                    target_channels.extend(collections_cfg[coll_name].get('target_channels', []))
            target_channels = list(set(target_channels))

        if not target_channels:
            logger.warning(f"[SPEECH] No target channels | Bot: {bot_name} | Topic: {topic_name}")
            _speech_pending.pop(job_id, None)
            return

        for bucket_text in buckets:
            if header_text:
                full_text = f"{header_text}\n\n{bucket_text}"
            else:
                full_text = bucket_text

            for target_chat in target_channels:
                try:
                    await client.send_message(target_chat, full_text, parse_mode='md')
                except Exception as e:
                    logger.error(f"[SPEECH] Failed to send bucket to {target_chat}: {e}")
                db.save_summary(
                    summary_text=bucket_text,
                    message_count=len(msg_ids),
                    summary_type=schedule_type,
                    target_entity=str(target_chat),
                    bot_name=bot_name,
                    topic_name=topic_name,
                    message_ids=msg_ids,
                    tokens_used=0,
                )

        db.mark_as_summarized(msg_ids, schedule_type, bot_name, topic_name)
        logger.info(f"[SPEECH] Sent {len(buckets)} bucket(s) | Bot: {bot_name} | Topic: {topic_name}")

    except Exception as e:
        logger.error(f"[SPEECH] Error sending buckets: {e}", exc_info=True)
    finally:
        _speech_pending.pop(job_id, None)


async def generate_speech_buckets(job_data: dict):
    """
    Collect unsummarized messages, call LLM, parse buckets,
    and (re)schedule the send task with a fresh wait_time countdown.
    """
    bot_name      = job_data['bot_name']
    topic_name    = job_data['topic_name']
    schedule_type = job_data['schedule_type']
    prompt_key    = job_data['prompt_key']
    wait_mins     = int(job_data.get('sch_wait_time') or 5)
    job_id        = job_data.get('job_id', f"{bot_name}:{job_data.get('category_name', '')}:{topic_name}")

    try:
        messages = db.get_messages_for_schedule(schedule_type, bot_name, topic_name)

        topic_messages = [
            m for m in messages
            if topic_name in [t.strip() for t in (m.get('topics') or '').split(',')]
        ]

        if not topic_messages:
            return

        # No window enforcement — messages accumulate until the wait_time send fires.
        # The 1-minute tick only sends to LLM when at least 1 message is available.
        in_window = topic_messages

        bots_cfg = db.get_all_bots_config()
        bot_cfg  = bots_cfg.get(bot_name, {})
        min_messages = int(bot_cfg.get('minimum_messages') or 0)
        if len(in_window) < min_messages:
            return

        texts   = [m['text'] for m in in_window]
        msg_ids = [m['id']   for m in in_window]

        prompt       = get_summary_prompt(texts, bot_name, prompt_key, topic_name=topic_name)
        llm_response, _ = await _run_with_retry(llm_client.generate_summary, prompt)
        buckets      = _parse_speech_buckets(llm_response)

        # Cancel any existing pending send task and restart the countdown
        existing = _speech_pending.get(job_id)
        if existing and existing.get('send_task'):
            existing['send_task'].cancel()

        wait_secs = wait_mins * 60
        send_task = asyncio.create_task(
            _send_speech_buckets(job_id, job_data, buckets, msg_ids, wait_secs)
        )
        _speech_pending[job_id] = {
            'buckets': buckets,
            'msg_ids': msg_ids,
            'send_task': send_task,
        }
        logger.info(
            f"[SPEECH] Buckets updated ({len(buckets)}) | Bot: {bot_name} | Topic: {topic_name} "
            f"| Sending in {wait_mins}m"
        )

    except Exception as e:
        logger.error(f"[SPEECH] Error in generate_speech_buckets: {e}", exc_info=True)
        try:
            from utils.gemini_usage import get_gemini_usage as _gu
            _usage = _gu()
            _rpm = _usage.get('rpm', {}).get('used')
            _tpm = _usage.get('tpm', {}).get('used')
            _rpd = _usage.get('rpd', {}).get('used')
        except Exception:
            _rpm = _tpm = _rpd = None
        db.log_schedule_run(bot_name=bot_name, topic_name=topic_name,
                            schedule_type=schedule_type, status='failed',
                            error_text=str(e),
                            rpm_at_failure=_rpm, tpm_at_failure=_tpm, rpd_at_failure=_rpd)


async def trigger_summary(job_data):
    """Trigger summary generation with complete job data."""
    try:
        if job_data.get('schedule_type') == 'speeches_interval':
            await generate_speech_buckets(job_data)
        else:
            await generate_and_send_summary(job_data)
    except Exception as e:
        logger.error(f"[ERROR] trigger_summary failed | Bot: {job_data.get('bot_name')} | Topic: {job_data.get('topic_name')} | Error: {e}", exc_info=True)


async def cleanup_message_backlog():
    """
    Mark unsummarized messages as 'missed' if they fall outside the schedule window
    for their (bot, topic). Cutoff is computed per-topic using _compute_window_start():
    - daily schedule  → only messages since last daily fire are kept
    - hourly schedule → only messages since last hourly fire are kept
    - interval 3h     → only messages from last 3h window are kept
    A message is only marked stale when it is outside ALL configured schedule windows
    for its topic (uses the earliest/furthest-back window start across all schedules).
    """
    try:
        bots_cfg = db.get_all_bots_config()

        # Build per-(bot_name, topic_name) cutoff.
        # Use the earliest window_start (furthest back in time) across all schedules
        # for that topic — a message is stale only if it's outside every window.
        topic_cutoffs: dict = {}  # (bot_name, topic_name) -> datetime
        for bot_name, bot_data in bots_cfg.items():
            for cat_data in bot_data.get('categories', {}).values():
                for topic_name, topic_data in cat_data.get('topics', {}).items():
                    if not topic_data.get('enabled', True):
                        continue
                    for schedule in topic_data.get('schedules', []):
                        if not schedule.get('enabled', True):
                            continue
                        stype = schedule.get('type')
                        if not stype:
                            continue
                        job_data = {
                            'schedule_type':    stype,
                            'sch_minute':       schedule.get('minute'),
                            'sch_hour':         schedule.get('hour'),
                            'sch_hours':        schedule.get('hours'),
                            'sch_minutes':      schedule.get('minutes'),
                            'sch_start_hour':   schedule.get('start_hour', 0),
                            'sch_start_minute': schedule.get('start_minute', 0),
                            'sch_end_hour':     schedule.get('end_hour'),
                            'sch_end_minute':   schedule.get('end_minute'),
                        }
                        window_start = _compute_window_start(job_data)
                        key = (bot_name, topic_name)
                        # Keep the earliest (furthest back) window start across schedules
                        if key not in topic_cutoffs or window_start < topic_cutoffs[key]:
                            topic_cutoffs[key] = window_start

        if not topic_cutoffs:
            return

        # Pre-filter DB with the globally earliest cutoff to avoid a full table scan
        earliest_cutoff = min(topic_cutoffs.values())
        old_msgs = db.get_old_unsummarized_messages(earliest_cutoff)
        if not old_msgs:
            return

        missed = 0
        for msg in old_msgs:
            bot_name   = msg.get('bot_name')
            topics_str = msg.get('topics') or ''
            topics     = [t.strip() for t in topics_str.split(',') if t.strip()]
            msg_ts     = msg.get('timestamp')
            if not bot_name or not topics or msg_ts is None:
                continue
            if isinstance(msg_ts, str):
                try:
                    msg_ts = datetime.datetime.fromisoformat(msg_ts)
                except ValueError:
                    continue
            if msg_ts.tzinfo is None:
                msg_ts = msg_ts.replace(tzinfo=BEIRUT_TZ)

            for topic_name in topics:
                cutoff = topic_cutoffs.get((bot_name, topic_name))
                if cutoff is None:
                    continue  # no schedule configured for this pair — leave untouched
                if msg_ts < cutoff:
                    db.mark_as_summarized([msg['id']], 'interim', bot_name, topic_name, status='missed')
                    missed += 1

        if missed:
            logger.info(f"[CLEANUP] Marked {missed} stale messages as missed (per-schedule cutoffs)")
    except Exception as e:
        logger.warning(f"[CLEANUP] backlog cleanup failed: {e}")


def _get_prompt_key_for_topic(bot_name: str, topic_name: str) -> str:
    """Look up any prompt_key configured for this (bot, topic). Returns first found or 'default'."""
    try:
        bots_cfg = db.get_all_bots_config()
        bot_cfg = bots_cfg.get(bot_name, {})
        for cat_data in bot_cfg.get('categories', {}).values():
            topic_data = cat_data.get('topics', {}).get(topic_name)
            if topic_data:
                schedules = topic_data.get('schedules', [])
                for sch in schedules:
                    pk = sch.get('prompt_key')
                    if pk:
                        return pk
    except Exception:
        pass
    return 'default'


def _get_schedule_name_for_topic(bot_name: str, topic_name: str) -> str | None:
    """Return the name of the first schedule configured for (bot, topic), or None."""
    try:
        bots_cfg = db.get_all_bots_config()
        bot_cfg = bots_cfg.get(bot_name, {})
        for cat_data in bot_cfg.get('categories', {}).values():
            topic_data = cat_data.get('topics', {}).get(topic_name)
            if topic_data:
                schedules = topic_data.get('schedules', [])
                for sch in schedules:
                    if sch.get('name'):
                        return sch['name']
    except Exception:
        pass
    return None


# One lock per (bot, topic) — prevents concurrent interim runs for the same topic
_interim_locks: dict = {}

def _get_interim_lock(bot_name: str, topic_name: str) -> asyncio.Lock:
    key = (bot_name, topic_name)
    if key not in _interim_locks:
        _interim_locks[key] = asyncio.Lock()
    return _interim_locks[key]


async def check_and_run_interim_summary(bot_name: str, topic_name: str):
    """
    Called after every message save.

    Each schedule of the topic keeps its OWN rolling interim chain, keyed by the
    schedule's id ('interim:{schedule_id}'). The DB helpers
    (get_unsummarized_count_for_interim / get_messages_for_interim) need both the
    schedule id and its concrete type so a batch never straddles a schedule fire.
    Batch size per schedule: 26 − B for bullet-points schedules, 20 otherwise.
    A per-topic lock prevents concurrent duplicate runs.
    """
    lock = _get_interim_lock(bot_name, topic_name)
    if lock.locked():
        return  # another task is already processing this topic — skip
    async with lock:
        try:
            schedules = db.get_schedules_for_topic(bot_name, topic_name)
        except Exception as e:
            logger.error(f"[INTERIM] Failed to load schedules | Bot={bot_name} | Topic={topic_name}: {e}", exc_info=True)
            return

        for sched in schedules:
            schedule_id   = sched.get('id')
            schedule_type = sched.get('type')
            if schedule_id is None or not schedule_type:
                continue  # malformed schedule row — skip rather than crash
            try:
                schedule_name = sched.get('name')
                prompt_key    = sched.get('prompt_key') or 'default'
                b_count = int(sched.get('bullet_points_count') or 0) if sched.get('bullet_points') else 0
                batch_limit = max(1, 26 - b_count) if b_count else 20
                logger.info(
                    f"[INTERIM] batch config | bot={bot_name} | topic={topic_name} "
                    f"| schedule={schedule_name}#{schedule_id} ({schedule_type}) "
                    f"| b={b_count} | batch_limit={batch_limit}"
                )
                # Bound the rolling {final_interim} chain to the current schedule window.
                # Without this, a final fire that gets SKIPPED (below min_messages, outside
                # active window, empty AI, or error) never marks its interims sent, so the
                # stale interim keeps rolling forward — leaking very old content (and prompting
                # hallucinated "messages") into every future summary. See get_latest_interim.
                interim_window_start = _compute_window_start({
                    'schedule_type':    schedule_type,
                    'sch_minute':       sched.get('minute'),
                    'sch_hour':         sched.get('hour'),
                    'sch_hours':        sched.get('hours'),
                    'sch_minutes':      sched.get('minutes'),
                    'sch_start_hour':   sched.get('start_hour', 0),
                    'sch_start_minute': sched.get('start_minute', 0),
                    'sch_end_hour':     sched.get('end_hour'),
                    'sch_end_minute':   sched.get('end_minute'),
                })
                while True:
                    count = db.get_unsummarized_count_for_interim(
                        bot_name, topic_name, schedule_id, schedule_type)
                    if count < batch_limit:
                        break

                    messages = db.get_messages_for_interim(
                        bot_name, topic_name, schedule_id, schedule_type, limit=batch_limit)
                    if len(messages) < batch_limit:
                        break

                    texts   = [m['text'] for m in messages]
                    msg_ids = [m['id'] for m in messages]

                    # Rolling cumulative — driven entirely by the user's prompt template.
                    # The template's {final_interim} slot receives the previous interim text
                    # (empty string on first run); the template owns how that context is
                    # blended with {messages} so the output style matches the schedule's
                    # final output exactly. Scoped to THIS schedule's chain.
                    prev_interim = db.get_latest_interim(
                        bot_name, topic_name, schedule_id=schedule_id,
                        after_dt=interim_window_start)
                    prev_text = (prev_interim.get('summary_text') or '').strip() if prev_interim else ''

                    prompt = get_summary_prompt(
                        texts, bot_name, prompt_key,
                        topic_name=topic_name, final_interim=prev_text, b=b_count
                    )
                    if b_count:
                        prompt += '\n\n' + get_bullet_points_suffix(b_count)

                    summary_text, _ = await _run_with_retry(llm_client.generate_summary, prompt)

                    interim_id = db.save_interim_summary(
                        bot_name, topic_name, summary_text, len(messages),
                        schedule_name=schedule_name, schedule_id=schedule_id)
                    db.mark_as_summarized(
                        msg_ids, f'interim:{schedule_id}', bot_name, topic_name, interim_id=interim_id)
                    logger.info(
                        f"[INTERIM] Saved | Bot={bot_name} | Topic={topic_name} "
                        f"| schedule={schedule_name}#{schedule_id} | msgs={len(msg_ids)}")
            except Exception as e:
                logger.error(
                    f"[INTERIM] Failed | Bot={bot_name} | Topic={topic_name} "
                    f"| schedule={schedule_id}: {e}", exc_info=True)


async def schedule_summaries():
    """
    Set up APScheduler jobs for all enabled topic schedules.
    Iterates through: bots → categories → topics → schedules
    """
    global SCHEDULER
    if SCHEDULER and SCHEDULER.running:
        SCHEDULER.remove_all_jobs()
    else:
        SCHEDULER = AsyncIOScheduler(timezone=BEIRUT_TZ, job_defaults={'misfire_grace_time': 60})
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
                    schedule_id   = schedule.get('id')

                    if not schedule_type or not prompt_key:
                        # logger.warning(f"Invalid schedule for topic '{topic_name}': missing type or prompt_key")
                        continue

                    schedule_header = schedule.get('header') or f"*{schedule_name}*"
                    header_datetime = schedule.get('header_datetime', False)

                    # Use immutable DB id as job_id so renaming the schedule doesn't create a new job.
                    job_id = f"sch:{schedule_id}" if schedule_id else f"{bot_name}:{category_name}:{topic_name}:{schedule_name}"
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
                        'header_datetime_offset': schedule.get('header_datetime_offset', 0) or 0,
                        'telegram_targets': schedule.get('telegram_targets', []),
                        # Schedule anchor fields — used to compute exact previous fire time at runtime
                        'sch_minute':       schedule.get('minute'),
                        'sch_hour':         schedule.get('hour'),
                        'sch_hours':        schedule.get('hours'),
                        'sch_minutes':      schedule.get('minutes'),
                        'sch_start_hour':   schedule.get('start_hour', 0),
                        'sch_start_minute': schedule.get('start_minute', 0),
                        'sch_end_hour':     schedule.get('end_hour'),
                        'sch_end_minute':   schedule.get('end_minute'),
                        # speeches_interval specific
                        'sch_wait_time':    schedule.get('wait_time', 5),
                        'job_id':           job_id,
                        'bullet_points':       schedule.get('bullet_points', False),
                        'bullet_points_count': schedule.get('bullet_points_count', 0),
                    }

                    try:
                        if schedule_type == "minute":
                            minute_interval = schedule.get('minute', 1)
                            trigger = CronTrigger(minute=f'*/{minute_interval}', timezone=BEIRUT_TZ)
                        elif schedule_type == "hourly":
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(minute=minute, timezone=BEIRUT_TZ)
                        elif schedule_type == "interval_minutes":
                            interval_mins = schedule.get('minutes', 30)
                            start_hour   = schedule.get('start_hour', 0)
                            start_minute = schedule.get('start_minute', 0)
                            now = datetime.datetime.now(BEIRUT_TZ)
                            # Anchor to today's start time (or yesterday if still in future).
                            # IntervalTrigger computes the correct next fire from the anchor,
                            # so rebuilding the scheduler never resets the fire cycle.
                            start_dt = now.replace(hour=start_hour, minute=start_minute, second=0, microsecond=0)
                            if start_dt > now:
                                start_dt -= datetime.timedelta(days=1)
                            trigger = IntervalTrigger(minutes=interval_mins, start_date=start_dt)
                        elif schedule_type == "interval_hourly":
                            interval_hours = schedule.get('hours', 1)
                            start_hour   = schedule.get('start_hour', 0)
                            start_minute = schedule.get('start_minute', 0)
                            now = datetime.datetime.now(BEIRUT_TZ)
                            # Anchor to today's start time (or yesterday if still in future).
                            # IntervalTrigger computes the correct next fire from the anchor,
                            # so rebuilding the scheduler never resets the fire cycle.
                            start_dt = now.replace(hour=start_hour, minute=start_minute, second=0, microsecond=0)
                            if start_dt > now:
                                start_dt -= datetime.timedelta(days=1)
                            trigger = IntervalTrigger(hours=interval_hours, start_date=start_dt)
                        elif schedule_type == "speeches_interval":
                            # Always runs every 1 minute; wait_time controls when buckets are sent
                            trigger = IntervalTrigger(minutes=1)
                        elif schedule_type == "daily":
                            hour = schedule.get('hour', 0)
                            minute = schedule.get('minute', 0)
                            trigger = CronTrigger(hour=hour, minute=minute, timezone=BEIRUT_TZ)
                        else:
                            logger.error(f"Unknown schedule type: {schedule_type}")
                            continue

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
                await cleanup_message_backlog()
                last_version = current_version
                asyncio.create_task(save_dialogs_to_db())

        except Exception as e:
            logger.warning(f"[SCHEDULER_WATCHER] Error: {e}")

        await asyncio.sleep(2)


# ==============================================
# ================= run_bot ====================
# ==============================================
async def run_bot():
    """
    Long-running coroutine for the Telegram userbot.
    Called by app.py via asyncio.create_task().
    Initializes all module-level state from the shared db/config,
    then runs the Telethon client + APScheduler until cancelled.
    """
    global config, db, logger, llm_client, API_ID, API_HASH, client

    # Initialize from app.py's already-configured db and config.
    # NOTE: logging is configured once in app.py (root logger + handlers); do not
    # reconfigure it here, or every line would print twice via a duplicate handler.
    import logging as _logging
    config = load_config()
    logger = _logging.getLogger("bot")
    db = get_db()  # app.py calls set_db_instance(SummariesDB(...)) before starting this task
    db.seed_keywords_from_config(config)

    if not config.get("gemini"):
        llm_client = OpenAIClient(
            api_key=config["openai"]["api_key"],
            model=config["openai"]["model"],
            max_tokens=config["openai"]["max_tokens"],
            temperature=config["openai"]["temperature"]
        )
    else:
        from utils.gemini_models import get_gemini_model
        llm_client = GeminiClient(
            project=config["gemini"]["project"],
            location=config["gemini"].get("location", "global"),
            model=get_gemini_model(config))

    API_ID = config["telegram"]["api_id"]
    API_HASH = config["telegram"]["api_hash"]

    # The admin's Telegram session lives in the DB (set via the System page → Session Setup).
    active_session = None
    try:
        _admin_user = get_db().get_admin_user()
        if _admin_user and _admin_user.get('telegram_session'):
            active_session = _admin_user['telegram_session']
    except Exception as _e:
        logger.debug(f"[SESSION] Could not load session from DB: {_e}")
    if not active_session:
        logger.warning("[SESSION] No Telegram session configured. Set one via the System page → Session Setup.")
        return
    logger.info("[SESSION] Using session string from DB")
    client = TelegramClient(StringSession(active_session), API_ID, API_HASH)

    # Register message handler once — persists across reconnects
    @client.on(events.NewMessage)
    async def message_handler(event):
        await read_channel_messages(event)

    watcher_task = None
    first_connect = True

    try:
        while True:
            try:
                await client.connect()

                try:
                    authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=30)
                except asyncio.TimeoutError:
                    logger.error("[RECONNECT] Auth check timed out (session may be expired). Retrying in 60s...")
                    await asyncio.sleep(60)
                    continue

                if not authorized:
                    logger.error("[RECONNECT] Session not authorized. Retrying in 60s...")
                    await asyncio.sleep(60)
                    continue

                await build_source_channel_map()

                if first_connect:
                    # Only mark stale messages as missed on the very first start,
                    # not on reconnects (recent messages should still be processed)
                    await cleanup_message_backlog()
                    first_connect = False

                await save_dialogs_to_db()

                # Start watcher only if not already running
                if watcher_task is None or watcher_task.done():
                    watcher_task = asyncio.create_task(scheduler_watcher())

                logger.info("[MAIN] Userbot connected successfully.")
                await client.run_until_disconnected()
                logger.warning("[RECONNECT] Disconnected from Telegram. Reconnecting in 15s...")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[RECONNECT] Connection error: {e}. Retrying in 30s...")

            await asyncio.sleep(15)

    except KeyboardInterrupt:
        pass
    finally:
        # app.py owns the db lifecycle — do NOT call db.close() here
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        if SCHEDULER and SCHEDULER.running:
            SCHEDULER.shutdown()
