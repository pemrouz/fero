// sections/break/runs.js — the section's OWN RUNS: separate simulations seeded from the page's seed, never the
// house cluster. DOM-free, so a Worker (worker.js) runs them off the main thread; Node can run them too.
//
//   crash  — three servers; the owner of gadgets is cut from everyone and destroyed (core.js kill: kill -9);
//            c1 writes gadgets; the survivors vote it out; the write lands.
//   stop   — the same, but the owner leaves cleanly (core.js leave: Ctrl-C, a LEAVE ballot).
//   crash2 — two servers; the owner is crashed; one of two is not a majority, so the write waits until the page
//            restarts the dead one from its disk.
//   defaults — the crash vote again, with the heartbeat and redial at fero's defaults, on three servers built
//            with sim.add (the house harness pins redial at 20 ms, so it cannot build this one). The caller
//            passes the defaults (read from api/index.ts at build time) and the house link delay: nothing here
//            is typed.
//
// Every number a run returns is the kernel's (journal rows, apply stamps, monitors, sim.now) or the run's own
// action log.
import { LiveCluster, Sim, REC, JK } from '../../core.js'
import { perEvent } from '../../lib/sim/monitors.js'
import { Story, annotate } from './narrate.js'

const ROW = 'gadgets'
const VALUE = { stock: 9 }          // the same write in every run: c1 assigns shop.data.gadgets = { stock: 9 }
const HORIZON = 16000               // simulated ms after the fault before a run gives up
const RESTART_AFTER = 7000          // crash2: the page restarts the dead owner this long after the crash

// run(lc, until, pred): advance in small steps until pred() holds or until (absolute) — always bounded
function runUntil(lc, until, pred) {
  while (lc.now < until && !pred()) lc.runTo(Math.min(until, lc.now + 25))
  return pred()
}
function settle(lc) {
  runUntil(lc, 20000, () => lc.isReady && lc.serverIds.every((s) => lc.viewOf(s).epoch >= 1))
  lc.runTo(lc.now + 500)
}
// the first violation of each rule: { monitor, event, detail } — a rule that breaks keeps failing at every
// later event, so the count of events says little; which rules broke, and where first, says it all
const firstPerRule = (vs) => { const m = new Map(); for (const v of vs) if (!m.has(v.monitor)) m.set(v.monitor, { monitor: v.monitor, event: v.event, detail: v.detail }); return [...m.values()] }

