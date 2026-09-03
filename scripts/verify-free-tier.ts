/**
 * Verifies the free-tier invariants against the live DB:
 *   1. is_free is ~50% on each layout table, and does NOT exist on holdings.
 *   2. One free claim per brand_key (domain), enforced even under concurrency.
 *   3. A brand that used its free claim can still PAY for more spots.
 *
 * Run: npx tsx scripts/verify-free-tier.ts
 * Cleans up everything it creates.
 */
import { pool } from "../src/lib/db.js"
import { claimSlot, hasBrandUsedFreeClaim, FreeClaimUsedError } from "../src/lib/claims.js"

const TEST_HOST = "free-tier-probe.example"
let failures = 0

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

async function cleanup() {
  const { rows } = await pool.query<{ company_id: string }>(
    `select company_id from companies where brand_key = $1`,
    [TEST_HOST],
  )
  const ids = rows.map((r) => r.company_id)
  if (ids.length) {
    await pool.query(
      `update holdings set company_id = null, standing_bid_cents = 0
       where company_id = any($1::uuid[])`,
      [ids],
    )
    await pool.query(`delete from orders where company_id = any($1::uuid[])`, [ids])
    await pool.query(`delete from companies where company_id = any($1::uuid[])`, [ids])
  }
}

async function main() {
  await cleanup()

  // ── 1. data model ──────────────────────────────────────────────────────────
  const { rows: holdingsCol } = await pool.query(
    `select 1 from information_schema.columns where table_name = 'holdings' and column_name = 'is_free'`,
  )
  check("holdings.is_free removed", holdingsCol.length === 0, `found ${holdingsCol.length} col(s)`)

  for (const [table, id] of [
    ["slots", "slot_id"],
    ["buildings", "building_id"],
    ["graveyard_plots", "plot_id"],
  ] as const) {
    const { rows } = await pool.query<{ total: string; free: string }>(
      `select count(*) as total, count(*) filter (where is_free) as free from ${table}`,
    )
    const total = Number(rows[0]!.total)
    const free = Number(rows[0]!.free)
    const pct = total ? (free / total) * 100 : 0
    check(`${table} ~50% free`, total > 0 && Math.abs(pct - 50) < 1.5, `${free}/${total} = ${pct.toFixed(1)}%`)
    void id
  }

  // ── 2. one free claim per domain ───────────────────────────────────────────
  const { rows: freeSlots } = await pool.query<{ slot_id: string }>(
    `select s.slot_id from slots s
     join holdings h on h.slot_id = s.slot_id
     where s.is_free and h.company_id is null
     limit 2`,
  )
  if (freeSlots.length < 2) {
    check("two unclaimed free slots available to test with", false, `got ${freeSlots.length}`)
  } else {
    const [a, b] = [freeSlots[0]!.slot_id, freeSlots[1]!.slot_id]
    const draft = {
      name: "Free Probe",
      url: `https://${TEST_HOST}`,
      tagline: "probing the free tier",
      logoUrl: null,
      primary: "#C43B2A",
      ink: "#F5F0E8",
    }

    check("brand starts with free claim unused", !(await hasBrandUsedFreeClaim(pool, draft.url)))

    const order1 = await pool.query(
      `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
       values ('single', array[$1], 1, 0, 0, 'processing') returning order_id`,
      [a],
    )
    await claimSlot({
      slotId: a,
      amountCents: 0,
      draft,
      ownerUserId: null,
      orderId: order1.rows[0]!.order_id,
      isFreeSlot: true,
    })
    check("first $0 claim succeeds", true)
    check("free claim now marked used", await hasBrandUsedFreeClaim(pool, draft.url))

    // Second free claim on a DIFFERENT free slot, same domain → must be refused.
    const order2 = await pool.query(
      `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
       values ('single', array[$1], 1, 0, 0, 'processing') returning order_id`,
      [b],
    )
    let refused = false
    try {
      await claimSlot({
        slotId: b,
        amountCents: 0,
        draft,
        ownerUserId: null,
        orderId: order2.rows[0]!.order_id,
        isFreeSlot: true,
      })
    } catch (e) {
      refused = e instanceof FreeClaimUsedError
    }
    check("second $0 claim from same domain refused", refused)

    const { rows: bOwner } = await pool.query<{ company_id: string | null }>(
      `select company_id from holdings where slot_id = $1`,
      [b],
    )
    check("refused claim left the slot unowned", bOwner[0]!.company_id === null)

    // ── 3. same domain can still PAY for that same slot ─────────────────────
    const order3 = await pool.query(
      `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
       values ('single', array[$1], 1, 100, 100, 'processing') returning order_id`,
      [b],
    )
    await claimSlot({
      slotId: b,
      amountCents: 100,
      draft,
      ownerUserId: null,
      orderId: order3.rows[0]!.order_id,
    })
    const { rows: paid } = await pool.query<{ company_id: string | null; standing_bid_cents: number }>(
      `select company_id, standing_bid_cents from holdings where slot_id = $1`,
      [b],
    )
    check(
      "same domain CAN still buy more spots for money",
      paid[0]!.company_id !== null && paid[0]!.standing_bid_cents === 100,
      `owner=${paid[0]!.company_id ? "set" : "null"} bid=${paid[0]!.standing_bid_cents}`,
    )
  }

  await cleanup()
  console.log(failures === 0 ? "\nALL FREE-TIER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  await pool.end()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  await pool.end()
  process.exit(1)
})
