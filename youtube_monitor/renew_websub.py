"""
Cron job: renew WebSub subscriptions for all active channels.

Runs every 4 days. YouTube's hub grants ~5-day leases regardless of the lease
we request, so the renewal cadence must stay comfortably under that.
"""

import logging
from youtube_monitor.db import get_yt_db
from youtube_monitor.websub import subscribe_channel

logger = logging.getLogger(__name__)


async def renew_all_subscriptions(fallback_callback_url: str = "", secret: str = None):
    """
    Re-subscribe all active channels whose WebSub subscription is expiring soon
    or has not been set up yet.

    Each channel re-subscribes to the callback URL it was originally subscribed
    with (`websub_callback_url`, persisted at subscribe time). `fallback_callback_url`
    is used only for channels with no stored callback (e.g. subscribed before
    this column existed) — pass the configured `youtube.callback_url`.
    """
    db = get_yt_db()
    channels = db.get_channels_needing_renewal()
    if not channels:
        logger.info("[WEBSUB-RENEW] No subscriptions due for renewal")
        return 0

    renewed = 0
    skipped = 0
    for ch in channels:
        cb = ch.get("websub_callback_url") or fallback_callback_url
        if not cb:
            skipped += 1
            logger.warning(
                f"[WEBSUB-RENEW] Skipping {ch['channel_id']} — no callback URL "
                f"(channel has none stored and youtube.callback_url is unset)")
            continue
        try:
            success = await subscribe_channel(ch['channel_id'], cb, secret)
            if success:
                renewed += 1
        except Exception as e:
            logger.error(f"[WEBSUB-RENEW] Failed to renew {ch['channel_id']}: {e}")

    msg = f"[WEBSUB-RENEW] Renewed {renewed}/{len(channels)} subscriptions"
    if skipped:
        msg += f" ({skipped} skipped — no callback URL)"
    logger.info(msg)
    return renewed
