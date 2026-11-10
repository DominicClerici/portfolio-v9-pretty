# dominicclerici.com

My personal developer portfolio. One page, no framework, loads fast. Mostly dark with a lime accent, and a fair amount of scroll-driven animation that I tried to keep out of the way of actually reading it.

**Live at [dominicclerici.com](https://www.dominicclerici.com)**

## Tech Stack

- **[Astro 6](https://astro.build)** — static site generator that ships zero JavaScript by default
- **[Tailwind CSS 4](https://tailwindcss.com)** — utility-first styling
- **Vanilla JS** — for the handful of interactive bits (grid animations, terminal typing effect, mobile menu, and a small casino)
- **Self-hosted, subset fonts** — Aspekta, Roboto Mono, and Inter served locally as woff2, trimmed by `subset-fonts.py` to only the exact glyphs used on the site

The whole project runs on just 4 npm dependencies. No React, no Vue, no frameworks beyond Astro itself.

## Getting Started

```bash
# install dependencies
pnpm install

# start the dev server at localhost:4321
pnpm dev

# build for production
pnpm build

# preview the production build locally
pnpm preview
```

Requires Node >= 22.12.0.

## Backgrounds

Three WebGL2 scenes sit behind the front page, each fetched only when it is about to be seen:

| Under | Scene | Loaded |
| --- | --- | --- |
| Hero, About | `src/scripts/ink-fluid.ts`: a fluid simulation carrying three pigments over paper, stirred by the pointer | With the page |
| Career, Quote | `src/scripts/glass-scene.ts`: fluted glass on near-black, one orb per employer | Once the page has loaded and gone idle, or when the turn to dark is reached |
| Footer | `src/scripts/signal-ascii.ts`: a trefoil knot raymarched once per character cell and set in Roboto Mono | A screen and a half ahead of the footer |

`PinnedCanvas.astro` owns the first two and the turn from one to the other; `Footer.astro` owns the third, and draws the knot in whatever room its layout leaves (the empty `data-knot` box). Each scene runs only while it is on screen and the tab is showing. What they share is in `src/lib/gl-kit.ts`.

## Fonts

The fonts are self-hosted and subset to only the characters that actually appear on the site. This means no requests to Google Fonts, faster load times, and smaller files.

The original (un-subset) font files live in `fonts-src/`. The subset versions that get deployed live in `src/assets/fonts/`, which the build emits under `/_astro/` with a content hash in each name, so they are cached for a year and a re-subset reaches returning visitors straight away. A Python script handles the subsetting automatically.

**If you change any visible text on the site and introduce characters that weren't there before** (for example, adding a `?` or `!` to a headline, or a name with an accented character), you need to re-subset the fonts:

```bash
# one-time setup
pip install fonttools brotli

# build first so the script can scan the resolved HTML
pnpm build

# subset fonts based on the built output
python subset-fonts.py

# rebuild with the new subset fonts
pnpm build
```

The script scans the built HTML in `dist/` (where all template expressions have been resolved to real text), figures out which characters each font needs, and trims the font files down to just those glyphs. It prints a summary showing the before/after sizes.

The casino (below) sets its text in the system's own fonts, so it needs nothing from this script.

## The casino

The `>_` prompts (header, bottom-left while scrolling, the footer's cap bar, and by the copyright on phones) open the **/dev/null casino**: four games (Crash, High Low, Roulette and Plinko) played with $1,000 of fake money, kept in `localStorage`. It runs as `casino.exe`, a Windows XP window (Luna blue): title bar, menus, an Explorer-style lobby, balloon tips, and a blue screen when Crash crashes.

- **Crash**: a memory graph that climbs until the process dies. Cash out before the OOM killer.
- **Big O**: hi-lo where the deck is thirteen complexity classes, O(1) to the busy beaver.
- **Merge Conflict**: roulette on a reel of commits. Ours, theirs, or the conflict.
- **Plinko**: drop a packet through the load balancer.

It's vanilla TypeScript and canvas in `src/scripts/casino/`, fetched only when someone clicks a prompt, so the page doesn't pay for it. With other visitors online it goes multiplayer: shared Crash rounds, other players' plays showing up at each table, and a leaderboard. That runs on a small Cloudflare Worker in [`multiplayer/`](multiplayer/README.md) (free tier), pointed to by the `PUBLIC_CASINO_WS` env var. Without it, everything plays solo.

## License

There isn't one. This project is completely free to use however you'd like. Clone it and swap in your own name, tear it apart and rebuild it into something new, or lift pieces of it for your own portfolio. Credit is always appreciated but never required. If it helps you land a job or make a new connection, that's more than enough for me.
