-- ============================================================================
-- Remediation: cross-account leaked default schedules
--
-- Bug (fixed in summaries/db.py add_topic): when two accounts owned a bot with
-- the SAME name, an unscoped "SELECT owner_id FROM bots WHERE name = %s" could
-- resolve to the wrong account, so a newly created topic was seeded with the
-- WRONG account's default schedules.
--
-- A schedule row is "leaked" when, for its topic's bot owner O, the row matches
-- a default_schedules_global entry owned by a DIFFERENT account, and does NOT
-- match any default owned by O. Matching uses the fields add_topic copies
-- VERBATIM (prompt_key is namespaced per bot for user bots, so it is excluded
-- from the fingerprint). name/header are excluded because {topic_name} is
-- substituted on copy.
--
-- USAGE:
--   Dry run (default, no writes):
--     psql "$DSN" -f scripts/fix_leaked_default_schedules.sql
--   Apply the deletion:
--     psql "$DSN" -v apply=1 -f scripts/fix_leaked_default_schedules.sql
--
-- Wrapped in a transaction; the dry run ROLLBACKs, apply COMMITs.
-- ============================================================================

\set ON_ERROR_STOP on
\if :{?apply} \else \set apply 0 \endif

BEGIN;

-- Candidate leaked rows, scoped to bots whose name is shared across >1 owner
-- (the only situation the bug could trigger in).
CREATE TEMP TABLE _leaked ON COMMIT DROP AS
WITH shared_names AS (
    -- count(*) (not count(DISTINCT owner_id)) so an admin(NULL)+user collision,
    -- which is the exact case the bug hits, is not dropped by NULL handling.
    SELECT name FROM bots GROUP BY name HAVING count(*) > 1
),
sched AS (
    SELECT s.*, b.owner_id AS bot_owner, b.name AS bot_name, t.name AS topic_name
    FROM schedules s
    JOIN topics t     ON t.id = s.topic_id
    JOIN categories c ON c.id = t.category_id
    JOIN bots b       ON b.id = c.bot_id
    WHERE b.name IN (SELECT name FROM shared_names)
)
SELECT sched.id, sched.bot_name, sched.bot_owner, sched.topic_name,
       sched.name AS sched_name, sched.prompt_key, sched.telegram_targets,
       fd.owner_id AS foreign_default_owner
FROM sched
-- matches a default owned by a DIFFERENT account
JOIN default_schedules_global fd
       ON fd.owner_id IS DISTINCT FROM sched.bot_owner
      AND fd.type = sched.type
      AND fd.telegram_targets::text = sched.telegram_targets::text
      AND COALESCE(fd.minute,  -1) = COALESCE(sched.minute,  -1)
      AND COALESCE(fd.hour,    -1) = COALESCE(sched.hour,    -1)
      AND COALESCE(fd.hours,   -1) = COALESCE(sched.hours,   -1)
      AND COALESCE(fd.minutes, -1) = COALESCE(sched.minutes, -1)
      AND COALESCE(fd.start_hour,   -1) = COALESCE(sched.start_hour,   -1)
      AND COALESCE(fd.start_minute, -1) = COALESCE(sched.start_minute, -1)
-- but does NOT match any default owned by the CORRECT account
WHERE NOT EXISTS (
    SELECT 1 FROM default_schedules_global cd
    WHERE cd.owner_id IS NOT DISTINCT FROM sched.bot_owner
      AND cd.type = sched.type
      AND cd.telegram_targets::text = sched.telegram_targets::text
      AND COALESCE(cd.minute,  -1) = COALESCE(sched.minute,  -1)
      AND COALESCE(cd.hour,    -1) = COALESCE(sched.hour,    -1)
      AND COALESCE(cd.hours,   -1) = COALESCE(sched.hours,   -1)
      AND COALESCE(cd.minutes, -1) = COALESCE(sched.minutes, -1)
);

\echo '=== Leaked schedule rows (review before applying) ==='
SELECT id, bot_name, bot_owner, topic_name, sched_name, prompt_key,
       telegram_targets, foreign_default_owner
FROM _leaked
ORDER BY bot_name, topic_name, id;

SELECT count(*) AS leaked_rows FROM _leaked;

DELETE FROM schedules WHERE id IN (SELECT id FROM _leaked) AND :apply = 1;

\if :apply
    \echo '=== APPLIED: leaked rows deleted, committing ==='
    COMMIT;
\else
    \echo '=== DRY RUN: no changes. Re-run with -v apply=1 to delete. ==='
    ROLLBACK;
\endif
