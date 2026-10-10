//! The adversarial leave harness (DESIGN-LEAVE §9 step 2, 2026-10-10): the generators the three I-20 reviews found
// their holes with, rebuilt in-tree and ROOT-free from the reports' descriptions, so the base's numbers are a FLOOR
// and every later "never worse than the base" is a diff of two runs. A plain module, not a test: sim/leave-harness.test.ts
// imports it and asserts; a scratch script can import it to run another tree's kernel or more seeds.
//
// The families, each named after the reviewer's generator (DESIGN-LEAVE §8.1 names them):
//   rebirth   — the round-2 re-check's `sweep2`: random cuts and heals between pairs during the leave window, and
//               leavers reborn FRESH as NEW identities (`n0Xr`: a new process without a dir is a new uuid, V4-2/V4-3),
//               on a memory-only cluster. Plus, as fixed schedules: the reviewer's seed 157 (H7) and the round-1
//               re-check's n=3 two-stop pair (H3), and the three seeds of THIS generator that today's kernel heals
//               and the parked branch wedges (306, 744, 804: H9's class, measured on both kernels).
//   isolate   — the round-3 re-check's `isolate`: the proposer (n01, the lowest member) cut from everyone a few ms
//               after one or two non-lowest members stop; the leavers time out, are torn down and restarted FROM
//               THEIR DIRS on the other side of the cut, next to a stayer that never saw a commit. The fixed 108-
//               schedule grid the report counted (n 3..5 × one or two leavers × 5/10/30 ms × 0.3/1.5/5 s × 2 seeds),
//               the two pins `evictsplit` (n=3) and `joinsplit` (n=3 plus a joiner through n01), and a seeded
//               variant with slow links and a joiner drawn by the seed — the family the reviewer asked for (H11).
//   pledgeTwo — the shape the RESTRICTED pledge cannot answer (DESIGN-LEAVE §10.3, the 2026-10-10 review): the
//               proposer keeps ONE stayer, the other stayer is cut off holding links to TWO leavers, and the leavers
//               restart on the stale side. A stayer's gate counts any admitted member link (kernel/membership.ts
//               gate), a read-only leaver's included — so two pledges plus one stayer's grant commit the view
//               minus the leavers at n01 while n03 is writable at the old view with the leavers' links: a split.
//               Today's kernel counts no knock as a vote: its ballot (the view minus the FIRST leaver it read, the
//               second knock is ignored while a ballot is in flight) has its own vote and n02's, two of the five it
//               needs, and commits nothing. The cut must come the instant n01 has read both knocks: 3 ms later the
//               VOTEs already in flight land, both kernels commit a four-member view at 2, and the family has no
//               teeth (the second review).
//   evictTwo,
//   evictTwoB — the base's own hole (DESIGN-LEAVE §10.2): a ballot that evicts two suspects at once at n=5, with the
//               third voter cut or crashed on its grant. In evictTwoB the voter that keeps the old view and a vote
//               above it is NOT the far side's lowest member, so the far side is led by a node that never voted, and
//               the stale voter GRANTS that higher ballot: "lead nothing" never fires, the vote is spent again.
//   crash     — the round-3 re-check's `crash2`: one stayer CRASHES at an offset from one or two clean stops (before,
//               at, just after), comes back from its dir after 2 s or never; the leavers time out and are restarted
//               from their dirs after 0.4, 3 or 25 s. The 24 n=3 "crash twin" cases live here (H12).
//   explorer  — sim/mesh.ts's random explorer over real Nodes with the quiet-point writable-split check on (the
//               round-2 re-check's "end-state check" variant), over its own seed range.
// What every family checks (sim/leave-sweep.ts): SAFETY — no monitor fired and no two nodes end WRITABLE in
// different views at a quiet point (the invariant DESIGN-LEAVE §9 names; one-view-per-epoch alone misses a stale
// majority writable at a lower epoch beside the view without it). LIVENESS is counted, never asserted as "all".
import { Sim } from './exec.ts'
import { cluster } from './harness.ts'
import { verdict, split } from './leave-sweep.ts'
import { explore } from './mesh.ts'
import { JK } from '../kernel/journal.ts'
import { VERB } from '../kernel/codec.ts'
import type { Node } from '../kernel/node.ts'
import type { NodeOpts } from '../kernel/node.ts'

