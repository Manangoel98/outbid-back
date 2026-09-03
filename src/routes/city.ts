import type { FastifyInstance } from "fastify"
import { pool } from "../lib/db.js"
import { publish } from "../lib/bus.js"
import { env } from "../env.js"

// In-memory rate limiting: key = "visitorId:slotId", value = timestamp of last accepted event.
// At most 1 impression per visitorId+slotId per 30 min, 1 click per 10 min.
const impRateMap = new Map<string, number>()
const clickRateMap = new Map<string, number>()
const IMP_WINDOW_MS = 30 * 60 * 1000
const CLICK_WINDOW_MS = 10 * 60 * 1000

// Hard caps so a hostile client can't (a) blow up the in-memory maps with unbounded unique
// keys, or (b) send pathologically large ids. slotId/visitorId are short by design.
const MAX_ID_LEN = 128
const MAX_RATE_MAP_ENTRIES = 50_000

function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN
}

// Evict oldest entries if a map grows past the cap (crude but bounded; these maps are a
// best-effort dedupe, not a source of truth).
function capMap(m: Map<string, number>) {
  if (m.size <= MAX_RATE_MAP_ENTRIES) return
  const drop = m.size - MAX_RATE_MAP_ENTRIES
  let i = 0
  for (const k of m.keys()) {
    m.delete(k)
    if (++i >= drop) break
  }
}

