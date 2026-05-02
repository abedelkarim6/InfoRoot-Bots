"""
Bot CRUD tests.
"""
import pytest
from conftest import ok, TEST_PREFIX

BOT      = f"{TEST_PREFIX}bot"
BOT_DUP  = f"{TEST_PREFIX}bot_dup"


@pytest.fixture(autouse=True)
def cleanup(admin_client):
    for name in (BOT, BOT_DUP):
        admin_client.post("/api/bot/delete", json={"name": name})
    yield
    for name in (BOT, BOT_DUP):
        admin_client.post("/api/bot/delete", json={"name": name})


def _create(client, name=BOT):
    return client.post("/api/bot/save", json={"name": name})


def _bot_names(client):
    resp = client.get("/api/bots")
    data = ok(resp, "GET /api/bots")
    raw = data.get("bots") or data.get("data") or data
    if isinstance(raw, dict):
        return set(raw.keys())
    if isinstance(raw, list):
        return {b.get("name") or b.get("bot_name") for b in raw}
    return set()


def test_list_bots(admin_client):
    ok(admin_client.get("/api/bots"), "GET /api/bots")


def test_create_bot(admin_client):
    ok(_create(admin_client), "POST /api/bot/save")


def test_created_bot_appears_in_list(admin_client):
    _create(admin_client)
    assert BOT in _bot_names(admin_client), f"{BOT} not in bot list after create"


def test_create_bot_missing_name(admin_client):
    resp = admin_client.post("/api/bot/save", json={})
    assert resp.json()["status"] == "error", "Missing name should return error"


def test_delete_bot(admin_client):
    _create(admin_client)
    ok(admin_client.post("/api/bot/delete", json={"name": BOT}), "POST /api/bot/delete")


def test_rename_bot(admin_client):
    new_name = f"{TEST_PREFIX}bot_renamed"
    admin_client.post("/api/bot/delete", json={"name": new_name})
    _create(admin_client)
    ok(admin_client.post("/api/bot/rename", json={"old_name": BOT, "new_name": new_name}),
       "POST /api/bot/rename")
    assert new_name in _bot_names(admin_client), "Renamed bot not found"
    admin_client.post("/api/bot/delete", json={"name": new_name})


def test_duplicate_bot(admin_client):
    _create(admin_client)
    resp = admin_client.post("/api/bot/duplicate", json={
        "source_name": BOT,
        "new_name":    BOT_DUP,
    })
    ok(resp, "POST /api/bot/duplicate")
    assert BOT_DUP in _bot_names(admin_client), "Duplicated bot not found"
