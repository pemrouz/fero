// Seeded correctness runs on data's real engine (one process).
//   node --expose-gc --experimental-strip-types sim.mjs <part> [seeds]
// picture (claim 7)    random writes and batches; links made at random points (inside an open batch, inside a
//                      sink's own call), on a server and on a client (loopback, JSON frames), on the whole
//                      resource, a row, a field, a depth-2 partition. Every sink applies c.changes to its own Map;
//                      after every step each must equal the source; an add for a key held is a double, an
//                      update or remove for a key not held is a miss.
// collector (claim 14) one program, run under N collector seeds: a seeded adversary ends each dropped link at a
//                      random step ("at once" to "never") and runs its finalizer later or never. Everything live
//                      handles read, every live target's state, f.rows of a hold-all client, and, per step and
//                      per partition, whether `lens.get()` is served here or takes a trip (review F1) must be the
//                      same in every seed. Controls: a client whose f.rows reads its whole cache (the rule
//                      broken), dropped links whose function writes outside its target, and (run with
//                      E55_MUTATE=weakread) a read served from rows that only a weak link holds.
// views (review F4)    views right of here(): after its handle closes, its scope ends, its target is collected
//                      (the seeded collector) or the linger passes, no sink of a view is ever called again and
//                      the resource keeps no view. Control (E55_MUTATE=viewleak): the first build.
// commute (claim 17)   every plain-data chain of 1-3 operators × every position of here(): the part left of here()
//                      runs on the server (a data view, its wire records sent), the rest on the client's rows.
//                      Settled answers against the whole chain on the server.
import { fero, Loop, D, SourceNode, HOT, scope } from '../proto/lens.mjs'
import { rng, out } from './common.mjs'

const PART = process.argv[2], SEEDS = +(process.argv[3] ?? 1000)
const J = (x) => JSON.stringify(x)

// ── claim 7 ─────────────────────────────────────────────────────────────────────────────────────────
function picture(seed) {
  const r = rng(seed), pick = (a) => a[r() % a.length], chance = (p) => r() % 1000 < p * 1000
  const depth = seed % 2 === 0 ? 1 : 2
  const seedData = {}
  const PARTS = ['p0', 'p1', 'p2', 'p3']
  let next = 0
  const newRow = () => ({ n: r() % 100, s: r() % 5, t: 'x' + (r() % 7) })
  if (depth === 1) for (let i = 0; i < 12; i++) seedData['k' + next++] = newRow()
  else for (const p of PARTS) { seedData[p] = {}; for (let i = 0; i < 4; i++) seedData[p]['m' + next++] = newRow() }
  const srv = fero('s', { depth, data: seedData })
  const tr = new Loop(srv, { json: true })
  const cl = fero('s', { depth, role: 'client', transport: tr, linger: 0 })
  const sinks = []
  const fail = { doubled: 0, missed: 0, unequal: 0, propUnequal: 0, firstsNotEmpty: 0 }
  const liveKeys = () => depth === 1 ? [...srv.eng.src.snapshot().keys()] : PARTS.flatMap((p) => [...(srv.eng.parts.get(p)?.snapshot().keys() ?? [])].map((k) => [p, k]))
  const expected = (sk) => {
    const m = new Map()
    if (depth === 1) {
      if (sk.path.length === 0) for (const [k, v] of srv.eng.src.snapshot()) m.set(k, v)
      else { const v = srv.eng.src.get(sk.path[0]); if (v !== undefined) m.set(sk.path[0], v) }
    } else { const ps = srv.eng.parts.get(sk.path[0]); if (ps) for (const [k, v] of ps.snapshot()) m.set(k, v) }
    return m
  }
  const apply = (t, c) => {
    if (c.first) { if (t.map.size !== 0) fail.firstsNotEmpty++; t.map.clear(); for (const ch of c.changes) t.map.set(ch.key, ch.row) }
    else for (const ch of c.changes) {
      if (ch.op === 'add') { if (t.map.has(ch.key)) fail.doubled++; t.map.set(ch.key, ch.row) }
      else if (ch.op === 'update') { if (!t.map.has(ch.key)) fail.missed++; t.map.set(ch.key, ch.row) }
      else { if (!t.map.has(ch.key)) fail.missed++; t.map.delete(ch.key) }
    }
    // a sink's own call may make another link (an effect that connects)
    if (t.nest > 0 && chance(0.05)) { t.nest--; makeSink(true) }
  }
  const makeSink = (nested = false) => {
    const onClient = chance(0.5)
    const f = onClient ? cl : srv
    let path
    if (depth === 1) path = chance(0.3) ? [] : [pick(liveKeys().concat(['k' + next]))]
    else path = [pick(PARTS)]
    const t = { map: new Map(), path, onClient, nest: nested ? 0 : 2, alive: true }
    if (chance(0.5)) t.link = f.data.at(...path).connect(t, apply)
    else t.link = f.data.at(...path).tap((c) => apply(t, c))
    sinks.push(t)
    // a field lens in 'prop' form
    if (depth === 1 && path.length === 1 && chance(0.3)) {
      const pt = { v: undefined, path: [path[0], 'n'], prop: true, alive: true, onClient }
      pt.link = f.data.at(path[0], 'n').connect(pt, 'v')
      sinks.push(pt)
    }
  }
  const write = () => {
    const k = liveKeys()
    const m = r() % 100
    if (m < 35 && k.length) { const p = pick(k); srv.set([...(depth === 1 ? [p] : p), 'n'], r() % 100) }
    else if (m < 55 && k.length) { const p = pick(k); srv.set(depth === 1 ? [p] : p, newRow()) }
    else if (m < 75) srv.set(depth === 1 ? ['k' + next++] : [pick(PARTS), 'm' + next++], newRow())
    else if (m < 90 && k.length) { const p = pick(k); srv.remove(depth === 1 ? [p] : p) }
    else if (k.length) { const p = pick(k); srv.remove([...(depth === 1 ? [p] : p), 't']) } // a field deleted
  }
  const check = () => {
    for (const t of sinks) {
      if (!t.alive) continue
      if (t.prop) { const want = srv.eng.readSync(t.path); if (!Object.is(want, t.v) && J(want) !== J(t.v)) fail.propUnequal++; continue }
      const e = expected(t)
      if (e.size !== t.map.size) { fail.unequal++; continue }
      for (const [k, v] of e) if (J(t.map.get(k)) !== J(v)) { fail.unequal++; break }
    }
  }
  for (let i = 0; i < 4; i++) makeSink()
  for (let step = 0; step < 150; step++) {
    const a = r() % 100
    if (a < 45) write()
    else if (a < 70) srv.eng.rt.batch(() => { const n = 1 + (r() % 5); for (let i = 0; i < n; i++) { write(); if (chance(0.25)) makeSink() } })
    else if (a < 85) makeSink()
    else { const live = sinks.filter((s) => s.alive); if (live.length) { const t = pick(live); t.alive = false; t.link.close() } }
    check()
  }
  return { depth, sinks: sinks.length, ...fail }
}

