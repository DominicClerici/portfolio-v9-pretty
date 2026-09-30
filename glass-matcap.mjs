/*
 * Matcap generator for the glass scene (src/scripts/glass-scene.ts).
 *
 * The sphere's image layer is a photo of a dark glossy ball (3000×2000, kept
 * in photos-src/, never deployed). The shader maps the *whole* photo onto
 * each sphere's disc — texture UV = normal.xy × 0.5 + 0.5 — so what matters
 * is the photo in UV space, not its pixel count or its 3:2 shape. This bakes
 * it into the square texture the shader actually samples: squeezed to
 * SIZE×SIZE (the same squeeze UV space already applies), downscaled with
 * Lanczos.
 *
 * SIZE is set by what can reach the screen, which is very little. The scene
 * pass draws into a quarter-resolution buffer (at most 1.5 dpr), and the
 * glass pass reads that through a 52 CSS px blur, so even the teal sphere on
 * a 4K screen — about 300px across in that buffer — shows no detail finer
 * than a twentieth of its width. Rendered through the real page (Playwright,
 * 2560×1440 at 1.5x down to a phone), every size from 512 down to 64 left the
 * frames within ±2 of 255 of the 3000×2000 original; 256 keeps twice what the
 * largest screen can show. The texture is mipmapped, so smaller spheres
 * sample it filtered rather than picking scattered texels of it.
 *
 * At this size the AVIF is ~1.7KB, less than a request's own overhead, so
 * glass-scene.ts inlines it (?inline) rather than fetching it.
 *
 * Usage:
 *     pnpm photos:matcap     # after changing the source or anything below
 */

import sharp from "sharp"

const SOURCE = "photos-src/glass-matcap.avif"
const OUT = "src/assets/glass-matcap.avif"
const SIZE = 256
// Well past what the blur leaves visible; q60 rendered identically too.
const AVIF = { quality: 75, effort: 9, chromaSubsampling: "4:4:4" }

const { size } = await sharp(SOURCE)
  .resize(SIZE, SIZE, { fit: "fill", kernel: "lanczos3" })
  .avif(AVIF)
  .toFile(OUT)
console.log(`${OUT}  ${SIZE}×${SIZE}  ${(size / 1024).toFixed(1)} KB`)
