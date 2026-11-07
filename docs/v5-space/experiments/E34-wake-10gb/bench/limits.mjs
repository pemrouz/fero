// E-34 side probe: the hard ceilings on rows in ONE data source, independent of memory.
//   node --max-old-space-size=8192 limits.mjs map|object|source
//   map     a JS Map: V8 caps it at 2^24 = 16,777,216 entries (data's Store keeps row keys in a Map)
//   object  a plain object used as a dictionary (data's adopted-object mode, $(obj))
//   source  a data source through fero's seam, rows {n} inserted by the lane in batches of 1024
// Each adds keys until a throw, 20,000,000 keys, or 150 s, and prints how many it held and why it stopped.
import { pathToFileURL } from 'node:url'
const what = process.argv[2]
const LIMIT = 20_000_000
const CAP_MS = 150_000
const over = () => Date.now() - t0 > CAP_MS
let n = 0, err = null
const t0 = Date.now()
try {
  if (what === 'map') { const m = new Map(); for (; n < LIMIT; n++) { m.set('k' + n, n); if ((n & 0xffff) === 0 && over()) { err = 'stopped at 150 s'; break } } }
  else if (what === 'object') { const o = {}; for (; n < LIMIT; n++) { o['k' + n] = n; if ((n & 0x3ff) === 0 && over()) { err = 'stopped at 150 s'; break } } }
  else if (what === 'source') {
    const S = await import(pathToFileURL(process.env.TREE + '/fero/api/substrate.ts').href)
    const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
    const p = S.proxy({}), lane = D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
    for (; n < LIMIT; n += 1024) { const b = []; for (let j = n; j < n + 1024; j++) b.push({ type: 1, key: [], at: 'k' + j, value: { n: j } }); lane(b); if (over()) { n += 1024; err = 'stopped at 150 s'; break } }
  }
} catch (e) { err = String(e?.message ?? e).slice(0, 200) }
console.log(JSON.stringify({ exp: 'E-34', part: 'limits', what, held: n, error: err, seconds: (Date.now() - t0) / 1000, heap_mb: Math.round(process.memoryUsage().heapUsed / 2 ** 20) }))
