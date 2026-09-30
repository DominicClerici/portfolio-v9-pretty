// @ts-check
import { defineConfig, envField } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";
import { visualizer } from "rollup-plugin-visualizer";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* The shaders in glass-scene.ts and heat-haze.ts are template literals, so
   their comments and indentation are string *content* — the JS minifier cannot
   reach them, and the GLSL commentary would ship to every visitor. Stripping them at build
   time keeps the annotated source intact while paying nothing for it. Build-only
   so dev still compiles the readable shader (line numbers in a GLSL compile
   error then match the source you are looking at). */
function stripGlslComments() {
  const FILES = ["glass-scene.ts", "heat-haze.ts"];
  const SHADER = /`#version 300 es[\s\S]*?`/g;
  const INTERP = /\$\{[^{}]*\}/g;

  return {
    name: "strip-glsl-comments",
    enforce: "pre",
    apply: "build",
    transform(code, id) {
      if (!FILES.some((f) => id.endsWith(f))) return null;

      let found = 0;
      const out = code.replace(SHADER, (lit) => {
        found++;
        // Interpolations are opaque: swap them for newline-free placeholders
        // first, so line-based stripping can never cut one in half.
        const exprs = [];
        const masked = lit.replace(INTERP, (e) => `\0${exprs.push(e) - 1}\0`);
        const stripped = masked
          .split("\n")
          .map((line) =>
            line
              .replace(/\/\/.*$/, "")
              .trimEnd()
              .trimStart(),
          )
          .filter((line) => line !== "")
          .join("\n");
        const restored = stripped.replace(/\0(\d+)\0/g, (_, i) => exprs[+i]);

        // A `${...}` sitting inside a comment, or a nested-brace interpolation
        // INTERP cannot mask, would be silently deleted above. Refuse instead.
        const before = (lit.match(/\$\{/g) || []).length;
        const after = (restored.match(/\$\{/g) || []).length;
        if (before !== after) {
          this.error(
            `strip-glsl-comments: ${id} lost ${before - after} interpolation(s); ` +
              `a \${...} is inside a // comment or uses nested braces.`,
          );
        }
        return restored;
      });

      if (!found) {
        this.error(
          `strip-glsl-comments: matched no shader literals in ${id}. ` +
            `Did the "#version 300 es" prologue change?`,
        );
      }
      return { code: out, map: null };
    },
  };
}

/* The components are annotated in HTML comments (<!-- -->) wherever the note
   belongs to markup, and Astro ships those verbatim: ~11KB of the front page,
   about an eighth of it once compressed, is commentary no visitor reads.
   Strip them from the built pages after the fact, so the source keeps them.
   Raw-text elements (script, style, textarea, pre) are left untouched, since
   a "<!--" in there is content, not a comment. Runs before the adapter's own
   build:done copies the pages into its output, as integrations run in order
   and the adapter is appended last. */
function stripHtmlComments() {
  const RAW = /(<(script|style|textarea|pre)\b[\s\S]*?<\/\2\s*>)/gi;
  const COMMENT = /<!--(?!\[if|<!|>)[\s\S]*?-->/g;

  async function* htmlFiles(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* htmlFiles(p);
      else if (e.name.endsWith(".html")) yield p;
    }
  }

  return {
    name: "strip-html-comments",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        let saved = 0;
        for await (const file of htmlFiles(fileURLToPath(dir))) {
          const html = await readFile(file, "utf8");
          // Odd indices are the raw-text elements the split captured (and
          // their tag names); only the text between them is stripped.
          const out = html
            .split(RAW)
            .map((part, i) => {
              if (i % 3 === 0) return part.replace(COMMENT, "");
              return i % 3 === 1 ? part : "";
            })
            .join("");
          if (out.length === html.length) continue;
          saved += html.length - out.length;
          await writeFile(file, out);
        }
        logger.info(`stripped ${(saved / 1024).toFixed(1)}KB of HTML comments`);
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site: "https://www.dominicclerici.com",
  integrations: [sitemap(), stripHtmlComments()],
  /* Every page stays prerendered; only the two files under src/pages/api opt
     out with `export const prerender = false`, so the adapter emits exactly
     one function and the rest of the site ships as static HTML. */
  adapter: vercel(),
  /* Opt-in only (no defaultStrategy): the sole link that asks for it is the
     spread's way back to the front page, on /projects/<slug>. A cold visitor
     landing there from a search result is one click from a 116KB document the
     browser has never seen, and the door that closes on arrival cannot start
     until it has. Astro's own prefetch rather than a bare <link rel="prefetch">
     for the fetch() fallback where that relation isn't honoured. */
  prefetch: true,
  /* Every stylesheet goes into the page's <head> rather than a <link>: the
     CSS is ~15KB compressed across three files, and fetching them cost a
     render-blocking round trip after the HTML had already arrived. */
  build: {
    inlineStylesheets: "always",
  },
  env: {
    schema: {
      RESEND_KEY: envField.string({ context: "server", access: "secret" }),
      /* The casino's multiplayer lobby (see multiplayer/README.md), e.g.
         wss://casino-lobby.<you>.workers.dev/ws. Unset, the casino runs solo. */
      PUBLIC_CASINO_WS: envField.string({
        context: "client",
        access: "public",
        optional: true,
      }),
    },
  },
  vite: {
    plugins: [
      tailwindcss(),
      stripGlslComments(),
      // Opt-in only: emitFile writes into dist/, so an unguarded visualizer
      // publishes the module graph to the live site. Run: ANALYZE=1 pnpm build
      ...(process.env.ANALYZE
        ? [
            visualizer({
              emitFile: true,
              filename: "stats.html",
            }),
          ]
        : []),
    ],
  },
});
