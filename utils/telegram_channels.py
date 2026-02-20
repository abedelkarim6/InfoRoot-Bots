"""
Utility functions for fetching Telegram channels where the bot is an admin.
"""

import asyncio
import logging
from typing import List, Dict
from telegram import Bot
from telegram.error import TelegramError

logger = logging.getLogger(__name__)


async def get_bot_admin_channels(bot_token: str, additional_channels: List[str] = None) -> List[Dict[str, str]]:
    """
    Get all channels where the bot has access (member, admin, or creator).

    For source channels: Bot needs to be at least a member (can read messages)
    For target channels: Bot needs to be admin/creator with post permission

    Args:
        bot_token: Telegram bot token
        additional_channels: Optional list of channel usernames/IDs to check (from config)

    Returns:
        List of dicts with 'id', 'title', 'username', 'can_post', and 'can_read' keys
    """
    bot = Bot(token=bot_token)
    accessible_channels = []
    checked_channels = set()

    try:
        # Initialize the bot (required for python-telegram-bot v20+)
        await bot.initialize()

        # Get updates to find channels the bot has interacted with
        updates = await bot.get_updates(limit=100)

        # Collect unique channel IDs from updates
        channel_ids = set()
        for update in updates:
            if update.channel_post:
                chat = update.channel_post.chat
                if chat.type == 'channel':
                    channel_ids.add(str(chat.id))

        # Also check channels from config/additional sources
        if additional_channels:
            for ch in additional_channels:
                if ch and ch not in channel_ids:
                    channel_ids.add(ch)

        # Check each channel to see if bot is admin
        for channel_id in channel_ids:
            # Skip if already checked
            if channel_id in checked_channels:
                continue

            checked_channels.add(channel_id)

            try:
                chat = await bot.get_chat(channel_id)

                # Get bot's member status in this channel
                bot_member = await bot.get_chat_member(channel_id, bot.id)

                # Check bot's access level
                # For source channels: bot just needs to be a member (can read)
                # For target channels: bot needs to be admin with post permission
                can_read = bot_member.status in ['administrator', 'creator', 'member', 'restricted']
                can_post = False

                if bot_member.status in ['administrator', 'creator']:
                    if bot_member.status == 'creator':
                        can_post = True
                    elif bot_member.status == 'administrator':
                        # Check if has explicit post permission
                        can_post = getattr(bot_member, 'can_post_messages', None) is True

                # Include channel if bot can at least read from it
                if can_read:
                    channel_info = {
                        'id': str(chat.id),
                        'title': chat.title or 'Unknown',
                        'username': f"@{chat.username}" if chat.username else None,
                        'type': chat.type,
                        'can_post': can_post,
                        'can_read': can_read
                    }
                    accessible_channels.append(channel_info)
                    access_type = "can post & read" if can_post else "can read only"
                    logger.info(f"Bot has access to: {channel_info['title']} ({channel_info.get('username', channel_info['id'])}) - {access_type}")

            except TelegramError as e:
                logger.warning(f"Error checking channel {channel_id}: {e}")
                continue

    except Exception as e:
        logger.error(f"Error getting bot accessible channels: {e}")
    finally:
        # Shutdown the bot properly
        try:
            await bot.shutdown()
        except:
            pass

    return accessible_channels


async def check_bot_can_post(bot_token: str, channel_id: str) -> bool:
    """
    Check if the bot can post messages to a specific channel.

    Args:
        bot_token: Telegram bot token
        channel_id: Channel ID or username (e.g., '@channel' or '-1001234567890')

    Returns:
        True if bot can post, False otherwise
    """
    bot = Bot(token=bot_token)

    try:
        # Initialize the bot
        await bot.initialize()

        # Get bot's member info
        bot_member = await bot.get_chat_member(channel_id, bot.id)

        # Check if bot is admin/creator
        if bot_member.status not in ['administrator', 'creator']:
            return False

        # Creators always have full permissions
        if bot_member.status == 'creator':
            return True

        # For administrators, check if has explicit post permission
        if bot_member.status == 'administrator':
            can_post = getattr(bot_member, 'can_post_messages', None)
            # If permission is explicitly granted, return True
            # If None or False, the bot doesn't have post permission
            return can_post is True

        return False

    except TelegramError as e:
        logger.error(f"Error checking bot permissions for {channel_id}: {e}")
        return False
    finally:
        try:
            await bot.shutdown()
        except:
            pass


async def get_channel_info(bot_token: str, channel_id: str) -> Dict[str, str]:
    """
    Get information about a specific channel.

    Args:
        bot_token: Telegram bot token
        channel_id: Channel ID or username

    Returns:
        Dict with channel info or None if error
    """
    bot = Bot(token=bot_token)

    try:
        # Initialize the bot
        await bot.initialize()

        chat = await bot.get_chat(channel_id)
        return {
            'id': str(chat.id),
            'title': chat.title or 'Unknown',
            'username': f"@{chat.username}" if chat.username else None,
            'type': chat.type,
            'description': chat.description
        }
    except TelegramError as e:
        logger.error(f"Error getting channel info for {channel_id}: {e}")
        return None
    finally:
        try:
            await bot.shutdown()
        except:
            pass


def get_bot_admin_channels_sync(bot_token: str, additional_channels: List[str] = None) -> List[Dict[str, str]]:
    """
    Synchronous wrapper for get_bot_admin_channels.
    Creates new event loop to run async function.

    Args:
        bot_token: Telegram bot token
        additional_channels: Optional list of channel usernames/IDs to check
    """
    try:
        # Try to get existing event loop
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # If loop is running, create new one
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
    except RuntimeError:
        # No event loop exists, create one
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    try:
        return loop.run_until_complete(get_bot_admin_channels(bot_token, additional_channels))
    finally:
        # Don't close loop if it was already running
        pass


def check_bot_can_post_sync(bot_token: str, channel_id: str) -> bool:
    """
    Synchronous wrapper for check_bot_can_post.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    try:
        return loop.run_until_complete(check_bot_can_post(bot_token, channel_id))
    finally:
        pass
