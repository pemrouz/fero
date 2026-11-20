// E-55's seeded lifetime checks, run against the owner's connect (one process; data's real engine).
//   node --experimental-strip-types sims.mjs <part> [seeds]
// picture (E-55 claim 7)  random writes and batches; links made at random points (inside an open batch, inside another
//                         link's call), on a server and on a client (loopback, JSON frames), on the whole resource, a
//                         row, a depth-2 partition. Every link is connect(fn, opts) or a for-await loop over connect(),
//                         ended by disconnect(), its signal, its until, or once. A callback applies commit.changes to
//                         its own Map; after every step it must equal the source. Every change's prev must equal what
//                         the Map held. A for-await loop pauses at seeded steps: each turn it gets the merged changes
//                         since its last turn (merge), or every commit in order (every: from 'now'); a merge turn must
//                         leave its Map equal to the source, an every loop must equal it once drained. Some links are
//                         ended twice, or their signal aborts after disconnect. At the end no selection may be left.
// views (E-55 claim 26)   views right of a handle (h.gt(...), operators left of connect): after the handle's
//                         disconnect, its signal, its until, once, or the view link's own disconnect, no sink of a
//                         view is called again and the resource keeps no view and no selection.
// share (E-55 claim 9)    1,000 bare connect() handles and 1,000 connect(fn) on one row of a client (loopback, JSON
//                         frames): one upstream SUB, one decode, one fold and one commit.text() per commit; every
//                         handle disconnected twice; one UNSUB after the linger.
// Env: E56_FIRST=sync (the first call inside connect(), E-55's way), E56_MUTATE and E55_MUTATE (planted bugs).
import { EventEmitter } from 'node:events'
import { fero, Loop, D } from '../../../E55-lens-prototype/proto/lens.mjs'
import { policy, MUT, counts } from '../proto/connect.mjs'

if (process.env.E56_FIRST === 'sync') policy.first = 'sync'
const PART = process.argv[2], SEEDS = +(process.argv[3] ?? 1000)
const J = (x) => JSON.stringify(x)
const out = (o) => console.log(J({ exp: 'E-56', node: process.version, first: policy.first, mutate: MUT || process.env.E55_MUTATE || '', ...o }))
const flush = () => new Promise((r) => setImmediate(r))
// E-55's seeded generator (bench/common.mjs)
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
// a socket-like thing for `until`: it can say whether it has closed (destroyed), and says 'close' once
const sockLike = () => { const em = new EventEmitter(); em.destroyed = false; return em }
const closeIt = (em) => { if (!em.destroyed) { em.destroyed = true; em.emit('close') } }

