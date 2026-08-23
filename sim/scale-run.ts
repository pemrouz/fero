//! ── sim/scale-run — the deep/nightly scale tier: `npm run sim:scale` ──────────
// The n=100 heavyweights the in-suite scale files model at n=8..50: seed-swept
// chaos at full width (30-90s per trajectory — script-tier by doctrine, never
// glob-tier). Monitors ride sampled (--check-every, default 1000): the
// log-cursor invariants keep full fidelity; state-snapshot laws are asserted at
// horizons. Engagement counters print per scenario — a sweep whose chaos never
// fired reads as exactly that, not as coverage. Scenarios using sim.restart /
// storeFault are NOT shrinkable (Step is write|partition|heal): failures ship
// the full capture only, and say so.
//
//   npm run sim:scale                      # every scenario at its default seeds
//   npm run sim:scale -- --only genesis-100 --seeds 20
//   npm run sim:scale -- --check-every 5000 --max-events 20000000

import { mkdirSync, writeFileSync } from 'node:fs'
import { Sim } from './exec.ts'
import { cluster, client, formed, writes } from './harness.ts'
import { converged, drained, exactlyR, scopedConverged, confirmedIntact } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import { captureSim } from '../tools/debug/capture.ts'
import type { Node } from '../kernel/node.ts'

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : dflt
}
const strArg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : null
}

const checkEvery = arg('check-every', 1000)
const maxEvents = arg('max-events', 10_000_000)
const seedsOverride = arg('seeds', 0) // 0 = per-scenario defaults
const only = strArg('only')

const jcount = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind).length
const jtotal = (sim: Sim, kind: number) => [...sim.nodes.values()].reduce((s, n) => s + jcount(n, kind), 0)
const live = (sim: Sim): Node[] => [...sim.nodes.values()]
const run = (sim: Sim, opts: { until?: number } = {}) => sim.run({ ...opts, checkEvery, maxEvents })

