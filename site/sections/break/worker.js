// sections/break/worker.js — runs the section's own runs (runs.js) off the main thread, so the page keeps its
// frames while small simulations run to their end. A module Worker: core.js has no DOM.
// A message is { id, kind, seed, opts }: opts carries what the page read at build time (fero's defaults) and
// the house link delay, so a run types none of its inputs.
import { scenario } from './runs.js'
self.onmessage = (e) => {
  const { id, kind, seed, opts } = e.data
  try { self.postMessage({ id, ok: true, r: scenario(kind, seed, opts ?? {}) }) }
  catch (err) { self.postMessage({ id, ok: false, err: String(err?.stack || err) }) }
}
