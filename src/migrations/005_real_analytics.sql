-- 005: real analytics — event-sourced passes and visits.
--
-- WHY THIS TABLE EXISTS
--
-- Before this, holdings.clicks/impressions were bare counters incremented on every accepted
-- request, and dedup lived in two in-memory Maps in the Node process. That had three fatal
-- flaws for numbers we publish as a pricing signal:
--
--   1. The dedup map is per-process. Cloud Run scales to zero and runs multiple instances, so
--      the map was wiped on every cold start and each instance deduped independently — the
--      same visitor could be counted once per instance, per restart. Over-counting.
--   2. Counters are not recomputable. Once a count is wrong there is no evidence left to
--      rebuild it from, and no way to ever answer "how many passes in the last 7 days".
--   3. The dedup key was a client-supplied visitorId, so rotating it inflated counts freely.
--
-- Storing one row per counted event fixes all three: dedup becomes a database uniqueness
-- constraint (durable, correct across instances), and counts become derivable from evidence.
-- The counter columns on holdings/buildings are kept as a denormalised fast-read cache so the
-- 3D city and leaderboard never have to aggregate on render.

create table if not exists ad_events (
  event_id      bigserial primary key,
  -- Exactly one of these is set — enforced by the check constraint below. Two nullable columns
  -- plus a check beats a polymorphic (kind, text_id) pair because it keeps real foreign keys,
  -- so deleting a slot or building cleans up its events automatically.
  slot_id       text null references slots(slot_id) on delete cascade,
  building_id   integer null references buildings(building_id) on delete cascade,
  event_kind    text not null check (event_kind in ('pass', 'visit')),
  -- sha256(daily_salt + client_ip + user_agent). Never the client-supplied id — see
  -- lib/visitor.ts for why that distinction is the whole point of this design.
  visitor_hash  text not null,
  -- Start of the dedup window this event falls in. Making the bucket part of the unique key is
  -- what lets the database enforce "once per visitor per placement per window" without any
  -- application-side state to keep in sync or lose on restart.
  bucket_start  timestamptz not null,
  -- Diagnostics only. Deliberately NOT part of any unique index: it is attacker-controlled.
  client_id     text null,
  created_at    timestamptz not null default now(),
  constraint ad_events_one_placement check ((slot_id is not null) <> (building_id is not null))
);

-- Dedup keys. Two partial indexes rather than one composite, because a single index over both
-- nullable columns would not enforce uniqueness: in Postgres NULLs are distinct, so every
-- building row (slot_id null) would be considered unique regardless of the rest of the key.
create unique index if not exists ad_events_slot_dedup_idx
  on ad_events (slot_id, event_kind, visitor_hash, bucket_start)
  where slot_id is not null;

create unique index if not exists ad_events_building_dedup_idx
  on ad_events (building_id, event_kind, visitor_hash, bucket_start)
  where building_id is not null;

-- Windowed reads ("passes in the last 7 days") scan by placement + time.
create index if not exists ad_events_slot_window_idx
  on ad_events (slot_id, event_kind, created_at desc)
  where slot_id is not null;

create index if not exists ad_events_building_window_idx
  on ad_events (building_id, event_kind, created_at desc)
  where building_id is not null;

-- Retention pruning scans purely by age.
create index if not exists ad_events_created_at_idx on ad_events (created_at);

-- Buildings were never tracked at all: the click handler only fired when a slotId was present,
-- so every tower reported 0 visits forever even though towers are the most expensive
-- placements. Mirror the counter columns holdings already has.
alter table buildings add column if not exists clicks integer not null default 0;
alter table buildings add column if not exists impressions integer not null default 0;
