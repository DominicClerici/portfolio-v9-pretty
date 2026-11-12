# Ink hero performance work: handoff

Temporary working note for continuing this on another machine. Delete it when the work lands.

Branch: `ink-hero-signal-footer`. The effect is the hero's ink fluid simulation, `src/scripts/ink-fluid.ts` (Astro 6, Tailwind 4, vanilla TS, WebGL2), mounted by `src/components/PinnedCanvas.astro`.

## Where things stand

Done and committed:

- The sheet wraps top to bottom; a finger can drag it; on touch devices the canvas is two frames tall (`--ink-tiles: 2`) and a compositor scroll timeline does the parallax (`ink-slide` in `src/styles/global.css`).
- Resolutions chosen by eye on a phone: pixel ratio capped at 1.5, ink grid 900 (desktop) / 800 (phone), water grid 144.
- A benchmark harness (below) and a baseline taken with it on the Mac.

Not started: the optimizations. The owner approved these six, in this order, and asked for each one to be (a) implemented, (b) checked to look the same, (c) benchmarked roughly, before moving to the next. Rough benchmarks are enough: the aim is to confirm each moves the right way, not to get a precise figure.

1. Stop splats being full-grid passes.
2. On touch, shade the display once and copy it to the second tile.
3. Fewer pressure passes, same solve.
4. Invalidate targets before full-target passes. (Item 5 in the original list.)
5. Load: one request instead of five. (Item 7.)
6. Move the ink to a worker with OffscreenCanvas. (Item 8.)

Left for the very end, after all of the above: strip the debug hooks (`?inkdebug`, `?inkbench`, `tune`, `probe`, the `performance.mark` calls, `ink-debug.ts`, `ink-bench.ts`, `ink-bench.mjs`, `ink-res-search.mjs`, this file).

Not approved, do not do: capping the simulation at 60 Hz on touch; dropping `powerPreference: "high-performance"`; replacing the procedural paper tooth with a noise texture.

## Rules the owner has set

- No optimization may change how the effect looks in any detectable way.
- Other work runs on the machine. Never assume it is quiet. GPU-time figures need a quiet machine: ask, and wait to be told it is quiet, before a long timing run. The exact counts and the "nothing shaded" ratio can be trusted at any time.
- Commit or push only when asked. Never delete files that this work did not create.
- No comments that restate the code. Comment only reasoning that cannot be inferred from it.
- The debug hooks stay until the last step.

## How a frame is built now

Per frame, 30 full-screen-triangle passes on RGBA16F targets:

