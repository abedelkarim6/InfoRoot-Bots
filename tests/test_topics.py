"""
Category / Topic / Keyword / Schedule tests.

Regressions guarded:
- Renaming a topic must preserve its keywords (was wiping them)
- Reserved topic names (None, null) must be rejected
"""
import pytest
from conftest import ok, TEST_PREFIX

BOT      = f"{TEST_PREFIX}topic_bot"
CAT      = f"{TEST_PREFIX}cat"
TOPIC    = f"{TEST_PREFIX}topic"
TOPIC2   = f"{TEST_PREFIX}topic_renamed"
KEYWORD  = "_autotest_keyword"


# ── Session-scoped bot/category setup ────────────────────────────────────────

@pytest.fixture(scope="module")
def bot(admin_client):
    admin_client.post("/api/bot/delete", json={"name": BOT})
    ok(admin_client.post("/api/bot/save", json={"name": BOT}), "create test bot")
    yield BOT
    admin_client.post("/api/bot/delete", json={"name": BOT})


@pytest.fixture(scope="module")
def category(admin_client, bot):
    resp = admin_client.post("/api/category/add", json={"bot_name": bot, "category_name": CAT})
    ok(resp, "create test category")
    yield CAT


# ── Per-test topic setup ──────────────────────────────────────────────────────

@pytest.fixture
def topic(admin_client, category, bot):
    admin_client.post("/api/topic/delete", json={"bot_name": bot, "category_name": category, "topic_name": TOPIC})
    admin_client.post("/api/topic/delete", json={"bot_name": bot, "category_name": category, "topic_name": TOPIC2})
    ok(admin_client.post("/api/topic/add", json={
        "bot_name": bot, "category_name": category, "topic_name": TOPIC,
    }), "create test topic")
    yield TOPIC
    admin_client.post("/api/topic/delete", json={"bot_name": bot, "category_name": category, "topic_name": TOPIC})
    admin_client.post("/api/topic/delete", json={"bot_name": bot, "category_name": category, "topic_name": TOPIC2})


# ── Category tests ────────────────────────────────────────────────────────────

def test_add_category(admin_client, bot):
    extra = f"{TEST_PREFIX}extra_cat"
    resp = admin_client.post("/api/category/add", json={"bot_name": bot, "category_name": extra})
    ok(resp, "POST /api/category/add")
    admin_client.post("/api/category/delete", json={"bot_name": bot, "category_name": extra})


def test_add_category_missing_fields(admin_client, bot):
    resp = admin_client.post("/api/category/add", json={"bot_name": bot})
    assert resp.json()["status"] == "error"


# ── Topic tests ───────────────────────────────────────────────────────────────

def test_add_topic(admin_client, category, bot):
    admin_client.post("/api/topic/delete", json={"bot_name": bot, "category_name": category, "topic_name": TOPIC})
    ok(admin_client.post("/api/topic/add", json={
        "bot_name": bot, "category_name": category, "topic_name": TOPIC,
    }), "POST /api/topic/add")
    admin_client.post("/api/topic/delete", json={"bot_name": bot, "category_name": category, "topic_name": TOPIC})


@pytest.mark.parametrize("reserved", ["None", "none", "null", "NULL"])
def test_reserved_topic_names_rejected(admin_client, category, bot, reserved):
    """Regression: topics named 'None' caused phantom entries across the UI."""
    resp = admin_client.post("/api/topic/add", json={
        "bot_name": bot, "category_name": category, "topic_name": reserved,
    })
    assert resp.json()["status"] == "error", \
        f"Reserved name '{reserved}' was accepted — it will cause 'None' topics in UI"


# ── Keyword tests ─────────────────────────────────────────────────────────────

def test_add_keyword(admin_client, bot, category, topic):
    resp = admin_client.post("/api/topic/keyword/add", json={
        "bot_name": bot, "category_name": category,
        "topic_name": topic, "keyword": KEYWORD,
    })
    ok(resp, "POST /api/topic/keyword/add")


def test_keyword_appears_in_list(admin_client, bot, category, topic):
    admin_client.post("/api/topic/keyword/add", json={
        "bot_name": bot, "category_name": category,
        "topic_name": topic, "keyword": KEYWORD,
    })
    resp = admin_client.get("/api/topic/keywords", params={
        "bot_name": bot, "category_name": category, "topic_name": topic,
    })
    data = ok(resp, "GET /api/topic/keywords")
    kws = [k["keyword"] for k in data.get("keywords", [])]
    assert KEYWORD in kws, f"Keyword not found in list: {kws}"


def test_delete_keyword(admin_client, bot, category, topic):
    admin_client.post("/api/topic/keyword/add", json={
        "bot_name": bot, "category_name": category,
        "topic_name": topic, "keyword": KEYWORD,
    })
    resp = admin_client.post("/api/topic/keyword/delete", json={
        "bot_name": bot, "category_name": category,
        "topic_name": topic, "keyword": KEYWORD,
    })
    ok(resp, "POST /api/topic/keyword/delete")


# ── REGRESSION: rename must preserve keywords ─────────────────────────────────

def test_rename_topic_preserves_keywords(admin_client, bot, category, topic):
    """
    Regression: rename_topic only updated topics.name but not topic_keywords.topic_name,
    so all keywords were invisible after a rename.
    Fixed in summaries/db.py rename_topic().
    """
    # Add a keyword
    admin_client.post("/api/topic/keyword/add", json={
        "bot_name": bot, "category_name": category,
        "topic_name": topic, "keyword": KEYWORD,
    })

    # Rename the topic
    ok(admin_client.post("/api/topic/rename", json={
        "bot_name": bot, "category_name": category,
        "old_name": topic, "new_name": TOPIC2,
    }), "POST /api/topic/rename")

    # Keyword must still be there under the new name
    resp = admin_client.get("/api/topic/keywords", params={
        "bot_name": bot, "category_name": category, "topic_name": TOPIC2,
    })
    data = ok(resp, "GET /api/topic/keywords after rename")
    kws = [k["keyword"] for k in data.get("keywords", [])]
    assert KEYWORD in kws, (
        f"Keyword lost after rename (regression). "
        f"Keywords under '{TOPIC2}': {kws}"
    )
