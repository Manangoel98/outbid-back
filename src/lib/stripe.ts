import Stripe from "stripe"
import { env } from "../env.js"

export const stripe = new Stripe(env.stripeSecretKey || "sk_test_placeholder", {
  apiVersion: "2025-02-24.acacia",
})

export function centsToStripeLineItem(name: string, amountCents: number, quantity = 1) {
  return {
    price_data: {
      currency: "usd",
      product_data: { name },
      unit_amount: Math.round(amountCents / quantity),
    },
    quantity,
  }
}
