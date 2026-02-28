from fastapi import APIRouter, Body

router = APIRouter()


def _get_dialogs():
    """Load cached dialogs from DB. Returns (result_dict, error_dict)."""
    from utils.database import get_db
    db = get_db()
    if db is None:
        return None, {"status": "error", "message": "Database not initialised"}
    result = db.get_userbot_dialogs()
    if not result['channels'] and result['updated_at'] is None:
        return None, {
            "status": "error",
            "message": "No dialog data yet — make sure the bot is running. It caches channel membership at startup."
        }
    return result, None


def _lookup_channel(channels: list, channel_id: str):
    """Find a channel in the cached list by @username or numeric ID."""
    stripped = channel_id.lstrip('@').strip()
    if stripped.lstrip('-').isdigit():
        num = int(stripped)
        if num < 0:
            s = str(-num)
            entity_id = int(s[3:]) if s.startswith('100') else -num
        else:
            entity_id = num
        for ch in channels:
            if ch['id'] == entity_id:
                return ch
        return None
    for ch in channels:
        if ch.get('username') and ch['username'].lower() == stripped.lower():
            return ch
    return None


@router.get("/telegram/admin_channels")
def get_admin_channels():
    """Return all channels the userbot is a member of (from DB cache)."""
    result, err = _get_dialogs()
    if err:
        return err
    return {"status": "ok", **result}


@router.post("/telegram/check_channel")
def check_channel(data: dict = Body(...)):
    """Check if the userbot is a member of a specific channel."""
    channel_id = (data.get('channel') or '').strip()
    if not channel_id:
        return {"status": "error", "message": "Missing channel"}

    result, err = _get_dialogs()
    if err:
        # DB not ready — treat as "not joined" rather than hard error
        return {"status": "ok", "joined": False, "channel": None}

    ch = _lookup_channel(result['channels'], channel_id)
    return {"status": "ok", "joined": ch is not None, "channel": ch}


@router.post("/telegram/verify_channel")
def verify_channel(data: dict = Body(...)):
    """Verify a channel and return its full details from the userbot's joined list."""
    channel_id = (data.get('channel') or '').strip()
    if not channel_id:
        return {"status": "error", "message": "Missing channel"}

    result, err = _get_dialogs()
    if err:
        return {"status": "not_found", "joined": False, "message": err["message"]}

    ch = _lookup_channel(result['channels'], channel_id)
    if ch is None:
        return {
            "status": "not_found",
            "joined": False,
            "message": f"Userbot is not a member of '{channel_id}', or not found in cache."
        }
    return {"status": "ok", "joined": True, "channel": ch}


@router.get("/telegram/userbot/dialogs")
def get_userbot_dialogs():
    """Return the cached list of Telegram channels the userbot is a member of."""
    result, err = _get_dialogs()
    if err:
        return err
    return {"status": "ok", **result}
