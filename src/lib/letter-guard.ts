/* Guards for the Contact letter's API routes: the signed challenge that binds
   a signature to one server-issued nonce, and a small rate limiter.

   Both stores live in module memory, which on Vercel means per-instance and
   per-cold-start. That is deliberate: it costs nothing, it blunts the bursts
   that actually matter (one script hammering one warm function), and the real
   gate is the signature re-check in verifyInk — not this. If the endpoint ever
   needs limits that survive a cold start, swap the two Maps for KV. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TTL_MS = 15 * 60_000;
// A challenge answered instantly was answered by a script, not a hand
const MIN_AGE_MS = 500;

const b64url = (b: Buffer) => b.toString("base64url");

/* The challenge key is derived from the Resend key rather than added as a
   second secret to keep in sync — HMAC is one-way, so the token can never leak
   anything about the credential it came from. Rotating the API key just
   invalidates challenges issued in the last 15 minutes. */
const keyCache = new Map<string, Buffer>();
function challengeKey(secret: string) {
  let key = keyCache.get(secret);
  if (!key) {
    key = createHmac("sha256", secret).update("cv2-letter-challenge").digest();
    keyCache.set(secret, key);
  }
  return key;
}

const sign = (payload: string, secret: string) =>
  b64url(createHmac("sha256", challengeKey(secret)).update(payload).digest());

/** A used nonce is dead: the same captured payload cannot be replayed. */
const spent = new Map<string, number>();

function prune(store: Map<string, { until: number }> | Map<string, number>) {
  const now = Date.now();
  for (const [k, v] of store as Map<string, any>) {
    const until = typeof v === "number" ? v : v.until;
    if (until <= now) store.delete(k);
  }
}

export function issueChallenge(secret: string) {
  const payload = `${b64url(randomBytes(12))}.${Date.now()}`;
  return { token: `${payload}.${sign(payload, secret)}`, ttlMs: TTL_MS };
}

export function verifyChallenge(token: unknown, secret: string) {
  if (typeof token !== "string" || token.length > 200)
    return { ok: false as const, reason: "no-token" };

  const cut = token.lastIndexOf(".");
  if (cut < 0) return { ok: false as const, reason: "malformed" };

  const payload = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1));
  const want = Buffer.from(sign(payload, secret));
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return { ok: false as const, reason: "bad-signature" };

  const issued = Number(payload.slice(payload.indexOf(".") + 1));
  const age = Date.now() - issued;
  if (!Number.isFinite(issued) || age < 0 || age > TTL_MS)
    return { ok: false as const, reason: "expired" };
  if (age < MIN_AGE_MS) return { ok: false as const, reason: "too-fast" };

  prune(spent);
  if (spent.has(payload)) return { ok: false as const, reason: "replayed" };
  spent.set(payload, issued + TTL_MS);

  return { ok: true as const, reason: "valid" };
}

const hits = new Map<string, { count: number; until: number }>();

/** True while `key` still has requests left in the current window. */
export function allow(key: string, limit: number, windowMs: number) {
  prune(hits);
  const now = Date.now();
  const slot = hits.get(key);
  if (!slot || slot.until <= now) {
    hits.set(key, { count: 1, until: now + windowMs });
    return true;
  }
  slot.count += 1;
  return slot.count <= limit;
}