const mul = (seed: number) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const members = (x: Node) => x.membership.view.members.map((m) => m[0])
const pairKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a)
//! the opts cluster() gives a member, for a FRESH rebirth: a new process without a dir is a NEW identity (V4-2/V4-3: a
// bare restart is a new uuid; the same uuid without its vote on disk is the double-vote fero refuses to allow), so
// the reborn leaver is `n0Xr` — sorted right after the uuid it replaces, dialing every original member
export const rebornId = (u: string) => `${u}r`
const freshOpts = (u: string, ids: string[]): NodeOpts => ({ uuid: rebornId(u), listen: `sim:${rebornId(u)}`, hosts: ids.filter((o) => o !== u).map((o) => `sim:${o}`), heartbeatMs: 50, durable: false, redialMs: 20, journalCap: 1 << 16 })
//! tearDown — what the shell does on `left`: every link dies at once. The node stays in the sim when it will be
// restarted from its dir (sim.restart needs it), and is destroyed when it never comes back.
const tearDown = (sim: Sim, u: string, keep: boolean) => {
  for (const o of sim.nodes.keys()) if (o !== u) sim.partition(u, o)
  if (!keep) { sim.nodes.get(u)!.destroy(); sim.nodes.delete(u) }
}
//! has — a journal row of that kind, optionally matching `a`
const has = (x: Node, kind: number, a?: unknown) => x.journal.read().some((e) => e.kind === kind && (a === undefined || e.a === a))

// ── rebirth: cuts and heals between pairs, leavers reborn fresh as new identities (the round-2 `sweep2`) ──
export interface ScheduleR { seed: number; n: number; ids: string[]; leavers: string[]; delay: [string, string, number][]; cuts: [string, string, number, number][]; offsets: number[]; reborn: number[] }

export const scheduleR = (seed: number): ScheduleR => {
  const r = mul(seed * 48271 + 5)
  const n = 2 + Math.floor(r() * 4)
  const k = 1 + Math.floor(r() * Math.min(3, n - 1))
  const ids = Array.from({ length: n }, (_, i) => `n0${i + 1}`)
  const leavers = [...ids].sort(() => r() - 0.5).slice(0, k).sort()
  const delay: [string, string, number][] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) delay.push([ids[i], ids[j], pick(r, [3, 3, 3, 20, 60])])
  const cuts: [string, string, number, number][] = []
  const nc = Math.floor(r() * 3)
  for (let c = 0; c < nc; c++) { const a = pick(r, ids); const b = pick(r, ids.filter((x) => x !== a)); cuts.push([a, b, pick(r, [0, 0, 20, 80, 150]), pick(r, [100, 300, 600, 1500])]) }
  const offsets = leavers.map(() => pick(r, [0, 0, 0, 30, 120]))
  const reborn = leavers.map(() => (r() < 0.4 ? pick(r, [100, 500, 1500]) : -1))
  return { seed, n, ids, leavers, delay, cuts, offsets, reborn }
}

//! the shapes the reports name, as fixed schedules. The sim seed drives the redial jitter only: seed 157's shape has
// slow links and a cut, so ten sim seeds give seven distinct runs; the two n=3 shapes have neither, so each is ONE
// deterministic schedule whatever the seed (612 events on every seed), and the test runs each once.
// Seed 157 of the reviewer's generator (H7) is here; its seeds 469, 740 and 1077 (H9) are not: the reports do not say
// which links were slow or how long one cut lasted, and the three rebuilds wedged on the base for the known pair-cut
// reason, so they would pin nothing the reviewer measured. H9's class is pinned by H9_SEEDS below instead.
export const NAMED_R: Record<string, Omit<ScheduleR, 'seed'>> = {
  //! seed 157: n=5; n05 stops, 120 ms later n01 (the lowest) and n04 stop; a 60 ms n01-n02 link; n01-n05 cut for 600 ms
  'r2-157': { n: 5, ids: ['n01', 'n02', 'n03', 'n04', 'n05'], leavers: ['n01', 'n04', 'n05'], delay: [['n01', 'n02', 60]], cuts: [['n01', 'n05', 0, 600]], offsets: [120, 120, 0], reborn: [-1, -1, -1] },
  //! the round-1 re-check's n=3 wedge (H3): two clean stops at once, no cuts, no stalls — just Ctrl-C on two of three
  'r1-n3-two-stops': { n: 3, ids: ['n01', 'n02', 'n03'], leavers: ['n02', 'n03'], delay: [], cuts: [], offsets: [0, 0], reborn: [-1, -1] },
  'r1-n3-lowest-too': { n: 3, ids: ['n01', 'n02', 'n03'], leavers: ['n01', 'n02'], delay: [], cuts: [], offsets: [0, 0], reborn: [-1, -1] },
}
export const namedR = (name: string, seed: number): ScheduleR => ({ seed, ...NAMED_R[name] })
//! H9_SEEDS — the three seeds of scheduleR, outside the pinned 1..100, that today's kernel heals and the round-3
// kernel (6de8eee) wedges, measured on both (the 2026-10-10 review): 306 is n=4 with two leavers (n01, n02); 744 and
// 804 are n=5 with leavers n02, n04, n05. The reports' 469/740/1077 class (n=4, three leavers, the lowest among them)
// is a different shape; these are the branch-only losses THIS generator draws. Pinned LIVE, so the branch's kernel
// turns them red.
export const H9_SEEDS = [306, 744, 804]

