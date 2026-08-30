import "dotenv/config"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Pool } from "pg"
import { env } from "../src/env.js"
import { poolSslOption } from "../src/lib/db.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const pool = new Pool({ connectionString: env.databaseUrl, ssl: poolSslOption() })
  const sql = readFileSync(join(__dirname, "../src/schema.sql"), "utf8")
  console.log("Applying backend/src/schema.sql ...")
  await pool.query(sql)
  console.log("Schema applied.")
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
