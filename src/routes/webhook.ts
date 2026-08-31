import type { FastifyInstance } from "fastify"
import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { stripe } from "../lib/stripe.js"
import { ClaimConflictError, claimBuilding, claimGraveyard, claimSlot, type CompanyDraft } from "../lib/claims.js"

/**
 * Stripe webhook — the only place holdings actually flip. Idempotent on
 * stripe_payment_intent_id (unique constraint on orders), so Stripe's automatic
 * retries are safe to re-process. If the optimistic lock in claims.ts fails
 * (someone else won the slot while this payment was in flight), we refund
 * automatically per BACKEND_PLAN.md §3.2 / §4.
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/stripe/webhook",
    // Higher ceiling than user-facing routes: Stripe can legitimately burst-deliver
    // retries, and this route is already gated by signature verification below, so
    // rate limiting here is only a backstop against unsigned junk floods.
    { config: { rawBody: true, rateLimit: { max: 60, timeWindow: "60 seconds" } } },
    async (req, reply) => {
      const sig = req.headers["stripe-signature"]
      if (!sig || typeof sig !== "string") return reply.code(400).send({ error: "missing_signature" })

      let event: import("stripe").Stripe.Event
      try {
        // @ts-expect-error rawBody attached by fastify raw-body hook (see server.ts)
        const raw = req.rawBody as Buffer
        event = stripe.webhooks.constructEvent(raw, sig, env.stripeWebhookSecret)
      } catch (err) {
        app.log.error(err)
        return reply.code(400).send({ error: "bad_signature" })
      }

      if (event.type !== "checkout.session.completed") return reply.send({ received: true })

      const session = event.data.object as import("stripe").Stripe.Checkout.Session

      // Defense in depth: checkout.session.completed can fire before funds actually settle
      // for delayed payment methods. Checkout Sessions here are restricted to card-only
      // (synchronous capture — see checkout.ts), so payment_status should always be "paid"
      // by the time this event lands; this guard makes that assumption explicit rather than
      // implicit, so if a future payment method is ever added, an unpaid session can't
      // silently flip a holding/building.
      if (session.payment_status !== "paid") return reply.send({ received: true, notPaid: true })

      const meta = session.metadata ?? {}
      const orderId = meta.orderId
      if (!orderId) return reply.send({ received: true })

      // Atomic idempotency gate: only one webhook/reconcile worker can process a pending
      // order. A plain SELECT-then-claim race lets two concurrent deliveries both read
      // status='pending', the first succeeds, the second hits ClaimConflictError (standing
      // bid already equals amount) and incorrectly refunds a legitimate payment.
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null
      const { rows: lockRows } = await pool.query<{ order_id: string }>(
        `update orders set status = 'processing'
         where order_id = $1 and status = 'pending'
         returning order_id`,
        [orderId],
      )
      if (!lockRows[0]) {
        return reply.send({ received: true, alreadyProcessed: true })
      }

      try {
        if (meta.kind === "single") {
          const draft: CompanyDraft = JSON.parse(meta.companyDraft ?? "{}")
          await claimSlot({
            slotId: meta.slotId!,
            amountCents: Number(meta.amountCents),
            draft,
            ownerUserId: null,
            orderId,
            stripePaymentIntentId: paymentIntentId,
          })
        } else if (meta.kind === "building") {
          const draft: CompanyDraft = JSON.parse(meta.companyDraft ?? "{}")
          await claimBuilding({
            buildingId: Number(meta.buildingId),
            amountCents: Number(meta.amountCents),
            officeName: meta.officeName!,
            draft,
            ownerUserId: null,
            orderId,
            stripePaymentIntentId: paymentIntentId,
          })
        } else if (meta.kind === "graveyard") {
          const draft: CompanyDraft = JSON.parse(meta.companyDraft ?? "{}")
          await claimGraveyard({
            plotId: meta.plotId!,
            amountCents: Number(meta.amountCents),
            startupName: meta.startupName ?? "",
            story: meta.story ?? "",
            domain: meta.domain ? meta.domain : null,
            born: meta.born ? Number(meta.born) : null,
            died: meta.died ? Number(meta.died) : null,
            draft,
            ownerUserId: null,
            orderId,
            stripePaymentIntentId: paymentIntentId,
          })
        } else {
        }
      } catch (err) {
        if (err instanceof ClaimConflictError && paymentIntentId) {
          // Re-check: another worker may have finished this exact order while we were claiming.
          const { rows: fresh } = await pool.query<{ status: string }>(
            `select status from orders where order_id = $1`,
            [orderId],
          )
          if (fresh[0]?.status === "succeeded") {
            return reply.send({ received: true, alreadyProcessed: true })
          }
          // Genuine lost race to a different buyer — refund in full.
          await stripe.refunds.create({ payment_intent: paymentIntentId })
          await pool.query(`update orders set status = 'refunded' where order_id = $1`, [orderId])
          app.log.warn(`Refunded order ${orderId}: ${err.message}`)
        } else {
          await pool.query(`update orders set status = 'pending' where order_id = $1 and status = 'processing'`, [orderId])
          app.log.error(err)
          throw err
        }
      }

      return reply.send({ received: true })
    },
  )
}