//! runR — one rebirth schedule to its horizon. A leaver is torn down the moment its leave is answered (cut from
// everyone, destroyed) and, when asked to, comes back `reborn` ms later as a FRESH node (a new identity, rebornId):
// it dials the others, learns the view on admit and knocks JOIN. The reviewer's generator reborn the same uuid; the
// sim's epoch-monotone monitor would fire on that (epoch 0 again under one id), and fero itself never does it. A cut
// still open at the leaver's teardown stays open for it (the round-3 finding on family 2: healing everything on a
// restart hides the shape); the reborn identity has no cuts.
export const runR = (s: ScheduleR, horizon = 20000): string[] => {
  const sim = new Sim(s.seed)
  const nodes = cluster(sim, s.n, { heartbeatMs: 50, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  for (const [a, b, d] of s.delay) sim.fault(a, b, { delay: [d, d] })
  const gone = new Map<string, number>(), back = new Set<string>()
  const down = (u: string) => gone.has(u) && !back.has(u)
  const open = new Map<string, number>() // pair → the virtual time its cut ends
  const t0 = sim.now
  for (const [a, b, at, dur] of s.cuts) {
    open.set(pairKey(a, b), Math.max(open.get(pairKey(a, b)) ?? 0, t0 + at + dur))
    sim.at(at, () => sim.partition(a, b))
    sim.at(at + dur, () => { if (!down(a) && !down(b) && (open.get(pairKey(a, b)) ?? 0) <= sim.now) sim.heal(a, b) })
  }
  s.leavers.forEach((u, i) => sim.post(u, { kind: 'leave' }, s.offsets[i]))
  let last = t0 + Math.max(0, ...s.cuts.map((c) => c[2] + c[3]))
  for (let t = sim.now; t <= t0 + horizon; t += 5) {
    sim.run({ until: t })
    s.leavers.forEach((u, i) => {
      if (!gone.has(u) && sim.left.has(u) && sim.nodes.has(u)) {
        tearDown(sim, u, false)
        gone.set(u, sim.now); last = Math.max(last, sim.now)
      }
      if (gone.has(u) && !back.has(u) && s.reborn[i] >= 0 && sim.now >= gone.get(u)! + s.reborn[i]) {
        back.add(u)
        sim.add(freshOpts(u, s.ids))
        sim.post(rebornId(u), { kind: 'start' })
        last = Math.max(last, sim.now)
      }
    })
    if (gone.size === s.leavers.length && s.leavers.every((u, i) => s.reborn[i] < 0 || back.has(u)) && sim.now > last + 9000) break
  }
  if (gone.size !== s.leavers.length) return ['leaver never answered: ' + s.leavers.filter((u) => !gone.has(u))]
  return verdict(sim, [...s.ids.filter((u) => !s.leavers.includes(u)), ...[...back].map(rebornId)].sort())
}
export const shapeR = (s: ScheduleR) => `${s.seed} n=${s.n} leavers=${s.leavers} cuts=${JSON.stringify(s.cuts)} reborn=${s.reborn} offsets=${s.offsets} slow=${s.delay.filter((d) => d[2] > 3).map((d) => d.join(':')).join(',')}`

// ── isolate: the proposer cut off while the leavers restart from their dirs beside a stale stayer (the round-3 `isolate`) ──
export interface ScheduleI { seed: number; n: number; leavers: string[]; isolateMs: number; backMs: number; join: boolean; delay: [string, string, number][]; horizon: number }

//! GRID_I — the 108 schedules the round-3 report counted: n 3..5; one leaver (the highest member) or two (the two
// highest); n01 isolated 5, 10 or 30 ms after the stops; the leavers back from their dirs 0.3, 1.5 or 5 s after
// their teardown, healed to everyone but n01; sim seeds 1 and 2
export const GRID_I: ScheduleI[] = []
for (const n of [3, 4, 5]) for (const two of [false, true]) for (const isolateMs of [5, 10, 30]) for (const backMs of [300, 1500, 5000]) for (const seed of [1, 2]) {
  const ids = Array.from({ length: n }, (_, i) => `n0${i + 1}`)
  GRID_I.push({ seed, n, leavers: two ? ids.slice(-2) : ids.slice(-1), isolateMs, backMs, join: false, delay: [], horizon: 12000 })
}
//! scheduleI — the seeded variant: n 3..5, one to n-2 non-lowest leavers (a stayer always remains), the proposer
// isolated 3..60 ms after the stops, the leavers back after 0.2..5 s, slow links, and a joiner through n01 one time in
// three (the join shape of H11)
export const scheduleI = (seed: number): ScheduleI => {
  const r = mul(seed * 7177 + 29)
  const n = 3 + Math.floor(r() * 3)
  const ids = Array.from({ length: n }, (_, i) => `n0${i + 1}`)
  const k = 1 + Math.floor(r() * (n - 2))
  const leavers = ids.slice(1).sort(() => r() - 0.5).slice(0, k).sort()
  const delay: [string, string, number][] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (r() < 0.3) delay.push([ids[i], ids[j], pick(r, [20, 40, 60])])
  return { seed, n, leavers, isolateMs: pick(r, [3, 5, 10, 30, 60]), backMs: pick(r, [200, 300, 800, 1500, 5000]), join: r() < 0.33, delay, horizon: 12000 }
}

//! inspect — an optional look at the sim before the verdict (a tracer's door; the test never passes one)
export interface OutcomeI { problems: string[]; settled: boolean; proposerWritable: boolean }
//! runI — one isolate schedule. Safety is what matters: at the horizon, with n01 still cut off, no two nodes may be
// writable in different views. `settled` records liveness on the far side: every node but n01 in one view without
// n01, writable (n01 itself is read-only in a minority, or writable alone — which, beside a settled far side, IS
// the split). The joiner, when drawn, dials n01 only, 60 ms before the stops, so n01 opens the join ballot first, and
// it is cut with n01: a joiner on the far side would carry n01's view across.
export const runI = (s: ScheduleI, inspect?: (sim: Sim) => void): OutcomeI => {
  const sim = new Sim(s.seed)
  const nodes = cluster(sim, s.n, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return { problems: ['never formed'], settled: false, proposerWritable: false }
  for (const [a, b, d] of s.delay) sim.fault(a, b, { delay: [d, d] })
  const ids = nodes.map((x) => x.uuid)
  if (s.join) {
    //! the joiner is on n01's side from the start (cut from the members): linked to them it would carry n01's view across
    for (const o of ids) if (o !== 'n01') sim.partition('n09', o)
    sim.add({ uuid: 'n09', listen: 'sim:n09', hosts: ['sim:n01'], heartbeatMs: 50, durable: true, redialMs: 20, journalCap: 1 << 16 })
    sim.post('n09', { kind: 'start' })
    sim.run({ until: sim.now + 60 })
  }
  const t0 = sim.now
  for (const u of s.leavers) sim.post(u, { kind: 'leave' })
  //! the isolation: n01 loses every member
  sim.at(s.isolateMs, () => { for (const o of ids) if (o !== 'n01') sim.partition('n01', o) })
  const gone = new Map<string, number>(), back = new Set<string>()
  let last = t0
  for (let t = sim.now; t <= t0 + s.horizon; t += 5) {
    sim.run({ until: t })
    for (const u of s.leavers) {
      if (!gone.has(u) && sim.left.has(u) && sim.nodes.has(u)) { tearDown(sim, u, true); gone.set(u, sim.now); last = sim.now }
      if (gone.has(u) && !back.has(u) && sim.now >= gone.get(u)! + s.backMs) {
        back.add(u)
        for (const o of ids) if (o !== 'n01' && o !== u && !(gone.has(o) && !back.has(o))) sim.heal(u, o)
        sim.left.delete(u)
        sim.restart(u)
        last = sim.now
      }
    }
    if (gone.size === s.leavers.length && back.size === s.leavers.length && sim.now > last + 8000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (gone.size !== s.leavers.length) problems.push('leaver never answered: ' + s.leavers.filter((u) => !gone.has(u)))
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  const far = [...sim.nodes.values()].filter((x) => x.uuid !== 'n01' && x.uuid !== 'n09')
  const views = new Set(far.map((x) => `${x.epoch}:${members(x)}`))
  const settled = views.size === 1 && far.every((x) => x.membership.gate(x).open && !members(x).includes('n01'))
  const p = sim.nodes.get('n01')
  return { problems, settled, proposerWritable: p ? p.membership.gate(p).open : false }
}
export const shapeI = (s: ScheduleI) => `${s.seed} n=${s.n} leavers=${s.leavers} isolate=${s.isolateMs} back=${s.backMs}${s.join ? ' join' : ''}${s.delay.length ? ' slow=' + s.delay.map((d) => d.join(':')).join(',') : ''}`

//! evictsplit — the round-3 report's n=3 pin, time-triggered as it was: n01-n02 cut; n03 stops and its knock reaches
// n01; 3 ms after n01 has read it n01-n03 is cut too; n03 times out, is torn down and comes back from its dir 500 ms
// later linked to n02 only; n01's redial chains give up around +4 s. Checked at the 20 s horizon.
export const evictsplit = (seed: number, inspect?: (sim: Sim) => void): OutcomeI => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return { problems: ['never formed'], settled: false, proposerWritable: false }
  sim.partition('n01', 'n02')
  sim.run({ until: sim.now + 20 })
  sim.post('n03', { kind: 'leave' })
  const t0 = sim.now
  let read = -1, torn = -1, backAt = -1
  for (let t = sim.now; t <= t0 + 20000; t += 1) {
    sim.run({ until: t })
    if (read < 0 && has(nodes[0], JK.leave, 'n03')) { read = sim.now; sim.at(3, () => sim.partition('n01', 'n03')) }
    if (torn < 0 && sim.left.has('n03')) { torn = sim.now; tearDown(sim, 'n03', true) }
    if (torn >= 0 && backAt < 0 && sim.now >= torn + 500) { backAt = sim.now; sim.heal('n02', 'n03'); sim.left.delete('n03'); sim.restart('n03') }
    if (backAt >= 0 && sim.now > backAt + 12000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (read < 0) problems.push('not the shape: n01 never read the knock')
  if (torn < 0) problems.push('not the shape: n03 never timed out')
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  const far = [...sim.nodes.values()].filter((x) => x.uuid !== 'n01')
  const settled = new Set(far.map((x) => `${x.epoch}:${members(x)}`)).size === 1 && far.every((x) => x.membership.gate(x).open && !members(x).includes('n01'))
  const p = sim.nodes.get('n01')!
  return { problems, settled, proposerWritable: p.membership.gate(p).open }
}

//! joinsplit — the round-3 report's join variant: n01-n02 cut; n09 joins through n01 (a 30 ms link, so its VOTE is
// slow); n01 opens {n01,n02,n03,n09}@2; n03 grants it and stops at once; its knock reaches n01 over the fast link
// before n09's VOTE; 3 ms after n01 has read it n01-n03 is cut; n03 comes back from its dir 500 ms after its
// teardown, linked to n02 only. Checked at the 20 s horizon.
export const joinsplit = (seed: number, inspect?: (sim: Sim) => void): OutcomeI => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return { problems: ['never formed'], settled: false, proposerWritable: false }
  sim.partition('n01', 'n02')
  //! the joiner is on n01's side of the cut: linked to n02 or n03 it would carry n01's view across (n03 would get its
  // exit proof from it and leave clean; n02 would learn the view and never be the stale stayer)
  sim.partition('n02', 'n09'); sim.partition('n03', 'n09')
  sim.run({ until: sim.now + 20 })
  sim.fault('n01', 'n09', { delay: [30, 30] })
  sim.add({ uuid: 'n09', listen: 'sim:n09', hosts: ['sim:n01'], heartbeatMs: 50, durable: true, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n09', { kind: 'start' })
  const t0 = sim.now
  let voted = -1, read = -1, torn = -1, backAt = -1
  for (let t = sim.now; t <= t0 + 20000; t += 1) {
    sim.run({ until: t })
    if (voted < 0 && nodes[2].journal.read().some((e) => e.kind === JK.vote && e.a === 2 && e.b === 1)) { voted = sim.now; sim.post('n03', { kind: 'leave' }) }
    if (voted >= 0 && read < 0 && has(nodes[0], JK.leave, 'n03')) { read = sim.now; sim.at(3, () => sim.partition('n01', 'n03')) }
    if (torn < 0 && sim.left.has('n03')) { torn = sim.now; tearDown(sim, 'n03', true) }
    if (torn >= 0 && backAt < 0 && sim.now >= torn + 500) { backAt = sim.now; sim.heal('n02', 'n03'); sim.left.delete('n03'); sim.restart('n03') }
    if (backAt >= 0 && sim.now > backAt + 12000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (voted < 0) problems.push('not the shape: n03 never granted the join ballot')
  if (read < 0) problems.push('not the shape: n01 never read the knock')
  if (torn < 0) problems.push('not the shape: n03 never timed out')
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  const far = [...sim.nodes.values()].filter((x) => x.uuid !== 'n01' && x.uuid !== 'n09')
  const settled = new Set(far.map((x) => `${x.epoch}:${members(x)}`)).size === 1 && far.every((x) => x.membership.gate(x).open && !members(x).includes('n01'))
  const p = sim.nodes.get('n01')!
  return { problems, settled, proposerWritable: p.membership.gate(p).open }
}

//! twoLeavers — the first review's n=4 schedule (DESIGN-LEAVE §3), the one the round-0 kernel split on: n01 and n02 lose
// each other (n02 keeps redialing n01, so each is the lowest live member in its own eyes); then n03 and n04 stop at
// once over asymmetric links — n01 is near n03 and far from n04, n02 the other way round — so each proposer reads a
// different leaver's knock first and opens a ballot at epoch 2 without that leaver. Vote-once must let at most one
// commit. Safety only: on the base nothing commits (all four stay at epoch 1). Checked at 1.2 s and at a quiet point.
export const twoLeavers = (seed: number, inspect?: (sim: Sim) => void): string[] => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 4, { heartbeatMs: 50, fault: { delay: [3, 3] } })
  sim.run({ until: 600 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  sim.partition('n01', 'n02')
  sim.run({ until: 900 })
  sim.fault('n01', 'n03', { delay: [5, 5] }); sim.fault('n01', 'n04', { delay: [40, 40] })
  sim.fault('n02', 'n04', { delay: [5, 5] }); sim.fault('n02', 'n03', { delay: [40, 40] })
  sim.post('n03', { kind: 'leave' }); sim.post('n04', { kind: 'leave' })
  const problems: string[] = []
  const check = (at: string) => {
    if (sim.violations.length) problems.push(`VIOLATION at ${at}: ` + JSON.stringify(sim.violations.slice(0, 1)))
    const sp = split(sim)
    if (sp) problems.push(`${sp} at ${at}`)
  }
  sim.run({ until: 1200 })
  check('1.2 s')
  sim.run({ until: 3000 })
  inspect?.(sim)
  check('3 s')
  return problems
}

//! pledgeTwo — the shape the restricted pledge cannot answer (DESIGN-LEAVE §10.3; the 2026-10-10 review's probe): n=5;
// n04 and n05 stop at once and knock to n01; the instant n01 has read both knocks, {n03,n04,n05} are cut from
// {n01,n02}. So n01 keeps ONE stayer (n02), and the stale stayer n03 keeps admitted links to BOTH leavers. The
// leavers time out, are torn down and restart from their dirs 500 ms later linked to n03 and each other only.
// Checked at the 12 s horizon. Today's kernel: n01 opened `{n01,n02,n03,n05}`@2 on the first knock (the second is
// ignored while a ballot is in flight, kernel/membership.ts onLeave); its PROPOSE reaches n03 and n05 across the
// cut (frames in flight land, sim/exec.ts partition) but their VOTEs leave after it and die, so n01 has its own vote
// and n02's, two of the five it needs, and commits nothing; the far side re-forms without n01 and n02, because n03
// leads it — holding a vote at 2 above its view 1 (the §10.9 step-2 rule would close that, so `settled` is a counted
// pin, not an assertion). A kernel that counts the two knocks as votes commits `{n01,n02,n03}`@2 on n01 + n02 + two
// pledges — exactly "the view minus the leavers" — while n03's gate counts 1 + n04 + n05 = 3 of 5 at view 1 (a
// leaver's own read-only gate does not stop it being COUNTED): two writable views from the commit on, one view per
// epoch broken once both sides reach 3, and `n01@3{n01,n02}` beside `n03@3{n03,n04,n05}` at the horizon.
// THE CUT IS AT 0 MS: the first version cut 3 ms after the knocks, the VOTEs already in flight landed, and BOTH
// kernels committed a four-member view at 2 (the base `{n01,n02,n03,n05}`, read-only at 2 of 4; round 3 the same) —
// no split anywhere, no teeth (the second review).
export const pledgeTwo = (seed: number, inspect?: (sim: Sim) => void): OutcomeI => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 5, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return { problems: ['never formed'], settled: false, proposerWritable: false }
  const leavers = ['n04', 'n05']
  for (const u of leavers) sim.post(u, { kind: 'leave' })
  const t0 = sim.now
  let read = -1, cutAt = -1
  const gone = new Map<string, number>(), back = new Set<string>()
  let last = t0
  for (let t = sim.now; t <= t0 + 12000; t += 1) {
    sim.run({ until: t })
    if (read < 0 && leavers.every((u) => has(nodes[0], JK.leave, u))) {
      read = sim.now
      //! the cut comes NOW, before any VOTE answering n01's ballot has left n03 or the leavers
      cutAt = sim.now; for (const a of ['n01', 'n02']) for (const b of ['n03', ...leavers]) sim.partition(a, b)
    }
    for (const u of leavers) {
      if (!gone.has(u) && sim.left.has(u) && sim.nodes.has(u)) { tearDown(sim, u, true); gone.set(u, sim.now); last = sim.now }
      if (gone.has(u) && !back.has(u) && sim.now >= gone.get(u)! + 500) {
        back.add(u)
        sim.heal(u, 'n03'); for (const o of leavers) if (o !== u && back.has(o)) sim.heal(u, o)
        sim.left.delete(u); sim.restart(u); last = sim.now
      }
    }
    if (back.size === leavers.length && sim.now > last + 8000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (read < 0) problems.push('not the shape: n01 never read both knocks')
  if (cutAt < 0) problems.push('not the shape: the cut never came')
  if (gone.size !== leavers.length) problems.push('leaver never answered: ' + leavers.filter((u) => !gone.has(u)))
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  const far = [...sim.nodes.values()].filter((x) => x.uuid !== 'n01' && x.uuid !== 'n02')
  const settled = new Set(far.map((x) => `${x.epoch}:${members(x)}`)).size === 1 && far.every((x) => x.membership.gate(x).open && !members(x).includes('n01'))
  const p = sim.nodes.get('n01')!
  return { problems, settled, proposerWritable: p.membership.gate(p).open }
}

//! evictTwo — the stale-majority shape the base's own arithmetic allows (DESIGN-LEAVE §10.2): a ballot that evicts TWO
// suspects at once at n=5 shrinks the view to three, whose writable majority is two, while a majority of the old view
// is three — and 2 + 3 = 5 voters exist. n04 and n05 are cut from n01 and n02 but stay linked to n03; n01 evicts both
// once its redial chains give up; n03 grants and is cut from n01 and n02 before the VIEW reaches it (`cut`: the first
// VIEW n01→n03 dies on the sever and both pairs stay cut) or crashes on its grant and comes back from its dir 500 ms
// later linked to n04 and n05 only (`crash`). `k = 1` (n05 alone cut, n04 kept) is the control the arithmetic
// forbids: the new view's two-of-four majority and the old view's three-of-five need six voters of five.
export const evictTwo = (seed: number, how: 'cut' | 'crash', k: 1 | 2 = 2, inspect?: (sim: Sim) => void): string[] => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 5, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  const far = k === 2 ? ['n04', 'n05'] : ['n05']
  for (const f of far) { sim.partition('n01', f); sim.partition('n02', f) }
  if (how === 'cut') sim.severOnFrame('n01', 'n03', VERB.VIEW)
  const t0 = sim.now
  let voted = -1, cutAt = -1, backAt = -1
  for (let t = sim.now; t <= t0 + 15000; t += 1) {
    sim.run({ until: t })
    if (voted < 0 && nodes[2].journal.read().some((e) => e.kind === JK.vote && e.a === 2 && e.b === 1 && e.c === 'n01')) {
      voted = sim.now
      if (how === 'crash') { tearDown(sim, 'n03', true) }
    }
    if (voted >= 0 && cutAt < 0 && how === 'cut' && nodes[0].epoch >= 2) { cutAt = sim.now; sim.partition('n01', 'n03'); sim.partition('n02', 'n03') }
    if (voted >= 0 && backAt < 0 && how === 'crash' && sim.now >= voted + 500) { backAt = sim.now; for (const f of far) sim.heal('n03', f); if (k === 1) sim.heal('n03', 'n04'); sim.restart('n03') }
    if ((how === 'cut' ? cutAt : backAt) >= 0 && sim.now > Math.max(cutAt, backAt) + 6000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (voted < 0) problems.push('not the shape: n03 never granted the eviction')
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  return problems
}

//! evictTwoB — evictTwo with the stale voter NOT the far side's lowest member (the second 2026-10-10 review's probe,
// DESIGN-LEAVE §10.2): n=5; {n02,n03} are cut from n01, n04 and n05, so neither can open a ballot (two of five live).
// n01 evicts both on n04's and n05's grants: `{n01,n04,n05}`@2. n04 CRASHES on its grant (every link dies) and comes
// back from its dir 500 ms later linked to n02 and n03 ONLY: view 1, a vote at 2 for n01 above it. The far side's
// lowest live member is n02, which never voted at 2: it evicts n01 and n05 at 2, n04 refuses (its vote at 2 is
// spent on n01, `ve` teaches the burn), n02 escalates to 3 — and n04 GRANTS at 3 while it still holds view 1: the
// vote above its view is spent again, on a ballot over the view it should not trust. n01 meanwhile evicts n04 at 3.
// Two views at epoch 3, `n01@3{n01,n05}` beside `n02@4{n02,n03,n04}` (or @3), both writable. So a rule that only
// closes the stale voter's gate and stops IT leading changes nothing here: the hole is the GRANT (a candidate rule
// with gate + lead-nothing only turns evictTwo green and leaves this red; one grant clause closes it, and costs
// the far side its liveness — DESIGN-LEAVE §10.2, §10.9 step 2).
export const evictTwoB = (seed: number, inspect?: (sim: Sim) => void): string[] => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 5, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  for (const a of ['n02', 'n03']) for (const b of ['n01', 'n04', 'n05']) sim.partition(a, b)
  const t0 = sim.now
  let voted = -1, backAt = -1
  for (let t = sim.now; t <= t0 + 15000; t += 1) {
    sim.run({ until: t })
    if (voted < 0 && nodes[3].journal.read().some((e) => e.kind === JK.vote && e.a === 2 && e.b === 1 && e.c === 'n01')) { voted = sim.now; tearDown(sim, 'n04', true) }
    if (voted >= 0 && backAt < 0 && sim.now >= voted + 500) { backAt = sim.now; sim.heal('n04', 'n02'); sim.heal('n04', 'n03'); sim.restart('n04') }
    if (backAt >= 0 && sim.now > backAt + 8000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (voted < 0) problems.push('not the shape: n04 never granted the eviction')
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  return problems
}

// ── crash: a stayer crashes at an offset from the clean stops; everyone restarts from disk (the round-3 `crash2`) ──
export interface ScheduleC { seed: number; n: number; crashed: string; leavers: string[]; offset: number; back: number; restart: number }

//! GRID_C — n 3..5; the crashed member the lowest (n01) or the highest; one leaver (the highest member left) or two
// (the two highest left); the crash 200 ms before the stops, at them, 20 or 100 ms after; the crashed member back
// from its dir after 2 s or never (-1); the leavers restarted after 0.4, 3 or 25 s; sim seeds 1 and 2. 576 cases.
// `restarts` and `seeds` trim it (the test runs 0.4 s under seed 1 by default: 96 cases, 4 of them the n=3 crash twin).
export const gridC = (restarts = [400, 3000, 25000], seeds = [1, 2]): ScheduleC[] => {
  const out: ScheduleC[] = []
  for (const n of [3, 4, 5]) for (const low of [true, false]) for (const two of [false, true]) for (const offset of [-200, 0, 20, 100]) for (const back of [2000, -1]) for (const restart of restarts) for (const seed of seeds) {
    const ids = Array.from({ length: n }, (_, i) => `n0${i + 1}`)
    const crashed = low ? ids[0] : ids[n - 1]
    const rest = ids.filter((u) => u !== crashed)
    out.push({ seed, n, crashed, leavers: two ? rest.slice(-2) : rest.slice(-1), offset, back, restart })
  }
  return out
}

//! runC — one crash schedule. The crash: every link of the crashed member dies at once and it goes silent; back
// means a restart from its dir, healed to everyone up. A leaver is torn down on `left` and restarted from its dir
// after `restart` ms, healed to everyone up. Wanted at the end: every node that is up, in one view holding exactly
// them, writable, the data converged.
export const runC = (s: ScheduleC): string[] => {
  const sim = new Sim(s.seed)
  const nodes = cluster(sim, s.n, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  const ids = nodes.map((x) => x.uuid)
  const down = new Set<string>()
  const up = (u: string) => !down.has(u)
  const t0 = sim.now
  const crashAt = Math.max(0, s.offset), leaveAt = Math.max(0, -s.offset)
  sim.at(crashAt, () => { down.add(s.crashed); for (const o of ids) if (o !== s.crashed) sim.partition(s.crashed, o) })
  for (const u of s.leavers) sim.post(u, { kind: 'leave' }, leaveAt)
  const gone = new Map<string, number>(), back = new Set<string>()
  let crashBack = s.back < 0, last = t0 + crashAt + Math.max(0, s.back)
  for (let t = sim.now; t <= t0 + 30000 + s.restart; t += 5) {
    sim.run({ until: t })
    if (!crashBack && sim.now >= t0 + crashAt + s.back) {
      crashBack = true; down.delete(s.crashed)
      for (const o of ids) if (o !== s.crashed && up(o)) sim.heal(s.crashed, o)
      sim.restart(s.crashed); last = sim.now
    }
    for (const u of s.leavers) {
      if (!gone.has(u) && sim.left.has(u) && sim.nodes.has(u)) { tearDown(sim, u, true); down.add(u); gone.set(u, sim.now); last = sim.now }
      if (gone.has(u) && !back.has(u) && sim.now >= gone.get(u)! + s.restart) {
        back.add(u); down.delete(u)
        for (const o of ids) if (o !== u && up(o)) sim.heal(u, o)
        sim.left.delete(u); sim.restart(u); last = sim.now
      }
    }
    if (gone.size === s.leavers.length && back.size === s.leavers.length && crashBack && sim.now > last + 9000) break
  }
  if (gone.size !== s.leavers.length) return ['leaver never answered: ' + s.leavers.filter((u) => !gone.has(u))]
  //! a member that never came back is destroyed before the verdict: it is not part of the wanted view
  if (s.back < 0) { tearDown(sim, s.crashed, false) }
  return verdict(sim, ids.filter((u) => u !== s.crashed || s.back >= 0).sort())
}
export const shapeC = (s: ScheduleC) => `${s.seed} n=${s.n} crash=${s.crashed}@${s.offset} back=${s.back} leavers=${s.leavers} restart=${s.restart}`

// ── explorer: the random mesh over real Nodes with the quiet-point split check ──
export interface OutcomeX { seed: number; n: number; bad: string | null }
export const exploreQuiet = (seed: number, steps = 400): OutcomeX => {
  const x = explore(seed, steps, true)
  const bad = x.threw ? `THREW ${x.threw}` : x.splits.length ? `one-view-per-epoch: ${x.splits[0]}` : x.quietSplit ? `SPLIT: ${x.quietSplit}` : null
  return { seed, n: x.n, bad }
}
