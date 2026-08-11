/* Hands out the one-use token that /api/contact demands alongside a signature.
   Requested when the captcha slip opens, so its age also measures how long the
   visitor spent signing. */

import type { APIRoute } from "astro";
import { RESEND_KEY } from "astro:env/server";
import { allow, issueChallenge } from "../../lib/letter-guard";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export const GET: APIRoute = ({ clientAddress }) => {
  if (!allow(`challenge:${clientAddress}`, 15, 10 * 60_000))
    return json({ ok: false, error: "rate" }, 429);

  return json({ ok: true, ...issueChallenge(RESEND_KEY) });
};
