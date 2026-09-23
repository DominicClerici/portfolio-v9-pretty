# dominicclerici.com

My personal developer portfolio. One page, no framework, loads fast. Mostly dark with a lime accent, and a fair amount of scroll-driven animation that I tried to keep out of the way of actually reading it.

**Live at [dominicclerici.com](https://www.dominicclerici.com)**

## Tech Stack

- **[Astro 6](https://astro.build)** — static site generator that ships zero JavaScript by default
- **[Tailwind CSS 4](https://tailwindcss.com)** — utility-first styling
- **Vanilla JS** — for the handful of interactive bits (grid animations, terminal typing effect, mobile menu)
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

## Footer Photo

The footer's Yosemite backdrop is cut from a full-resolution original in `photos-src/` (kept out of `public/`, so it is never deployed). A Node script renders every size the page serves into `public/photos/` and writes `src/data/footer-photo.json`, which the footer builds its `<picture>` from:

- **full frame** for landscape screens, 1280w up to 5120w, so 4K and 5K (ultrawide included) monitors get a pixel per pixel
- **portrait crop** for phones and portrait tablets: zoomed 1.2× into the centre of the frame and cut in the file itself, so none of the source's resolution is spent on pixels that would be cropped off screen

Each size is written as AVIF with a WebP fallback. To change the crop, sizes or quality, edit the constants at the top of `footer-photos.mjs` and rerun it:

```bash
pnpm photos:footer
```

The heat haze over the river (`src/scripts/heat-haze.ts`) is positioned in the full photo's coordinates, so it follows the crop automatically. Only a new source photo means re-measuring it.

## License

There isn't one. This project is completely free to use however you'd like. Clone it and swap in your own name, tear it apart and rebuild it into something new, or lift pieces of it for your own portfolio. Credit is always appreciated but never required. If it helps you land a job or make a new connection, that's more than enough for me.
