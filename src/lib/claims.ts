import type { PoolClient } from "pg"
import { withTx } from "./db.js"
import { env } from "../env.js"
import { publish } from "./bus.js"

export type CompanyDraft = {
  name: string
  url: string
  tagline: string
  logoUrl?: string | null
  primary: string
  ink: string
}

export class ClaimConflictError extends Error {
  currentBidCents: number
  constructor(currentBidCents: number) {
    super(`Slot price moved to ${currentBidCents} cents, retry with a higher bid`)
    this.currentBidCents = currentBidCents
  }
}

function companySnapshot(draft: CompanyDraft) {
  return { name: draft.name, url: draft.url, tagline: draft.tagline, logoUrl: draft.logoUrl ?? null, primary: draft.primary, ink: draft.ink }
}

function normalizeHost(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`)
    return url.hostname.toLowerCase().replace(/^www\./, "") || null
  } catch {
    return null
  }
}

async function upsertCompany(client: PoolClient, draft: CompanyDraft, ownerUserId: string | null) {
  // brand_key is purely a read-only display-aggregation label (see SECURITY.md /
  // schema.sql comment on companies.brand_key) — this INSERT never conflicts on it and
  // never overwrites an existing company row. Every purchase always creates its own new,
  // immutable company_id, exactly as before.
  const brandKey = normalizeHost(draft.url)
  const { rows } = await client.query<{ company_id: string }>(
    `insert into companies (owner_user_id, name, url, brand_key, tagline, logo_url, primary_color, ink_color)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning company_id`,
    [ownerUserId, draft.name, draft.url, brandKey, draft.tagline, draft.logoUrl ?? null, draft.primary, draft.ink],
  )
  return rows[0]!.company_id
}

/**
 * Take-price rule from BACKEND_PLAN.md §2: to take or raise, new bid must be at least
 * `standing + takeDeltaCents`. Mirrors `takePrice()` in src/stores/gameStore.ts.
 */
export function computeTakePriceCents(standingBidCents: number, isOwner: boolean) {
  if (standingBidCents <= 0) return env.floorCents
  return isOwner ? standingBidCents + env.takeDeltaCents : standingBidCents + env.takeDeltaCents
}

/**
 * Single-slot claim/raise, run *after* Stripe confirms payment for `amountCents`.
 * Optimistic-locked per BACKEND_PLAN.md §3.1: the UPDATE only succeeds if nobody else
 * moved the price since the price the buyer saw when they started checkout.
 */
export async function claimSlot(opts: {
  slotId: string
  amountCents: number
  draft: CompanyDraft
  ownerUserId: string | null
  orderId: string
  stripePaymentIntentId?: string | null
}) {
  return withTx(async (client) => {
    const companyId = await upsertCompany(client, opts.draft, opts.ownerUserId)

    const { rows } = await client.query<{
      slot_id: string
      company_id: string | null
      standing_bid_cents: number
      version: string
      claimed_at: string | null
    }>(
      `update holdings
       set company_id = $1,
           standing_bid_cents = $2,
           paid_total_cents = paid_total_cents + $3,
           claimed_at = coalesce(claimed_at, now()),
           last_raise_at = now(),
           version = version + 1
       where slot_id = $4 and standing_bid_cents < $2
       returning slot_id, company_id, standing_bid_cents, version, claimed_at`,
      [companyId, opts.amountCents, opts.amountCents, opts.slotId],
    )

    if (rows.length === 0) {
      const { rows: cur } = await client.query<{ standing_bid_cents: number }>(
        `select standing_bid_cents from holdings where slot_id = $1`,
        [opts.slotId],
      )
      throw new ClaimConflictError(cur[0]?.standing_bid_cents ?? env.floorCents)
    }

    await client.query(
      `update orders set status = 'succeeded', stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id)
       where order_id = $1 and status in ('pending', 'processing')`,
      [opts.orderId, opts.stripePaymentIntentId ?? null],
    )

    const row = rows[0]!
    publish({
      type: "holding",
      slotId: row.slot_id,
      companyId: row.company_id,
      standingBidCents: row.standing_bid_cents,
      claimedAt: row.claimed_at,
      company: companySnapshot(opts.draft),
    })
    return row
  })
}

/**
 * Whole-building purchase per BACKEND_PLAN.md §2 building rule: price is based on real
 * building footprint area and floor count (`floorCents * (w*d*floors/AREA_UNIT) * multiplier`,
 * computed by the caller (routes/checkout.ts) from the buildings table itself — not from a
 * client-supplied number — before creating the Stripe session, then re-validated here
 * against the current owner.
 */
export async function claimBuilding(opts: {
  buildingId: number
  amountCents: number
  officeName: string
  draft: CompanyDraft
  ownerUserId: string | null
  orderId: string
  stripePaymentIntentId?: string | null
}) {
  return withTx(async (client) => {
    const companyId = await upsertCompany(client, opts.draft, opts.ownerUserId)

    const { rows } = await client.query<{ building_id: number; office_owner_id: string | null; price_cents: number | null }>(
      `update buildings
       set office_owner_id = $1,
           office_name = $2,
           purchased_at = now(),
           price_cents = $3
       where building_id = $4 and (price_cents is null or price_cents < $3)
       returning building_id, office_owner_id, price_cents`,
      [companyId, opts.officeName, opts.amountCents, opts.buildingId],
    )

    if (rows.length === 0) {
      const { rows: cur } = await client.query<{ price_cents: number | null }>(
        `select price_cents from buildings where building_id = $1`,
        [opts.buildingId],
      )
      throw new ClaimConflictError(cur[0]?.price_cents ?? 0)
    }

    await client.query(
      `update orders set status = 'succeeded', stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id)
       where order_id = $1 and status in ('pending', 'processing')`,
      [opts.orderId, opts.stripePaymentIntentId ?? null],
    )

    const row = rows[0]!
    publish({
      type: "building",
      buildingId: row.building_id,
      officeOwnerId: row.office_owner_id,
      officeName: opts.officeName,
      priceCents: row.price_cents,
      company: companySnapshot(opts.draft),
    })
    return row
  })
}

/**
 * Bury/outbid a graveyard plot, run *after* Stripe confirms payment. Same optimistic-lock
 * shape as claimBuilding: the UPDATE only wins if the new bid strictly exceeds the current
 * standing bid, so a concurrent higher outbid can't be clobbered. Writes the buyer-supplied
 * startup name/story/domain/years onto the plot (already moderated in routes/checkout.ts).
 */
export async function claimGraveyard(opts: {
  plotId: string
  amountCents: number
  startupName: string
  story: string
  domain: string | null
  born: number | null
  died: number | null
  draft: CompanyDraft
  ownerUserId: string | null
  orderId: string
  stripePaymentIntentId?: string | null
}) {
  return withTx(async (client) => {
    const companyId = await upsertCompany(client, opts.draft, opts.ownerUserId)

    const { rows } = await client.query<{
      plot_id: string
      company_id: string | null
      standing_bid_cents: number
    }>(
      `update graveyard_plots
       set company_id = $1,
           name = $2,
           story = $3,
           domain = $4,
           born = $5,
           died = $6,
           standing_bid_cents = $7,
           paid_total_cents = paid_total_cents + $7,
           claimed_at = coalesce(claimed_at, now()),
           last_raise_at = now(),
           version = version + 1
       where plot_id = $8 and standing_bid_cents < $7
       returning plot_id, company_id, standing_bid_cents`,
      [companyId, opts.startupName, opts.story, opts.domain, opts.born, opts.died, opts.amountCents, opts.plotId],
    )

    if (rows.length === 0) {
      const { rows: cur } = await client.query<{ standing_bid_cents: number }>(
        `select standing_bid_cents from graveyard_plots where plot_id = $1`,
        [opts.plotId],
      )
      throw new ClaimConflictError(cur[0]?.standing_bid_cents ?? 0)
    }

    await client.query(
      `update orders set status = 'succeeded', stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id)
       where order_id = $1 and status in ('pending', 'processing')`,
      [opts.orderId, opts.stripePaymentIntentId ?? null],
    )

    const row = rows[0]!
    publish({
      type: "graveyard",
      plotId: row.plot_id,
      companyId: row.company_id,
      name: opts.startupName,
      story: opts.story,
      domain: opts.domain,
      born: opts.born,
      died: opts.died,
      standingBidCents: row.standing_bid_cents,
      company: companySnapshot(opts.draft),
    })
    return row
  })
}