// ── claim 7 on connect ──────────────────────────────────────────────────────────────────────────────────────────
async function picture(seed) {
  const r = rng(seed), pick = (a) => a[r() % a.length], chance = (p) => r() % 1000 < p * 1000
  const depth = seed % 2 === 0 ? 1 : 2
  const seedData = {}, PARTS = ['p0', 'p1', 'p2', 'p3']
  let next = 0
  const newRow = () => ({ n: r() % 100, s: r() % 5, t: 'x' + (r() % 7) })
  if (depth === 1) for (let i = 0; i < 12; i++) seedData['k' + next++] = newRow()
  else for (const p of PARTS) { seedData[p] = {}; for (let i = 0; i < 4; i++) seedData[p]['m' + next++] = newRow() }
  const srv = fero('s', { depth, data: seedData })
  const tr = new Loop(srv, { json: true })
  const cl = fero('s', { depth, role: 'client', transport: tr, linger: 0 })
  const sinks = [], loops = []
  const fail = { doubled: 0, missed: 0, badPrev: 0, unequal: 0, firstsNotEmpty: 0, calledAfterEnd: 0, onceWrong: 0, iterUnequal: 0, iterEveryUnequal: 0, rowStateAhead: 0, selsLeft: 0 }
  const seen = { fnSinks: 0, onceSinks: 0, mergeLoops: 0, everyLoops: 0, turns: 0, mergedCommits: 0, everyLagTurns: 0, endedTwice: 0, byEnd: {}, mergeTurns: 0, manyStateAheadTurns: 0, jobsWithManyCommits: 0, readds: 0, skippedClientMidBatch: 0 }
  // the oracle is the server's rows. A client link's first picture taken inside an open server batch, or while the
  // server is still handing a commit to its sinks, may lack writes the server already holds (they reach the client
  // with that commit's frame, and the link then gets them as changes), so a check of such a picture is skipped and
  // counted. With the first call a microtask later (the default) this never happens; with E56_FIRST=sync it does.
  const midClient = (t) => t.onClient && (srv.eng.rt.midBatch || srv.eng.rt.connectSeq() !== 0)
  const removed = [] // keys removed, so a write can bring one back (a remove then an add of one key, merged in one turn)
  const liveKeys = () => depth === 1 ? [...srv.eng.src.snapshot().keys()] : PARTS.flatMap((p) => [...(srv.eng.parts.get(p)?.snapshot().keys() ?? [])].map((k) => [p, k]))
  const expected = (t) => {
    const m = new Map()
    if (depth === 1) {
      if (t.path.length === 0) for (const [k, v] of srv.eng.src.snapshot()) m.set(k, v)
      else { const v = srv.eng.src.get(t.path[0]); if (v !== undefined) m.set(t.path[0], v) }
    } else { const ps = srv.eng.parts.get(t.path[0]); if (ps) for (const [k, v] of ps.snapshot()) m.set(k, v) }
    return m
  }
  const same = (m, e) => { if (e.size !== m.size) return false; for (const [k, v] of e) if (J(m.get(k)) !== J(v)) return false; return true }
  const applyTo = (t, c) => {
    if (c.first) { if (t.map.size !== 0 && !t.loop) fail.firstsNotEmpty++; t.map.clear(); for (const ch of c.changes) t.map.set(ch.key, ch.row); return }
    for (const ch of c.changes) {
      const had = t.map.has(ch.key)
      if (ch.op === 'add') { if (had) fail.doubled++; t.map.set(ch.key, ch.row); continue }
      if (!had) { fail.missed++; if (ch.op === 'update') t.map.set(ch.key, ch.row); continue }
      if (J(t.map.get(ch.key)) !== J(ch.prev)) fail.badPrev++
      if (ch.op === 'update') t.map.set(ch.key, ch.row); else t.map.delete(ch.key)
    }
  }
  const endWay = () => { const a = r() % 100; return a < 50 ? 'disconnect' : a < 75 ? 'signal' : 'until' }
  const optsFor = (t) => {
    if (t.end === 'signal') { t.ac = new AbortController(); return { signal: t.ac.signal } }
    if (t.end === 'until') { t.em = sockLike(); return { until: t.em } }
    return {}
  }
  const endIt = (t) => {
    t.ended = true
    seen.byEnd[t.end] = (seen.byEnd[t.end] ?? 0) + 1
    if (t.end === 'signal') t.ac.abort(); else if (t.end === 'until') closeIt(t.em); else t.h.disconnect()
    if (chance(0.3)) { seen.endedTwice++; if (t.end === 'signal' || chance(0.5)) t.h.disconnect(); else t.ac?.abort() } // a second end: must do nothing
    if (t.release) { const f = t.release; t.release = null; f() }
  }
  const makeSink = (nested = false) => {
    const onClient = chance(0.5)
    const f = onClient ? cl : srv
    let path
    if (depth === 1) path = chance(0.3) ? [] : [pick(liveKeys().concat(['k' + next]))]
    else path = [pick(PARTS)]
    const t = { map: new Map(), path, onClient, nest: nested ? 0 : 2, ended: false, end: endWay() }
    const lens = f.data.at(...path)
    const a = r() % 100
    if (a < 55) { // a callback
      seen.fnSinks++
      t.h = lens.connect((s, c) => {
        if (t.ended) fail.calledAfterEnd++
        applyTo(t, c)
        if (t.nest > 0 && chance(0.05)) { t.nest--; makeSink(true) } // an effect that connects
      }, optsFor(t))
      sinks.push(t)
    } else if (a < 65) { // once: one call, the picture
      seen.onceSinks++
      t.once = true; t.calls = 0
      t.h = lens.connect((s, c) => { t.calls++; if (t.ended) fail.calledAfterEnd++; if (!c.first || t.calls > 1) fail.onceWrong++; applyTo(t, c); if (c.first && midClient(t)) seen.skippedClientMidBatch++; else if (!same(t.map, expected(t))) fail.unequal++ }, { ...optsFor(t), once: true })
      sinks.push(t)
    } else { // a for-await loop: merge (no from) or every commit (from: 'now'); a third of them with a callback too
      const every = chance(0.3)
      every ? seen.everyLoops++ : seen.mergeLoops++
      t.loop = every ? 'every' : 'merge'; t.release = null; t.fast = false
      const opts = optsFor(t); if (every) opts.from = 'now'
      const withFn = chance(0.33)
      if (withFn) { t.fnMap = { map: new Map(), path }; t.h = lens.connect((s, c) => { if (t.ended) fail.calledAfterEnd++; applyTo(t.fnMap, c) }, opts) }
      else t.h = lens.connect(opts)
      const run = async () => {
        const it = t.h[Symbol.asyncIterator]()
        // a merge turn must leave the loop's copy equal to the source AS IT WAS when the turn was taken; commits that
        // came after that wait for the next turn. The state handed with the turn is checked against the same moment:
        // a row's state is a value (it must match), a partition's is the live view (it may have moved on: recorded)
        if (t.loop === 'merge') it.onTake = (v) => { t.expAt = v.commit.first && midClient(t) ? null : expected(t) }
        for await (const { state, commit } of it) {
          if (t.ended) fail.calledAfterEnd++
          seen.turns++; if (!commit.first) seen.mergedCommits += commit.commits ?? 1
          applyTo(t, commit)
          if (t.loop === 'merge') {
            seen.mergeTurns++
            if (t.expAt === null) seen.skippedClientMidBatch++
            else if (!same(t.map, t.expAt)) fail.iterUnequal++
            const isRow = depth === 1 && t.path.length === 1
            const sm = new Map()
            if (isRow) { if (state !== undefined) sm.set(t.path[0], state) } else for (const k of Object.keys(state)) sm.set(k, state[k])
            if (t.expAt !== null && !same(sm, t.expAt)) { if (isRow) fail.rowStateAhead++; else seen.manyStateAheadTurns++ }
          } else if (!same(t.map, expected(t))) seen.everyLagTurns++ // the log: behind the source while commits wait (not a failure)
          if (!t.fast) await new Promise((res) => { t.release = res })
        }
      }
      loops.push(run())
      sinks.push(t)
    }
  }
  const write = () => {
    const k = liveKeys()
    const m = r() % 100
    if (m < 35 && k.length) { const p = pick(k); srv.set([...(depth === 1 ? [p] : p), 'n'], r() % 100) }
    else if (m < 55 && k.length) { const p = pick(k); srv.set(depth === 1 ? [p] : p, newRow()) }
    else if (m < 68) srv.set(depth === 1 ? ['k' + next++] : [pick(PARTS), 'm' + next++], newRow())
    else if (m < 76 && removed.length) { const i = r() % removed.length; const p = removed[i]; removed.splice(i, 1); seen.readds++; srv.set(depth === 1 ? [p] : p, newRow()) } // a removed key comes back
    else if (m < 90 && k.length) { const p = pick(k); removed.push(p); srv.remove(depth === 1 ? [p] : p) }
    else if (k.length) { const p = pick(k); srv.remove([...(depth === 1 ? [p] : p), 't']) } // a field deleted
  }
  const check = () => {
    for (const t of sinks) {
      if (t.ended || t.h.dead) continue
      if (t.fnMap && t.h.attached && !same(t.fnMap.map, expected(t))) fail.unequal++
      if (t.loop || t.once || !t.h.attached) continue
      if (!same(t.map, expected(t))) fail.unequal++
    }
  }
  for (let i = 0; i < 4; i++) makeSink()
  await flush()
  for (let step = 0; step < 150; step++) {
    const a = r() % 100
    if (a < 30) write()
    else if (a < 45) { seen.jobsWithManyCommits++; const n = 2 + (r() % 3); for (let i = 0; i < n; i++) write() } // several commits in one job
    else if (a < 70) srv.eng.rt.batch(() => { const n = 1 + (r() % 5); for (let i = 0; i < n; i++) { write(); if (chance(0.25)) makeSink() } })
    else if (a < 85) makeSink()
    else { const live = sinks.filter((s) => !s.ended); if (live.length) endIt(pick(live)) }
    for (const t of sinks) if (t.release && chance(0.4)) { const f = t.release; t.release = null; f() } // slow loops take a turn now and then
    await flush()
    check()
  }
  // drain: every loop runs fast to the end of what is waiting; an every loop must then equal the source
  for (const t of sinks) if (t.loop) { t.fast = true; if (t.release) { const f = t.release; t.release = null; f() } }
  for (let i = 0; i < 4; i++) await flush()
  for (const t of sinks) if (t.loop && !t.ended && !t.h.dead && !same(t.map, expected(t))) (t.loop === 'merge' ? fail.iterUnequal++ : fail.iterEveryUnequal++)
  for (const t of sinks) if (!t.ended) endIt(t)
  await Promise.all(loops)
  await flush()
  fail.selsLeft = srv.eng.sels.size + (srv.eng.all !== null ? 1 : 0) + cl.eng.sels.size + (cl.eng.all !== null ? 1 : 0)
  return { depth, sinks: sinks.length, ...fail, seen }
}

