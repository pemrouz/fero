// Probe: which known operator faults are still in data at the HEAD on this box?
// One process, one source per case, seeded. Untimed. Prints one line per case.
// usage: node --experimental-strip-types --no-warnings data-bugs.mjs
import { fileURLToPath } from 'node:url'
const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
const D = await import(DATA + '/api/index.ts')
const { $, node: NODE, value: VALUE, lane } = D

const rng = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const keysOf = (h) => { const out = []; h[NODE].each((k) => out.push(k)); return out }
const out = []
const say = (name, verdict, detail) => out.push(`${name.padEnd(34)} ${verdict.padEnd(9)} ${detail}`)

// 1. az/za over a column that mixes numbers and strings: deleted rows stay in the view (E-23 part 3)
{
  let phantomRuns = 0, worst = 0
  for (let seed = 1; seed <= 20; seed++) {
    const R = rng(seed)
    const s = $({}); const L = lane(s)
    const top = s.za('points', 10), full = s.az('points')
    const live = new Set()
    let bad = 0
    for (let i = 0; i < 4000; i++) {
      const k = 'p' + Math.floor(R() * 400)
      if (live.has(k) && R() < 0.3) { L([{ type: 2, key: [k] }]); live.delete(k) }
      else { L([{ type: 0, key: [k], value: { points: R() < 0.99 ? Math.floor(R() * 101) : 'x' } }]); live.add(k) }
    }
    for (const k of keysOf(full)) if (!live.has(k)) bad++
    for (const k of keysOf(top)) if (!live.has(k)) bad++
    if (bad) phantomRuns++
    worst = Math.max(worst, bad)
  }
  say('mixed-type az/za (1% "x")', phantomRuns ? 'PRESENT' : 'absent', `${phantomRuns}/20 seeds end with deleted rows still shown; worst seed ${worst} stale keys`)
}
// 1b. control: numbers only
{
  let phantomRuns = 0
  for (let seed = 1; seed <= 20; seed++) {
    const R = rng(seed)
    const s = $({}); const L = lane(s)
    const full = s.az('points')
    const live = new Set()
    for (let i = 0; i < 4000; i++) {
      const k = 'p' + Math.floor(R() * 400)
      if (live.has(k) && R() < 0.3) { L([{ type: 2, key: [k] }]); live.delete(k) }
      else { L([{ type: 0, key: [k], value: { points: Math.floor(R() * 101) } }]); live.add(k) }
    }
    if (keysOf(full).some((k) => !live.has(k))) phantomRuns++
  }
  say('control: numbers-only az', phantomRuns ? 'PRESENT' : 'absent', `${phantomRuns}/20 seeds with stale rows`)
}
// 2. between over a mixed column (sorted index, lowerBound): stale rows after removes?
{
  let phantomRuns = 0, worst = 0
  for (let seed = 1; seed <= 20; seed++) {
    const R = rng(seed)
    const s = $({}); const L = lane(s)
    const b = s.between('points', [10, 60])
    const live = new Map()
    for (let i = 0; i < 4000; i++) {
      const k = 'p' + Math.floor(R() * 400)
      if (live.has(k) && R() < 0.3) { L([{ type: 2, key: [k] }]); live.delete(k) }
      else { const p = R() < 0.99 ? Math.floor(R() * 101) : 'x'; L([{ type: 0, key: [k], value: { points: p } }]); live.set(k, p) }
    }
    const want = new Set([...live].filter(([, p]) => typeof p === 'number' && p >= 10 && p <= 60).map(([k]) => k))
    const got = keysOf(b)
    const bad = got.filter((k) => !want.has(k)).length + [...want].filter((k) => !got.includes(k)).length
    if (bad) phantomRuns++
    worst = Math.max(worst, bad)
  }
  say('mixed-type between (1% "x")', phantomRuns ? 'PRESENT' : 'absent', `${phantomRuns}/20 seeds differ from the query; worst ${worst}`)
}
// 3. ties by arrival: the same rows in two orders give two different top-3s
{
  const rows = Array.from({ length: 10 }, (_, i) => ['r' + i, { s: 5 }])
  const a = $({}), b = $({})
  const La = lane(a), Lb = lane(b)
  for (const [k, v] of rows) La([{ type: 0, key: [k], value: v }])
  for (const [k, v] of [...rows].reverse()) Lb([{ type: 0, key: [k], value: v }])
  const ta = keysOf(a.za('s', 3)).join(','), tb = keysOf(b.za('s', 3)).join(',')
  say('za ties broken by arrival', ta !== tb ? 'PRESENT' : 'absent', `same 10 tied rows: [${ta}] vs [${tb}]`)
  const la = keysOf(a.limit(3)).join(','), lb = keysOf(b.limit(3)).join(',')
  say('limit(3) by arrival', la !== lb ? 'PRESENT' : 'absent', `[${la}] vs [${lb}] (by definition)`)
}
// 4. sum is a running float total: history-dependent, and a NaN that left poisons it
{
  const s = $({}); const L = lane(s); const sm = s.sum('v')
  L([{ type: 0, key: ['a'], value: { v: 0.1 } }]); L([{ type: 0, key: ['b'], value: { v: 0.2 } }]); L([{ type: 0, key: ['c'], value: { v: 0.3 } }])
  L([{ type: 2, key: ['a'] }]); L([{ type: 2, key: ['b'] }])
  const live = sm[VALUE]
  const fresh = $({ c: { v: 0.3 } }).sum('v')[VALUE]
  say('sum float history-dependent', live !== fresh ? 'PRESENT' : 'absent', `after add .1,.2,.3 and remove .1,.2: ${live} vs a fresh sum ${fresh}`)
  const t = $({}); const T = lane(t); const sn = t.sum('v')
  T([{ type: 0, key: ['a'], value: { v: 1 } }]); T([{ type: 0, key: ['n'], value: { v: NaN } }]); T([{ type: 2, key: ['n'] }])
  say('sum NaN poisons after removal', Number.isNaN(sn[VALUE]) ? 'PRESENT' : 'absent', `rows {a:1}; sum reads ${sn[VALUE]}`)
}
// 5. max over a mixed column depends on arrival order
{
  const vals = [9, '10', 3, 'x', 42]
  const a = $({}), b = $({}); const La = lane(a), Lb = lane(b)
  vals.forEach((v, i) => La([{ type: 0, key: ['k' + i], value: { v } }]))
  ;[...vals].reverse().forEach((v, i) => Lb([{ type: 0, key: ['k' + (vals.length - 1 - i)], value: { v } }]))
  const ma = a.max('v')[VALUE], mb = b.max('v')[VALUE]
  say('max over mixed types by order', ma !== mb ? 'PRESENT' : 'absent', `same rows, two orders: ${JSON.stringify(ma)} vs ${JSON.stringify(mb)}`)
}
// 6. distinct() with no function on object rows (fero I-37)
{
  const s = $({}); const L = lane(s)
  L([{ type: 0, key: ['a'], value: { c: 'x' } }]); L([{ type: 0, key: ['b'], value: { c: 'y' } }])
  const d = s.distinct(); const v = d[VALUE]
  const n = Object.keys(v ?? {}).length
  say('distinct() on object rows', n === 1 ? 'PRESENT' : 'absent', `2 different rows give ${n} bucket(s): ${JSON.stringify(Object.keys(v ?? {}))}`)
}
// 7. 3-arg reduce with an object init uses it AS the accumulator (fero I-38)
{
  const init = {}
  const s = $({ a: { k: 'n', v: 2 }, b: { k: 's', v: 3 } })
  const add = (acc, r) => { acc[r.k] = (acc[r.k] ?? 0) + r.v; return acc }
  const rem = (acc, r) => { acc[r.k] -= r.v; return acc }
  s.reduce(add, rem, init)
  s.reduce(add, rem, init)
  say('3-arg reduce shares object init', Object.keys(init).length ? 'PRESENT' : 'absent', `caller's init after two views: ${JSON.stringify(init)}`)
}
// 8. length(fn) counts keep an empty bucket (E-23: history, not rows)
{
  const s = $({}); const L = lane(s)
  L([{ type: 0, key: ['a'], value: { room: 'r1' } }]); L([{ type: 2, key: ['a'] }])
  const live = s.length((r) => r.room)[VALUE]
  const t = $({}); const T = lane(t); const early = t.length((r) => r.room)
  T([{ type: 0, key: ['a'], value: { room: 'r1' } }]); T([{ type: 2, key: ['a'] }])
  say('length(fn) keeps empty buckets', JSON.stringify(early[VALUE]) !== JSON.stringify(live) ? 'PRESENT' : 'absent', `view built before: ${JSON.stringify(early[VALUE])}; built after: ${JSON.stringify(live)}`)
}
console.log('data: the DATA folder (63fea66)')
for (const l of out) console.log(l)
