import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { publish, subscribe, type CityEvent } from "../lib/bus.js"

/**
 * Realtime channel per BACKEND_PLAN.md §3.4/§5: pushes holding/building deltas to every
 * connected client (so two browsers see each other's outbids live), and relays lightweight
 * {x,z,yaw} player broadcasts for multiplayer presence. No DB writes for movement — it's
 * ephemeral and does not touch the payments path at all.
 */
export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws/city", { websocket: true }, (socket) => {
    const playerId = randomUUID()

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
      publish({ type: "player_left", playerId })
    })
  })
}