export function scenario(kind, seed, opts = {}) {
  if (kind === 'defaults') return defaultsRun(seed, opts)
  const servers = kind === 'crash2' ? 2 : 3
  const lc = new LiveCluster({ seed, paced: false, writer: false, servers })
  settle(lc)
  const t0 = lc.now, ev0 = lc.events, v0 = lc.sim.violations.length
  const target = lc.owner(ROW)
  const lanes = lc.ids()
  const story = new Story(t0)
  const views = lanes.map((id) => ({ node: id, at: t0, epoch: lc.viewOf(id).epoch, members: lc.viewOf(id).members }))
  const marks = []
  let vote = null
  lc.on('journal', (e) => {
    story.add(annotate(lc, e))
    if (e.name === 'viewInstall' && e.at >= t0) {
      const v = lc.viewOf(e.node)
      views.push({ node: e.node, at: e.at, epoch: v.epoch, members: v.members })
      if (!vote && !v.members.includes(target)) vote = { at: e.at, epoch: v.epoch, members: v.members, node: e.node }
    }
  })
  // every distinct stamp the write got, anywhere (nothing else writes this value to this row in an own run)
  const want = JSON.stringify(VALUE), stamps = []
  lc.on('apply', (a) => {
    if (a.at < t0 || a.path[0] !== ROW || a.type !== REC.update || JSON.stringify(a.value) !== want) return
    const k = `${a.origin}|${a.seq}|${a.epoch}`
    if (!stamps.some((s) => s.k === k)) stamps.push({ k, epoch: a.epoch, seq: a.seq, origin: a.origin, at: a.at, node: a.node })
  })
  lc.on('kill', (id) => marks.push({ node: id, at: lc.now, kind: 'kill' }))
  lc.on('left', (id) => marks.push({ node: id, at: lc.now, kind: 'left' }))
  lc.on('restart', (id) => marks.push({ node: id, at: lc.now, kind: 'restart', origin: lc.origin(id), life: lc.life(id) }))
  if (kind === 'stop') { lc.leave(target); marks.push({ node: target, at: t0, kind: 'leave' }) } else lc.kill(target)
  lc.runTo(t0 + 50)
  const w = lc.write('c1', ROW, VALUE)
  let restart = null
  if (kind === 'crash2') {
    runUntil(lc, t0 + RESTART_AFTER, () => w.state === 'committed')
    if (w.state !== 'committed') { lc.restart(target); restart = { at: lc.now, origin: lc.origin(target), life: lc.life(target) } }
  }
  runUntil(lc, t0 + HORIZON, () => w.state === 'committed' && (kind === 'crash2' || vote))
  lc.runTo(lc.now + 600)
  const end = lc.now
  return {
    kind, seed, servers: lc.serverIds.slice(), lanes, target, row: ROW, t0, end,
    rec: { type: REC.update, key: [ROW], value: VALUE },
    write: { issuedAt: w.issuedAt, committedAt: w.committedAt ?? null, stamp: w.stamp ?? null, state: w.state },
    stamps: stamps.map(({ k, ...s }) => s),
    vote, restart, views, marks,
    gate: kind === 'crash2' ? lc.writable(lc.serverIds.find((s) => s !== target)) : null,
    lines: story.lines(), routine: story.routineText(), quiet: story.quiet, rows: story.rows,
    events: lc.events - ev0, violations: lc.violations - v0, broken: firstPerRule(lc.sim.violations.slice(v0)), rules: lc.rules.length,
    final: lanes.filter((id) => lc.alive(id)).map((id) => ({ id, value: lc.object(id)[ROW] ?? null, stamp: lc.stamp(id, ROW) ?? null })),
  }
}

// the crash vote at fero's defaults: heartbeat.ms and redial.ms as api/index.ts sets them (passed in by the page
// from its build facts), the house link delay, durable — no client, no writer: only the vote is timed.
export function defaultsRun(seed, { heartbeatMs, redialMs, delay } = {}) {
  if (!(heartbeatMs > 0) || !(redialMs > 0) || !Array.isArray(delay)) return { kind: 'defaults', seed, failed: true, why: 'the build facts did not load' }
  const sim = new Sim(seed, { delay })
  const ids = ['n01', 'n02', 'n03']
  const nodes = ids.map((id) => sim.add({ uuid: id, listen: `sim:${id}`, hosts: ids.filter((x) => x !== id).map((x) => `sim:${x}`), heartbeatMs, durable: true, redialMs, journalCap: 1 << 16 }))
  sim.monitors.push(...perEvent())
  for (const id of ids) sim.post(id, { kind: 'start' })
  const run = (until, pred) => { while (sim.now < until && !pred()) sim.run({ until: Math.min(until, sim.now + 50), maxEvents: 200000 }), sim.now = Math.max(sim.now, Math.min(until, sim.now + 50)); return pred() }
  run(30000, () => nodes.every((n) => n.membership.view.epoch >= 1))
  run(sim.now + 1000, () => false)
  const t0 = sim.now, target = 'n02'
  // the vote's instant is the survivor's own viewInstall row (tapped like core.js taps the journal)
  let voteAt = null, epoch = null
  for (const n of [nodes[0], nodes[2]]) {
    const emit = n.journal.emit.bind(n.journal)
    n.journal.emit = (kind, a, b, c) => {
      emit(kind, a, b, c)
      if (kind === JK.viewInstall && voteAt === null && !n.membership.view.members.some((m) => m[0] === target)) { voteAt = sim.now; epoch = n.membership.view.epoch }
    }
  }
  for (const id of ids) if (id !== target) sim.partition(target, id)
  nodes[1].destroy()
  run(t0 + 120000, () => voteAt !== null)
  return { kind: 'defaults', seed, heartbeatMs, redialMs, delay, t0, voteMs: voteAt === null ? null : voteAt - t0, epoch, events: sim.events, violations: sim.violations.length, broken: firstPerRule(sim.violations) }
}
