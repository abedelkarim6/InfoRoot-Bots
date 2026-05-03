"""
Tests for the summaries and interims DB/API layer.

These tests seed data directly via DB methods (no AI, no Telegram) and verify:
  - Interim save / retrieve / mark-sent lifecycle
  - Sequential interim_number ordering
  - summary_composition endpoint wires interims to messages correctly
  - Graceful handling of unknown IDs on all monitor endpoints

DB fixtures: call get_db() directly (separate process/pool from the server).
API fixtures: use admin_client to hit the live server over HTTP.
"""
import sys
import yaml
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from summaries.db import SummariesDB
from conftest import ok, TEST_PREFIX

ROOT = Path(__file__).parent.parent

def _make_db():
    with open(ROOT / "config.yaml", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return SummariesDB(cfg["database"]["dsn"])

BOT   = f"{TEST_PREFIX}sumtest_bot"
TOPIC = f"{TEST_PREFIX}sumtest_topic"

# Fake message IDs that won't exist in the messages table — enough to exercise
# the mapping logic (get_messages_by_ids returns [] for unknown ids, which is fine)
MSG_IDS = [999991, 999992, 999993, 999994, 999995]


# ── Shared DB instance ────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def db():
    return _make_db()


# ── Seeded interims (module scope — created once, torn down after all tests) ──

@pytest.fixture(scope="module")
def three_interims(db):
    """Insert 3 interims for BOT/TOPIC, oldest → newest. Yield their ids."""
    ids = []
    for i in range(1, 4):
        iid = db.save_interim_summary(BOT, TOPIC, f"interim text {i}", message_count=i * 5)
        ids.append(iid)
    yield ids
    try:
        cursor = db._get_cursor()
        cursor.execute("DELETE FROM topic_interim_summaries WHERE id = ANY(%s)", (ids,))
    finally:
        db._commit()


@pytest.fixture(scope="module")
def one_interim(db):
    """Single interim with known message linkages via message_summarizations."""
    iid = db.save_interim_summary(BOT, TOPIC, "single interim", message_count=3)

    # Link MSG_IDS[0..2] to this interim in message_summarizations
    try:
        cursor = db._get_cursor()
        for mid in MSG_IDS[:3]:
            cursor.execute("""
                INSERT INTO message_summarizations
                    (message_id, bot_name, topic_name, schedule_type, interim_id)
                VALUES (%s, %s, %s, 'interim', %s)
                ON CONFLICT (message_id, bot_name, topic_name, schedule_type) DO UPDATE
                    SET interim_id = EXCLUDED.interim_id
            """, (mid, BOT, TOPIC, iid))
    finally:
        db._commit()

    yield iid

    try:
        cursor = db._get_cursor()
        cursor.execute("DELETE FROM topic_interim_summaries WHERE id = %s", (iid,))
        cursor.execute(
            "DELETE FROM message_summarizations WHERE bot_name = %s AND topic_name = %s",
            (BOT, TOPIC),
        )
    finally:
        db._commit()


@pytest.fixture(scope="module")
def one_summary(db, one_interim):
    """A summary whose message_ids span the linked interim messages + extras."""
    all_ids = MSG_IDS  # [:3] covered by interim, [3:] are remaining
    sid = db.save_summary(
        "final summary text", len(all_ids), "scheduled", "@testchannel",
        bot_name=BOT, topic_name=TOPIC, message_ids=all_ids,
    )
    yield sid
    try:
        cursor = db._get_cursor()
        cursor.execute("DELETE FROM summaries WHERE id = %s", (sid,))
    finally:
        db._commit()


# ══════════════════════════════════════════════════════════════════════════════
# DB-layer tests
# ══════════════════════════════════════════════════════════════════════════════

def test_save_interim_returns_int_id(db):
    iid = db.save_interim_summary(BOT, TOPIC, "temp", message_count=1)
    assert isinstance(iid, int) and iid > 0
    try:
        cursor = db._get_cursor()
        cursor.execute("DELETE FROM topic_interim_summaries WHERE id = %s", (iid,))
    finally:
        db._commit()


def test_get_latest_interim_returns_newest(db, three_interims):
    row = db.get_latest_interim(BOT, TOPIC)
    assert row is not None, "get_latest_interim returned None"
    # The last inserted id should be the latest
    assert row['id'] == three_interims[-1], (
        f"Expected latest id={three_interims[-1]}, got {row['id']}"
    )


def test_get_latest_interim_unknown_topic_returns_none(db):
    row = db.get_latest_interim(BOT, "_autotest_nonexistent_topic_xyz")
    assert row is None


def test_mark_interim_sent_sets_sent_at(db, three_interims):
    target_id = three_interims[0]
    db.mark_interim_summaries_sent([target_id])
    rows = db.get_interims_by_ids([target_id])
    assert rows, "get_interims_by_ids returned empty after mark"
    assert rows[0]['status'] == 'done', f"Expected status='done', got {rows[0]['status']}"
    assert rows[0]['sent_at'] is not None


def test_get_unsent_interims_excludes_sent(db, three_interims):
    from datetime import datetime, timedelta
    since = datetime.utcnow() - timedelta(hours=1)
    unsent = db.get_unsent_interim_summaries(BOT, TOPIC, since)
    sent_ids = {three_interims[0]}
    for row in unsent:
        assert row['id'] not in sent_ids, (
            f"Interim {row['id']} was marked sent but still returned as unsent"
        )


def test_get_interims_by_ids_ordered_with_interim_number(db, three_interims):
    rows = db.get_interims_by_ids(three_interims)
    assert len(rows) == 3, f"Expected 3 rows, got {len(rows)}"
    # Must be ordered by id ASC
    assert [r['id'] for r in rows] == sorted(three_interims)
    # interim_number must be sequential (1, 2, 3) for the same bot/topic
    numbers = [r['interim_number'] for r in rows]
    assert numbers == sorted(numbers), "interim_number not ascending"
    assert len(set(numbers)) == len(numbers), "interim_number has duplicates"


def test_get_interims_by_ids_status_field(db, three_interims):
    rows = db.get_interims_by_ids(three_interims)
    for row in rows:
        assert row['status'] in ('pending', 'done'), f"Unexpected status: {row['status']}"
        assert 'preview' in row
        assert 'created_at' in row


def test_save_summary_returns_int_id(db):
    sid = db.save_summary("text", 1, "scheduled", "@ch", bot_name=BOT, topic_name=TOPIC)
    assert isinstance(sid, int) and sid > 0
    try:
        cursor = db._get_cursor()
        cursor.execute("DELETE FROM summaries WHERE id = %s", (sid,))
    finally:
        db._commit()


def test_get_interim_ids_for_messages_maps_correctly(db, one_interim):
    mapping = db.get_interim_ids_for_messages(MSG_IDS[:3], bot_name=BOT, topic_name=TOPIC)
    assert len(mapping) == 3, f"Expected 3 mapped, got {len(mapping)}"
    for mid in MSG_IDS[:3]:
        assert mapping[mid] == one_interim, (
            f"message {mid} mapped to {mapping.get(mid)}, expected {one_interim}"
        )


def test_get_interim_ids_empty_input(db):
    result = db.get_interim_ids_for_messages([])
    assert result == {}


def test_get_interims_filter_by_bot(db, three_interims):
    rows = db.get_interims(bot_name=BOT)
    ids_returned = {r['id'] for r in rows}
    for iid in three_interims:
        assert iid in ids_returned, f"Interim {iid} missing from filtered result"


# ══════════════════════════════════════════════════════════════════════════════
# API-layer tests
# ══════════════════════════════════════════════════════════════════════════════

def test_interims_endpoint_returns_structure(admin_client):
    resp = admin_client.get("/api/monitor/interims")
    data = ok(resp, "GET /api/monitor/interims")
    assert "interims" in data, "Missing 'interims' key"
    assert isinstance(data["interims"], list)


def test_interims_endpoint_bot_filter_returns_subset(admin_client, three_interims):
    resp = admin_client.get("/api/monitor/interims", params={"bot": BOT})
    data = ok(resp, "GET /api/monitor/interims?bot=...")
    ids_returned = {r["id"] for r in data["interims"]}
    for iid in three_interims:
        assert iid in ids_returned, f"Interim {iid} missing when filtering by bot"


def test_interims_endpoint_topic_filter(admin_client, three_interims):
    resp = admin_client.get("/api/monitor/interims", params={"bot": BOT, "topic": TOPIC})
    data = ok(resp, "GET /api/monitor/interims?bot=&topic=")
    for r in data["interims"]:
        assert r["bot_name"] == BOT
        assert r["topic_name"] == TOPIC


def test_summary_messages_nonexistent_id(admin_client):
    resp = admin_client.get("/api/monitor/summary-messages", params={"id": 999999999})
    data = ok(resp, "GET /api/monitor/summary-messages?id=nonexistent")
    assert data.get("messages") == [], f"Expected empty list, got {data.get('messages')}"


def test_summary_composition_nonexistent_id(admin_client):
    resp = admin_client.get("/api/monitor/summary-composition", params={"id": 999999999})
    data = ok(resp, "GET /api/monitor/summary-composition?id=nonexistent")
    assert data.get("interims") == []
    assert data.get("remaining_messages") == []


def test_summary_composition_links_interim(admin_client, one_summary, one_interim):
    """
    Regression: composition must return the interim that covers the first batch
    of messages and leave remaining messages separate.
    """
    resp = admin_client.get("/api/monitor/summary-composition", params={"id": one_summary})
    data = ok(resp, "GET /api/monitor/summary-composition")

    interim_ids = [i["id"] for i in data.get("interims", [])]
    assert one_interim in interim_ids, (
        f"Expected interim {one_interim} in composition, got {interim_ids}"
    )
    # Remaining messages are those NOT covered by any interim (MSG_IDS[3:])
    remaining_ids = {m["id"] for m in data.get("remaining_messages", [])}
    for mid in MSG_IDS[3:]:
        # These are fake IDs so get_messages_by_ids returns nothing — just check
        # the composition didn't wrongly classify them as interim-covered
        assert mid not in [m["id"] for i in data["interims"] for m in i.get("messages", [])]


def test_interim_messages_nonexistent_id(admin_client):
    resp = admin_client.get("/api/monitor/interim-messages", params={"id": 999999999})
    data = ok(resp, "GET /api/monitor/interim-messages?id=nonexistent")
    assert isinstance(data.get("messages", []), list)
