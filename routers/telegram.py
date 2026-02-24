from fastapi import APIRouter, Body
from utils.helpers import load_config, save_config
from utils.telegram_channels import get_bot_admin_channels_sync, check_bot_can_post_sync

router = APIRouter()

@router.post("/telegram/update")
def update_telegram(data: dict = Body(...)):
    """Update telegram channel IDs from JSON body.

    Expects: { "source_channel_ids": [...], "target_channel_id": -100... }
    """
    cfg = load_config()

    source_ids = data.get("source_channel_ids")
    target_id = data.get("target_channel_id")

    if source_ids is None or target_id is None:
        return {"status": "error", "message": "Missing source_channel_ids or target_channel_id"}

    # Ensure we store the list under the plural key
    cfg.setdefault("telegram", {})["source_channel_ids"] = source_ids
    cfg["telegram"]["target_channel_id"] = target_id
    save_config(cfg)
    return {
        "status": "updated",
        "restart_required": True
    }


@router.get("/telegram/admin_channels")
def get_admin_channels():
    """Get all channels where the bot is an administrator."""
    cfg = load_config()
    bot_token = cfg.get("telegram", {}).get("bot_token")

    if not bot_token:
        return {"status": "error", "message": "Bot token not configured"}

    try:
        # Collect all channels mentioned in config to check them too
        additional_channels = []

        # Get channels from collections
        collections = cfg.get("collections", {})
        for coll_data in collections.values():
            if coll_data.get("source_channels"):
                additional_channels.extend(coll_data.get("source_channels", []))
            if coll_data.get("target_channel"):
                additional_channels.append(coll_data["target_channel"])
            if coll_data.get("target_channels"):
                additional_channels.extend(coll_data.get("target_channels", []))

        # Get channels from bots (source channels only, target channels are in collections)
        bots = cfg.get("bots", {})
        for bot_data in bots.values():
            if bot_data.get("source_channel_ids"):
                additional_channels.extend(bot_data.get("source_channel_ids", []))

        # Remove duplicates and None values
        additional_channels = list(set(filter(None, additional_channels)))

        channels = get_bot_admin_channels_sync(bot_token, additional_channels)
        return {
            "status": "ok",
            "channels": channels
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }


@router.post("/telegram/check_channel")
def check_channel_permission(data: dict = Body(...)):
    """Check if bot can post to a specific channel."""
    cfg = load_config()
    bot_token = cfg.get("telegram", {}).get("bot_token")
    channel_id = data.get("channel_id")

    if not bot_token:
        return {"status": "error", "message": "Bot token not configured"}

    if not channel_id:
        return {"status": "error", "message": "channel_id required"}

    try:
        can_post = check_bot_can_post_sync(bot_token, channel_id)
        return {
            "status": "ok",
            "can_post": can_post
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }


@router.post("/telegram/verify_channel")
def verify_and_add_channel(data: dict = Body(...)):
    """Verify if bot is admin in a channel and return channel info if true."""
    cfg = load_config()
    bot_token = cfg.get("telegram", {}).get("bot_token")
    channel_identifier = data.get("channel_identifier")  # Can be @username or channel ID

    if not bot_token:
        return {"status": "error", "message": "Bot token not configured"}

    if not channel_identifier:
        return {"status": "error", "message": "channel_identifier required"}

    try:
        # Import here to avoid circular dependency
        from utils.telegram_channels import get_channel_info, check_bot_can_post

        # Use asyncio to run async functions
        import asyncio

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        # Get channel info and check if bot is admin
        channel_info = loop.run_until_complete(get_channel_info(bot_token, channel_identifier))

        if not channel_info:
            return {
                "status": "error",
                "message": "Channel not found or bot doesn't have access"
            }

        can_post = loop.run_until_complete(check_bot_can_post(bot_token, channel_identifier))

        return {
            "status": "ok",
            "channel": {
                **channel_info,
                "can_post": can_post
            }
        }

    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }
