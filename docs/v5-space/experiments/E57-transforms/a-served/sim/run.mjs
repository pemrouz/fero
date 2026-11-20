// E-57 group A: the seeded runs. One JSON line per run: the claim, the planted bug (E57_MUTATE, empty when real), the
// seeds, the sums of every counter, the seeds that failed and why.
//   node --expose-gc --experimental-strip-types run.mjs <claim> [seeds]
// claims: a1 a2 a3 a4 a5 a6 a7 a8 xa2 xa2l xa2sb xa2sbx xa2s2 xa2s2x xa8 xa9 xa10 xa12 xa13 share sharing (see each preset below)
import { World, newStats } from './world.mjs'
import { MUT } from '../proto/served.mjs'

const CLAIM = process.argv[2], SEEDS = +(process.argv[3] ?? 1000)
const W = (o) => {
  // cumulative weights out of 1000: write, fold, deliver, client action, fault
  const b = { write: 120, fold: 330, deliver: 840, client: 950, fault: 1000, ...o }
  return b
}
const four = (w) => {
  const r = w.r, x = r() % 4
  if (x === 0) return { cls: 'C', method: 'best', arg: [3, 10][r() % 2] }
  if (x === 1) return { cls: 'C', method: 'byTeam', arg: null }
  if (x === 2) return { cls: 'C', method: 'total', arg: null }
  return { cls: 'C', method: 'after', arg: [r() % 10, 'k' + (r() % 40)] }
}
const base = { right: true, pOpen: 40, pClose: 60, pGet: 60, pWrite: 75, pCall: 75, maxOpen: 5, spec: four, weights: W({ client: 1000, fault: 1000 }) }
// faults: a seeded mix; a killed copy comes back after a while (from a snapshot)
const faults = (o) => (w) => {
  const r = w.r
  for (const c of w.copies) if (!c.alive && w.t >= (c.backAt ?? 0)) { w.restart(c.id); return }
  const x = r() % 100
  if (x < o.disc) { const ls = [...w.links.values()]; if (ls.length) w.disconnect(ls[r() % ls.length]) }
  else if (x < o.kill) { const sv = w.serving(); if (sv.length > 1) { const c = sv[r() % sv.length]; c.backAt = w.t + 10 + (r() % 30); w.kill(c.id) } }
  else if (x < o.lkill) { if (w.leader >= 0 && w.copies.filter((c) => c.alive).length > 1) { const k = w.leader; w.copies[k].backAt = w.t + 10 + (r() % 30); w.kill(k) } }
}
// faults with standbys: a kill takes any live copy but the leader (a standby too), while three copies live
const faultsSB = (o) => (w) => {
  const r = w.r
  for (const c of w.copies) if (!c.alive && w.t >= (c.backAt ?? 0)) { w.restart(c.id); return }
  const x = r() % 100
  if (x < o.disc) { const ls = [...w.links.values()]; if (ls.length) w.disconnect(ls[r() % ls.length]) }
  else if (x < o.kill) { const live = w.copies.filter((c) => c.alive); const cand = live.filter((c) => c.id !== w.leader); if (live.length > 2 && cand.length) { const c = cand[r() % cand.length]; c.backAt = w.t + 10 + (r() % 30); w.kill(c.id) } }
  else if (x < o.lkill) { const voters = w.copies.filter((c) => c.alive && !w.isStandby(c.id)); if (w.leader >= 0 && voters.length > 1) { const k = w.leader; w.copies[k].backAt = w.t + 10 + (r() % 30); w.kill(k) } }
}
// the serving copy that holds the most entries (a forced kill: at least one per seed)
const killBusiest = (w) => { const sv = w.serving(); if (sv.length < 1 || w.copies.filter((c) => c.alive).length < 2) return; const c = sv.sort((a, b) => b.entries.size - a.entries.size)[0]; c.backAt = w.t + 10 + (w.r() % 30); w.kill(c.id) }

