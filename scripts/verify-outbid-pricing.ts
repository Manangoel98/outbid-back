/**
 * Verifies outbid pricing AFTER a free claim, for all three item types:
 *
 *   banner (slot)   free-claimed → takeable for the $1 floor        (cheap on purpose)
 *   building        free-claimed → takeable ONLY at real floor price (size-based, not $1)
 *   graveyard plot  free-claimed → takeable for the $1 floor        (its real price)
 *
 * Also proves the DB-level optimistic locks reject an underpriced takeover, not just the
 * route-level check — that's what stops a crafted request or a race.
 *
 * Run: npx tsx scripts/verify-outbid-pricing.ts
 */
import { pool } from "../src/lib/db.js"
import { claimSlot, claimBuilding, claimGraveyard, ClaimConflictError, FreeClaimUsedError } from "../src/lib/claims.js"
import { buildingFloorCents } from "../src/lib/pricing.js"

const FREE_HOST = "outbid-probe-free.example"
const TAKER_HOST = "outbid-probe-taker.example"
// Each item type needs its OWN free-claim domain: one free claim per brand is enforced
// globally, so reusing a single host here would (correctly) be refused on the 2nd claim.
const FREE_SLOT_HOST = "outbid-probe-free-slot.example"
const FREE_BLDG_HOST = "outbid-probe-free-bldg.example"
const FREE_PLOT_HOST = "outbid-probe-free-plot.example"
const ALL_HOSTS = [FREE_HOST, TAKER_HOST, FREE_SLOT_HOST, FREE_BLDG_HOST, FREE_PLOT_HOST]
let failures = 0

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

function draftFor(host: string) {
  return {
    name: "Outbid Probe",
    url: `https://${host}`,
    tagline: "probing outbid pricing",
    logoUrl: null,
    primary: "#C43B2A",
    ink: "#F5F0E8",
  }
}

async function order(kind: string, cents: number, extra: Record<string, unknown> = {}) {
  if (kind === "single") {
    const { rows } = await pool.query(
      `insert into orders (kind, slot_ids, quantity, price_per_unit_cents, total_cents, status)
       values ('single', array[$1], 1, $2, $2, 'processing') returning order_id`,
      [extra.slotId, cents],
    )
    return rows[0]!.order_id as string
  }
  if (kind === "building") {
    const { rows } = await pool.query(
      `insert into orders (kind, building_id, quantity, price_per_unit_cents, total_cents, status)
       values ('building', $1, 1, $2, $2, 'processing') returning order_id`,
      [extra.buildingId, cents],
    )
    return rows[0]!.order_id as string
  }
  const { rows } = await pool.query(
    `insert into orders (kind, graveyard_plot_id, quantity, price_per_unit_cents, total_cents, status)
     values ('graveyard', $1, 1, $2, $2, 'processing') returning order_id`,
    [extra.plotId, cents],
  )
  return rows[0]!.order_id as string
}

let usedSlots: string[] = []
let usedBuildings: number[] = []
let usedPlots: string[] = []

async function cleanup() {
  const { rows } = await pool.query<{ company_id: string }>(
    `select company_id from companies where brand_key = any($1::text[])`,
    [ALL_HOSTS],
  )
  const ids = rows.map((r) => r.company_id)
  if (usedSlots.length) {
    await pool.query(
      `update holdings set company_id = null, standing_bid_cents = 0, paid_total_cents = 0,
              claimed_at = null, last_raise_at = null where slot_id = any($1::text[])`,
      [usedSlots],
    )
  }
  if (usedBuildings.length) {
    await pool.query(
      `update buildings set office_owner_id = null, office_name = null, price_cents = null,
              purchased_at = null where building_id = any($1::int[])`,
      [usedBuildings],
    )
  }
  if (usedPlots.length) {
    await pool.query(
      `update graveyard_plots set company_id = null, name = '', story = '', domain = null,
              born = null, died = null, standing_bid_cents = 0, paid_total_cents = 0,
              claimed_at = null, last_raise_at = null where plot_id = any($1::text[])`,
      [usedPlots],
    )
  }
  if (ids.length) {
    await pool.query(`delete from orders where company_id = any($1::uuid[])`, [ids])
    await pool.query(`delete from companies where company_id = any($1::uuid[])`, [ids])
  }
}

