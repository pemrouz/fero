// The contract's pure-oracle claims, on data's real engine (views) against specs written apart from src/lib.mjs.
//   XB-2  the total order in both directions, UTF-16 key ties: za(f, 10) and az(f, 10) hold no non-number while
//         ten numbers exist; the numeric part equals E-23's cmpTotal (numbers, ties by key); the whole order
//         equals a spec written as tuples. Planted: za as the full reverse of az (strings on top); utf8 (key ties
//         by UTF-8 bytes).
//   XB-3  one numeric projection: sum, avg, min, max, median and by().sum() each equal one pure query that skips
//         non-numbers. Planted: plus (data's own sum: unary-plus coercion).
//   XB-5  by(field) and by(field, { step }) equal the query under the typed key rule (an equality written apart:
//         same type and SameValueZero); eq(f, NaN), eq(f, -0), eq(f, 1) follow SameValueZero. Planted: string
//         (String(v) bucket keys: 1 and '1' merge).
//   XB-6  at depth 2, whole-resource za(10) and pages tie and page by (partition, row). Planted: rowkey (ties by
//         the row key only).
//   XB-13 limit over an ordered parent is a window: a prototype limit that reads the parent's order channel
//         (wantsOrder) equals za(f, n). Planted: arrival (data's limit today).
//   node xb-pure.mjs <claim> <seeds> <commits>
import { rng, canon, num, svz, bkey, bkeyString, stepKey, rowCmp, afterCursor, applyRec, E23Sum, WideSum, cmpVal } from '../src/lib.mjs'
import { D, NODE, VALUE, laneOf, keysOf, eq, ByView, SumView } from '../src/ops.mjs'

const CLAIM = process.argv[2], SEEDS = +(process.argv[3] ?? 1000), COMMITS = +(process.argv[4] ?? 200)
const MUTATE = process.env.MUTATE ?? ''
const totals = new Map()
let first = null, curSeed = 0
const tally = (name, ok, ex) => {
  let s = totals.get(name)
  if (s === undefined) totals.set(name, (s = { n: 0, bad: 0, seeds: new Set() }))
  s.n++
  if (!ok) { s.bad++; s.seeds.add(curSeed); if (first === null) first = `seed ${curSeed} ${name}: ${ex()}`.slice(0, 400) }
}

// ── specs written apart ───────────────────────────────────────────────────────────────────────────────
const u16 = (a, b) => { // UTF-16 code units, by hand
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { const x = a.charCodeAt(i), y = b.charCodeAt(i); if (x !== y) return x - y }
  return a.length - b.length
}
const utf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
// the order as a tuple per value: [class, number or text]; za negates the number only
function tupleOf(v, dir) {
  if (typeof v === 'number' && !Number.isNaN(v)) return [0, dir === 'za' ? -v : v]
  if (typeof v === 'string') return [1, v]
  if (typeof v === 'boolean') return [2, v ? 1 : 0]
  if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return [4, 0]
  return [3, canon(v)]
}
function specCmp(dir) {
  return (a, b) => {
    const x = tupleOf(a.s, dir), y = tupleOf(b.s, dir)
    if (x[0] !== y[0]) return x[0] - y[0]
    if (x[0] === 1 || x[0] === 3) { const c = u16(x[1], y[1]); if (c !== 0) return c }
    else if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1
    return u16(a.id, b.id)
  }
}
// E-23's cmpTotal (lib.ts:216-225), copied: rankable numbers first, descending; the rest after; ties by key
const rankable = (x) => typeof x === 'number' && x === x
const cmpTotal = (a, b) => { const ra = rankable(a.s), rb = rankable(b.s); if (ra && rb) { if (a.s !== b.s) return a.s > b.s ? -1 : 1 } else if (ra !== rb) return ra ? -1 : 1; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }

