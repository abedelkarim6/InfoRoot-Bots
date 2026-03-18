"""
Weekly cleanup cron job: archive old queue entries, purge long-failed jobs.
"""

import logging
from youtube_monitor.db import get_yt_db

logger = logging.getLogger(__name__)


def run_cleanup():
    """Run weekly maintenance on YouTube tables."""
    db = get_yt_db()
    deleted = db.cleanup_old_queue(days=30)
    logger.info(f"[YT-CLEANUP] Cleaned up {deleted} old queue entries")
    return deleted
