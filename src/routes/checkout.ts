import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { pool } from "../lib/db.js"
import { env } from "../env.js"
import { stripe } from "../lib/stripe.js"
import {
  ClaimConflictError,
  FreeClaimUsedError,
  claimBuilding,
  claimGraveyard,
  claimSlot,
  computeTakePriceCents,
  hasBrandUsedFreeClaim,
} from "../lib/claims.js"
import { buildingFloorCents } from "../lib/pricing.js"
import { moderateCompanyDraft, moderateFreeText } from "../lib/moderation.js"

const companyDraft = z.object({
  name: z.string().min(1).max(32),
  url: z.string().min(1),
  tagline: z.string().max(90).default(""),
  logoUrl: z.string().url().nullish(),
  primary: z.string().default("#C43B2A"),
  ink: z.string().default("#F5F0E8"),
})

const slotCheckoutBody = z.object({
  slotId: z.string(),
  amountCents: z.number().int().min(env.floorCents).max(env.maxBidCents),
  companyDraft,
})

const buildingCheckoutBody = z.object({
  buildingId: z.number().int(),
  officeName: z.string().min(1).max(40),
  companyDraft,
})

const graveyardCheckoutBody = z.object({
  plotId: z.string().min(1).max(64),
  amountCents: z.number().int().min(env.floorCents).max(env.maxBidCents),
  startupName: z.string().min(1).max(60),
  story: z.string().max(600).default(""),
  domain: z.string().max(120).nullish(),
  born: z.number().int().min(1900).max(2100).nullish(),
  died: z.number().int().min(1900).max(2100).nullish(),
  companyDraft,
})

// Free-tier claim. No amountCents: the price is always exactly $0, decided by the server from
// the DB, so there is nothing for the client to supply or tamper with.
const freeClaimBody = z.discriminatedUnion("target", [
  z.object({ target: z.literal("slot"), slotId: z.string().min(1).max(64), companyDraft }),
  z.object({
    target: z.literal("building"),
    buildingId: z.number().int(),
    officeName: z.string().min(1).max(40),
    companyDraft,
  }),
  z.object({
    target: z.literal("plot"),
    plotId: z.string().min(1).max(64),
    startupName: z.string().min(1).max(60),
    story: z.string().max(600).default(""),
    domain: z.string().max(120).nullish(),
    born: z.number().int().min(1900).max(2100).nullish(),
    died: z.number().int().min(1900).max(2100).nullish(),
    companyDraft,
  }),
])

