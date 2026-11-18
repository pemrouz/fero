// Claims 6, 8, 9, 10 and 11 on data's real engine, one process (a server resource; links made here).
//   node --expose-gc --experimental-strip-types connect.mjs <part> [args]
// setup   (6)  a second here()/connect on a held selection; the target's registration; the first picture
//               against the selection's size and the resource's size (depth 2: rooms of P rows, N rows in all)
// fan     (8)  K links on K different rows (depth 1, 100,000 rows), writes over every row: ns per write;
//               data's own path connect today for contrast (its subscriptions check every row delta)
// share   (9)  1,000 here()s and connects on one selection: upstream subscriptions, folds, c.text() builds,
//               unsubscribes after the linger (a client cache over the loopback transport, JSON frames)
// tap     (10) tap((c) => …) reading nothing, reading c.changes with prev, reading c.now; a bare data sink (data's
//               own delivery, no lens); data's taps today
// weak    (11) 10,000 weak links against 10,000 strong sinks on one selection; the target check alone
import { fero, Loop, Store, D, VALUE } from '../proto/lens.mjs'
import { seedRows, key, row, gc, now, out, interleave, r1, r3, med } from './common.mjs'

const PART = process.argv[2]
let sink = 0

if (PART === 'setup') {
  // (a) the second here()/connect on a selection, on a resource of 100,000 rows: ns each, 10,000 of each
  const f = fero('f', { data: seedRows(100000) }); f.eng.promote()
  const lk = f.data.k5, at = f.at('k5')
  const first = lk.here(); // the selection exists and is held
  const M = 10000, res = {}
  const time = (name, mk) => {
    const xs = []
    for (let r = 0; r < 5; r++) {
      const targets = Array.from({ length: M }, () => ({ v: 0 }))
      const made = new Array(M)
      gc(); const t0 = now()
      for (let i = 0; i < M; i++) made[i] = mk(targets[i])
      xs.push(Number(now() - t0) / M)
      for (const l of made) l.close()
    }
    res[name] = r1(med(xs))
  }
  time('here (kept lens)', () => lk.here())
  time('here (at)', () => at.here())
  time('connect fn (kept lens)', (t) => lk.connect(t, (t, c) => { t.v++ }))
  time('connect prop (kept lens)', (t) => lk.connect(t, 'v'))
  time('tap (kept lens)', () => lk.tap((c) => { sink++ }))
  // the parts: the lookup and the count; the target's registration (WeakRef + FinalizationRegistry)
  const e = f.eng
  const look = []
  for (let r = 0; r < 5; r++) { gc(); const t0 = now(); for (let i = 0; i < M; i++) { const s = e.sel('k5'); s.acquire(); s.count-- } look.push(Number(now() - t0) / M) }
  res['lookup + count'] = r1(med(look))
  const reg = new FinalizationRegistry(() => {})
  const part = (name, fn) => { const xs = []; for (let r = 0; r < 5; r++) { const ts = Array.from({ length: M }, () => ({})); const tok = ts.map(() => ({})); const ws = new Array(M); gc(); const t0 = now(); for (let i = 0; i < M; i++) fn(ts, tok, ws, i); xs.push(Number(now() - t0) / M); for (const t of tok) reg.unregister(t) } res[name] = r1(med(xs)) }
  part('weakref', (ts, tok, ws, i) => { ws[i] = new WeakRef(ts[i]) })
  part('register', (ts, tok, ws, i) => { reg.register(ts[i], tok[i]) })
  part('register with token', (ts, tok, ws, i) => { reg.register(ts[i], tok[i], tok[i]) })
  part('target registration', (ts, tok, ws, i) => { ws[i] = new WeakRef(ts[i]); reg.register(ts[i], tok[i]) })
  first.close()
  out({ claim: 6, bench: 'setup-second', rows: 100000, links: M, ns: res, derived: { connect_over_here: r1(res['connect fn (kept lens)'] - res['here (kept lens)']) } })

  // (b) the first picture: depth 2, rooms of P rows; N rows in all. Time the first here()+tap on one room.
  const pics = []
  for (const [N, P] of [[1e4, 100], [1e6, 100], [1e5, 1], [1e6, 10000], [1e5, 10000]]) { // 1e6 one-row rooms: 1e6 data sources do not fit (claim 19)
    const seed = {}
    for (let i = 0; i < N; i++) { const p = 'p' + Math.floor(i / P); (seed[p] ??= {})['m' + i] = row(i) }
    const g = fero('g', { depth: 2, data: seed }); g.eng.promote()
    const rooms = Object.keys(seed)
    const xs = []
    for (let r = 0; r < 7; r++) {
      const room = rooms[(r * 7919) % rooms.length]
      let got = 0
      gc(); const t0 = now()
      const t = g.data[room].tap((c) => { for (const ch of c.changes) got++ })
      xs.push(Number(now() - t0) / 1e6)
      t.close()
      if (got !== P) throw new Error(`picture ${got} != ${P}`)
    }
    pics.push({ rows: N, roomRows: P, rooms: rooms.length, ms: r3(med(xs)) })
  }
  out({ claim: 6, bench: 'setup-first-picture', pictures: pics })
}

