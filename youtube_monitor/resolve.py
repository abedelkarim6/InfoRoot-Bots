"""
Resolve any YouTube channel reference to a canonical UC… channel id.

Accepts: a bare UC id, an @handle, a /channel/UC… URL, a legacy /c/<slug> or
/user/<slug> custom URL, a bare custom slug, or even a video link — and returns
the channel's canonical UC id (plus name/handle when available).

The primary method fetches the public page and extracts the embedded
canonical channelId. This needs no Data API quota and — unlike the API — works
for legacy /c/ and /user/ custom URLs, which the API can't resolve directly.
"""
import re
import logging
import urllib.parse

import httpx

logger = logging.getLogger(__name__)

_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
# Pre-accept the cookie-consent so datacenter IPs get the real page instead of
# YouTube's "before you continue" consent interstitial (which has no channelId).
_CONSENT_COOKIES = {"SOCS": "CAI", "CONSENT": "YES+cb"}
_UC_RE = re.compile(r"^UC[0-9A-Za-z_-]{22}$")


def _extract(html: str):
    """Pull (channel_id, name, handle) out of a YouTube page's HTML."""
    m = (
        re.search(r'"(?:channelId|externalId)":"(UC[0-9A-Za-z_-]{22})"', html)
        or re.search(r"youtube\.com/channel/(UC[0-9A-Za-z_-]{22})", html)
        or re.search(r'<meta itemprop="identifier" content="(UC[0-9A-Za-z_-]{22})"', html)
    )
    uc = m.group(1) if m else None

    nm = re.search(r'<meta property="og:title" content="([^"]+)"', html)
    name = nm.group(1).strip() if nm else None

    hm = re.search(r'"canonicalBaseUrl":"/(@[^"/]+)"', html)
    handle = urllib.parse.unquote(hm.group(1)) if hm else None

    return uc, name, handle


async def _fetch(client: httpx.AsyncClient, url: str):
    try:
        r = await client.get(url, headers=_UA, cookies=_CONSENT_COOKIES,
                             timeout=20, follow_redirects=True)
        if r.status_code == 200:
            return r.text
    except Exception as e:
        logger.debug(f"[YT-RESOLVE] fetch failed for {url}: {e}")
    return None


def _candidate_urls(raw: str):
    """Build the list of public URLs to try for a given raw reference."""
    if raw.startswith("http://") or raw.startswith("https://"):
        return [raw]
    if "youtube.com" in raw or "youtu.be" in raw:
        return ["https://" + raw]
    if raw.startswith("@"):
        return [f"https://www.youtube.com/{raw}"]
    # Bare slug — could be an @handle, a /c/ custom URL, or a /user/ legacy URL.
    q = urllib.parse.quote(raw)
    return [
        f"https://www.youtube.com/@{q}",
        f"https://www.youtube.com/c/{q}",
        f"https://www.youtube.com/user/{q}",
    ]


async def resolve_channel(raw: str):
    """Resolve `raw` to {'channel_id', 'channel_name', 'handle'} or None.

    Never raises — returns None if nothing could be resolved.
    """
    raw = (raw or "").strip()
    if not raw:
        return None

    # Already a bare UC id.
    if _UC_RE.match(raw):
        return {"channel_id": raw, "channel_name": None, "handle": None}

    # A /channel/UC… URL (no network needed).
    m = re.search(r"/channel/(UC[0-9A-Za-z_-]{22})", raw)
    if m:
        return {"channel_id": m.group(1), "channel_name": None, "handle": None}

    async with httpx.AsyncClient() as client:
        for url in _candidate_urls(raw):
            html = await _fetch(client, url)
            if not html:
                continue
            uc, name, handle = _extract(html)
            if uc:
                return {"channel_id": uc, "channel_name": name, "handle": handle}

    return None
