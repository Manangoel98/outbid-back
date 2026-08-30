/**
 * Wipe all user/payment data for a pristine public launch.
 * Keeps city layout tables (slots, buildings) — run `npm run seed` after this to
 * refresh layout from generateCity() and ensure holdings rows exist.
 */
import "dotenv/config"
import { pool } from "../src/lib/db.js"

async function main() {
  console.log("Resetting Outbid City DB to unclaimed state…")

  const { rowCount: orders } = await pool.query(`delete from orders`)
  console.log(`  deleted ${orders ?? 0} orders`)

  const { rowCount: holdings } = await pool.query(
    `update holdings set
       company_id = null,
       standing_bid_cents = 0,
       paid_total_cents = 0,
       claimed_at = null,
       last_raise_at = null,
       clicks = 0,
       impressions = 0,
       version = 0`,
  )
  console.log(`  reset ${holdings ?? 0} holdings to unclaimed`)

  const { rowCount: buildings } = await pool.query(
    `update buildings set
       office_owner_id = null,
       office_name = null,
       purchased_at = null,
       price_cents = null`,
  )
  console.log(`  reset ${buildings ?? 0} buildings to unclaimed`)

  const { rowCount: companies } = await pool.query(`delete from companies`)
  console.log(`  deleted ${companies ?? 0} companies`)

  const { rowCount: users } = await pool.query(`delete from users`)
  console.log(`  deleted ${users ?? 0} users`)

  const check = await pool.query<{
    orders: string
    claimed_holdings: string
    claimed_buildings: string
    companies: string
  }>(`
    select
      (select count(*)::text from orders) as orders,
      (select count(*)::text from holdings where company_id is not null) as claimed_holdings,
      (select count(*)::text from buildings where office_owner_id is not null) as claimed_buildings,
      (select count(*)::text from companies) as companies
  `)
  const r = check.rows[0]!
  console.log("\nVerification:")
  console.log(`  orders=${r.orders} claimed_holdings=${r.claimed_holdings} claimed_buildings=${r.claimed_buildings} companies=${r.companies}`)
  if (r.orders !== "0" || r.claimed_holdings !== "0" || r.claimed_buildings !== "0" || r.companies !== "0") {
    throw new Error("Reset incomplete — counts should all be 0")
  }
  console.log("\nDone. Run: npm run seed")
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err)
    return pool.end().finally(() => process.exit(1))
  })
