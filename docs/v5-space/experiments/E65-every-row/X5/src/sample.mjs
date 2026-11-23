// E-65 X5, part `sample`: hold a fixed sample of slots, not every row, and answer whole-resource questions
// with an estimate and a 95 % interval.
//
// The resource: partitions (the first key) of skewed size, each with its own typical value, so rows in one
// partition look alike (that is what makes a slot sample a *cluster* sample). A partition's slot is a hash
// of its key. Live writes: updates, inserts (popular partitions get more) and deletes.
//
// The asker picks k of the 4,096 slots by a salted hash and folds only the writes to those slots (the copy
// drops the rest). At each read it estimates, with a 95 % interval:
//   count, sum (totals, scaled by S/k), mean and paid share (ratios), median and p90 (Woodruff's interval).
// Two checks per seed:
//   exact: the held rows equal the oracle's rows in the sampled slots, after every read point;
//   cover: over PICKS independent picks (salts) on the same resource, each estimate's interval holds the
//          truth at the final read in at least MINCOVER of PICKS picks (real code: about 95 % of picks).
// A seed fails if either check fails. Planted bugs (BUG=...): noscale, skipempty, rowvar, hotpick, window,
// lostdelete. Each must fail most seeds.
//
// Also printed, not checked: two things a slot sample cannot estimate well, with numbers: the distinct count
// of a field that is not the key, and the max.
//
// Usage: node sample.mjs [seeds] [firstSeed]   env BUG, PICKS (20), K (256), OUT (a JSON-lines file)
import { appendFileSync } from 'node:fs'

const S = 4096
const BUG = process.env.BUG ?? ''
const PICKS = +(process.env.PICKS ?? 20)
const K = +(process.env.K ?? 256)
const MINCOVER = Math.ceil(PICKS * 0.7)          // 14 of 20: under a true 95 % rate, P(fewer) is about 1e-5
const Z = 1.96
const PARTS = +(process.env.PARTS ?? 30000)       // partitions: PARTS to 2*PARTS (30,000: about 11 a slot; 2,000: about 0.7)
const W = +(process.env.W ?? 20000)              // writes after the picture
const HEAVY = process.env.TAIL === 'heavy'       // heavy: sizes Pareto 1.3 to 400 rows, values lognormal sd 1.2;
                                                 // moderate (default): Pareto 1.8 to 100 rows, lognormal sd 0.6

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}
const slotOf = (pkey) => hash32(pkey) % S
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

// ---- the world ------------------------------------------------------------------------------------------
function makeWorld(seed) {
  const r = rng(seed)
  const P = PARTS + Math.floor(r() * PARTS)                   // partitions
  const parts = []
  for (let i = 0; i < P; i++) {
    const size = Math.min(HEAVY ? 400 : 100, Math.floor(1 / Math.pow(1 - r(), 1 / (HEAVY ? 1.3 : 1.8))))   // Pareto sizes
    const u = r()                                             // busy partitions (more writes) spend a bit more
    parts.push({ key: 'u' + seed + '-' + i, mu: Math.exp(3 + (HEAVY ? 1.2 : 0.6) * normal(r) + 0.5 * u), pPaid: r(), pop: u * u * u })
    parts[i].size0 = size
  }
  const rows = new Map()                                      // rowKey -> { p, v, paid, sku, w }
  let next = 0, clock = 0
  const newRow = (pi) => {
    const p = parts[pi]
    return { p: pi, v: p.mu * Math.exp(0.3 * normal(r)), paid: r() < p.pPaid, sku: 's' + Math.floor(r() * 5000), w: clock }
  }
  for (let i = 0; i < P; i++) for (let j = 0; j < parts[i].size0; j++) rows.set('r' + next++, newRow(i))
  // popular partitions get more writes: pick a partition by its pop weight (a table of cumulative weights)
  const cum = []; let tot = 0
  for (const p of parts) { tot += p.pop; cum.push(tot) }
  const pickPart = () => { const x = r() * tot; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m } return lo }
  const byPart = parts.map(() => [])
  for (const [k, row] of rows) byPart[row.p].push(k)
  // one write: returns { op, key, row|null } as the copy would publish it, with its slot
  const step = () => {
    clock++
    const pi = pickPart(), list = byPart[pi], x = r()
    if (x < 0.6 && list.length) { const k = list[Math.floor(r() * list.length)]; const row = newRow(pi); rows.set(k, row); return { slot: slotOf(parts[pi].key), key: k, row } }
    if (x < 0.85 || !list.length) { const k = 'r' + next++; const row = newRow(pi); rows.set(k, row); list.push(k); return { slot: slotOf(parts[pi].key), key: k, row } }
    const i = Math.floor(r() * list.length), k = list[i]; list[i] = list[list.length - 1]; list.pop(); rows.delete(k)
    return { slot: slotOf(parts[pi].key), key: k, row: null }
  }
  return { parts, rows, step, slotOfRow: (row) => slotOf(parts[row.p].key), now: () => clock }
}