if (PART === 'fan') {
  // K links on K rows of 100,000; writes to every row in turn (so a write meets a link K/N of the time)
  const N = 100000, W = +(process.argv[3] ?? 50000)
  const res = {}
  for (const K of [0, 10, 100, 1000, 10000, 100000]) {
    const f = fero('f', { data: seedRows(N) }); f.eng.promote()
    const targets = []
    let c = 0
    for (let i = 0; i < K; i++) { const t = { n: 0 }; targets.push(t); f.data[key(i)].connect(t, (t, cc) => { t.n++; c++ }) }
    const xs = []
    for (let r = 0; r < 5; r++) { gc(); const t0 = now(); for (let i = 0; i < W; i++) f.set([key(i % N), 'n'], r * W + i + 1e9); xs.push(Number(now() - t0) / W) }
    res[K] = { lens: r1(med(xs)), delivered: c }
    sink += targets.length
  }
  // data's own path connect today (api/index.ts:186-191): every subscription sees every row delta
  const today = {}
  for (const K of [0, 100, 1000, 10000]) {
    const s = D.$(seedRows(N)); s.promote(); let c = 0
    for (let i = 0; i < K; i++) s.get(key(i)).connect({}, () => c++, { clone: false, initial: false })
    const Wd = K >= 10000 ? 2000 : W
    const xs = []
    for (let r = 0; r < 5; r++) { gc(); const t0 = now(); for (let i = 0; i < Wd; i++) s.get(key(i % N)).get('n').update(r * Wd + i + 1e9); xs.push(Number(now() - t0) / Wd) }
    today[K] = r1(med(xs))
  }
  out({ claim: 8, bench: 'path-fan', rows: N, writes: W, nsPerWrite: res, dataPathConnectToday: today, ratio_10000_over_0: r3(res[10000].lens / res[0].lens), ratio_100000_over_0: r3(res[100000].lens / res[0].lens) })
}

