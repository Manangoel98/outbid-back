-- Migration 003: make "one free claim per brand" atomic.
--
-- WHY 003 EXISTS
-- The application-level check in claims.ts (`select exists(... free_claim_used)` inside the
-- claim transaction) does NOT stop concurrent claims. withTx() uses a bare BEGIN, i.e.
-- READ COMMITTED, so transaction B cannot see transaction A's uncommitted
-- free_claim_used = true. Two simultaneous free claims from the same domain both committed in
-- testing. Only a DB constraint can enforce this atomically.
--
-- One row per brand_key may have free_claim_used = true. A partial unique index lets the same
-- brand keep many companies (every purchase mints a new company row — by design), but at most
-- ONE of them can ever hold the free claim. The second concurrent commit now fails with a
-- unique violation instead of silently succeeding.
--
-- Rows with brand_key IS NULL are excluded: NULL is never equal to itself in a unique index, so
-- they'd never conflict anyway, and hasBrandUsedFreeClaim() already fails closed on them.
create unique index if not exists companies_one_free_claim_per_brand_idx
  on companies (brand_key)
  where free_claim_used and brand_key is not null;
