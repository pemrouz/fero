//! ── tools/debug/scenarios — the living scenario registry: every high-level behaviour as a named, diagrammed, measured run ──
// The dashboard (scenarios.html at `/`) is a projection of THIS file: each entry
// declares what the cluster is put through (happy path or fault path), a topology
// diagram spec, and a run() that executes the scenario on the sim executive and
// returns counted metrics + a full capture. Clicking a card opens that exact run
// in the debugger — the scenario IS its own debug artifact (plan §8, "tests ARE
// debug artifacts", extended: the scenario SUITE is the debugger's front door).
//
// Metrics discipline mirrors the perf strategy (plan §7): counted invariants
// first (deterministic on any machine — any drift vs the committed baseline is
// signal), wall-clock last (soft-compared; this box swings 2-3x). The baseline
// lives in results/baseline.json and is only ever (re)written by the CLI —
// the serve endpoint is read-only (the pull-spine ethic: rendering never mutates).

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sim } from '../../sim/exec.ts'
import { cluster, formed, writes } from '../../sim/harness.ts'
import { converged, drained, confirmedIntact } from '../../sim/monitors.ts'
import { captureSim } from './capture.ts'
import { contested } from './model.mjs'
import { JK } from '../../kernel/journal.ts'
import { Node } from '../../kernel/node.ts'
import { CONFIRM } from '../../kernel/confirm.ts'
import { REC, type Env, type Rec } from '../../kernel/env.ts'
import { VERB, encodeFrame, encodeControl } from '../../kernel/codec.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'results')

//! the frozen /scenarios.json vocabulary — the dashboard renders EXACTLY these shapes
export type Metric = { k: string; v: number | string; kind: 'count' | 'ms' | 'text' }
export type Diagram = {
  nodes: string[]
  mesh?: boolean
  faults?: [string, string][]
  cut?: [string, string][]
  writers?: string[]
  phases: { label: string; sev: 'ok' | 'warn' | 'crit' | 'info' | 'gold' }[]
}
type Outcome = { pass: boolean; notes: string; metrics: Metric[]; capture: unknown }
type Scenario = {
  id: string
  title: string
  kind: 'happy' | 'unhappy' | 'meta'
  desc: string
  diagram: Diagram
  run: () => Outcome
}

//! tally — counted facts straight off the journals: every metric traces to typed events, never a guess
const tally = (sim: Sim) => {
  const t = {
    writes: 0, applied: 0, dups: 0, lwwLost: 0, ae: 0, shed: 0, redials: 0, dupLinks: 0, giveUps: 0, revives: 0,
    proposes: 0, installs: 0, evicts: 0, joins: 0, buffered: 0,
    forwards: 0, acks: 0, nacks: 0, writeDups: 0, relays: 0,
  }
  for (const n of sim.nodes.values())
    for (const e of n.journal.read()) {
      if (e.kind === JK.writeLocal) t.writes++
      else if (e.kind === JK.applyInbound) t.applied++
      else if (e.kind === JK.dupDrop) t.dups++
      else if (e.kind === JK.lwwSkip) t.lwwLost++
      else if (e.kind === JK.aeShip) t.ae += Number(e.b) || 0
      else if (e.kind === JK.dropOldest) t.shed += Number(e.b) || 0
      else if (e.kind === JK.redial) t.redials++
      else if (e.kind === JK.dupLink) t.dupLinks++
      else if (e.kind === JK.giveUp) t.giveUps++
      else if (e.kind === JK.revive) t.revives++
      else if (e.kind === JK.propose) t.proposes++
      else if (e.kind === JK.viewInstall) t.installs++
      else if (e.kind === JK.evict) t.evicts++
      else if (e.kind === JK.join) t.joins++
      else if (e.kind === JK.writeBuffered) t.buffered++
      else if (e.kind === JK.writeForward) t.forwards++
      else if (e.kind === JK.writeAck) t.acks++
      else if (e.kind === JK.writeNack) t.nacks++
      else if (e.kind === JK.writeDup) t.writeDups++
      else if (e.kind === JK.writeRelay) t.relays++
    }
  return t
}

//! failOf — the ONE verdict expression, identical to the sweep CLI's (run.ts): a scenario passes on the same terms a seed does
const failOf = (sim: Sim, nodes: Node[]): string => {
  const v = sim.violations
  return (
    (v.length ? `monitor: ${v[0].monitor} — ${v[0].detail}` : '') ||
    (!formed(nodes) ? 'mesh never fully formed' : '') ||
    (!sim.quiesced ? 'never quiesced' : '') ||
    (converged(sim) ?? '') ||
    (drained(sim) ?? '')
  )
}

//! owner — deterministic key→node routing at the workload layer: the M3 owner-routing story previewed,
// so the happy replication path is SINGLE-WRITER PER KEY and LWW elections simply never happen.
// (Conflicts are not the steady state of this system — they are the `conflict` scenario below.)
const owner = <T>(key: string, nodes: T[]): T =>
  nodes[[...key].reduce((h, c) => h + c.charCodeAt(0), 0) % nodes.length]

const idOf = (i: number, n: number) => `n${String(i).padStart(Math.max(2, String(n).length), '0')}`
const allPairs = (n: number): [string, string][] => {
  const out: [string, string][] = []
  for (let i = 1; i <= n; i++) for (let j = i + 1; j <= n; j++) out.push([idOf(i, n), idOf(j, n)])
  return out
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => idOf(i + 1, n))

