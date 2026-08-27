// @ts-check
import { defineConfig, envField } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";
import { visualizer } from "rollup-plugin-visualizer";

/* The three shaders in glass-scene.ts are template literals, so their comments
   and indentation are string *content* — the JS minifier cannot reach them, and
   ~750 bytes of GLSL commentary ships to every visitor. Stripping them at build
   time keeps the annotated source intact while paying nothing for it. Build-only
   so dev still compiles the readable shader (line numbers in a GLSL compile
   error then match the source you are looking at). */
function stripGlslComments() {
  const SHADER = /`#version 300 es[\s\S]*?`/g;
  const INTERP = /\$\{[^{}]*\}/g;

  return {
    name: "strip-glsl-comments",
    enforce: "pre",
    apply: "build",
    transform(code, id) {
      if (!id.endsWith("glass-scene.ts")) return null;

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

// https://astro.build/config
export default defineConfig({
  site: "https://www.dominicclerici.com",
  integrations: [sitemap()],
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
  env: {
    schema: {
      RESEND_KEY: envField.string({ context: "server", access: "secret" }),
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
