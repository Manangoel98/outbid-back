import "dotenv/config"

function required(name: string, fallback?: string) {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`Missing required env var ${name}`)
  return v
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required("DATABASE_URL"),
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  stripeSuccessUrl: process.env.STRIPE_SUCCESS_URL ?? "http://localhost:5173/checkout/success?session_id={CHECKOUT_SESSION_ID}",
  stripeCancelUrl: process.env.STRIPE_CANCEL_URL ?? "http://localhost:5173/checkout/cancel",
  floorCents: Number(process.env.FLOOR_CENTS ?? 100),
  takeDeltaCents: Number(process.env.TAKE_DELTA_CENTS ?? 100),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 20),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  // Read-only snapshot routes need their own, much larger budget. They are cheap and cached,
  // but they are consumed by the SEO edge functions (2-3 calls per rendered page) and by
  // search/AI crawlers — all of which arrive from a small set of shared egress IPs. Under the
  // write-route budget of 20/60s a crawler working through the sitemap throttles itself almost
  // immediately, and a throttled read turns into a 503 for a crawler. Writes keep the strict
  // limit; see SECURITY.md Threat 8.
  readRateLimitMax: Number(process.env.READ_RATE_LIMIT_MAX ?? 300),
  readRateLimitWindowMs: Number(process.env.READ_RATE_LIMIT_WINDOW_MS ?? 60_000),
  // Analytics writes are high-frequency by nature: a player walking through the city passes
  // many surfaces, and passes are reported in batches every couple of seconds. They are cheap
  // (one upsert per new event) and must not share a budget with checkout, or normal play would
  // throttle purchases. Abuse is bounded by the server-side visitor hash + per-batch cap
  // rather than by a tight request limit, since a tight limit only loses real data.
  analyticsRateLimitMax: Number(process.env.ANALYTICS_RATE_LIMIT_MAX ?? 120),
  analyticsRateLimitWindowMs: Number(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS ?? 60_000),
  // Max placements accepted in a single /analytics/passes batch. The client reports at most
  // ~8 nearby surfaces per scan; this is a hard server-side bound so a hostile client cannot
  // send a 10k-element array and turn one request into 10k upserts.
  analyticsMaxBatch: Number(process.env.ANALYTICS_MAX_BATCH ?? 24),
  // Rotating salt for the visitor hash. Set ANALYTICS_SALT in production: without it the salt
  // is random per process, so dedup would reset on every cold start and multiple Cloud Run
  // instances would each count the same visitor once.
  analyticsSalt: process.env.ANALYTICS_SALT ?? "",
  bodyLimitBytes: Number(process.env.BODY_LIMIT_BYTES ?? 256 * 1024),
  // Stripe's own ceiling for USD Checkout is $999,999.99; we cap well below that as a
  // sanity bound so a stray extra zero can't create a runaway charge. Real bids in this
  // game are expected to stay in the $1–$10,000 range.
  maxBidCents: Number(process.env.MAX_BID_CENTS ?? 100_000_00),
}
