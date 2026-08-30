// Reconciliation sweep — the exact same claim logic the Stripe webhook runs, but driven
// by asking Stripe directly "is this order actually paid?" instead of trusting a webhook
// delivery. Safe to run any time (idempotent — see the 'pending' status guard below,
// identical to webhook.ts's guard) and safe to re-run repeatedly (a cron-able safety net).
//
// Why this exists: webhook delivery can be missed (server down, wrong secret, no tunnel
// while developing locally, etc). When that happens the customer is charged in Stripe but
// the DB never flips the holding/building to "owned". This script finds every 'pending'
// order, asks Stripe for the real payment status, and — only for orders Stripe confirms
// as paid — runs the identical claimSlot/claimBuilding path the webhook would have run.
import "dotenv/config"
import { pool } from "../src/lib/db.js"
import { stripe } from "../src/lib/stripe.js"
import { ClaimConflictError, claimBuilding, claimSlot, type CompanyDraft } from "../src/lib/claims.js"

async function main() {
  const { rows: pending } = await pool.query<{
    order_id: string
    kind: string
    slot_ids: string[]
    building_id: number | null
    total_cents: number
    stripe_checkout_session_id: string | null
  }>(
    `select order_id, kind, slot_ids, building_id, total_cents, stripe_checkout_session_id
     from orders where status = 'pending' and stripe_checkout_session_id is not null
     order by created_at asc`,
  )

  if (!pending.length) {
    console.log("No pending orders with a Stripe session — nothing to reconcile.")
    return
  }

  console.log(`Found ${pending.length} pending order(s). Checking each against Stripe...\n`)

  for (const order of pending) {
    const sessionId = order.stripe_checkout_session_id!
    let session: import("stripe").Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId)
    } catch (err) {
      console.log(`  [${order.order_id}] could not fetch session ${sessionId}: ${(err as Error).message}`)
      continue
    }

    if (session.payment_status !== "paid") {
      const expired = session.status === "expired"
      console.log(`  [${order.order_id}] session ${sessionId} not paid (payment_status=${session.payment_status}, status=${session.status})${expired ? " — marking failed" : ""}`)
      if (expired) {
        await pool.query(`update orders set status = 'failed' where order_id = $1 and status = 'pending'`, [order.order_id])
      }
      continue
    }

    // Re-check status right before writing — closes the race if the real webhook fires
    // between our SELECT above and now. Use the same atomic lock as webhook.ts.
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null
    const { rows: lockRows } = await pool.query<{ order_id: string }>(
      `update orders set status = 'processing'
       where order_id = $1 and status = 'pending'
       returning order_id`,
      [order.order_id],
    )
    if (!lockRows[0]) {
      console.log(`  [${order.order_id}] already processed — skipping`)
      continue
    }

    const meta = session.metadata ?? {}
    try {
      if (meta.kind === "single" || order.kind === "single") {
        const draft: CompanyDraft = JSON.parse(meta.companyDraft ?? "{}")
        const row = await claimSlot({
          slotId: meta.slotId!,
          amountCents: Number(meta.amountCents ?? order.total_cents),
          draft,
          ownerUserId: null,
          orderId: order.order_id,
          stripePaymentIntentId: paymentIntentId,
        })
        console.log(`  [${order.order_id}] RECOVERED slot claim: slot=${row.slot_id} company=${row.company_id}`)
      } else if (meta.kind === "building" || order.kind === "building") {
        const draft: CompanyDraft = JSON.parse(meta.companyDraft ?? "{}")
        const row = await claimBuilding({
          buildingId: Number(meta.buildingId ?? order.building_id),
          amountCents: Number(meta.amountCents ?? order.total_cents),
          officeName: meta.officeName!,
          draft,
          ownerUserId: null,
          orderId: order.order_id,
          stripePaymentIntentId: paymentIntentId,
        })
        console.log(`  [${order.order_id}] RECOVERED building claim: building=${row.building_id} company=${row.office_owner_id}`)
      } else {
        console.log(`  [${order.order_id}] unknown kind "${meta.kind}" — skipping`)
        await pool.query(`update orders set status = 'failed' where order_id = $1 and status = 'processing'`, [order.order_id])
      }
    } catch (err) {
      if (err instanceof ClaimConflictError && paymentIntentId) {
        const { rows: fresh } = await pool.query<{ status: string }>(`select status from orders where order_id = $1`, [order.order_id])
        if (fresh[0]?.status === "succeeded") {
          console.log(`  [${order.order_id}] already succeeded — skip refund`)
        } else {
          console.log(`  [${order.order_id}] lost the race (someone else claimed it) — refunding`)
          await stripe.refunds.create({ payment_intent: paymentIntentId })
          await pool.query(`update orders set status = 'refunded' where order_id = $1`, [order.order_id])
        }
      } else {
        await pool.query(`update orders set status = 'pending' where order_id = $1 and status = 'processing'`, [order.order_id])
        console.error(`  [${order.order_id}] FAILED:`, err)
      }
    }
  }

  console.log("\nDone.")
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err)
    return pool.end().finally(() => process.exit(1))
  })
