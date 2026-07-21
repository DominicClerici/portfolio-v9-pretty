// Shared geometry for the Work section's shaped windows ("doors").
//
// Each project's window is a small figure of sub-shapes — Dispatch a rounded
// diamond (two on mobile), Meridian a grid of circles, Fuzzbox a stack of
// bars. One parametric definition feeds three consumers:
//
//   1. Build time (Work.astro frontmatter): an SVG data-URI mask for the
//      static window, and per-sub boxes for the halo outlines.
//   2. Runtime (Work.astro script): per-frame `clip-path: path(...)` values
//      for the walk-through-the-door portal. Multi-part figures can't be
//      expressed as CSS-interpolable basic shapes, so the door animation is
//      rAF-driven off these same primitives.
//   3. The Learn more glyph, which reuses the mask at icon size.
//
// All variants are authored in a unit box 100 wide by `h` tall (aspect =
// 100 / h); consumers scale into their own pixel box.

export type ShapeId = "diamond" | "circles" | "bars";

export type Sub =
  | { kind: "rrect"; cx: number; cy: number; w: number; h: number; r: number; rot: number }
  | { kind: "circle"; cx: number; cy: number; r: number };

export type Variant = { h: number; subs: Sub[] };
export type Shape = { desktop: Variant; mobile: Variant };

// A square rotated 45° whose horizontal extent (diagonal) is `extent`
const diamond = (cx: number, cy: number, extent: number): Sub => {
  const side = extent / Math.SQRT2;
  return { kind: "rrect", cx, cy, w: side, h: side, r: side * 0.17, rot: 45 };
};

const circle = (cx: number, cy: number, r: number): Sub => ({ kind: "circle", cx, cy, r });

const barStack = (n: number, h: number, gap: number, r: number): Variant => {
  const bh = (h - gap * (n - 1)) / n;
  return {
    h,
    subs: Array.from({ length: n }, (_, i) => ({
      kind: "rrect" as const,
      cx: 50,
      cy: bh / 2 + i * (bh + gap),
      w: 100,
      h: bh,
      r: Math.min(r, bh / 2),
      rot: 0,
    })),
  };
};

const circleGrid = (cols: number, rows: number, gap: number): Variant => {
  const d = (100 - gap * (cols - 1)) / cols;
  const r = d / 2;
  const at = (i: number) => r + i * (d + gap);
  const subs: Sub[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) subs.push(circle(at(col), at(row), r));
  return { h: rows * d + gap * (rows - 1), subs };
};

export const SHAPES: Record<ShapeId, Shape> = {
  diamond: {
    desktop: { h: 100, subs: [diamond(50, 50, 100)] },
    mobile: {
      h: 48.5,
      subs: [diamond(24.25, 24.25, 48.5), diamond(75.75, 24.25, 48.5)],
    },
  },
  circles: {
    desktop: circleGrid(2, 2, 5),
    mobile: circleGrid(4, 2, 4),
  },
  bars: {
    desktop: barStack(4, 119, 6, 7),
    mobile: barStack(3, 70, 5, 5),
  },
};

const F = (n: number) => String(Math.round(n * 100) / 100);

