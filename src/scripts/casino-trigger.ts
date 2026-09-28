/* ── Casino trigger ──
   The site's >_ prompts open the /dev/null casino (src/scripts/casino). All
   of it is fetched on demand: pointing at or focusing a prompt starts the
   download, and the click opens it, so the page never pays for the games
   up front. */

type CasinoModule = typeof import("./casino/index")

let loading: Promise<CasinoModule> | null = null
const load = () => (loading ??= import("./casino/index"))

const TRIGGER = "[data-casino-open]"
const trigger = (e: Event) => (e.target as Element | null)?.closest?.(TRIGGER)

document.addEventListener("click", (e) => {
  if (!trigger(e)) return
  e.preventDefault()
  load()
    .then((m) => m.open())
    .catch(() => {
      // A failed chunk (deploy mid-visit, flaky network) gets one fresh try
      loading = null
    })
})

const warm = (e: Event) => {
  if (trigger(e)) void load().catch(() => (loading = null))
}
document.addEventListener("pointerover", warm, { passive: true })
document.addEventListener("focusin", warm)
