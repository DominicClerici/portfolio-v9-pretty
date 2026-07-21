// Content for the "Morning Editions" work section (src/components/Work.astro).
// Each project is one edition of the paper: an accent ink, a wash drawn from
// it, the stock that edition is printed on, and the copy that fills its front
// page and inside spread.
// Gallery images and story copy are placeholders to swap for real content.

export type GalleryPlate = {
  src: string;
  alt: string;
  caption: string;
};

export type Project = {
  index: string;
  title: string;
  edition: string;
  fact: string;
  description: string;
  stack: string[];
  websiteUrl: string;
  githubUrl: string | null;
  featured: boolean;
  accent: string;
  wash: string;
  /** The stock this edition is printed on — bone (#f7f7f5) pulled a few points
   *  toward the accent. Only the inside spread (and the arch window looking
   *  into it) is printed on it; the front page stays on plain bone. */
  paper: string;
  details: { label: string; value: string }[];
  story: string[];
  gallery: GalleryPlate[];
};

export const projects: Project[] = [
  {
    index: "01",
    title: "Dispatch",
    edition: "morning edition",
    fact: "writes itself every morning",
    description:
      "The last 24 hours of tech news, compressed into a 10 minute read. Two decoupled AI pipelines research, triage, and write it; GitHub Actions runs the whole thing while I sleep.",
    stack: ["Astro", "TypeScript", "OpenAI API", "Tailwind", "Vercel"],
    websiteUrl: "https://dispatch.dominicclerici.com/",
    githubUrl: "https://github.com/DominicClerici/dispatch",
    featured: false,
    accent: "#0e63c8",
    wash: "rgba(14, 99, 200, 0.09)",
    paper: "#eef4fc",
    details: [
      { label: "Role", value: "Design & build — solo" },
      { label: "Timeline", value: "2025 — ongoing" },
      { label: "Status", value: "In print daily" },
    ],
    story: [
      "Dispatch exists because I kept losing whole mornings to tab sprawl — four newsletters, two aggregators, and a feed that never ended. The brief I set myself was narrow: everything that mattered in tech in the last twenty-four hours, printed as one calm page, readable before the coffee goes cold.",
      "Two decoupled pipelines run the press. The first is a researcher: it sweeps sources overnight, scores stories against each other, and throws most of them away. The second is a writer: it takes the surviving shortlist and sets it in plain language, with a hard budget of ten minutes of reading. Neither pipeline knows the other exists — they only share an editorial contract.",
      "GitHub Actions is the night shift. It runs the whole edition while I sleep, and the only moving part I ever touch is reading the paper it leaves behind.",
    ],
    gallery: [
      { src: "/photos/dispatch.webp", alt: "Dispatch front page", caption: "The front page of a live edition, printed at six sharp." },
      { src: "/photos/dispatch.webp", alt: "Dispatch placeholder plate", caption: "Placeholder plate — the triage pipeline's scoring pass." },
      { src: "/photos/dispatch.webp", alt: "Dispatch placeholder plate", caption: "Placeholder plate — a story moving from shortlist to print." },
    ],
  },
  {
    index: "02",
    title: "Meridian",
    edition: "midday edition",
    fact: "0 npm dependencies",
    description:
      "A new-tab extension for Chrome and Firefox with zero npm dependencies. Eleven feature modules, a reactive storage layer, and a recommendation engine that never lets data leave the browser.",
    stack: ["TypeScript", "esbuild", "Chrome APIs", "Firefox Add-ons"],
    websiteUrl: "https://meridian.dominicclerici.com/",
    githubUrl: "https://github.com/DominicClerici/meridian",
    featured: false,
    accent: "#006c22",
    wash: "rgba(0, 108, 34, 0.09)",
    paper: "#edf9f1",
    details: [
      { label: "Role", value: "Design & build — solo" },
      { label: "Timeline", value: "2024 — 2025" },
      { label: "Status", value: "Live on two stores" },
    ],
    story: [
      "Meridian is a protest against the modern new-tab page — the weather widgets, the sponsored links, the quiet phone-home. It ships with zero npm dependencies: every line that runs in the browser is a line I wrote and can read.",
      "Under the hood it is eleven feature modules seated on a reactive storage layer. Each module owns its slice of state; the layer broadcasts changes and the page settles itself, no framework in the room.",
      "The recommendation engine is the part I'm proudest of: it learns what you open and when, and never lets a byte of that leave the machine. Your habits stay yours.",
    ],
    gallery: [
      { src: "/photos/meridian.webp", alt: "Meridian new tab", caption: "A fresh tab, seated and quiet." },
      { src: "/photos/meridian.webp", alt: "Meridian placeholder plate", caption: "Placeholder plate — the module registry at work." },
      { src: "/photos/meridian.webp", alt: "Meridian placeholder plate", caption: "Placeholder plate — the on-device recommendation pass." },
    ],
  },
  {
    index: "03",
    title: "Fuzzbox",
    edition: "late edition",
    fact: "design system: Neon Riff",
    description:
      "The companion I wished I had when learning guitar. Place notes on an interactive fretboard and it explains the chord you found — the intervals, the theory, why it sounds the way it does.",
    stack: ["TypeScript", "Next.js", "React Native", "Prisma", "PostgreSQL"],
    websiteUrl: "https://fuzzbox.dominicclerici.com/",
    githubUrl: null,
    featured: true,
    accent: "#5e2cc0",
    wash: "rgba(94, 44, 192, 0.1)",
    paper: "#f4f0fd",
    details: [
      { label: "Role", value: "Design & build — solo" },
      { label: "Timeline", value: "2025 — ongoing" },
      { label: "Status", value: "Editor's pick — in beta" },
    ],
    story: [
      "Fuzzbox started with a chord I found by accident and couldn't name. Every tool I tried wanted me to already know the answer; I wanted one that would meet me at the fretboard.",
      "Place notes on the interactive fretboard and Fuzzbox explains what you've built — the intervals, the theory, why it rings the way it does. It is the companion I wished I had in the first year of playing.",
      "The whole thing wears a design system called Neon Riff — stage-light color on deep black, built to feel like the back room of a guitar shop after hours.",
    ],
    gallery: [
      { src: "/photos/fuzzbox.webp", alt: "Fuzzbox fretboard", caption: "The fretboard, mid-chord." },
      { src: "/photos/fuzzbox.webp", alt: "Fuzzbox placeholder plate", caption: "Placeholder plate — interval breakdown for a found chord." },
      { src: "/photos/fuzzbox.webp", alt: "Fuzzbox placeholder plate", caption: "Placeholder plate — Neon Riff tokens in the wild." },
    ],
  },
];