async function main() {
  await cleanup()

  // ── BANNER: free-claimed, then taken for $1 ────────────────────────────────
  const { rows: slotRow } = await pool.query<{ slot_id: string }>(
    `select s.slot_id from slots s join holdings h on h.slot_id = s.slot_id
     where s.is_free and h.company_id is null limit 1`,
  )
  if (!slotRow[0]) {
    check("found a free unclaimed slot", false)
  } else {
    const slotId = slotRow[0].slot_id
    usedSlots.push(slotId)
    await claimSlot({
      slotId,
      amountCents: 0,
      draft: draftFor(FREE_SLOT_HOST),
      ownerUserId: null,
      orderId: await order("single", 0, { slotId }),
      isFreeSlot: true,
    })
    const { rows: after } = await pool.query<{ standing_bid_cents: number }>(
      `select standing_bid_cents from holdings where slot_id = $1`,
      [slotId],
    )
    check("banner free-claimed at $0", after[0]!.standing_bid_cents === 0)

    // $0 takeover must be refused (below the $1 floor).
    let zeroRefused = false
    try {
      await claimSlot({
        slotId,
        amountCents: 0,
        draft: draftFor(TAKER_HOST),
        ownerUserId: null,
        orderId: await order("single", 0, { slotId }),
      })
    } catch (e) {
      zeroRefused = e instanceof ClaimConflictError
    }
    check("banner: $0 takeover refused by DB lock", zeroRefused)

    // $1 takeover must succeed — banners are cheap to contest by design.
    await claimSlot({
      slotId,
      amountCents: 100,
      draft: draftFor(TAKER_HOST),
      ownerUserId: null,
      orderId: await order("single", 100, { slotId }),
    })
    const { rows: taken } = await pool.query<{ standing_bid_cents: number }>(
      `select standing_bid_cents from holdings where slot_id = $1`,
      [slotId],
    )
    check("banner: free-claimed banner taken for $1", taken[0]!.standing_bid_cents === 100)
  }

  // ── BUILDING: free-claimed, must cost REAL floor to take ───────────────────
  const { rows: bRow } = await pool.query<{ building_id: number; w: number; d: number; h: number }>(
    `select building_id, w, d, h from buildings
     where is_free and office_owner_id is null
     order by w * d * 16 + h * 90 desc limit 1`,
  )
  if (!bRow[0]) {
    check("found a free unclaimed building", false)
  } else {
    const { building_id: bid, w, d, h } = bRow[0]
    usedBuildings.push(bid)
    const floor = buildingFloorCents(w, d, h)
    await claimBuilding({
      buildingId: bid,
      amountCents: 0,
      officeName: "Probe Tower",
      draft: draftFor(FREE_BLDG_HOST),
      ownerUserId: null,
      orderId: await order("building", 0, { buildingId: bid }),
      isFreeBuilding: true,
    })
    const { rows: after } = await pool.query<{ price_cents: number | null }>(
      `select price_cents from buildings where building_id = $1`,
      [bid],
    )
    check("building free-claimed at $0", after[0]!.price_cents === 0, `floor is $${(floor / 100).toFixed(2)}`)

    // THE KEY CHECK: $1 must NOT be enough to steal a free-claimed tower.
    let cheapRefused = false
    try {
      await claimBuilding({
        buildingId: bid,
        amountCents: 100,
        officeName: "Cheap Steal",
        draft: draftFor(TAKER_HOST),
        ownerUserId: null,
        orderId: await order("building", 100, { buildingId: bid }),
      })
    } catch (e) {
      cheapRefused = e instanceof ClaimConflictError
    }
    check("building: $1 takeover of free-claimed tower REFUSED", cheapRefused, `needs $${(floor / 100).toFixed(2)}`)

    // Just below floor also refused.
    let belowRefused = false
    try {
      await claimBuilding({
        buildingId: bid,
        amountCents: floor - 1,
        officeName: "Almost",
        draft: draftFor(TAKER_HOST),
        ownerUserId: null,
        orderId: await order("building", floor - 1, { buildingId: bid }),
      })
    } catch (e) {
      belowRefused = e instanceof ClaimConflictError
    }
    check("building: floor-minus-1¢ takeover refused", belowRefused)

    // At the real floor price it succeeds.
    await claimBuilding({
      buildingId: bid,
      amountCents: floor,
      officeName: "Fair Price",
      draft: draftFor(TAKER_HOST),
      ownerUserId: null,
      orderId: await order("building", floor, { buildingId: bid }),
    })
    const { rows: taken } = await pool.query<{ price_cents: number | null; office_name: string | null }>(
      `select price_cents, office_name from buildings where building_id = $1`,
      [bid],
    )
    check(
      "building: takeover at real floor price succeeds",
      taken[0]!.price_cents === floor && taken[0]!.office_name === "Fair Price",
      `paid $${(floor / 100).toFixed(2)}`,
    )
  }

  // ── GRAVEYARD: free-claimed, then outbid at real price ($1 floor) ──────────
  // Also asserts the one-free-claim rule holds for plots: a domain that already free-claimed
  // a plot cannot free-claim a second one.
  const { rows: pRow } = await pool.query<{ plot_id: string }>(
    `select plot_id from graveyard_plots where is_free and company_id is null limit 2`,
  )
  if (!pRow[0]) {
    check("found a free unclaimed plot", false)
  } else {
    const plotId = pRow[0].plot_id
    usedPlots.push(plotId)
    await claimGraveyard({
      plotId,
      amountCents: 0,
      startupName: "Dead Probe Inc",
      story: "died probing",
      domain: null,
      born: 2019,
      died: 2024,
      draft: draftFor(FREE_PLOT_HOST),
      ownerUserId: null,
      orderId: await order("graveyard", 0, { plotId }),
      isFreePlot: true,
    })
    const { rows: after } = await pool.query<{ standing_bid_cents: number }>(
      `select standing_bid_cents from graveyard_plots where plot_id = $1`,
      [plotId],
    )
    check("plot free-claimed at $0", after[0]!.standing_bid_cents === 0)

    let zeroRefused = false
    try {
      await claimGraveyard({
        plotId,
        amountCents: 0,
        startupName: "Free Steal",
        story: "",
        domain: null,
        born: null,
        died: null,
        draft: draftFor(TAKER_HOST),
        ownerUserId: null,
        orderId: await order("graveyard", 0, { plotId }),
      })
    } catch (e) {
      zeroRefused = e instanceof ClaimConflictError
    }
    check("plot: $0 takeover refused by DB lock", zeroRefused)

    await claimGraveyard({
      plotId,
      amountCents: 100,
      startupName: "Paid Grave",
      story: "bought it",
      domain: null,
      born: 2020,
      died: 2025,
      draft: draftFor(TAKER_HOST),
      ownerUserId: null,
      orderId: await order("graveyard", 100, { plotId }),
    })
    const { rows: taken } = await pool.query<{ standing_bid_cents: number; name: string }>(
      `select standing_bid_cents, name from graveyard_plots where plot_id = $1`,
      [plotId],
    )
    check(
      "plot: free-claimed grave outbid at $1 real price",
      taken[0]!.standing_bid_cents === 100 && taken[0]!.name === "Paid Grave",
    )

    // One free claim per domain applies to graves too: the same domain must not be able to
    // free-claim a SECOND plot.
    if (pRow[1]) {
      const plot2 = pRow[1].plot_id
      usedPlots.push(plot2)
      let secondRefused = false
      try {
        await claimGraveyard({
          plotId: plot2,
          amountCents: 0,
          startupName: "Second Free Grave",
          story: "",
          domain: null,
          born: null,
          died: null,
          draft: draftFor(FREE_PLOT_HOST),
          ownerUserId: null,
          orderId: await order("graveyard", 0, { plotId: plot2 }),
          isFreePlot: true,
        })
      } catch (e) {
        secondRefused = e instanceof FreeClaimUsedError
      }
      const { rows: p2 } = await pool.query<{ company_id: string | null }>(
        `select company_id from graveyard_plots where plot_id = $1`,
        [plot2],
      )
      check(
        "plot: same domain CANNOT free-claim a second grave",
        secondRefused && p2[0]!.company_id === null,
      )
    }
  }

  await cleanup()
  console.log(failures === 0 ? "\nALL OUTBID-PRICING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  await pool.end()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  await pool.end()
  process.exit(1)
})
