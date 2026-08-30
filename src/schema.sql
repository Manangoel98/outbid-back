-- Outbid City — schema v1
-- Run via `npm run migrate` (backend/scripts/migrate.ts), or paste into any Postgres client.
-- Mirrors backend/../BACKEND_PLAN.md sections 1.1–1.6.

create extension if not exists pgcrypto;

-- 1.1 slots: immutable layout, re-derived from generateCity() by scripts/seed.ts
create table if not exists slots (
  slot_id     text primary key,
  kind        text not null,
  tier        smallint not null default 5,
  floor_cents integer not null default 100,
  district    text not null,
  name        text not null,
  w           real not null default 1,
  h           real not null default 1,
  meta        jsonb not null default '{}'::jsonb,
  city_version integer not null default 1,
  created_at  timestamptz not null default now()
);

-- 1.2 buildings: whole-building office purchase
create table if not exists buildings (
  building_id     integer primary key,
  x               real not null,
  z               real not null,
  w               real not null,
  d               real not null,
  district        text not null,
  floors          integer not null default 1,
  office_owner_id uuid null,
  office_name     text null,
  purchased_at    timestamptz null,
  price_cents     integer null,
  city_version    integer not null default 1
);

-- Real building height in meters — needed (alongside w/d) so whole-building price can
-- scale with actual footprint + height instead of a flat number. See lib/pricing.ts.
alter table buildings add column if not exists h real not null default 30;

-- Permanent id for a building's ownership history, independent of building_id in case a
-- future city_version bump ever renumbers buildings (same pattern as holdings.holding_uid).
-- `add column if not exists` so this is safe to re-run against the original v1 table too.
alter table buildings add column if not exists building_uid uuid not null default gen_random_uuid();
create unique index if not exists buildings_building_uid_idx on buildings (building_uid);

-- 1.3 companies: a brand a user controls
create table if not exists companies (
  company_id         uuid primary key default gen_random_uuid(),
  owner_user_id      uuid null,
  name               text not null,
  url                text not null,
  tagline            text not null default '',
  logo_url           text null,
  primary_color      text not null default '#C43B2A',
  ink_color          text not null default '#F5F0E8',
  stripe_customer_id text null,
  created_at         timestamptz not null default now()
);

-- Normalized hostname (e.g. "acme.com"), read-only display aggregation key so the
-- leaderboard/map can group "all of Acme's holdings" without any write path that lets
-- one purchase mutate another already-paid-for company row. See backend/SECURITY.md.
-- Every purchase still creates its own immutable company row — this is never used to
-- upsert/overwrite an existing one.
alter table companies add column if not exists brand_key text null;
create index if not exists companies_brand_key_idx on companies (brand_key);

do $$
begin
  alter table buildings
    add constraint buildings_office_owner_fk
    foreign key (office_owner_id) references companies(company_id) on delete set null;
exception
  when duplicate_object then null;
end $$;

-- 1.4 holdings: current occupancy, one row per slot (hot table)
create table if not exists holdings (
  slot_id             text primary key references slots(slot_id) on delete cascade,
  holding_uid         uuid not null default gen_random_uuid(),
  company_id          uuid null references companies(company_id) on delete set null,
  -- 0 means "never claimed" — computeTakePriceCents() in lib/claims.ts treats <=0 as
  -- "use the $1 floor price". Do not default this to floor_cents (100): that would silently
  -- double the real first-buy price to $2, since claimSlot's take-price formula is always
  -- `standing + $1` once a row has a positive standing bid.
  standing_bid_cents  integer not null default 0,
  paid_total_cents    bigint not null default 0,
  claimed_at          timestamptz null,
  last_raise_at       timestamptz null,
  clicks              integer not null default 0,
  impressions         integer not null default 0,
  version             bigint not null default 0
);

create unique index if not exists holdings_holding_uid_idx on holdings (holding_uid);

-- 1.5 orders: append-only payment ledger, Stripe writes here
create table if not exists orders (
  order_id                  uuid primary key default gen_random_uuid(),
  company_id                uuid null references companies(company_id) on delete set null,
  stripe_payment_intent_id  text unique,
  stripe_checkout_session_id text unique,
  kind                      text not null check (kind in ('single', 'fleet_bulk', 'building')),
  slot_ids                  text[] not null default '{}',
  building_id               integer null references buildings(building_id) on delete set null,
  quantity                  integer not null default 1,
  price_per_unit_cents      integer not null,
  total_cents               integer not null,
  status                    text not null default 'pending' check (status in ('pending', 'processing', 'succeeded', 'failed', 'refunded')),
  created_at                timestamptz not null default now()
);

-- 1.6 users / sessions: anonymous by default, Stripe email attaches identity later
create table if not exists users (
  user_id             uuid primary key default gen_random_uuid(),
  visitor_id          text unique not null,
  stripe_customer_id  text null,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);

create index if not exists holdings_company_idx on holdings (company_id);
create index if not exists orders_company_idx on orders (company_id);
create index if not exists orders_status_idx on orders (status);
create index if not exists slots_kind_idx on slots (kind);

-- Transient 'processing' status for atomic webhook/reconcile claim (see webhook.ts).
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('pending', 'processing', 'succeeded', 'failed', 'refunded'));

-- ---------------------------------------------------------------------------
-- Row Level Security (Supabase linter: rls_disabled_in_public)
--
-- The frontend NEVER talks to Postgres/PostgREST directly — only this Fastify API
-- via DATABASE_URL (postgres role, bypasses RLS). Enabling RLS with NO permissive
-- policies blocks anon/authenticated Supabase API keys from reading or writing app
-- tables. See backend/SECURITY.md § "Database exposure".
-- ---------------------------------------------------------------------------
alter table public.slots enable row level security;
alter table public.holdings enable row level security;
alter table public.companies enable row level security;
alter table public.buildings enable row level security;
alter table public.users enable row level security;
alter table public.orders enable row level security;

-- Belt-and-suspenders: strip default API grants (RLS alone is sufficient when no policies exist).
revoke all on table public.slots from anon, authenticated;
revoke all on table public.holdings from anon, authenticated;
revoke all on table public.companies from anon, authenticated;
revoke all on table public.buildings from anon, authenticated;
revoke all on table public.users from anon, authenticated;
revoke all on table public.orders from anon, authenticated;
