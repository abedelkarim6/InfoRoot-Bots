"""
One-time migration: move bots/collections/prompts/system from config.yaml + prompts.yaml into PostgreSQL.
Run while the app is stopped, then restart with the new code.

Usage:  python migrate_config_to_db.py
"""
import json
import yaml
import psycopg2
import psycopg2.extras

CONFIG_FILE = "config.yaml"
PROMPTS_FILE = "prompts.yaml"


def load_yaml(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}


def main():
    cfg = load_yaml(CONFIG_FILE)
    prompts_cfg = load_yaml(PROMPTS_FILE)

    dsn = cfg["database"]["dsn"]
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # --- System enabled ---
    enabled = cfg.get("system", {}).get("enabled", True)
    cur.execute("""
        INSERT INTO system_settings (key, value) VALUES ('system_enabled', %s)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    """, (json.dumps(enabled),))
    print(f"[OK] system_enabled = {enabled}")

    # --- Global rules ---
    rules = cfg.get("rules", {"remove": [], "replace": []})
    cur.execute("""
        INSERT INTO system_settings (key, value) VALUES ('global_rules', %s)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    """, (json.dumps(rules),))
    print(f"[OK] global_rules migrated")

    # --- Collections ---
    coll_count = 0
    for coll_name, coll_data in cfg.get("collections", {}).items():
        # Handle old format
        if "target_channel" in coll_data and "target_channels" not in coll_data:
            coll_data["target_channels"] = [coll_data["target_channel"]]

        cur.execute("""
            INSERT INTO collections (name, display_name, source_channels, target_channels, enabled)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (name) DO NOTHING
        """, (
            coll_name,
            coll_data.get("name", coll_name),
            json.dumps(coll_data.get("source_channels", [])),
            json.dumps(coll_data.get("target_channels", [])),
            coll_data.get("enabled", True),
        ))
        coll_count += 1
    print(f"[OK] {coll_count} collections migrated")

    # --- Bots ---
    bot_count = 0
    cat_count = 0
    topic_count = 0
    sched_count = 0

    for bot_name, bot_data in cfg.get("bots", {}).items():
        cur.execute("""
            INSERT INTO bots (name, enabled, minimum_messages, collection_names, rules)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (name) DO NOTHING
            RETURNING id
        """, (
            bot_name,
            bot_data.get("enabled", True),
            bot_data.get("minimum_messages", 5),
            json.dumps(bot_data.get("collections", [])),
            json.dumps(bot_data.get("rules", {"remove": [], "replace": []})),
        ))
        row = cur.fetchone()
        if not row:
            cur.execute("SELECT id FROM bots WHERE name = %s", (bot_name,))
            row = cur.fetchone()
        bot_id = row["id"]
        bot_count += 1

        for cat_name, cat_data in bot_data.get("categories", {}).items():
            cur.execute("""
                INSERT INTO categories (bot_id, name, enabled)
                VALUES (%s, %s, %s)
                ON CONFLICT (bot_id, name) DO NOTHING
                RETURNING id
            """, (bot_id, cat_name, cat_data.get("enabled", True)))
            row = cur.fetchone()
            if not row:
                cur.execute("SELECT id FROM categories WHERE bot_id = %s AND name = %s", (bot_id, cat_name))
                row = cur.fetchone()
            cat_id = row["id"]
            cat_count += 1

            for topic_name, topic_data in cat_data.get("topics", {}).items():
                cur.execute("""
                    INSERT INTO topics (category_id, name, enabled, linked_topics)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (category_id, name) DO NOTHING
                    RETURNING id
                """, (
                    cat_id,
                    topic_name,
                    topic_data.get("enabled", True),
                    json.dumps(topic_data.get("linked_topics", [])),
                ))
                row = cur.fetchone()
                if not row:
                    cur.execute("SELECT id FROM topics WHERE category_id = %s AND name = %s",
                                (cat_id, topic_name))
                    row = cur.fetchone()
                topic_id = row["id"]
                topic_count += 1

                for sched in topic_data.get("schedules", []):
                    cur.execute("""
                        INSERT INTO schedules (topic_id, name, type, enabled, prompt_key,
                                               header, header_datetime,
                                               minute, hour, hours, minutes,
                                               start_hour, start_minute)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        topic_id,
                        sched.get("name", ""),
                        sched.get("type", "hourly"),
                        sched.get("enabled", True),
                        sched.get("prompt_key"),
                        sched.get("header"),
                        sched.get("header_datetime", False),
                        sched.get("minute"),
                        sched.get("hour"),
                        sched.get("hours"),
                        sched.get("minutes"),
                        sched.get("start_hour"),
                        sched.get("start_minute"),
                    ))
                    sched_count += 1

    print(f"[OK] {bot_count} bots, {cat_count} categories, {topic_count} topics, {sched_count} schedules migrated")

    # --- Prompts ---
    prompt_count = 0
    for bot_name, bot_prompts in prompts_cfg.get("bots", {}).items():
        for key, val in bot_prompts.items():
            text = val.get("text", "") if isinstance(val, dict) else (val or "")
            cur.execute("""
                INSERT INTO prompts (bot_name, key, text) VALUES (%s, %s, %s)
                ON CONFLICT (bot_name, key) DO NOTHING
            """, (bot_name, key, text))
            prompt_count += 1
    print(f"[OK] {prompt_count} prompts migrated")

    # --- Config version ---
    cur.execute("""
        INSERT INTO system_settings (key, value) VALUES ('config_version', '1')
        ON CONFLICT (key) DO UPDATE SET value = '1'
    """)

    conn.commit()
    conn.close()
    print("\n[DONE] Migration complete. You can now restart the app.")


if __name__ == "__main__":
    main()
