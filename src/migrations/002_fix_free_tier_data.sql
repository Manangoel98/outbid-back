-- Migration 002: correct the free-tier data model.
--
-- Fixes two mistakes introduced by 001 + the seed script:
--   1. holdings.is_free was redundant/wrong. A holding is the *occupancy* of a slot; the
--      free-tier flag belongs to the immutable layout row (slots.is_free). Having it on both
--      created two sources of truth and holdings.is_free was never populated (always FALSE),
--      so every free-tier lookup silently returned "paid".
--   2. The seed used `random() < 0.5` per run, so repeated runs compounded and drifted the
--      split (74% slots / 67% buildings / 92% plots instead of 50%).
--
-- The assignment below is deterministic (ordered by md5 of the id) and idempotent: running
-- it any number of times always produces the exact same 50% set, so it is safe on prod.

-- 1. Drop the redundant column + its index.
DROP INDEX IF EXISTS holdings_is_free_idx;
ALTER TABLE holdings DROP COLUMN IF EXISTS is_free;

-- 2. Exactly 50% of slots free, deterministic.
WITH ranked AS (
  SELECT slot_id,
         row_number() OVER (ORDER BY md5(slot_id)) AS rn,
         count(*) OVER () AS total
  FROM slots
)
UPDATE slots s
SET is_free = (r.rn <= r.total / 2)
FROM ranked r
WHERE s.slot_id = r.slot_id
  AND s.is_free <> (r.rn <= r.total / 2);

-- 3. Exactly 50% of buildings free, deterministic.
WITH ranked AS (
  SELECT building_id,
         row_number() OVER (ORDER BY md5(building_id::text)) AS rn,
         count(*) OVER () AS total
  FROM buildings
)
UPDATE buildings b
SET is_free = (r.rn <= r.total / 2)
FROM ranked r
WHERE b.building_id = r.building_id
  AND b.is_free <> (r.rn <= r.total / 2);

-- 4. Exactly 50% of graveyard plots free, deterministic.
WITH ranked AS (
  SELECT plot_id,
         row_number() OVER (ORDER BY md5(plot_id)) AS rn,
         count(*) OVER () AS total
  FROM graveyard_plots
)
UPDATE graveyard_plots g
SET is_free = (r.rn <= r.total / 2)
FROM ranked r
WHERE g.plot_id = r.plot_id
  AND g.is_free <> (r.rn <= r.total / 2);
