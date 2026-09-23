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

The footer's backdrop (Mount Shuksan over Picture Lake) is cut from a full-resolution original in `photos-src/` (4340×3255), kept out of `public/` so it is never deployed. A Node script renders every size the page serves into `public/photos/` and writes `src/data/footer-photo.json`, which the footer builds its `<picture>` from:

- **landscape cut** for landscape screens: the whole photo, pinned to its top centre so the peak always shows, from 1280w up to its full 4340w
- **portrait cut** for phones and portrait tablets: cropped at the bottom only as far as it takes for the lake to fill the lower 25% of a tall screen, and trimmed to 3:4 about the centre, with a faint dark fade baked into its foot to keep the name legible over the lake. On phones it hangs 10% of the screen's height below the screen, under Safari's toolbar, and the cut carries that extra 10% at its foot so what shows on screen stays the same

Both are cut in the files themselves, so no pixels are sent only to be cropped off screen. Each size is written as AVIF with a WebP fallback. The page starts loading the photo once it has itself finished loading and gone idle, at low priority, so the footer is ready before anyone scrolls to it without holding anything else up. To change the crops, sizes or quality, edit the constants at the top of `footer-photos.mjs` and rerun it:

```bash
pnpm photos:footer
```

The heat haze over the lake (`src/scripts/heat-haze.ts`) is positioned in the full photo's coordinates, so it follows either crop automatically. Only a new source photo means re-measuring it.

## License

There isn't one. This project is completely free to use however you'd like. Clone it and swap in your own name, tear it apart and rebuild it into something new, or lift pieces of it for your own portfolio. Credit is always appreciated but never required. If it helps you land a job or make a new connection, that's more than enough for me.
