#!/usr/bin/env python3
"""One-off backfill: ESTIMATE audio_tokens for historical YouTube summaries.

Rows written before audio-modality tracking existed have audio_tokens = NULL.
Gemini's native video ingestion tokenizes the soundtrack at roughly
**32 audio tokens per second**, and we store `duration_secs`, so we can
approximate the split for past rows:

    audio_tokens = LEAST(input_tokens, 32 * duration_secs)

This is an ESTIMATE, not recovered data — the true per-call modality split is
not retrievable after the fact. It only affects rows produced by the native
video strategy (`transcript_source = 'gemini_video'`); transcript-only runs are
text input with no audio. Rows already carrying a real (tracked) value are left
alone, so re-running is safe.

Usage:
    python backfill_yt_audio_tokens.py              # dry run — shows the impact
    python backfill_yt_audio_tokens.py --apply      # actually write
"""

import sys

AUDIO_TOKENS_PER_SEC = 32

SELECT_PREVIEW = """
    SELECT COUNT(*) AS rows,
           COALESCE(SUM(LEAST(COALESCE(input_tokens, 0),
                              %s * COALESCE(duration_secs, 0))), 0) AS est_audio,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS total_input
    FROM yt_summaries
    WHERE transcript_source = 'gemini_video'
      AND audio_tokens IS NULL
      AND input_tokens IS NOT NULL
"""

UPDATE_SQL = """
    UPDATE yt_summaries
    SET audio_tokens = LEAST(COALESCE(input_tokens, 0),
                             %s * COALESCE(duration_secs, 0))
    WHERE transcript_source = 'gemini_video'
      AND audio_tokens IS NULL
      AND input_tokens IS NOT NULL
"""


def main():
    apply = "--apply" in sys.argv

    sys.path.insert(0, ".")
    from utils.helpers import load_config
    import psycopg2
    import psycopg2.extras

    dsn = load_config()["database"]["dsn"]
    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(SELECT_PREVIEW, (AUDIO_TOKENS_PER_SEC,))
    p = cur.fetchone()
    print(f"Candidate rows (gemini_video, audio_tokens IS NULL): {p['rows']}")
    print(f"  total input tokens on those rows : {p['total_input']:,}")
    print(f"  estimated audio tokens to write  : {p['est_audio']:,}")
    if p["total_input"]:
        print(f"  => audio is ~{100 * p['est_audio'] / p['total_input']:.1f}% of their input")

    # Show the extra cost this makes visible, at current pricing.
    try:
        from utils.ai_pricing import get_pricing, resolve_rates
        pricing = get_pricing(None)
        rates = resolve_rates("gemini-2.5-flash", pricing)
        premium = p["est_audio"] * (rates.get("audio", rates["input"]) - rates["input"]) / 1_000_000
        print(f"  => newly-visible audio premium   : ${premium:.4f} "
              f"(audio ${rates.get('audio', rates['input'])}/1M vs input ${rates['input']}/1M)")
    except Exception as e:
        print(f"  (pricing preview unavailable: {e})")

    if not p["rows"]:
        print("\nNothing to backfill.")
        return

    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to commit.")
        return

    cur.execute(UPDATE_SQL, (AUDIO_TOKENS_PER_SEC,))
    conn.commit()
    print(f"\nBackfilled {cur.rowcount} row(s) with ESTIMATED audio_tokens.")
    conn.close()


if __name__ == "__main__":
    main()
