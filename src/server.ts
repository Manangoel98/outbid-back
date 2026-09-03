import Fastify from "fastify"
import cors from "@fastify/cors"
import helmet from "@fastify/helmet"
import rateLimit from "@fastify/rate-limit"
import websocket from "@fastify/websocket"
import { ZodError } from "zod"
import { env } from "./env.js"
import { cityRoutes } from "./routes/city.js"
import { checkoutRoutes } from "./routes/checkout.js"
import { webhookRoutes } from "./routes/webhook.js"
import { wsRoutes } from "./routes/ws.js"
import { statsRoutes } from "./routes/stats.js"
import { pruneOldEvents } from "./lib/analytics.js"

async function main() {
  // trustProxy — Cloud Run/Render terminate TLS and forward with X-Forwarded-For, so without this
  // every request's `req.ip` resolved to the platform's front-end proxy. That made ALL the rate
  // limits global instead of per-client: an 8/60s checkout limit meant only 8 checkouts per minute
  // could succeed worldwide, one script could lock every customer out of paying, and analytics
  // POSTs were being silently 429'd (which is why impression counts were near zero — not low
  // traffic, dropped writes).
  //
  // Deliberately NOT `true`. The platform *appends* to X-Forwarded-For rather than replacing it, so
  // `true` would trust the whole chain and take the leftmost entry — which is client-supplied.
  //
  // CRITICAL: trusting even one hop is only safe when a trusted proxy is actually in front.
  // Verified locally with no proxy present, `X-Forwarded-For: 9.9.9.1` becomes req.ip verbatim — so
  // a client could mint a fresh analytics visitor per request and bypass every per-IP rate limit,
  // checkout included. Hence this is gated on env.trustProxy instead of being unconditional: with
  // no proxy we use the real socket address, which cannot be forged. See SECURITY.md Threat 8/14.
  const app = Fastify({
    logger: true,
    bodyLimit: env.bodyLimitBytes,
    trustProxy: env.trustProxy ? (_address, hop) => hop === 0 : false,
  })

  if (!env.trustProxy) {
    app.log.warn(
      "trustProxy DISABLED: using the raw socket address for rate limiting and analytics identity. " +
        "Set TRUST_PROXY=1 only when a trusted reverse proxy (Cloud Run, Render, nginx) is in front.",
    )
  }

  await app.register(helmet, {
    // This is a JSON API with no HTML views, so CSP is irrelevant noise; the
    // rest of helmet's defaults (X-Content-Type-Options, X-Frame-Options,
    // Referrer-Policy, HSTS, etc.) still apply and cost nothing.
    contentSecurityPolicy: false,
  })
  await app.register(cors, { origin: env.corsOrigins })
  // Global default: generous enough for normal play, tight enough to blunt scripted abuse.
  // checkout/webhook routes set a stricter per-route override below (see Threat 8 in SECURITY.md).
  await app.register(rateLimit, {
    global: true,
    max: env.rateLimitMax,
    timeWindow: env.rateLimitWindowMs,
  })
  await app.register(websocket)

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", message: error.message })
    }
    // Respect the status a plugin already decided on. @fastify/rate-limit throws an Error
    // carrying statusCode 429; hardcoding 500 here turned every throttle into a fake server
    // error, so clients saw "Internal Server Error" and had nothing to back off on. Same for
    // 404/405 and anything else Fastify raises with a 4xx.
    const err = error as { statusCode?: number; name?: string; message?: string }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500
    if (status < 500) {
      return reply.code(status).send({
        statusCode: status,
        error: err.name && err.name !== "Error" ? err.name : "Request Failed",
        message: err.message ?? "Request failed",
      })
    }
    // Genuine server faults: log the detail, but don't echo internal messages (DB errors, SQL
    // fragments, stack-adjacent text) back to the client.
    app.log.error(error)
    return reply.code(500).send({ statusCode: 500, error: "Internal Server Error" })
  })

  // Stripe needs the exact raw request bytes to verify the webhook signature,
  // so this route is registered with its own content-type parser before the
  // default JSON body parser touches it.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(req as any).rawBody = body
    try {
      done(null, body.length ? JSON.parse(body.toString()) : {})
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // navigator.sendBeacon is the only transport that reliably completes after a tab closes, so the
  // frontend uses it for the final analytics flush of a session. It must send a CORS-safelisted
  // content type (text/plain) to avoid a preflight it cannot recover from — see the comment in
  // frontend/src/net/api.ts. The payload is still JSON, so parse it as such.
  //
  // Scoped narrowly: only bodies that actually look like a JSON object are accepted, and a parse
  // failure yields an empty body rather than a 400, because a beacon has no way to retry or even
  // observe an error.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : ""
    if (!text.startsWith("{")) return done(null, {})
    try {
      done(null, JSON.parse(text))
    } catch {
      done(null, {})
    }
  })

  await app.register(cityRoutes)
  await app.register(checkoutRoutes)
  await app.register(webhookRoutes)
  await app.register(wsRoutes)
  await app.register(statsRoutes)

  app.get("/healthz", async () => ({ ok: true }))

  // Retention for the raw analytics event log. ad_events grows with every counted walk-by, so
  // without pruning it would grow without bound; the permanent totals live in the counter columns
  // on holdings/buildings, so pruning only drops the ability to compute windows further back than
  // the retention period.
  //
  // Runs in-process on an interval rather than as an external cron: there is no scheduler in this
  // deployment, and a delete-by-timestamp on an indexed column is cheap enough that a dedicated
  // job would be more moving parts than the problem justifies. If multiple instances run, they
  // simply each try — the delete is idempotent, so a concurrent run is harmless.
  //
  // unref() so this timer never holds the process open during shutdown.
  const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
  const pruneTimer = setInterval(() => {
    void pruneOldEvents()
      .then((n) => {
        if (n > 0) app.log.info({ pruned: n }, "pruned expired ad_events")
      })
      // A failed prune must never take the API down — it is housekeeping, not request-path work.
      .catch((err) => app.log.error({ err }, "ad_events prune failed"))
  }, PRUNE_INTERVAL_MS)
  pruneTimer.unref()

  await app.listen({ port: env.port, host: "0.0.0.0" })
  app.log.info(`Outbid City API listening on :${env.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