const presets = {
  // A1: a served view end to end: four views, copies with their own lags, no faults
  a1: { ...base },
  // A2: reconnects: many disconnects, rings of 2 to 8 frames, short lingers
  a2: { ...base, weights: W({ fault: 1000 }), fault: faults({ disc: 92, kill: 97, lkill: 100 }) },
  // A3: failover: copy kills (one forced per seed), leader kills, restarts from a snapshot
  a3: { ...base, weights: W({}), fault: faults({ disc: 40, kill: 75, lkill: 100 }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 60 + (w.r() % 180) } },
  // A4: sharing and allow: mine(user) checked with the caller on every SUB; band({ lo, hi }) with keys in either order
  a4: { ...base, weights: W({ fault: 1000 }), fault: faults({ disc: 70, kill: 95, lkill: 100 }), spec: (w) => {
    const r = w.r, x = r() % 20
    if (x < 7) return { cls: 'C', method: 'mine', arg: 'u' + (r() % 4) }
    if (x < 17) { const lo = r() % 3, hi = lo + (r() % 3); return { cls: 'C', method: 'band', arg: r() % 2 ? { lo, hi } : { hi, lo } } }
    return { cls: 'C', method: 'best', arg: 10 }
  } },
  // A5: caps and bounds: small caps, many distinct calls, get(), and a bucket view that grows past views.rows
  a5: { ...base, viewsClient: 2, viewsMax: 5, viewsRows: 30, maxOpen: 6, linger: 25, clients: 4, pOpen: 45, pClose: 60, pGet: 78, pWrite: 82, pCall: 82, weights: W({ fault: 1000 }), fault: faults({ disc: 60, kill: 90, lkill: 100 }),
    spec: (w) => { const r = w.r, x = r() % 4; if (x === 0) return { cls: 'C', method: 'best', arg: 1 + (r() % 12) }; if (x === 1) return { cls: 'C', method: 'spread', arg: null }; if (x === 2) return { cls: 'C', method: 'band', arg: { lo: r() % 4, hi: 4 + (r() % 4) } }; return { cls: 'C', method: 'after', arg: [r() % 10, 'k' + (r() % 30)] } },
    getSpec: (w) => ({ cls: 'C', method: 'best', arg: 1 + (w.r() % 12) }) },
  // A6: linger and dispose; handler calls; at the end every client closes everything
  a6: { ...base, calls: true, closeAll: true, pOpen: 35, pClose: 65, pGet: 72, pWrite: 80, pCall: 92, getSpec: four, weights: W({ fault: 1000 }), fault: faults({ disc: 70, kill: 90, lkill: 100 }) },
  // A7: class B with the order channel; class A with the chain run here; past views.shapes, class B is served as A
  a7: { ...base, depth: 2, rows: 30, parts: 3, shapes: 3, maxOpen: 6, weights: W({ fault: 1000 }), fault: faults({ disc: 85, kill: 97, lkill: 100 }), spec: (w) => chainSpec(w) },
  // A8: a deploy of method table v2 on every copy at one step
  a8: { ...base, weights: W({ fault: 1000 }), fault: faults({ disc: 70, kill: 90, lkill: 100 }), atStep: (w, i) => { if (i === w.deployAt) { w.deployed = new Set(w.copies.map((c) => c.id)); for (const c of w.copies) if (c.alive) c.deploy(2); w.stats.deploys++ } }, init: (w) => { w.deployAt = 80 + (w.r() % 150) } },
  // XA-2: placement by key, and headroom for failover
  xa2: { ...base, failHeld: true, viewsMax: 12, headroom: 6, viewsClient: 16, clients: 4, maxOpen: 6, pOpen: 60, pClose: 65, weights: W({ fault: 1000 }), fault: faults({ disc: 50, kill: 100, lkill: 100 }),
    spec: (w) => ({ cls: 'C', method: 'band', arg: { lo: w.r() % 5, hi: 5 + (w.r() % 5) } }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 150 + (w.r() % 100) } },
  // XA-2, added after the skeptic's review (F2, F24): the headroom rule (views.max / k for k >= 2 serving copies, 0 for
  // one), (a) with leader kills on three voters, (b) with three voters and one standby (one serving copy while it lives)
  xa2l: { ...base, failHeld: true, headroomRule: true, viewsMax: 12, viewsClient: 16, clients: 4, maxOpen: 6, pOpen: 60, pClose: 65, weights: W({ fault: 1000 }), fault: faults({ disc: 50, kill: 80, lkill: 100 }),
    spec: (w) => ({ cls: 'C', method: 'band', arg: { lo: w.r() % 5, hi: 5 + (w.r() % 5) } }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 150 + (w.r() % 100) } },
  xa2sb: { ...base, failHeld: true, headroomRule: true, copies: 4, standbys: 1, standbysFirst: true, viewsMax: 12, viewsClient: 16, clients: 4, maxOpen: 6, pOpen: 60, pClose: 65, weights: W({ fault: 1000 }), fault: faultsSB({ disc: 50, kill: 80, lkill: 100 }),
    spec: (w) => ({ cls: 'C', method: 'band', arg: { lo: w.r() % 5, hi: 5 + (w.r() % 5) } }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 150 + (w.r() % 100) } },
  // (c) as (b), but every live copy except the leader serves (the standby and two voters): the rule the page took
  xa2sbx: { ...base, failHeld: true, headroomRule: true, copies: 4, standbys: 1, viewsMax: 12, viewsClient: 16, clients: 4, maxOpen: 6, pOpen: 60, pClose: 65, weights: W({ fault: 1000 }), fault: faultsSB({ disc: 50, kill: 80, lkill: 100 }),
    spec: (w) => ({ cls: 'C', method: 'band', arg: { lo: w.r() % 5, hi: 5 + (w.r() % 5) } }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 150 + (w.r() % 100) } },
  // (d) and (e): five servers, three voters and two standbys, standbys first (d) or every copy but the leader (e)
  xa2s2: { ...base, failHeld: true, headroomRule: true, copies: 5, standbys: 2, standbysFirst: true, viewsMax: 12, viewsClient: 16, clients: 4, maxOpen: 6, pOpen: 60, pClose: 65, weights: W({ fault: 1000 }), fault: faultsSB({ disc: 50, kill: 80, lkill: 100 }),
    spec: (w) => ({ cls: 'C', method: 'band', arg: { lo: w.r() % 5, hi: 5 + (w.r() % 5) } }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 150 + (w.r() % 100) } },
  xa2s2x: { ...base, failHeld: true, headroomRule: true, copies: 5, standbys: 2, viewsMax: 12, viewsClient: 16, clients: 4, maxOpen: 6, pOpen: 60, pClose: 65, weights: W({ fault: 1000 }), fault: faultsSB({ disc: 50, kill: 80, lkill: 100 }),
    spec: (w) => ({ cls: 'C', method: 'band', arg: { lo: w.r() % 5, hi: 5 + (w.r() % 5) } }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 150 + (w.r() % 100) } },
  // XA-8: an impure view (a threshold from the copy's own clock), through failovers
  xa8: { ...base, impure: true, spec: () => ({ cls: 'C', method: 'recent', arg: null }), thresholdOf: (s) => s.firstTh, weights: W({}), linger: 1000, fault: faults({ disc: 30, kill: 80, lkill: 100 }), atStep: (w, i) => { if (i === w.killAt) killBusiest(w) }, init: (w) => { w.killAt = 60 + (w.r() % 150) } },
  // XA-8 control: the same impure view with no faults (no failover): it must pass
  xa8ctl: { ...base, impure: true, clockConst: 50, spec: () => ({ cls: 'C', method: 'recent', arg: null }), thresholdOf: (s) => s.firstTh, weights: W({ client: 1000, fault: 1000 }) },
  // XA-9: a cost budget per copy (µs per write, at a nominal 1,000 rows) beside the count caps
  xa9: { ...base, budget: 10, nominalRows: 1000, viewsMax: 64, viewsClient: 16, clients: 4, maxOpen: 8, pOpen: 60, pClose: 75, weights: W({ fault: 1000 }), fault: faults({ disc: 50, kill: 100, lkill: 100 }),
    spec: (w) => { const r = w.r, x = r() % 3; return x === 0 ? { cls: 'C', method: 'best', arg: 1 + (r() % 20) } : x === 1 ? { cls: 'C', method: 'band', arg: { lo: r() % 5, hi: 5 + (r() % 5) } } : { cls: 'C', method: 'byTeam', arg: null } } },
  // XA-10: a rolling deploy (one copy at a time) with kills; half the clients are typed for v1
  xa10: { ...base, typedV1: true, spec: (w) => (w.r() % 3 ? { cls: 'C', method: w.r() % 2 ? 'best' : 'byTeam', arg: w.r() % 2 ? 10 : null } : four(w)), pOpen: 50, clientOpts: (i) => (i % 2 === 0 ? { shapes: { best: 'row', byTeam: 'num', total: 'num', after: 'row' } } : {}), weights: W({}), fault: faults({ disc: 20, kill: 75, lkill: 100 }),
    atStep: (w, i) => { if (w.rollAt.includes(i)) { const k = w.rollAt.indexOf(i); w.deployed.add(k); if (w.copies[k].alive) w.copies[k].deploy(2); w.stats.deploys++ } },
    init: (w) => { w.deployed = new Set(); const a = 50 + (w.r() % 50); w.rollAt = [a, a + 30 + (w.r() % 40), a + 90 + (w.r() % 40)] } },
  // XA-12: a bucket view that crosses views.rows again and again; clients keep asking for it
  xa12: { ...base, viewsRows: 25, spec: (w) => (w.r() % 2 ? { cls: 'C', method: 'spread', arg: null } : four(w)), pOpen: 50, pClose: 70, weights: W({ fault: 1000 }), fault: faults({ disc: 70, kill: 100, lkill: 100 }) },
  // XA-13: read-your-writes through SYNC
  xa13: { ...base, sync: true, pOpen: 35, pClose: 45, pGet: 45, pWrite: 80, pCall: 80, weights: W({ fault: 1000 }), fault: faults({ disc: 60, kill: 90, lkill: 100 }) },
}
// A7's grid: E-55 claim 17's chains of 1 to 3 plain operators, ending ordered (or in one aggregate)
function chainSpec(w) {
  const r = w.r, part = 'p' + (r() % w.cfg.parts)
  const filters = [() => ['gt', 'points', r() % 8], () => ['lt', 'points', 2 + (r() % 8)], () => ['between', 'points', r() % 4, 4 + (r() % 5)], () => ['gt', 'pts', ((r() % 1001) - 500) / 10]]
  const ends = [() => ['za', 'points', 3 + (r() % 8)], () => ['az', 'points', 3 + (r() % 8)], () => ['za', 'pts', 5], () => ['az', 'points'], () => ['za', 'points']]
  const aggs = [() => ['sum', 'pts'], () => ['length'], () => ['max', 'points'], () => ['min', 'pts']]
  const n = r() % 3, ops = []
  for (let i = 0; i < n; i++) ops.push(filters[r() % filters.length]())
  ops.push(r() % 5 === 0 ? aggs[r() % aggs.length]() : ends[r() % ends.length]())
  return { cls: r() % 3 === 0 ? 'A' : 'B', part, ops }
}