function genS(r) {
  const u = r()
  if (u < 0.97) return Math.floor(r() * 10) // ties common
  if (u < 0.975) return 'x'
  if (u < 0.98) return '\u{1F600}'
  if (u < 0.985) return 'ｚ'
  if (u < 0.99) return r() < 0.5
  if (u < 0.993) return { o: 1 }
  if (u < 0.996) return null
  return NaN
}
const KEYS = (n) => Array.from({ length: n }, (_, i) => ['k' + i, 'k\u{1F600}' + i, 'kｚ' + i][i % 3])

function xb2(seed) {
  const r = rng(seed * 11 + 1)
  const src = D.$({}), lane = laneOf(src), truth = new Map(), keys = KEYS(60)
  const cmpFor = (dir) => {
    if (MUTATE === 'reverse' && dir === 'za') { const c = rowCmp('s', 'az'); return (a, b) => -c(a, b) }
    if (MUTATE === 'utf8') return (a, b) => cmpVal(dir, a.s, b.s) || utf8(a.id, b.id)
    return rowCmp('s', dir)
  }
  const vz = src.az(cmpFor('za'), 10), va = src.az(cmpFor('az'), 10)
  for (let c = 0; c < COMMITS; c++) {
    const k = keys[Math.floor(r() * keys.length)]
    const rec = !truth.has(k) ? { type: 1, key: [], at: k, value: { id: k, s: genS(r) } } : r() < 0.85 ? { type: 0, key: [k, 's'], value: genS(r) } : { type: 2, key: [k] }
    lane([rec]); applyRec(truth, rec)
    const rows = [...truth.values()]
    const nums = rows.filter((x) => rankable(x.s)).length
    for (const [dir, v] of [['za', vz], ['az', va]]) {
      const ks = keysOf(v)
      const got = ks.map((k) => truth.get(k))
      if (nums >= 10) tally(`${dir}(s, 10) holds no non-number while ten numbers exist`, got.every((x) => rankable(x.s)), () => canon(got.map((x) => x.s)))
      const spec = [...rows].sort(specCmp(dir)).slice(0, 10).map((x) => x.id)
      tally(`${dir}(s, 10) = the tuple spec (UTF-16 key ties)`, canon(ks) === canon(spec), () => `${canon(ks)} vs ${canon(spec)}`)
      if (dir === 'za') { // E-23's cmpTotal on the numeric part
        const t = [...rows].sort(cmpTotal).filter((x) => rankable(x.s)).slice(0, 10).map((x) => x.id)
        const g = ks.filter((k) => rankable(truth.get(k).s))
        tally("za(s, 10)'s numbers = E-23's cmpTotal", canon(g) === canon(t.slice(0, g.length)), () => `${canon(g)} vs ${canon(t)}`)
      }
    }
  }
}

// a dirty column: E-23's dirty domain for points
function genDirty(r) {
  const u = r()
  if (u < 0.6) return Math.floor(r() * 101)
  if (u < 0.7) return Math.round(r() * 1e4) / 100
  if (u < 0.75) return null
  if (u < 0.8) return undefined
  if (u < 0.86) return String(Math.floor(r() * 101))
  if (u < 0.9) return 'x'
  if (u < 0.92) return r() < 0.5
  if (u < 0.94) return { o: 1 }
  if (u < 0.96) return NaN
  if (u < 0.97) return -0
  if (u < 0.98) return Infinity
  if (u < 0.99) return -Infinity
  return 0
}
function oSumExact(xs) { // the pure query: numbers only, exact (Shewchuk add-only; the values stay small), -0 rule
  let nan = 0, pinf = 0, ninf = 0, nf = 0, nz = 0
  const s = new E23Sum()
  for (const x of xs) { if (x !== x) nan++; else if (x === Infinity) pinf++; else if (x === -Infinity) ninf++; else { nf++; if (Object.is(x, -0)) nz++; s.add(x) } }
  if (nan || (pinf && ninf)) return NaN
  if (pinf) return Infinity
  if (ninf) return -Infinity
  if (nf > 0 && nz === nf) return -0
  const v = s.value(); return v === 0 ? 0 : v
}
const eqZ = (a, b) => Object.is(a, b) || (a === 0 && b === 0) // min/max/median: -0 and 0 tie