// ── claim 14: a seeded collector ─────────────────────────────────────────────────────────────────────
function simWeak(adv) {
  const dropped = new Map() // target → { collectAt, finalAt }
  const regs = []
  let step = 0
  const w = {
    ref: (t) => ({ deref: () => { const d = dropped.get(t); return d !== undefined && d.collectAt <= step ? undefined : t } }),
    register: (t, link) => regs.push({ t, link }),
    unregister: () => {},
    drop(t) { // the program lets go of t: the adversary picks when it is collected and when its finalizer runs
      const mode = adv() % 4
      const collectAt = mode === 0 ? step : mode === 3 ? Infinity : step + (adv() % 40)
      const finalAt = collectAt === Infinity ? Infinity : adv() % 2 ? collectAt + (adv() % 40) : Infinity
      dropped.set(t, { collectAt, finalAt })
    },
    dropWithInfo(t) { this.drop(t); return dropped.get(t) },
    collectAll(s) { for (const d of dropped.values()) { if (d.collectAt > s) d.collectAt = s; if (d.finalAt > s) d.finalAt = s } },
    tick(s) {
      step = s
      for (const g of regs) { const d = dropped.get(g.t); if (d !== undefined && d.finalAt <= step && !g.done) { g.done = true; g.link.end('collected') } }
    },
  }
  return w
}
function collector(progSeed, advSeed, variant) {
  const r = rng(progSeed), adv = rng(advSeed * 7919 + 17)
  const pick = (a) => a[r() % a.length], chance = (p) => r() % 1000 < p * 1000
  const weak = simWeak(adv)
  let timers = []
  const vt = { set: (fn, ms) => { const h = { fn, at: now + ms }; timers.push(h); return h }, clear: (h) => { timers = timers.filter((x) => x !== h) } }
  let now = 0
  const PARTS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
  const seed = {}; let next = 0
  for (const p of PARTS) { seed[p] = {}; for (let i = 0; i < 3; i++) seed[p]['m' + next++] = { n: r() % 50 } }
  const srv = fero('s', { depth: 2, data: seed })
  const mk = (hold, leaky) => fero('s', { depth: 2, role: 'client', transport: new Loop(srv, { json: true }), hold, linger: 3, timers: vt, weak, leakyRows: leaky })
  const cl = mk('none', false), all = mk('all', false), leaky = mk('none', true)
  const log = [] // what the program sees
  const leakLog = [], awaitLog = []
  let heres = 0, trips = 0
  const helds = [], live = []
  let shared = { n: 0 }
  const fnTarget = (t, c) => { t.n++; t.last = J(c.now.rows) }
  const fnShared = (t, c) => { t.n++; shared.n++ } // writes outside its target: the control
  for (let step = 0; step < 120; step++) {
    now = step
    weak.tick(step)
    for (const h of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== h); h.fn() }
    const a = r() % 100
    if (a < 35) { const p = pick(PARTS); srv.set([p, 'm' + (r() % next)], { n: r() % 50 }) }
    else if (a < 45) { const h = pick([cl, leaky]).data[pick(PARTS)].here(); helds.push(h) }
    else if (a < 52 && helds.length) { const i = r() % helds.length; helds[i].close(); helds.splice(i, 1) }
    else if (a < 62) { const t = { n: 0 }; const c = pick([cl, leaky]); c.data[pick(PARTS)].connect(t, fnTarget); live.push(t) }
    else if (a < 85) { // a link whose target the program drops at once
      const t = { n: 0 }; const c = pick([cl, leaky])
      c.data[pick(PARTS)].connect(t, variant === 'shared' && chance(0.5) ? fnShared : fnTarget)
      weak.drop(t)
    } else { const p = pick(PARTS); srv.set([p, 'm' + next++], { n: r() % 50 }) }
    // what the program reads this step
    for (const h of helds) log.push(J(Object.entries(h.rows)))
    for (const t of live) log.push(t.n + ':' + t.last)
    log.push(J(Object.keys(all.rows).map((p) => [p, Object.fromEntries(all.rows[p].snapshot())])))
    try { cl.rows; log.push('rows!') } catch (e) { log.push(e.code) }
    log.push('shared:' + shared.n)
    leakLog.push(J([...leaky.eng.parts].map(([p, s]) => [p, s.rowCount()])))
    // review F1: what `cl.data[p].get()` would do now, for every partition: served here, or a trip. With the
    // loopback transport a trip's value is always the server's, so the here/trip pattern is the whole outcome.
    for (const p of PARTS) { const w = cl.readWhere([p]); awaitLog.push(w); if (w === 'here') { heres++; log.push('get:' + J(Object.fromEntries(cl.eng.readSync([p]).snapshot()))) } else trips++ }
  }
  return { digest: hash(log.join('\n')), awaitDigest: hash(awaitLog.join('')), heres, trips, clSubs: cl.transport.stats.subs, leakDigest: hash(leakLog.join('\n')), netEnded: cl.eng.stats.netEnded + leaky.eng.stats.netEnded, subs: cl.transport.stats.subs + leaky.transport.stats.subs }
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) }

