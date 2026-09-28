import juniorLogo from "../assets/logos/junior.svg?raw";
import rumorLogo from "../assets/logos/rumor.svg?raw";
import squibLogo from "../assets/logos/squib.svg?raw";
import artesianLogo from "../assets/logos/artesian-builds.svg?raw";
import mcdonaldsLogo from "../assets/logos/mcdonalds.svg?raw";
import type { LogoPaint } from "../scripts/logo-morph";

// Career entries, newest first, for the Career section.
//
// `accent` is the UI-side partner of the company's orb in PinnedCanvas.astro:
// the same hue, lifted until it reads as a line or a label on near-black.
// The section blends between them as the scroll pin moves entry to entry, so
// the foreground picks up the colour the background is already carrying.

// Dates are "YYYY-MM" and inclusive: an entry runs from the start of its
// first month to the end of its last. No `end` means it's the current job,
// and runs to today.
//
// `logo` is the company's mark as SVG markup: one path, filled even-odd, set
// to fill a 100×100 box (see the note in Career.astro on how they morph).
// Its fill is a flat colour or a linear gradient in the box's own units
// (gradientUnits="userSpaceOnUse"), which the morph reads back via logoPaint.
export interface CareerEntry {
  period: string;
  start: string;
  end?: string;
  lane: number;
  company: string;
  title: string;
  description: string;
  skills: string[];
  tags: string[];
  url: string;
  accent: string;
  logo: string;
}

export const entries: CareerEntry[] = [
  {
    period: "2026 — Now",
    start: "2026-09",
    lane: 0,
    company: "Junior",
    title: "Software Engineer",
    description:
      "Junior records expert calls for private equity and consulting firms and turns them into transcripts analysts can search. I'm in the New York office, split between the pipeline that cleans up the audio and the app people read the output in. Getting a number wrong matters here — someone is pricing a deal off it.",
    skills: ["Full Stack", "Applied AI", "Knowledge Graphs"],
    tags: [
      "Python",
      "TypeScript",
      "Rust",
      "PostgreSQL",
      "AI/ML",
      "Diarization",
    ],
    url: "https://junior.ai/",
    accent: "#508DE3",
    logo: juniorLogo,
  },
  {
    period: "2025 — 2026",
    start: "2025-08",
    end: "2026-08",
    lane: 0,
    company: "Rumor",
    title: "Full Stack Developer",
    description:
      "Built the platform behind Rumor — a private network connecting people to exclusive cultural events. Most of my time went to the host dashboard and the mobile apps: event creation, guest management, and the analytics that sit on top of both. Small team, so I touched most of the stack, from the database layer up to what users see on their phones.",
    skills: ["Full Stack", "Mobile", "Cloud Infrastructure"],
    tags: [
      "TypeScript",
      "PostgreSQL",
      "AWS Lambda",
      "Next.js",
      "React Native",
      "Swift",
    ],
    url: "https://www.therumor.com/",
    accent: "#FFE786",
    logo: rumorLogo,
  },
  {
    period: "2024 — 2025",
    start: "2024-12",
    end: "2025-10",
    lane: 1,
    company: "Squib",
    title: "Founding Engineer",
    description:
      "First engineer at an AI research lab building autonomous agents that model human behavior. I helped build Persona, a product that creates AI-powered social profiles — digital twins that grow audiences and predict how communities will respond before a campaign launches. Tiny team at the time, so I'd be deep in agent architecture one week and building the product UI the next.",
    skills: ["AI/ML", "Autonomous Agents", "Growth Engineering"],
    tags: ["Go", "TypeScript", "Python", "PostgreSQL"],
    url: "https://www.heysquib.com/",
    accent: "#C97DFF",
    logo: squibLogo,
  },
  {
    period: "2021 — 2022",
    start: "2021-05",
    end: "2022-03",
    lane: 0,
    company: "Artesian Builds",
    title: "Full Stack Developer",
    description:
      "Helped overhaul the company website — better design, tighter SEO, load times dropped about 40%. Also built internal tools for tracking sponsorship metrics and Twitch creator stats, which gave management real numbers instead of gut feelings. First job where I shipped things real people used, which changes how carefully you write everything after.",
    skills: ["Full Stack", "Internal Tooling", "SEO", "Data Analysis"],
    tags: ["WordPress", "Elementor", "Electron", "Python", "PostgreSQL"],
    url: "https://en.wikipedia.org/wiki/Artesian_Builds",
    accent: "#5C92FF",
    logo: artesianLogo,
  },
  {
    period: "2020",
    start: "2020-04",
    end: "2020-07",
    lane: 0,
    company: "McDonald's",
    title: "Crew Member",
    description:
      "Got me my first car at 16 — a '93 Miata with 220k miles on it. I still think about that car more than I probably should.",
    skills: ["Deep Fryer", "Cash Register", "Drive-Thru", "Customer Service"],
    tags: ["Ice Cream Machine (Broken)", "McFlurry Assembly", "Headset Comms"],
    url: "https://www.mcdonalds.com/us/en-us.html",
    accent: "#ffc83d",
    logo: mcdonaldsLogo,
  },
];

// Time axis ------------------------------------------------------------------
// Positions on the axis are "years": fractional years, so May 2021 is 2021.33.

const ym = (s: string) => {
  const [y, m] = s.split("-").map(Number);
  return y + (m - 1) / 12;
};