if (PART === 'share') {
  // 1,000 here()s and 1,000 connects on one selection in a client (loopback, JSON frames): count the work
  const server = fero('s', { data: seedRows(1000) })
  const tr = new Loop(server, { json: true })
  let ticks = []
  const timers = { set: (fn, ms) => { ticks.push(fn); return fn }, clear: (h) => { ticks = ticks.filter((x) => x !== h) } }
  const cl = fero('s', { role: 'client', transport: tr, linger: 1000, timers })
  const helds = [], links = []
  const targets = Array.from({ length: 1000 }, () => ({ text: '', n: 0 }))
  for (let i = 0; i < 1000; i++) helds.push(cl.data.k7.here())
  for (let i = 0; i < 1000; i++) links.push(cl.data.k7.connect(targets[i], (t, c) => { t.text = c.text(); t.n++ }))
  await helds[0].ready
  const before = { ...cl.eng.stats }
  const W = 100
  let folds = 0
  const foldSink = cl.eng.src.connect({ wantsOrder: false, origin: null, apply: (b) => { folds += b.rows.length } })
  for (let i = 0; i < W; i++) server.set(['k7', 'n'], 5000 + i)
  foldSink.dispose()
  const after = cl.eng.stats
  const counts = { upstreamSubs: tr.stats.subs, framesDecoded: tr.stats.decodes - 1, writes: W, foldsInCache: folds, textBuilds: after.texts - before.texts, deliveries: after.deliveries - before.deliveries, selections: cl.eng.sels.size, allTargetsCurrent: targets.every((t) => t.n === W + 1) }
  for (const h of helds) h.close()
  for (const l of links) l.close()
  const unsubBeforeLinger = tr.stats.unsubs
  const pendingTimers = ticks.length
  for (const fn of ticks.splice(0)) fn() // the linger ends
  out({ claim: 9, bench: 'share', links: 2000, counts, unsubBeforeLinger, lingerTimers: pendingTimers, unsubAfterLinger: tr.stats.unsubs, selectionsAfter: cl.eng.sels.size, cacheRowsAfter: cl.eng.src.rowCount() })
}

if (PART === 'tap') {
  // tap-cost.mjs's harness: 10,000 rows, 200,000 field writes over every row, one sink on the whole resource
  const N = 10000, W = 200000
  const run = (attach) => {
    const f = fero('f', { data: seedRows(N) }); f.eng.promote()
    let c = 0
    const h = attach(f, () => c++)
    const xs = []
    for (let r = 0; r < 5; r++) { gc(); const t0 = now(); for (let i = 0; i < W; i++) f.set([key(i % N), 'n'], r * W + i + 1e9); xs.push(Number(now() - t0) / W) }
    return { nsPerWrite: r1(med(xs)), calls: c }
  }
  const runData = (attach) => {
    const s = D.$(seedRows(N)); s.promote(); let c = 0
    attach(s, () => c++)
    const xs = []
    for (let r = 0; r < 5; r++) { gc(); const t0 = now(); for (let i = 0; i < W; i++) s.get(key(i % N)).get('n').update(r * W + i + 1e9); xs.push(Number(now() - t0) / W) }
    return { nsPerWrite: r1(med(xs)), calls: c }
  }
  const res = {}
  for (let rep = 0; rep < 2; rep++) {
    res['none' + rep] = run(() => null)
    res['bare data sink' + rep] = run((f, cnt) => f.eng.src.connect({ wantsOrder: false, origin: null, apply: () => cnt() })) // data's delivery alone, no lens
    res['tap reads nothing' + rep] = run((f, cnt) => f.data.tap((c) => cnt()))
    res['tap reads changes+prev' + rep] = run((f, cnt) => f.data.tap((c) => { for (const ch of c.changes) { if (ch.prev !== undefined) sink++; cnt() } }))
    res['tap reads now' + rep] = run((f, cnt) => f.data.tap((c) => { if (c.now.rows.k1 !== undefined) sink++; cnt() }))
    res['tap reads recs()' + rep] = run((f, cnt) => f.data.tap((c) => { sink += c.recs().length; cnt() }))
  }
  const today = {
    'data none': runData(() => null),
    'data tap(() => …)': runData((s, cnt) => s.tap(() => cnt())),
    'data tap((rec) => …)': runData((s, cnt) => s.tap((rec) => cnt())),
  }
  const m = (k) => Math.min(res[k + '0'].nsPerWrite, res[k + '1'].nsPerWrite)
  const derived = { dataSink_over_none: r1(m('bare data sink') - m('none')), lens_over_dataSink: r1(m('tap reads nothing') - m('bare data sink')), nothing_over_none: r1(m('tap reads nothing') - m('none')), changes_over_nothing: r1(m('tap reads changes+prev') - m('tap reads nothing')), now_over_nothing: r1(m('tap reads now') - m('tap reads nothing')), recs_over_nothing: r1(m('tap reads recs()') - m('tap reads nothing')), data_param_over_bare: r1(today['data tap((rec) => …)'].nsPerWrite - today['data tap(() => …)'].nsPerWrite) }
  out({ claim: 10, bench: 'tap', rows: N, writes: W, ns: res, today, derived })
}

