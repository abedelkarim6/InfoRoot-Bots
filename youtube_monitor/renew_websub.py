"""
Cron job: renew WebSub subscriptions for all active channels.
Runs every 9 days.
"""

import logging
from youtube_monitor.db import get_yt_db
from youtube_monitor.websub import subscribe_channel

logger = logging.getLogger(__name__)


async def renew_all_subscriptions(callback_url: str, secret: str = None):
    """
    Re-subscribe all active channels whose WebSub subscription is expiring soon
    or has not been set up yet.
    """
    db = get_yt_db()
    channels = db.get_channels_needing_renewal()

    renewed = 0
    for ch in channels:
        try:
            success = await subscribe_channel(ch['channel_id'], callback_url, secret)
            if success:
                renewed += 1
        except Exception as e:
            logger.error(f"[WEBSUB-RENEW] Failed to renew {ch['channel_id']}: {e}")

    logger.info(f"[WEBSUB-RENEW] Renewed {renewed}/{len(channels)} subscriptions")
    return renewed