function xb3(seed) {
  const r = rng(seed * 13 + 5)
  const src = D.$({}), lane = laneOf(src), truth = new Map(), keys = KEYS(80)
  const nums = src.filter((x) => num(x.p) !== undefined) // the projection, as a row test, ahead of data's own min/max/median
  const sum = MUTATE === 'plus' ? src.sum('p') : new SumView(src, 'p')
  const cnt = nums.length()
  const mn = nums.min('p'), mx = nums.max('p'), md = src.median('p') // data's quantiles already skip non-numbers (and median is not on a filter's handle)
  const by = new ByView(src, 'g', { agg: 'sum', of: 'p' })
  const read = (v) => (v instanceof SumView ? v.value : v[VALUE])
  for (let c = 0; c < COMMITS; c++) {
    const k = keys[Math.floor(r() * keys.length)]
    const rec = !truth.has(k) ? { type: 1, key: [], at: k, value: { id: k, p: genDirty(r), g: 'g' + Math.floor(r() * 4) } } : r() < 0.85 ? (() => { const v = genDirty(r); return v === undefined ? { type: 2, key: [k, 'p'] } : { type: 0, key: [k, 'p'], value: v } })() : { type: 2, key: [k] }
    lane([rec]); applyRec(truth, rec)
    const xs = [...truth.values()].map((x) => x.p).filter((x) => typeof x === 'number' && !Number.isNaN(x))
    const qs = oSumExact(xs)
    tally('sum = the pure query', Object.is(read(sum), qs), () => `${canon(read(sum))} vs ${canon(qs)}`)
    const qa = xs.length === 0 ? undefined : qs / xs.length
    const av = xs.length === 0 ? undefined : read(sum) / cnt[VALUE]
    tally('avg = the pure query', Object.is(av, qa) || (Number.isNaN(av) && Number.isNaN(qa)), () => `${canon(av)} vs ${canon(qa)}`)
    const sorted = [...xs].sort((a, b) => a - b)
    const qmin = sorted.length ? sorted[0] : undefined, qmax = sorted.length ? sorted[sorted.length - 1] : undefined
    tally('min = the pure query', eqZ(mn[VALUE], qmin), () => `${canon(mn[VALUE])} vs ${canon(qmin)}`)
    tally('max = the pure query', eqZ(mx[VALUE], qmax), () => `${canon(mx[VALUE])} vs ${canon(qmax)}`)
    let qmed
    if (sorted.length) { const h = (sorted.length - 1) * 0.5, lo = Math.floor(h), f = h - lo; qmed = f === 0 ? sorted[lo] : sorted[lo] + f * (sorted[lo + 1] - sorted[lo]) }
    tally('median = the pure query', eqZ(md[VALUE], qmed) || (Number.isNaN(md[VALUE]) && Number.isNaN(qmed)), () => `${canon(md[VALUE])} vs ${canon(qmed)}`)
    const qb = new Map()
    for (const x of truth.values()) { const b = bkey(x.g); let a = qb.get(b); if (!a) qb.set(b, (a = [])); if (typeof x.p === 'number' && !Number.isNaN(x.p)) a.push(x.p) }
    const snap = by.snapshot()
    let ok = snap.size === qb.size
    for (const [b, a] of qb) if (!Object.is(snap.get(b), oSumExact(a))) ok = false
    tally('by(g).sum(p) = the pure query', ok, () => `${canon(snap)} vs ${canon(qb)}`)
  }
}

