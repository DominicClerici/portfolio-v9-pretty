// Content for the "Morning Editions" work section (src/components/Work.astro).
// Each project is one edition of the paper: an accent ink, a wash drawn from
// it, the stock that edition is printed on, and the copy that fills its front
// page and inside spread.
// Gallery images and story copy are placeholders to swap for real content.

export type GalleryPlate = {
  /** The 1x plate (1280x720). A matching `-2x` file (2560x1440) sits beside it
   *  in /public/photos and is picked up by ProjectGallery's srcset. */
  src: string;
  alt: string;
};

export type Project = {
  index: string;
  /** URL segment for this edition's own page: /projects/<slug>. Also the
   *  marker the front page reads on arrival (/#from-<slug>) to know which
   *  window to close the door back into. */
  slug: string;
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
   *  toward the accent. Only the inside spread (and the shaped window looking
   *  into it) is printed on it; the front page stays on plain bone. */
  paper: string;
  /** The window this edition is read through (see src/lib/workShapes.ts):
   *  a rounded diamond, a grid of circles, or a stack of bars. */
  shape: "diamond" | "circles" | "bars";
  details: { label: string; value: string }[];
  story: string[];
  gallery: GalleryPlate[];
};

export const projects: Project[] = [
  {
    index: "01",
    slug: "dispatch",
    title: "Dispatch",
    edition: "morning edition",
    fact: "writes itself every morning",
    description:
      "The last 24 hours of tech news in a 10 minute read. One AI pipeline finds and ranks the stories, a second one writes them up, and GitHub Actions runs the whole thing overnight.",
    stack: ["Astro", "TypeScript", "OpenAI API", "Tailwind", "Vercel"],
    websiteUrl: "https://dispatch.dominicclerici.com/",
    githubUrl: "https://github.com/DominicClerici/dispatch",
    featured: false,
    accent: "#0e63c8",
    wash: "rgba(14, 99, 200, 0.09)",
    paper: "#f3f6fb",
    shape: "diamond",
    details: [
      { label: "Role", value: "Design & build — solo" },
      { label: "Timeline", value: "2025 — ongoing" },
      { label: "Status", value: "In print daily" },
    ],
    story: [
      "I was reading four newsletters and two aggregators every morning and still felt behind on everything. Dispatch is what I built instead: one page, everything from the last 24 hours in tech that's actually worth knowing, about ten minutes to get through.",
      "It runs as two separate pipelines. The first goes out overnight, pulls from a long list of sources, and scores stories against each other — most of them get cut. The second takes what survives and writes it up in plain English. They never talk to each other; the researcher drops a shortlist where the writer expects to find one.",
      "GitHub Actions runs it on a schedule, so the edition is sitting there when I wake up. I haven't had to touch it in months, which is the part I'm happiest about.",
    ],
    gallery: [
      {
        src: "/photos/dispatch-01.webp",
        alt: "Dispatch newsletter page — the four delivery options and the subscribe form",
      },
      {
        src: "/photos/dispatch-02.webp",
        alt: "Dispatch daily snapshots index, listing recent editions by date",
      },
      {
        src: "/photos/dispatch-03.webp",
        alt: "Dispatch search page with filters and a list of matching dispatches",
      },
    ],
  },
  {
    index: "02",
    slug: "meridian",
    title: "Meridian",
    edition: "midday edition",
    fact: "0 npm dependencies",
    description:
      "A new-tab extension for Chrome and Firefox, built with zero npm dependencies. Eleven feature modules sitting on a reactive storage layer, plus a recommendation engine that keeps everything on your machine.",
    stack: ["TypeScript", "esbuild", "Chrome APIs", "Firefox Add-ons"],
    websiteUrl: "https://meridian.dominicclerici.com/",
    githubUrl: "https://github.com/DominicClerici/meridian",
    featured: false,
    accent: "#006c22",
    wash: "rgba(0, 108, 34, 0.09)",
    paper: "#f2f8f3",
    shape: "circles",
    details: [
      { label: "Role", value: "Design & build — solo" },
      { label: "Timeline", value: "2024 — 2025" },
      { label: "Status", value: "Live on two stores" },
    ],
    story: [
      "Every new-tab extension I tried wanted to show me the weather, a sponsored link, and — going by the network tab — a bit of my browsing history. Meridian is the one I wanted instead. It ships with zero npm dependencies, so every line running in your browser is one I wrote.",
      "There are eleven feature modules sitting on a small reactive storage layer. Each module owns its own slice of state and the layer tells the others when it changes. No framework, mostly because I wanted to find out whether I could get away without one.",
      "The recommendation engine learns which sites you open and when, and does all of it locally — nothing gets sent anywhere. That was the whole reason I built it, and it's the piece I'd show someone first.",
    ],
    gallery: [
      {
        src: "/photos/meridian-01.webp",
        alt: "Meridian's landing page — “Your new tab, reimagined”",
      },
      {
        src: "/photos/meridian-02.webp",
        alt: "Meridian's five dashboard widgets: clock, Spotify, weather, calendar, and to-do",
      },
      {
        src: "/photos/meridian-03.webp",
        alt: "Meridian's appearance settings — accent colors, light and dark modes, and image backgrounds",
      },
    ],
  },
  {
    index: "03",
    slug: "fuzzbox",
    title: "Fuzzbox",
    edition: "late edition",
    fact: "design system: Neon Riff",
    description:
      "A chord finder that works backwards. Put notes on an interactive fretboard and it works out what you've found, then explains the intervals and the theory behind why it sounds like that.",
    stack: ["TypeScript", "Next.js", "React Native", "Prisma", "PostgreSQL"],
    websiteUrl: "https://fuzzbox.dominicclerici.com/",
    githubUrl: null,
    featured: false,
    accent: "#5e2cc0",
    wash: "rgba(94, 44, 192, 0.1)",
    paper: "#f6f4fc",
    shape: "bars",
    details: [
      { label: "Role", value: "Design & build — solo" },
      { label: "Timeline", value: "2025 — ongoing" },
      { label: "Status", value: "In beta" },
    ],
    story: [
      "I found a chord by accident, liked it, and had no idea what it was called. Every tool I looked at assumed I already knew the answer — you type in a chord name and it draws you the shape. I needed it the other way round.",
      "So Fuzzbox works backwards. Put notes on the fretboard and it tells you what you've made and why it sounds like that. It's the thing I could have used in my first year of playing, when I was mostly guessing.",
      "It runs on a design system I put together called Neon Riff: bright color on near-black, which is roughly what a guitar pedal looks like.",
    ],
    gallery: [
      { src: "/photos/fuzzbox.webp", alt: "Fuzzbox fretboard" },
      {
        src: "/photos/fuzzbox-02.webp",
        alt: "Fuzzbox's chord analyzer naming a six-note voicing as Gbm7, with its intervals broken out",
      },
      {
        src: "/photos/fuzzbox-03.webp",
        alt: "Fuzzbox's closing call to action — “Ready to plug in?”",
      },
    ],
  },
];
