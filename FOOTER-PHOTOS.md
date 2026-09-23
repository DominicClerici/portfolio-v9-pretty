# Footer photo: processing and integration handoff

How the footer's road photo is prepared and served, so this work can move from
the abandoned branch `claude/mobile-footer-gradient-crop-6t3xs9` (tip at or
after `e46480d`) onto a fresh branch off `master`.

This covers **only the image work**: cropping, sizing and encoding the photo,
serving it through a `<picture>`, and the heat-haze changes that keep it sharp.
None of the overscroll-flicker attempts are carried over. They are listed at the
end so the next approach doesn't repeat them.

---

## 1. What you end up with

| Cut | Used on | Widths (px) | Formats |
|---|---|---|---|
| **full**: the whole frame | landscape screens: laptops, desktops, 4K, 5K ultrawide, landscape phones and tablets | 1280, 1920, 2560, 3840, 5120 | AVIF + WebP |
| **portrait**: zoomed 1.55× into the centre, moved 15% of the screen down | phones and portrait tablets, `(max-width: 1023px) and (orientation: portrait)` | 900, 1320, 1766 (1766 is the crop at the source's full resolution) | AVIF + WebP |

What each screen was measured picking in Chromium:

| Screen | File picked | AVIF | WebP |
|---|---|---|---|
| iPhone (390×844 @3x) | `footer-road-portrait-1766` | 303 KB | 446 KB |
| iPad portrait (820×1180 @2x) | `footer-road-portrait-1766` | 303 KB | 446 KB |
| 1440×900 laptop @1x | `footer-road-full-1920` | 433 KB | 522 KB |
| 4K (1920×1080 @2x) | `footer-road-full-3840` | 1194 KB | 1651 KB |
| 5K ultrawide (2560×1080 @2x) | `footer-road-full-5120` | 1728 KB | 2522 KB |

For comparison, the old files were `footer-road.webp` (1280w, 194 KB) and
`footer-road-2x.webp` (2000w, 379 KB), shown with a CSS zoom on mobile.

---

## 2. Source image

- File: `diego-jimenez-A-NVHPka9Rk-unsplash.jpg`, 5472×3648 (exactly 3:2),
  sRGB (IEC61966-2.1 ICC profile), about 4.4 MB.
  Photo: <https://unsplash.com/photos/A-NVHPka9Rk>, by Diego Jimenez on Unsplash.
- Master has it at `public/photos/`. **Move it to `photos-src/`** (next to
  `fonts-src/`). Everything in `public/` is deployed, and the page never
  references the original.
- It has the **same framing** as the old 2000×1333 `footer-road` photo: the two
  downscaled to 200×133 differ by a mean of 1.6/255 grey levels. So the
  heat-haze road coordinates (`CREST_Y`, `CREST_X`, `HORIZON_Y`… in
  `src/scripts/heat-haze.ts`), which are in the photo's UV space, carry over
  unchanged.
- Being sRGB, it needs no colour conversion. `sharp` strips the profile on
  output, and browsers assume sRGB.

---

## 3. Fastest route: take the files from the branch

From a fresh branch off `master`:

```bash
B=origin/claude/mobile-footer-gradient-crop-6t3xs9
git fetch origin claude/mobile-footer-gradient-crop-6t3xs9

# generator, source, generated output, manifest
git checkout $B -- footer-photos.mjs photos-src/ src/data/footer-photo.json
git checkout $B -- $(git ls-tree -r --name-only $B public/photos | grep '/footer-road-')

# the old photo files and the misplaced original
git rm public/photos/footer-road.webp public/photos/footer-road-2x.webp
git rm public/photos/diego-jimenez-A-NVHPka9Rk-unsplash.jpg   # now lives in photos-src/

# sharp as a dev dependency + the npm script
pnpm add -D sharp@0.34.5
npm pkg set scripts.photos:footer="node footer-photos.mjs"

# the heat haze, optional but needed for a sharp photo (see section 6)
git checkout $B -- src/scripts/heat-haze.ts
```

**Do not** check out `src/components/Footer.astro` from the branch. It still
carries a flicker experiment (the haze pausing during overscroll, and
`pointer-events-none` on the backdrop). Apply section 5 by hand instead.

The README section (`## Footer Photo`) can be copied from the branch's
`README.md` as well.

If the branch is gone, section 4 has everything needed to recreate the
generator from scratch.

---

## 4. The generator: `footer-photos.mjs`

A Node script at the repo root, following `subset-fonts.py`'s precedent. It
reads the source, writes every size into `public/photos/`, and writes a
manifest `src/data/footer-photo.json` that the footer builds its `<picture>`
from. Run it with:

```bash
pnpm photos:footer      # about 7 minutes; AVIF at effort 6 is slow at 5K
```

It needs `sharp` as a direct dev dependency. It's already installed as part of
Astro, but pnpm doesn't expose it to root scripts: `pnpm add -D sharp@0.34.5`.

### 4.1 Crop math (portrait)

The design intent was: take the full photo cover-fitted to a tall screen, zoom
it `ZOOM`× about the screen's centre, then move it down `SHIFT` of the screen's
height. For a portrait screen the cover fit is height-bound, so the screen
shows `1/ZOOM` of the photo's height, starting at
`((ZOOM − 1)/2 − SHIFT) / ZOOM` of the way down:

```
ZOOM = 1.55, SHIFT = 0.15, H = 3648, W = 5472
cropH = round(H / ZOOM)                         = 2354
top   = round(((ZOOM - 1)/2 - SHIFT) / ZOOM * H) = 294
cropW = round(cropH * 3/4)                      = 1766   (3:4, see below)
left  = round((W - cropW) / 2)                  = 1853
```

**Why 3:4:** a phone (about 0.46 wide:tall) cover-fits a 3:4 crop
height-bound and shows its middle, exactly as intended. A portrait tablet
(0.69–0.75) fits it almost exactly. A narrower crop would save around 25% of the
bytes on phones but would zoom tablets in further.

In full-photo UV (x, y, w, h) the crop is
`[0.338633, 0.080592, 0.322734, 0.645285]`. The manifest records it as
`portrait.rect`, and the heat haze needs it (section 6).

### 4.2 Sizes

- **full:** 1280 / 1920 / 2560 / 3840 / 5120. 5120 is a 5K ultrawide's (and a
  5K iMac's) device width. The source's 5472 would add only 7%.
- **portrait:** 900 / 1320 / native (1766). These are a portrait screen's height
  at roughly 1×, 2× and 3×, expressed as 3:4 widths. A 3× phone would want
  about 1900w, so it gets the native 1766. That's the source's limit at a 1.55×
  zoom, and about 1:1 with the screen.
- Resize kernel: Lanczos3 (`sharp`'s default, set explicitly).

### 4.3 Encoding

```js
const AVIF = { quality: 62, effort: 6 }
const WEBP = { quality: 84, effort: 6, smartSubsample: true }
```

These were chosen by comparing 1:1 (and 2× zoomed) crops of the most detailed
region (the dry brush and gravel beside the road) against a lossless
downscale of the source:

| Setting | Size of the 2560w full frame | PSNR vs source | By eye at 2× |
|---|---|---|---|
| AVIF q50 | 411 KB | 31.8 dB | gravel visibly smeared |
| AVIF q56 | 537 KB | 33.5 dB | close, slight softening |
| **AVIF q62** | 693 KB | 35.3 dB | indistinguishable |
| WebP q78 | 682 KB | 32.8 dB | softened |
| **WebP q84** | 904 KB | 34.8 dB | indistinguishable |

The photo is expensive to compress: the brush is high-entropy, so AVIF saves
only about 20–30% over WebP here, not the usual 50%. If bytes matter more than
the last bit of fidelity, AVIF q56 is the next step down.

### 4.4 Blur-up placeholders

A tiny WebP of each cut (24px wide for full, 18px for portrait, quality 60)
goes into the manifest as a `data:` URI. It's about 150 bytes each, used as the
backdrop's background until the photo loads.

### 4.5 Output

- `public/photos/footer-road-{full|portrait}-{width}.{avif|webp}`. The filename
  carries the cut and the width, and the heat haze relies on that (section 6).
- `src/data/footer-photo.json`:

```json
{
  "full":     { "rect": [0,0,1,1], "width": 5472, "height": 3648,
                "avif": "/photos/footer-road-full-1280.avif 1280w, …",
                "webp": "/photos/footer-road-full-1280.webp 1280w, …",
                "placeholder": "data:image/webp;base64,…" },
  "portrait": { "rect": [0.3386…, 0.0806…, 0.3227…, 0.6453…], "width": 1766, "height": 2354, … }
}
```

### 4.6 Full script

```js
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import sharp from "sharp"

const SOURCE = "photos-src/diego-jimenez-A-NVHPka9Rk-unsplash.jpg"
const OUT_DIR = "public/photos"
const MANIFEST = "src/data/footer-photo.json"
const NAME = "footer-road"

const ZOOM = 1.55
const SHIFT = 0.15
const PORTRAIT_ASPECT = 3 / 4

const FULL_WIDTHS = [1280, 1920, 2560, 3840, 5120]
const PORTRAIT_WIDTHS = [900, 1320, Infinity]

const AVIF = { quality: 62, effort: 6 }
const WEBP = { quality: 84, effort: 6, smartSubsample: true }

const { width: W, height: H } = await sharp(SOURCE).metadata()

const cropH = Math.round(H / ZOOM)
const cropW = Math.round(cropH * PORTRAIT_ASPECT)
const crop = {
  left: Math.round((W - cropW) / 2),
  top: Math.round((((ZOOM - 1) / 2 - SHIFT) / ZOOM) * H),
  width: cropW,
  height: cropH,
}
if (crop.top < 0 || crop.top + crop.height > H) {
  throw new Error("ZOOM/SHIFT move the portrait crop off the photo")
}

await mkdir(OUT_DIR, { recursive: true })
for (const f of await readdir(OUT_DIR)) {
  if (f.startsWith(`${NAME}-`) || f.startsWith(`${NAME}.`)) await rm(`${OUT_DIR}/${f}`)
}

async function renderSet(label, region, widths) {
  const sizes = [...new Set(widths.map((w) => Math.min(w, region.width)))]
  const set = { avif: [], webp: [] }
  for (const w of sizes) {
    const base = sharp(SOURCE).extract(region).resize({ width: w, kernel: "lanczos3" })
    for (const [fmt, opts] of [["avif", AVIF], ["webp", WEBP]]) {
      const file = `${NAME}-${label}-${w}.${fmt}`
      const { size } = await base.clone()[fmt](opts).toFile(`${OUT_DIR}/${file}`)
      set[fmt].push(`/photos/${file} ${w}w`)
      console.log(`${file.padEnd(34)} ${(size / 1024).toFixed(0).padStart(5)} KB`)
    }
  }
  const tiny = await sharp(SOURCE)
    .extract(region)
    .resize({ width: region.width >= region.height ? 24 : 18 })
    .webp({ quality: 60 })
    .toBuffer()
  return {
    rect: [region.left / W, region.top / H, region.width / W, region.height / H],
    width: region.width,
    height: region.height,
    avif: set.avif.join(", "),
    webp: set.webp.join(", "),
    placeholder: `data:image/webp;base64,${tiny.toString("base64")}`,
  }
}

const manifest = {
  full: await renderSet("full", { left: 0, top: 0, width: W, height: H }, FULL_WIDTHS),
  portrait: await renderSet("portrait", crop, PORTRAIT_WIDTHS),
}
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote ${MANIFEST}`)
```

(The branch's copy has a fuller header comment explaining the same choices.)

---

## 5. Footer integration (`src/components/Footer.astro`)

These edits are independent of how the backdrop is pinned. They assume master's
viewport-fixed `.footer-canvas-wrap`. If the new approach changes the
backdrop's box, the one thing that matters is that the `<img>` is
`object-fit: cover` in a box the haze is told about (its `frame`, section 6).

### 5.1 Frontmatter

```astro
import photo from "../data/footer-photo.json";

// Screens that get the portrait cut. Keep in step with the same query in the
// styles, which picks its blur-up.
const PORTRAIT = "(max-width: 1023px) and (orientation: portrait)";
// Each cut is cover-fitted to a screen-tall frame, so its displayed width is
// the screen's height × its aspect (3:4 portrait, 3:2 full) — unless the
// screen is wider than that, when the width fills it.
const PORTRAIT_SIZES = "(min-aspect-ratio: 3/4) 100vw, 75vh";
const FULL_SIZES = "(min-aspect-ratio: 3/2) 100vw, 150vh";
```

`sizes` matters here. With master's `sizes="100vw"`, a phone would ask for a
390px-wide image while cover actually displays it about 630px wide, and a
4:3 desktop would under-fetch in the same way. `vh` in `sizes` is the large
viewport on iOS, which matches a full-screen backdrop.

### 5.2 Markup

This replaces master's single `<img>`. The blur-up moves from the inline
`style="background-image:…"` to two custom properties:

```astro
<div
  class="footer-canvas-wrap fixed inset-0 -z-10 bg-n-900"
  style={`--blur-full:url(${photo.full.placeholder});--blur-portrait:url(${photo.portrait.placeholder})`}
  aria-hidden="true"
>
  <picture>
    <source media={PORTRAIT} type="image/avif" data-srcset={photo.portrait.avif} sizes={PORTRAIT_SIZES} />
    <source media={PORTRAIT} type="image/webp" data-srcset={photo.portrait.webp} sizes={PORTRAIT_SIZES} />
    <source type="image/avif" data-srcset={photo.full.avif} sizes={FULL_SIZES} />
    <img
      class="footer-photo absolute inset-0 w-full h-full object-cover"
      data-srcset={photo.full.webp}
      data-portrait-rect={JSON.stringify(photo.portrait.rect)}
      sizes={FULL_SIZES}
      width={photo.full.width}
      height={photo.full.height}
      alt=""
      decoding="async"
    />
  </picture>
  <canvas id="footer-canvas" class="absolute left-0 w-full"></canvas>
  <div class="footer-scrim absolute inset-0"></div>
</div>
```

Notes:
- The `<canvas>` is no longer `inset-0 w-full h-full`. The haze sets its `top`
  and `height` itself, over the horizon band only.
- `data-portrait-rect` hands the crop rectangle to the client script without
  bundling the whole manifest (placeholders included) into the JS.

### 5.3 Styles

```css
/* The blur-up, cut to match whichever photo the <picture> picks. */
.footer-canvas-wrap {
  background: var(--blur-full) center / cover;
}
/* Same query as PORTRAIT in the frontmatter. */
@media (max-width: 1023px) and (orientation: portrait) {
  .footer-canvas-wrap {
    background-image: var(--blur-portrait);
  }
}
```

Also update the comment on `#footer-canvas`. It no longer says the canvas is
opaque (`alpha: false`), because it is now transparent outside the shimmer.

### 5.4 Script

Deferred loading has to set the `<source>`s' srcsets as well, and before the
`<img>`'s, so the `<img>` chooses among all of them:

```ts
// The photo's current source, for the haze: its files are named for their
// cut and width (footer-road-<cut>-<width>.<ext>), and the portrait cut's
// place in the full photo rides on the <img>.
const portraitRect: number[] = JSON.parse(photo.dataset.portraitRect!);
const source = () => {
  const [, cut, width] = /-(full|portrait)-(\d+)\.\w+$/.exec(photo.currentSrc)!;
  return {
    width: Number(width),
    rect: cut === "portrait" ? portraitRect : [0, 0, 1, 1],
  };
};

function loadPhoto() {
  if (photo.srcset) return;
  for (const el of footer.querySelectorAll<HTMLSourceElement>("picture source")) {
    el.srcset = el.dataset.srcset!;
  }
  photo.srcset = photo.dataset.srcset!;
  if (reducedMotion) return;
  photo
    .decode()
    .then(() => {
      haze = createHeatHaze({
        canvas,
        frame: footer.querySelector<HTMLElement>(".footer-canvas-wrap")!,
        img: photo,
        source,
        onReady: () => canvas.classList.add("is-ready"),
        onLost: () => {
          canvas.classList.remove("is-ready");
          haze = null;
        },
      });
      if (footerVisible && !document.hidden) haze?.start();
    })
    .catch(() => {});
  // Turning a tablet or phone switches between the cuts; the haze re-reads
  // the photo once the new one is in.
  photo.addEventListener("load", () => haze?.reload());
}
```

Everything else in master's script (the two IntersectionObservers,
`visibilitychange`, the typewriter and the header echo) stays as it is.

