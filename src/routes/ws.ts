import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { pool } from "../lib/db.js"
import { publish, subscribe, type CityEvent } from "../lib/bus.js"

/**
 * Realtime channel per BACKEND_PLAN.md §3.4/§5: pushes holding/building deltas to every
 * connected client (so two browsers see each other's outbids live), and relays lightweight
 * {x,z,yaw} player broadcasts for multiplayer presence. No DB writes for movement — it's
 * ephemeral and does not touch the payments path at all.
 */

let connectedCount = 0

async function broadcastOnlineCount() {
  try {
    const { rows } = await pool.query(`select coalesce(sum(clicks),0)::int as total from holdings`)
    const totalVisits: number = rows[0]?.total ?? 0
    publish({ type: "online_count", count: connectedCount, totalVisits })
  } catch {
    publish({ type: "online_count", count: connectedCount, totalVisits: 0 })
  }
}

export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws/city", { websocket: true }, (socket) => {
    const playerId = randomUUID()
    connectedCount++
    void broadcastOnlineCount()

    const unsubscribe = subscribe((event: CityEvent) => {
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(event))
    })

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "player" && typeof msg.x === "number" && typeof msg.z === "number") {
          publish({ type: "player", playerId, x: msg.x, z: msg.z, yaw: msg.yaw ?? 0 })
        }
      } catch {
        // ignore malformed frames
      }
    })

    socket.on("close", () => {
      unsubscribe()
      connectedCount = Math.max(0, connectedCount - 1)
      publish({ type: "player_left", playerId })
      void broadcastOnlineCount()
    })
  })
}
