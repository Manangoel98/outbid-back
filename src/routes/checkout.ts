import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { pool } from "../lib/db.js"
import { env } from "../env.js"
import { stripe } from "../lib/stripe.js"
import { computeTakePriceCents } from "../lib/claims.js"
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

export async function checkoutRoutes(app: FastifyInstance) {
  // Tighter than the global default (see server.ts) — checkout creates real Stripe
  // sessions, so it's the most expensive/abusable route in the API.
  const checkoutRateLimit = { max: 8, timeWindow: "60 seconds" }

  // Single-slot claim/raise — mirrors takePrice() in src/stores/gameStore.ts.
  app.post("/api/v1/checkout/slot", { config: { rateLimit: checkoutRateLimit } }, async (req, reply) => {
    const body = slotCheckoutBody.parse(req.body)
    const mod = moderateCompanyDraft(body.companyDraft)
    if (!mod.ok) return reply.code(400).send({ error: mod.reason })
    const { rows } = await pool.query(`select standing_bid_cents, company_id from holdings where slot_id = $1`, [body.slotId])
    if (!rows[0]) return reply.code(404).send({ error: "unknown_slot" })
    const need = computeTakePriceCents(rows[0].standing_bid_cents, false)
    if (body.amountCents < need) return reply.code(409).send({ error: "bid_too_low", minNeeded: need })

    const { rows: orderRows } = await pool.query(
      `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
       values ('single', array[$1], 1, $2, $2, 'pending') returning order_id`,
      [body.slotId, body.amountCents],
    )
    const orderId = orderRows[0]!.order_id as string

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Card-only: keeps payment synchronous so checkout.session.completed always means
      // funds are captured immediately (see webhook.ts's payment_status guard too).
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: { currency: "usd", product_data: { name: `Claim ${body.slotId}` }, unit_amount: body.amountCents },
          quantity: 1,
        },
      ],
      metadata: { orderId, kind: "single", slotId: body.slotId, companyDraft: JSON.stringify(body.companyDraft), amountCents: String(body.amountCents) },
      success_url: env.stripeSuccessUrl,
      cancel_url: env.stripeCancelUrl,
    })

    await pool.query(`update orders set stripe_checkout_session_id = $1 where order_id = $2`, [session.id, orderId])
    return { url: session.url }
  })

  // Whole-building office purchase — price scales with real footprint area + height
  // (buildingFloorCents in lib/pricing.ts), computed here from the buildings table itself,
  // never trusted from the client.
  app.post("/api/v1/checkout/building", { config: { rateLimit: checkoutRateLimit } }, async (req, reply) => {
    const body = buildingCheckoutBody.parse(req.body)
    const mod = moderateCompanyDraft(body.companyDraft)
    if (!mod.ok) return reply.code(400).send({ error: mod.reason })
    const nameMod = moderateFreeText(body.officeName)
    if (!nameMod.ok) return reply.code(400).send({ error: nameMod.reason })
    const { rows } = await pool.query<{ w: number; d: number; h: number; price_cents: number | null }>(
      `select w, d, h, price_cents from buildings where building_id = $1`,
      [body.buildingId],
    )
    if (!rows[0]) return reply.code(404).send({ error: "unknown_building" })
    const floorTotal = buildingFloorCents(rows[0].w, rows[0].d, rows[0].h)
    const need = rows[0].price_cents ? rows[0].price_cents + env.takeDeltaCents : floorTotal
    const amountCents = need

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
}
