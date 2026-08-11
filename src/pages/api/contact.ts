/* The letter's destination. Everything the captcha slip decides in the browser
   is re-decided here — the signature geometry, the timing, the one-use token —
   because a POST can claim anything. Copy is written to be shown verbatim in
   the slip's status line, in the letter's voice. */

import type { APIRoute } from "astro";
import { RESEND_KEY } from "astro:env/server";
import { inkToPath, verifyInk, type Pt } from "../../scripts/signature";
import { allow, verifyChallenge } from "../../lib/letter-guard";

export const prerender = false;

const FROM = "Letters <letters@dominicclerici.com>";
const TO = "dclerici77@gmail.com";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const reject = (error: string, message: string, status = 400) =>
  json({ ok: false, error, message }, status);

// Anything a visitor typed goes into an HTML mail, so it gets escaped once here
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/* The scribble, framed to its own bounds so it reads as a signature rather
   than a smudge in the corner of a fixed-size box. */
function signatureSvg(strokes: Pt[][]) {
  const pts = strokes.flat();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = 8;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  const w = Math.max(...xs) - x + pad;
  const h = Math.max(...ys) - y + pad;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.min(Math.round(w), 320)}" role="img" aria-label="The sender's signature"><path d="${inkToPath(strokes)}" fill="none" stroke="#1a1a18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Two budgets. The loose one only stops flooding, so a mistyped address or a
  // rejected scribble costs a visitor nothing; the strict one, spent further
  // down, is what actually caps letters in an inbox.
  if (!allow(`contact:${clientAddress}`, 25, 15 * 60_000))
    return reject("rate", "Too many tries at once — give it a minute.", 429);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES)
    return reject("too-big", "That letter is too long to carry.", 413);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return reject("malformed", "Something went wrong sending that.");
  }

  // The honeypot: a field no human can see, so anything in it is a bot. It is
  // answered with the success shape on purpose — a script that knows it failed
  // learns how to pass.
  if (clean(data.website, 100)) return json({ ok: true });

  const message = clean(data.message, MAX_MESSAGE);
  if (!message)
    return reject(
      "empty",
      "The letter needs a body — write anything at all.",
      422,
    );

  const name = clean(data.name, MAX_NAME);
  const email = clean(data.email, MAX_EMAIL);
  if (email && !EMAIL_RE.test(email))
    return reject(
      "email",
      "That address doesn't look like one — fix it or leave it blank.",
      422,
    );

  const challenge = verifyChallenge(data.token, RESEND_KEY);
  if (!challenge.ok)
    return reject(
      `challenge:${challenge.reason}`,
      "That signature has gone stale — sign it once more.",
      403,
    );

  const ink = verifyInk(data.strokes);
  if (!ink.ok)
    return reject(
      `ink:${ink.reason}`,
      "That signature didn't take — try scribbling it again.",
      403,
    );

  if (!allow(`send:${clientAddress}`, 5, 15 * 60_000))
    return reject(
      "rate",
      "That's plenty of letters for now — try again later.",
      429,
    );

  const strokes = data.strokes as Pt[][];
  const subject = name
    ? `PORTFOLIO MESSAGE: ${name}`
    : "PORTFOLIO MESSAGE: (no name given)";
  const text = [
    "Message From your Portfolio —",
    "",
    message,
    "",
    name ? `They gave the name: ${name}` : "",
    email ? `They gave the email: ${email}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1a1a18;max-width:560px">
<p style="margin:0 0 20px">Message From your Portfolio —</p>
<div style="white-space:pre-wrap;margin:0 0 24px">${esc(message)}</div>
<p style="margin:0 0 4px">${name ? `They gave the name: ${esc(name)}` : "They didn't give a name"}</p>
<p style="margin:0 0 20px;color:#6b6b64;font-size:14px">${email ? `They gave the email: <a href="mailto:${esc(email)}" style="color:#1a1a18">${esc(email)}</a>` : "No email given"}</p>
<div style="border-top:1px solid #e2e2dd;padding-top:14px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#9a9a92">Signed by hand</p>
${signatureSvg(strokes)}
</div>
</div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject,
        text,
        html,
        ...(email ? { reply_to: email } : {}),
      }),
    });

    if (!res.ok) {
      console.error("resend rejected the letter", res.status, await res.text());
      return reject(
        "send",
        "The post office is closed — try again in a moment.",
        502,
      );
    }
  } catch (err) {
    console.error("resend unreachable", err);
    return reject(
      "send",
      "The post office is closed — try again in a moment.",
      502,
    );
  }

  return json({ ok: true });
};
