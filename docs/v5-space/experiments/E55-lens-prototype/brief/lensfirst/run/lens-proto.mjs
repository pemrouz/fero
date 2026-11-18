// A lens prototype over data: every step is a callable Proxy (a call is a verb on the path before it), and
// connect(target, apply) holds its target by a WeakRef and ends when a FinalizationRegistry reports the target gone.
//   node --expose-gc --experimental-strip-types --no-warnings lens-proto.mjs <rows>     (TREE = the E-50 scratch tree)
import { pathToFileURL } from 'node:url'
const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
const N = +(process.argv[2] ?? 10000), W = 200000
const mk = () => { const o = {}; for (let i = 0; i < N; i++) o['k' + i] = { name: 'user-' + i, region: 'r' + (i % 16), n: i, tags: ['a', 'b'] }; return o }
const gc = () => { globalThis.gc(); globalThis.gc() }
const med = (f) => { const r = []; for (let i = 0; i < 5; i++) { gc(); const t0 = process.hrtime.bigint(); f(i); r.push(Number(process.hrtime.bigint() - t0) / W) } r.sort((a, b) => a - b); return +r[2].toFixed(0) }

// ── the lens: one handler; a step makes a function target and a Proxy and caches nothing ──
const registry = new FinalizationRegistry((end) => { ended++; end() })
let ended = 0
const VERBS = {
  peek: (src, path) => { let v = src.rows.get(path[0]); for (let i = 1; i < path.length && v != null; i++) v = v[path[i]]; return v },
  set: (src, path, v) => src.write(path, v),
  connect: (src, path, target, apply) => {
    const ref = new WeakRef(target)
    let h
    const end = () => h.dispose()
    h = src.s.sink({ apply: (b) => { const t = ref.deref(); if (t === undefined) return end(); apply(t, b) } })   // apply must not close over target
    registry.register(target, end, h)
    return { close: () => { registry.unregister(h); end() } }
  },
}
const handler = {
  get(t, k) { if (typeof k === 'symbol' || k === 'then') return undefined; return lens(t.src, t.path === null ? [k] : [...t.path, k]) },
  apply(t, _this, args) {
    const path = t.path, verb = VERBS[path[path.length - 1]]
    if (!verb) throw new Error('no such verb: ' + String(path[path.length - 1]))
    return verb(t.src, path.slice(0, -1), ...args)
  },
}
function lens(src, path) { const t = function () {}; t.src = src; t.path = path; return new Proxy(t, handler) }

const s = D.$(mk()); s.promote()
const rows = new Map(Object.entries(mk()))                       // stands in for f.rows (a Map read)
const src = { s, rows, write: (path, v) => s.get(path[0]).get(path[1]).update(v) }
const L = lens(src, null)
let sink = 0
const out = { bench: 'lens-proto', node: process.version, rows: N, ns: {} }
// reads: ns per read of one field of a row, keys spread
out.ns['map.get(k).n'] = med(() => { for (let i = 0; i < W; i++) sink += rows.get('k' + (i % N)).n })
out.ns['L[k].n.peek()'] = med(() => { for (let i = 0; i < W; i++) sink += L['k' + (i % N)].n.peek() })
const kept = []; for (let i = 0; i < N; i++) kept.push(L['k' + i].n)
out.ns['kept lens .peek()'] = med(() => { for (let i = 0; i < W; i++) sink += kept[i % N].peek() })
out.ns['data handle s.get(k).get(n)[value]'] = med(() => { const V = Object.getOwnPropertySymbols(s).find(() => false); for (let i = 0; i < W; i++) sink += s.get('k' + (i % N)).get('n') ? 1 : 0 })
// writes: ns per write
out.ns['write: data handle'] = med((r) => { for (let i = 0; i < W; i++) s.get('k' + (i % N)).get('n').update(r * W + i) })
out.ns['write: L[k].n.set(v)'] = med((r) => { for (let i = 0; i < W; i++) L["k" + (i % N)].n.set(r * W + i + 1) })
const keptW = []; for (let i = 0; i < N; i++) keptW.push(L['k' + i].n)
out.ns['write: kept lens .set(v)'] = med((r) => { for (let i = 0; i < W; i++) keptW[i % N].set(r * W + i + 4) })
out.ns['write: data handle (again)'] = med((r) => { for (let i = 0; i < W; i++) s.get('k' + (i % N)).get('n').update(r * W + i + 5) })
// sinks: ns per write with one sink attached
let c = 0
const strong = s.sink({ apply: (b) => { c++ } })
out.ns['write + strong sink'] = med((r) => { for (let i = 0; i < W; i++) s.get('k' + (i % N)).get('n').update(r * W + i + 2) })
strong.dispose()
let target = { count: 0 }
const link = L.connect(target, (t, b) => { t.count++ })
out.ns['write + weak connect'] = med((r) => { for (let i = 0; i < W; i++) s.get('k' + (i % N)).get('n').update(r * W + i + 3) })
out.fired = target.count
// lifetime: 1,000 weak connects, targets dropped, then GC
const before = ended
;(() => { for (let i = 0; i < 1000; i++) L.connect({ i }, (t, b) => { t.last = b }) })()
const t0 = performance.now()
s.get('k1').get('n').update(-1)                                  // one commit before any GC: all 1,001 sinks still run
const perCommitBefore = performance.now() - t0
for (let i = 0; i < 6 && ended - before < 1000; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)) }
out.weak = { made: 1000, endedAfterGc: ended - before, msOneCommitWith1000DeadTargets: +perCommitBefore.toFixed(3) }
// without a forced GC: do the finalizers ever run while the program allocates?
const before2 = ended
;(() => { for (let i = 0; i < 1000; i++) L.connect({ i }, (t, b) => { t.last = b }) })()
let junk = []; const t1 = performance.now()
while (ended - before2 < 1000 && performance.now() - t1 < 5000) { for (let i = 0; i < 20000; i++) junk.push({ i }); if (junk.length > 2e6) junk = []; await new Promise((r) => setTimeout(r, 1)) }
out.weakNoForcedGc = { made: 1000, ended: ended - before2, ms: +(performance.now() - t1).toFixed(0) }
// a target that stays reachable is never ended; an idle program (no allocation) for 2 s:
const before3 = ended
;(() => { for (let i = 0; i < 1000; i++) L.connect({ i }, (t, b) => { t.last = b }) })()
await new Promise((r) => setTimeout(r, 2000))
out.weakIdle2s = { made: 1000, ended: ended - before3 }
link.close(); out.sinkGuard = sink > 0
console.log(JSON.stringify(out))