function xb5(seed) {
  const r = rng(seed * 17 + 9)
  const src = D.$({}), lane = laneOf(src), truth = new Map(), keys = KEYS(80)
  const keyFn = MUTATE === 'string' ? bkeyString : bkey
  const by = new ByView(src, 'v', { agg: 'length', keyFn })
  const byStep = new ByView(src, 'v', { agg: 'length', step: 10 })
  const eqs = [[NaN, eq(src, 'v', NaN)], [-0, eq(src, 'v', -0)], [0, eq(src, 'v', 0)], [1, eq(src, 'v', 1)], ['1', eq(src, 'v', '1')], [null, eq(src, 'v', null)], [true, eq(src, 'v', true)]]
  const gen = (r) => { const u = r(); return u < 0.2 ? 1 : u < 0.3 ? '1' : u < 0.4 ? NaN : u < 0.5 ? -0 : u < 0.6 ? 0 : u < 0.65 ? null : u < 0.7 ? true : u < 0.73 ? 'true' : u < 0.76 ? undefined : u < 0.78 ? { o: 1 } : u < 0.8 ? Infinity : Math.floor(r() * 60) - 20 }
  // the typed key rule, written as an equality (no key strings): same type, then SameValueZero
  const same = (a, b) => (a === null || b === null ? a === b : typeof a === typeof b && (a === b || (a !== a && b !== b)))
  const scalarOk = (v) => v === null || ['number', 'string', 'boolean'].includes(typeof v)
  for (let c = 0; c < COMMITS; c++) {
    const k = keys[Math.floor(r() * keys.length)]
    const v = gen(r)
    const rec = !truth.has(k) ? { type: 1, key: [], at: k, value: v === undefined ? { id: k } : { id: k, v } } : r() < 0.85 ? (v === undefined ? { type: 2, key: [k, 'v'] } : { type: 0, key: [k, 'v'], value: v }) : { type: 2, key: [k] }
    lane([rec]); applyRec(truth, rec)
    const rows = [...truth.values()]
    // by(v): buckets as [value, count], matched by `same`
    const qb = []
    for (const x of rows) { if (!scalarOk(x.v)) continue; const e = qb.find((y) => same(y[0], x.v)); if (e) e[1]++; else qb.push([x.v, 1]) }
    const got = [...by.m.values()].map((e) => [e.key, e.n])
    let ok = got.length === qb.length && qb.every(([v, n]) => got.some(([w, m]) => same(v, w) && m === n))
    tally('by(v).length() = the typed key rule', ok, () => `${canon(got)} vs ${canon(qb)}`)
    const qs = []
    for (const x of rows) { if (typeof x.v !== 'number' || !Number.isFinite(x.v)) continue; const b = Math.floor(x.v / 10) * 10; const e = qs.find((y) => y[0] === b); if (e) e[1]++; else qs.push([b, 1]) }
    const gs = [...byStep.m.values()].map((e) => [e.key, e.n])
    ok = gs.length === qs.length && qs.every(([v, n]) => gs.some(([w, m]) => v === w && m === n))
    tally('by(v, { step: 10 }).length() = the typed key rule', ok, () => `${canon(gs)} vs ${canon(qs)}`)
    for (const [w, view] of eqs) {
      const q = rows.filter((x) => same(x.v, w)).map((x) => x.id).sort()
      tally(`eq(v, ${canon(w)}) follows SameValueZero`, canon(keysOf(view).sort()) === canon(q), () => `${canon(keysOf(view))} vs ${canon(q)}`)
    }
  }
}

