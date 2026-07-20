// @ts-check
import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"
import sitemap from "@astrojs/sitemap"
import { visualizer } from "rollup-plugin-visualizer"

// https://astro.build/config
export default defineConfig({
  site: "https://www.dominicclerici.com",
  integrations: [sitemap()],
  vite: {
    plugins: [
      tailwindcss(),
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
})
