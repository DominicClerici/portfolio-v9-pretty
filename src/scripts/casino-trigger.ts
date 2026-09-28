/* ── Casino trigger ──
   The site's >_ prompts open the /dev/null casino (src/scripts/casino). All
   of it is fetched on demand: pointing at or focusing a prompt starts the
   download, and the click opens it, so the page never pays for the games
   up front. */

export type CasinoModule = typeof import("./casino/index")

let loading: Promise<CasinoModule> | null = null

/** The casino chunk, fetched once. A failed fetch (deploy mid-visit, flaky
    network) is forgotten, so the next ask gets one fresh try. */
export const loadCasino = () =>
  (loading ??= import("./casino/index").catch((err) => {
    loading = null
    throw err
  }))

const TRIGGER = "[data-casino-open]"
const trigger = (e: Event) => (e.target as Element | null)?.closest?.(TRIGGER)

document.addEventListener("click", (e) => {
  if (!trigger(e)) return
  e.preventDefault()
  loadCasino()
    .then((m) => m.open())
    .catch(() => {})
})

const warm = (e: Event) => {
  if (trigger(e)) void loadCasino().catch(() => {})
}
document.addEventListener("pointerover", warm, { passive: true })
document.addEventListener("focusin", warm)
