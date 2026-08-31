// Minimal in-process pub/sub for holding + player deltas.
// Fan-out to WebSocket clients lives in routes/ws.ts, which subscribes here.
// For >1 server process, swap this for Postgres LISTEN/NOTIFY or Redis pub/sub —
// the subscribe/publish shape below stays identical either way.

export type HoldingDelta = {
  type: "holding"
  slotId: string
  companyId: string | null
  standingBidCents: number
  claimedAt: string | null
  company: { name: string; url: string; tagline: string; logoUrl: string | null; primary: string; ink: string } | null
  impressions?: number
  clicks?: number
}

export type BuildingDelta = {
  type: "building"
  buildingId: number
  officeOwnerId: string | null
  officeName: string | null
  priceCents: number | null
  company: { name: string; url: string; tagline: string; logoUrl: string | null; primary: string; ink: string } | null
}

export type GraveyardDelta = {
  type: "graveyard"
  plotId: string
  companyId: string | null
  name: string
  story: string
  domain: string | null
  born: number | null
  died: number | null
  standingBidCents: number
  company: { name: string; url: string; tagline: string; logoUrl: string | null; primary: string; ink: string } | null
}

export type PlayerDelta = {
  type: "player"
  playerId: string
  x: number
  z: number
  yaw: number
}

export type PlayerLeft = {
  type: "player_left"
  playerId: string
}

export type OnlineCount = {
  type: "online_count"
  count: number
  totalVisits: number
}

export type CityEvent = HoldingDelta | BuildingDelta | GraveyardDelta | PlayerDelta | PlayerLeft | OnlineCount

type Listener = (event: CityEvent) => void

const listeners = new Set<Listener>()

export function publish(event: CityEvent) {
  for (const l of listeners) l(event)
}

export function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
