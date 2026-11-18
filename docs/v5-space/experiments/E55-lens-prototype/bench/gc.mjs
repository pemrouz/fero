// Claims 12, 13 and 15: links whose targets the program drops.
//   forced  (12)  node --expose-gc …  gc.mjs forced
//     1,000 connects on one row; the targets are dropped. One commit before any collection (its cost; every
//     function still runs). Then a full collection and, in the same turn, before any finalizer can run, a commit:
//     how many functions run (must be 0), how many links the delivery check ends. Then a turn: the rest.
//     A second round: a full collection and no writes: the finalizers end the links.
//   natural (13)  node … gc.mjs natural <young|old> <idle|busy|busy-writes>   (no --expose-gc)
//     cost-first's fin-time table on the lens: 1,000 links with dropped targets; when does each end?
//     idle: nothing runs; busy: 2,000 small objects every 10 ms tick (about 100 KB); busy-writes: the same plus
//     one write to the row each tick (so the delivery check can end a link without a finalizer).
//     old: the targets are promoted to the old generation (allocation churn, no forced GC) before the drop.
//   capture (15)  node --expose-gc … gc.mjs capture
//     a function that closes over its target: is the target ever collected? does a dev check see it?
import { fero } from '../proto/lens.mjs'
import { seedRows, out, r3, q, gcAsync } from './common.mjs'

const PART = process.argv[2]
const turn = () => new Promise((r) => setTimeout(r, 0))

if (PART === 'forced') {
  const f = fero('f', { data: seedRows(10000) }); f.eng.promote()
  let calls = 0
  // the targets must outlive minor collections, or a scavenge takes them before the commit: promote them first
  let pin = []
  const makePinned = (n) => { for (let i = 0; i < n; i++) { const t = { i, hits: 0 }; pin.push(t); f.data.k1.connect(t, (t, c) => { t.hits++; calls++ }) } }
  makePinned(1000)
  globalThis.gc(); globalThis.gc() // promoted to the old generation while still held
  pin = null // dropped: no major collection has run since
  await turn(); await turn()
  calls = 0
  let t0 = performance.now()
  f.set(['k1', 'n'], 1e9 + 1) // one commit while 1,000 dropped targets are not yet collected: every function still runs
  const msBefore = performance.now() - t0
  const callsBefore = calls
  // a link with a live target, for contrast
  const keep = { hits: 0 }
  f.data.k1.connect(keep, (t) => { t.hits++ })
  await turn(); await turn() // deref() keeps a target alive to the end of the job that read it
  globalThis.gc(); globalThis.gc()
  calls = 0
  const s0 = { ...f.eng.stats }
  t0 = performance.now()
  f.set(['k1', 'n'], 1e9 + 2) // same turn as the collection: no finalizer has run yet
  const msAfterGc = performance.now() - t0
  const sameTurn = { calls, endedByCheck: f.eng.stats.checkEnded - s0.checkEnded, endedByFinalizer: f.eng.stats.collected - s0.collected, liveLinks: f.eng.sels.get('k1').links.length }
  await turn(); await turn()
  const afterTurn = { endedByCheck: f.eng.stats.checkEnded, endedByFinalizer: f.eng.stats.collected, liveLinks: f.eng.sels.get('k1').links.length, keepHits: keep.hits }
  // round 2: drop 1,000 more, collect, and write nothing: the finalizers alone end them
  pin = []; makePinned(1000); pin = null
  await turn(); await turn()
  const c0 = f.eng.stats.collected
  await gcAsync(); await turn()
  const round2 = { made: 1000, endedByFinalizer: f.eng.stats.collected - c0, liveLinks: f.eng.sels.get('k1').links.length }
  out({ claim: 12, bench: 'forced', targets: 1000, commitBeforeCollection: { ms: r3(msBefore), calls: callsBefore }, commitSameTurnAfterGc: { ms: r3(msAfterGc), ...sameTurn }, afterOneTurn: afterTurn, round2, warnings: f.eng.warnings.length })
}

if (PART === 'natural') {
  const AGE = process.argv[3], MODE = process.argv[4]
  const f = fero('f', { data: seedRows(1000) })
  const ends = []
  let t0 = 0
  const origEnd = Object.getPrototypeOf(f.eng.sel('k1').view) // keep the selection alive with a held link
  const hold = f.data.k1.here()
  let targets = []
  for (let i = 0; i < 1000; i++) { const t = { i }; targets.push(t); f.data.k1.connect(t, (t, c) => { t.n = c.seq }) }
  // record when each link ends
  for (const L of f.eng.sel('k1').links) { const e = L.end.bind(L); L.end = (why) => { if (!L.dead) ends.push({ ms: performance.now() - t0, why }); e(why) } }
  if (AGE === 'old') { let junk = []; for (let r = 0; r < 60; r++) { junk = []; for (let i = 0; i < 50000; i++) junk.push({ a: i, b: 'x' + i }) } } // promote by churn
  await new Promise((r) => setTimeout(r, 50))
  targets = null
  t0 = performance.now()
  let junk = [], w = 0
  const tick = () => {
    if (MODE !== 'idle') { junk = []; for (let i = 0; i < 2000; i++) junk.push({ a: i, b: 'x' + i }) }
    if (MODE === 'busy-writes') f.set(['k1', 'n'], ++w)
  }
  const marks = {}
  for (const at of [100, 1000, 5000, 15000, 30000]) {
    while (performance.now() - t0 < at) { tick(); await new Promise((r) => setTimeout(r, 10)) }
    marks[at] = ends.length
  }
  const ms = ends.map((e) => e.ms)
  const why = {}; for (const e of ends) why[e.why] = (why[e.why] ?? 0) + 1
  out({ claim: 13, bench: 'natural', age: AGE, mode: MODE, links: 1000, endedBy: marks, never30s: 1000 - ends.length, firstMs: ms.length ? Math.round(Math.min(...ms)) : null, p50Ms: ms.length ? Math.round(q(ms, 0.5)) : null, p99Ms: ms.length ? Math.round(q(ms, 0.99)) : null, why, held: !!hold })
}

if (PART === 'capture') {
  const f = fero('f', { data: seedRows(100), dev: true })
  let probeClosing, probeFree, probeDom
  ;(() => {
    const a = { name: 'closes over its target' }
    probeClosing = new WeakRef(a)
    f.data.k1.connect(a, (_t, c) => { a.last = c.seq }) // the trap: the function names `a` itself
    const b = { name: 'uses the argument' }
    probeFree = new WeakRef(b)
    f.data.k1.connect(b, (t, c) => { t.last = c.seq })
    const el = { isConnected: false, textContent: '' } // a DOM node stand-in another piece of code removed
    probeDom = new WeakRef(el)
    f.data.k1.connect(el, (_t, c) => { el.textContent = String(c.seq) }) // the trap, on a DOM node
  })()
  for (let i = 0; i < 5; i++) { await gcAsync(); f.set(['k1', 'n'], 100 + i) }
  await new Promise((r) => setTimeout(r, 1000)); await gcAsync()
  out({ claim: 15, bench: 'capture', closingTargetCollected: probeClosing.deref() === undefined, freeTargetCollected: probeFree.deref() === undefined, domClosingCollected: probeDom.deref() === undefined, liveLinks: f.eng.sel('k1').links.length, devWarnings: f.eng.warnings })
}
