import type { PoolClient } from "pg"
import { pool } from "./db.js"

/** Recording and reading real ad analytics.
 *
 *  Every counted event is inserted into ad_events first; the denormalised counter on
 *  holdings/buildings is incremented ONLY if that insert actually created a row. The two happen
 *  in a single statement (a CTE), which is what makes the count exactly equal to the number of
 *  unique events — no application-side check-then-act, so two concurrent requests from the same
 *  visitor cannot both pass a "have we seen this?" test and both increment. */

export type Placement = { slotId: string } | { buildingId: number }

export type RecordResult = { counted: boolean }

/** Insert one event and bump the matching counter iff the event was new.
 *
 *  `on conflict do nothing` + `returning` is the whole mechanism: on a duplicate the CTE yields
 *  zero rows, so the update's `where exists` fails and no counter moves. This is why dedup
 *  survives restarts and is correct across multiple instances — the guarantee lives in the
 *  unique index, not in process memory. */
export async function recordEvent(
  client: PoolClient,
  placement: Placement,
  kind: "pass" | "visit",
  visitorHash: string,
  bucketStart: Date,
  clientId: string | null,
): Promise<RecordResult> {
  const column = kind === "pass" ? "impressions" : "clicks"

  if ("slotId" in placement) {
    const { rows } = await client.query(
      `with ins as (
         insert into ad_events (slot_id, event_kind, visitor_hash, bucket_start, client_id)
         values ($1, $2, $3, $4, $5)
         on conflict do nothing
         returning event_id
       ), bump as (
         update holdings set ${column} = ${column} + 1
         where slot_id = $1 and exists (select 1 from ins)
         returning impressions, clicks
       )
       select (select count(*) from ins)::int as inserted,
              (select impressions from bump) as impressions,
              (select clicks from bump) as clicks`,
      [placement.slotId, kind, visitorHash, bucketStart, clientId],
    )
    return { counted: (rows[0]?.inserted ?? 0) > 0 }
  }

  const { rows } = await client.query(
    `with ins as (
       insert into ad_events (building_id, event_kind, visitor_hash, bucket_start, client_id)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning event_id
     ), bump as (
       update buildings set ${column} = ${column} + 1
       where building_id = $1 and exists (select 1 from ins)
       returning impressions, clicks
     )
     select (select count(*) from ins)::int as inserted,
            (select impressions from bump) as impressions,
            (select clicks from bump) as clicks`,
    [placement.buildingId, kind, visitorHash, bucketStart, clientId],
  )
  return { counted: (rows[0]?.inserted ?? 0) > 0 }
}

export type PlacementStats = {
  walkbys: number
  visits: number
  walkbys7d: number
  visits7d: number
  /** visits / walkbys as a fraction, or null when there is not enough data to be meaningful. */
  ctr: number | null
  ctr7d: number | null
}

/** CTR is only reported once a placement has enough passes for the ratio to mean anything.
 *  With 3 walk-bys and 1 visit, "33% CTR" is noise presented as insight — and this number is
 *  shown to people deciding what to pay, so a confidently wrong figure is worse than a blank. */
const MIN_WALKBYS_FOR_CTR = 20

function ratio(visits: number, walkbys: number) {
  if (walkbys < MIN_WALKBYS_FOR_CTR) return null
  return visits / walkbys
}

/** All-time counters come from the cached columns (cheap); the 7-day figures aggregate ad_events.
 *  Rows created before this table existed have no events, so their 7-day numbers start at 0 while
 *  all-time keeps the historical total — the windowed figures simply become meaningful as data
 *  accumulates. */
export async function slotStats(slotId: string): Promise<PlacementStats> {
  const { rows } = await pool.query(
    `select h.impressions::int as walkbys,
            h.clicks::int      as visits,
            coalesce(w.pass_7d, 0)::int  as walkbys_7d,
            coalesce(w.visit_7d, 0)::int as visits_7d
     from holdings h
     left join (
       select slot_id,
              count(*) filter (where event_kind = 'pass')  as pass_7d,
              count(*) filter (where event_kind = 'visit') as visit_7d
       from ad_events
       where slot_id = $1 and created_at >= now() - interval '7 days'
       group by slot_id
     ) w on w.slot_id = h.slot_id
     where h.slot_id = $1`,
    [slotId],
  )
  const r = rows[0] ?? { walkbys: 0, visits: 0, walkbys_7d: 0, visits_7d: 0 }
  return {
    walkbys: r.walkbys,
    visits: r.visits,
    walkbys7d: r.walkbys_7d,
    visits7d: r.visits_7d,
    ctr: ratio(r.visits, r.walkbys),
    ctr7d: ratio(r.visits_7d, r.walkbys_7d),
  }
}

export async function buildingStats(buildingId: number): Promise<PlacementStats> {
  const { rows } = await pool.query(
    `select b.impressions::int as walkbys,
            b.clicks::int      as visits,
            coalesce(w.pass_7d, 0)::int  as walkbys_7d,
            coalesce(w.visit_7d, 0)::int as visits_7d
     from buildings b
     left join (
       select building_id,
              count(*) filter (where event_kind = 'pass')  as pass_7d,
              count(*) filter (where event_kind = 'visit') as visit_7d
       from ad_events
       where building_id = $1 and created_at >= now() - interval '7 days'
       group by building_id
     ) w on w.building_id = b.building_id
     where b.building_id = $1`,
    [buildingId],
  )
  const r = rows[0] ?? { walkbys: 0, visits: 0, walkbys_7d: 0, visits_7d: 0 }
  return {
    walkbys: r.walkbys,
    visits: r.visits,
    walkbys7d: r.walkbys_7d,
    visits7d: r.visits_7d,
    ctr: ratio(r.visits, r.walkbys),
    ctr7d: ratio(r.visits_7d, r.walkbys_7d),
  }
}

/** Raw events older than this are pruned. The counter columns keep the permanent all-time total,
 *  so pruning only costs the ability to compute windows further back than the retention period —
 *  and it keeps the table from growing without bound. */
const RETENTION_DAYS = 90

export async function pruneOldEvents() {
  const { rowCount } = await pool.query(
    `delete from ad_events where created_at < now() - ($1 || ' days')::interval`,
    [RETENTION_DAYS],
  )
  return rowCount ?? 0
}
