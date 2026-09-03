/**
 * PROD PARITY: does the live DB match the city the frontend actually renders?
 *
 * The 3D world is generated procedurally in the browser; the DB is seeded from that same generator.
 * If they diverge, the failure is silent and user-facing: the world shows a slot the API has never
 * heard of (clicking Buy 404s), or the API sells inventory nobody can see. Nothing in the app
 * detects this, so it has to be asserted.
 *
 * Imports the REAL frontend generator and diffs it against the live DATABASE_URL.
 *
 * LOCAL DEV TOOL ONLY. The frontend is a separate repository, so the import below resolves only in
 * a workspace where both repos sit side by side. It is excluded from tsconfig for that reason and
 * will not run in CI or a clean backend clone — run it locally before a deploy that touches city
 * generation or the seeder.
 *
 * Run from backend/: npx tsx scripts/verify-city-parity.ts
 */
import { pool } from "../src/lib/db.js"
import { getCity } from "../../frontend/src/city/generateCity"

let failures = 0
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const city = getCity()

// Vehicle slots are runtime-only decoration in some builds; compare what the seeder persists.
const genSlots = new Map(city.slots.map((s) => [s.id, s]))
const { rows: dbSlotRows } = await pool.query<{
  slot_id: string
  kind: string
  tier: number
  district: string
  w: number
  h: number
}>(`select slot_id, kind, tier, district, w, h from slots`)
const dbSlots = new Map(dbSlotRows.map((r) => [r.slot_id, r]))

const missingInDb = [...genSlots.keys()].filter((id) => !dbSlots.has(id))
const extraInDb = [...dbSlots.keys()].filter((id) => !genSlots.has(id))

check(
  "every generated slot exists in the DB",
  missingInDb.length === 0,
  missingInDb.length ? `${missingInDb.length} missing, e.g. ${missingInDb.slice(0, 5).join(", ")}` : "",
)
check(
  "DB has no slots absent from the generator",
  extraInDb.length === 0,
  extraInDb.length ? `${extraInDb.length} extra, e.g. ${extraInDb.slice(0, 5).join(", ")}` : "",
)

// Attributes drive PRICE and the buy UI, so a mismatch is a mispricing, not cosmetic.
const attrMismatch: string[] = []
for (const [id, g] of genSlots) {
  const d = dbSlots.get(id)
  if (!d) continue
  if (d.kind !== g.kind) attrMismatch.push(`${id}: kind ${d.kind}!=${g.kind}`)
  else if (Number(d.tier) !== Number(g.tier)) attrMismatch.push(`${id}: tier ${d.tier}!=${g.tier}`)
  else if (d.district !== g.district) attrMismatch.push(`${id}: district ${d.district}!=${g.district}`)
}
check(
  "slot kind/tier/district match the generator",
  attrMismatch.length === 0,
  attrMismatch.length ? `${attrMismatch.length} differ, e.g. ${attrMismatch.slice(0, 4).join("; ")}` : "",
)

// Buildings are the most expensive inventory; an id drift sells the wrong tower.
const genB = new Map(city.buildings.map((b) => [b.id, b]))
const { rows: dbBRows } = await pool.query<{ building_id: number; w: number; d: number; h: number }>(
  `select building_id, w, d, h from buildings`,
)
const dbB = new Map(dbBRows.map((r) => [Number(r.building_id), r]))
const bMissing = [...genB.keys()].filter((id) => !dbB.has(id))
const bExtra = [...dbB.keys()].filter((id) => !genB.has(id))
check("every generated building exists in the DB", bMissing.length === 0, bMissing.slice(0, 5).join(", "))
check("DB has no buildings absent from the generator", bExtra.length === 0, bExtra.slice(0, 5).join(", "))

const geomDrift: string[] = []
for (const [id, g] of genB) {
  const d = dbB.get(id)
  if (!d) continue
  // Tolerance for float round-tripping through `real`.
  if (Math.abs(Number(d.h) - g.h) > 0.05) geomDrift.push(`${id}: h ${d.h}!=${g.h.toFixed(2)}`)
}
check(
  "building heights match (height drives price + walk-by reach)",
  geomDrift.length === 0,
  geomDrift.length ? `${geomDrift.length} differ, e.g. ${geomDrift.slice(0, 4).join("; ")}` : "",
)

console.log(
  `\nGenerator: ${genSlots.size} slots, ${genB.size} buildings.  DB: ${dbSlots.size} slots, ${dbB.size} buildings.`,
)
console.log(failures === 0 ? "\nCity parity OK: DB matches the rendered world." : `\n${failures} parity check(s) FAILED.`)
await pool.end()
process.exit(failures === 0 ? 0 : 1)
