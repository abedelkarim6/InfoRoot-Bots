"""
Tests for the channel picker endpoint (/api/telegram/userbot/dialogs).

Regressions guarded:
- Admin must never get status=no_session
- Channels response must include can_post, is_broadcast fields
  (missing can_post broke the "Browse writable" target-channel filter)
- /api/telegram/admin_channels endpoint still works independently
"""
import pytest
from conftest import ok


@pytest.mark.slow
def test_admin_never_gets_no_session(admin_client):
    """Admin request must never return no_session."""
    resp = admin_client.get("/api/telegram/userbot/dialogs")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("status") != "no_session", (
        "Admin received no_session — telegram_session is missing from DB/config.yaml"
    )


@pytest.mark.slow
def test_channel_list_has_required_fields(admin_client):
    """
    When the endpoint returns channels, every channel must include can_post
    and is_broadcast. Missing fields silently break the picker filter.
    """
    resp = admin_client.get("/api/telegram/userbot/dialogs")
    assert resp.status_code == 200
    data = resp.json()

    if data.get("status") != "ok":
        pytest.skip(f"Telegram not available: {data.get('message', data)}")

    channels = data.get("channels", [])
    assert isinstance(channels, list)

    for ch in channels[:5]:  # spot-check first 5
        assert "id"           in ch, f"Channel missing 'id': {ch}"
        assert "title"        in ch, f"Channel missing 'title': {ch}"
        assert "can_post"     in ch, f"Channel missing 'can_post' — target filter will show empty: {ch}"
        assert "is_broadcast" in ch, f"Channel missing 'is_broadcast': {ch}"


@pytest.mark.slow
def test_admin_channels_endpoint_still_works(admin_client):
    """/api/telegram/admin_channels (used by Channel Membership Validator) must still work."""
    resp = admin_client.get("/api/telegram/admin_channels")
    assert resp.status_code == 200
    data = resp.json()
    # Acceptable: ok or a Telegram connection error — never a Python crash
    assert "status" in data, f"Unexpected response shape: {data}"
    assert resp.status_code != 500, "Endpoint crashed (500)"
