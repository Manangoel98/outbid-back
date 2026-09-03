import type { FastifyInstance } from "fastify"
import type { PoolClient } from "pg"
import { pool } from "../lib/db.js"
import { publish } from "../lib/bus.js"
import { env } from "../env.js"
import { buildingStats, recordEvent, slotStats, type Placement } from "../lib/analytics.js"
import {
  bucketStart,
  hasAllowedOrigin,
  isBotRequest,
  PASS_WINDOW_MS,
  visitorHash,
  VISIT_WINDOW_MS,
} from "../lib/visitor.js"

// Hard caps so a hostile client can't send pathologically large ids. slotId/visitorId are short
// by design.
const MAX_ID_LEN = 128

function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN
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
    const [owned, free, traffic] = await Promise.all([
      pool.query(
        `select b.building_id, b.office_owner_id, b.office_name, b.purchased_at, b.price_cents, b.is_free,
                b.clicks, b.impressions,
                c.name as company_name, c.url as company_url, c.tagline, c.logo_url, c.primary_color, c.ink_color
         from buildings b
         join companies c on c.company_id = b.office_owner_id
         where b.office_owner_id is not null`,
      ),
      pool.query(`select building_id from buildings where is_free`),
      // Traffic for UNOWNED buildings too. Walk-bys accrue whether or not a building is claimed,
      // and "this tower already gets N walk-bys" is the strongest argument for buying it — but the
      // owned-buildings join above can't carry it, so it needs its own row set. Filtered to
      // buildings with actual traffic so the payload stays proportional to real activity rather
      // than to the size of the city.
      pool.query(
        `select building_id, clicks, impressions from buildings
         where office_owner_id is null and (impressions > 0 or clicks > 0)`,
      ),
    ])
    return {
      buildings: owned.rows,
      freeBuildingIds: free.rows.map((r) => r.building_id as number),
      traffic: traffic.rows,
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
      // Windowed stats ride along so the crawler-facing /holding/:id page and the in-game bid
      // panel both quote the same figures from the same source — no second round trip, no chance
      // of the public page and the game disagreeing about what a placement is worth.
      const stats = await slotStats(req.params.slotId)
      return { holding: rows[0], history, stats }
    },
  )

  app.get<{ Params: { id: string } }>("/api/v1/companies/:id", async (req, reply) => {
    const { rows } = await pool.query(`select company_id, name, url, tagline, logo_url, primary_color, ink_color from companies where company_id = $1`, [
      req.params.id,
    ])
    if (!rows[0]) return reply.code(404).send({ error: "not_found" })
    return rows[0]
  })

  // ---------------------------------------------------------------------------------------
  // Analytics
  //
  // Both endpoints derive the visitor identity server-side and let a unique index in Postgres
  // enforce dedup (see lib/visitor.ts and lib/analytics.ts). The client-supplied id is accepted
  // but only stored for diagnostics — it is never part of the dedup key, because it is
  // attacker-chosen and rotating it was previously enough to inflate any placement freely.
  // ---------------------------------------------------------------------------------------

  const analyticsRateLimit = {
    max: env.analyticsRateLimitMax,
    timeWindow: env.analyticsRateLimitWindowMs,
  }

  /** Shared guard: reject anything that is not a real browser on one of our own pages. */
  function analyticsAllowed(req: Parameters<typeof visitorHash>[0]) {
    if (isBotRequest(req)) return false
    if (!hasAllowedOrigin(req)) return false
    return true
  }

  // Record walk-bys in BATCHES. The player passes several surfaces at once, and the previous
  // one-POST-per-surface design fired up to 8 requests every 2 seconds — which, against a
  // shared rate limit, meant most walk-bys were silently 429'd rather than recorded. One
  // request per scan makes the limit non-binding and lets the server collapse duplicates
  // inside a payload before touching the database.
  app.post<{
    Body: { slots?: string[]; buildings?: number[]; visitorId?: string }
  }>("/api/v1/analytics/passes", { config: { rateLimit: analyticsRateLimit } }, async (req, reply) => {
    if (!analyticsAllowed(req)) return reply.code(204).send()

    const body = req.body ?? {}
    const rawSlots = Array.isArray(body.slots) ? body.slots : []
    const rawBuildings = Array.isArray(body.buildings) ? body.buildings : []

    // Dedupe within the request and hard-cap the batch, so one call can never fan out into an
    // unbounded number of upserts.
    const slotIds = [...new Set(rawSlots.filter(validId))].slice(0, env.analyticsMaxBatch)
    const buildingIds = [
      ...new Set(rawBuildings.filter((b) => Number.isInteger(b) && b >= 0)),
    ].slice(0, env.analyticsMaxBatch)

    if (!slotIds.length && !buildingIds.length) return { ok: true, counted: 0 }

    const hash = visitorHash(req)
    const bucket = bucketStart(PASS_WINDOW_MS)
    const clientId = validId(body.visitorId) ? body.visitorId! : null

    let counted = 0
    const client = await pool.connect()
    try {
      for (const slotId of slotIds) {
        const res = await recordPassSafely(client, { slotId }, hash, bucket, clientId)
        if (res) counted++
      }
      for (const buildingId of buildingIds) {
        const res = await recordPassSafely(client, { buildingId }, hash, bucket, clientId)
        if (res) counted++
      }
    } finally {
      client.release()
    }

    return { ok: true, counted }
  })

  /** Record one pass, skipping placements that no longer exist instead of failing the batch.
   *
   *  A batch is built from the client's cached city layout, so it can legitimately contain an id
   *  that has since been removed — which Postgres rejects with a foreign-key violation (23503).
   *  Letting that propagate would return 500 and discard every *valid* pass in the same batch,
   *  so a single stale id would silently wipe out real walk-by data for the surfaces around it.
   *  Each recordEvent runs as its own implicit transaction (no BEGIN here), so a failed insert
   *  does not poison the ones that follow.
   *
   *  Only 23503 is swallowed. Any other error still propagates, because a genuine database fault
   *  must not be quietly converted into "counted nothing". */
  async function recordPassSafely(
    client: PoolClient,
    placement: Placement,
    hash: string,
    bucket: Date,
    clientId: string | null,
  ) {
    try {
      const res = await recordEvent(client, placement, "pass", hash, bucket, clientId)
      return res.counted
    } catch (err) {
      if ((err as { code?: string }).code === "23503") {
        app.log.warn({ placement }, "analytics pass for unknown placement, skipped")
        return false
      }
      throw err
    }
  }

  // Record a visit (click-through to the advertiser). Handles buildings too — previously the
  // click handler only fired when a slotId was present, so every office tower reported zero
  // visits permanently despite being the most expensive placement in the game.
  app.post<{
    Body: { slotId?: string; buildingId?: number; visitorId?: string }
  }>("/api/v1/analytics/visit", { config: { rateLimit: analyticsRateLimit } }, async (req, reply) => {
    if (!analyticsAllowed(req)) return reply.code(204).send()

    const body = req.body ?? {}
    const hasSlot = validId(body.slotId)
    const hasBuilding = Number.isInteger(body.buildingId) && (body.buildingId as number) >= 0
    // Exactly one placement, matching the table's check constraint.
    if (hasSlot === hasBuilding) return reply.code(400).send({ error: "one_placement_required" })

    const hash = visitorHash(req)
    const bucket = bucketStart(VISIT_WINDOW_MS)
    const clientId = validId(body.visitorId) ? body.visitorId! : null
    const placement = hasSlot
      ? { slotId: body.slotId as string }
      : { buildingId: body.buildingId as number }

    const client = await pool.connect()
    let counted = false
    try {
      const res = await recordEvent(client, placement, "visit", hash, bucket, clientId)
      counted = res.counted
    } catch (err) {
      // A foreign-key violation means the placement id does not exist.
      if ((err as { code?: string }).code === "23503") {
        return reply.code(404).send({ error: "not_found" })
      }
      throw err
    } finally {
      client.release()
    }

    // Only broadcast when the count actually moved, so a deduped no-op does not churn every
    // connected client's UI.
    if (counted && hasSlot) {
      const { rows } = await pool.query(
        `select slot_id, impressions, clicks from holdings where slot_id = $1`,
        [body.slotId],
      )
      if (rows[0]) {
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
      }
    }

    return { ok: true, counted }
  })

  // Public per-placement stats: all-time, rolling 7 days, and CTR. These are the numbers shown
  // in the bid panel and on the crawler-facing holding/building pages, so they must come from
  // the same source of truth as everything else.
  app.get<{ Params: { slotId: string } }>(
    "/api/v1/analytics/slot/:slotId",
    { config: { rateLimit: readRateLimit } },
    async (req, reply) => {
      if (!validId(req.params.slotId)) return reply.code(400).send({ error: "bad_id" })
      return await slotStats(req.params.slotId)
    },
  )

  app.get<{ Params: { buildingId: string } }>(
    "/api/v1/analytics/building/:buildingId",
    { config: { rateLimit: readRateLimit } },
    async (req, reply) => {
      const id = Number(req.params.buildingId)
      if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "bad_id" })
      return await buildingStats(id)
    },
  )
}
