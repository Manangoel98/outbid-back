# Outbid City — Security Model

Full brainstorm of "how does nobody get to take someone else's thing without legitimately
outbidding them, and how does nothing else go wrong." Read alongside `../BACKEND_PLAN.md`
(data model / pricing / concurrency) — this file is the attacker's-eye view of the same system.

The core design principle: **ownership only ever changes inside one atomic, optimistic-locked
SQL statement, and that statement only ever runs after Stripe has confirmed real money moved.**
Everything below is either a consequence of that principle, or a defense that keeps it true.

## Threat 1 — Two buyers race for the same slot

**Attack:** Two people click "buy" on `taxi-3` within the same 50ms window. Naively, both writes
could succeed (last-write-wins) and one payment is "lost" — the buyer paid but doesn't own it.

**Mitigation:** `holdings.version` optimistic lock. The claim SQL is
`UPDATE holdings SET ... WHERE slot_id = $1 AND standing_bid_cents < $2`. Postgres serializes
concurrent writes to the same row — the first `UPDATE` to commit wins, the second matches 0 rows.
See `backend/src/lib/claims.ts::claimSlot`. The loser is detected (`rows.length === 0`) and their
Stripe payment is refunded automatically in `backend/src/routes/webhook.ts`.
**Residual risk:** none at the DB level — Postgres row locks are the actual guarantee here, the
optimistic-lock `WHERE` clause is just how we detect and react to it.

## Threat 2 — Someone claims a slot without actually paying

**Attack:** Client calls a hypothetical `POST /holdings/:id/claim` directly with a fake "paid"
flag, or replays an old successful request.

**Mitigation:** There is no such endpoint. The *only* function that can flip `holdings.company_id`
is `claimSlot`/`claimFleet`/`claimBuilding` in `claims.ts`, and the *only* caller of those is the
Stripe webhook handler (`webhook.ts`) — never a client-facing route. `checkout.ts` only ever
creates a Stripe Checkout Session; it never touches `holdings`. So "claiming without paying" isn't
a logic bug to patch, it's structurally impossible — there is no code path from an HTTP request to
an ownership change that doesn't pass through Stripe first.

## Threat 3 — Someone forges a fake "payment succeeded" webhook

**Attack:** POST a hand-crafted `checkout.session.completed` JSON straight to
`/api/v1/stripe/webhook` claiming any slot for $0.

**Mitigation:** `stripe.webhooks.constructEvent(raw, signature, STRIPE_WEBHOOK_SECRET)` verifies
the HMAC signature Stripe attaches to every real webhook, using a secret only you and Stripe
know. Requests without a valid signature are rejected with 400 before any DB code runs
(`webhook.ts`). This is why the raw request body is captured unparsed in `server.ts` — signature
verification needs the exact original bytes.

## Threat 4 — Stripe retries the same webhook twice (it does this by design)

**Attack (accidental, not malicious):** Stripe redelivers webhooks on any non-2xx response or
timeout. Naive handling would double-charge, double-count, or double-fire the realtime broadcast.

**Mitigation:** `orders.stripe_checkout_session_id` and `stripe_payment_intent_id` are `unique`
constraints. Combined with an explicit status check before reprocessing (see Hardening §7 below),
a redelivered webhook for an already-`succeeded` order is a no-op. Idempotency is a database
constraint, not an in-memory flag, so it survives server restarts.

## Threat 5 — Price manipulation from the client

**Attack:** Client sends `amountCents: 1` for a slot whose real standing bid is $500.

**Mitigation:** `checkout.ts` re-reads `standing_bid_cents` from the DB and computes the real
minimum via `computeTakePriceCents()` server-side before creating the Stripe session — the amount
charged is never trusted from the client beyond "is it at least the real minimum." The Checkout
Session amount is what Stripe actually charges, so there's no way to pay less than the server
computed.

## Threat 6 — SSRF through the logo-fetch proxy

**Attack:** The `/logo?u=<url>` proxy (used so brand favicons can be drawn onto canvas textures
without CORS taint) fetches whatever URL a user's browser sends. Without checks, an attacker
could set `u=http://169.254.169.254/latest/meta-data/` (cloud metadata endpoint) or
`u=http://localhost:5432` and use your own server as a network probe into infrastructure that
should never be reachable from the internet.

**Mitigation:** `frontend/shared/urlSafety.ts` — shared by the Vite dev middleware, the Vercel
edge function, and the Netlify function — rejects: non-http(s) schemes, `localhost`/`.local`/
`.internal` hostnames, and any literal IPv4/IPv6 address in a private/loopback/link-local/
metadata range. The upstream response is also capped in size and must have an `image/*`
content-type, so even a URL that slips through can't be used to exfiltrate arbitrary data through
the proxy. **Residual risk:** DNS rebinding (a hostname that resolves to a public IP at
validation-time but a private IP at fetch-time) is not fully closed — that needs a resolve-then-
connect-to-IP fetch, which isn't available in edge/serverless runtimes. Low severity here since the
proxy only returns image bytes, but worth revisiting if this proxy is ever reused for anything else.

