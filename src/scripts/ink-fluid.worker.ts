// The ink (ink-fluid.ts) on a thread of its own, drawing to the canvas
// ink-mount.ts hands over.

import { serveInk, type FromInk, type ToInk } from "./ink-fluid";

const scope = self as unknown as {
  postMessage(m: FromInk, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToInk>) => void) | null;
};
const served = serveInk((m, transfer = []) => scope.postMessage(m, transfer));
scope.onmessage = (e) => {
  // Its loop runs on the frames of the screen, which not every browser
  // gives a worker.
  if (e.data.is === "open" && typeof requestAnimationFrame !== "function")
    return scope.postMessage({ is: "failed" }, []);
  served.hear(e.data);
};
