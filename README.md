# dominicclerici.com

My personal developer portfolio — a single-page site built to be fast, minimal, and easy on the eyes. Dark theme, warm gold accents, and just enough animation to keep things interesting without getting in the way.

**Live at [dominicclerici.com](https://www.dominicclerici.com)**

## Tech Stack

- **[Astro 6](https://astro.build)** — static site generator that ships zero JavaScript by default
- **[Tailwind CSS 4](https://tailwindcss.com)** — utility-first styling
- **Vanilla JS** — for the handful of interactive bits (grid animations, terminal typing effect, mobile menu)
- **Self-hosted, subset fonts** — Newsreader, Inter, and Space Grotesk served locally as woff2, trimmed to only the exact glyphs used on the site (~38KB total vs ~128KB for the full latin subset)

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

## Fonts

The fonts are self-hosted and subset to only the characters that actually appear on the site. This means no requests to Google Fonts, faster load times, and smaller files.

The original (un-subset) font files live in `public/fonts/full/`. The subset versions that get deployed live in `public/fonts/`. A Python script handles the subsetting automatically.

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

## License

There isn't one. This project is completely free to use however you'd like. Clone it and swap in your own name, tear it apart and rebuild it into something new, or lift pieces of it for your own portfolio. Credit is always appreciated but never required. If it helps you land a job or make a new connection, that's more than enough for me.
