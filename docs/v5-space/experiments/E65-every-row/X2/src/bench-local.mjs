// E-65 X2 timing, in one process: (a) a server's own code reading every row of the groups it holds, with no
// wire; (b) what a pin costs a copy that folds writes with `data`.
//
//   node src/bench-local.mjs --part=local --rows=2500000     (4 groups of a 16-group resource of 1e7 rows)
//   node src/bench-local.mjs --part=pin --rows=625000        (one group of a 1e7-row resource of 16 groups)
//
// (a) 'local': the rows are held by slot (a Map per slot, as server.mjs). Three ways to read them all:
//     map      a plain loop over every slot's Map (the floor);
//     paged    the scan's own way: each slot's keys sorted, pages of 1,000 handed out by an async iterator
//              (`for await (const page of ...)`), so code that reads local and remote groups is the same code;
//     rowiter  the same, one row per `for await` step.
// (b) 'pin': one group's rows in a `data` source (data at the commit in ../data, read only), written by field
//     updates in batches of 256 through data's lane, as a copy folds a commit batch. A sink hands each changed
//     row's before and after (data's `prev`), the feed E-64 found every way past one process needs. Timed:
//     nosink    the lane alone;
//     sink      a sink that reads `prev` and keeps nothing (the before-and-after feed by itself);
//     pin       a pin over the group: the first change of a row not yet scanned keeps its image (a Map set);
//               the cursor is half way, so half the rows are "passed" (a compare each);
//     pinall    a pin where no row is passed yet (every first change keeps an image).
//     Each round writes values no row has yet: data sends no delta for a write that leaves a field equal.
//     Then memory: the heap after K images kept (K = rows / 8 and rows / 2), against none, per image.
//     And the two other ways to pin: a copy of the group's Map of rows (rows shared, as data's snapshot shares
//     them), timed and weighed.
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'
import { args, out } from './lib.mjs'

const o = args(process.argv.slice(2), { part: 'local', rows: 1e6, run: 0, out: '', writes: 200000, rounds: 5, order: '' })
const load0 = os.loadavg()[0]
const S = 4096, G = 16
function slotOf(k) {
  let h = 0x811c9dc5
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13
  return (h >>> 0) % S
}
const REG = ['eu-west', 'eu-north', 'us-east', 'us-west', 'ap-south', 'ap-east', 'sa-east', 'af-south', 'me-central', 'ca-central', 'eu-south', 'us-central', 'ap-north', 'oc-east', 'eu-east', 'mx-central']
let rs = 12345
const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296 }
const makeRow = (i) => ({ name: 'user ' + i, email: 'u' + i + '@example.com', region: REG[i % 16], room: 'r' + (i % 1000), n: Math.floor(rnd() * 1000), active: rnd() < 0.5, tags: ['a', 'b'] })
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1] }
const gc = () => { global.gc(); global.gc(); global.gc() }
const heap = () => { gc(); return process.memoryUsage().heapUsed }