if (PART === 'tap2') {
  // Review F5: the `tap` part above runs its ways one after another and takes the lower of two copies; two copies
  // of the SAME way then differ by 37 to 530 ns, more than claim 10's 50 ns bar. Here every way has its own
  // resource, made up front, and the ways are interleaved round by round (as step.mjs does), their order rotated
  // each round. A difference is taken inside a round (way − base, same round); the result is the median over the
  // rounds, with the lowest and highest round. `none B − none A` is the noise: two copies of the same way.
  // Review F15: `frozen` freezes each row a sink is handed, deeply, on first hand-out (what f.rows does, DATA-07).
  const N = 10000, W = 200000, ROUNDS = 9
  const deepFreeze = (o) => { if (Object.isFrozen(o)) return o; Object.freeze(o); for (const k in o) { const v = o[k]; if (v !== null && typeof v === 'object') deepFreeze(v) } return o }
  const mkLens = (attach) => { const f = fero('f', { data: seedRows(N) }); f.eng.promote(); const st = { c: 0 }; attach(f, () => st.c++); return { st, go: (r) => { for (let i = 0; i < W; i++) f.set([key(i % N), 'n'], r * W + i + 1e9) } } }
  const mkData = (attach) => { const d = D.$(seedRows(N)); d.promote(); const st = { c: 0 }; attach(d, () => st.c++); return { st, go: (r) => { for (let i = 0; i < W; i++) d.get(key(i % N)).get('n').update(r * W + i + 1e9) } } }
  const ways = {
    'none A': mkLens(() => null),
    'none B': mkLens(() => null),
    'bare data sink': mkLens((f, cnt) => f.eng.src.connect({ wantsOrder: false, origin: null, apply: () => cnt() })),
    'tap reads nothing': mkLens((f, cnt) => f.data.tap(() => cnt())),
    'tap reads changes+prev': mkLens((f, cnt) => f.data.tap((c) => { for (const ch of c.changes) { if (ch.prev !== undefined) sink++; cnt() } })),
    'tap reads changes+prev, frozen': mkLens((f, cnt) => f.data.tap((c) => { for (const ch of c.changes) { if (ch.row !== undefined) deepFreeze(ch.row); if (ch.prev !== undefined) sink++; cnt() } })),
    'tap reads now': mkLens((f, cnt) => f.data.tap((c) => { if (c.now.rows.k1 !== undefined) sink++; cnt() })),
    'tap reads recs()': mkLens((f, cnt) => f.data.tap((c) => { sink += c.recs().length; cnt() })),
    'data none': mkData(() => null),
    'data tap(() => …)': mkData((d, cnt) => d.tap(() => cnt())),
    'data tap((rec) => …)': mkData((d, cnt) => d.tap((rec) => cnt())),
  }
  const names = Object.keys(ways)
  const xs = Object.fromEntries(names.map((k) => [k, []]))
  for (const k of names) ways[k].go(-1) // one warm round each, not timed
  for (let r = 0; r < ROUNDS; r++) {
    for (let j = 0; j < names.length; j++) {
      const k = names[(j + r) % names.length]
      gc(); const t0 = now(); ways[k].go(r); xs[k].push(Number(now() - t0) / W)
    }
  }
  const stat = (v) => { const srt = [...v].sort((a, b) => a - b); return { med: r1(med(v)), lo: r1(srt[0]), hi: r1(srt[srt.length - 1]) } }
  const diff = (a, b) => stat(xs[a].map((x, i) => x - xs[b][i]))
  const ns = Object.fromEntries(names.map((k) => [k, { ...stat(xs[k]), calls: ways[k].st.c }]))
  const derived = {
    noise_noneB_minus_noneA: diff('none B', 'none A'),
    dataSink_over_none: diff('bare data sink', 'none A'),
    nothing_over_none: diff('tap reads nothing', 'none A'),
    lens_over_dataSink: diff('tap reads nothing', 'bare data sink'),
    changes_over_nothing: diff('tap reads changes+prev', 'tap reads nothing'),
    frozen_over_changes: diff('tap reads changes+prev, frozen', 'tap reads changes+prev'),
    now_over_nothing: diff('tap reads now', 'tap reads nothing'),
    recs_over_nothing: diff('tap reads recs()', 'tap reads nothing'),
    data_bare_tap_over_none: diff('data tap(() => …)', 'data none'),
    data_param_over_bare: diff('data tap((rec) => …)', 'data tap(() => …)'),
  }
  out({ claim: 10, bench: 'tap-interleaved', rows: N, writes: W, rounds: ROUNDS, ns, derived })
}

