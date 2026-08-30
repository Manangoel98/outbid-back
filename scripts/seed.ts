import "dotenv/config"
import { Pool } from "pg"
import { env } from "../src/env.js"
import { poolSslOption } from "../src/lib/db.js"

/**
 * Seeds `slots` and `buildings` from the exact same generateCity() the client uses,
 * so slot ids (e.g. "taxi-3", "needle-crown") always match between client and server —
 * see BACKEND_PLAN.md §1. Falls back to a tiny synthetic city if the frontend module
 * can't be loaded standalone (e.g. this repo has been split into separate deploys).
 */
async function loadCity() {
  try {
    const modPath: string = "../../frontend/src/city/generateCity.ts"
    const mod = (await import(modPath)) as { generateCity: () => any }
    return mod.generateCity()
  } catch (err) {
    console.warn("Could not import ../../frontend/src/city/generateCity.ts directly, using fallback seed.", err)
    return null
  }
}

async function main() {
  const pool = new Pool({ connectionString: env.databaseUrl, ssl: poolSslOption() })
  const city = await loadCity()

  if (!city) {
    console.log("Seeding a minimal fallback city (3 demo slots) so the API has something to serve.")
    await pool.query(
      `insert into slots (slot_id, kind, tier, floor_cents, district, name, w, h, meta)
       values
        ('demo-billboard-1', 'billboard', 2, $1, 'cbd', 'Demo Billboard', 12, 6, '{}'::jsonb),
        ('demo-kiosk-1', 'kiosk', 4, $1, 'midtown', 'Demo Kiosk', 2, 1, '{}'::jsonb),
        ('demo-facade-1', 'facade', 5, $1, 'residential', 'Demo Shopfront', 4, 2, '{}'::jsonb)
       on conflict (slot_id) do nothing`,
      [env.floorCents],
    )
  } else {
    console.log(`Seeding ${city.slots.length} slots and ${city.buildings.length} buildings from generateCity()...`)
    for (const s of city.slots) {
      await pool.query(
        `insert into slots (slot_id, kind, tier, floor_cents, district, name, w, h, meta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (slot_id) do update set kind = excluded.kind, tier = excluded.tier, district = excluded.district,
           name = excluded.name, w = excluded.w, h = excluded.h, meta = excluded.meta`,
        [
          s.id,
          s.kind,
          s.tier,
          env.floorCents,
          s.district,
          s.name,
          s.w,
          s.h,
          JSON.stringify({ x: s.x, y: s.y, z: s.z, rotY: s.rotY, taxiIndex: s.taxiIndex, videoCh: s.videoCh }),
        ],
      )
    }
    for (const b of city.buildings) {
      await pool.query(
        `insert into buildings (building_id, x, z, w, d, h, district, floors)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (building_id) do update set x = excluded.x, z = excluded.z, w = excluded.w, d = excluded.d, h = excluded.h`,
        [b.id, b.x, b.z, b.w, b.d, b.h, b.district, Math.max(1, Math.round(b.h / 4))],
      )
    }
  }

  await pool.query(
    `insert into holdings (slot_id)
     select slot_id from slots
     on conflict (slot_id) do nothing`,
  )

  // Taxi/plane/boat/train are no longer sellable (cosmetic-only in the 3D city — see
  // frontend city.vehicleBanners). Prune any pre-existing rows for them so the sellable
  // inventory served by /api/v1/city and /api/v1/holdings matches exactly what's for sale.
  // Safe: verified 0 claimed holdings of these kinds before this change shipped.
  const { rowCount: prunedHoldings } = await pool.query(
    `delete from holdings where slot_id in (select slot_id from slots where kind in ('taxi','plane','boat','train'))`,
  )
  const { rowCount: prunedSlots } = await pool.query(`delete from slots where kind in ('taxi','plane','boat','train')`)
  if (prunedSlots) console.log(`Pruned ${prunedSlots} non-sellable vehicle slot(s) and ${prunedHoldings} holding(s).`)

  // General staleness cleanup for future city redesigns (new vehicles/buildings added,
  // old ones renumbered/removed in generateCity.ts): any slot/building id that no longer
  // exists in the current city AND has never been paid for is safe to drop. Anything with
  // a real claimed holding or a purchased office is left untouched no matter what —
  // append-only in practice, never destroy a paid purchase.
  if (city) {
    const currentSlotIds: string[] = city.slots.map((s: { id: string }) => s.id)
    const { rowCount: staleSlots } = await pool.query(
      `delete from slots s
       where s.slot_id <> all($1::text[])
         and not exists (select 1 from holdings h where h.slot_id = s.slot_id and h.company_id is not null)`,
      [currentSlotIds],
    )
    if (staleSlots) console.log(`Pruned ${staleSlots} stale unclaimed slot(s) no longer in generateCity().`)

    const currentBuildingIds: number[] = city.buildings.map((b: { id: number }) => b.id)
    const { rowCount: staleBuildings } = await pool.query(
      `delete from buildings where building_id <> all($1::int[]) and office_owner_id is null`,
      [currentBuildingIds],
    )
    if (staleBuildings) console.log(`Pruned ${staleBuildings} stale unclaimed building(s) no longer in generateCity().`)
  }

  console.log("Seed complete.")
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
