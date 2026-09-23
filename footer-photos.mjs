/*
 * Footer photo generator for dominicclerici.com.
 *
 * Cuts the footer's Yosemite backdrop out of the full-resolution source in
 * photos-src/ and writes every size the page serves into public/photos/, plus
 * a manifest (src/data/footer-photo.json) that Footer.astro builds its
 * <picture> from and the heat haze maps its shader through.
 *
 * Two cuts:
 *
 *   · full — the whole frame, for landscape screens, from 1280w up to 5120w
 *     so 4K and 5K (ultrawide included) monitors get a pixel per pixel.
 *   · portrait — for phones and portrait tablets, where a landscape photo
 *     cover-fitted to a tall screen would otherwise be shown as a thin middle
 *     slice. It is zoomed ZOOM× into the centre of the frame, then moved
 *     SHIFT of the screen's height down, and baked into the file rather than
 *     applied in CSS, so none of the source's pixels go to waste: the largest
 *     portrait size is the crop at the source's own resolution.
 *
 * Each size is written as AVIF and as WebP (the fallback). Both are
 * downscaled from the source with Lanczos and encoded at settings chosen to
 * stay visually lossless on the photo's smooth sky, where banding would show
 * first.
 *
 * The source stays in photos-src/ (never deployed), so the crop can be
 * re-cut from the original at any time.
 *
 * Usage:
 *     pnpm photos:footer     # after changing the source or anything below
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import sharp from "sharp"

const SOURCE = "photos-src/yosemite.jpg"
const OUT_DIR = "public/photos"
const MANIFEST = "src/data/footer-photo.json"
const NAME = "footer-yosemite"

// Portrait crop, relative to the full photo cover-fitted to a tall screen:
// zoomed into its centre, then moved down by a share of the screen's height.
const ZOOM = 1.2
const SHIFT = 0
// Width over height of the portrait cut: wide enough to cover a portrait
// tablet (3:4) as well as any phone, which shows the middle of it.
const PORTRAIT_ASPECT = 3 / 4

// Output widths. Full: 1x laptop up to a 5K ultrawide's 5120 device pixels.
// Portrait: roughly a portrait screen's height at 1x, 2x and 3x (as 3:4
// widths), then the crop's native size for the tallest phones and tablets.
const FULL_WIDTHS = [1280, 1920, 2560, 3840, 5120]
const PORTRAIT_WIDTHS = [900, 1320, 1900, Infinity]

const AVIF = { quality: 62, effort: 6 }
const WEBP = { quality: 84, effort: 6, smartSubsample: true }

const src = sharp(SOURCE)
const { width: W, height: H } = await src.metadata()

// Portrait crop, in source pixels. The screen shows 1/ZOOM of the photo's
// height; the zoom about the centre puts the top of that window at
// (ZOOM − 1) / 2 of the zoomed photo, and the shift pulls it back up by SHIFT
// of the screen.
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

// Clear out earlier renders so resized or renamed sets don't linger.
await mkdir(OUT_DIR, { recursive: true })
for (const f of await readdir(OUT_DIR)) {
  if (f.startsWith(`${NAME}-`) || f.startsWith(`${NAME}.`)) {
    await rm(`${OUT_DIR}/${f}`)
  }
}

async function renderSet(label, region, widths) {
  const sizes = [...new Set(widths.map((w) => Math.min(w, region.width)))]
  const set = { avif: [], webp: [] }
  for (const w of sizes) {
    const base = sharp(SOURCE)
      .extract(region)
      .resize({ width: w, kernel: "lanczos3" })
    for (const [fmt, opts] of [
      ["avif", AVIF],
      ["webp", WEBP],
    ]) {
      const file = `${NAME}-${label}-${w}.${fmt}`
      const { size } = await base.clone()[fmt](opts).toFile(`${OUT_DIR}/${file}`)
      set[fmt].push(`/photos/${file} ${w}w`)
      console.log(`${file.padEnd(38)} ${(size / 1024).toFixed(0).padStart(5)} KB`)
    }
  }
  // 24px blur-up, shown until the real photo arrives
  const tiny = await sharp(SOURCE)
    .extract(region)
    .resize({ width: region.width >= region.height ? 24 : 18 })
    .webp({ quality: 60 })
    .toBuffer()
  return {
    // Where this cut sits in the full photo, as UV (x, y, width, height)
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

await mkdir("src/data", { recursive: true })
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote ${MANIFEST}`)