// ---- the sample hold ------------------------------------------------------------------------------------
// pick k slots by a salted hash: the k slots with the smallest hash32(salt + slot)
function pickSlots(salt, world) {
  if (BUG === 'hotpick') {                                   // planted: the k fullest slots at open
    const n = new Array(S).fill(0)
    for (const row of world.rows.values()) n[world.slotOfRow(row)]++
    return [...n.keys()].sort((a, b) => n[b] - n[a]).slice(0, K)
  }
  return [...Array(S).keys()].map((s) => [hash32(salt + ':' + s), s]).sort((a, b) => a[0] - b[0]).slice(0, K).map((x) => x[1])
}

class SampleHold {
  constructor(slots, world) {
    this.slots = slots
    this.in = new Uint8Array(S); for (const s of slots) this.in[s] = 1
    this.rows = new Map()                                     // key -> { slot, v, paid, sku, w }
    for (const [k, row] of world.rows) { const s = world.slotOfRow(row); if (this.in[s]) this.rows.set(k, { slot: s, ...row }) }   // the picture
  }
  apply(rec) {                                                // the copy sends only records of held slots
    if (!this.in[rec.slot]) return false
    if (rec.row === null) { if (BUG !== 'lostdelete') this.rows.delete(rec.key) }
    else this.rows.set(rec.key, { slot: rec.slot, ...rec.row })
    return true
  }
  // per-slot sums of x (count) and y over the held rows, with empty sampled slots as zeros
  perSlot(fy) {
    const ix = new Map(this.slots.map((s, i) => [s, i]))
    const x = new Float64Array(K), y = new Float64Array(K)
    for (const row of this.rows.values()) { const i = ix.get(row.slot); x[i] += 1; y[i] += fy(row) }
    return { x, y }
  }
  estimates(nowClock) {
    const f = S / K, fpc = 1 - K / S
    const { x, y: yv } = this.perSlot((r) => r.v)
    const { y: yp } = this.perSlot((r) => (r.paid ? 1 : 0))
    const used = BUG === 'skipempty' ? [...x.keys()].filter((i) => x[i] > 0) : [...x.keys()]
    const kk = used.length
    const mean = (a) => used.reduce((s, i) => s + a[i], 0) / kk
    const varOf = (a, m) => used.reduce((s, i) => s + (a[i] - m) ** 2, 0) / (kk - 1)
    const total = (a) => {
      const m = mean(a)
      const est = BUG === 'noscale' ? m * kk : m * S
      let se = S * Math.sqrt(fpc * varOf(a, m) / kk)
      if (BUG === 'rowvar') se = rowSe(a === x ? null : (r) => r.v)
      return [est, est - Z * se, est + Z * se]
    }
    const rows = [...this.rows.values()]
    const rowSe = (fy) => {                                   // planted: rows as if each were drawn alone
      if (!fy) return f * Math.sqrt(fpc * rows.length)
      return f * Math.sqrt(fpc * rows.reduce((s, r) => s + fy(r) ** 2, 0))
    }
    const ratio = (a, b) => {                                 // a/b with the linearized cluster variance
      const R = used.reduce((s, i) => s + a[i], 0) / used.reduce((s, i) => s + b[i], 0)
      const bbar = mean(b)
      const d = used.map((i) => a[i] - R * b[i])
      const s2 = d.reduce((s, v) => s + v * v, 0) / (kk - 1)
      let se = Math.sqrt(fpc * s2 / kk) / bbar
      if (BUG === 'rowvar') {
        const n = rows.length
        const vals = a === yv ? rows.map((r) => r.v) : rows.map((r) => (r.paid ? 1 : 0))
        const m = vals.reduce((s, v) => s + v, 0) / n
        se = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1) / n * fpc)
      }
      return [R, R - Z * se, R + Z * se]
    }
    let pool = rows
    if (BUG === 'window') pool = rows.filter((r) => r.w > nowClock * 0.7)   // planted: hold only recent rows
    const vals = pool.map((r) => r.v).sort((a, b) => a - b)
    const qAt = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]
    const quant = (q) => {                                    // Woodruff: an interval for F at Q, mapped back
      const Q = qAt(q)
      const ix = new Map(this.slots.map((s, i) => [s, i]))
      const below = new Float64Array(K), all = new Float64Array(K)
      for (const r of pool) { const i = ix.get(r.slot); all[i]++; if (r.v <= Q) below[i]++ }
      const Rb = below.reduce((s, v) => s + v, 0) / all.reduce((s, v) => s + v, 0)
      const abar = all.reduce((s, v) => s + v, 0) / K
      const d = [...below.keys()].map((i) => below[i] - Rb * all[i])
      let se = Math.sqrt(fpc * d.reduce((s, v) => s + v * v, 0) / (K - 1) / K) / abar
      if (BUG === 'rowvar') se = Math.sqrt(q * (1 - q) / vals.length * fpc)
      return [Q, qAt(q - Z * se), qAt(q + Z * se)]
    }
    if (BUG === 'window') {                                   // the window reports ratios and quantiles of what it holds
      const n = pool.length, m = pool.reduce((s, r) => s + r.v, 0) / n, ps = pool.filter((r) => r.paid).length / n
      const sv = Math.sqrt(pool.reduce((s, r) => s + (r.v - m) ** 2, 0) / (n - 1) / n)
      const sp = Math.sqrt(ps * (1 - ps) / n)
      return { count: total(x), sum: total(yv), mean: [m, m - Z * sv, m + Z * sv], paid: [ps, ps - Z * sp, ps + Z * sp], median: quant(0.5), p90: quant(0.9) }
    }
    return { count: total(x), sum: total(yv), mean: ratio(yv, x), paid: ratio(yp, x), median: quant(0.5), p90: quant(0.9) }
  }
}

