// Career entries, newest first, for the Career section.
//
// `accent` is the UI-side partner of the company's orb in PinnedCanvas.astro:
// the same hue, lifted until it reads as a line or a label on near-black.
// The section blends between them as the scroll pin moves entry to entry, so
// the foreground picks up the colour the background is already carrying.

export const RANGE_START = 2019;
export const RANGE_END = 2027;
export const SPAN = RANGE_END - RANGE_START;

export interface CareerEntry {
  period: string;
  start: number;
  end: number;
  lane: number;
  now: boolean;
  company: string;
  title: string;
  description: string;
  skills: string[];
  tags: string[];
  url: string;
  accent: string;
}

export const entries: CareerEntry[] = [
  {
    period: "2026 — Now",
    start: 2026.67,
    end: 2027,
    lane: 0,
    now: true,
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
    accent: "#3fe0c5",
  },
  {
    period: "2025 — 2026",
    start: 2025,
    end: 2026.65,
    lane: 0,
    now: false,
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
    accent: "#dcb563",
  },
  {
    period: "2024 — 2026",
    start: 2024,
    end: 2026,
    lane: 1,
    now: false,
    company: "Squib",
    title: "Founding Engineer",
    description:
      "First engineer at an AI research lab building autonomous agents that model human behavior. I helped build Persona, a product that creates AI-powered social profiles — digital twins that grow audiences and predict how communities will respond before a campaign launches. Tiny team at the time, so I'd be deep in agent architecture one week and building the product UI the next.",
    skills: ["AI/ML", "Autonomous Agents", "Growth Engineering"],
    tags: ["Go", "TypeScript", "Python", "PostgreSQL"],
    url: "https://www.heysquib.com/",
    accent: "#ae92ff",
  },
  {
    period: "2021 — 2022",
    start: 2021,
    end: 2022,
    lane: 0,
    now: false,
    company: "Artesian Builds",
    title: "Full Stack Developer",
    description:
      "Helped overhaul the company website — better design, tighter SEO, load times dropped about 40%. Also built internal tools for tracking sponsorship metrics and Twitch creator stats, which gave management real numbers instead of gut feelings. First job where I shipped things real people used, which changes how carefully you write everything after.",
    skills: ["Full Stack", "Internal Tooling", "SEO", "Data Analysis"],
    tags: ["WordPress", "Elementor", "Electron", "Python", "PostgreSQL"],
    url: "https://en.wikipedia.org/wiki/Artesian_Builds",
    accent: "#72a0ff",
  },
  {
    period: "2019",
    start: 2019.05,
    end: 2019.85,
    lane: 0,
    now: false,
    company: "McDonald's",
    title: "Crew Member",
    description:
      "Got me my first car at 16 — a '93 Miata with 220k miles on it. I still think about that car more than I probably should.",
    skills: ["Deep Fryer", "Cash Register", "Drive-Thru", "Customer Service"],
    tags: ["Ice Cream Machine (Broken)", "McFlurry Assembly", "Headset Comms"],
    url: "https://www.mcdonalds.com/us/en-us.html",
    accent: "#ffc83d",
  },
];

// Time axis ------------------------------------------------------------------
// The axis is not linear in time. A true scale spends half its width on the
// last three years and most of the rest on empty gaps, so it's warped:
// piecewise linear between these [year, %] knots. Every placement on the axis
// (bars, year marks, playhead, read-out) goes through the same mapping, and
// scroll per entry is unchanged — only where things sit, and so how fast the
// playhead travels between them, moves.
//
//   0 – 40%   McDonald's, Artesian Builds and the gaps around them (the gaps
//             squeezed to ~20% of their linear width)
//   40 – 100% Squib, Rumor and Junior
export const axisKnots: [number, number][] = [
  [RANGE_START, 0],
  [2019.05, 0.5], // McDonald's
  [2019.85, 16],
  [2021, 19], // Artesian Builds
  [2022, 37.5],
  [2024, 40], // Squib
  [2025, 60], // Rumor
  [2026.67, 88], // Junior
  [RANGE_END, 100],
];

// Piecewise-linear lookup along one column of the knots into the other;
// clamps outside the range.
const warp = (v: number, from: 0 | 1) => {
  const to = from === 0 ? 1 : 0;
  const k = axisKnots;
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

// Year -> % along the axis, and back.
export const yearPct = (v: number) => warp(v, 0);
export const pctYear = (p: number) => warp(p, 1);

// Year marks on the axis. Squeezed gaps put some years only a couple of
// percent apart, so a year is only marked if it clears the marks already
// placed. Placed first: the axis ends, then years a bar starts on, then years
// a bar ends on, then the rest.
const MIN_MARK_GAP = 6;
const onYear = (v: number[]) => v.filter(Number.isInteger);
const markPriority = new Set([
  RANGE_START,
  RANGE_END,
  ...onYear(entries.map((e) => e.start)),
  ...onYear(entries.map((e) => e.end)),
  ...Array.from({ length: SPAN }, (_, i) => RANGE_START + i),
]);
const marked: number[] = [];
for (const y of markPriority) {
  if (marked.every((m) => Math.abs(yearPct(m) - yearPct(y)) >= MIN_MARK_GAP))
    marked.push(y);
}
export const yearMarks = marked.sort((a, b) => a - b);

// Axis value -> "Sep 2026" / "2026-09". Months come off the same fractional
// year the playhead read-out uses, so the dates and the axis always agree.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const monthOf = (v: number) => Math.min(11, Math.floor((v % 1) * 12));
export const monthYear = (v: number) =>
  `${MONTHS[monthOf(v)]} ${Math.floor(v)}`;
export const monthIso = (v: number) =>
  `${Math.floor(v)}-${String(monthOf(v) + 1).padStart(2, "0")}`;

// Scroll order is oldest-first; each keeps its original index `i`, which is
// what data-select / data-panel attributes key off.
export const ordered = entries.map((entry, i) => ({ entry, i })).reverse();
