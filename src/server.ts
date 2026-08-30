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

async function main() {
  const app = Fastify({ logger: true, bodyLimit: env.bodyLimitBytes })

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
    const message = error instanceof Error ? error.message : "Internal Server Error"
    app.log.error(error)
    return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message })
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

  await app.register(cityRoutes)
  await app.register(checkoutRoutes)
  await app.register(webhookRoutes)
  await app.register(wsRoutes)

  app.get("/healthz", async () => ({ ok: true }))

  await app.listen({ port: env.port, host: "0.0.0.0" })
  app.log.info(`Outbid City API listening on :${env.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
