/**
 * E2E over real HTTP against the running API — the earlier suites called claim* directly and so
 * never exercised the /api/v1/claim/free route itself (zod schema, eligibility checks, error
 * mapping, order bookkeeping).
 *
 * Usage: npx tsx scripts/e2e-free-claim.ts http://127.0.0.1:8799
 */
import { pool } from "../src/lib/db.js"

const BASE = process.argv[2] ?? "http://127.0.0.1:8799"
const HOST = "e2e-free-probe.example"
let failures = 0

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const draft = {
  name: "E2E Probe",
  url: `https://${HOST}`,
  tagline: "end to end probing the free route",
  primary: "#C43B2A",
  ink: "#F5F0E8",
}

async function post(body: unknown) {
  const res = await fetch(`${BASE}/api/v1/claim/free`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* empty body */
  }
  return { status: res.status, json: json as { ok?: boolean; error?: string } | null }
}

async function cleanup(slotIds: string[], plotIds: string[]) {
  if (slotIds.length) {
    await pool.query(
      `update holdings set company_id = null, standing_bid_cents = 0, paid_total_cents = 0,
              claimed_at = null, last_raise_at = null where slot_id = any($1::text[])`,
      [slotIds],
    )
  }
  if (plotIds.length) {
    await pool.query(
      `update graveyard_plots set company_id = null, name = '', story = '', domain = null,
              born = null, died = null, standing_bid_cents = 0, paid_total_cents = 0,
              claimed_at = null, last_raise_at = null where plot_id = any($1::text[])`,
      [plotIds],
    )
  }
  await pool.query(
    `delete from orders where total_cents = 0
       and stripe_checkout_session_id is null and stripe_payment_intent_id is null
       and created_at > now() - interval '1 hour'`,
  )
  await pool.query(`delete from companies where brand_key = $1`, [HOST])
}

async function main() {
  await cleanup([], [])

  const { rows: freeSlots } = await pool.query<{ slot_id: string }>(
    `select s.slot_id from slots s join holdings h on h.slot_id = s.slot_id
     where s.is_free and h.company_id is null limit 2`,
  )
  const { rows: paidSlots } = await pool.query<{ slot_id: string }>(
    `select s.slot_id from slots s join holdings h on h.slot_id = s.slot_id
     where not s.is_free and h.company_id is null limit 1`,
  )
  const { rows: freePlots } = await pool.query<{ plot_id: string }>(
    `select plot_id from graveyard_plots where is_free and company_id is null limit 1`,
  )
  if (freeSlots.length < 2 || !paidSlots[0] || !freePlots[0]) {
    console.log("SKIP: not enough free/paid targets available")
    await pool.end()
    return
  }
  const [slotA, slotB] = [freeSlots[0]!.slot_id, freeSlots[1]!.slot_id]
  const paidSlot = paidSlots[0].slot_id
  const plot = freePlots[0].plot_id
  const touchedSlots = [slotA, slotB, paidSlot]

  // 1. health
  const health = await fetch(`${BASE}/healthz`)
  check("api reachable", health.ok)

  // 2. a NON-free slot must be rejected
  const notFree = await post({ target: "slot", slotId: paidSlot, companyDraft: draft })
  check("non-free slot rejected", notFree.status === 409 && notFree.json?.error === "not_free_tier", `${notFree.status} ${notFree.json?.error}`)

  // 3. unknown slot -> 404
  const unknown = await post({ target: "slot", slotId: "definitely-not-a-slot", companyDraft: draft })
  check("unknown slot -> 404", unknown.status === 404, `${unknown.status}`)

  // 4. client CANNOT send a price (schema must strip/reject extra amount)
  const withPrice = await post({ target: "slot", slotId: slotA, companyDraft: draft, amountCents: 999999 })
  check("client-sent amountCents ignored (no price on free path)", withPrice.status === 200, `${withPrice.status} ${withPrice.json?.error ?? ""}`)
  if (withPrice.status === 200) {
    const { rows } = await pool.query<{ standing_bid_cents: number; company_id: string | null }>(
      `select standing_bid_cents, company_id from holdings where slot_id = $1`,
      [slotA],
    )
    check("free claim committed at exactly $0", rows[0]!.standing_bid_cents === 0 && rows[0]!.company_id !== null, `${rows[0]!.standing_bid_cents}c`)
  }

  // 5. SAME DOMAIN cannot free-claim a second slot
  const second = await post({ target: "slot", slotId: slotB, companyDraft: draft })
  check(
    "same domain 2nd free claim -> 409 free_claim_already_used",
    second.status === 409 && second.json?.error === "free_claim_already_used",
    `${second.status} ${second.json?.error}`,
  )
  const { rows: bStill } = await pool.query<{ company_id: string | null }>(
    `select company_id from holdings where slot_id = $1`,
    [slotB],
  )
  check("2nd slot left unclaimed", bStill[0]!.company_id === null)

  // 6. same domain cannot free-claim a GRAVE either (rule is global per domain)
  const grave = await post({ target: "plot", plotId: plot, startupName: "Dead E2E", story: "died", companyDraft: draft })
  check(
    "same domain free grave -> 409",
    grave.status === 409 && grave.json?.error === "free_claim_already_used",
    `${grave.status} ${grave.json?.error}`,
  )

  // 6b. Rate limiting must return 429, not a fake 500. The global error handler used to
  // hardcode 500, which turned every throttle into "Internal Server Error".
  let sawThrottle: number | null = null
  for (let i = 0; i < 14; i++) {
    const r = await post({ target: "slot", slotId: slotB, companyDraft: draft })
    if (r.status === 429 || r.status === 500) {
      sawThrottle = r.status
      break
    }
  }
  check("rate limit returns 429 (not a fake 500)", sawThrottle === 429, `got ${sawThrottle ?? "no throttle in 14 tries"}`)
  // Wait out the window so later assertions aren't throttled.
  if (sawThrottle) await new Promise((r) => setTimeout(r, 62_000))

  // 7. no order left stuck at 'processing'
  const { rows: stuck } = await pool.query<{ c: string }>(
    `select count(*) as c from orders
     where status = 'processing' and total_cents = 0 and created_at > now() - interval '10 minutes'`,
  )
  check("no orders stuck at 'processing'", Number(stuck[0]!.c) === 0, `${stuck[0]!.c} stuck`)

  // 8. the free claim is visible on the API the client actually reads
  const holdingsRes = await fetch(`${BASE}/api/v1/holdings`)
  const { holdings } = (await holdingsRes.json()) as { holdings: { slot_id: string; is_free: boolean; company_id: string | null }[] }
  const rowA = holdings.find((h) => h.slot_id === slotA)
  const rowB = holdings.find((h) => h.slot_id === slotB)
  check("claimed free slot exposed as owned + is_free", !!rowA?.company_id && rowA!.is_free === true)
  check("unclaimed free slot exposed as is_free (so UI can show FREE)", rowB?.company_id === null && rowB!.is_free === true)
  const freeUnclaimed = holdings.filter((h) => h.is_free && !h.company_id).length
  check("free unclaimed slots visible to client", freeUnclaimed > 0, `${freeUnclaimed} available`)

  await cleanup(touchedSlots, [plot])
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECK(S) FAILED`)
  await pool.end()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await pool.end()
  process.exit(1)
})
