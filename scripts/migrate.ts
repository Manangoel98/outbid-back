import "dotenv/config"
import { readFileSync, readdirSync } from "node:fs"
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

  // Then apply every numbered migration in order. All migrations are written to be
  // idempotent (IF NOT EXISTS / deterministic updates), so re-running is always safe.
  const dir = join(__dirname, "../src/migrations")
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  for (const file of files) {
    console.log(`Applying migrations/${file} ...`)
    await pool.query(readFileSync(join(dir, file), "utf8"))
  }
  console.log(`${files.length} migration(s) applied.`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
