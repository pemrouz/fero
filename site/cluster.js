// cluster.js — the page side of core.js: the one frame loop, the honesty helpers, and THE shared house cluster.
//   import { page, LiveCluster, attest, put, fmt, onFrame, REDUCED, decode, … } from '../cluster.js'
// Everything core.js exports is re-exported here. A Worker imports core.js instead (no DOM there).
import { LiveCluster, HOUSE } from './core.js'
export * from './core.js'

export const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
export const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

// attest(el, value, tier): write a kernel-produced ('runtime'), in-tab measured ('measured') or build-time
// ('build') value and stamp its provenance. tools/audit.mjs fails the page on any digit-bearing text outside
// pre/code/[data-literal] that is not attested. Never print a number without it.
export function attest(el, value, tier = 'runtime') {
  if (!el) return
  const s = typeof value === 'number' ? fmt(value) : String(value)
  if (el.textContent !== s) el.textContent = s
  if (el.getAttribute('data-attested') !== tier) el.setAttribute('data-attested', tier)
}
export function put(el, s) { if (el && el.textContent !== s) el.textContent = s }
// one cached Intl.NumberFormat per digit pair: toLocaleString with options builds a new formatter on every call,
// which was the page's biggest CPU cost in a profile
const NF = new Map()
export const fmt = (v, d = 0) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v)
  const max = Number.isInteger(v) ? Math.max(d, 0) : Math.max(d, 2), k = d + ':' + max
  let f = NF.get(k); if (!f) NF.set(k, f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: max }))
  return f.format(v)
}

// the page-wide frame loop: one rAF, many subscribers. Re-arm first: one throwing tick must not stop the page.
const ticks = new Set()
export function onFrame(fn) { ticks.add(fn); return () => ticks.delete(fn) }
const fpsSamples = (window.__fpsSamples ||= [])
let lastFrame = performance.now()
function loop(now) {
  requestAnimationFrame(loop)
  fpsSamples.push(now - lastFrame); lastFrame = now; if (fpsSamples.length > 600) fpsSamples.splice(0, 300)
  for (const t of ticks) { try { t(now) } catch (e) { console.error(e) } }
}
requestAnimationFrame(loop)
LiveCluster.ticker = onFrame

// THE house cluster (core.js HOUSE: `shop`, n01 n02 n03 + c1, seed 7 — `?seed=N` overrides it)
const q = new URL(location.href).searchParams.get('seed')
export const page = new LiveCluster({ seed: q !== null && /^\d{1,9}$/.test(q) ? +q : HOUSE.seed })
window.__fero = page

// footer: the kernel line flips to live once core.js (and so lib/) has loaded; chrome.js prints the commit and the
// module count and size from lib/manifest.json
const kernel = document.querySelector('#kernel')
if (kernel) { kernel.textContent = 'kernel · live'; kernel.classList.add('ok'); kernel.setAttribute('data-attested', 'runtime') }