// ── claim 17: moving here() ──────────────────────────────────────────────────────────────────────────
const OPS = [
  () => ['gt', ['s', 1 + (R() % 3)]], () => ['lt', ['s', 1 + (R() % 3)]], () => ['gte', ['s', R() % 4]], () => ['lte', ['n', R() % 60]],
  () => ['between', ['n', [R() % 30, 30 + (R() % 40)]]], () => ['az', ['s']], () => ['za', ['s', 1 + (R() % 6)]], () => ['az', ['n', 1 + (R() % 6)]],
  () => ['top', [1 + (R() % 5)]], () => ['limit', [1 + (R() % 5)]], () => ['reverse', []],
]
const AGG = [() => ['sum', ['n']], () => ['length', []], () => ['max', ['n']], () => ['min', ['s']], () => ['avg', ['n']]]
let R = null
function answer(h) {
  const n = h[D.node]
  if (n.kind === 'scalar') return J(h[D.value])
  const order = n.currentOrder()
  const snap = n.snapshot()
  if (order) return J(order.map((k) => [k, snap.get(k)]))
  return J([...snap].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)))
}
function commute(seed) {
  R = rng(seed)
  const r = R, chance = (p) => r() % 1000 < p * 1000
  const len = 1 + (r() % 3)
  const chain = []
  for (let i = 0; i < len; i++) chain.push(i === len - 1 && chance(0.3) ? AGG[r() % AGG.length]() : OPS[r() % OPS.length]())
  const rows = {}; let next = 0
  for (let i = 0; i < 12; i++) rows['m' + next++] = { n: r() % 60, s: r() % 4 }
  const rt = new D.Runtime()
  const src = new SourceNode(rt, rows)
  const build = (h, ops) => { for (const [name, args] of ops) h = h[name](...args); return h }
  const whole = build(D.handleFor(src), chain)
  // for each position i of here(): chain[0:i] on the server, wire records to a client store, chain[i:] there
  const sides = []
  for (let i = 0; i <= len; i++) {
    const left = chain.slice(0, i), right = chain.slice(i)
    const sv = build(D.handleFor(src), left)
    if (sv[D.node].kind === 'scalar') { sides.push({ i, scalar: sv }); continue }
    const crt = new D.Runtime()
    const csrc = new SourceNode(crt, {})
    const ch = D.handleFor(csrc)
    const order = [] // KEEP_ORDER: the order channel kept beside the keyed store (data's wireSink sends at and move)
    D.wireSink(sv, (b) => crt.batch(() => {
      for (const x of b.records) {
        if (x.t === 'add') { csrc.write(x.k, [], x.v); if (x.at !== undefined) order.splice(x.at, 0, x.k); else order.push(x.k) }
        else if (x.t === 'remove') { if (x.path?.length) csrc.remove(x.k, x.path); else { csrc.remove(x.k); const j = order.indexOf(x.k); if (j >= 0) order.splice(j, 1) } }
        else if (x.t === 'update') csrc.write(x.k, x.path ?? [], x.v)
        else if (x.t === 'move') { const j = order.indexOf(x.k); order.splice(j, 1); order.splice(x.to, 0, x.k) }
      }
    }))
    sides.push({ i, client: build(ch, right), order: right.length === 0 && sv[D.node].currentOrder() !== null ? order : null, csrc })
  }
  const key = () => 'm' + (r() % next)
  for (let step = 0; step < 60; step++) {
    const go = () => {
      const a = r() % 100
      if (a < 40) { const k = key(); if (src.hasRow(k)) src.write(k, ['n'], r() % 60) }
      else if (a < 60) { const k = key(); if (src.hasRow(k)) src.write(k, ['s'], r() % 4) }
      else if (a < 80) src.write('m' + next++, [], { n: r() % 60, s: r() % 4 })
      else { const k = key(); src.remove(k) }
    }
    if (chance(0.3)) rt.batch(() => { go(); go(); go() }); else go()
  }
  const want = answer(whole)
  const bad = []
  const badKeyed = [], badOrdered = []
  for (const s of sides) {
    const got = answer(s.scalar ?? s.client)
    if (got !== want) badKeyed.push(s.i)
    // the same client, reading the order channel it kept when the whole ordered result came from the server
    const got2 = s.order ? J(s.order.map((k) => [k, s.csrc.get(k)])) : got
    if (got2 !== want) badOrdered.push(s.i)
  }
  return { chain: chain.map((c) => c[0]).join('.'), len, bad: badKeyed, badOrdered }
}