export async function checkoutRoutes(app: FastifyInstance) {
  // Tighter than the global default (see server.ts) — checkout creates real Stripe
  // sessions, so it's the most expensive/abusable route in the API.
  const checkoutRateLimit = { max: 8, timeWindow: "60 seconds" }

  // Single-slot claim/raise — mirrors takePrice() in src/stores/gameStore.ts.
  // SECURITY: Fetch is_free and free_claim_used from DB, never trust client.
  app.post("/api/v1/checkout/slot", { config: { rateLimit: checkoutRateLimit } }, async (req, reply) => {
    const body = slotCheckoutBody.parse(req.body)
    const mod = moderateCompanyDraft(body.companyDraft)
    if (!mod.ok) return reply.code(400).send({ error: mod.reason })
    
    // SECURITY: Fetch slot data from DB (is_free lives on the slot layout row, standing bid on the holding)
    const { rows: slotRows } = await pool.query<{ is_free: boolean; standing_bid_cents: number; company_id: string | null }>(
      `select s.is_free, h.standing_bid_cents, h.company_id from holdings h
       join slots s on h.slot_id = s.slot_id
       where h.slot_id = $1`,
      [body.slotId],
    )
    if (!slotRows[0]) return reply.code(404).send({ error: "unknown_slot" })

    const isUnclaimed = slotRows[0].company_id === null

    // SECURITY: Minimum price computed server-side, never trusted from the client.
    // Note there is no $0 branch here: free claims go through POST /api/v1/claim/free (Stripe
    // rejects a $0 charge). This route is the paid path only, so a free-tier spot is simply
    // charged the normal floor if someone routes a payment at it — a brand can own unlimited
    // spots, it just can't get a second one free.
    const minPrice = isUnclaimed
      ? env.floorCents
      : computeTakePriceCents(slotRows[0].standing_bid_cents, false)
    
    // SECURITY: Reject if client bid is below minimum
    if (body.amountCents < minPrice) {
      return reply.code(409).send({ error: "bid_too_low", minNeeded: minPrice })
    }

    const { rows: orderRows } = await pool.query(
      `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
       values ('single', array[$1], 1, $2, $2, 'pending') returning order_id`,
      [body.slotId, body.amountCents],
    )
    const orderId = orderRows[0]!.order_id as string

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: { currency: "usd", product_data: { name: `Claim ${body.slotId}` }, unit_amount: body.amountCents },
          quantity: 1,
        },
      ],
      metadata: { 
        orderId, 
        kind: "single", 
        slotId: body.slotId, 
        companyDraft: JSON.stringify(body.companyDraft), 
        amountCents: String(body.amountCents),
      },
      success_url: env.stripeSuccessUrl,
      cancel_url: env.stripeCancelUrl,
    })

    await pool.query(`update orders set stripe_checkout_session_id = $1 where order_id = $2`, [session.id, orderId])
    return { url: session.url }
  })

  // Whole-building office purchase — price scales with real footprint area + height
  // (buildingFloorCents in lib/pricing.ts), computed here from the buildings table itself,
  // never trusted from the client.
  // SECURITY: Fetch is_free from DB, never trust client.
  app.post("/api/v1/checkout/building", { config: { rateLimit: checkoutRateLimit } }, async (req, reply) => {
    const body = buildingCheckoutBody.parse(req.body)
    const mod = moderateCompanyDraft(body.companyDraft)
    if (!mod.ok) return reply.code(400).send({ error: mod.reason })
    const nameMod = moderateFreeText(body.officeName)
    if (!nameMod.ok) return reply.code(400).send({ error: nameMod.reason })
    
    // SECURITY: Fetch building data from DB (dimensions + current owner)
    const { rows } = await pool.query<{ w: number; d: number; h: number; price_cents: number | null; office_owner_id: string | null }>(
      `select w, d, h, price_cents, office_owner_id from buildings where building_id = $1`,
      [body.buildingId],
    )
    if (!rows[0]) return reply.code(404).send({ error: "unknown_building" })

    const isUnclaimed = rows[0].office_owner_id === null
    const floor = buildingFloorCents(rows[0].w, rows[0].d, rows[0].h)
    const standing = rows[0].price_cents ?? 0

    // SECURITY: Price computed server-side. Paid path only — free claims use
    // POST /api/v1/claim/free.
    //
    // A free-claimed building has price_cents = 0. Taking it over must cost the building's REAL
    // floor price, NOT 0 + $1 — otherwise claiming a skyscraper free would make it a $1
    // takeover target, i.e. cheaper to steal than a paid one. Buildings are size-priced, so the
    // floor is the meaningful number to defend. (Banners deliberately differ: a free-claimed
    // banner can be taken for the $1 floor, which is its real price anyway.)
    // Mirrors buildingTakePrice() in frontend/src/stores/gameStore.ts.
    const minPrice = isUnclaimed || standing <= 0 ? floor : standing + env.takeDeltaCents
    
    // The client never sends a price for buildings — the server is the sole authority, so the
    // charge is simply the computed minimum. (Slots differ: there the client may bid above the
    // floor, which is why that route validates body.amountCents instead.)
    const amountCents = minPrice

    const { rows: orderRows } = await pool.query(
      `insert into orders (kind, building_id, quantity, price_per_unit_cents, total_cents, status)
       values ('building', $1, 1, $2, $2, 'pending') returning order_id`,
      [body.buildingId, amountCents],
    )
    const orderId = orderRows[0]!.order_id as string

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: { currency: "usd", product_data: { name: `Buy building #${body.buildingId} — ${body.officeName}` }, unit_amount: amountCents },
          quantity: 1,
        },
      ],
      metadata: {
        orderId,
        kind: "building",
        buildingId: String(body.buildingId),
        officeName: body.officeName,
        companyDraft: JSON.stringify(body.companyDraft),
        amountCents: String(amountCents),
      },
      success_url: env.stripeSuccessUrl,
      cancel_url: env.stripeCancelUrl,
    })

    await pool.query(`update orders set stripe_checkout_session_id = $1 where order_id = $2`, [session.id, orderId])
    return { url: session.url }
  })

  // Bury/outbid a graveyard plot. Minimum is the current standing bid + takeDelta (or the
  // $1 floor for an empty plot), recomputed from graveyard_plots here — never trusted from
  // the client. name/story are moderated like any other buyer-visible free text.
  // SECURITY: Fetch is_free from DB, never trust client.
  app.post("/api/v1/checkout/graveyard", { config: { rateLimit: checkoutRateLimit } }, async (req, reply) => {
    const body = graveyardCheckoutBody.parse(req.body)
    const mod = moderateCompanyDraft(body.companyDraft)
    if (!mod.ok) return reply.code(400).send({ error: mod.reason })
    const nameMod = moderateFreeText(body.startupName)
    if (!nameMod.ok) return reply.code(400).send({ error: nameMod.reason })
    if (body.story) {
      const storyMod = moderateFreeText(body.story)
      if (!storyMod.ok) return reply.code(400).send({ error: storyMod.reason })
    }
    
    // SECURITY: Fetch plot data from DB (standing bid + owner)
    const { rows } = await pool.query<{ standing_bid_cents: number; company_id: string | null }>(
      `select standing_bid_cents, company_id from graveyard_plots where plot_id = $1`,
      [body.plotId],
    )
    if (!rows[0]) return reply.code(404).send({ error: "unknown_plot" })

    // SECURITY: Price computed server-side. Paid path only — free burials use
    // POST /api/v1/claim/free.
    const minPrice = rows[0].company_id === null
      ? env.floorCents
      : computeTakePriceCents(rows[0].standing_bid_cents, false)
    
    // SECURITY: Reject if client bid is below minimum
    if (body.amountCents < minPrice) {
      return reply.code(409).send({ error: "bid_too_low", minNeeded: minPrice })
    }

    const { rows: orderRows } = await pool.query(
      `insert into orders (kind, graveyard_plot_id, quantity, price_per_unit_cents, total_cents, status)
       values ('graveyard', $1, 1, $2, $2, 'pending') returning order_id`,
      [body.plotId, body.amountCents],
    )
    const orderId = orderRows[0]!.order_id as string

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: { currency: "usd", product_data: { name: `Bury ${body.startupName} in Outbid City graveyard` }, unit_amount: body.amountCents },
          quantity: 1,
        },
      ],
      metadata: {
        orderId,
        kind: "graveyard",
        plotId: body.plotId,
        startupName: body.startupName,
        story: body.story ?? "",
        domain: body.domain ?? "",
        born: body.born != null ? String(body.born) : "",
        died: body.died != null ? String(body.died) : "",
        companyDraft: JSON.stringify(body.companyDraft),
        amountCents: String(body.amountCents),
      },
      success_url: env.stripeSuccessUrl,
      cancel_url: env.stripeCancelUrl,
    })

    await pool.query(`update orders set stripe_checkout_session_id = $1 where order_id = $2`, [session.id, orderId])
    return { url: session.url }
  })

  // ── Free-tier claim ──────────────────────────────────────────────────────────────────
  // Deliberately NOT a Stripe checkout: Stripe rejects a $0 charge (50¢ minimum), so a free
  // claim can never round-trip through the payment flow. It commits directly instead, reusing
  // the same claim* functions as a paid purchase so the optimistic locking, moderation and
  // WebSocket broadcast are identical — only the payment step is skipped.
  //
  // Every eligibility decision is made here from the DB. The client sends no price at all.
  //
  // THE RULE: one free spot per domain. Nothing else. A domain may own unlimited spots; every
  // one after its first free claim is a paid bid. Enforced atomically by the partial unique
  // index companies_one_free_claim_per_brand_idx (migration 003) inside the claim transaction.
  // Slightly tighter than the global default: a real user only ever needs one successful free
  // claim, but a few attempts are normal (validation errors, changing their mind, retrying), so
  // this must not be so tight that ordinary use gets throttled.
  app.post("/api/v1/claim/free", { config: { rateLimit: { max: 10, timeWindow: "60 seconds" } } }, async (req, reply) => {
    const body = freeClaimBody.parse(req.body)
    const mod = moderateCompanyDraft(body.companyDraft)
    if (!mod.ok) return reply.code(400).send({ error: mod.reason })

    // Cheap early-out for a clean error message. The index above is the real guarantee — this
    // read can't see a concurrent uncommitted claim (READ COMMITTED).
    if (await hasBrandUsedFreeClaim(pool, body.companyDraft.url)) {
      return reply.code(409).send({ error: "free_claim_already_used" })
    }

    // Tracks the order created below so a failed claim can be marked 'failed' rather than
    // being abandoned at 'processing' forever.
    let pendingOrderId: string | null = null
    const newOrder = async (sql: string, params: unknown[]) => {
      const { rows } = await pool.query<{ order_id: string }>(sql, params)
      pendingOrderId = rows[0]!.order_id
      return pendingOrderId
    }

    try {
      if (body.target === "slot") {
        // is_free lives on the slot layout row; company_id null ⇒ still unclaimed.
        const { rows } = await pool.query<{ is_free: boolean; company_id: string | null }>(
          `select s.is_free, h.company_id from holdings h
           join slots s on s.slot_id = h.slot_id
           where h.slot_id = $1`,
          [body.slotId],
        )
        if (!rows[0]) return reply.code(404).send({ error: "unknown_slot" })
        if (!rows[0].is_free) return reply.code(409).send({ error: "not_free_tier" })
        if (rows[0].company_id) return reply.code(409).send({ error: "already_claimed" })

        await claimSlot({
          slotId: body.slotId,
          amountCents: 0,
          draft: body.companyDraft,
          ownerUserId: null,
          orderId: await newOrder(
            `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
             values ('single', array[$1], 1, 0, 0, 'processing') returning order_id`,
            [body.slotId],
          ),
          isFreeSlot: true,
        })
        return { ok: true }
      }

      if (body.target === "building") {
        const nameMod = moderateFreeText(body.officeName)
        if (!nameMod.ok) return reply.code(400).send({ error: nameMod.reason })

        const { rows } = await pool.query<{ is_free: boolean; office_owner_id: string | null }>(
          `select is_free, office_owner_id from buildings where building_id = $1`,
          [body.buildingId],
        )
        if (!rows[0]) return reply.code(404).send({ error: "unknown_building" })
        if (!rows[0].is_free) return reply.code(409).send({ error: "not_free_tier" })
        if (rows[0].office_owner_id) return reply.code(409).send({ error: "already_claimed" })

        await claimBuilding({
          buildingId: body.buildingId,
          amountCents: 0,
          officeName: body.officeName,
          draft: body.companyDraft,
          ownerUserId: null,
          orderId: await newOrder(
            `insert into orders (kind, building_id, quantity, price_per_unit_cents, total_cents, status)
             values ('building', $1, 1, 0, 0, 'processing') returning order_id`,
            [body.buildingId],
          ),
          isFreeBuilding: true,
        })
        return { ok: true }
      }

      const nameMod = moderateFreeText(body.startupName)
      if (!nameMod.ok) return reply.code(400).send({ error: nameMod.reason })
      if (body.story) {
        const storyMod = moderateFreeText(body.story)
        if (!storyMod.ok) return reply.code(400).send({ error: storyMod.reason })
      }

      const { rows } = await pool.query<{ is_free: boolean; company_id: string | null }>(
        `select is_free, company_id from graveyard_plots where plot_id = $1`,
        [body.plotId],
      )
      if (!rows[0]) return reply.code(404).send({ error: "unknown_plot" })
      if (!rows[0].is_free) return reply.code(409).send({ error: "not_free_tier" })
      if (rows[0].company_id) return reply.code(409).send({ error: "already_claimed" })

      await claimGraveyard({
        plotId: body.plotId,
        amountCents: 0,
        startupName: body.startupName,
        story: body.story ?? "",
        domain: body.domain ?? null,
        born: body.born ?? null,
        died: body.died ?? null,
        draft: body.companyDraft,
        ownerUserId: null,
        orderId: await newOrder(
          `insert into orders (kind, graveyard_plot_id, quantity, price_per_unit_cents, total_cents, status)
           values ('graveyard', $1, 1, 0, 0, 'processing') returning order_id`,
          [body.plotId],
        ),
        isFreePlot: true,
      })
      return { ok: true }
    } catch (err) {
      // The claim threw, so its order never reached 'succeeded'. Close it out instead of
      // leaving a stuck 'processing' row in the order history.
      if (pendingOrderId) {
        await pool
          .query(`update orders set status = 'failed' where order_id = $1 and status = 'processing'`, [pendingOrderId])
          .catch(() => {})
      }
      // Lost the race: someone claimed it, or this brand's free claim was consumed by a
      // concurrent request that committed first.
      if (err instanceof FreeClaimUsedError) {
        return reply.code(409).send({ error: "free_claim_already_used" })
      }
      if (err instanceof ClaimConflictError) {
        return reply.code(409).send({ error: "already_claimed" })
      }
      throw err
    }
  })
}
