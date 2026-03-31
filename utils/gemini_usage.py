"""
In-memory + DB-backed tracker for Gemini API usage.
Tracks: RPM (requests/minute), total TPM (input+output tokens/minute),
        RPD (requests/day), video hours/day (Tier 1 native video only).
RPD and video seconds persist across restarts via system_settings table.
"""
import time
import threading
import datetime
import logging

logger = logging.getLogger(__name__)

RPM_LIMIT        = 15
TPM_LIMIT        = 1_000_000
RPD_LIMIT        = 1_500
VIDEO_SECS_LIMIT = 8 * 3600   # 8 hours/day


class GeminiUsageTracker:
    def __init__(self):
        self._lock = threading.Lock()
        # Ring buffer: list of (timestamp, total_tokens) kept for last 60 s
        self._minute_log: list[tuple[float, int]] = []
        # Daily request counter
        self._day_str   = ""
        self._day_count = 0
        # Daily video seconds counter (Tier 1 only)
        self._vid_day_str  = ""
        self._vid_day_secs = 0.0
        self._db_loaded = False

    def _load_db(self):
        if self._db_loaded:
            return
        self._db_loaded = True
        try:
            from utils.database import get_db
            db = get_db()
            if db is None:
                return
            today = datetime.date.today().isoformat()

            val = db.get_setting("gemini_usage_daily")
            if val and isinstance(val, dict) and val.get("date") == today:
                self._day_str   = today
                self._day_count = int(val.get("count", 0))

            vval = db.get_setting("gemini_usage_video_daily")
            if vval and isinstance(vval, dict) and vval.get("date") == today:
                self._vid_day_str  = today
                self._vid_day_secs = float(vval.get("seconds", 0))
        except Exception as e:
            logger.warning(f"[GEMINI-USAGE] load: {e}")

    def _save_db(self):
        try:
            from utils.database import get_db
            db = get_db()
            if db is None:
                return
            db.set_setting("gemini_usage_daily", {
                "date": self._day_str, "count": self._day_count,
            })
            db.set_setting("gemini_usage_video_daily", {
                "date": self._vid_day_str, "seconds": self._vid_day_secs,
            })
        except Exception as e:
            logger.warning(f"[GEMINI-USAGE] save: {e}")

    def record(self, total_tokens: int = 0):
        """Record one API request with its total token count (input + output)."""
        now   = time.time()
        today = datetime.date.today().isoformat()
        with self._lock:
            self._load_db()
            cutoff = now - 60.0
            self._minute_log = [(ts, tk) for ts, tk in self._minute_log if ts >= cutoff]
            self._minute_log.append((now, total_tokens))
            if self._day_str != today:
                self._day_str   = today
                self._day_count = 0
            self._day_count += 1
            self._save_db()

    def record_video_seconds(self, secs: float):
        """Record video seconds consumed by a Tier 1 native-video Gemini call."""
        today = datetime.date.today().isoformat()
        with self._lock:
            self._load_db()
            if self._vid_day_str != today:
                self._vid_day_str  = today
                self._vid_day_secs = 0.0
            self._vid_day_secs += secs
            self._save_db()

    def get_video_seconds_used(self) -> float:
        today = datetime.date.today().isoformat()
        with self._lock:
            self._load_db()
            return self._vid_day_secs if self._vid_day_str == today else 0.0

    def get_stats(self) -> dict:
        now   = time.time()
        today = datetime.date.today().isoformat()
        with self._lock:
            self._load_db()
            cutoff = now - 60.0
            recent   = [(ts, tk) for ts, tk in self._minute_log if ts >= cutoff]
            rpm_used = len(recent)
            tpm_used = sum(tk for _, tk in recent)
            rpd_used = self._day_count if self._day_str == today else 0
            vid_secs = self._vid_day_secs if self._vid_day_str == today else 0.0
        return {
            "rpm":   {"used": rpm_used,  "limit": RPM_LIMIT},
            "tpm":   {"used": tpm_used,  "limit": TPM_LIMIT},
            "rpd":   {"used": rpd_used,  "limit": RPD_LIMIT},
            "video": {"used": vid_secs,  "limit": VIDEO_SECS_LIMIT},
        }


_tracker = GeminiUsageTracker()


def record_gemini_request(total_tokens: int = 0):
    _tracker.record(total_tokens)


def record_gemini_video_seconds(secs: float):
    _tracker.record_video_seconds(secs)


def get_gemini_video_seconds_used() -> float:
    return _tracker.get_video_seconds_used()


def get_gemini_usage() -> dict:
    return _tracker.get_stats()