// ── claim 26 on connect: views right of a handle ───────────────────────────────────────────────────────────────
async function views(seed) {
  const r = rng(seed), pick = (a) => a[r() % a.length], chance = (p) => r() % 1000 < p * 1000
  let timers = [], now = 0
  const vt = { set: (fn, ms) => { const h = { fn, at: now + ms }; timers.push(h); return h }, clear: (h) => { timers = timers.filter((x) => x !== h) } }
  const PARTS = ['p0', 'p1', 'p2']
  const seedData = {}; let next = 0
  for (const p of PARTS) { seedData[p] = {}; for (let i = 0; i < 4; i++) seedData[p]['m' + next++] = { n: r() % 50, s: r() % 4 } }
  const srv = fero('s', { depth: 2, data: seedData })
  const onServer = seed % 2 === 0
  const f = onServer ? fero('v', { depth: 2, data: J(seedData) && JSON.parse(J(seedData)), linger: 3, timers: vt }) : fero('s', { depth: 2, role: 'client', transport: new Loop(srv, { json: true }), linger: 3, timers: vt })
  const src = onServer ? f : srv
  const mkOps = () => pick([[['gt', ['n', r() % 40]]], [['gt', ['s', 1]], ['za', ['n', 3]]], [['lt', ['n', 30]]], [['az', ['n', 2]]], [['gt', ['n', 10]], ['sum', ['n']]]])
  const chainOn = (x, ops) => { for (const [name, args] of ops) x = x[name](...args); return x }
  const sinks = []
  const fail = { calledAfterEnd: 0, viewsLeft: 0, selsLeft: 0, wrongFirsts: 0 }
  const open = []
  const mkSink = (how) => { const k = { ended: false, calls: 0, how, firsts: 0 }; sinks.push(k); return k }
  const count = (k) => (s, c) => { if (k.ended) fail.calledAfterEnd++; k.calls++; if (c.first) k.firsts++ }
  for (let step = 0; step < 120; step++) {
    now = step
    for (const h of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== h); h.fn() }
    const a = r() % 100
    const p = pick(PARTS)
    if (a < 35) src.set([p, 'm' + (r() % next)], { n: r() % 50, s: r() % 4 })
    else if (a < 40) src.set([p, 'm' + next++], { n: r() % 50, s: r() % 4 })
    else if (a < 52) { // a handle, one or two views on it, a sink on each; ended by the handle's disconnect()
      const h = f.data[p].connect(); const ks = []
      for (let i = 0; i < 1 + (r() % 2); i++) { const v = chainOn(h, mkOps()); const k = mkSink('disconnect'); v.connect(count(k)); ks.push(k) }
      open.push({ end: () => h.disconnect(), ks })
    } else if (a < 62) { // the same with a signal; ended by abort
      const ac = new AbortController(); const ks = []
      const h = f.data[p].connect({ signal: ac.signal }); const v = chainOn(h, mkOps())
      const k = mkSink('signal'); v.connect(count(k)); ks.push(k)
      if (chance(0.5)) { const k2 = mkSink('signal'); v.connect(count(k2)); ks.push(k2) }
      open.push({ end: () => ac.abort(), ks })
    } else if (a < 70) { // operators left of connect, until a socket-like emitter closes
      const em = sockLike(); const k = mkSink('until')
      chainOn(f.data[p], mkOps()).connect(count(k), { until: em })
      open.push({ end: () => closeIt(em), ks: [k] })
    } else if (a < 76) { // the same, the link disconnected by hand
      const k = mkSink('link.disconnect')
      const L = chainOn(f.data[p], mkOps()).connect(count(k))
      open.push({ end: () => L.disconnect(), ks: [k] })
    } else if (a < 80) { // once: one call, then the view and its hold end
      const k = mkSink('once'); k.once = true
      chainOn(f.data[p], mkOps()).connect(count(k), { once: true })
      k.ended = 'after-first'
    } else if (a < 92 && open.length) { const i = r() % open.length; const o = open[i]; open.splice(i, 1); o.end(); for (const k of o.ks) k.ended = true }
    // a once sink is ended after its first call
    for (const k of sinks) if (k.once && k.ended === 'after-first' && k.calls >= 1) k.ended = true
  }
  for (const o of open) { o.end(); for (const k of o.ks) k.ended = true }
  for (const k of sinks) if (k.once) k.ended = true
  src.set(['p0', 'm0'], { n: 49, s: 3 }); src.set(['p1', 'm' + next++], { n: 48, s: 3 })
  now = 2000
  for (const h of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== h); h.fn() }
  for (let i = 0; i < 10; i++) src.set([pick(PARTS), 'm' + (r() % next)], { n: r() % 50, s: r() % 4 })
  await flush()
  fail.viewsLeft = f.views.size
  fail.selsLeft = f.eng.sels.size + (f.eng.all !== null ? 1 : 0)
  fail.wrongFirsts = sinks.filter((k) => k.firsts !== 1).length
  return { sinks: sinks.length, byHow: sinks.reduce((o, k) => { o[k.how] = (o[k.how] ?? 0) + 1; return o }, {}), ...fail }
}