function runSeeds(claim, seeds) {
  const P = presets[claim]
  const tot = newStats(), failKinds = {}, failed = []
  let maxBuilds = 0
  const only = process.env.E57_SEED ? +process.env.E57_SEED : 0
  for (let seed = only || 1; seed <= (only || seeds); seed++) {
    const w = new World(seed, P)
    P.init?.(w)
    if (only) trace(w)
    if (claim === 'xa8' || claim === 'xa8ctl') hookImpure(w)
    w.run()
    for (const [k, v] of Object.entries(w.stats)) tot[k] = (tot[k] ?? 0) + v
    if (w.stats.kills > 0) tot.seedsWithKill = (tot.seedsWithKill ?? 0) + 1
    maxBuilds = Math.max(maxBuilds, w.stats.maxBuildsPerKey)
    if (w.fails.size) { failed.push(seed); for (const [k, v] of w.fails) failKinds[k] = (failKinds[k] ?? 0) + v }
  }
  tot.maxBuildsPerKey = maxBuilds
  return { tot, failKinds, failed }
}
// XA-8: the client records the threshold of the copy that built its first picture
function hookImpure(w) {
  for (const cl of w.clients) {
    const orig = cl.onPicture.bind(cl)
    cl.onPicture = (s, m) => { if (s.firstTh === undefined) { for (const c of w.copies) if (c.alive) for (const e of c.entries.values()) if (e.inst === m.i) s.firstTh = e.th } return orig(s, m) }
  }
}

