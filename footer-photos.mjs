/*
 * Footer photo generator for dominicclerici.com.
 *
 * Cuts the footer's mountain backdrop (Mount Shuksan over Picture Lake) out of
 * the full-resolution source in photos-src/ and writes every size the page
 * serves into src/assets/footer/, plus a manifest (src/data/footer-photo.json)
 * that Footer.astro builds its <picture> from and the heat haze maps its
 * shader through. Kept in src/ rather than public/ so the build emits them
 * under /_astro/ with a content hash in the name, where they are served as
 * immutable and cached for a year.
 *
 * The source is a 4:3 landscape photo. The footer shows it cover-fitted to a
 * screen-tall frame, so a screen of any other shape sees only part of it, and
 * each cut below is only as much of the photo as the screens it is served to
 * can show:
 *
 *   · landscape — the whole photo, for landscape screens squarer than 16:9.
 *     The footer pins it to its top centre (object-position), so a 16:10
 *     screen shows the peak and as much of the lake below it as its height
 *     allows, and a 4:3 one all of it. From 1280w up to the photo's full
 *     width.
 *   · wide — its top 16:9, for desktop screens at least that wide (nearly
 *     every desktop browser window), which show no more of it than that. The
 *     bottom of the lake is never on screen there, so it isn't sent.
 *   · portrait — for portrait tablets (and phones wider than 9:16), cropped
 *     only as far as it has to be for the lake to fill the bottom WATER_SHARE
 *     of a tall screen: the bottom of the photo is cut off, the top kept,
 *     and the sides trimmed to a 3:4 frame about the centre. Phones show it
 *     without a scrim, so a faint dark fade (PORTRAIT_FADE) is baked into its
 *     bottom to keep the name and the copyright line legible over the lake's
 *     bright reflection. Baked in rather than laid over in CSS, the heat
 *     haze, which redraws the lake from these pixels, carries it too.
 *   · phone — the middle 9:16 of the portrait cut, fade and all: exactly the
 *     part of it a phone screen shows, as the cover fit scales it to the
 *     screen's height and centres it.
 *
 * All of it is baked into the files rather than applied in CSS, so no pixels
 * are sent only to be cropped off screen.
 *
 * Each size is written as AVIF and as WebP (the fallback). Both are
 * downscaled from the source with Lanczos. The encoder settings sit at the
 * knee of the photo's size/quality curve (measured with SSIMULACRA2): the
 * lake and the tree line are dense fine texture, and below these the texture
 * visibly softens faster than the files shrink. AVIF keeps full-resolution
 * chroma (4:4:4), which at this size scores better than 4:2:0 at a higher
 * quality.
 *
 * The widths step closely enough that the browser's pick (the first at or
 * above what the screen needs) is never far over: a 1440-wide retina laptop
 * takes 3024w, not 3840w.
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
const OUT_DIR = "src/assets/footer"
const MANIFEST = "src/data/footer-photo.json"
const NAME = "footer-mountain"

// Portrait crop. SHORE_Y is where the lake meets the far shore, as a share
// of the photo's height from the top; the crop's bottom edge is set so the
// water below it fills WATER_SHARE of the frame, and its top is the photo's.
const SHORE_Y = 0.593
const WATER_SHARE = 0.25
// The fade at the portrait cut's foot: clear down to `from` (a share of the
// cut's height, here just above the water), easing to `alpha` of the site's
// ink (rgb 10 10 10) at the bottom edge, gently at first.
const PORTRAIT_FADE = { from: 0.7, alpha: 0.5, ease: 1.6 }
// Width over height of the portrait cut: wide enough to cover a portrait
// tablet (3:4) as well as any phone, which shows the middle of it.
const PORTRAIT_ASPECT = 3 / 4
// The phone cut's width over height, and the wide cut's. Each is served only
// to screens at least that narrow (phone) or wide (wide), in the media
// queries Footer.astro pairs them with.
const PHONE_ASPECT = 9 / 16
const WIDE_ASPECT = 16 / 9

// Output widths, each capped at its cut's native size. Landscape and wide:
// the common laptop and desktop widths at 1x and 2x (1280, 1440, 1512 and
// 1728 at 2x among them), then 4K and up to the photo's full 4340. Portrait:
// portrait tablets at 1x and 2x (a 1024×1366 iPad Pro wants ≈2050, more than
// there is). Phone: a phone's height × 9/16 at about 2x and 3x, where most
// take the full cut.
const LANDSCAPE_WIDTHS = [1280, 1600, 1920, 2560, 3024, 3456, 3840, 5120]
const PORTRAIT_WIDTHS = [900, 1320, 1800, 2280]
const PHONE_WIDTHS = [720, 1080, 1280, 1600]

// How many of the source's top rows the sky colour is averaged over
const SKY_ROWS = 24

const AVIF = { quality: 62, effort: 6, chromaSubsampling: "4:4:4" }
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
// The phone cut: the portrait crop's middle, at its full height
const phoneW = Math.round(cropH * PHONE_ASPECT)
const phone = { ...crop, left: Math.round((W - phoneW) / 2), width: phoneW }
// The wide cut: the photo's top, at its full width
const wide = { ...whole, height: Math.round(W / WIDE_ASPECT) }

// Clear out earlier renders so resized or renamed sets don't linger.
await mkdir(OUT_DIR, { recursive: true })
for (const f of await readdir(OUT_DIR)) {
  if (f.startsWith(`${NAME}-`) || f.startsWith(`${NAME}.`)) {
    await rm(`${OUT_DIR}/${f}`)
  }
}

// A full-size cut of the source with a fade darkening its foot, as raw
// pixels to resize from. (Sharp composites after it resizes, so the fade is
// laid on at full size first.)
async function faded(region, { from, alpha, ease }) {
  const stops = Array.from({ length: 11 }, (_, i) => {
    const k = i / 10
    return `<stop offset="${from + (1 - from) * k}" stop-color="rgb(10,10,10)" stop-opacity="${(alpha * k ** ease).toFixed(4)}"/>`
  }).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(10,10,10)" stop-opacity="0"/>${stops}</linearGradient></defs><rect width="100%" height="100%" fill="url(#f)"/></svg>`
  const { data, info } = await sharp(SOURCE)
    .extract(region)
    .composite([{ input: Buffer.from(svg) }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return () => sharp(data, { raw: info })
}

async function renderSet(label, region, widths, fade) {
  const cut = fade ? await faded(region, fade) : () => sharp(SOURCE).extract(region)
  const sizes = [...new Set(widths.map((w) => Math.min(w, region.width)))]
  const set = { avif: [], webp: [] }
  for (const w of sizes) {
    const base = cut().resize({ width: w, kernel: "lanczos3" })
    for (const [fmt, opts] of [
      ["avif", AVIF],
      ["webp", WEBP],
    ]) {
      const file = `${NAME}-${label}-${w}.${fmt}`
      const { size } = await base.clone()[fmt](opts).toFile(`${OUT_DIR}/${file}`)
      set[fmt].push([file, w])
      console.log(`${file.padEnd(38)} ${(size / 1024).toFixed(0).padStart(5)} KB`)
    }
  }
  // The sky at the cut's top edge, averaged along it: the colour the footer
  // carries the photo on with, up past the top of the screen
  const { data: row } = await sharp(SOURCE)
    .extract({ ...region, height: SKY_ROWS })
    .resize({ width: 1, height: 1, kernel: "lanczos3", fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const sky = "#" + [...row.subarray(0, 3)].map((c) => c.toString(16).padStart(2, "0")).join("")
  // 24px blur-up, shown until the real photo arrives
  const tiny = await cut()
    .resize({ width: region.width >= region.height ? 24 : 18 })
    .webp({ quality: 60 })
    .toBuffer()
  return {
    // Where this cut sits in the full photo, as UV (x, y, width, height)
    rect: [region.left / W, region.top / H, region.width / W, region.height / H],
    width: region.width,
    height: region.height,
    // [file, width] pairs; Footer.astro turns them into srcsets
    avif: set.avif,
    webp: set.webp,
    placeholder: `data:image/webp;base64,${tiny.toString("base64")}`,
    sky,
  }
}

const manifest = {
  landscape: await renderSet("landscape", whole, LANDSCAPE_WIDTHS),
  wide: await renderSet("wide", wide, LANDSCAPE_WIDTHS),
  portrait: await renderSet("portrait", crop, PORTRAIT_WIDTHS, PORTRAIT_FADE),
  phone: await renderSet("phone", phone, PHONE_WIDTHS, PORTRAIT_FADE),
}

await mkdir("src/data", { recursive: true })
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote ${MANIFEST}`)
