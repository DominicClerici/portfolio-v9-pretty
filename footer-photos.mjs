/*
 * Footer photo generator for dominicclerici.com.
 *
 * Cuts the footer's mountain backdrop (Mount Shuksan over Picture Lake) out of
 * the full-resolution source in photos-src/ and writes every size the page
 * serves into public/photos/, plus a manifest (src/data/footer-photo.json)
 * that Footer.astro builds its <picture> from and the heat haze maps its
 * shader through.
 *
 * The source is a 4:3 landscape photo, so it is cut two ways:
 *
 *   · landscape — for landscape screens, the whole photo. The footer pins it
 *     to its top centre (object-position), so a wide screen shows the peak
 *     and as much of the lake below it as its height allows, and a squarer
 *     one all of it. From 1280w up to the photo's full width.
 *   · portrait — for phones and portrait tablets, cropped only as far as it
 *     has to be for the lake to fill the bottom WATER_SHARE of a tall screen:
 *     the bottom of the photo is cut off, the top kept, and the sides trimmed
 *     to a 3:4 frame about the centre.
 *
 * Both are baked into the files rather than applied in CSS, so no pixels are
 * sent only to be cropped off screen.
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

const SOURCE = "photos-src/mountain.jpg"
const OUT_DIR = "public/photos"
const MANIFEST = "src/data/footer-photo.json"
const NAME = "footer-mountain"

// Portrait crop. SHORE_Y is where the lake meets the far shore, as a share
// of the photo's height from the top; the crop's bottom edge is set so the
// water below it fills WATER_SHARE of the frame, and its top is the photo's.
const SHORE_Y = 0.593
const WATER_SHARE = 0.35
// Width over height of the portrait cut: wide enough to cover a portrait
// tablet (3:4) as well as any phone, which shows the middle of it.
const PORTRAIT_ASPECT = 3 / 4

// Output widths. Landscape: 1x laptop up to a 5K ultrawide's 5120 device
// pixels. Portrait: roughly a portrait screen's height at 1x, 2x and 3x (as
// 3:4 widths), then the most there is for the tallest phones and portrait
// tablets (a 1023×1366 tablet at 2x wants ≈2050). Each is capped at the
// crop's native size.
const LANDSCAPE_WIDTHS = [1280, 1920, 2560, 3840, 5120]
const PORTRAIT_WIDTHS = [900, 1320, 1900, 2280]

const AVIF = { quality: 62, effort: 6 }
const WEBP = { quality: 84, effort: 6, smartSubsample: true }

const src = sharp(SOURCE)
const { width: W, height: H } = await src.metadata()

const whole = { left: 0, top: 0, width: W, height: H }

// Portrait crop, in source pixels
const cropH = Math.round((SHORE_Y / (1 - WATER_SHARE)) * H)
const cropW = Math.round(cropH * PORTRAIT_ASPECT)
if (cropH > H || cropW > W) {
  throw new Error("SHORE_Y/WATER_SHARE need more of the photo than there is")
}
const crop = {
  left: Math.round((W - cropW) / 2),
  top: 0,
  width: cropW,
  height: cropH,
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
  landscape: await renderSet("landscape", whole, LANDSCAPE_WIDTHS),
  portrait: await renderSet("portrait", crop, PORTRAIT_WIDTHS),
}

await mkdir("src/data", { recursive: true })
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote ${MANIFEST}`)