// a debugging aid: E57_SEED=n runs one seed and prints the first failure with the client's recent messages
function trace(w) {
  const logs = new Map()
  for (const cl of w.clients) { const o = cl.onMsg.bind(cl); logs.set(cl.id, []); cl.onMsg = (k, raw) => { const L = logs.get(cl.id); L.push('t' + w.t + ' c' + cl.id + ' <' + k + ' ' + (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 200)); if (L.length > 40) L.shift(); return o(k, raw) } }
  let n = 0
  const f = w.fail.bind(w)
  w.fail = (kind, s) => { f(kind, s); if (n === 0 && (kind.startsWith('cap') || kind === 'refusedHeld')) for (const c of w.copies) if (c.alive) console.error('t', w.t, 'leader', w.leader, 'copy', c.id, 'entries', c.entries.size, 'lingering', [...c.entries.values()].filter((e) => e.lingerAt !== null).length, 'cli', JSON.stringify([...c.cli]), [...c.entries.values()].map((e) => e.key + ' h=' + JSON.stringify([...e.holders]) + ' ling=' + e.lingerAt + ' last=' + e.last).join(' | ')); if (n++ === 0) { console.error('FAIL', kind, 't', w.t, s ? JSON.stringify({ key: s.key, h: s.h, inst: s.inst, q: s.q, pos: s.pos, copy: s.copy, status: s.status, asA: s.asA, order: s.value?.order }) : ''); for (const cl of w.clients) if (!s || [...cl.sels.values()].includes(s)) console.error(logs.get(cl.id).join('\n')) } }
}
const out = (o) => console.log(JSON.stringify({ exp: 'E-57', group: 'A', node: process.version, mutate: [...MUT].join(',') || null, ...o }))