if (PART === 'picture') {
  const tot = { seeds: 0, sinks: 0, doubled: 0, missed: 0, unequal: 0, propUnequal: 0, firstsNotEmpty: 0, failedSeeds: [] }
  for (let s = 1; s <= SEEDS; s++) {
    const x = picture(s)
    tot.seeds++; tot.sinks += x.sinks
    for (const k of ['doubled', 'missed', 'unequal', 'propUnequal', 'firstsNotEmpty']) tot[k] += x[k]
    if (x.doubled + x.missed + x.unequal + x.propUnequal + x.firstsNotEmpty > 0 && tot.failedSeeds.length < 10) tot.failedSeeds.push(s)
  }
  out({ claim: 7, bench: 'picture-then-changes', ...tot })
}

if (PART === 'collector') {
  const res = {}
  for (const variant of ['target-only', 'shared']) {
    const digests = new Map(), leak = new Set(), aw = new Set(), subsPer = new Set()
    let netEnded = 0, subsMin = Infinity, subsMax = 0, heres = 0, trips = 0
    for (const prog of [1, 2, 3]) {
      for (let a = 1; a <= SEEDS; a++) {
        const x = collector(prog, a, variant)
        const k = prog + ':' + x.digest
        digests.set(k, (digests.get(k) ?? 0) + 1)
        leak.add(prog + ':' + x.leakDigest); aw.add(prog + ':' + x.awaitDigest); subsPer.add(prog + ':' + x.clSubs)
        heres += x.heres; trips += x.trips
        netEnded += x.netEnded; subsMin = Math.min(subsMin, x.subs); subsMax = Math.max(subsMax, x.subs)
      }
    }
    res[variant] = { programs: 3, collectorSeeds: SEEDS, distinctResultsPerProgram: digests.size / 3, distinctLeakyRowsPerProgram: leak.size / 3, linksEndedByNet: netEnded, upstreamSubsRange: [subsMin, subsMax], distinctGetHereOrTripPatternsPerProgram: aw.size / 3, getsServedHere: heres, getsThatTrip: trips, distinctClientSubCountsPerProgram: subsPer.size / 3 }
  }
  out({ claim: 14, bench: 'collector-adversary', mutate: process.env.E55_MUTATE ?? '', ...res })
}