## Threat 7 — Abusive brand content (slurs, phishing lookalikes, chat-app link spam)

**Attack:** Someone claims a slot with `name: "<script>"` or `url: "wa.me/scampage"` or a slur, by
hitting the API directly (bypassing the client's `BANNED_HOSTS` check, which only runs in the
browser and is trivially skippable with curl).

**Mitigation:** Same `BANNED_HOSTS` list plus a profanity/slur list now enforced **server-side**
in `backend/src/lib/moderation.ts`, run inside `checkout.ts` before a Checkout Session is even
created — rejected content never reaches Stripe or the DB. Brand name/tagline are also rendered
as text content only (React escapes by default) so stored XSS via those fields isn't possible on
the client either, but the server-side filter is the real gate since it's the only one that can't
be bypassed.

## Threat 8 — Bots spamming outbids / scraping / DoSing checkout

**Attack:** A script hammers `POST /api/v1/checkout/slot` thousands of times a second — either to
grief real users (making everything constantly "just got outbid"), or simply to run up your Stripe
API usage / DB load.

**Mitigation:** `@fastify/rate-limit` on every write route (`checkout.*`, `webhook`), keyed by
IP, in `server.ts`. Read-only routes (`/city`, `/holdings`) are cheap and cached
(`cache-control` header) so they're a lower priority target, but still capped.

## Threat 9 — Fleet bulk-buy race (multiple slots at once)

**Attack:** Two companies both buy "5 taxis" at the same moment — naive "pick 5 open slots" logic
could hand both buyers overlapping slots.

**Mitigation:** `SELECT ... FOR UPDATE SKIP LOCKED` in `claimFleet` — each concurrent transaction
skips rows the other has already locked, so two simultaneous bulk buys always get disjoint slot
sets, never picking the same slot twice. See `backend/src/lib/claims.ts::claimFleet`.

## Threat 10 — Building purchase race identical to Threat 1

Same optimistic-lock pattern (`buildings.price_cents` guarded `WHERE` clause) in
`claimBuilding` — see Threat 1, identical guarantee.

## Threat 11 — Oversized / malformed requests

**Attack:** A giant JSON body, an absurd `quantity: 999999999`, or a negative `amountCents`.

**Mitigation:** `zod` schemas in `checkout.ts` already cap `quantity` (1–50) and floor
`amountCents`/`pricePerUnitCents` at `env.floorCents`; body size is capped at the Fastify level
(`bodyLimit`) in `server.ts`. Fleet quantity is additionally capped by
`MAX_FLEET_TAXI_PER_COMPANY`/`MAX_FLEET_PLANE_PER_COMPANY` business rules (not just input
validation — these are the actual game-design caps from `BACKEND_PLAN.md` §2).

## Threat 12 — Cross-origin abuse (some other website calls your API using a visitor's browser)

**Mitigation:** `@fastify/cors` restricted to `CORS_ORIGIN` (your domain only) in `server.ts` —
requests from any other origin are rejected by the browser before they even reach your handlers
for state-changing routes.

## Threat 13 — "No login" identity gets impersonated

**Attack:** Since there's no password, could someone else claim to be you and manage your brand?

**Why this is a non-issue by design:** There is nothing to impersonate *into* — every
ownership-changing action re-pays in full via Stripe regardless of who claims to be the current
owner (BACKEND_PLAN.md §2: raising has "no premium requirement" but still costs the same real
money). The anonymous `visitor_id` is only ever used for cosmetic convenience (e.g. a future
"your holdings" view), never as an authorization check that gates a free action. If we later add
free edits (e.g. renaming a tagline without re-paying), that's the moment a real per-company
secret/session token needs to be introduced — flagged in `BACKEND_PLAN.md` §6, not yet needed.

## What's implemented vs. still open

| # | Threat | Status |
|---|---|---|
| 1 | Double-sell race | ✅ optimistic lock |
| 2 | Claim without paying | ✅ structurally impossible (no such code path) |
| 3 | Forged webhook | ✅ signature verification |
| 4 | Duplicate webhook delivery | ✅ unique constraints + explicit status check |
| 5 | Client price tampering | ✅ server recomputes minimum |
| 6 | SSRF via logo proxy | ✅ hostname/IP-range guard + content-type/size cap |
| 7 | Abusive content | ✅ server-side filter (moderation.ts) |
| 8 | Bot/DoS on checkout | ✅ rate limiting |
| 9 | Fleet buy race | ✅ `FOR UPDATE SKIP LOCKED` |
| 10 | Building buy race | ✅ optimistic lock |
| 11 | Malformed/oversized input | ✅ zod + body limits + business caps |
| 12 | Cross-origin abuse | ✅ CORS allowlist |
| 13 | Anonymous identity | ✅ by design, N/A until free-edit features exist |
| — | DNS rebinding on logo proxy | ⚠️ residual, low severity, documented above |
| — | TLS/HTTPS | depends on host (Render/Vercel/Netlify/Railway all provide free TLS — make sure it's on) |
| — | Secrets management | `.env` is gitignored everywhere; never commit real Stripe keys |
