import { Pool } from "pg"
import { env } from "../env.js"

// Supabase/Neon/Render-hosted Postgres all require TLS on their public endpoint. Detect
// non-localhost hosts and enable it automatically so local Docker Postgres (no TLS) and
// hosted Postgres (TLS required) both just work without extra config.
export function poolSslOption() {
  const isLocal = /localhost|127\.0\.0\.1/.test(env.databaseUrl)
  return isLocal ? undefined : ({ rejectUnauthorized: false } as const)
}

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: poolSslOption(),
})

export async function withTx<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
