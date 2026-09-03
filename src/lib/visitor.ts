import { createHash } from "node:crypto"
import { randomBytes } from "node:crypto"
import type { FastifyRequest } from "fastify"
import { env } from "../env.js"

/** Server-derived visitor identity for analytics dedup.
 *
 *  THE CORE RULE: the dedup key is derived entirely from data the client cannot choose.
 *
 *  The previous implementation keyed dedup on a `visitorId` sent in the request body. That is
 *  attacker-chosen, so inflating any placement's numbers was a loop with a fresh random id each
 *  time — no limit, no detection. Since these counts are published as a pricing signal (a buyer
 *  decides what a billboard is worth from its walk-by and visit numbers), a forgeable counter is
 *  worse than no counter.
 *
 *  What we use instead: sha256(rotating salt + client IP + user agent).
 *
 *  - The IP comes from Fastify's `req.ip`, which is only trustworthy because the server sets
 *    `trustProxy: 1` (see server.ts). With `trustProxy: true` the leftmost X-Forwarded-For entry
 *    wins and that IS client-supplied, which would hand the attacker the key material back.
 *  - The salt rotates daily so the table cannot be used to track a person across days, and so a
 *    leaked hash has a bounded useful life.
 *  - The raw IP is never stored — only the hash. Nothing here needs to be reversible.
 *
 *  ACCEPTED TRADEOFF: this UNDER-counts. Everyone behind one office NAT, one carrier gateway or
 *  one VPN exit collapses into a single visitor. That is the right direction to be wrong in for a
 *  number people spend money against: under-counting understates a placement's value, whereas
 *  over-counting means selling on numbers that aren't real. */

// A random per-process fallback so a misconfigured deploy fails closed (dedup still works within
// the process) rather than silently sharing a predictable, guessable salt across the internet.
const FALLBACK_SALT = randomBytes(32).toString("hex")

function saltFor(now: Date) {
  const base = env.analyticsSalt || FALLBACK_SALT
  // Daily rotation: same salt for every request on a given UTC day.
  const day = now.toISOString().slice(0, 10)
  return `${base}:${day}`
}

/** Stable hash for this requester. Same visitor + same day => same hash. */
export function visitorHash(req: FastifyRequest, now = new Date()) {
  const ip = req.ip || "0.0.0.0"
  const ua = req.headers["user-agent"] ?? ""
  return createHash("sha256").update(`${saltFor(now)}|${ip}|${ua}`).digest("hex")
}

/** Start of the dedup window containing `now`.
 *
 *  Floored to a fixed grid rather than measured from the last event. A sliding window would need
 *  a "last seen" timestamp per visitor+placement — exactly the mutable state whose loss on
 *  restart caused the original over-counting. A floored bucket is computable from the clock
 *  alone, so any instance derives the same value with no shared state.
 *
 *  The cost is boundary behaviour: a visitor passing at 10:59 and 11:01 counts twice with hourly
 *  buckets. That is acceptable — it slightly over-counts a genuine repeat visitor, while the
 *  thing we actually care about (one visitor generating thousands of counts) is fully blocked. */
export function bucketStart(windowMs: number, now = new Date()) {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

// A pass is a walk-by: the player was physically near the surface. Deduped hourly so walking the
// same street repeatedly in one session does not manufacture impressions.
export const PASS_WINDOW_MS = 60 * 60 * 1000
// A visit is a click through to the advertiser. Rarer and more valuable, so a longer window: one
// person cannot pad a placement's CTR by repeatedly clicking the same link.
export const VISIT_WINDOW_MS = 6 * 60 * 60 * 1000

/** Reject obvious non-humans.
 *
 *  Analytics must not count crawlers. This matters more than usual here because the SEO edge
 *  functions publish these numbers to crawlers, so a crawler-inflated count would feed itself.
 *  This is a cheap filter, not a security boundary — a determined script can set any UA. Real
 *  protection is the visitor hash plus the per-batch cap. */
const BOT_UA =
  /bot|crawler|spider|headless|puppeteer|playwright|selenium|phantom|curl\/|wget|python-requests|axios|okhttp|java\/|go-http|scrapy|lighthouse|gptbot|claudebot|perplexity|ccbot|bytespider|applebot|duckduckbot|yandex|baiduspider|facebookexternalhit|slackbot|discordbot|embedly|preview/i

export function isBotRequest(req: FastifyRequest) {
  const ua = req.headers["user-agent"] ?? ""
  // No UA at all is not a browser. Every real browser sends one.
  if (!ua.trim()) return true
  return BOT_UA.test(ua)
}

/** Require the request to come from one of our own origins.
 *
 *  Analytics endpoints are POSTs a browser only makes from our pages, so an Origin outside the
 *  allow-list means it is not real gameplay. CORS already blocks a *browser* from reading the
 *  response cross-origin, but it does not stop a direct scripted POST from writing — so this is
 *  checked server-side rather than relying on the CORS plugin. */
export function hasAllowedOrigin(req: FastifyRequest) {
  const origin = req.headers.origin
  // Same-origin/non-browser callers may omit Origin entirely; those are rejected because real
  // in-game analytics always arrive from the site with an Origin header present.
  if (!origin) return false
  return env.corsOrigins.some((allowed) => allowed === origin || allowed === "*")
}
