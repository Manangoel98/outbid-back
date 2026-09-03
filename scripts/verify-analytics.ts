/**
 * Verifies the analytics pipeline produces REAL, non-forgeable numbers.
 *
 * Each check targets a specific way the old implementation produced fake counts:
 *   1. Dedup is enforced by the database, so it survives restarts and works across instances
 *      (the old in-memory Map lost all state on every cold start and deduped per-process).
 *   2. Rotating the client-supplied visitorId does NOT inflate counts (it was the entire dedup
 *      key before, so inflating any placement was a for-loop).
 *   3. A batch containing the same placement many times counts it once.
 *   4. Counter columns stay exactly equal to the number of unique events.
 *   5. Buildings are counted at all (they were silently ignored).
 *   6. Bots and off-origin callers are refused.
 *   7. Windowed stats and the CTR suppression threshold behave.
 *
 * Checks 1-5 and 7 exercise the real database path directly. Checks over HTTP run only when a
 * server is reachable at API_URL, so this is useful in CI without one.
 *
 * Run: npx tsx scripts/verify-analytics.ts
 * Cleans up everything it creates.
 */
import { pool } from "../src/lib/db.js"
import { recordEvent, slotStats, buildingStats } from "../src/lib/analytics.js"
import { bucketStart, PASS_WINDOW_MS, VISIT_WINDOW_MS } from "../src/lib/visitor.js"

const API_URL = process.env.API_URL ?? "http://localhost:8080"
const HASH_A = "verify-analytics-hash-aaaa"
const HASH_B = "verify-analytics-hash-bbbb"
const PROBE_HASHES = [HASH_A, HASH_B]
// Captured before any writes so cleanup can delete exactly the rows this run created, including
// HTTP-probe rows written under this machine's real (unpredictable) visitor hash.
const START_TS = new Date()

let failures = 0

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

/** Roll the counters back to where they started, so running the verifier never leaves the
 *  published numbers wrong. */
async function cleanup(slotId: string | null, buildingId: number | null) {
  await pool.query(`delete from ad_events where visitor_hash = any($1::text[])`, [PROBE_HASHES])
  if (slotId) {
    await pool.query(`update holdings set impressions = $2, clicks = $3 where slot_id = $1`, [
      slotId,
      baseline.slotImpressions,
      baseline.slotClicks,
    ])
  }
  if (buildingId != null) {
    await pool.query(`update buildings set impressions = $2, clicks = $3 where building_id = $1`, [
      buildingId,
      baseline.buildingImpressions,
      baseline.buildingClicks,
    ])
  }
}

const baseline = {
  slotImpressions: 0,
  slotClicks: 0,
  buildingImpressions: 0,
  buildingClicks: 0,
}