---

## 6. Heat haze (`src/scripts/heat-haze.ts`)

Take the branch's file whole. It doesn't depend on how the backdrop is
positioned. Why it had to change:

1. **Sharpness.** On master the canvas covers the whole screen, is opaque, and
   renders at a device pixel ratio capped at 1.5. That hides the photo behind a
   softer copy of itself, which defeats the new 3840w/5120w files. The canvas
   now covers only the band the shimmer lives in (photo UV y 0.42–0.62,
   `CANVAS_Y`) at the full device pixel ratio (capped at 3). It is transparent
   (`alpha: true`, premultiplied) wherever the distortion mask is zero, and
   fades in over the mask's faint fringe, so there are no seams. On a 5K
   ultrawide that's about 3.5 MP of canvas instead of 11 MP.
2. **Two cuts.** The shader works in full-photo UV. A `source()` callback
   supplies the current file's pixel width and its rect in the full photo, and
   the canvas's pixels are mapped through the cover fit of *that* file.
3. **Texture size.** Only the band's rows (`TEX_Y` = 0.40–0.64, with margin for
   the distortion and the mirage) are uploaded, cut with
   `createImageBitmap(img, 0, r0, w, h)`. At 5120w that's 5120×819, not a
   5120×3413 texture plus mipmaps.