if (PART === 'commute') {
  const byChain = new Map()
  let runs = 0, badRuns = 0, badOrderedRuns = 0, positions = 0
  const badOrderedChains = new Set()
  for (let s = 1; s <= SEEDS; s++) {
    const x = commute(s)
    runs++; positions += x.len + 1
    if (x.bad.length) badRuns++
    if (x.badOrdered.length) { badOrderedRuns++; badOrderedChains.add(x.chain + '@' + x.badOrdered.join(',')) }
    const e = byChain.get(x.chain) ?? { runs: 0, bad: 0, positions: new Set() }
    e.runs++; if (x.bad.length) { e.bad++; for (const i of x.bad) e.positions.add(i) }
    byChain.set(x.chain, e)
  }
  const failing = [...byChain].filter(([, e]) => e.bad > 0).map(([c, e]) => ({ chain: c, runs: e.runs, bad: e.bad, herePositions: [...e.positions] })).sort((a, b) => b.bad - a.bad)
  const passing = [...byChain].filter(([, e]) => e.bad === 0).map(([c]) => c)
  out({ claim: 17, bench: 'commute', seeds: runs, chainPositions: positions, badRunsKeyedClient: badRuns, badRunsOrderKept: badOrderedRuns, badOrderedChains: [...badOrderedChains].slice(0, 20), chains: byChain.size, failingChains: failing.length, failing: failing.slice(0, 40), passingSample: passing.slice(0, 30) })
}

