// @ts-check
import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"
import sitemap from "@astrojs/sitemap"
import { visualizer } from "rollup-plugin-visualizer"

// https://astro.build/config
export default defineConfig({
  site: "https://dominicclerici.com",
  integrations: [sitemap()],
  vite: {
    plugins: [
      tailwindcss(),
      visualizer({
        emitFile: true,
        filename: "stats.html",
      }),
    ],
  },
})
