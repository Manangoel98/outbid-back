// Server-side content/URL gate for anything a buyer submits as their brand's
// name/tagline/url/logoUrl. Runs in checkout.ts *before* a Stripe Checkout Session is
// created — this is the one gate that can't be bypassed by skipping the browser UI and
// hitting the API directly. See backend/SECURITY.md "Threat 7".

const BANNED_HOSTS = new Set([
  "t.me",
  "telegram.me",
  "discord.gg",
  "discord.com",
  "wa.me",
  "whatsapp.com",
  "chat.whatsapp.com",
  "signal.me",
  "m.me",
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
])

// Small, deliberately conservative slur/profanity list — this is a spam/abuse deterrent,
// not a substitute for a moderation queue. Matches whole words only (word-boundary regex)
// to avoid false positives on legitimate brand names that merely contain a substring.
const BLOCKED_WORDS = [
  "nigger", "nigga", "faggot", "retard", "chink", "spic", "kike", "tranny",
  "cunt", "whore", "rape", "molest", "pedo", "nazi", "hitler",
  "porn", "xxx", "onlyfans", "escort",
]
const BLOCKED_WORDS_RE = new RegExp(`\\b(${BLOCKED_WORDS.join("|")})\\b`, "i")

function containsBlockedWord(text: string) {
  return BLOCKED_WORDS_RE.test(text)
}

function parseUrlLoose(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    try {
      return new URL(`https://${raw}`)
    } catch {
      return null
    }
  }
}

export type CompanyDraftInput = {
  name: string
  url: string
  tagline?: string
  logoUrl?: string | null
}

export type ModerationResult = { ok: true } | { ok: false; reason: string }

/** Any other free-text field a buyer controls (e.g. building officeName) needs the same
 * blocked-word gate as name/tagline — it's rendered on the building for everyone to see. */
export function moderateFreeText(text: string): ModerationResult {
  if (containsBlockedWord(text)) return { ok: false, reason: "blocked_content" }
  return { ok: true }
}

export function moderateCompanyDraft(draft: CompanyDraftInput): ModerationResult {
  const text = `${draft.name} ${draft.tagline ?? ""}`
  if (containsBlockedWord(text)) return { ok: false, reason: "blocked_content" }

  const url = parseUrlLoose(draft.url)
  if (!url) return { ok: false, reason: "invalid_url" }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "bad_scheme" }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  if (BANNED_HOSTS.has(host)) return { ok: false, reason: "blocked_host" }

  if (draft.logoUrl) {
    const logo = parseUrlLoose(draft.logoUrl)
    if (!logo) return { ok: false, reason: "invalid_logo_url" }
    if (logo.protocol !== "https:" && logo.protocol !== "http:") return { ok: false, reason: "bad_logo_scheme" }
  }

  return { ok: true }
}
