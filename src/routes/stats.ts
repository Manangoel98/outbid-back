import type { FastifyInstance } from "fastify"

// PostHog Query API credentials come from the environment (set on Cloud Run).
// Read-only, project-scoped personal key — never commit it to source.
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.posthog.com"
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID || ""
const POSTHOG_PERSONAL_KEY = process.env.POSTHOG_PERSONAL_API_KEY || ""

// HogQL: total pageviews + distinct sessions.
// NOTE: an unbounded all-time count() over the events table times out (504) on
// PostHog Cloud and silently falls back to zeros. Bounding by a time window keeps
// the query fast and reliable. STATS_WINDOW_DAYS is configurable via env.
const STATS_WINDOW_DAYS = Number(process.env.POSTHOG_STATS_WINDOW_DAYS || 365)
const STATS_QUERY =
  "SELECT count() AS pageviews, count(DISTINCT $session_id) AS sessions " +
  `FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL ${STATS_WINDOW_DAYS} DAY`

// Cache the PostHog result so we never hammer their API (and stay well under rate limits).
let cache: { pageviews: number; sessions: number; at: number } | null = null
const CACHE_TTL_MS = 60_000

async function fetchPostHogStats(): Promise<{ pageviews: number; sessions: number }> {
  if (!POSTHOG_PERSONAL_KEY || !POSTHOG_PROJECT_ID) {
    // Not configured — behave as "no data" instead of erroring.
    return { pageviews: 0, sessions: 0 }
  }
  // Guard against slow PostHog responses so the topbar never hangs.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${POSTHOG_PERSONAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: STATS_QUERY } }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`posthog_${res.status}`)
    const data = (await res.json()) as { results?: [number, number][] }
    const row = data.results?.[0]
    return { pageviews: Number(row?.[0] ?? 0), sessions: Number(row?.[1] ?? 0) }
  } finally {
    clearTimeout(timer)
  }
}

export async function statsRoutes(app: FastifyInstance) {
  // Public read-only endpoint — returns aggregate site traffic from PostHog.
  app.get("/api/v1/stats/pageviews", async (_req, reply) => {
    const now = Date.now()
    if (cache && now - cache.at < CACHE_TTL_MS) {
      reply.header("cache-control", "public, max-age=60")
      return { pageviews: cache.pageviews, sessions: cache.sessions }
    }
    try {
      const stats = await fetchPostHogStats()
      cache = { ...stats, at: now }
      reply.header("cache-control", "public, max-age=60")
      return stats
    } catch {
      // On failure, serve stale cache if we have it, else zeros — never 500 the topbar.
      if (cache) return { pageviews: cache.pageviews, sessions: cache.sessions }
      return { pageviews: 0, sessions: 0 }
    }
  })
}