- `stir()`: 2 brush splats, each a full ping-pong pass on the water grid and another on the ink grid (4 passes). A pointer stroke adds up to 10 more splats (20 more passes) in a frame; an opening drop adds 12.
- `step()`: curl, vorticity, divergence, scale (last frame's pressure × 0.8), 18 Jacobi pressure iterations, project, advect velocity, advect dye.
- `draw()`: the display pass to the canvas (5 dye taps, value noise and a hash from `gl_FragCoord`, two `exp` of a vec3).

## The harness

`ink-bench.mjs` (driver, repo root) and `src/scripts/ink-bench.ts` (in-page, loaded by `?inkbench`). The header comment in `ink-bench.mjs` documents the method in full.

```
pnpm build
node ink-bench.mjs                         # this build, desktop and phone-sized
node ink-bench.mjs --a <base dir> --b dist/client   # A/B against a saved build
node ink-bench.mjs --phone                 # serve it; a real phone opens the URL and posts results
  [--device desktop|phone|both] [--rounds 7] [--loads 5] [--save out.json] [--headed] [--chrome <path>]
```

What it reports, and how far to trust each:

- **Exact per-frame counts** (draws, GL calls, fragments shaded, texture reads, GPU memory). Always exact. This is the main evidence for items 1 to 3.
- **"With nothing shaded"**: the browser's cost of submitting the passes. Paired A/B ratio is good to about 1% even on a busy machine. Moves with pass count.
- **GPU time in "ref units"**: the frame's GPU time divided by a fixed reference workload's, measured with the GPU saturated. Only meaningful on a quiet machine; the tool warns when the spread is over 8% or under 4 rounds are valid. Same-build-against-itself read ×1.025 on the Mac, so a GPU change must be well beyond a few percent to count.
- **Load marks**: `ink:create`, `ink:built`, `ink:linked`, `ink:ready`, cold and warm, over `--loads` fresh profiles. The evidence for items 5 and 6.
- **Shipped script size** of the ink's chunk and its static imports.

A full 9-round A/B on both sizes takes over eight minutes. `--device desktop` or `--rounds 3` shortens it for the rough checks between steps.

### On the new machine first

1. `pnpm install && pnpm build`.
2. Copy `dist/client` at this commit to a folder outside the repo. That is the baseline build `A` for every later comparison.
3. Run `node ink-bench.mjs --a <that folder> --b dist/client` once (same build against itself) to learn this machine's noise.

The method was worked out on an M5 Mac (ANGLE on Metal). Things to check on Windows before trusting it:

- Headless Chrome must be using the real GPU, not SwiftShader. Check `chrome://gpu` or the `UNMASKED_RENDERER_WEBGL` string; if it is software, try `--headed`, or add `--use-angle=d3d11` / `--enable-gpu` to the launch flags in `ink-bench.mjs`.
- The driver's default Chrome path is per platform; pass `--chrome` if it is elsewhere.
- The GPU-saturation calibration (`prepare()` in `ink-bench.ts`) picks the smallest extra load that makes the frame GPU-bound. On a much faster or slower GPU, confirm rounds come back valid (`validRounds` in the report).
- Timer queries were unusable on Metal and are not used. Leave-one-out timing disturbs the flow and is not used either.
- Figures from the Mac are not comparable with figures from another machine. Only compare A and B on the same machine in the same run.

### Baseline on the Mac (M5), for orientation only

| | Desktop (1440×900@2) | Phone-sized (402×874@3, touch) |
|---|---|---|
| Buffer / ink grid | 2160×1350 / 1440×900 | 603×2982 / 800×1978 |
| Passes / GL calls per frame | 30 / 290 | 30 / 290 |
| Fragments shaded | 7.67M | 7.88M |
| Texture reads | 23.5M | 21.2M |
| GPU memory | 32.4 MB | 33.4 MB |
| Browser cost of the 30 passes | 0.63 ms | 0.68 ms |
| GPU time, ref units | about 0.60 | about 0.40 to 0.54 |
| Display pass share of GPU | about 64% | about 59% |
| Ink-grid splats | about 9% | about 12% |
| Ink advection | about 8% | about 14% |

Load, desktop, cold, least of 5: ink creation starts at 49 ms, ready at 99 ms; 9.5 ms blocks the page creating the context and queuing 9 shaders, 14 ms is the off-thread link wait, 1.6 ms is setup. Script: 19.1 KB raw, 7.6 KB brotli, in 5 files (PinnedCanvas 15,253; preload-helper 1,254; gl-program 691; gl-kit 1,444; layout-watch 476).

The phone-sized column is a phone's workload on the Mac's GPU. No real phone has been measured; `--phone` was verified only as far as serving the build and receiving a posted report.

## Checking that nothing looks different

There is no automated check for this yet; building one is the first job. A suggested approach: `ink.probe()` already hands out a `frame(dt)` that runs the simulation on demand with a fixed clock, so the result is deterministic for a given build. Run N frames with fixed `dt` in the baseline and the changed build, `readPixels` the canvas (or screenshot it over CDP), and diff. Items 1, 4, 5 and 6 should match to within half-float rounding; item 3 changes the order of floating-point operations, so expect tiny differences and judge by maximum per-channel error on the 8-bit output (0 or 1 levels). Item 2 changes the grain's position in the second tile by design (see below), so compare the first tile exactly and inspect the second by eye. Exercise a pointer stroke and the opening drops as well as the idle brushes. `ink-res-search.mjs` has screenshot-and-compare code (using `sharp`) that can be borrowed.

## Notes on each optimization

**1. Splats.** `splat()` in `ink-fluid.ts` reads the whole target and writes the whole other one, to add a Gaussian that is negligible outside a small disc. Options, in order of preference:

- Draw the splat additively (`gl.blendFunc(ONE, ONE)`) straight into the current read target, with the scissor set to the Gaussian's bounding box. No ping-pong, no texture read. Blending on RGBA16F needs nothing extra in WebGL2 (it is `EXT_float_blend` that 32F needs). Cut the box where the Gaussian is below what half-float can represent against typical values, and remember the sheet wraps vertically: a box that crosses the top or bottom edge needs a second scissored draw (or two rects). Alpha must stay 1: use `blendFuncSeparate(ONE, ONE, ZERO, ONE)`.
- Alternatively fold the two idle brushes into the advect shaders as uniforms, which removes their passes entirely but leaves pointer strokes and drops as they are.

Expected: idle frame loses 2.59M of 7.67M fragments on desktop and 4 texture-reading passes become 4 tiny draws; a fast pointer stroke stops costing up to 20 full passes. The bench labels draws `"<program>:<water|ink|screen>"` by viewport size, so check its labelling still makes sense once splats use a scissor.

**2. Second tile on touch.** With `tiles = 2` the display shader runs over a canvas two frames tall, showing the same dye twice. Shade one frame's height, then copy it to the other half. Two routes: render the display pass to an RGBA8 texture of one frame's size and `blitFramebuffer` it to the canvas twice; or shade the canvas's lower half and `blitFramebuffer` the canvas onto its own upper half (the regions do not overlap, but reading the canvas back can be costly on a tile-based GPU). Measure which is cheaper on a real phone. The catch: the paper tooth comes from `gl_FragCoord`, so today the grain differs between the two tiles, and after this it repeats once per frame height. The owner has accepted this item knowing that, but confirm by eye that the repeat cannot be seen while scrolling (the two copies are never on screen at the same time at the same place, only across the seam). If the buffer height is odd the seam must still land on a pixel boundary.

**3. Pressure.** Three independent changes, all meant to give the same solve:

- Two Jacobi iterations per pass: the pressure shader computes the result of two iterations at once from a 13-tap diamond (pressure at distance ≤ 2, divergence at distance ≤ 1). 18 passes become 9.
- Fold the `× 0.8` scale into the first iteration (a uniform that is 0.8 on the first pass and 1 after), removing the scale pass.
- Compute curl inside the vorticity shader (it needs the curl at 5 points, so 12 or so velocity taps) and drop the curl pass and its target.

30 passes become about 19. Pressure and divergence use NEAREST, and horizontal wrap is CLAMP_TO_EDGE while vertical is REPEAT: the two-step stencil must reproduce exactly what two single steps did at the left and right edges, where a clamped neighbour of a neighbour is not the same as a neighbour two away. Test the edges specifically.

**4. Invalidate.** Before a pass that overwrites a whole target, call `gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0])` (and `[gl.COLOR]` for the canvas) so a tile-based GPU does not load the old contents. This matters on phones and should be neutral on desktop; it needs a real-phone run to show anything. Once splats draw into part of a target (item 1), those draws must not be preceded by an invalidate.

**5. One request.** The ink's code arrives as a `PinnedCanvas` chunk plus four small static imports (`preload-helper`, `gl-program`, `gl-kit`, `layout-watch`), 19 KB in total. Get it into one request (Vite `manualChunks`, or inlining the small shared modules) or at least `modulepreload` them. Also `buildProgram` in `src/lib/gl-program.ts` compiles a fresh copy of the same vertex shader for each of the 9 programs: compile it once and share it. Note other scenes use `gl-kit` and `gl-program` too; check what else shares those chunks before merging them.

**6. Worker.** Move the simulation and drawing into a worker with `canvas.transferControlToOffscreen()`, so shader compilation and each frame's GL calls leave the main thread. Things to carry across: pointer and touch positions (post them, do not read the DOM in the worker), `getBoundingClientRect` of the canvas (measure on the main thread), scroll (`setScroll`), darkness, resize (the worker cannot read `clientWidth`; `fitCanvas` must be split), reduced motion, `--ink-tiles`. `requestAnimationFrame` exists in workers in Chrome, Safari 16.4+ and Firefox; keep the main-thread path as the fallback where `transferControlToOffscreen` is missing. With the compositor-driven slide on touch, a worker-drawn canvas presenting a frame late is harmless; on desktop the parallax shift is applied inside the simulation, so check scrolling stays in step. The bench drives the scene through `probe()` on the main thread and will need a path into the worker. Do this one last: it restructures the file the other items edit.

## Other suggestions made, for reference

Ordered by expected gain when first proposed: (1) bounded splats, (2) shade display once on touch, (3) fewer pressure passes, (4) 60 Hz simulation on touch, (5) invalidate, (6) drop `high-performance`, (7) one request and one vertex shader, (8) worker, (9) strip debug hooks.
