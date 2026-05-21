#!/usr/bin/env python3
"""
WebSub subscription validator.

Queries Google's PubSubHubbub hub for the *real* lease/expiration of every
active YouTube channel and compares it against what the DB thinks
(`yt_channels.websub_expires_at`). This reveals whether subscriptions are
expiring sooner than the 9-day lease the app requests.

Usage (run on the server, from the repo root):

    python validate_websub.py https://your-public-domain.com

The callback base URL must be the SAME public URL YouTube reaches the app on
(the app derives it from the incoming request, so it is not stored anywhere).
If `youtube.websub_secret` is set in config.yaml it is picked up automatically.
"""

import re
import sys
from datetime import datetime, timezone

import httpx
import psycopg2
import psycopg2.extras

from utils.helpers import load_config

HUB_DETAILS = "https://pubsubhubbub.appspot.com/subscription-details"
TOPIC_BASE = "https://www.youtube.com/xml/feeds/videos.xml?channel_id="


def _strip_tags(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return "\n".join(ln.strip() for ln in text.splitlines() if ln.strip())


def _extract(label: str, text: str) -> str:
    """Pull the value following a label from the stripped details page."""
    m = re.search(rf"{re.escape(label)}\s*[:\-]?\s*(.+)", text, re.IGNORECASE)
    return m.group(1).strip() if m else ""


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    base = sys.argv[1].rstrip("/")
    callback_url = f"{base}/youtube/websub/callback"

    cfg = load_config()
    dsn = cfg["database"]["dsn"]
    secret = (cfg.get("youtube", {}) or {}).get("websub_secret", "") or ""

    print(f"Callback URL : {callback_url}")
    print(f"WebSub secret: {'(set)' if secret else '(none)'}")
    print("=" * 78)

    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT channel_id, channel_name, websub_subscribed_at, websub_expires_at
        FROM yt_channels
        WHERE active = TRUE
        ORDER BY channel_name
    """)
    channels = cur.fetchall()
    cur.close()
    conn.close()

    if not channels:
        print("No active channels in yt_channels.")
        return

    now = datetime.now(timezone.utc)

    for ch in channels:
        cid = ch["channel_id"]
        name = ch["channel_name"] or cid
        topic = f"{TOPIC_BASE}{cid}"

        params = {"hub.callback": callback_url, "hub.topic": topic}
        if secret:
            params["hub.secret"] = secret

        print(f"\n● {name}  ({cid})")
        db_sub = ch["websub_subscribed_at"]
        db_exp = ch["websub_expires_at"]
        print(f"   DB subscribed_at : {db_sub}")
        print(f"   DB expires_at    : {db_exp}  <- what the app assumes (request lease)")

        try:
            resp = httpx.get(HUB_DETAILS, params=params, timeout=30,
                             follow_redirects=True)
        except Exception as e:
            print(f"   HUB              : ERROR contacting hub: {e}")
            continue

        if resp.status_code != 200:
            print(f"   HUB              : HTTP {resp.status_code} — "
                  f"no subscription found (callback/topic/secret mismatch?)")
            continue

        text = _strip_tags(resp.text)
        state = _extract("State", text)
        # The hub labels vary slightly; try the common ones.
        expires = (_extract("Expiration time", text)
                   or _extract("Lease expiration", text)
                   or _extract("Expires", text))
        last_verify = (_extract("Last successful verification", text)
                       or _extract("Last verification", text))
        last_delivery = (_extract("Last delivery", text)
                         or _extract("Last successful delivery", text))

        print(f"   HUB state        : {state or '(unknown)'}")
        print(f"   HUB expiration   : {expires or '(not shown)'}  <- the REAL lease")
        if last_verify:
            print(f"   HUB last verify  : {last_verify}")
        if last_delivery:
            print(f"   HUB last deliver : {last_delivery}")

        # Real lease length, if both subscribe + expiry are known.
        if db_sub and expires:
            try:
                exp_dt = datetime.fromisoformat(
                    re.sub(r"\s*\(.*\)\s*$", "", expires).strip()
                    .replace("Z", "+00:00"))
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
                sub_dt = db_sub if db_sub.tzinfo else db_sub.replace(tzinfo=timezone.utc)
                lease_days = (exp_dt - sub_dt).total_seconds() / 86400
                left_days = (exp_dt - now).total_seconds() / 86400
                print(f"   >> REAL lease    : ~{lease_days:.1f} days "
                      f"(app requested 9.0) | {left_days:.1f} days left")
            except Exception:
                pass

        if state and state.lower() not in ("verified", "subscribed"):
            print("   >> WARNING: subscription is NOT active — videos are being missed.")

    print("\n" + "=" * 78)
    print("If 'REAL lease' is well under 9 days, the renewal cadence must be "
          "shorter than that value.")


if __name__ == "__main__":
    main()