if (o.part === 'local') {
  // the groups one server of four holds: groups 0, 4, 8, 12 of 16, about rows / 4 rows
  const bySlot = new Map(); const slots = []
  for (let s = 0; s < S; s++) if ((s % G) % 4 === 0) { bySlot.set(s, new Map()); slots.push(s) }
  let held = 0
  for (let i = 0; held < o.rows; i++) { const k = 'u' + i; const m = bySlot.get(slotOf(k)); if (m) { m.set(k, makeRow(i)); held++ } }
  async function* pages(limit) {
    for (const s of slots) {
      const m = bySlot.get(s)
      const keys = [...m.keys()].sort()
      for (let i = 0; i < keys.length; i += limit) {
        const page = []
        for (let j = i; j < Math.min(i + limit, keys.length); j++) page.push(m.get(keys[j]))
        yield page
      }
    }
  }
  async function* rowsOf(limit) { for await (const p of pages(limit)) for (const r of p) yield r }
  const ways = {
    map: async () => { let sum = 0; for (const s of slots) for (const r of bySlot.get(s).values()) sum += r.n; return sum },
    paged: async () => { let sum = 0; for await (const p of pages(1000)) for (const r of p) sum += r.n; return sum },
    rowiter: async () => { let sum = 0; for await (const r of rowsOf(1000)) sum += r.n; return sum },
    sortonly: async () => { let x = 0; for (const s of slots) x += [...bySlot.get(s).keys()].sort().length; return x },
  }
  for (const [name, fn] of Object.entries(ways)) {
    const t = []
    let check
    for (let r = 0; r < o.rounds; r++) { const t0 = performance.now(); check = await fn(); t.push(performance.now() - t0) }
    out(o.out, { kind: 'local', run: o.run, way: name, rows: held, slots: slots.length, msMedian: +median(t).toFixed(1), nsPerRow: Math.round((median(t) * 1e6) / held), check, load0 })
  }
} else if (o.part === 'pin') {
  const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url))
  const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
  const N = o.rows
  const keys = Array.from({ length: N }, (_, i) => 'u' + i)
  const src = D.$({})
  const lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
  for (let i = 0; i < N; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(i + 256, N); j++) recs.push({ type: 1, key: [], at: keys[j], value: makeRow(j) })
    lane(recs)
  }
  // the writes: field updates of `n` on uniform keys, in batches of 256
  const W = o.writes
  // each round writes values no row has yet (data skips a write that leaves a field equal, and sends no delta)
  let round = 0
  const makeBatches = () => {
    round++
    const out = []
    for (let i = 0; i < W; i += 256) { const b = []; for (let j = 0; j < 256 && i + j < W; j++) b.push({ type: 0, key: [keys[Math.floor(rnd() * N)], 'n'], value: round * 1e6 + i + j }); out.push(b) }
    return out
  }
  // the pin: a Map of images; "passed" rows are those whose index is below the cursor (half the rows)
  const idx = new Map(keys.map((k, i) => [k, i]))
  let mode = 'nosink', saved = new Map(), cursor = N >> 1, seen = 0
  src.sink({ apply: (b) => {
    if (mode === 'nosink') return
    for (const d of b.rows) {
      const prev = d.prev
      if (mode === 'sink') { if (prev !== undefined) seen++; continue }
      const k = d.key
      if (saved.has(k)) continue
      if (mode === 'pin' && idx.get(k) < cursor) continue // passed: no image needed
      saved.set(k, prev)
    }
  } })
  const timeMode = (m) => {
    const t = []
    let deltas = 0
    for (let r = 0; r < o.rounds; r++) {
      const batches = makeBatches()
      mode = m; saved = new Map(); seen = 0
      gc()
      const t0 = performance.now()
      for (const b of batches) lane(b)
      t.push(performance.now() - t0)
      deltas = seen
    }
    out(o.out, { kind: 'pin', run: o.run, mode: m, rows: N, writes: W, usPerRecord: +((median(t) * 1000) / W).toFixed(3), images: saved.size, sinkDeltas: deltas, load0 })
  }
  for (const m of (o.order || 'nosink,sink,pin,pinall,nosink,sink').split(',')) timeMode(m)
  // memory per image: keep K images (each the row as it was; the row object stays alive while kept)
  for (const K of [Math.floor(N / 8), Math.floor(N / 2)]) {
    mode = 'pinall'; saved = new Map()
    const h0 = heap()
    let n = 0
    while (saved.size < K) { const b = []; for (let j = 0; j < 256; j++) b.push({ type: 0, key: [keys[n++ % N], 'n'], value: n }); lane(b) }
    const h1 = heap()
    mode = 'nosink'; const size = saved.size; saved = new Map() // the images go; the rows they held are garbage now
    const h2 = heap()
    out(o.out, { kind: 'pinmem', run: o.run, rows: N, images: size, bytesPerImage: Math.round((h1 - h2) / size), heapBeforeMB: +(h0 / 1048576).toFixed(1), heapWithMB: +(h1 / 1048576).toFixed(1), heapAfterMB: +(h2 / 1048576).toFixed(1), load0 })
  }
  // the other way to pin: copy the group's rows (the Map of row references; rows are shared, never copied)
  {
    const node = src[Symbol.for('data.v4.node')]
    const t = []
    for (let r = 0; r < 3; r++) { gc(); const t0 = performance.now(); const copy = new Map(); node.each((k, row) => copy.set(k, row)); t.push(performance.now() - t0) }
    const h1 = heap()
    const copy = new Map(); node.each((k, row) => copy.set(k, row))
    const h2 = heap(); const size = copy.size
    const h1h2 = h2 - h1
    out(o.out, { kind: 'pincopy', run: o.run, rows: N, msMedian: +median(t).toFixed(1), MB: +(h1h2 / 1048576).toFixed(1), bytesPerRow: Math.round(h1h2 / size), kept: copy.size, load0 })
  }
}