//! the standard verdict spine (run.ts's chain, horizon-tolerant): first violation wins; scenarios
// append their own law checks after it. `engage` counters surface how hard the chaos actually bit.
const spine = (sim: Sim, nodes: Node[], opts: { quiesce?: boolean } = {}): string | null =>
  (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail} (event ${sim.violations[0].event})`) ||
  (!formed(nodes) && 'mesh never fully formed') ||
  (opts.quiesce !== false && !sim.quiesced && 'never quiesced') ||
  converged(sim) ||
  drained(sim) ||
  null

interface Scenario {
  name: string
  seeds: number
  shrinkable: boolean
  //! run one seed: null = green, string = the failure. `engage` accumulates scenario-wide counters.
  run(seed: number, engage: Map<string, number>): { sim: Sim; fail: string | null }
}

const bump = (engage: Map<string, number>, key: string, by: number) => engage.set(key, (engage.get(key) ?? 0) + by)

const SCENARIOS: Scenario[] = [
  {
    //! B1 at seed breadth: the always-on canary — any O(n²)→O(n³) regression shows up as runaway first
    name: 'converge-100', seeds: 10, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { fault: { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 } })
      writes(sim, nodes, 200, 300)
      if (seed % 2) { // the odd-seed partition/heal window, sweepBuild-style but cluster-built
        const a = nodes[Math.floor(sim.rng() * 100)].uuid
        let b = a
        while (b === a) b = nodes[Math.floor(sim.rng() * 100)].uuid
        const cut = 20 + sim.rng() * 150
        sim.at(cut, () => sim.partition(a, b))
        sim.at(cut + 30 + sim.rng() * 200, () => sim.heal(a, b))
        bump(engage, 'partitions', 1)
      }
      run(sim)
      bump(engage, 'dupDrops', jtotal(sim, JK.dupDrop))
      return { sim, fail: spine(sim, nodes) }
    },
  },
  {
    //! B2 at seed breadth: 100-member genesis under jittered personalities — one ballot, one proposer
    name: 'genesis-100', seeds: 5, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 100, fault: { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.2 } })
      run(sim, { until: 2000 })
      bump(engage, 'dupLinks', jtotal(sim, JK.dupLink)) // formation-only: dial-race dedup is the dup signal (no records to dupDrop)
      const proposers = live(sim).filter((n) => jcount(n, JK.propose) > 0).map((n) => n.uuid)
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (!formed(nodes) && 'mesh never fully formed') ||
        (nodes.some((n) => n.epoch !== 1) && `epochs split: ${new Set(nodes.map((n) => n.epoch)).size} distinct`) ||
        (proposers.join() !== 'n001' && `proposers [${proposers}] — the single-proposer law broke`) ||
        (nodes.some((n) => jcount(n, JK.viewInstall) !== 1) && 'a node installed more than one view') ||
        converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! B6 at full width — M6's newest machinery has never run above n≈50: the top bug-hunt candidate.
    // ~97% of held data freezes at the arming install; 100 concurrent shed polls negotiate R=3 sets.
    name: 'exactly-3-of-100', seeds: 5, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 200, replicas: 3, fault: { delay: [1, 1 + sim.rng() * 15], dupP: sim.rng() * 0.1 } })
      writes(sim, nodes, 150, 300)
      run(sim, { until: 10_000 })
      bump(engage, 'sheds', jtotal(sim, JK.shed))
      bump(engage, 'stalls', jtotal(sim, JK.shedStall))
      const wedged = live(sim).filter((n) => { const t = n.scope!.tallies(); return t.orphaned > 0 || t.acquiring > 0 })
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (!formed(nodes) && 'mesh never fully formed') ||
        exactlyR(sim) || scopedConverged(sim) ||
        (wedged.length > 0 && `${wedged.length} nodes still hold orphans/acquisitions at horizon`) || null
      return { sim, fail }
    },
  },
  {
    //! C2 at n=100: cut 10, one batch ballot, heal, 10-wide join wave home
    name: 'batch-eviction-of-10', seeds: 2, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 200 })
      const cut = nodes.slice(90).map((n) => n.uuid)
      const kept = nodes.slice(0, 90)
      sim.at(1500, () => { for (const c of cut) for (const k of kept) sim.partition(c, k.uuid) })
      for (let i = 0; i < 10; i++) sim.post(kept[i * 7].uuid, { kind: 'write', recs: [{ type: 0, key: [`bw${i}`], value: i }] }, 1600 + i * 900)
      run(sim, { until: 10_000 })
      const evicted = new Set(kept[0].journal.read().filter((e) => e.kind === JK.evict).map((e) => e.a))
      bump(engage, 'evicted', evicted.size)
      if (evicted.size !== 10) return { sim, fail: `evicted ${evicted.size} of the cut 10 before heal` }
      sim.at(0, () => { for (const c of cut) for (const k of kept) sim.heal(c, k.uuid) })
      run(sim, { until: 40_000 })
      const all = live(sim)
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (all.some((n) => n.membership.view.members.length !== 100) && 'membership never fully restored') ||
        (new Set(all.map((n) => n.epoch)).size !== 1 && 'epochs split at horizon') ||
        converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! C3 at scale: 80 form, 20 join staggered — serialized admissions, join-starvation is the hunt
    name: 'join-storm-80+20', seeds: 2, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      //! hb=200 and a 25s horizon are the budget: at n=100 the idle AE floor costs ~n(n-1) digest
      // frames PER TICK, so hb=100 × 60s virtual exceeded 10M events in floor traffic alone before
      // any join work ran — the horizon must be sized to the wave (20 serialized ballots), not padded
      const members = cluster(sim, 80, { heartbeatMs: 200 })
      const allAddrs = [...members.map((m) => `sim:${m.uuid}`), ...Array.from({ length: 20 }, (_, i) => `sim:n${String(81 + i).padStart(2, '0')}`)]
      for (let i = 0; i < 20; i++)
        sim.at(1500 + i * 100, () => {
          const uuid = `n${String(81 + i).padStart(2, '0')}`
          sim.add({ uuid, listen: `sim:${uuid}`, hosts: allAddrs.filter((a) => a !== `sim:${uuid}`), heartbeatMs: 200, redialMs: 20, journalCap: 1 << 16 })
          sim.post(uuid, { kind: 'start' }, 0)
        })
      for (let i = 0; i < 30; i++) sim.post(members[i % 80].uuid, { kind: 'write', recs: [{ type: 0, key: [`jw${i}`], value: i }] }, 1400 + i * 500)
      run(sim, { until: 25_000 })
      const all = live(sim)
      const admitted = all.filter((n) => n.membership.view.members.length === 100).length
      engage.set('peak-epoch', Math.max(engage.get('peak-epoch') ?? 0, ...all.map((n) => n.epoch)))
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (admitted !== 100 && `join starvation: only ${admitted}/100 nodes see full membership at horizon`) ||
        (all.some((n) => jcount(n, JK.propose) > 0 && n.uuid !== 'n01') && 'a second proposer appeared') ||
        converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! C6 at n=100: every disk restores at one instant; mutual re-confirmation, no ballot race
    name: 'full-restore-at-100', seeds: 2, shrinkable: false,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 100, durable: true })
      run(sim, { until: 1500 })
      if (!formed(nodes)) return { sim, fail: 'never formed before the kill' }
      writes(sim, nodes, 150, 500)
      let id = 0
      sim.at(800, () => {
        for (const n of live(sim)) {
          const tail = n.logs.get(n.uuid)?.at(-1)
          if (tail && id < 10) sim.post(n.uuid, { kind: 'confirm', id: ++id, origin: n.uuid, seq: tail.seq, level: CONFIRM.persisted })
        }
      })
      sim.at(1000, () => { for (const n of live(sim)) sim.restart(n.uuid) })
      run(sim, { until: 12_000 })
      const all = live(sim)
      bump(engage, 'replayed', jtotal(sim, JK.replayed))
      const proposes = all.reduce((s, n) => s + jcount(n, JK.propose), 0)
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (all.some((n) => n.membership.rejoining()) && 'a rejoin floor never cleared') ||
        (proposes > 0 && `${proposes} proposes — mutual re-confirmation should beat the self-ballot with all 100 back`) ||
        confirmedIntact(sim, CONFIRM.persisted) || converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! C5 at scale: 30 of 100 durable nodes crash staggered mid-workload on slow disks
    name: 'mass-restart-30-of-100', seeds: 2, shrinkable: false,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 100, durable: true })
      const victims = nodes.filter((_, i) => i % 3 === 1).slice(0, 30).map((n) => n.uuid)
      for (const v of victims) sim.storeFault(v, { delay: [30, 120] })
      run(sim, { until: 1500 })
      if (!formed(nodes)) return { sim, fail: 'never formed before the crashes' }
      writes(sim, nodes, 300, 600)
      let torn = 0
      victims.forEach((v, i) => sim.at(300 + i * 15, () => { torn += sim.stores.get(v)!.wal.filter((r) => !r.resolved).length; sim.restart(v) }))
      run(sim, { until: 15_000 })
      bump(engage, 'torn-rows', torn)
      const stuck = victims.filter((v) => sim.nodes.get(v)!.membership.rejoining() || !sim.nodes.get(v)!.membership.gate(sim.nodes.get(v)!).open)
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (stuck.length > 0 && `${stuck.length} reborn nodes still gated/rejoining at horizon`) ||
        converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! C7 at scale + the amplification ledger: how many redundant copies does a 99-teacher re-teach cost?
    name: 'fsync-liars-10-of-100', seeds: 2, shrinkable: false,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 100, durable: true })
      const liars = nodes.slice(90).map((n) => n.uuid)
      for (const l of liars) sim.storeFault(l, { lieP: 0.3 })
      run(sim, { until: 1500 })
      if (!formed(nodes)) return { sim, fail: 'never formed' }
      writes(sim, nodes, 200, 500)
      liars.forEach((l, i) => sim.at(400 + i * 40, () => sim.restart(l)))
      run(sim, { until: 15_000 })
      bump(engage, 'holes+taints', liars.reduce((s, l) => s + jcount(sim.nodes.get(l)!, JK.walHole) + jcount(sim.nodes.get(l)!, JK.walTaint), 0))
      bump(engage, 'aeShips', jtotal(sim, JK.aeShip))
      bump(engage, 'dupDrops-at-liars', liars.reduce((s, l) => s + jcount(sim.nodes.get(l)!, JK.dupDrop), 0))
      const backpressured = live(sim).filter((n) => jcount(n, JK.dropOldest) > 0)
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (backpressured.length > 0 && `the re-teach storm tripped backpressure at ${backpressured.map((n) => n.uuid)}`) ||
        converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! B2's adversary: dupP 0.5 on every pair — every dedup layer at once, at width. Finds nothing
    // for hundreds of seeds and then earns its keep.
    name: 'dup-storm-formation', seeds: 5, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 100, fault: { delay: [1, 25], dupP: 0.5 } })
      writes(sim, nodes, 100, 800)
      run(sim, { until: 2500 })
      bump(engage, 'dupDrops', jtotal(sim, JK.dupDrop))
      bump(engage, 'dupLinks', jtotal(sim, JK.dupLink))
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (!formed(nodes) && 'mesh never fully formed') ||
        (nodes.some((n) => n.epoch !== 1 || jcount(n, JK.viewInstall) !== 1) && 'dup PROPOSE/VOTE broke the one-install law') ||
        converged(sim) || null
      return { sim, fail }
    },
  },
  {
    //! C4 at n=100: one join moves ~1/101 of the ring under 200 live writes
    name: 'rescope-storm-100', seeds: 2, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 100, { heartbeatMs: 200, replicas: 3 })
      run(sim, { until: 8000 })
      if (!formed(nodes)) return { sim, fail: 'never formed' }
      writes(sim, nodes, 200, 400)
      sim.at(400, () => {
        sim.add({ uuid: 'n101', listen: 'sim:n101', hosts: nodes.map((m) => `sim:${m.uuid}`), heartbeatMs: 200, redialMs: 20, journalCap: 1 << 16, replicas: 3 })
        sim.post('n101', { kind: 'start' }, 0)
      })
      run(sim, { until: 30_000 })
      bump(engage, 'orphaned', jtotal(sim, JK.orphaned))
      bump(engage, 'acquires', jtotal(sim, JK.acquire))
      const all = live(sim)
      const wedged = all.filter((n) => { const t = n.scope!.tallies(); return t.orphaned > 0 || t.acquiring > 0 })
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (all.some((n) => n.epoch < 2) && 'the join never committed') ||
        exactlyR(sim) || scopedConverged(sim) ||
        (wedged.length > 0 && `${wedged.length} nodes wedged at horizon`) || null
      return { sim, fail }
    },
  },
  {
    //! spokes at width: 20 clients across 50 members, one popular server dies — 20 failovers at once
    name: 'spokes-20-on-50', seeds: 2, shrinkable: true,
    run(seed, engage) {
      const sim = new Sim(seed)
      const members = cluster(sim, 50, { heartbeatMs: 100 })
      //! every spoke lists n01 FIRST so the primary election concentrates — the mass-failover shape
      const spokes = Array.from({ length: 20 }, (_, i) =>
        client(sim, `c${String(i + 1).padStart(2, '0')}`, [members[0], ...members.slice(1 + (i % 45), 5 + (i % 45))], { heartbeatMs: 100 }))
      run(sim, { until: 1500 })
      for (let i = 0; i < 20; i++) sim.post(spokes[i].uuid, { kind: 'write', recs: [{ type: 0, key: [`cw${i}`], value: i }] }, 100 + i * 40)
      sim.at(1200, () => { for (const s of spokes) sim.partition('n01', s.uuid) }) // the popular feeder vanishes from every spoke
      for (let i = 0; i < 20; i++) sim.post(spokes[i].uuid, { kind: 'write', recs: [{ type: 0, key: [`fw${i}`], value: i }] }, 1400 + i * 40)
      run(sim, { until: 8000 })
      bump(engage, 'digests', jtotal(sim, JK.digestOut))
      const fail =
        (sim.violations.length && `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}`) ||
        (members.some((n) => n.membership.view.members.length !== 50) && 'a client leaked into membership') ||
        converged(sim) || null
      return { sim, fail }
    },
  },
]

const saveCapture = (sim: Sim, name: string, seed: number, why: string): void => {
  mkdirSync('captures', { recursive: true })
  const path = `captures/scale-${name}-seed-${seed}.json`
  writeFileSync(path, JSON.stringify(captureSim(sim)))
  console.error(`  capture (${why}): npm run debug -- ${path}`)
}

let failed = 0
let events = 0
const t0 = performance.now()
const picked = SCENARIOS.filter((s) => !only || s.name === only)
if (!picked.length) {
  console.error(`unknown scenario '${only}' — known: ${SCENARIOS.map((s) => s.name).join(', ')}`)
  process.exit(2)
}
for (const sc of picked) {
  const seeds = seedsOverride || sc.seeds
  const engage = new Map<string, number>()
  const ts = performance.now()
  let bad = 0
  for (let seed = 0; seed < seeds; seed++) {
    try {
      const { sim, fail } = sc.run(seed, engage)
      events += sim.events
      if (fail) {
        bad++; failed++
        console.error(`✗ ${sc.name} seed ${seed}: ${fail}`)
        if (!sc.shrinkable) console.error('  (restart/storeFault scenario — NOT shrinkable; full capture only)')
        saveCapture(sim, sc.name, seed, String(fail))
      }
    } catch (e) {
      bad++; failed++
      console.error(`✗ ${sc.name} seed ${seed}: threw ${e}`)
    }
  }
  const stats = [...engage].map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')
  console.log(`${bad ? '✗' : '✓'} ${sc.name}: ${seeds - bad}/${seeds} seeds green in ${((performance.now() - ts) / 1000).toFixed(1)}s${stats ? ` · ${stats}` : ''}`)
}
const ms = performance.now() - t0
console.log(`\n${failed ? 'RED' : 'GREEN'} · ${picked.length} scenarios · ${events.toLocaleString()} events in ${(ms / 1000).toFixed(0)}s (${Math.round(events / (ms / 1000)).toLocaleString()} events/s)`)
if (failed) process.exit(1)