4. **`reload()`** re-uploads after the `<picture>` switches source (on
   rotation).

API:

```ts
createHeatHaze({
  canvas,          // placed and sized by the haze inside `frame`
  frame,           // the box the <img> is cover-fitted to (observed for resizes)
  img,             // the decoded <img>
  source,          // () => ({ width: filePixelWidth, rect: [x, y, w, h] in full-photo UV })
  onReady, onLost,
}) // → { start, stop, resize, reload } | null
```

### Gotcha: `naturalWidth` is not the file's width

For an image chosen from a `srcset` with `w` descriptors, `img.naturalWidth`
is **divided by the chosen density**. A 1920w file shown with
`sizes` = 1440px reports `naturalWidth` 1440, while
`createImageBitmap(img)` is 1920 real pixels. Computing the texture's crop
rows from `naturalWidth` lands them in the sky. That's why `source()` returns
the real width, parsed from the filename (the height follows from the aspect).
Keep the `-<cut>-<width>.<ext>` naming if the files are renamed.

---

## 7. Verifying it

In Chromium via Playwright (`executablePath: '/opt/pw-browsers/chromium'` in
this environment), at 390×844 @3x (mobile), 820×1180 @2x (portrait tablet),
1440×900 @1x, 1920×1080 @2x (4K) and 2560×1080 @2x (5K ultrawide):

