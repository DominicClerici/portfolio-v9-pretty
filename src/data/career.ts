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

// Time axis: a year maps to its distance from RANGE_START, as a percentage.
export const yearPct = (v: number) => ((v - RANGE_START) / SPAN) * 100;
export const years = Array.from({ length: SPAN }, (_, i) => RANGE_START + i);

// Axis value -> "Sep 2026" / "2026-09". Months come off the same fractional
// year the playhead read-out uses, so the dates and the axis always agree.
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const monthOf = (v: number) => Math.min(11, Math.floor((v % 1) * 12));
export const monthYear = (v: number) =>
  `${MONTHS[monthOf(v)]} ${Math.floor(v)}`;
export const monthIso = (v: number) =>
  `${Math.floor(v)}-${String(monthOf(v) + 1).padStart(2, "0")}`;

// Scroll order is oldest-first; each keeps its original index `i`, which is
// what data-select / data-panel attributes key off.
export const ordered = entries.map((entry, i) => ({ entry, i })).reverse();
