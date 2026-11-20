// A3's cost and XA-1: building one served view on a copy of N rows (a failover rebuild, from the copy's current rows),
// and what the build does to the copy's event loop.
//   build    the time of the SUB that builds best(10) (data's ordered view, C1 comparator), byTeam (exact sums per
//            bucket) and total (an exact sum), and answers its picture; the median of 3.
//   delay    the event loop's delay while the build runs: a 1 ms interval records how late each tick fires; the
//            longest stall, and the p99 of the ticks, from the build's start to 20 ms after it.
//              one block: the build as one synchronous call (today's data; the critic's planted case);
//              sliced:    byTeam and total built in slices of S rows with a yield between (setImmediate), the commits
//                         that land between slices applied to the rows already counted (the key list itself is one
//                         copy of the store: data has no resumable key iterator). best(10) cannot be sliced from
//                         outside data (its index is built in one sort on first read), so it has no sliced way.
//   check    the sliced build, with 200 seeded commits between its slices, equals the exact query from scratch.
//   node --expose-gc --experimental-strip-types rebuild.mjs <N>
import { newCopy, sub, gcAsync, now, med, r1, r3, out, rng } from './common.mjs'
import { ExactSum } from '../proto/served.mjs'
import { exactSum } from '../proto/oracle.mjs'

const N = +process.argv[2]
const specs = { best: { method: 'best', arg: 10 }, byTeam: { method: 'byTeam', arg: null }, total: { method: 'total', arg: null } }
const res = { buildMs: {}, oneBlock: {}, sliced: {} }
// build times
for (const [name, spec] of Object.entries(specs)) {
  const xs = []
  for (let rep = 0; rep < 3; rep++) {
    const { c } = newCopy(N)
    await gcAsync()
    const t0 = now()
    sub(c, spec)
    xs.push(Number(now() - t0) / 1e6)
  }
  res.buildMs[name] = r1(med(xs))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function measure(fn) {
  // a 1 ms interval records how late each tick fires (the event loop's delay); the longest stall is the number that
  // matters: one build is one event, so a p99 over idle 1 ms ticks would hide it
  const lates = []
  let last = performance.now()
  const iv = setInterval(() => { const t = performance.now(); lates.push(t - last - 1); last = t }, 1)
  await sleep(20)
  lates.length = 0
  const t0 = now()
  await fn()
  const ms = Number(now() - t0) / 1e6
  await sleep(20)
  clearInterval(iv)
  lates.sort((a, b) => a - b)
  return { maxStallMs: r1(lates.at(-1) ?? 0), p99Ms: r1(lates[Math.floor(0.99 * (lates.length - 1))] ?? 0), samples: lates.length, wallMs: r1(ms) }
}
// one block
for (const [name, spec] of Object.entries(specs)) {
  const { c } = newCopy(N)
  await gcAsync()
  res.oneBlock[name] = await measure(async () => { await new Promise((r) => setImmediate(r)); sub(c, spec); await new Promise((r) => setImmediate(r)) })
}
// sliced: buckets (exact sum per team) and one exact sum, S rows a slice; commits between slices
async function slicedBuild(c, kind, S, between) {
  // data has no resumable key iterator: the key list is one copy of the store (one O(N) block, timed as part of the
  // build). Each slice then reads the LIVE row of each key; a commit between slices applies to keys already counted,
  // and counts at once a key added that was not counted yet (so the slice that reaches it skips it)
  const src = c.src, acc = new Map(), done = new Set()
  const bk = (row) => (kind === 'byTeam' ? row.team : '')
  const get = (b) => { let a = acc.get(b); if (!a) acc.set(b, (a = new ExactSum())); return a }
  const sub_ = src.connect({ wantsOrder: false, origin: null, apply: (b) => {
    for (const d of b.rows) {
      if (!done.has(d.key)) { if (d.op === 'add') { done.add(d.key); get(bk(d.row)).add(d.row.pts) } continue }
      if (d.op !== 'add') get(bk(d.prev)).sub(d.prev.pts)
      if (d.op !== 'remove') get(bk(d.row)).add(d.row.pts)
    }
  } })
  const keys = [...src.snapshot().keys()]
  for (let i = 0; i < keys.length; i += S) {
    await new Promise((r) => setImmediate(r))
    between?.()
    for (let j = i; j < Math.min(i + S, keys.length); j++) {
      const k = keys[j]
      if (done.has(k)) continue
      const row = src.get(k)
      if (row === undefined) continue
      done.add(k); get(bk(row)).add(row.pts)
    }
  }
  sub_.dispose()
  return acc
}
for (const kind of ['byTeam', 'total']) {
  const { c } = newCopy(N)
  await gcAsync()
  res.sliced[kind] = { slice: 20000, ...(await measure(() => slicedBuild(c, kind, 20000))) }
}
// the sliced build is right with commits between its slices (checked against the exact query from scratch)
{
  const { c } = newCopy(Math.min(N, 100000))
  const r = rng(9), n = c.src.rowCount()
  let p = 0, bad = 0
  for (const kind of ['byTeam', 'total']) {
    const acc = await slicedBuild(c, kind, 5000, () => { for (let i = 0; i < 10; i++) { const k = 'k' + (r() % n); const x = r() % 3; c.fold(++p, [x === 0 ? { k, f: 'pts', v: ((r() % 2001) - 1000) / 10 } : x === 1 ? { k, f: 'team', v: 't' + (r() % 4) } : { k, del: true }]) } })
    const truth = new Map()
    c.src.each((k, row) => { const bk = kind === 'byTeam' ? row.team : ''; if (!truth.has(bk)) truth.set(bk, []); truth.get(bk).push(row.pts) })
    for (const [bk, vs] of truth) if (!Object.is(exactSum(vs), acc.get(bk)?.value())) bad++
  }
  res.slicedCheck = { rows: n, commitsBetweenSlices: p, unequalBuckets: bad }
}
out({ claim: 'A3/XA-1', bench: 'rebuild', rows: N, ...res })