1. **Right file:** after scrolling to the bottom, `.footer-photo`'s
   `currentSrc` should be portrait-1766 on the phone and tablet, and
   full-1920, full-3840 and full-5120 on the others.
2. **Haze alignment:** hide the footer content and the scrim, then screenshot
   with the canvas visible and again with it at `opacity: 0`. Outside the
   horizon band the two are identical, and inside it they differ only by the
   shimmer. A large difference inside the band means the texture rows are wrong
   (see the gotcha in section 6).
3. **Rotation:** resize a portrait tablet viewport to landscape. The source
   switches to a full-frame file and the canvas follows it after `reload()`.
4. **Reduced motion:** the photo loads and the canvas never becomes
   `is-ready`.
5. **Nothing else moved:** compare full-page screenshots against master under
   `reducedMotion: 'reduce'`. Page height and every screen above the footer
   should match. The Quote section's background code snippets are random per
   load, so ignore differences there.

---

## 8. Flicker attempts that did *not* work

The flicker in question is on iOS Safari: the scrim gradient under the giant
name flickers on a momentum overscroll at the page's end. A dragged overscroll
is fine. None of these fixed it:

1. **Stable-size backdrop:** the fixed wrap sized `100lvh + 2 × --bg-overhang`
   and pulled up by the overhang (like the hero's `--bg-h`), so Safari's toolbar
   showing and hiding never resizes the scrim or re-allocates the canvas. It
   didn't fix it.
2. **Sticky instead of fixed:** the backdrop in a track inside the footer, as a
   `position: sticky; bottom` stage, with the footer on `overflow: clip`, so it
   rests in normal flow at the page's end. **It broke the page's display on the
   device.** Avoid it.
3. **`pointer-events: none` on the fixed backdrop**, to keep it out of Safari
   26's bottom-edge colour sampling. It didn't fix it.
4. **Pausing the haze's render loop while scrolled past the end** (detected as
   `scrollHeight − (scrollY + innerHeight) < −1`), to stop per-frame layer
   commits during the bounce. It didn't fix it.

What that rules out, roughly: the toolbar resizing the backdrop, the canvas's
per-frame redraws, and hit-test-based edge sampling of the backdrop.
Still-plausible causes include Safari's own scroll-edge shading under its
toolbar, and how WebKit composites a negative-z-index fixed layer beneath
transparent in-flow content during a rubber-band.