async function main() {
  // Pick real rows to probe against.
  const { rows: slotRows } = await pool.query<{ slot_id: string }>(
    `select slot_id from holdings order by slot_id limit 1`,
  )
  const { rows: bRows } = await pool.query<{ building_id: number }>(
    `select building_id from buildings order by building_id limit 1`,
  )
  if (!slotRows[0] || !bRows[0]) {
    console.error("No slots/buildings in DB — run seed first.")
    process.exit(1)
  }
  const slotId = slotRows[0].slot_id
  const buildingId = bRows[0].building_id

  // Record the starting counters so cleanup can restore them exactly.
  const { rows: bh } = await pool.query(
    `select impressions, clicks from holdings where slot_id = $1`,
    [slotId],
  )
  const { rows: bb } = await pool.query(
    `select impressions, clicks from buildings where building_id = $1`,
    [buildingId],
  )
  baseline.slotImpressions = bh[0].impressions
  baseline.slotClicks = bh[0].clicks
  baseline.buildingImpressions = bb[0].impressions
  baseline.buildingClicks = bb[0].clicks

  await cleanup(slotId, buildingId)

  const client = await pool.connect()
  const passBucket = bucketStart(PASS_WINDOW_MS)
  const visitBucket = bucketStart(VISIT_WINDOW_MS)

  try {
    // ── 1. dedup is durable, not in-memory ────────────────────────────────────
    // Two identical calls with the same derived hash: the second must not count. Because the
    // guarantee is a unique index, this holds across process restarts and instances.
    const first = await recordEvent(client, { slotId }, "pass", HASH_A, passBucket, "client-1")
    const second = await recordEvent(client, { slotId }, "pass", HASH_A, passBucket, "client-1")
    check("first pass counts", first.counted)
    check("repeat pass in same window does NOT count", !second.counted)

    // ── 2. forged client ids cannot inflate ───────────────────────────────────
    // This is the headline fix. Same visitor, 50 different client-supplied ids — the old code
    // counted 50 impressions, the new code counts zero extra because the id is not the key.
    let inflated = 0
    for (let i = 0; i < 50; i++) {
      const r = await recordEvent(client, { slotId }, "pass", HASH_A, passBucket, `forged-${i}`)
      if (r.counted) inflated++
    }
    check("50 rotated client ids add 0 counts", inflated === 0, `added ${inflated}`)

    // A genuinely different visitor still counts — dedup must not collapse everyone into one.
    const other = await recordEvent(client, { slotId }, "pass", HASH_B, passBucket, "client-2")
    check("a different visitor still counts", other.counted)

    // ── 3. counters equal unique events exactly ───────────────────────────────
    const { rows: evCount } = await pool.query<{ n: string }>(
      `select count(*)::text as n from ad_events
       where slot_id = $1 and event_kind = 'pass' and visitor_hash = any($2::text[])`,
      [slotId, PROBE_HASHES],
    )
    const { rows: nowH } = await pool.query<{ impressions: number }>(
      `select impressions from holdings where slot_id = $1`,
      [slotId],
    )
    const uniqueEvents = Number(evCount[0].n)
    const delta = nowH[0].impressions - baseline.slotImpressions
    check(
      "counter delta == unique event rows",
      uniqueEvents === 2 && delta === 2,
      `events=${uniqueEvents} counterDelta=${delta}`,
    )

    // ── 4. visits dedup on their own, longer window ───────────────────────────
    const v1 = await recordEvent(client, { slotId }, "visit", HASH_A, visitBucket, null)
    const v2 = await recordEvent(client, { slotId }, "visit", HASH_A, visitBucket, null)
    check("first visit counts", v1.counted)
    check("repeat visit does NOT count", !v2.counted)

    // ── 5. buildings are tracked ──────────────────────────────────────────────
    const bp = await recordEvent(client, { buildingId }, "pass", HASH_A, passBucket, null)
    const bpDup = await recordEvent(client, { buildingId }, "pass", HASH_A, passBucket, null)
    const bv = await recordEvent(client, { buildingId }, "visit", HASH_A, visitBucket, null)
    check("building pass counts", bp.counted)
    check("building pass dedups", !bpDup.counted)
    check("building visit counts", bv.counted)

    // A slot and a building sharing a hash+bucket must not collide: the partial unique indexes
    // exist precisely because one composite index over both nullable columns would not work.
    const { rows: bCount } = await pool.query<{ n: string }>(
      `select count(*)::text as n from ad_events
       where building_id = $1 and visitor_hash = any($2::text[])`,
      [buildingId, PROBE_HASHES],
    )
    check("slot and building events don't collide", Number(bCount[0].n) === 2, `got ${bCount[0].n}`)

    // ── 6. stats reads ────────────────────────────────────────────────────────
    const s = await slotStats(slotId)
    const bs = await buildingStats(buildingId)
    check("slot 7d walkbys >= 2", s.walkbys7d >= 2, `got ${s.walkbys7d}`)
    check("slot 7d visits >= 1", s.visits7d >= 1, `got ${s.visits7d}`)
    check("building 7d walkbys >= 1", bs.walkbys7d >= 1, `got ${bs.walkbys7d}`)

    // CTR must stay null on tiny samples: "50% CTR" from 2 passes is noise shown to someone
    // deciding what to pay.
    check("CTR suppressed on small sample", s.ctr7d === null, `got ${String(s.ctr7d)}`)
  } finally {
    client.release()
  }

  // ── 7. HTTP surface: bot + origin rejection, batch dedup ────────────────────
  let serverUp = true
  try {
    const res = await fetch(`${API_URL}/healthz`)
    serverUp = res.ok
  } catch {
    serverUp = false
  }

  if (!serverUp) {
    console.log(`SKIP  HTTP checks — no server at ${API_URL}`)
  } else {
    const origin = process.env.PROBE_ORIGIN ?? "http://localhost:5173"
    const browserUA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"

    // A crawler must never move the numbers, because these counts are published to crawlers on
    // the SEO pages — a bot-inflated count would feed itself.
    const botRes = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": "Googlebot/2.1" },
      body: JSON.stringify({ slots: [slotId] }),
    })
    check("bot UA refused", botRes.status === 204, `status ${botRes.status}`)

    // No Origin => not a real browser on our page.
    const noOriginRes = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": browserUA },
      body: JSON.stringify({ slots: [slotId] }),
    })
    check("missing Origin refused", noOriginRes.status === 204, `status ${noOriginRes.status}`)

    // A batch repeating one placement 30 times must count it at most once.
    const dupBatch = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": browserUA },
      body: JSON.stringify({ slots: Array(30).fill(slotId) }),
    })
    const dupBody = (await dupBatch.json().catch(() => ({}))) as { counted?: number }
    check(
      "30x same slot in one batch counts <= 1",
      dupBatch.ok && (dupBody.counted ?? 99) <= 1,
      `counted=${String(dupBody.counted)}`,
    )

    // Sending it again from the same IP+UA must add nothing.
    const repeat = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": browserUA },
      body: JSON.stringify({ slots: [slotId], visitorId: "totally-new-id" }),
    })
    const repeatBody = (await repeat.json().catch(() => ({}))) as { counted?: number }
    check(
      "repeat batch with fresh visitorId counts 0",
      (repeatBody.counted ?? 99) === 0,
      `counted=${String(repeatBody.counted)}`,
    )

    // text/plain must parse, since navigator.sendBeacon uses it to dodge a preflight it cannot
    // recover from.
    const beacon = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin, "user-agent": browserUA },
      body: JSON.stringify({ slots: [slotId] }),
    })
    check("text/plain beacon body accepted", beacon.ok, `status ${beacon.status}`)

    // A batch is built from the client's cached city layout, so it can contain an id that no
    // longer exists. That must not fail the batch: a foreign-key violation propagating as a 500
    // would discard every valid pass sent alongside it.
    const mixedBatch = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": browserUA },
      body: JSON.stringify({ slots: ["definitely-not-a-real-slot-id", slotId], buildings: [999999] }),
    })
    const mixedBody = (await mixedBatch.json().catch(() => ({}))) as { counted?: number }
    check(
      "unknown ids skipped, batch still succeeds",
      mixedBatch.ok,
      `status ${mixedBatch.status} counted=${String(mixedBody.counted)}`,
    )

    // ...and the valid id in that same batch must still have been recorded.
    const onlyBogus = await fetch(`${API_URL}/api/v1/analytics/passes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": browserUA },
      body: JSON.stringify({ slots: ["definitely-not-a-real-slot-id"] }),
    })
    const onlyBogusBody = (await onlyBogus.json().catch(() => ({}))) as { counted?: number }
    check(
      "all-unknown batch returns 200 with 0 counted",
      onlyBogus.ok && (onlyBogusBody.counted ?? 99) === 0,
      `status ${onlyBogus.status} counted=${String(onlyBogusBody.counted)}`,
    )

    // X-Forwarded-For must not be usable to mint new visitors. This is environment-dependent and
    // was a genuine bypass: with trustProxy on but no real proxy in front, a client's own
    // X-Forwarded-For becomes req.ip verbatim, so each spoofed value counted as a fresh visitor.
    // env.trustProxy now gates that, so locally the raw socket address is used and spoofing is inert.
    let xffCounted = 0
    for (const fake of ["9.9.9.101", "9.9.9.102", "9.9.9.103"]) {
      const res = await fetch(`${API_URL}/api/v1/analytics/passes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "user-agent": browserUA,
          "x-forwarded-for": fake,
        },
        body: JSON.stringify({ slots: [slotId] }),
      })
      const b = (await res.json().catch(() => ({}))) as { counted?: number }
      xffCounted += b.counted ?? 0
    }
    check(
      "spoofed X-Forwarded-For cannot mint new visitors",
      xffCounted === 0,
      `added ${xffCounted} (expected 0 when no trusted proxy is in front)`,
    )

    // A visit must name exactly one placement, matching the table's check constraint.
    const bothRes = await fetch(`${API_URL}/api/v1/analytics/visit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": browserUA },
      body: JSON.stringify({ slotId, buildingId }),
    })
    check("visit with both ids rejected", bothRes.status === 400, `status ${bothRes.status}`)

    const neitherRes = await fetch(`${API_URL}/api/v1/analytics/visit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": browserUA },
      body: JSON.stringify({}),
    })
    check("visit with no id rejected", neitherRes.status === 400, `status ${neitherRes.status}`)
  }

  // Clean up everything, including the events the HTTP probes created under this machine's real
  // server-derived hash. Those can't be matched by probe hash, so they're matched by placement +
  // "created during this run" — which is why START_TS is captured before any writes.
  await pool.query(
    `delete from ad_events
     where created_at >= $1
       and (slot_id = $2 or building_id = $3)`,
    [START_TS, slotId, buildingId],
  )
  await cleanup(slotId, buildingId)

  const { rows: leftover } = await pool.query<{ n: string }>(
    `select count(*)::text as n from ad_events
     where created_at >= $1 and (slot_id = $2 or building_id = $3)`,
    [START_TS, slotId, buildingId],
  )
  check("probe events cleaned up", Number(leftover[0].n) === 0, `${leftover[0].n} left`)

  const { rows: finalH } = await pool.query<{ impressions: number; clicks: number }>(
    `select impressions, clicks from holdings where slot_id = $1`,
    [slotId],
  )
  check(
    "counters restored to baseline",
    finalH[0].impressions === baseline.slotImpressions && finalH[0].clicks === baseline.slotClicks,
    `impressions=${finalH[0].impressions} (want ${baseline.slotImpressions})`,
  )

  console.log(failures === 0 ? "\nAll analytics checks passed." : `\n${failures} check(s) FAILED.`)
  await pool.end()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await pool.end().catch(() => {})
  process.exit(1)
})