export async function cityRoutes(app: FastifyInstance) {
  // Read-only snapshot routes get a far larger budget than the strict global (write-oriented)
  // limit. See env.readRateLimitMax for why: the SEO edge functions and search/AI crawlers all
  // arrive from shared egress IPs and spend 2-3 reads per rendered page, so the write budget
  // throttled legitimate crawling. These routes are cached and cheap.
  const readRateLimit = {
    max: env.readRateLimitMax,
    timeWindow: env.readRateLimitWindowMs,
  }

  // Static layout — cacheable, only changes when city_version bumps.
  // is_free ships here (not on the live endpoints) because it is immutable layout data:
  // this is what lets the client mark *unclaimed* free spots, which is the whole point.
  app.get("/api/v1/city", { config: { rateLimit: readRateLimit } }, async (_req, reply) => {
    const [slots, buildings] = await Promise.all([
      pool.query(`select slot_id, kind, tier, floor_cents, district, name, w, h, meta, is_free from slots order by slot_id`),
      pool.query(`select building_id, x, z, w, d, h, district, floors, is_free from buildings order by building_id`),
    ])
    reply.header("cache-control", "public, max-age=300")
    return { slots: slots.rows, buildings: buildings.rows }
  })

  // Live occupancy snapshot — company, standing bid, clicks — for every slot.
  // is_free is joined from slots (the layout row), never stored on holdings.
  app.get("/api/v1/holdings", { config: { rateLimit: readRateLimit } }, async () => {
    const { rows } = await pool.query(
      `select h.slot_id, h.holding_uid, h.company_id, h.standing_bid_cents, h.paid_total_cents,
              h.claimed_at, h.last_raise_at, h.clicks, h.impressions, s.is_free,
              c.name as company_name, c.url as company_url, c.tagline, c.logo_url, c.primary_color, c.ink_color
       from holdings h
       join slots s on s.slot_id = h.slot_id
       left join companies c on c.company_id = h.company_id`,
    )
    return { holdings: rows }
  })

  // Live building-ownership snapshot — separate from /api/v1/city (which is cached 5min
  // as pure static layout). Ownership changes in real time via Stripe, so it needs its own
  // uncached endpoint, exactly mirroring how /api/v1/holdings works for slots. Without this,
  // the frontend has no way to learn who owns which building except by having been connected
  // to the WebSocket at the exact instant a purchase happened.
  //
  // freeBuildingIds is returned alongside: unlike slots (which have a holdings row each, so
  // /api/v1/holdings covers unclaimed ones too) this endpoint only lists *owned* buildings,
  // so the free-tier flag for unclaimed buildings has to come through explicitly.
  app.get("/api/v1/building-owners", { config: { rateLimit: readRateLimit } }, async () => {
    const [owned, free] = await Promise.all([
      pool.query(
        `select b.building_id, b.office_owner_id, b.office_name, b.purchased_at, b.price_cents, b.is_free,
                c.name as company_name, c.url as company_url, c.tagline, c.logo_url, c.primary_color, c.ink_color
         from buildings b
         join companies c on c.company_id = b.office_owner_id
         where b.office_owner_id is not null`,
      ),
      pool.query(`select building_id from buildings where is_free`),
    ])
    return {
      buildings: owned.rows,
      freeBuildingIds: free.rows.map((r) => r.building_id as number),
    }
  })

  // Live graveyard snapshot — every plot (claimed or not) with its default/owner label,
  // story and bid. Uncached and real-time like /api/v1/building-owners: ownership changes
  // via Stripe. The default dead-startup label lives on the plot row (seeded), so this one
  // query serves both the classic tombstones and any user-buried startup uniformly.
  app.get("/api/v1/graveyard", { config: { rateLimit: readRateLimit } }, async () => {
    const { rows } = await pool.query(
      `select g.plot_id, g.company_id, g.name, g.story, g.domain, g.born, g.died,
              g.standing_bid_cents, g.paid_total_cents, g.claimed_at, g.last_raise_at, g.is_free,
              c.name as company_name, c.url as company_url, c.tagline, c.logo_url, c.primary_color, c.ink_color
       from graveyard_plots g
       left join companies c on c.company_id = g.company_id
       order by g.plot_id`,
    )
    return { plots: rows }
  })

  app.get<{ Params: { slotId: string } }>(
    "/api/v1/holdings/:slotId",
    { config: { rateLimit: readRateLimit } },
    async (req, reply) => {
      const { rows } = await pool.query(
        `select h.*, c.name as company_name, c.url as company_url, c.tagline,
                c.logo_url, c.primary_color, c.ink_color
       from holdings h
       left join companies c on c.company_id = h.company_id
       where h.slot_id = $1`,
        [req.params.slotId],
      )
      if (!rows[0]) return reply.code(404).send({ error: "not_found" })
      const { rows: history } = await pool.query(
        `select order_id, total_cents, price_per_unit_cents, quantity, kind, created_at, status
       from orders where $1 = any(slot_ids) order by created_at desc limit 20`,
        [req.params.slotId],
      )
      return { holding: rows[0], history }
    },
  )

  app.get<{ Params: { id: string } }>("/api/v1/companies/:id", async (req, reply) => {
    const { rows } = await pool.query(`select company_id, name, url, tagline, logo_url, primary_color, ink_color from companies where company_id = $1`, [
      req.params.id,
    ])
    if (!rows[0]) return reply.code(404).send({ error: "not_found" })
    return rows[0]
  })

  // Analytics: record an impression (walk-by) for a slot.
  // Rate-limited: once per visitorId+slotId per 30 min (in-memory, ephemeral across restarts).
  app.post<{ Body: { slotId: string; visitorId: string } }>("/api/v1/analytics/impression", async (req, reply) => {
    const { slotId, visitorId } = req.body ?? {}
    if (!validId(slotId) || !validId(visitorId)) return reply.code(400).send({ error: "missing_fields" })
    const key = `${visitorId}:${slotId}`
    const now = Date.now()
    const last = impRateMap.get(key) ?? 0
    if (now - last < IMP_WINDOW_MS) return { ok: false, reason: "rate_limited" }
    impRateMap.set(key, now)
    capMap(impRateMap)
    const { rows } = await pool.query(
      `update holdings set impressions = impressions + 1 where slot_id = $1 returning slot_id, impressions, clicks`,
      [slotId],
    )
    if (!rows[0]) return reply.code(404).send({ error: "not_found" })
    publish({
      type: "holding",
      slotId: rows[0].slot_id,
      companyId: null,
      standingBidCents: -1,
      claimedAt: null,
      company: null,
      impressions: rows[0].impressions,
      clicks: rows[0].clicks,
    } as Parameters<typeof publish>[0])
    return { ok: true }
  })

  // Analytics: record a click (visit) for a slot.
  // Rate-limited: once per visitorId+slotId per 10 min (in-memory, ephemeral across restarts).
  app.post<{ Body: { slotId: string; visitorId: string } }>("/api/v1/analytics/click", async (req, reply) => {
    const { slotId, visitorId } = req.body ?? {}
    if (!validId(slotId) || !validId(visitorId)) return reply.code(400).send({ error: "missing_fields" })
    const key = `${visitorId}:${slotId}`
    const now = Date.now()
    const last = clickRateMap.get(key) ?? 0
    if (now - last < CLICK_WINDOW_MS) return { ok: false, reason: "rate_limited" }
    clickRateMap.set(key, now)
    capMap(clickRateMap)
    const { rows } = await pool.query(
      `update holdings set clicks = clicks + 1 where slot_id = $1 returning slot_id, impressions, clicks`,
      [slotId],
    )
    if (!rows[0]) return reply.code(404).send({ error: "not_found" })
    publish({
      type: "holding",
      slotId: rows[0].slot_id,
      companyId: null,
      standingBidCents: -1,
      claimedAt: null,
      company: null,
      impressions: rows[0].impressions,
      clicks: rows[0].clicks,
    } as Parameters<typeof publish>[0])
    return { ok: true }
  })
}
