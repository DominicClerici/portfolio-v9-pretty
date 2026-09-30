/*
 * Builds logo-morph's distance fields off the main thread. Each is a few
 * hundred thousand pixels of rasterising plus two exact distance transforms —
 * tens of milliseconds apiece on a laptop and several times that on a phone,
 * which on the main thread lands as long tasks while the page is being read.
 *
 * One request per field, answered in the order asked; the field's buffer is
 * transferred back rather than copied.
 */
import { fieldOf } from "./logo-field"

type Req = { i: number; path: string }

self.onmessage = (e: MessageEvent<Req>) => {
  const { i, path } = e.data
  try {
    const field = fieldOf(path, (size) => new OffscreenCanvas(size, size))
    ;(self as unknown as Worker).postMessage({ i, field }, [field.buffer])
  } catch {
    ;(self as unknown as Worker).postMessage({ i, field: null })
  }
}
