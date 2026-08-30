import "dotenv/config"
import { Pool } from "pg"
import { env } from "../src/env.js"
import { poolSslOption } from "../src/lib/db.js"

async function main() {
  const pool = new Pool({ connectionString: env.databaseUrl, ssl: poolSslOption() })

  const counts = await pool.query(
    `select s.kind, count(*)::int as total,
            count(*) filter (where h.company_id is not null)::int as claimed,
            count(*) filter (where h.standing_bid_cents > 0)::int as nonzero_bid
     from slots s join holdings h on h.slot_id = s.slot_id
     group by s.kind order by s.kind`,
  )
  console.log("\n=== Slot kinds (total / claimed / nonzero-bid) ===")
  for (const r of counts.rows) console.log(`${r.kind.padEnd(12)} total=${r.total}  claimed=${r.claimed}  nonzero_bid=${r.nonzero_bid}`)

  const totalSlots = await pool.query(`select count(*)::int as n from slots`)
  const totalHoldings = await pool.query(`select count(*)::int as n from holdings`)
  const totalBuildings = await pool.query(`select count(*)::int as n from buildings`)
  const claimedBuildings = await pool.query(`select count(*)::int as n from buildings where office_owner_id is not null`)
  const anyBidGtFloor = await pool.query(`select count(*)::int as n from holdings where standing_bid_cents <> 0`)
  const anyCompany = await pool.query(`select count(*)::int as n from holdings where company_id is not null`)
  const companiesCount = await pool.query(`select count(*)::int as n from companies`)
  const ordersCount = await pool.query(`select count(*)::int as n from orders`)

  console.log("\n=== Totals ===")
  console.log(`slots=${totalSlots.rows[0].n}  holdings=${totalHoldings.rows[0].n}  buildings=${totalBuildings.rows[0].n}`)
  console.log(`claimed buildings=${claimedBuildings.rows[0].n}`)
  console.log(`holdings with nonzero standing_bid_cents=${anyBidGtFloor.rows[0].n} (should be 0 on a fresh seed)`)
  console.log(`holdings with a company_id=${anyCompany.rows[0].n} (should be 0 on a fresh seed)`)
  console.log(`companies=${companiesCount.rows[0].n}  orders=${ordersCount.rows[0].n} (should both be 0 on a fresh seed)`)

  const vehicleKinds = await pool.query(`select kind, count(*)::int as n from slots where kind in ('taxi','plane','boat','train') group by kind order by kind`)
  console.log("\n=== Vehicle fleet sizes (should be empty — no longer sellable) ===")
  for (const r of vehicleKinds.rows) console.log(`${r.kind}: ${r.n}`)
  if (vehicleKinds.rows.length === 0) console.log("(none — correct)")

  const sampleBuildings = await pool.query(
    `select building_id, w, d, h, price_cents from buildings order by (w*d) desc limit 5`,
  )
  console.log("\n=== Sample building prices (area-based, largest first) ===")
  for (const b of sampleBuildings.rows) {
    const expected = Math.max(3500, Math.round(b.w * b.d * 16 + b.h * 90))
    console.log(`#${b.building_id} w=${b.w.toFixed(1)} d=${b.d.toFixed(1)} h=${b.h.toFixed(1)} -> floor=$${(expected / 100).toFixed(2)} (price_cents=${b.price_cents ?? "null"})`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
