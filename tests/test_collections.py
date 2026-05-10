"""
Collection CRUD tests.

Note: collection_save for admin requires at least one target_channel.
We use a placeholder string — the API doesn't validate channel existence on save.
"""
import pytest
from conftest import ok, TEST_PREFIX

NAME     = f"{TEST_PREFIX}collection"
RENAMED  = f"{TEST_PREFIX}collection_renamed"
FAKE_CH  = "@_autotest_fake_channel"


@pytest.fixture(autouse=True)
def cleanup(admin_client):
    """Delete test collections before and after each test."""
    for n in (NAME, RENAMED):
        admin_client.post("/api/collection/delete", json={"collection_name": n})
    yield
    for n in (NAME, RENAMED):
        admin_client.post("/api/collection/delete", json={"collection_name": n})


# ── Helpers ───────────────────────────────────────────────────────────────────

def _create(client, name=NAME):
    return client.post("/api/collection/save", json={
        "collection_name": name,
        "source_channels":  [],
        "target_channels":  [FAKE_CH],
    })


def _collection_names(client):
    resp = client.get("/api/collections")
    data = ok(resp, "GET /api/collections")
    raw = data.get("collections") or data.get("data") or data
    if isinstance(raw, dict):
        return set(raw.keys())
    if isinstance(raw, list):
        return {c.get("collection_name") or c.get("name") for c in raw}
    return set()


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_list_collections(admin_client):
    ok(admin_client.get("/api/collections"), "GET /api/collections")


def test_create_collection(admin_client):
    ok(_create(admin_client), "POST /api/collection/save")


def test_created_collection_appears_in_list(admin_client):
    _create(admin_client)
    assert NAME in _collection_names(admin_client), \
        f"{NAME} not found in collections after create"


def test_create_allows_empty_target_channels(admin_client):
    """
    Sources and destinations are edited independently in the React UI, so a
    collection may be partially configured (no targets yet). Empty
    target_channels must NOT be rejected.
    """
    resp = admin_client.post("/api/collection/save", json={
        "collection_name": NAME,
        "source_channels":  [],
        "target_channels":  [],
    })
    ok(resp, "POST /api/collection/save with empty target_channels")


def test_create_requires_collection_name(admin_client):
    resp = admin_client.post("/api/collection/save", json={
        "source_channels": [],
        "target_channels": [FAKE_CH],
    })
    assert resp.status_code == 200
    assert resp.json()["status"] == "error", \
        "Missing collection_name should return error"


def test_rename_collection(admin_client):
    _create(admin_client)
    ok(admin_client.post("/api/collection/rename", json={
        "old_name": NAME,
        "new_name": RENAMED,
    }), "POST /api/collection/rename")

    names = _collection_names(admin_client)
    assert RENAMED in names, "Renamed collection not found"
    assert NAME    not in names, "Old name still present after rename"


def test_delete_collection(admin_client):
    _create(admin_client)
    ok(admin_client.post("/api/collection/delete", json={"collection_name": NAME}),
       "POST /api/collection/delete")
    assert NAME not in _collection_names(admin_client), \
        "Collection still present after delete"


def test_toggle_collection(admin_client):
    _create(admin_client)
    resp = admin_client.post("/api/collection/toggle", json={
        "collection_name": NAME,
        "enabled": False,
    })
    ok(resp, "POST /api/collection/toggle")