if (PART === 'weak') {
  // 10,000 weak links (connect) against 10,000 strong sinks (tap) on one selection (the whole resource)
  const N = 10000, L = 10000, W = 2000
  const run = (mode) => {
    const f = fero('f', { data: seedRows(N) }); f.eng.promote()
    const targets = Array.from({ length: L }, () => ({ n: 0 }))
    let c = 0
    // WORK (argv[3] = 'work'): each sink also does a little of its own work, as a DOM sink would (a property
    // write per change); without it the sinks only count
    const WORK = process.argv[3] === 'work'
    // a strong sink with work writes its OWN object (closed over), as the weak link writes its target: the same
    // memory touched on both sides (run 1's first harness wrote one shared object here: see README)
    if (mode === 'strong') for (let i = 0; i < L; i++) { const t = targets[i]; f.data.tap(WORK ? (cc) => { c++; for (const ch of cc.changes) { t.last = ch.row; t.n++ } } : (cc) => { c++ }) }
    if (mode === 'weak') for (let i = 0; i < L; i++) f.data.connect(targets[i], WORK ? (t, cc) => { c++; for (const ch of cc.changes) { t.last = ch.row; t.n++ } } : (t, cc) => { c++ })
    const xs = []
    for (let r = 0; r < 7; r++) { gc(); const t0 = now(); for (let i = 0; i < W; i++) f.set([key(i % N), 'n'], r * W + i + 1e9); xs.push(Number(now() - t0) / W) }
    sink += targets.length
    return { nsPerCommit: r1(med(xs)), calls: c }
  }
  const res = { strong: run('strong'), weak: run('weak'), strong2: run('strong'), weak2: run('weak') }
  const s = Math.min(res.strong.nsPerCommit, res.strong2.nsPerCommit), w = Math.min(res.weak.nsPerCommit, res.weak2.nsPerCommit)
  // the target check alone: WeakRef.deref() and a compare, per call
  const refs = Array.from({ length: L }, () => new WeakRef({}))
  const keepAlive = refs.map((r) => r.deref())
  const xs = []
  for (let r = 0; r < 7; r++) { gc(); const t0 = now(); for (let j = 0; j < 200; j++) for (let i = 0; i < L; i++) { const t = refs[i].deref(); if (t === undefined) sink-- } xs.push(Number(now() - t0) / (200 * L)) }
  out({ claim: 11, bench: 'weak', sinkWork: process.argv[3] === 'work', strongOwnTarget: true, rows: N, links: L, writes: W, ns: res, ratio_weak_over_strong: r3(w / s), perLinkDelta: r3((w - s) / L), derefCheckNs: r3(med(xs)), alive: keepAlive.length })
}