if (PART === 'picture') {
  const tot = { seeds: 0, sinks: 0, failedSeeds: [] }, keys = ['doubled', 'missed', 'badPrev', 'unequal', 'firstsNotEmpty', 'calledAfterEnd', 'onceWrong', 'iterUnequal', 'iterEveryUnequal', 'rowStateAhead', 'selsLeft']
  for (const k of keys) tot[k] = 0
  const seenTot = {}
  for (let s = 1; s <= SEEDS; s++) {
    const x = await picture(s)
    tot.seeds++; tot.sinks += x.sinks
    let bad = 0; for (const k of keys) { tot[k] += x[k]; bad += x[k] }
    for (const [k, v] of Object.entries(x.seen)) { if (typeof v === 'object') { seenTot[k] ??= {}; for (const [a, b] of Object.entries(v)) seenTot[k][a] = (seenTot[k][a] ?? 0) + b } else seenTot[k] = (seenTot[k] ?? 0) + v }
    if (bad > 0 && tot.failedSeeds.length < 10) tot.failedSeeds.push(s)
  }
  out({ part: 'picture', claim: 7, ...tot, seen: seenTot, connectCounts: counts })
}
if (PART === 'views') {
  const tot = { seeds: 0, sinks: 0, calledAfterEnd: 0, viewsLeft: 0, selsLeft: 0, wrongFirsts: 0, byHow: {}, failedSeeds: [] }
  for (let s = 1; s <= SEEDS; s++) {
    const x = await views(s)
    tot.seeds++; tot.sinks += x.sinks
    for (const k of ['calledAfterEnd', 'viewsLeft', 'selsLeft', 'wrongFirsts']) tot[k] += x[k]
    for (const [k, v] of Object.entries(x.byHow)) tot.byHow[k] = (tot.byHow[k] ?? 0) + v
    if (x.calledAfterEnd + x.viewsLeft + x.selsLeft + x.wrongFirsts > 0 && tot.failedSeeds.length < 10) tot.failedSeeds.push(s)
  }
  out({ part: 'views', claim: 26, ...tot, connectCounts: counts })
}
if (PART === 'share') {
  // E-55 bench/connect.mjs share, on connect: 1,000 bare handles and 1,000 callbacks on one row of a client
  const seed = {}; for (let i = 0; i < 1000; i++) seed['k' + i] = { n: i }
  const server = fero('s', { data: seed })
  const tr = new Loop(server, { json: true })
  let ticks = []
  const timers = { set: (fn, ms) => { ticks.push(fn); return fn }, clear: (h) => { ticks = ticks.filter((x) => x !== h) } }
  const cl = fero('s', { role: 'client', transport: tr, linger: 1000, timers })
  const bare = [], links = []
  const targets = Array.from({ length: 1000 }, () => ({ text: '', n: 0 }))
  for (let i = 0; i < 1000; i++) bare.push(cl.data.k7.connect())
  for (let i = 0; i < 1000; i++) { const t = targets[i]; links.push(cl.data.k7.connect((s, c) => { t.text = c.text(); t.n++ })) }
  await bare[0].ready; await links[999].ready
  const before = { ...cl.eng.stats }
  const W = 100
  let folds = 0
  const foldSink = cl.eng.src.connect({ wantsOrder: false, origin: null, apply: (b) => { folds += b.rows.length } })
  for (let i = 0; i < W; i++) server.set(['k7', 'n'], 5000 + i)
  foldSink.dispose()
  const after = cl.eng.stats
  const counts = { upstreamSubs: tr.stats.subs, framesDecoded: tr.stats.decodes - 1, writes: W, foldsInCache: folds, textBuilds: after.texts - before.texts, deliveries: after.deliveries - before.deliveries, selections: cl.eng.sels.size, allCallbacksCurrent: targets.every((t) => t.n === W + 1) }
  for (const h of bare) { h.disconnect(); h.disconnect() } // each twice: the second must do nothing
  for (const l of links) { l.disconnect(); l.disconnect() }
  const unsubBeforeLinger = tr.stats.unsubs
  const pendingTimers = ticks.length
  for (const fn of ticks.splice(0)) fn()
  const res = { links: 2000, counts, unsubBeforeLinger, lingerTimers: pendingTimers, unsubAfterLinger: tr.stats.unsubs, selectionsAfter: cl.eng.sels.size, cacheRowsAfter: cl.eng.src.rowCount() }
  const ok = counts.upstreamSubs === 1 && counts.framesDecoded === W && counts.foldsInCache === W && counts.textBuilds === W && counts.allCallbacksCurrent && unsubBeforeLinger === 0 && pendingTimers === 1 && res.unsubAfterLinger === 1 && res.selectionsAfter === 0 && res.cacheRowsAfter === 0
  out({ part: 'share', claim: 9, ok, ...res })
}
