-- Migration 004: drop free_claim_log.
--
-- An earlier revision of 003 created this table to cap free claims per IP. That was scope
-- creep: the rule is simply "one free spot per domain", which the partial unique index in 003
-- already enforces atomically. No IP tracking, no extra endpoint gating.
--
-- Written as a separate migration (rather than editing 003) so a database that already applied
-- the earlier 003 gets the table removed instead of keeping a stray, unused table forever.
drop table if exists free_claim_log;