// Today as a year. The axis runs up to it, so the current job keeps growing
// without anyone touching this file; the page works it out again on load.
export const nowYear = (d = new Date()) => {
  const y = d.getFullYear();
  const t0 = new Date(y, 0, 1).getTime();
  const t1 = new Date(y + 1, 0, 1).getTime();
  return y + (d.getTime() - t0) / (t1 - t0);
};

export const startOf = (e: CareerEntry) => ym(e.start);
// The current job runs to today, but always shows at least its first month,
// however the visitor's clock is set.
export const endOf = (e: CareerEntry, now: number) =>
  e.end ? ym(e.end) + 1 / 12 : Math.max(now, ym(e.start) + 1 / 12);

// The axis is not linear in time. The oldest entries get set widths, each
// with a set gap after it, so short early jobs and the years between them
// don't crowd out the recent ones:
const FIXED: [bar: number, gap: number][] = [
  [8, 3], // McDonald's
  [15, 4], // Artesian Builds
];
// Everything after them (Squib, Rumor, Junior) shares what's left of the axis
// in proportion to time, up to today, so as the current job runs on it
// widens and the others narrow to make room.
//
// That makes the axis piecewise linear between [year, %] knots. Every
// placement on it (bars, year marks, playhead, read-out) goes through the
// same mapping. Scroll per entry doesn't depend on it; only where things sit,
// and so how fast the playhead travels between them.
const knotsAt = (now: number) => {
  const oldest = ordered.map(({ entry }) => entry);
  const k: [number, number][] = [];
  let x = 0;
  FIXED.forEach(([bar, gap], j) => {
    k.push([startOf(oldest[j]), x], [endOf(oldest[j], now), x + bar]);
    x += bar + gap;
  });
  const rest = oldest.slice(FIXED.length);
  k.push(
    [startOf(rest[0]), x],
    [Math.max(...rest.map((e) => endOf(e, now))), 100],
  );
  return k;
};

// Piecewise-linear lookup along one column of the knots into the other;
// clamps outside the range.
const warp = (k: [number, number][], v: number, from: 0 | 1) => {
  const to = from === 0 ? 1 : 0;
  if (v <= k[0][from]) return k[0][to];
  for (let j = 1; j < k.length; j++) {
    if (v <= k[j][from]) {
      const a = k[j - 1];
      const b = k[j];
      return a[to] + ((v - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
    }
  }
  return k[k.length - 1][to];
};

// Year marks. Squeezed stretches put some years only a few percent apart, so
// a year is only marked if it clears the marks already placed, newest first.
// The ends are always marked: the year the axis starts in, and "Now".
const MIN_MARK_GAP = 7;

export interface Axis {
  /** year -> % along the axis */
  pct: (v: number) => number;
  /** % along the axis -> year */
  year: (p: number) => number;
  /** left/width of an entry's bar, in % */
  bar: (e: CareerEntry) => { left: number; width: number };
  marks: { pct: number; label: string }[];
}

export const axisAt = (now: number): Axis => {
  const k = knotsAt(now);
  const pct = (v: number) => warp(k, v, 0);
  const year = (p: number) => warp(k, p, 1);
  const first = k[0][0];
  const end = k[k.length - 1][0];

  const kept = [0, 100];
  const years: number[] = [];
  for (let y = Math.floor(end); y > first; y--) {
    const p = pct(y);
    if (kept.every((q) => Math.abs(q - p) >= MIN_MARK_GAP)) {
      kept.push(p);
      years.push(y);
    }
  }
  const short = (y: number) => `'${String(y).slice(2)}`;
  const marks = [
    { pct: 0, label: short(Math.floor(first)) },
    ...years.reverse().map((y) => ({ pct: pct(y), label: short(y) })),
    { pct: 100, label: "Now" },
  ];

  const bar = (e: CareerEntry) => {
    const left = pct(startOf(e));
    return { left, width: pct(endOf(e, now)) - left };
  };
  return { pct, year, bar, marks };
};

// The path data out of an entry's logo markup.
export const logoPath = (e: CareerEntry) => /\sd="([^"]+)"/.exec(e.logo)![1];

// The logo's fill as a gradient line in its 100×100 box. A flat fill is a
// gradient of one colour.
export const logoPaint = (e: CareerEntry): LogoPaint => {
  const g = /<linearGradient([^>]*)>(.*?)<\/linearGradient>/.exec(e.logo);
  if (!g) {
    const c = /fill="(#[0-9a-fA-F]{6})"/.exec(e.logo)![1];
    return { from: [0, 0], to: [100, 100], stops: [[0, c]] };
  }
  const at = (name: string, fallback: number) =>
    +(new RegExp(`\\s${name}="([^"]+)"`).exec(g[1])?.[1] ?? fallback);
  return {
    from: [at("x1", 0), at("y1", 0)],
    to: [at("x2", 100), at("y2", 0)],
    stops: [...g[2].matchAll(/<stop([^>]*)\/>/g)].map(([, a]) => [
      +(/offset="([^"]+)"/.exec(a)?.[1] ?? 0),
      /stop-color="([^"]+)"/.exec(a)![1],
    ]),
  };
};

// "2026-09" -> "Sep 2026"
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
export const monthYear = (s: string) => {
  const [y, m] = s.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

// Scroll order is oldest-first; each keeps its original index `i`, which is
// what data-select / data-panel attributes key off.
export const ordered = entries.map((entry, i) => ({ entry, i })).reverse();