function truthOf(world) {
  const vs = [...world.rows.values()]
  const n = vs.length, sum = vs.reduce((s, r) => s + r.v, 0)
  const sorted = vs.map((r) => r.v).sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))]
  return { count: n, sum, mean: sum / n, paid: vs.filter((r) => r.paid).length / n, median: q(0.5), p90: q(0.9),
           distinctSku: new Set(vs.map((r) => r.sku)).size, max: sorted[n - 1] }
}

// ---- one seed ---------------------------------------------------------------------------------------------
function runSeed(seed) {
  const NAMES = ['count', 'sum', 'mean', 'paid', 'median', 'p90']
  const cover = Object.fromEntries(NAMES.map((n) => [n, 0]))
  let exactBad = 0, held = 0, rowsEnd = 0, sentFrac = 0, distinctRatio = 0, maxRatio = 0, widths = Object.fromEntries(NAMES.map((n) => [n, 0]))
  const world = makeWorld(seed)                               // one resource and one stream of writes ...
  const holds = []                                            // ... and PICKS independent picks folding it
  for (let pick = 0; pick < PICKS; pick++) holds.push(new SampleHold(pickSlots('salt' + seed + '/' + pick, world), world))
  const sent = new Array(PICKS).fill(0)
  for (let w = 1; w <= W; w++) {
    const rec = world.step()
    for (let i = 0; i < PICKS; i++) if (holds[i].apply(rec)) sent[i]++
    if (w % (W / 2) === 0) for (const hold of holds) {        // exact check at two read points
      for (const [k, row] of world.rows) { const s = world.slotOfRow(row); if (hold.in[s]) { const h = hold.rows.get(k); if (!h || h.v !== row.v) exactBad++ } }
      for (const k of hold.rows.keys()) if (!world.rows.has(k)) exactBad++
    }
  }
  const t = truthOf(world)
  for (let i = 0; i < PICKS; i++) {
    const hold = holds[i], e = hold.estimates(world.now())
    for (const n of NAMES) { if (e[n][1] <= t[n] && t[n] <= e[n][2]) cover[n]++; widths[n] += (e[n][2] - e[n][1]) / 2 / t[n] / PICKS }
    held += hold.rows.size / PICKS; rowsEnd = t.count; sentFrac += sent[i] / W / PICKS
    const ds = new Set([...hold.rows.values()].map((r) => r.sku)).size
    distinctRatio += (ds * S / K) / t.distinctSku / PICKS
    let mx = -Infinity; for (const r of hold.rows.values()) if (r.v > mx) mx = r.v
    maxRatio += mx / t.max / PICKS
  }
  const lowCover = NAMES.filter((n) => cover[n] < MINCOVER)
  const fail = exactBad > 0 || lowCover.length > 0
  for (const n of NAMES) widths[n] = +widths[n].toFixed(4)
  return { seed, bug: BUG || 'none', tail: HEAVY ? 'heavy' : 'moderate', picks: PICKS, k: K, parts: world.parts.length, fail, exactBad, lowCover, cover, halfWidthRel: widths, rows: rowsEnd, heldRows: Math.round(held), sentFrac: +sentFrac.toFixed(4), distinctRatio: +distinctRatio.toFixed(3), maxRatio: +maxRatio.toFixed(3) }
}

const seeds = +(process.argv[2] ?? 20), first = +(process.argv[3] ?? 1)
let fails = 0
const agg = { cover: {}, n: 0 }
for (let s = first; s < first + seeds; s++) {
  const res = runSeed(s)
  if (res.fail) fails++
  agg.n++
  for (const [k, v] of Object.entries(res.cover)) agg.cover[k] = (agg.cover[k] ?? 0) + v
  if (process.env.OUT) appendFileSync(process.env.OUT, JSON.stringify(res) + '\n')
  if (process.env.VERBOSE) console.log(JSON.stringify(res))
}
const coverRate = Object.fromEntries(Object.entries(agg.cover).map(([k, v]) => [k, +(v / (agg.n * PICKS)).toFixed(3)]))
console.log(JSON.stringify({ part: 'sample', bug: BUG || 'none', tail: HEAVY ? 'heavy' : 'moderate', k: K, parts: PARTS, seeds, failed: fails, coverRate }))
