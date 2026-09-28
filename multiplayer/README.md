# Casino lobby

The multiplayer half of the `/dev/null` casino, the easter egg behind the site's `>_` prompts. It's a single Cloudflare Worker with one Durable Object that every visitor's WebSocket connects to. It:

- keeps the list of who's online, where they are, and their (self-reported) balance, for the lobby leaderboard and the player counts on each tab
- runs the shared **Crash** rounds: betting window, curve, bust point, cash-outs, all on one server clock
- relays a summary of every **Big O**, **Merge Conflict** and **Plinko** play to the other players at the same table (those games run in the browser)

Balances live in each visitor's `localStorage`; the server never holds money. It checks names, bet shapes and round timing, and rebuilds every relayed payload field by field (`src/protocol.ts`, shared with the site), but a determined visitor can still give themselves a billion fake dollars. That's fine.

The casino works without this. If `PUBLIC_CASINO_WS` isn't set, or the socket is down, the games play solo and the multiplayer UI stays hidden. Nobody is shown an empty leaderboard.

## Free tier

Everything here fits in the Workers **free** plan:

- **SQLite-backed Durable Objects** are the kind the free plan includes (`new_sqlite_classes` in `wrangler.jsonc`).
- **Hibernating WebSockets**: the object sleeps between messages, so an idle lobby costs nothing.
- **Alarms, not timers, drive Crash rounds**, so the object isn't kept awake between phases. Rounds only run while somebody is sitting at the Crash table.
- **Nothing streams while a round runs.** Clients draw the curve from a shared start time, so the server sends a handful of messages per round, not one per frame.

Rough numbers: a Crash round is ~4 alarms plus one message per bet and cash-out; each client sends a clock sync every 25s. A few dozen concurrent visitors sit far inside the free limits (100k requests/day, with WebSocket messages billed at 20:1).

## Deploy

You need a free Cloudflare account.

```bash
cd multiplayer
npm install
npx wrangler login     # opens a browser once
npx wrangler deploy
```

Wrangler prints the Worker's URL, something like `https://casino-lobby.<your-subdomain>.workers.dev`. The socket lives at `/ws` on it:

```
wss://casino-lobby.<your-subdomain>.workers.dev/ws
```

Then tell the site about it: in Vercel → Project → Settings → Environment Variables, add

```
PUBLIC_CASINO_WS = wss://casino-lobby.<your-subdomain>.workers.dev/ws
```

and redeploy the site (it's read at build time).

### Allowed origins

Only pages from the origins in `ALLOWED_ORIGINS` (`wrangler.jsonc`) can open a socket: the production domains and localhost. To try it on Vercel preview deployments too, add their pattern (`*` matches within a host), e.g.

```
https://portfolio-v9-pretty-*.vercel.app
```

and `npx wrangler deploy` again.

## Develop

```bash
cd multiplayer
npm install
npm run dev          # ws://localhost:8787/ws
```

and in the site root, `PUBLIC_CASINO_WS=ws://localhost:8787/ws pnpm dev`. Open the site in two browsers (or a normal and a private window) to see both sides.

```bash
npm test             # protocol: crash maths, name filter, payload cleaning
npm run typecheck
```

## Protocol, briefly

Money is integer cents, multipliers are ×100 integers, times are server epoch ms (clients measure their clock offset with `sync` round trips). The message types are in `src/protocol.ts`:

| Client → server | |
| --- | --- |
| `hi` | name, where they are, balance; answered with `welcome` (player list, crash state, history) |
| `at` / `name` / `bal` | moved tables / renamed / balance changed |
| `bet` / `out` | Crash stake (with optional auto cash-out) / cash out now |
| `play` | a finished Big O, Merge or Plinko play, relayed to that table |
| `sync` | clock sync and keep-alive |

The server refuses anything malformed without comment, caps messages at 1KB and 20 a second per socket, allows 250 sockets, and replaces a name that fails the filter with a generated one.