if (presets[CLAIM]) {
  const t0 = Date.now()
  const { tot, failKinds, failed } = runSeeds(CLAIM, SEEDS)
  out({ claim: CLAIM, seeds: SEEDS, failedSeeds: failed.length, firstFailed: failed.slice(0, 5), failKinds, sec: (Date.now() - t0) / 1000, stats: tot })
} else if (CLAIM === 'share') {
  // A1 and A4: one encode per view per change with 1 and 1,000 subscribers; equal calls share one data view
  for (const subs of [1, 1000]) {
    const w = new World(7, { ...presets.a1, clients: subs, steps: 0, rows: 40 })
    w.r = () => 0 // fixed choices
    for (const cl of w.clients) { cl.open({ cls: 'C', method: 'best', arg: 10 }); cl.open({ cls: 'C', method: 'byTeam', arg: null }); cl.open({ cls: 'C', method: 'total', arg: null }) }
    for (const c of w.copies) while (c.alive && c.pos < w.logEnd) w.foldOne(c)
    while (w.deliverOne());
    const before = { ...w.stats }
    const rr = (s => () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s })(99)
    w.r = rr
    let changes = 0
    for (let i = 0; i < 200; i++) { w.append(true); for (const c of w.copies) while (c.pos < w.logEnd) w.foldOne(c); while (w.deliverOne()); }
    const views = w.copies.reduce((a, c) => a + (c.alive ? c.entries.size : 0), 0)
    const d = (k) => w.stats[k] - before[k]
    out({ claim: 'share', subscribers: subs, entries: views, builds: w.stats.builds, commits: 200, frames: d('frames'), encodes: d('encodes'), sends: d('sends'), decodes: d('decodes'), framesApplied: d('framesApplied'), unequal: w.stats.unequal, encodesPerFrame: d('encodes') / d('frames'), sendsPerFrame: d('sends') / d('frames') })
  }
} else if (CLAIM === 'sharing') {
  // A4: 2,000 subscribers over keys whose arguments are objects written with their keys in either order
  for (const shuffle of [true]) {
    const w = new World(11, { ...presets.a1, clients: 100, steps: 0, rows: 40 })
    const r = w.r
    let subscribers = 0
    const distinct = new Set()
    for (let i = 0; i < 2000; i++) {
      const cl = w.clients[i % 100]
      const lo = r() % 5, hi = 5 + (r() % 5)
      const arg = shuffle && r() % 2 ? { hi, lo } : { lo, hi }
      const s = cl.open({ cls: 'C', method: 'band', arg }); subscribers++
      distinct.add('band|' + lo + '|' + hi + '|1')
      if (i % 50 === 0) while (w.deliverOne());
    }
    while (w.deliverOne());
    const entries = w.copies.reduce((a, c) => a + (c.alive ? c.entries.size : 0), 0)
    const builds = w.stats.builds
    let dataViews = 0
    for (const c of w.copies) if (c.alive) for (const e of c.entries.values()) dataViews++
    out({ claim: 'sharing', subscribers, distinctKeys: distinct.size, builds, entries, subsSent: w.stats.subs, joins: w.stats.joins, clientShares: w.stats.clientShares })
  }
} else if (CLAIM === 'placement') {
  // XA-2: (a) 2,000 subscribers over 50 keys on 3 copies: views built = distinct keys; (b) a copy kill with a cap of 40:
  // with headroom (20) no client that held a view is refused; planted: 'freecopy' (builds rise), 'noheadroom'
  for (const [max, head] of [[1000, 0], [64, 32], [40, 20]]) {
    const w = new World(5, { ...presets.a1, clients: 100, steps: 0, rows: 40, viewsMax: max, headroom: head, viewsClient: 64 })
    const r = w.r
    const keys = []
    for (let lo = 0; lo < 10; lo++) for (let d = 0; d < 5; d++) keys.push({ lo, hi: lo + d })
    for (let i = 0; i < 2000; i++) { w.clients[i % 100].open({ cls: 'C', method: 'band', arg: keys[r() % 50] }); if (i % 20 === 0) while (w.deliverOne()); }
    const drain = () => { for (let k = 0; k < 50; k++) { while (w.deliverOne()); w.t++; for (const c of w.copies) if (c.alive) c.tick(w.t); for (const [cl, kk] of w.downs.splice(0)) cl.linkDown(kk); for (const cl of w.clients) cl.tick(w.t) } }
    drain()
    const per = w.copies.map((c) => (c.alive ? c.entries.size : 0))
    const live = new Set(); for (const c of w.copies) for (const e of c.entries.values()) live.add(e.key)
    const before = { builds: w.stats.builds, entriesPerCopy: per, distinctLive: live.size, refusedFresh: w.stats.refusedCap, crossDup: w.stats.crossDup }
    w.checkCaps()
    killBusiest(w); drain()
    out({ claim: 'placement', viewsMax: max, headroom: head, subscribers: 2000, distinctKeys: 50, ...before, crossDupAfter: w.stats.crossDup, afterKill: { entriesPerCopy: w.copies.map((c) => (c.alive ? c.entries.size : 0)), refusedHeld: w.stats.refusedHeld, refusedTotal: w.stats.refusedCap, leaderEntries: w.stats.leaderEntries } })
  }
} else if (CLAIM === 'pages') {
  // XA-7: 1,000 page reads with distinct cursors from one client within one linger: one shared index; no refusal
  const w = new World(3, { ...presets.a1, clients: 1, steps: 0, rows: 60, linger: 100000, viewsClient: 16 })
  const cl = w.clients[0]
  let n = 0
  for (let pts = 0; pts < 10; pts++) for (let j = 0; j < 100; j++) { cl.get({ cls: 'C', method: 'page', arg: [pts, 'k' + j] }); n++; while (w.deliverOne()); if (j % 10 === 0) { w.append(true); for (const c of w.copies) while (c.pos < w.logEnd) w.foldOne(c) } }
  while (w.deliverOne());
  const entries = w.copies.map((c) => (c.alive ? c.entries.size : 0))
  out({ claim: 'pages', pageReads: n, answered: w.stats.getsChecked, unequal: w.stats.getUnequal, tooManyViews: w.stats.getTooMany, refused: w.stats.getRefused, indexesBuilt: w.stats.pageIndexes, servedEntriesBuilt: w.stats.builds - w.stats.pageIndexes, entriesPerCopy: entries })
} else { console.error('no claim ' + CLAIM); process.exit(1) }