// ── review F4: views right of here() and their lifetimes ────────────────────────────────────────────
function views(seed) {
  const r = rng(seed), adv = rng(seed * 104729 + 3), pick = (a) => a[r() % a.length], chance = (p) => r() % 1000 < p * 1000
  const weak = simWeak(adv)
  let timers = [], now = 0
  const vt = { set: (fn, ms) => { const h = { fn, at: now + ms }; timers.push(h); return h }, clear: (h) => { timers = timers.filter((x) => x !== h) } }
  const PARTS = ['p0', 'p1', 'p2']
  const seedData = {}; let next = 0
  for (const p of PARTS) { seedData[p] = {}; for (let i = 0; i < 4; i++) seedData[p]['m' + next++] = { n: r() % 50, s: r() % 4 } }
  const srv = fero('s', { depth: 2, data: seedData })
  const onServer = seed % 2 === 0
  const f = onServer ? fero('v', { depth: 2, data: JSON.parse(J(seedData)), linger: 3, timers: vt, weak }) : fero('s', { depth: 2, role: 'client', transport: new Loop(srv, { json: true }), linger: 3, timers: vt, weak })
  const src = onServer ? f : srv
  const mkOps = () => pick([[['gt', ['n', r() % 40]]], [['gt', ['s', 1]], ['za', ['n', 3]]], [['lt', ['n', 30]]], [['az', ['n', 2]]], [['gt', ['n', 10]], ['sum', ['n']]]])
  const chainOn = (x, ops) => { for (const [name, args] of ops) x = x[name](...args); return x }
  const sinks = [] // { ended, calls, callsAtEnd, how }
  const fail = { calledAfterEnd: 0, viewsLeft: 0, selsLeft: 0, wrongAnswer: 0, firstMissing: 0 }
  const open = [] // things the program can still end: { end(), sinks: [...] }
  const mkSink = (how) => { const k = { ended: false, calls: 0, how, firsts: 0 }; sinks.push(k); return k }
  const count = (k) => (c) => { if (k.ended) fail.calledAfterEnd++; k.calls++; if (c.first) k.firsts++ }
  const countT = (k) => (t, c) => { if (k.ended) fail.calledAfterEnd++; k.calls++; t.n++; if (c.first) k.firsts++ }
  for (let step = 0; step < 120; step++) {
    now = step
    weak.tick(step)
    for (const h of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== h); h.fn() }
    const a = r() % 100
    const p = pick(PARTS)
    if (a < 35) src.set([p, 'm' + (r() % next)], { n: r() % 50, s: r() % 4 })
    else if (a < 40) src.set([p, 'm' + next++], { n: r() % 50, s: r() % 4 })
    else if (a < 52) { // a handle, one or two views on it, taps on them; ended by handle.close()
      const h = f.data[p].here(); const ks = []
      for (let i = 0; i < 1 + (r() % 2); i++) { const v = chainOn(h, mkOps()); const k = mkSink('close'); v.tap(count(k)); ks.push(k) }
      open.push({ end: () => h.close(), ks })
    } else if (a < 62) { // the same inside a scope; ended by the scope
      const ks = []
      const sc = scope(() => { const h = f.data[p].here(); const v = chainOn(h, mkOps()); const k = mkSink('scope'); v.tap(count(k)); ks.push(k); if (chance(0.5)) { const k2 = mkSink('scope'); v.connect({ n: 0 }, countT(k2)); ks.push(k2) } })
      open.push({ end: () => sc.dispose(), ks })
    } else if (a < 74) { // operators left of here(), then connect: a weak link the program drops; the collector ends it
      const t = { n: 0 }; const k = mkSink('collector')
      chainOn(f.data[p], mkOps()).connect(t, countT(k))
      const w = weak.dropWithInfo(t); k.collectAt = w.collectAt
    } else if (a < 80) { // the same, the link closed by hand
      const t = { n: 0 }; const k = mkSink('link.close')
      const L = chainOn(f.data[p], mkOps()).connect(t, countT(k))
      open.push({ end: () => L.close(), ks: [k], keep: t })
    } else if (a < 92 && open.length) { const i = r() % open.length; const o = open[i]; open.splice(i, 1); o.end(); for (const k of o.ks) k.ended = true }
    // a sink whose target the collector took is ended from that step on: it must not be called again
    for (const k of sinks) if (k.how === 'collector' && !k.ended && k.collectAt <= step) k.ended = true
  }
  for (const o of open) { o.end(); for (const k of o.ks) k.ended = true }
  // the collector takes every dropped target now; then the linger passes
  weak.collectAll(1000); now = 1000; weak.tick(1000)
  for (const k of sinks) if (k.how === 'collector') k.ended = true
  src.set(['p0', 'm0'], { n: 49, s: 3 }); src.set(['p1', 'm' + next++], { n: 48, s: 3 }) // the check before delivery ends what is left
  now = 2000; weak.tick(2000)
  for (const h of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== h); h.fn() }
  for (let i = 0; i < 10; i++) src.set([pick(PARTS), 'm' + (r() % next)], { n: r() % 50, s: r() % 4 })
  fail.viewsLeft = f.views.size
  fail.selsLeft = f.eng.sels.size + (f.eng.all !== null ? 1 : 0)
  fail.firstMissing = sinks.filter((k) => k.firsts !== 1).length
  return { sinks: sinks.length, byHow: sinks.reduce((o, k) => { o[k.how] = (o[k.how] ?? 0) + 1; return o }, {}), ...fail }
}
if (PART === 'views') {
  const tot = { seeds: 0, sinks: 0, calledAfterEnd: 0, viewsLeft: 0, selsLeft: 0, firstMissing: 0, byHow: {}, failedSeeds: [] }
  for (let s = 1; s <= SEEDS; s++) {
    const x = views(s)
    tot.seeds++; tot.sinks += x.sinks
    for (const k of ['calledAfterEnd', 'viewsLeft', 'selsLeft', 'firstMissing']) tot[k] += x[k]
    for (const [k, v] of Object.entries(x.byHow)) tot.byHow[k] = (tot.byHow[k] ?? 0) + v
    if (x.calledAfterEnd + x.viewsLeft + x.selsLeft + x.firstMissing > 0 && tot.failedSeeds.length < 10) tot.failedSeeds.push(s)
  }
  out({ claim: 26, bench: 'view-lifetimes', mutate: process.env.E55_MUTATE ?? '', ...tot })
}
