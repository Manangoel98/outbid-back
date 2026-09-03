import type { PoolClient } from "pg"
import { withTx } from "./db.js"
import { env } from "../env.js"
import { publish } from "./bus.js"
import { buildingFloorCents } from "./pricing.js"

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

/** This brand already used its single free claim — any further claim must be paid. */
export class FreeClaimUsedError extends Error {
  constructor() {
    super("This brand has already used its free claim")
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

export { normalizeHost }

/**
 * Has this brand already used its one free claim?
 *
 * Keyed on brand_key (normalized hostname), NOT company_id: upsertCompany() deliberately
 * mints a brand-new company_id for every single purchase (see SECURITY.md — a purchase must
 * never mutate an already-paid-for company row), so a per-company_id check would be
 * trivially bypassed by simply claiming again — every new row starts with
 * free_claim_used = false. The hostname is the only stable identity across purchases.
 *
 * This gate applies to the FREE path only. A brand may own unlimited spots; it just has to
 * pay for every one after its first free claim.
 *
 * Returns true when the domain can't be resolved to a hostname, so an unparseable URL fails
 * closed (denied a free claim) instead of granting unlimited ones.
 *
 * Pass the transaction client when calling inside a claim so the read participates in the
 * same transaction as the write that sets the flag.
 */
export async function hasBrandUsedFreeClaim(
  client: Pick<PoolClient, "query">,
  url: string,
): Promise<boolean> {
  const brandKey = normalizeHost(url)
  if (!brandKey) return true
  const { rows } = await client.query<{ used: boolean }>(
    `select exists (
       select 1 from companies where brand_key = $1 and free_claim_used
     ) as used`,
    [brandKey],
  )
  return rows[0]?.used ?? false
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
 * Marks a brand's one free claim as used, and hard-fails if it was already used.
 *
 * Relies on the partial unique index companies_one_free_claim_per_brand_idx (migration 003) as
 * the real enforcement, NOT on the read below. withTx() uses a bare BEGIN (READ COMMITTED), so
 * a concurrent transaction's uncommitted free_claim_used = true is invisible here — two
 * simultaneous free claims from one brand both passed this check in testing before the index
 * existed. The pre-read is kept only to produce a clean FreeClaimUsedError in the common
 * sequential case; the unique violation is what actually closes the race.
 */
async function consumeFreeClaim(client: PoolClient, companyId: string, url: string) {
  if (await hasBrandUsedFreeClaim(client, url)) {
    throw new FreeClaimUsedError()
  }
  try {
    await client.query(`update companies set free_claim_used = true where company_id = $1`, [companyId])
  } catch (err) {
    // 23505 = unique_violation: another transaction committed this brand's free claim first.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new FreeClaimUsedError()
    }
    throw err
  }
}

/**
 * Single-slot claim/raise, run *after* Stripe confirms payment for `amountCents`.
 * Optimistic-locked per BACKEND_PLAN.md §3.1: the UPDATE only succeeds if nobody else
 * moved the price since the price the buyer saw when they started checkout.
 *
 * If this is a free claim ($0), also sets free_claim_used=TRUE on the company.
 */
export async function claimSlot(opts: {
  slotId: string
  amountCents: number
  draft: CompanyDraft
  ownerUserId: string | null
  orderId: string
  stripePaymentIntentId?: string | null
  isFreeSlot?: boolean
}) {
  return withTx(async (client) => {
    const companyId = await upsertCompany(client, opts.draft, opts.ownerUserId)

    // If this is a free claim ($0), consume the brand's one-and-only free claim.
    if (opts.isFreeSlot && opts.amountCents === 0) {
      await consumeFreeClaim(client, companyId, opts.draft.url)
    }

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
       where slot_id = $4
         and (company_id is null or standing_bid_cents < $2)
         and ($2 >= $5 or company_id is null)
       returning slot_id, company_id, standing_bid_cents, version, claimed_at`,
      [companyId, opts.amountCents, opts.amountCents, opts.slotId, env.floorCents],
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
 *
 * If this is a free claim ($0), also sets free_claim_used=TRUE on the company.
 */
export async function claimBuilding(opts: {
  buildingId: number
  amountCents: number
  officeName: string
  draft: CompanyDraft
  ownerUserId: string | null
  orderId: string
  stripePaymentIntentId?: string | null
  isFreeBuilding?: boolean
}) {
  return withTx(async (client) => {
    const companyId = await upsertCompany(client, opts.draft, opts.ownerUserId)

    // If this is a free claim ($0), consume the brand's one-and-only free claim.
    if (opts.isFreeBuilding && opts.amountCents === 0) {
      await consumeFreeClaim(client, companyId, opts.draft.url)
    }

    // A free-claimed building sits at price_cents = 0, so the plain `price_cents < $3` guard
    // would happily let someone take a skyscraper for $1. Taking over ANY already-owned
    // building must clear its real size-based floor, so free-tier towers are never cheaper to
    // steal than paid ones. Computed here in TS from the same buildingFloorCents() the checkout
    // route uses, rather than duplicating the formula in SQL.
    const { rows: dims } = await client.query<{ w: number; d: number; h: number; office_owner_id: string | null }>(
      `select w, d, h, office_owner_id from buildings where building_id = $1`,
      [opts.buildingId],
    )
    if (!dims[0]) throw new ClaimConflictError(0)
    const requiredCents =
      dims[0].office_owner_id === null ? 0 : buildingFloorCents(dims[0].w, dims[0].d, dims[0].h)

    const { rows } = await client.query<{ building_id: number; office_owner_id: string | null; price_cents: number | null }>(
      `update buildings
       set office_owner_id = $1,
           office_name = $2,
           purchased_at = now(),
           price_cents = $3
       where building_id = $4
         and (office_owner_id is null or price_cents is null or price_cents < $3)
         and $3 >= $5
       returning building_id, office_owner_id, price_cents`,
      [companyId, opts.officeName, opts.amountCents, opts.buildingId, requiredCents],
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
 *
 * If this is a free claim ($0), also sets free_claim_used=TRUE on the company.
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
  isFreePlot?: boolean
}) {
  return withTx(async (client) => {
    const companyId = await upsertCompany(client, opts.draft, opts.ownerUserId)

    // If this is a free claim ($0), consume the brand's one-and-only free claim.
    if (opts.isFreePlot && opts.amountCents === 0) {
      await consumeFreeClaim(client, companyId, opts.draft.url)
    }

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
       where plot_id = $8
         and (company_id is null or standing_bid_cents < $7)
         and ($7 >= $9 or company_id is null)
       returning plot_id, company_id, standing_bid_cents`,
      [companyId, opts.startupName, opts.story, opts.domain, opts.born, opts.died, opts.amountCents, opts.plotId, env.floorCents],
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
