"""
Test fixtures. Requires the server to be running.

Run all tests:          pytest tests/
Skip slow Telegram:     pytest tests/ -m "not slow"
One feature only:       pytest tests/test_collections.py
"""
import os
import pytest
import httpx
import yaml
from pathlib import Path

BASE_URL = os.getenv("TEST_BASE_URL", "http://localhost:8000")
ROOT     = Path(__file__).parent.parent

# All test data uses this prefix so cleanup is safe and obvious
TEST_PREFIX = "_autotest_"


def _load_admin_creds():
    with open(ROOT / "config.yaml") as f:
        cfg = yaml.safe_load(f)
    adm = cfg.get("admin", {})
    return adm.get("username", "admin"), adm.get("password", "")


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "slow: requires a live Telegram connection (skip with -m 'not slow')",
    )


# ── Admin client (session-scoped — logs in once for the whole run) ────────────

@pytest.fixture(scope="session")
def admin_client():
    username, password = _load_admin_creds()
    client = httpx.Client(base_url=BASE_URL, timeout=30)

    # Fail fast if server isn't up
    try:
        client.get("/login")
    except httpx.ConnectError:
        pytest.exit(f"Server not reachable at {BASE_URL}. Start it first.", returncode=1)

    resp = client.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, f"Admin login HTTP error: {resp.text}"
    data = resp.json()
    assert data["status"] == "ok", f"Admin login failed: {data}"
    client.headers["Authorization"] = f"Bearer {data['token']}"

    yield client

    client.post("/api/auth/logout")
    client.close()


# ── Helpers used by multiple test modules ─────────────────────────────────────

def ok(resp, context=""):
    """Assert HTTP 200 and status==ok, print helpful message on failure."""
    assert resp.status_code == 200, \
        f"{context} HTTP {resp.status_code}: {resp.text[:300]}"
    data = resp.json()
    assert data.get("status") not in ("error",), \
        f"{context} returned error: {data.get('message', data)}"
    return data