function xb6(seed) { // depth 2: rows keyed by (partition, row); row keys repeat across partitions
  const r = rng(seed * 19 + 3)
  const src = D.$({}), lane = laneOf(src), truth = new Map()
  const parts = ['ada', 'bob', 'cy', 'dee', '\u{1F600}e'], ids = Array.from({ length: 12 }, (_, i) => 'o' + i)
  const cmpFor = (dir) => MUTATE === 'rowkey' ? rowCmp('s', dir, 1) : rowCmp('s', dir, 2)
  const vz = src.az(cmpFor('za'), 10)
  const CUR = [5, 'bob', 'o3']
  const pg = src.filter(MUTATE === 'rowkey' ? afterCursor('s', 'za', [CUR[0], CUR[2]], 1) : afterCursor('s', 'za', CUR, 2)).az(cmpFor('za'), 10)
  const spec = (a, b) => (a.s !== b.s ? b.s - a.s : u16(a.p, b.p) || u16(a.id, b.id))
  for (let c = 0; c < COMMITS; c++) {
    const p = parts[Math.floor(r() * parts.length)], id = ids[Math.floor(r() * ids.length)], k = p + '\u0000' + id
    const rec = !truth.has(k) ? { type: 1, key: [], at: k, value: { p, id, s: Math.floor(r() * 10) } } : r() < 0.8 ? { type: 0, key: [k, 's'], value: Math.floor(r() * 10) } : { type: 2, key: [k] }
    lane([rec]); applyRec(truth, rec)
    const rows = [...truth.values()].sort(spec)
    const path = (x) => x.p + '/' + x.id
    const qz = rows.slice(0, 10).map(path)
    const gz = keysOf(vz).map((k) => path(truth.get(k)))
    tally('depth 2: za(s, 10) by key path', canon(gz) === canon(qz), () => `${canon(gz)} vs ${canon(qz)}`)
    const after = (x) => spec(x, { s: CUR[0], p: CUR[1], id: CUR[2] }) > 0
    const qp = rows.filter(after).slice(0, 10).map(path)
    const gp = keysOf(pg).map((k) => path(truth.get(k)))
    tally('depth 2: page after [5, bob, o3] by key path', canon(gp) === canon(qp), () => `${canon(gp)} vs ${canon(qp)}`)
  }
}

function xb13(seed) { // limit over an ordered parent, read through the parent's order channel
  const r = rng(seed * 23 + 7)
  const src = D.$({}), lane = laneOf(src), truth = new Map(), keys = KEYS(40)
  const parent = src.az(rowCmp('s', 'za'))
  const N = 5
  let lim
  if (MUTATE === 'arrival') { const v = parent.limit(N); lim = () => keysOf(v) }
  else { // the window F-25 asks for: the first n keys of the parent's order, kept from its order deltas
    const order = []
    parent.sink({
      wantsOrder: true,
      init: (snap, ord) => { order.push(...ord) },
      apply: (b) => { for (const d of b.order ?? []) { if (d.op === 'orderRemove') order.splice(order.indexOf(d.key), 1); else if (d.op === 'orderInsert') order.splice(d.index, 0, d.key); else { order.splice(order.indexOf(d.key), 1); order.splice(d.index, 0, d.key) } } },
    })
    lim = () => order.slice(0, N)
  }
  const win = src.az(rowCmp('s', 'za'), N)
  for (let c = 0; c < COMMITS; c++) {
    const k = keys[Math.floor(r() * keys.length)]
    const rec = !truth.has(k) ? { type: 1, key: [], at: k, value: { id: k, s: Math.floor(r() * 10) } } : r() < 0.85 ? { type: 0, key: [k, 's'], value: Math.floor(r() * 10) } : { type: 2, key: [k] }
    lane([rec]); applyRec(truth, rec)
    tally('za(s).limit(5) = za(s, 5)', canon(lim()) === canon(keysOf(win)), () => `${canon(lim())} vs ${canon(keysOf(win))}`)
  }
}

const F = { 'XB-2': xb2, 'XB-3': xb3, 'XB-5': xb5, 'XB-6': xb6, 'XB-13': xb13 }[CLAIM]
const t0 = performance.now()
for (let s = 1; s <= SEEDS; s++) { curSeed = s; F(s) }
const byCheck = Object.fromEntries([...totals].map(([n, s]) => [n, { checks: s.n, mismatches: s.bad, seedsFailed: s.seeds.size }]))
const seedsFailed = new Set([...totals.values()].flatMap((s) => [...s.seeds])).size
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: CLAIM, bench: 'pure-oracle', planted: MUTATE || null, seeds: SEEDS, commits: COMMITS, seedsFailed, checks: [...totals.values()].reduce((a, s) => a + s.n, 0), mismatches: [...totals.values()].reduce((a, s) => a + s.bad, 0), seconds: Math.round(performance.now() - t0) / 1000, byCheck, first }))