const rrectPath = (s: Extract<Sub, { kind: "rrect" }>): string => {
  const a = (s.rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const r = Math.max(0, Math.min(s.r, s.w / 2, s.h / 2));
  const hw = s.w / 2;
  const hh = s.h / 2;
  // Corner points in local coords, rotated then translated; the corner arcs
  // stay circular under rotation, so plain A commands survive the transform
  const P = (x: number, y: number) => `${F(s.cx + x * cos - y * sin)} ${F(s.cy + x * sin + y * cos)}`;
  const A = (x: number, y: number) => `A ${F(r)} ${F(r)} 0 0 1 ${P(x, y)}`;
  return (
    `M ${P(-hw + r, -hh)} L ${P(hw - r, -hh)} ${A(hw, -hh + r)} ` +
    `L ${P(hw, hh - r)} ${A(hw - r, hh)} ` +
    `L ${P(-hw + r, hh)} ${A(-hw, hh - r)} ` +
    `L ${P(-hw, -hh + r)} ${A(-hw + r, -hh)} Z`
  );
};

const circlePath = (s: Extract<Sub, { kind: "circle" }>): string =>
  `M ${F(s.cx + s.r)} ${F(s.cy)} ` +
  `A ${F(s.r)} ${F(s.r)} 0 1 0 ${F(s.cx - s.r)} ${F(s.cy)} ` +
  `A ${F(s.r)} ${F(s.r)} 0 1 0 ${F(s.cx + s.r)} ${F(s.cy)} Z`;

export const pathOf = (subs: Sub[]): string =>
  subs.map((s) => (s.kind === "circle" ? circlePath(s) : rrectPath(s))).join(" ");

/** Unit-space subs mapped into a pixel box at (dx, dy). Sizes scale off the
 *  width so a slightly-off box aspect can never skew a rotated sub. */
export const subsInBox = (v: Variant, w: number, h: number, dx = 0, dy = 0): Sub[] => {
  const kx = w / 100;
  const ky = h / v.h;
  return v.subs.map((s) =>
    s.kind === "circle"
      ? { kind: "circle", cx: dx + s.cx * kx, cy: dy + s.cy * ky, r: s.r * kx }
      : { ...s, cx: dx + s.cx * kx, cy: dy + s.cy * ky, w: s.w * kx, h: s.h * kx, r: s.r * kx },
  );
};

// ── Halo outlines ──
// The outlines used to be the whole figure under a transform scale, which
// multiplies the gaps between sub-shapes along with the sub-shapes
// themselves — on a figure of several small parts the outline ends up
// floating somewhere inside the window instead of tracing its edge. They are
// now one element per sub, inflated by a flat number of pixels in CSS (see
// .we1-ringp), which is the only way the gap can read the same on every edge
// of every part: an offset baked into this unit space would shrink with the
// plate, and the plate's rendered width isn't known here.

export type RingBox = { x: number; y: number; w: number; h: number; r: number; rot: number };

/** Each sub as a plain box in unit space, for the halo outlines. Circles come
 *  through as squares with a half-width radius — a border-radius rounds them
 *  right back into circles once CSS has added its pixel inset. */
export const ringBoxes = (v: Variant): RingBox[] =>
  v.subs.map((s) =>
    s.kind === "circle"
      ? { x: s.cx, y: s.cy, w: s.r * 2, h: s.r * 2, r: s.r, rot: 0 }
      : { x: s.cx, y: s.cy, w: s.w, h: s.h, r: s.r, rot: s.rot },
  );

export const lerpSubs = (from: Sub[], to: Sub[], t: number): Sub[] =>
  from.map((a, i) => {
    const b = to[i];
    if (a.kind === "circle" && b.kind === "circle")
      return {
        kind: "circle" as const,
        cx: a.cx + (b.cx - a.cx) * t,
        cy: a.cy + (b.cy - a.cy) * t,
        r: a.r + (b.r - a.r) * t,
      };
    if (a.kind === "rrect" && b.kind === "rrect")
      return {
        kind: "rrect" as const,
        cx: a.cx + (b.cx - a.cx) * t,
        cy: a.cy + (b.cy - a.cy) * t,
        w: a.w + (b.w - a.w) * t,
        h: a.h + (b.h - a.h) * t,
        r: a.r + (b.r - a.r) * t,
        rot: a.rot + (b.rot - a.rot) * t,
      };
    return a;
  });

/** Grown copies of `subs` (viewport-space) whose union covers the whole
 *  viewport — the open-door end state. Diamonds and circles grow in place;
 *  bars fatten into overlapping full-width bands, so their gaps close early
 *  in the run rather than at the last frame. */
export const expandTargets = (id: ShapeId, subs: Sub[], vw: number, vh: number): Sub[] => {
  const corners: [number, number][] = [
    [0, 0],
    [vw, 0],
    [0, vh],
    [vw, vh],
  ];

  if (id === "bars") {
    const band = vh / subs.length;
    const over = band * 0.5;
    return subs.map((s, i) =>
      s.kind === "rrect"
        ? {
            ...s,
            cx: vw / 2,
            cy: (i + 0.5) * band,
            // Bleed past every screen edge so the rounded corners never
            // notch into the visible frame
            w: vw + 2 * (s.r + 40),
            h: band + 2 * over,
          }
        : s,
    );
  }

  return subs.map((s) => {
    if (s.kind === "circle") {
      let r = 0;
      for (const [x, y] of corners) r = Math.max(r, Math.hypot(x - s.cx, y - s.cy));
      return { ...s, r: r + 24 };
    }
    // Rotated rect: needed half-extent is the farthest corner measured in
    // the rect's own (rotated) frame; grow uniformly about the center
    const a = (s.rot * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    let need = 0;
    for (const [x, y] of corners) {
      const dx = x - s.cx;
      const dy = y - s.cy;
      need = Math.max(need, Math.abs(dx * cos + dy * sin), Math.abs(-dx * sin + dy * cos));
    }
    // 15% proportional headroom on top of the flat margin: the corner
    // radius grows with the figure, and its cut near the local diagonal
    // must never reach a viewport corner
    const k = ((need * 2 + 48) / Math.min(s.w, s.h)) * 1.15;
    return { ...s, w: s.w * k, h: s.h * k, r: s.r * k };
  });
};

export const maskUri = (v: Variant): string => {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 ${F(v.h)}' ` +
    `preserveAspectRatio='none'><path d='${pathOf(v.subs)}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

/** css cubic-bezier(), solved for y at a given x (Newton + bisection). */
export const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sampleX(t) - x;
      if (Math.abs(e) < 1e-6) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      if (sampleX(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
};
