import type { FastifyInstance } from "fastify"
import { pool } from "../lib/db.js"
import { publish } from "../lib/bus.js"

// In-memory rate limiting: key = "visitorId:slotId", value = timestamp of last accepted event.
// At most 1 impression per visitorId+slotId per 30 min, 1 click per 10 min.
const impRateMap = new Map<string, number>()
const clickRateMap = new Map<string, number>()
const IMP_WINDOW_MS = 30 * 60 * 1000
const CLICK_WINDOW_MS = 10 * 60 * 1000

export async function cityRoutes(app: FastifyInstance) {
  // Static layout — cacheable, only changes when city_version bumps.
  app.get("/api/v1/city", async (_req, reply) => {
    const [slots, buildings] = await Promise.all([
      pool.query(`select slot_id, kind, tier, floor_cents, district, name, w, h, meta from slots order by slot_id`),
      pool.query(`select building_id, x, z, w, d, h, district, floors from buildings order by building_id`),
    ])
    reply.header("cache-control", "public, max-age=300")
    return { slots: slots.rows, buildings: buildings.rows }
  })

  // Live occupancy snapshot — company, standing bid, clicks — for every slot.
  app.get("/api/v1/holdings", async () => {
    const { rows } = await pool.query(
      `select h.slot_id, h.holding_uid, h.company_id, h.standing_bid_cents, h.paid_total_cents,
              h.claimed_at, h.last_raise_at, h.clicks, h.impressions,
              c.name as company_name, c.url as company_url, c.tagline, c.logo_url, c.primary_color, c.ink_color
       from holdings h
       left join companies c on c.company_id = h.company_id`,
    )
    return { holdings: rows }
  })

  // Live building-ownership snapshot — separate from /api/v1/city (which is cached 5min
  // as pure static layout). Ownership changes in real time via Stripe, so it needs its own
  // uncached endpoint, exactly mirroring how /api/v1/holdings works for slots. Without this,
  // the frontend has no way to learn who owns which building except by having been connected
  // to the WebSocket at the exact instant a purchase happened.
  app.get("/api/v1/building-owners", async () => {
    const { rows } = await pool.query(
      `select b.building_id, b.office_owner_id, b.office_name, b.purchased_at, b.price_cents,
              c.name as company_name, c.url as company_url, c.tagline, c.logo_url, c.primary_color, c.ink_color
       from buildings b
       join companies c on c.company_id = b.office_owner_id
       where b.office_owner_id is not null`,
    )
    return { buildings: rows }
  })

  app.get<{ Params: { slotId: string } }>("/api/v1/holdings/:slotId", async (req, reply) => {
    const { rows } = await pool.query(
      `select h.*, c.name as company_name, c.url as company_url from holdings h
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
  })

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
    if (!slotId || !visitorId) return reply.code(400).send({ error: "missing_fields" })
    const key = `${visitorId}:${slotId}`
    const now = Date.now()
    const last = impRateMap.get(key) ?? 0
    if (now - last < IMP_WINDOW_MS) return { ok: false, reason: "rate_limited" }
    impRateMap.set(key, now)
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
    if (!slotId || !visitorId) return reply.code(400).send({ error: "missing_fields" })
    const key = `${visitorId}:${slotId}`
    const now = Date.now()
    const last = clickRateMap.get(key) ?? 0
    if (now - last < CLICK_WINDOW_MS) return { ok: false, reason: "rate_limited" }
    clickRateMap.set(key, now)
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
