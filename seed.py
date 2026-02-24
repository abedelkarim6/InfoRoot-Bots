"""
seed.py — Initialize the database and seed topic keywords from config.yaml.

Run this once on a fresh setup (or to force-refresh keywords):
    python seed.py

What it does:
  - Creates the required tables (topic_keywords, messages, summaries) if they don't exist
  - Clears any existing topic_keywords and re-inserts all keywords from config.yaml
  - Does NOT touch the messages or summaries tables

What it does NOT do:
  - It does not seed messages or summaries (those are runtime/test data)
  - Bot, collection, category, topic, and rule config lives in config.yaml — not the DB
"""

import sys
import os

import psycopg2
import psycopg2.extras
import yaml


CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.yaml")


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def create_tables(cursor):
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS topic_keywords (
            id SERIAL PRIMARY KEY,
            bot_name TEXT NOT NULL,
            category_name TEXT NOT NULL,
            topic_name TEXT NOT NULL,
            keyword TEXT NOT NULL,
            UNIQUE(bot_name, category_name, topic_name, keyword)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            channel_id BIGINT NOT NULL,
            text TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            summarized_minute BOOLEAN DEFAULT FALSE,
            summarized_hourly BOOLEAN DEFAULT FALSE,
            summarized_daily BOOLEAN DEFAULT FALSE,
            countries TEXT,
            regions TEXT,
            topics TEXT,
            categories TEXT,
            keywords_found TEXT,
            bot_name TEXT,
            original_text TEXT,
            replaced_text TEXT,
            channel_username TEXT,
            collection_name TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS summaries (
            id SERIAL PRIMARY KEY,
            summary_text TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            summary_type TEXT NOT NULL,
            target_entity TEXT NOT NULL,
            bot_name TEXT,
            topic_name TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    print("[tables] All tables ready.")


def seed_keywords(cursor, config):
    bots = config.get("bots", {})
    if not bots:
        print("[keywords] No bots found in config.yaml — nothing to seed.")
        return

    # Wipe existing keywords for a clean reseed
    cursor.execute("DELETE FROM topic_keywords")
    print("[keywords] Cleared existing topic_keywords.")

    total = 0
    for bot_name, bot_data in bots.items():
        categories = bot_data.get("categories", {})
        for category_name, category_data in categories.items():
            topics = category_data.get("topics", {})
            for topic_name, topic_data in topics.items():
                keywords = topic_data.get("keywords", [])
                inserted = 0
                for kw in keywords:
                    kw = str(kw).strip()
                    if not kw:
                        continue
                    cursor.execute("""
                        INSERT INTO topic_keywords (bot_name, category_name, topic_name, keyword)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                    """, (bot_name, category_name, topic_name, kw))
                    inserted += cursor.rowcount

                if inserted:
                    print(f"  [{bot_name}] {category_name} / {topic_name}: {inserted} keywords")
                    total += inserted

    print(f"\n[keywords] Done — {total} keywords seeded across {len(bots)} bot(s).")


def main():
    print("=" * 55)
    print("  Telegram Bot DB Seeder")
    print("=" * 55)

    cfg = load_config()
    dsn = cfg.get("database", {}).get("dsn")
    if not dsn:
        print("[ERROR] No database.dsn found in config.yaml")
        sys.exit(1)

    print(f"[db] Connecting to: {dsn.split('@')[-1]}")  # hide credentials in output

    try:
        conn = psycopg2.connect(dsn)
        conn.autocommit = False
        cursor = conn.cursor()
    except Exception as e:
        print(f"[ERROR] Could not connect to database: {e}")
        sys.exit(1)

    try:
        create_tables(cursor)
        seed_keywords(cursor, cfg)
        conn.commit()
        print("\n[done] Database seeded successfully.")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] Seeding failed, rolled back: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