//! ── the registry — ordered happy → unhappy → meta (the dashboard renders in this order) ──
export const SCENARIOS: Scenario[] = [
  {
    id: 'formation',
    title: 'Mesh formation — one logical link per pair',
    kind: 'happy',
    desc: 'everyone dials everyone (deliberately redundant); identity-before-admission collapses each dial race to exactly one link per pair, no coordination frame',
    diagram: {
      nodes: ids(3), mesh: true,
      phases: [
        { label: 'dial ×6', sev: 'info' }, { label: 'HELLO', sev: 'info' },
        { label: 'dedup', sev: 'warn' }, { label: 'digest', sev: 'gold' }, { label: 'formed', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(101)
      const nodes = cluster(sim, 3)
      sim.run()
      const t = tally(sim)
      const oneLinkEach = nodes.every((n) => n.admitted().length === 2)
      const fail = failOf(sim, nodes) || (!oneLinkEach ? 'more than one link survived a pair' : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'links/node', v: nodes[0].admitted().length, kind: 'count' },
          { k: 'dup links closed', v: t.dupLinks, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'replication',
    title: 'Owner-routed replication — zero conflicts by design',
    kind: 'happy',
    desc: 'every key has ONE writer (the M3 owner-routing rule, applied at the workload layer) — 30 writes fan out and converge with zero LWW elections',
    diagram: {
      nodes: ids(3), mesh: true, writers: ids(3),
      phases: [
        { label: 'form', sev: 'ok' }, { label: 'write routed', sev: 'gold' },
        { label: 'replicate', sev: 'info' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(202)
      const nodes = cluster(sim, 3)
      sim.run() // form first — this is the steady-state happy path
      for (let i = 0; i < 30; i++) {
        const key = `k${i % 10}`
        const rec: Rec = { type: REC.update, key: [key], value: { n: i, note: `write ${i}` } }
        sim.post(owner(key, nodes).uuid, { kind: 'write', recs: [rec] }, 1 + i * 3)
      }
      sim.run()
      const capture = captureSim(sim)
      const nContested = contested(capture).length
      const t = tally(sim)
      const fail = failOf(sim, nodes) || (nContested > 0 ? `${nContested} contested cells on the single-writer path` : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'applied', v: t.applied, kind: 'count' },
          { k: 'contested', v: nContested, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture,
      }
    },
  },
  {
    id: 'scale-formation',
    title: 'Scale — 100 nodes, 4,950 links, one mesh',
    kind: 'happy',
    desc: '9,900 dials dedup to one link per pair and 100 concurrent writers converge — the sim/scale tier headline at dashboard budget (diagram is a 10-node schematic of the 100; monitors ride SAMPLED via run({checkEvery}) — per-event walks would cost minutes at this width)',
    diagram: {
      nodes: ids(10), mesh: true, writers: ids(10),
      phases: [
        { label: 'dial ×9,900', sev: 'info' }, { label: 'dedup ×4,950', sev: 'warn' },
        { label: 'write ×100', sev: 'gold' }, { label: 'converge ×100', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(0)
      const nodes = cluster(sim, 100)
      writes(sim, nodes, 100, 300)
      sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
      const t = tally(sim)
      const links = nodes.reduce((s, n) => s + n.admitted().length, 0) / 2
      const fail = failOf(sim, nodes) || (links !== 4950 ? `${links}/4950 links survived the dial storm` : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'nodes', v: nodes.length, kind: 'count' },
          { k: 'links', v: links, kind: 'count' },
          { k: 'dup links closed', v: t.dupLinks, kind: 'count' },
          { k: 'applied', v: t.applied, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'scale-genesis',
    title: 'Scale genesis — one ballot, one proposer, 50 members',
    kind: 'happy',
    desc: 'the lowest uuid alone proposes view 1 once its full mesh stands, and ONE ballot commits all 50 members — the single-proposer law the scale tier pins at n=100 (sim/scale.test.ts), sized to the dashboard budget here',
    diagram: {
      nodes: ids(8), mesh: true,
      phases: [
        { label: 'mesh at n01', sev: 'info' }, { label: 'propose ×1', sev: 'gold' },
        { label: 'vote ×49', sev: 'info' }, { label: 'view 1 ×50', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(1)
      const nodes = cluster(sim, 50, { heartbeatMs: 100 })
      sim.run({ until: 1500, checkEvery: 1000, maxEvents: 3_000_000 }) // heartbeats never quiesce — a virtual-time bound
      const t = tally(sim)
      const proposers = nodes.filter((n) => n.journal.read().some((e) => e.kind === JK.propose)).map((n) => n.uuid)
      const fail =
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (!formed(nodes) ? 'mesh never fully formed' : '') ||
        (nodes.some((n) => n.epoch !== 1) ? 'genesis never committed everywhere' : '') ||
        (proposers.join() !== 'n01' ? `proposers [${proposers}] — the single-proposer law broke` : '') ||
        (t.installs !== 50 ? `${t.installs}/50 installs — a node re-installed or missed view 1` : '') ||
        (drained(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'members', v: 50, kind: 'count' },
          { k: 'proposers', v: proposers.length, kind: 'count' },
          { k: 'installs', v: t.installs, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'conflict',
    title: 'Concurrent same-key writes — LWW total order',
    kind: 'unhappy',
    desc: 'all three nodes write the SAME four keys at the same instant (what owner routing exists to prevent) — every node must elect the same winner, deterministically',
    diagram: {
      nodes: ids(3), mesh: true, writers: ids(3),
      phases: [
        { label: 'form', sev: 'ok' }, { label: '3× same key', sev: 'gold' },
        { label: 'LWW election', sev: 'warn' }, { label: 'same winner', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(303)
      const nodes = cluster(sim, 3)
      sim.run()
      for (let k = 0; k < 4; k++)
        for (const n of nodes) {
          const rec: Rec = { type: REC.update, key: [`c${k}`], value: `${n.uuid} claims c${k}` }
          sim.post(n.uuid, { kind: 'write', recs: [rec] }, 1 + k) // same instant per key → genuine concurrency
        }
      sim.run()
      const capture = captureSim(sim)
      const nContested = contested(capture).length
      const t = tally(sim)
      const fail = failOf(sim, nodes) || (nContested !== 4 ? `expected 4 contested cells, saw ${nContested}` : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'contested', v: nContested, kind: 'count' },
          { k: 'lww losses', v: t.lwwLost, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture,
      }
    },
  },
  {
    id: 'race-formation',
    title: 'Writes racing formation — dial-race loss window',
    kind: 'unhappy',
    desc: 'writes issued INSIDE the dial/HELLO/dedup window under dup+delay faults — the adversarial review proved the original kernel lost writes here; digest-on-admit heals it',
    diagram: {
      nodes: ids(3), mesh: true, faults: allPairs(3), writers: ids(3),
      phases: [
        { label: 'dial + write', sev: 'gold' }, { label: 'dup race', sev: 'warn' },
        { label: 'digest sync', sev: 'info' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(17)
      const nodes = cluster(sim, 3)
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
          sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.3 })
      writes(sim, nodes, 25, 40) // deliberately concurrent with formation
      sim.run()
      const t = tally(sim)
      const fail = failOf(sim, nodes)
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'dups dropped', v: t.dups, kind: 'count' },
          { k: 'ae re-shipped', v: t.ae, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'dup-delay-chaos',
    title: 'Duplication + uneven delays — 4-node chaos',
    kind: 'unhappy',
    desc: 'every pair gets its own fault personality (up to 40% duplication, 1-30ms delay spread → reordering across links) — 60 mixed-type writes still converge',
    diagram: {
      nodes: ids(4), mesh: true, faults: allPairs(4), writers: ids(4),
      phases: [
        { label: 'form', sev: 'ok' }, { label: 'write ×60', sev: 'gold' },
        { label: 'dup + delay', sev: 'warn' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(42)
      const nodes = cluster(sim, 4)
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++)
          sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 30], dupP: 0.4 })
      writes(sim, nodes, 60)
      sim.run()
      const t = tally(sim)
      const fail = failOf(sim, nodes)
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'dups dropped', v: t.dups, kind: 'count' },
          { k: 'applied', v: t.applied, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'partition-heal',
    title: 'Partition + heal — tail loss re-shipped',
    kind: 'unhappy',
    desc: 'a write dies IN FLIGHT at the cut, more land on both sides during it — the heal-time digest exchange ships exactly the missing suffixes, both directions',
    diagram: {
      nodes: ids(2), mesh: true, cut: [['n01', 'n02']], writers: ids(2),
      phases: [
        { label: 'form', sev: 'ok' }, { label: 'write', sev: 'gold' }, { label: 'cut', sev: 'crit' },
        { label: 'heal + digest', sev: 'info' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(5)
      const nodes = cluster(sim, 2)
      sim.run()
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['at-cut'], value: 1 }] }, 1)
      sim.at(1, () => sim.partition('n01', 'n02')) // the write's frame is in flight when the cable dies
      sim.at(40, () => sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['during'], value: 2 }] }, 0))
      sim.at(40, () => sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: ['other-side'], value: 3 }] }, 0))
      sim.at(120, () => sim.heal('n01', 'n02'))
      sim.run()
      const t = tally(sim)
      const fail =
        failOf(sim, nodes) ||
        (nodes[1].state.size !== 3 ? `n02 holds ${nodes[1].state.size}/3 cells` : '') ||
        (t.ae === 0 ? 'no anti-entropy shipped — loss was not healed by AE' : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'ae re-shipped', v: t.ae, kind: 'count' },
          { k: 'redials', v: t.redials, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'partition-during-dial',
    title: 'Cut while dialing — no zombie links',
    kind: 'unhappy',
    desc: 'the partition lands while dials are IN FLIGHT (the adversarial-review zombie-link regression) — refused dials must leave nothing behind; backoff redial reconnects after heal',
    diagram: {
      nodes: ids(2), mesh: true, cut: [['n01', 'n02']], writers: ['n01'],
      phases: [
        { label: 'dial', sev: 'info' }, { label: 'cut mid-dial', sev: 'crit' },
        { label: 'backoff', sev: 'warn' }, { label: 'heal', sev: 'ok' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(11)
      const nodes = cluster(sim, 2)
      sim.partition('n01', 'n02') // dials from 'start' are still in flight
      sim.run({ until: 300 })
      const zombie = formed(nodes) || nodes.some((n) => n.links.size > 0)
      sim.heal('n01', 'n02')
      sim.run()
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['after'], value: 1 }] })
      sim.run()
      const t = tally(sim)
      const fail = (zombie ? 'a zombie link survived the refused dial' : '') || failOf(sim, nodes)
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'redials', v: t.redials, kind: 'count' },
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'revival',
    title: 'Give-up + heartbeat revival — parked, not dead',
    kind: 'unhappy',
    desc: 'a peer stays partitioned past every redial attempt (journal-visible give-up); after heal, the heartbeat floor revives the dial — down-long-enough is a cool-down, never permanent',
    diagram: {
      nodes: ids(2), mesh: true, cut: [['n01', 'n02']], writers: ['n01'],
      phases: [
        { label: 'dial ×10', sev: 'info' }, { label: 'give up', sev: 'crit' },
        { label: 'heal', sev: 'ok' }, { label: 'revive', sev: 'gold' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(13)
      const nodes = cluster(sim, 2, { heartbeatMs: 100 })
      sim.partition('n01', 'n02')
      sim.run({ until: 8000 }) // heartbeats never quiesce — every phase runs to a bound
      const gaveUp = nodes.some((n) => n.journal.read().some((e) => e.kind === JK.giveUp))
      sim.heal('n01', 'n02')
      sim.run({ until: 8400 })
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['revived'], value: 1 }] })
      sim.run({ until: 8600 })
      const t = tally(sim)
      const fail =
        (!gaveUp ? 'the redial chain never gave up' : '') ||
        (t.revives === 0 ? 'no revival fired' : '') ||
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (!formed(nodes) ? 'mesh never re-formed after revival' : '') ||
        (converged(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'give-ups', v: t.giveUps, kind: 'count' },
          { k: 'revives', v: t.revives, kind: 'count' },
          { k: 'redials', v: t.redials, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'backpressure',
    title: 'Backpressure overflow — shed, de-sync, re-sync',
    kind: 'unhappy',
    desc: 'a paused link overflows its bounded queue: the WHOLE queue clears (pure tail loss, journal-visible), the link de-syncs, and the drain-time digest exchange re-ships everything',
    diagram: {
      nodes: ids(2), mesh: true, writers: ['n01'],
      phases: [
        { label: 'pause', sev: 'warn' }, { label: 'write ×300', sev: 'gold' }, { label: 'shed', sev: 'crit' },
        { label: 'drain + digest', sev: 'info' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(9)
      const nodes = cluster(sim, 2)
      sim.run()
      const link = [...nodes[0].links.values()].find((l) => l.uuid === 'n02')!
      sim.post('n01', { kind: 'pause', link: link.id })
      sim.run()
      for (let i = 0; i < 300; i++)
        sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] }, i * 0.1)
      sim.run()
      const shedHappened = link.queued.length === 0 && !link.synced
      sim.post('n01', { kind: 'drain', link: link.id })
      sim.run()
      const t = tally(sim)
      const fail =
        (!shedHappened ? 'overflow did not shed+de-sync as specified' : '') ||
        failOf(sim, nodes) ||
        (nodes[1].state.size !== 300 ? `n02 holds ${nodes[1].state.size}/300 cells` : '') ||
        (!link.synced ? 'link never re-synced after drain' : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'shed', v: t.shed, kind: 'count' },
          { k: 'ae re-shipped', v: t.ae, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'scale-overflow',
    title: 'Scale backpressure — 50 queues shed ONCE at fan-out 99',
    kind: 'unhappy',
    desc: 'half of one node’s 99 links pause; a 500-write burst overflows MAX_QUEUED on every paused link — exactly ONE whole-queue drop each (de-sync withholds a second), then 50 simultaneous drains re-teach every shed tail (diagram is a 6-node schematic of the 100)',
    diagram: {
      nodes: ids(6), mesh: true, writers: ['n01'],
      phases: [
        { label: 'form ×100', sev: 'ok' }, { label: 'pause ×50', sev: 'warn' },
        { label: 'burst ×500', sev: 'gold' }, { label: 'shed ×50', sev: 'crit' },
        { label: 'drain + converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(2)
      const nodes = cluster(sim, 100)
      sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
      const paused = [...nodes[0].links.values()].sort((a, b) => (a.uuid < b.uuid ? -1 : 1)).slice(0, 50)
      for (const l of paused) sim.post('n001', { kind: 'pause', link: l.id })
      sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
      for (let i = 0; i < 500; i++) sim.post('n001', { kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] }, i * 0.1)
      sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
      const drops = nodes[0].journal.read().filter((e) => e.kind === JK.dropOldest).length
      for (const l of paused) sim.post('n001', { kind: 'drain', link: l.id }, 0)
      sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
      const t = tally(sim)
      const fail =
        failOf(sim, nodes) ||
        (drops !== 50 ? `${drops} whole-queue drops for 50 paused links — the one-drop law broke` : '') ||
        (paused.some((l) => !l.synced) ? 'a drained link never re-latched synced' : '') ||
        (nodes[99].state.size !== 500 ? `n100 holds ${nodes[99].state.size}/500 cells` : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'paused links', v: 50, kind: 'count' },
          { k: 'whole-queue drops', v: drops, kind: 'count' },
          { k: 'records shed', v: t.shed, kind: 'count' },
          { k: 'ae re-shipped', v: t.ae, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'eviction',
    title: 'Eviction + rejoin — membership through real ballots',
    kind: 'unhappy',
    desc: 'a node cut off past every redial is evicted by joint-consensus ballot; the CP gate buffers its writes; on heal it learns its eviction, JOINs back, and its buffer flushes — M2 end-to-end',
    diagram: {
      nodes: ids(3), mesh: true, cut: [['n01', 'n03'], ['n02', 'n03']], writers: ['n01', 'n03'],
      phases: [
        { label: 'view 1', sev: 'info' }, { label: 'cut', sev: 'crit' }, { label: 'evict ballot', sev: 'warn' },
        { label: 'CP buffer', sev: 'gold' }, { label: 'rejoin + flush', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(52)
      const nodes = cluster(sim, 3, { heartbeatMs: 50 })
      sim.run({ until: 400 })
      sim.partition('n01', 'n03')
      sim.partition('n02', 'n03')
      sim.run({ until: 5500 })
      const evicted = nodes[0].epoch === 2 && nodes[2].epoch === 1
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['majority-write'], value: 1 }] })
      sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['minority-write'], value: 2 }] })
      sim.run({ until: 5700 })
      const gated = nodes[2].writes.pending.size === 1 && !nodes[2].state.has(JSON.stringify(['minority-write']))
      sim.heal('n01', 'n03')
      sim.heal('n02', 'n03')
      sim.run({ until: 9000 })
      const t = tally(sim)
      const fail =
        (!evicted ? 'the eviction view never committed on the majority side' : '') ||
        (!gated ? 'the CP gate failed to buffer the minority write' : '') ||
        (nodes.some((n) => n.epoch !== 3) ? `rejoin view did not commit everywhere (epochs ${nodes.map((n) => n.epoch)})` : '') ||
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (converged(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'views committed', v: t.installs, kind: 'count' },
          { k: 'evictions', v: t.evicts, kind: 'count' },
          { k: 'joins', v: t.joins, kind: 'count' },
          { k: 'writes buffered', v: t.buffered, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'split-brain',
    title: 'Split-brain impossibility — 2-2 commits nothing',
    kind: 'unhappy',
    desc: 'a symmetric partition of four: neither side reaches joint majority, so NO view commits and both sides buffer under the CP gate; heal flushes both — one view, one history',
    diagram: {
      nodes: ids(4), mesh: true,
      cut: [['n01', 'n03'], ['n01', 'n04'], ['n02', 'n03'], ['n02', 'n04']], writers: ['n01', 'n03'],
      phases: [
        { label: 'view 1', sev: 'info' }, { label: '2-2 cut', sev: 'crit' }, { label: 'both gate', sev: 'warn' },
        { label: 'heal + flush', sev: 'gold' }, { label: 'one view', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(53)
      const nodes = cluster(sim, 4, { heartbeatMs: 50 })
      sim.run({ until: 500 })
      for (const a of ['n01', 'n02']) for (const b of ['n03', 'n04']) sim.partition(a, b)
      sim.run({ until: 1500 })
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['left'], value: 'L' }] })
      sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['right'], value: 'R' }] })
      sim.run({ until: 1700 })
      const bothGated = nodes[0].writes.pending.size === 1 && nodes[2].writes.pending.size === 1
      for (const a of ['n01', 'n02']) for (const b of ['n03', 'n04']) sim.heal(a, b)
      sim.run({ until: 3500 })
      const t = tally(sim)
      const fail =
        (!bothGated ? 'a minority side committed instead of buffering' : '') ||
        (nodes.some((n) => n.epoch !== 1) ? `a view committed across the split (epochs ${nodes.map((n) => n.epoch)})` : '') ||
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (converged(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'views committed', v: t.installs - 4, kind: 'count' }, // beyond the 4 genesis installs: MUST be 0
          { k: 'writes buffered', v: t.buffered, kind: 'count' },
          { k: 'ae re-shipped', v: t.ae, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'write-pipeline',
    title: 'The write pipeline — kernel owner routing (M3)',
    kind: 'happy',
    desc: 'writes land on random nodes; the KERNEL routes each to its ring owner over the committed view — forwarded attempts, ACKed coordinates, one origin per partition per epoch, zero contested cells',
    diagram: {
      nodes: ids(3), mesh: true, writers: ids(3),
      phases: [
        { label: 'view 1', sev: 'info' }, { label: 'write anywhere', sev: 'gold' },
        { label: 'forward → owner', sev: 'info' }, { label: 'stamp + ACK', sev: 'gold' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(71)
      const nodes = cluster(sim, 3, { heartbeatMs: 50 })
      sim.run({ until: 400 }) // genesis: view 1 committed by ballot
      for (let i = 0; i < 30; i++) {
        const rec: Rec = { type: REC.update, key: [`k${i % 10}`], value: { n: i, note: `write ${i}` } }
        sim.post(nodes[i % 3].uuid, { kind: 'write', recs: [rec] }, 450 + i * 10)
      }
      sim.run({ until: 2000 })
      const capture = captureSim(sim)
      const nContested = contested(capture).length
      const t = tally(sim)
      const stuck = nodes.reduce((s, n) => s + n.writes.pending.size, 0)
      const fail =
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (nodes.some((n) => n.epoch !== 1) ? 'genesis view never committed' : '') ||
        (stuck ? `${stuck} attempts never ACKed` : '') ||
        (nContested > 0 ? `${nContested} contested cells on the kernel-routed path` : '') ||
        (converged(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: t.writes, kind: 'count' },
          { k: 'forwarded', v: t.forwards, kind: 'count' },
          { k: 'acked runs', v: t.acks, kind: 'count' },
          { k: 'contested', v: nContested, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture,
      }
    },
  },
  {
    id: 'lost-ack',
    title: 'Lost ACK — cid dedup, original coordinates (AA #1)',
    kind: 'unhappy',
    desc: 'the owner commits but its ACK dies with the link (v2\'s dominant conflict source: the forwarder then self-committed a second origin) — v3 retries, the owner dedups by cid, and the duplicate ACK re-carries the ORIGINAL commit coordinates',
    diagram: {
      nodes: ids(3), mesh: true, faults: [['n01', 'n02']], writers: ['n01'],
      phases: [
        { label: 'forward', sev: 'info' }, { label: 'commit', sev: 'gold' },
        { label: 'ACK dies', sev: 'crit' }, { label: 'retry → dedup', sev: 'warn' }, { label: 'once', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(61)
      const nodes = cluster(sim, 3, { heartbeatMs: 50 })
      sim.run({ until: 400 })
      for (const n of nodes) n.writes.ring.place('hot', 'n02')
      sim.severOnFrame('n02', 'n01', VERB.WACK)
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['hot'], value: 'exactly-once' }] })
      sim.run({ until: 3000 })
      const t = tally(sim)
      const committed = nodes[1].logs.get('n02')?.filter((e) => e.rec.key[0] === 'hot').length ?? 0
      //! the route completes by EITHER path: replication-as-ACK (the committed record carries its
      // attempt identity back to the issuer) or the tick-clock retransmit hitting the dedup window
      const acked = nodes[0].journal.read().filter((e) => e.kind === JK.writeAck).length
      const fail =
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (committed !== 1 ? `the write committed ${committed} times (must be exactly 1)` : '') ||
        (acked < 1 ? 'the issuer never observed the commit (no replication-ACK, no duplicate WACK)' : '') ||
        (nodes[0].writes.pending.size ? 'the issuer never cleared its attempt' : '') ||
        (nodes[0].logs.get('n01') ? 'the issuer self-committed — the v2 fallback is supposed to be deleted' : '') ||
        (converged(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'commits', v: committed, kind: 'count' },
          { k: 'acks observed', v: acked, kind: 'count' },
          { k: 'forwards', v: t.forwards, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'parked-flush',
    title: 'Parked flush re-validates — owner-routed, never local (AA #3/#4)',
    kind: 'unhappy',
    desc: 'a minority node parks a write for a partition it does not own; on heal the flush RE-RESOLVES ownership and forwards — v2 re-stamped it locally at the current epoch (a second origin); v3\'s flushed record carries the owner\'s origin',
    diagram: {
      nodes: ids(3), mesh: true, cut: [['n01', 'n03'], ['n02', 'n03']], writers: ['n03', 'n01'],
      phases: [
        { label: 'cut → park', sev: 'crit' }, { label: 'owner writes', sev: 'info' },
        { label: 'heal', sev: 'ok' }, { label: 'flush → forward', sev: 'gold' }, { label: 'one origin', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(64)
      const nodes = cluster(sim, 3, { heartbeatMs: 50 })
      sim.run({ until: 400 })
      for (const n of nodes) n.writes.ring.place('shared', 'n01')
      sim.partition('n01', 'n03')
      sim.partition('n02', 'n03')
      sim.run({ until: 600 })
      sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['shared'], value: 'parked' }] })
      sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['shared'], value: 'owner-value' }] }, 100)
      sim.run({ until: 2000 })
      const parked = nodes[2].writes.pending.size === 1
      sim.heal('n01', 'n03')
      sim.heal('n02', 'n03')
      sim.run({ until: 6000 })
      const t = tally(sim)
      const atOwner = nodes[0].logs.get('n01')?.filter((e) => e.rec.key[0] === 'shared').length ?? 0
      const fail =
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} — ${sim.violations[0].detail}` : '') ||
        (!parked ? 'the minority write did not park' : '') ||
        (atOwner !== 2 ? `owner log holds ${atOwner} 'shared' records (want both writes)` : '') ||
        (nodes[2].logs.get('n03') ? 'the parked write was stamped locally — the AA #3 shape' : '') ||
        (converged(sim) ?? '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'parked', v: t.buffered, kind: 'count' },
          { k: 'flushed via owner', v: atOwner, kind: 'count' },
          { k: 'forwards', v: t.forwards, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'restore',
    title: 'Kill \u22129 the whole cluster \u2014 restore from WALs alone (M4)',
    kind: 'unhappy',
    desc: 'durable mode: writes fsync to per-node WALs, tails are CONFIRMED at the persisted level, then every node dies at once \u2014 three directories are all that remain. Boot records re-form the view (the rejoin self-ballot), replay refolds the logs, and zero persisted-confirmed writes may be lost',
    diagram: {
      nodes: ids(3), mesh: true, writers: ids(3),
      phases: [
        { label: 'write + fsync', sev: 'gold' }, { label: 'confirm \u2713', sev: 'gold' },
        { label: 'kill \u22129 \u00d73', sev: 'crit' }, { label: 'replay WALs', sev: 'info' }, { label: 'converge', sev: 'ok' },
      ],
    },
    run() {
      const sim = new Sim(90)
      cluster(sim, 3, { heartbeatMs: 50, durable: true })
      sim.run({ until: 400 })
      const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
      for (let i = 0; i < 18; i++)
        sim.at(50 + i * 20, () => sim.post(`n0${1 + (i % 3)}`, { kind: 'write', recs: [{ type: REC.update, key: [`${names[i % 6]}${i}`], value: { n: i } }] }))
      sim.run({ until: 1600 })
      const written = [...sim.nodes.get('n01')!.logs.values()].reduce((s, es) => s + es.length, 0)
      //! confirm every origin's tail at the PERSISTED level \u2014 the only rung that promises majority-crash survival
      let id = 0
      for (const [origin, entries] of sim.nodes.get('n01')!.logs)
        sim.post('n01', { kind: 'confirm', id: ++id, origin, seq: entries[entries.length - 1].seq, level: CONFIRM.persisted })
      sim.run({ until: 2400 })
      const confirmed = [...sim.confirms.values()].filter((c) => c.ok === true).length
      //! the kill: all three at once \u2014 in-flight fsync batches tear, nothing is flushed
      for (const u of [...sim.nodes.keys()]) sim.restart(u)
      sim.run({ until: 14000 })
      const live = [...sim.nodes.values()]
      const replayed = live.reduce((s, n) => s + n.journal.read().filter((e) => e.kind === JK.replayed).reduce((x, e) => x + (Number(e.a) || 0), 0), 0)
      const fail =
        (sim.violations.length ? `monitor: ${sim.violations[0].monitor} \u2014 ${sim.violations[0].detail}` : '') ||
        (confirmed !== id ? `${confirmed}/${id} probes confirmed pre-crash` : '') ||
        (!formed(live) ? 'mesh did not re-form from the boot records' : '') ||
        (converged(sim) ?? '') ||
        (confirmedIntact(sim, CONFIRM.persisted) ?? '') ||
        (live.some((n) => !n.membership.gate(n).open) ? 'gate closed after restore' : '')
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'writes', v: written, kind: 'count' },
          { k: 'confirmed persisted', v: confirmed, kind: 'count' },
          { k: 'rows replayed', v: replayed, kind: 'count' },
          { k: 'events', v: sim.events, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'wire',
    title: 'Wire invariants — counted, pinned',
    kind: 'meta',
    desc: 'the perf strategy in one card: bytes-per-record pinned EXACTLY, frames-per-burst counted exactly — deterministic on any machine, so any drift vs baseline is a real wire change',
    diagram: {
      nodes: ['a', 'b'], mesh: true, writers: ['a'],
      phases: [
        { label: 'encode', sev: 'info' }, { label: 'frame + crc', sev: 'gold' },
        { label: 'decode', sev: 'info' }, { label: 'verify', sev: 'ok' },
      ],
    },
    run() {
      //! the canonical record from codec.perf.ts — the SAME pin, surfaced on the dashboard
      const frame = encodeFrame(
        [{ type: REC.update, key: ['key1', 'field'], value: { n: 1, s: 'value-1', ok: true } }],
        { origin: 'origin-1', baseSeq: 1, epoch: 0 },
      )
      //! frames-per-burst: a formed 3-peer node must emit exactly one frame per peer per write burst
      let frames = 0
      const env: Env = {
        now: () => 0, rng: () => 0.5,
        sink: { connect() {}, send() { frames++ }, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {} },
      }
      const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
      for (let p = 0; p < 3; p++) {
        node.step({ kind: 'linkUp', link: p + 1, dialed: true, to: `x:${p + 2}` })
        node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.HELLO, { u: `p${p}`, i: 1, l: `x:${p + 2}` }) })
        node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
      }
      frames = 0
      node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
      const fail =
        (frame.length !== 73 ? `canonical record frame is ${frame.length}B (pinned 73B)` : '') ||
        (frames !== 3 ? `write burst produced ${frames} frames for 3 peers` : '')
      //! the click-through capture: a minimal clean 2-node run, so the card opens to a readable timeline
      const sim = new Sim(1)
      const nodes = cluster(sim, 2)
      for (let i = 0; i < 5; i++)
        sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`w${i}`], value: i }] }, 5 + i)
      sim.run()
      return {
        pass: !fail, notes: fail,
        metrics: [
          { k: 'bytes/record', v: frame.length, kind: 'count' },
          { k: 'frames/burst (3 peers)', v: frames, kind: 'count' },
        ],
        capture: captureSim(sim),
      }
    },
  },
  {
    id: 'sweep',
    title: 'Seed sweep — 100 chaotic trajectories',
    kind: 'meta',
    desc: 'the full CLI recipe at dashboard scale: per-pair fault personalities, writes racing formation, a partition/heal window on odd seeds — every seed must form, converge, and drain',
    diagram: {
      nodes: ids(3), mesh: true, faults: allPairs(3), cut: [['n01', 'n03']], writers: ids(3),
      phases: [
        { label: '×100 seeds', sev: 'info' }, { label: 'race + cut', sev: 'crit' },
        { label: 'heal', sev: 'ok' }, { label: 'converge ×100', sev: 'ok' },
      ],
    },
    run() {
      const SEEDS = 100
      let green = 0
      let events = 0
      let firstFail: { sim: Sim; why: string } | null = null
      let last: Sim | null = null
      const t0 = performance.now()
      for (let seed = 0; seed < SEEDS; seed++) {
        const sim = new Sim(seed)
        const nodes = cluster(sim, 3)
        for (let i = 0; i < 3; i++)
          for (let j = i + 1; j < 3; j++)
            sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
        writes(sim, nodes, 40)
        if (seed % 2) {
          const a = nodes[Math.floor(sim.rng() * nodes.length)].uuid
          let b = a
          while (b === a) b = nodes[Math.floor(sim.rng() * nodes.length)].uuid
          const cut = 20 + sim.rng() * 150
          sim.at(cut, () => sim.partition(a, b))
          sim.at(cut + 30 + sim.rng() * 250, () => sim.heal(a, b))
        }
        sim.run()
        events += sim.events
        const fail = failOf(sim, nodes)
        if (fail) { if (!firstFail) firstFail = { sim, why: fail } } else green++
        last = sim
      }
      const wall = performance.now() - t0
      //! a failing seed's capture wins the click-through (triage first); else the last seed's (a representative chaotic run)
      const shown = firstFail ? firstFail.sim : last!
      return {
        pass: green === SEEDS,
        notes: firstFail ? `seed ${firstFail.sim.seed}: ${firstFail.why} (capture shown)` : '',
        metrics: [
          { k: 'seeds', v: `${green}/${SEEDS}`, kind: 'text' },
          { k: 'events', v: events, kind: 'count' },
          { k: 'events/s', v: Math.round(events / (wall / 1000)), kind: 'ms' },
        ],
        capture: captureSim(shown),
      }
    },
  },
]

//! ── the runner: results JSON (the /scenarios.json contract) + per-scenario captures ──
export const runAll = () => {
  let rev = '—'
  try { rev = execSync('git rev-parse --short HEAD', { cwd: HERE }).toString().trim() } catch {}
  const baseline = existsSync(join(RESULTS, 'baseline.json'))
    ? JSON.parse(readFileSync(join(RESULTS, 'baseline.json'), 'utf8'))
    : null
  const baseFor = (id: string): Record<string, number | string> | null => {
    const s = baseline?.scenarios?.find((x: { id: string }) => x.id === id)
    return s ? Object.fromEntries(s.metrics.map((m: Metric) => [m.k, m.v])) : null
  }
  const captures = new Map<string, unknown>()
  const t0 = performance.now()
  const scenarios = SCENARIOS.map((s) => {
    const st = performance.now()
    let out: Outcome
    try { out = s.run() }
    catch (e) { out = { pass: false, notes: `threw: ${e}`, metrics: [], capture: null } } // a throwing scenario reports; the rest still run
    const wallMs = Math.round(performance.now() - st)
    if (out.capture) captures.set(s.id, out.capture)
    return {
      id: s.id, title: s.title, kind: s.kind, desc: s.desc, diagram: s.diagram,
      pass: out.pass, notes: out.notes,
      metrics: [...out.metrics, { k: 'wall ms', v: wallMs, kind: 'ms' as const }],
      base: baseFor(s.id),
    }
  })
  const results = {
    rev,
    when: new Date().toISOString(),
    wallMs: Math.round(performance.now() - t0),
    pass: scenarios.filter((s) => s.pass).length,
    total: scenarios.length,
    baseline: baseline ? { rev: baseline.rev, when: baseline.when } : null,
    scenarios,
  }
  return { results, captures }
}

//! CLI: `npm run scenarios` — print the table, write results/latest.json; first run (or --rebase) also pins the baseline.
if (process.argv[1] && process.argv[1].endsWith('scenarios.ts')) {
  const { results } = runAll()
  for (const s of results.scenarios) {
    const counted = s.metrics.filter((m) => m.kind !== 'ms').map((m) => `${m.k} ${m.v}`).join(' · ')
    console.log(`${s.pass ? '✓' : '✗'} ${s.id.padEnd(22)} ${counted}${s.notes ? `\n    ${s.notes}` : ''}`)
  }
  console.log(`\n${results.pass}/${results.total} scenarios · rev ${results.rev} · ${results.wallMs}ms`)
  mkdirSync(RESULTS, { recursive: true })
  writeFileSync(join(RESULTS, 'latest.json'), JSON.stringify(results, null, 1))
  if (!existsSync(join(RESULTS, 'baseline.json')) || process.argv.includes('--rebase')) {
    writeFileSync(join(RESULTS, 'baseline.json'), JSON.stringify(results, null, 1))
    console.log(`baseline pinned at rev ${results.rev} → tools/debug/results/baseline.json`)
  }
  if (results.pass !== results.total) process.exit(1)
}
