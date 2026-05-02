"""
Smoke tests — hit every GET endpoint, assert HTTP 200 and no error status.
Run these after EVERY change. They catch 90% of regressions in under 10 seconds.

Usage:
    pytest tests/test_smoke.py
"""
import pytest
from conftest import ok

# Every GET endpoint in the app. Add new ones here when they're built.
GET_ENDPOINTS = [
    # Auth
    "/api/auth/me",
    # Config / prompts
    "/api/config",
    "/api/prompts",
    "/api/rules",
    # Bots / collections / topics
    "/api/bots",
    "/api/collections",
    # Monitor
    "/api/monitor/data",
    "/api/monitor/messages",
    "/api/monitor/unclassified",
    "/api/monitor/missed",
    "/api/monitor/schedule-stats",
    "/api/monitor/schedule-history",
    "/api/monitor/pending-messages",
    # Dashboard
    "/api/dashboard/stats",
    # Recycle bin
    "/api/recycle-bin/list",
    # System
    "/api/system/status",
    "/api/system/fixed-prefix",
    "/api/system/ai-usage-details",
    # YouTube
    "/api/youtube/overview",
    "/api/youtube/channels",
    "/api/youtube/keywords",
    "/api/youtube/summaries",
    "/api/youtube/queue",
    "/api/youtube/blocked-channels",
    "/api/youtube/blocked-keywords",
    "/api/youtube/prompt",
    "/api/youtube/fixed-prefix",
    # Warnings / logs
    "/api/warnings",
    "/api/logs",
]


@pytest.mark.parametrize("path", GET_ENDPOINTS)
def test_get_endpoint_no_error(admin_client, path):
    resp = admin_client.get(path)
    assert resp.status_code == 200, \
        f"GET {path} → HTTP {resp.status_code}\n{resp.text[:400]}"
    data = resp.json()
    assert data.get("status") != "error", \
        f"GET {path} returned error: {data.get('message', data)}"
