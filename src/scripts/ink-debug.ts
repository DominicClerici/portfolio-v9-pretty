// Temporary: with ?inkdebug, a frame-rate counter and sliders for the ink's
// resolutions, for finding the lowest ones that still look right on a phone.

import type { Ink } from "./ink-fluid";

export function inkDebug(ink: Ink) {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:6px;right:6px;top:max(6px,env(safe-area-inset-top));z-index:99999;" +
    "display:flex;align-items:center;gap:8px;padding:4px 8px;" +
    "font:10px/1 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.78);" +
    "border-radius:6px;touch-action:none";
  const fps = document.createElement("span");
  fps.style.cssText = "width:38px;flex:none";
  box.appendChild(fps);

  // For ink-res-search.mjs, which drives the same control from outside.
  (window as any).__inkTune = ink.tune;
  const now = ink.tune({});
  const slider = (
    key: "dpr" | "dye" | "sim",
    label: string,
    min: number,
    max: number,
    step: number,
  ) => {
    const cell = document.createElement("label");
    cell.style.cssText =
      "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px";
    const name = document.createElement("span");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(now[key]);
    input.style.cssText = "width:100%;height:18px;margin:0";
    const show = () => (name.textContent = `${label} ${input.value}`);
    show();
    input.addEventListener("input", show);
    // Applied on release: each change rebuilds the sheet from clean.
    input.addEventListener("change", () =>
      ink.tune({ [key]: Number(input.value) }),
    );
    cell.append(name, input);
    box.appendChild(cell);
  };
  slider("dpr", "px ratio", 0.5, 3, 0.05);
  slider("dye", "ink", 160, 1200, 20);
  slider("sim", "water", 48, 256, 8);
  document.body.appendChild(box);

  let frames = 0;
  let from = performance.now();
  const frame = (t: number) => {
    requestAnimationFrame(frame);
    if (++frames < 30) return;
    fps.textContent = `${Math.round(30000 / (t - from))}fps`;
    frames = 0;
    from = t;
  };
  requestAnimationFrame(frame);
}
