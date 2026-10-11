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
//   keptBallot — the kept ballot's two-member shape at n=4 (DESIGN-LEAVE §10.2 (ii); the third 2026-10-10 review's
//               probe), move by move on real Nodes: a duel at 2, the loser escalates to 3 over view 1 before view 2
//               reaches it, installs view 2 EVICTED and keeps the ballot (kernel/membership.ts install), and commits
//               it on two granters who hold view 2. Today's kernel: two writable views at the quiet point, then two
//               views at epoch 4 once the cut chains give up. The base's third hole.
//   flapDuringBallot, proposerCrash — a FAILED ballot in a healthy cluster (the same review): one member flaps during
//               an eviction ballot and the proposer abandons it; the proposer crashes for good mid-ballot (open, or
//               committed with its VIEW unsent). Today's kernel heals both, writable everywhere; a rule that closes a
//               gate on a vote above its view freezes every live member for good (DESIGN-LEAVE §10.2, the release).
//   releasedEarly, proposerDeadStale, retrySameEpoch, twoFailedBallots, lateView — the RELEASE shapes (DESIGN-LEAVE
//               §10.10): what a rule that holds a vote above the view must stay live and safe on, pinned on today's
//               kernel before the rule was measured. A two-evictee ballot (the only ballot today's kernel opens that
//               changes two members at once) that commits late with the VIEW lost (the split a clock-based release
//               allows; red today as evictTwo is); whose proposer dies for good with a stale majority alive, open or
//               committed, and comes back from its dir; that is abandoned and retried at the same epoch after the
//               proposer's restart; that is abandoned twice and then commits; and whose VIEW is late into one voter.
//   clientAsk, freshLink, genesisProposerAndGranterDie, genesisSplit — the THIRD review's shapes (§10.10, 2026-10-10):
//               a client's word (a HELLO and a PULL that name a hold) must teach nothing (I-23); a held member's link
//               to a stayer flaps, and the stayer must not count the fresh link before it knows the holds; the genesis
//               hold's cost (one survivor with memory beside a newcomer or a reborn pair, the epoch-0 form of
//               proposerAndGranterDie); and today's genesis split (two views at one epoch when two granters are cut
//               before the VIEW, hostless), red today.
//   clientGenesis, serverAsk, helloHold, freshLinkSim — the FOURTH review's shapes (§10.10, 2026-10-10): one pin per
//               kernel line of the rule's wire. A client's word at epoch 0 and a non-member server's word teach
//               nothing (the two halves of I-23's fix); a hold a stayer learned from a HELLO alone is counted again
//               when it ends; and freshLink on REAL HELLOs in the Sim, because this mesh writes its own HELLO for
//               every link and so never tests the node's. genesisProposerAndGranterDie also records its proposals.
//   explorer  — sim/mesh.ts's random explorer over real Nodes with the quiet-point writable-split check on (the
//               round-2 re-check's "end-state check" variant), over its own seed range.
// What every family checks (sim/leave-sweep.ts): SAFETY — no monitor fired and no two nodes end WRITABLE in
// different views at a quiet point (the invariant DESIGN-LEAVE §9 names; one-view-per-epoch alone misses a stale
// majority writable at a lower epoch beside the view without it). LIVENESS is counted, never asserted as "all".
import { Sim } from './exec.ts'
import { cluster } from './harness.ts'
import { verdict, split } from './leave-sweep.ts'
import { explore, Mesh, quietSplit } from './mesh.ts'
import { JK } from '../kernel/journal.ts'
import { VERB, encodeControl } from '../kernel/codec.ts'
import { LS } from '../kernel/link.ts'
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
//! `slow` (releasedEarly, below): the n01-n03 link carries every frame `slow` ms each way, so n03's grant reaches n01
// late and the ballot commits late; the commit is then required to come at least `slow` ms after the grant.
export const evictTwo = (seed: number, how: 'cut' | 'crash', k: 1 | 2 = 2, inspect?: (sim: Sim) => void, slow = 0): string[] => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 5, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  const far = k === 2 ? ['n04', 'n05'] : ['n05']
  for (const f of far) { sim.partition('n01', f); sim.partition('n02', f) }
  if (how === 'cut') sim.severOnFrame('n01', 'n03', VERB.VIEW)
  if (slow > 0) sim.fault('n01', 'n03', { delay: [slow, slow] })
  const t0 = sim.now
  let voted = -1, cutAt = -1, backAt = -1, committedAt = -1
  for (let t = sim.now; t <= t0 + 15000; t += 1) {
    sim.run({ until: t })
    if (voted < 0 && nodes[2].journal.read().some((e) => e.kind === JK.vote && e.a === 2 && e.b === 1 && e.c === 'n01')) {
      voted = sim.now
      if (how === 'crash') { tearDown(sim, 'n03', true) }
    }
    if (committedAt < 0 && nodes[0].epoch >= 2) committedAt = sim.now
    if (voted >= 0 && cutAt < 0 && how === 'cut' && nodes[0].epoch >= 2) { cutAt = sim.now; sim.partition('n01', 'n03'); sim.partition('n02', 'n03') }
    if (voted >= 0 && backAt < 0 && how === 'crash' && sim.now >= voted + 500) { backAt = sim.now; for (const f of far) sim.heal('n03', f); if (k === 1) sim.heal('n03', 'n04'); sim.restart('n03') }
    if ((how === 'cut' ? cutAt : backAt) >= 0 && sim.now > Math.max(cutAt, backAt) + 6000) break
  }
  inspect?.(sim)
  const problems: string[] = []
  if (voted < 0) problems.push('not the shape: n03 never granted the eviction')
  if (slow > 0 && (committedAt < 0 || committedAt < voted + slow)) problems.push(`not the shape: the commit did not come ${slow} ms after the grant (grant ${voted - t0}, commit ${committedAt < 0 ? 'never' : committedAt - t0})`)
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  return problems
}

//! releasedEarly — evictTwo's cut shape WITH A DELAY (DESIGN-LEAVE §10.10, the release): the n01-n03 link is slow
// (200 ms each way), so n03's grant reaches n01 late and n01 commits `{n01,n02,n03}`@2 at +400 ms (age 8 of its 10
// ticks) — then the VIEW to n03 dies on the sever and the pairs stay cut. From n03's seat nothing distinguishes this
// from a ballot its proposer dropped: the grant is 200 ms old when the commit happens, and the VIEW never comes.
// Plainly (the second review of §10.10): this shape has no teeth evictTwo does not have. ANY hold that ends on a
// clock shorter than the run splits evictTwo already, because the VIEW never arrives there either; the delay only
// makes the grant older at the commit. It stays as the named witness of the clock argument, red today exactly as
// evictTwo is. The "commit came 200 ms after the grant" check is a guard that the slow link was in effect, true by
// construction whenever the ballot commits (n01 needs n03's VOTE, which crosses the slow link) — not an engagement
// count. The shape with the VIEW LATE rather than lost, which a clock fails where evictTwo's horizon may not catch
// it, is lateView below (its hold-back is longer than the rejected clock).
export const releasedEarly = (seed: number, inspect?: (sim: Sim) => void): string[] => evictTwo(seed, 'cut', 2, inspect, 200)

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

// ── the mesh shapes: fixed schedules, move by move on real Nodes (sim/mesh.ts; the third 2026-10-10 review's probes) ──
//! meshState — every node on one line: `uuid@epoch{members}` then `W` (writable) or `r:<reason>` (read-only)
export const meshState = (m: Mesh) => [...m.nodes.values()].map((x) => { const g = x.membership.gate(x); return `${x.uuid}@${x.epoch}{${x.membership.view.members.map((v) => v[0])}}${g.open ? 'W' : 'r:' + g.reason}` }).join(' ')
//! drain — every queued frame lands, in order, with the cuts as they are (the mesh's quiet point, without the ticks)
const drain = (m: Mesh) => { for (let g = 0; g < 2000; g++) { const qs = [...m.q.entries()].filter(([, f]) => f.length); if (!qs.length) break; for (const [k] of qs) { const [a, b] = k.split('>'); m.deliver(a, b) } } }
//! allOf — every frame a→b lands, in order; the verbs it delivered
const allOf = (m: Mesh, a: string, b: string) => { const out: string[] = []; for (let v; (v = m.deliver(a, b)); ) out.push(v); return out }
const proposals = (m: Mesh, u: string) => m.nodes.get(u)!.journal.read().filter((e) => e.kind === JK.propose).map((e) => `P(${e.a},${e.b})`).join(' ')
//! settle — the chains to every cut pair give up (as they do in life after the redial budget), every frame lands,
// everyone ticks; `rounds` times over
const settle = (m: Mesh, rounds: number, pairs: [string, string][]) => {
  for (let r = 0; r < rounds; r++) { for (const [x, y] of pairs) m.giveUp(x, y); drain(m); for (const u of m.nodes.keys()) m.tick(u) }
  drain(m)
}
//! `mid` (the release shapes below): the state at named points before the end — read-only sets a rule may move
export interface OutcomeM { shape: string[]; splits: string[]; quiet: string | null; end: string; readOnly: string[]; mid?: string[] }
const outcomeM = (m: Mesh, shape: string[], quiet: string | null, mid?: string[]): OutcomeM => {
  const end = meshState(m)
  return { shape, splits: [...m.splits], quiet, end, readOnly: end.split(' ').filter((s) => s.includes('r:')), ...(mid ? { mid } : {}) }
}
//! readOnlyOf — the read-only entries of a meshState line
export const readOnlyOf = (state: string) => state.split(' ').filter((s) => s.includes('r:'))

//! keptBallot — the kept ballot's two-member shape at n=4 (DESIGN-LEAVE §10.2 (ii)): aa and bb lose each other and
// each, the lowest live member in its own eyes, proposes the view without the other at 2. bb wins on cc's and dd's
// grants, `{bb,cc,dd}`@2. aa is refused at 2 (their votes are on bb), its ballot ages out, and it escalates past the
// burn to `{aa,cc,dd}`@3 (kernel/membership.ts #nextEpoch) — over view 1, because bb's VIEW 2 has not reached it.
// bb's VIEW lands at cc and dd first; they install view 2 and THEN read aa's PROPOSE@3, which is above their view,
// and grant it (the grant rule reads no base epoch: the frame carries none). aa reads cc's VIEW 2 — installs it,
// EVICTED, and KEEPS its ballot at 3 (install drops only a ballot at or below the view) — then cc's VOTE (its own and
// cc's: 2 of view 1's 4, not a majority, so nothing commits yet). Now cc is cut from aa and from dd, and bb from dd;
// dd's VOTE lands and aa counts 3 of view 1's 4 (itself, cc and dd; its old set, fixed when the ballot opened) and 3
// of 3 new: `{aa,cc,dd}`@3 commits with view 2 and view 3 TWO members apart (bb out, aa in).
// At the quiet point aa and dd are writable at 3 beside bb and cc at 2 (the split the recorder cannot see); once the
// chains give up, bb evicts dd (`{bb,cc}`@4) and aa evicts cc (`{aa,dd}`@4): two views at epoch 4, both writable.
// `shape` names the move that did not happen as described; empty on today's kernel.
export const keptBallot = (): OutcomeM => {
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd'])
  const shape: string[] = []
  const node = (u: string) => m.nodes.get(u)!
  m.cut('aa', 'bb')
  for (let i = 0; i < 3; i++) { m.tick('aa'); m.tick('bb') }
  m.giveUp('aa', 'bb'); m.giveUp('bb', 'aa')
  m.tick('aa'); m.tick('bb')
  if (proposals(m, 'aa') !== 'P(2,3)' || proposals(m, 'bb') !== 'P(2,3)') shape.push(`the duel at 2: aa ${proposals(m, 'aa')}, bb ${proposals(m, 'bb')}`)
  //! bb wins on cc's and dd's grants
  allOf(m, 'bb', 'cc'); allOf(m, 'bb', 'dd'); allOf(m, 'cc', 'bb'); allOf(m, 'dd', 'bb')
  if (node('bb').epoch !== 2) shape.push(`bb did not commit {bb,cc,dd}@2: ${meshState(m)}`)
  //! cc and dd refuse aa at 2 (their vote at 2 is on bb); bb's VIEW 2 is still in their queues, not yet read
  allOf(m, 'aa', 'cc'); allOf(m, 'aa', 'dd'); allOf(m, 'cc', 'aa'); allOf(m, 'dd', 'aa')
  //! aa's ballot at 2 ages out and it escalates past the burn to 3, over view 1
  for (let i = 0; i < 20 && !proposals(m, 'aa').includes('P(3'); i++) { m.giveUp('aa', 'bb'); m.tick('aa') }
  if (proposals(m, 'aa') !== 'P(2,3) P(3,3)' || node('aa').epoch !== 1) shape.push(`aa did not escalate to 3 over view 1: ${proposals(m, 'aa')} at epoch ${node('aa').epoch}`)
  //! bb's VIEW 2 lands at cc and dd FIRST (they install it and flood it to aa), then aa's queued PROPOSE@3s: both grant
  allOf(m, 'bb', 'cc'); allOf(m, 'bb', 'dd'); allOf(m, 'aa', 'cc'); allOf(m, 'aa', 'dd')
  for (const u of ['cc', 'dd']) if (node(u).epoch !== 2 || node(u).membership.votedFor.e !== 3 || node(u).membership.votedFor.p !== 'aa') shape.push(`${u} did not grant aa at 3 from view 2: ${meshState(m)}`)
  //! aa reads cc's queue: VIEW 2 first (FIFO) — installed, evicted, the ballot KEPT — then cc's VOTE at 3
  allOf(m, 'cc', 'aa')
  if (node('aa').epoch !== 2) shape.push(`aa did not install view 2 evicted: ${meshState(m)}`)
  //! the two cuts inside one round trip; then dd's VOTE lands and the kept ballot commits
  m.cut('cc', 'aa'); m.cut('cc', 'dd'); m.cut('bb', 'dd')
  allOf(m, 'dd', 'aa')
  if (node('aa').epoch !== 3) shape.push(`aa did not commit {aa,cc,dd}@3 on the kept ballot: ${meshState(m)}`)
  const quiet = quietSplit(m)
  settle(m, 30, [['aa', 'bb'], ['bb', 'aa'], ['aa', 'cc'], ['cc', 'aa'], ['cc', 'dd'], ['dd', 'cc'], ['bb', 'dd'], ['dd', 'bb']])
  return outcomeM(m, shape, quiet)
}

//! evictionBallot — a healthy five-node mesh in which aa loses ee only (k = 1), or dd and ee (k = 2), suspects them,
// its chains give up, and it proposes the view without them at 2 (the eviction branch of kernel/membership.ts tick):
// `{aa,bb,cc,dd}`@2, one member apart from view 1, or `{aa,bb,cc}`@2, TWO apart — the shape the one-member count of
// DESIGN-LEAVE §10.2 (a) does not protect, and the only ballot today's kernel opens that changes two members at once.
// The start of the failed-ballot shapes below.
const evictionBallot = (shape: string[], k: 1 | 2 = 1, durable = false): Mesh => {
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'], durable)
  const gone = k === 2 ? ['dd', 'ee'] : ['ee']
  for (const u of gone) m.cut('aa', u)
  for (let i = 0; i < 3; i++) m.tick('aa')
  for (const u of gone) m.giveUp('aa', u)
  m.tick('aa')
  if (proposals(m, 'aa') !== `P(2,${5 - k})`) shape.push(`aa did not open the eviction of ${gone} at 2: ${proposals(m, 'aa')}`)
  return m
}
//! drainExcept — every queued frame lands, in order, except those INTO `skip` (a late link into one node)
const drainExcept = (m: Mesh, skip: string) => { for (let g = 0; g < 2000; g++) { const qs = [...m.q.entries()].filter(([k, f]) => f.length && !k.endsWith('>' + skip)); if (!qs.length) break; for (const [k] of qs) { const [a, b] = k.split('>'); m.deliver(a, b) } } }
//! restartFromDir — the node comes back from its boot record (a new life, the next incarnation) linked to `peers`
const restartFromDir = (m: Mesh, u: string, peers: string[], shape: string[]) => {
  const b = m.boots.get(u)
  if (!b) { shape.push(`${u} has no boot record to restart from`); return }
  if (m.nodes.has(u)) m.destroy(u)
  m.add(u, { epoch: b.epoch, members: b.members, votedFor: b.votedFor }, 2)
  for (const o of peers) m.connect(u, o)
}

//! flapDuringBallot — one member flaps during an eviction ballot, no cut of the cluster: bb's VOTE lands (2 of the 3
// aa needs), then ee comes back and aa ABANDONS the ballot (membership.ts tick: the suspect came back). Every frame
// lands and everyone ticks 40 rounds. Today's kernel: all five writable at view 1, bb, cc and dd each holding a vote
// at 2 for aa above their view, which nothing reads. A gate rule on that vote leaves all five read-only for good:
// bb, cc, dd `stale-vote`, and aa and ee `minority` once a stayer's gate skips the three (DESIGN-LEAVE §10.2).
export const flapDuringBallot = (): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape)
  if (m.deliver('aa', 'bb') !== 'PROPOSE' || m.deliver('bb', 'aa') !== 'VOTE') shape.push('bb did not grant aa at 2')
  m.connect('aa', 'ee')
  m.tick('aa') // ee is live again: the eviction ballot is abandoned
  settle(m, 40, [])
  return outcomeM(m, shape, quietSplit(m))
}

//! proposerCrash — the proposer crashes for good in the middle of a one-member eviction ballot, after bb and cc have
// granted. `open`: the VOTEs never reach aa (it dies with the ballot open). `committed`: aa counts both, installs
// `{aa,bb,cc,dd}`@2 and dies before its VIEW leaves. The rest stay linked; their chains to aa give up. Today's
// kernel: the four re-form, `{bb,cc,dd,ee}`@3, writable. A gate rule on a vote above the view leaves all four
// read-only for good, and the one candidate release (the vote's proposer reporting its ballot uncommitted) has no
// proposer to fire from. In the committed variant the base's re-form is safe by the one-member count: a view at 2
// that changed one member cannot be writable beside view 3 (DESIGN-LEAVE §10.2 (a)).
export const proposerCrash = (variant: 'open' | 'committed'): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc')
  if (variant === 'committed') { m.deliver('bb', 'aa'); m.deliver('cc', 'aa'); if (m.nodes.get('aa')!.epoch !== 2) shape.push('aa did not commit {aa,bb,cc,dd}@2 on two grants') }
  else if (m.nodes.get('aa')!.epoch !== 1) shape.push('aa committed before it died')
  m.destroy('aa')
  settle(m, 40, [...m.nodes.keys()].map((u) => [u, 'aa'] as [string, string]))
  return outcomeM(m, shape, quietSplit(m))
}

// ── the release shapes (DESIGN-LEAVE §10.10): what a rule for "a vote above my view" must stay live and safe on ──
//! proposerDeadStale — the proposer of a TWO-evictee ballot dies for good with a stale majority of the old view alive
// and linked: aa evicts dd and ee at 2 on bb's and cc's grants and dies — with the ballot open (`open`: the VOTEs never
// reach it) or after installing `{aa,bb,cc}`@2 and before its VIEW leaves (`committed`); in `restart` it then comes
// back from its dir holding that view, which nobody else has, and dials everyone. bb, cc, dd and ee stay linked; their
// chains to aa give up. Today's kernel: bb (the lowest live member, holding a vote at 2 for aa above view 1) proposes
// `{bb,cc,dd,ee}`@3 and the four re-form, writable; the restored aa is a rejoiner at floor 2, learns view 3 on admit,
// is evicted, knocks JOIN, and bb votes it back in at 4. SAFE on the base: the view that died with aa was never held
// by a writable majority. Under a rule that holds bb and cc (their vote is for a view two members apart from the
// one they hold), the four are read-only for good unless the rule lets the held view be SUPERSEDED by a ballot that
// a majority of its members consent to — aa's death is indistinguishable, from here, from aa cut off and writable
// with its view (releasedEarly), so no local clock may release them (§10.10, requirement 1). `mid` is read two
// settle rounds after aa's death — every ask has landed, no chain to aa has given up yet, so nobody has proposed
// (the second review: read after the full settle it was the end state again and pinned nothing).
export const proposerDeadStale = (variant: 'open' | 'committed' | 'restart'): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2, true)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc')
  if (variant !== 'open') { m.deliver('bb', 'aa'); m.deliver('cc', 'aa'); if (m.nodes.get('aa')!.epoch !== 2) shape.push('aa did not commit {aa,bb,cc}@2 on two grants') }
  else if (m.nodes.get('aa')!.epoch !== 1) shape.push('aa committed before it died')
  m.destroy('aa')
  settle(m, 2, [])
  const mid = meshState(m)
  if ([...m.nodes.values()].some((x) => proposals(m, x.uuid) !== '')) shape.push(`someone proposed before the chains to aa gave up: ${mid}`)
  settle(m, 38, [...m.nodes.keys()].map((u) => [u, 'aa'] as [string, string]))
  const quiet: string[] = []
  const q1 = quietSplit(m); if (q1) quiet.push(q1)
  if (variant === 'restart') {
    //! aa comes back holding {aa,bb,cc}@2 — a committed view nobody else has — and dials everyone
    if (m.boots.get('aa')?.epoch !== 2) shape.push(`aa's boot record does not hold {aa,bb,cc}@2: ${JSON.stringify(m.boots.get('aa'))}`)
    restartFromDir(m, 'aa', ['bb', 'cc', 'dd', 'ee'], shape)
    settle(m, 20, [])
    const q2 = quietSplit(m); if (q2) quiet.push(q2)
  }
  return outcomeM(m, shape, quiet.length ? quiet.join(' | ') : null, [mid])
}

//! retrySameEpoch — an ABANDONED two-evictee ballot whose proposer later restarts and retries at the same epoch:
// aa evicts dd and ee at 2; bb grants (cc's VOTE is still in flight); dd comes back and aa abandons the ballot
// (kernel/membership.ts tick: the suspect returned); aa crashes and comes back from its dir — view 1, its own vote at
// 2 (durable before the PROPOSE left), the ballot forgotten — linked to bb, cc and dd (`one`: ee is still gone, so it
// retries as the ONE-member eviction `{aa,bb,cc,dd}`@2) or to bb and cc only (`two`: dd and ee are both gone again,
// so it retries the SAME two-member ballot at 2). The epoch is the same because a node's own ballots never go down
// (#nextEpoch, V4-25). bb and cc re-grant: the same proposer at the same epoch. Today's kernel: the retry commits and
// every member of it is writable; ee (and dd, in `two`) learn the view from bb and sit evicted, cut from the proposer
// they would knock to. Under a rule that holds bb and cc on the first grant, the re-grant must RE-READ the hold against
// the ballot it is for — one member apart in `one` (no hold), two in `two` (held until the VIEW lands) — and a vote
// the proposer's restart disowned must not stay disowned once the same proposer asks again.
export const retrySameEpoch = (variant: 'one' | 'two'): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2, true)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa')
  m.connect('aa', 'dd'); m.tick('aa') // dd is back: the ballot is abandoned, cc's VOTE dies with aa below
  if (m.nodes.get('aa')!.epoch !== 1) shape.push(`aa committed before the abandon: ${meshState(m)}`)
  for (const u of ['bb', 'cc']) if (m.nodes.get(u)!.membership.votedFor.e !== 2 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} does not hold a vote at 2 for aa: ${meshState(m)}`)
  const mid = meshState(m)
  if (variant === 'two') m.cut('aa', 'dd')
  restartFromDir(m, 'aa', variant === 'one' ? ['bb', 'cc', 'dd'] : ['bb', 'cc'], shape)
  const vf = m.nodes.get('aa')!.membership.votedFor
  if (vf.e !== 2 || vf.p !== 'aa' || m.nodes.get('aa')!.epoch !== 1) shape.push(`the restored aa does not hold view 1 and its own vote at 2: ${meshState(m)}`)
  //! the rejoin floor clears on a peer's VIEW 1 at admit; then aa suspects the absent again and retries at 2
  settle(m, 40, variant === 'one' ? [['aa', 'ee']] : [['aa', 'dd'], ['aa', 'ee']])
  if (proposals(m, 'aa') !== `P(2,${variant === 'one' ? 4 : 3})`) shape.push(`the restored aa did not retry at 2: ${proposals(m, 'aa') || 'nothing'}`)
  return outcomeM(m, shape, quietSplit(m), [mid])
}

//! twoFailedBallots — two abandoned two-evictee ballots in a row by one proposer, then a third that commits: dd and ee
// flap away from aa, aa proposes `{aa,bb,cc}`@2, bb grants, both come back, aa abandons; everyone ticks ten rounds
// (`mid[0]`); the same again at the same epoch (aa's own vote is at 2, so the retry is at 2 — V4-25), `mid[1]`; then
// they stay away and the ballot commits on bb's and cc's re-grants. Today's kernel: all five writable after each
// abandon; `{aa,bb,cc}`@2 at the end with dd and ee evicted. A rule that holds bb and cc on each grant must release
// them twice — the proposer is alive and linked and says the ballot is gone — and hold them a third time until the
// VIEW lands: the release and the re-hold must compose.
export const twoFailedBallots = (): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2)
  const mid: string[] = []
  const fail = (nth: number) => {
    m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa')
    m.connect('aa', 'dd'); m.connect('aa', 'ee'); m.tick('aa') // both back: abandoned; cc's VOTE lands on no ballot
    if (m.nodes.get('aa')!.epoch !== 1) shape.push(`ballot ${nth} committed: ${meshState(m)}`)
    settle(m, 10, [])
    mid.push(meshState(m))
  }
  fail(1)
  const again = () => {
    m.cut('aa', 'dd'); m.cut('aa', 'ee')
    for (let i = 0; i < 3; i++) m.tick('aa')
    m.giveUp('aa', 'dd'); m.giveUp('aa', 'ee')
    m.tick('aa')
  }
  again()
  if (proposals(m, 'aa') !== 'P(2,3) P(2,3)') shape.push(`aa did not re-open {aa,bb,cc} at 2: ${proposals(m, 'aa')}`)
  fail(2)
  again()
  if (proposals(m, 'aa') !== 'P(2,3) P(2,3) P(2,3)') shape.push(`aa did not open {aa,bb,cc} at 2 a third time: ${proposals(m, 'aa')}`)
  settle(m, 20, [['aa', 'dd'], ['aa', 'ee'], ['dd', 'aa'], ['ee', 'aa']])
  if (m.nodes.get('aa')!.epoch !== 2) shape.push(`the third ballot did not commit: ${meshState(m)}`)
  return outcomeM(m, shape, quietSplit(m), mid)
}

//! lateView — the release racing a LATE VIEW: aa evicts dd and ee at 2 on bb's and cc's grants and installs; every
// frame INTO cc is held back (a slow link into one node), everything else lands and everyone ticks LATE_VIEW_ROUNDS
// rounds — bb installs 2 and floods it, dd and ee install 2 evicted — then the late frames land in order. Today's
// kernel at the mid point: cc is WRITABLE at view 1 (every link up, a majority of view 1 reachable) beside aa and bb
// writable at 2: two writable views, the evictTwo shape in its one-round-trip window (red today, the quiet-point
// test's witness). Under the rule cc is held until a VIEW at or above its vote lands; the proposer's answer to a held
// voter's question, once it holds a view at or above the vote, is that VIEW and never a release — on one FIFO link
// the answer cannot overtake the view. The end: cc at 2. The hold-back is 24 rounds, LONGER than the clock the
// rejected variant of DESIGN-LEAVE §10.10.4 used (proposalAge + 2 = 12 ticks): a hold that ends on that clock ends
// here with the VIEW still in flight and the mid point shows two writable views again — the shape with the VIEW late
// rather than lost, which is what a clock cannot tell apart (the second review: at 12 rounds the bound was never
// crossed and the shape had no teeth against it).
export const LATE_VIEW_ROUNDS = 24
export const lateView = (): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa'); m.deliver('cc', 'aa')
  if (m.nodes.get('aa')!.epoch !== 2) shape.push(`aa did not commit {aa,bb,cc}@2: ${meshState(m)}`)
  for (let r = 0; r < LATE_VIEW_ROUNDS; r++) { drainExcept(m, 'cc'); for (const u of m.nodes.keys()) m.tick(u) }
  drainExcept(m, 'cc')
  const mid = meshState(m)
  if (m.nodes.get('cc')!.epoch !== 1) shape.push(`cc learned the view before the late frames landed: ${mid}`)
  //! the late frames land, in the order each link queued them
  for (const k of [...m.q.keys()].filter((k) => k.endsWith('>cc'))) allOf(m, k.split('>')[0], 'cc')
  settle(m, 10, [])
  return outcomeM(m, shape, quietSplit(m), [mid])
}

// ── the second review's shapes (DESIGN-LEAVE §10.10, 2026-10-10): what a stayer may count, who may lead, and two
// costs of the rule, each one fixed schedule on real Nodes ──
//! writableViews — how many DIFFERENT views are writable on the mesh right now (epoch-0 nodes are in no view)
export const writableViews = (m: Mesh) => new Set([...m.nodes.values()].filter((x) => x.epoch > 0 && x.membership.gate(x).open).map((x) => `${x.epoch}:${x.membership.view.members.map((v) => v[0])}`)).size
//! rounds — every frame lands and everyone ticks, `n` times over, with no chain giving up (the quiet-point check's
// own cadence, sim/mesh.ts quietSplit): the cut pairs stay "still dialing", so nobody evicts and the shape stands still
const rounds = (m: Mesh, n: number, skip?: string) => { for (let r = 0; r < n; r++) { drain(m); for (const u of m.nodes.keys()) if (u !== skip) m.tick(u) } drain(m) }

//! lateAsk — the stayer's count when the HELD member's heartbeat is late (the second review's blocker against a
// two-tick memory of the held member's ask). evictTwo's witness shape: {aa,bb} cut from {dd,ee}; aa evicts both at 2
// on bb's and cc's grants and installs `{aa,bb,cc}`@2; cc is cut from aa and bb before the VIEW reaches it. Six quiet
// rounds settle it. Then cc's timer does not fire for four rounds while everyone else ticks and every frame lands —
// a GC pause, a slow scheduler — and then it ticks once more. `mid` is the state after each late round and after cc
// ticks again. Today's kernel: cc is writable at view 1 with dd and ee beside aa and bb at 2 throughout — two
// writable views at every point (red today: the quiet-point test's witness, drawn out). A rule that holds cc must
// keep dd and ee from counting cc HOWEVER late cc's timer is: a stayer whose memory of the ask expires on a clock
// counts cc again when the clock runs out, and dd and ee are writable at view 1 beside aa and bb at 2 — the split
// back, with every link up and every frame landed. The pin is the exact state at every point and the number of
// writable views at each.
export const lateAsk = (): OutcomeM => {
  const shape: string[] = []
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'])
  for (const a of ['aa', 'bb']) for (const b of ['dd', 'ee']) m.cut(a, b)
  for (let i = 0; i < 3; i++) m.tick('aa')
  for (const b of ['dd', 'ee']) m.giveUp('aa', b)
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(2,3)') shape.push(`aa did not evict dd and ee at 2: ${proposals(m, 'aa')}`)
  for (const x of ['bb', 'cc']) { m.deliver('aa', x); m.deliver(x, 'aa') }
  if (m.nodes.get('aa')!.epoch !== 2) shape.push(`aa did not commit {aa,bb,cc}@2: ${meshState(m)}`)
  m.cut('aa', 'cc'); m.cut('bb', 'cc')
  rounds(m, 6)
  if (m.nodes.get('cc')!.epoch !== 1) shape.push(`cc learned view 2: ${meshState(m)}`)
  const mid: string[] = []
  for (let late = 1; late <= 4; late++) { rounds(m, 1, 'cc'); mid.push(`late ${late}: ${meshState(m)} | writable views ${writableViews(m)}`) }
  rounds(m, 1)
  mid.push(`cc ticks: ${meshState(m)} | writable views ${writableViews(m)}`)
  return outcomeM(m, shape, quietSplit(m, 0), mid)
}

//! allHeld — every live member holds a vote for the dead proposer's view (the second review's major): n=7 at view
// 1; ff and gg are down; aa evicts both at 2 — `{aa,bb,cc,dd,ee}`, two apart from view 1 — bb, cc, dd and ee grant,
// and aa dies for good, with the ballot open or committed with its VIEW unsent. Four of seven alive and fully linked:
// a majority of view 1 and four of the five members of the view they voted for. Today's kernel: bb, the lowest live,
// re-forms `{bb,cc,dd,ee}`@3, writable. A rule under which a held member may not lead leaves nobody to lead here, and
// the four are read-only for good with every link up and a majority of the held view reachable; a held member that
// leads a ballot JOINT over its own hold re-forms them as today. Pinned as the end state (live today).
export const allHeld = (variant: 'open' | 'committed'): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg']
  const m = Mesh.formed(ids)
  m.destroy('ff'); m.destroy('gg')
  for (let i = 0; i < 3; i++) m.tick('aa')
  for (const u of ['ff', 'gg']) m.giveUp('aa', u)
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(2,5)') shape.push(`aa did not evict ff and gg at 2: ${proposals(m, 'aa')}`)
  for (const u of ['bb', 'cc', 'dd', 'ee']) m.deliver('aa', u)
  if (variant === 'committed') { for (const u of ['bb', 'cc', 'dd', 'ee']) m.deliver(u, 'aa'); if (m.nodes.get('aa')!.epoch !== 2) shape.push(`aa did not commit {aa,bb,cc,dd,ee}@2: ${meshState(m)}`) }
  else if (m.nodes.get('aa')!.epoch !== 1) shape.push('aa committed before it died')
  for (const u of ['bb', 'cc', 'dd', 'ee']) if (m.nodes.get(u)!.membership.votedFor.e !== 2 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} does not hold a vote at 2 for aa`)
  m.destroy('aa')
  settle(m, 60, [...m.nodes.keys()].flatMap((u) => ['aa', 'ff', 'gg'].map((d) => [u, d] as [string, string])))
  return outcomeM(m, shape, quietSplit(m))
}

//! genesisProposerDies — the first proposer dies during genesis (the second review's major, the same hole at
// epoch 0): `n` fresh nodes, fully linked, no view yet; aa, the lowest, proposes view 1 over everyone; the others
// grant; aa dies with the ballot open, or after installing view 1 with its VIEW unsent. A granter's vote is for an
// n-member view and its own view is EMPTY: n members apart. Today's kernel: bb proposes `{bb,…}`@2 over the empty
// old view (past the vote it spent at 1) and the survivors form, writable. A rule that holds the granters and lets no
// held member lead never forms the cluster; a held member leading jointly over its hold forms it whenever a
// majority of the first view's members are reachable — and that is SAFER than today, which forms `{dd,ee}`@2
// beside a possible `{aa,…,ee}`@1 when two members are merely cut. Pinned as the end state (live today).
export const genesisProposerDies = (n: 3 | 5, variant: 'open' | 'committed'): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee'].slice(0, n)
  const m = new Mesh()
  for (const u of ids) m.add(u)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m.connect(ids[i], ids[j])
  for (const k of m.q.keys()) m.q.set(k, [])
  m.tick('aa')
  if (proposals(m, 'aa') !== `P(1,${n})`) shape.push(`aa did not propose view 1 over everyone: ${proposals(m, 'aa') || 'nothing'}`)
  for (const u of ids.slice(1)) m.deliver('aa', u)
  if (variant === 'committed') { for (const u of ids.slice(1)) m.deliver(u, 'aa'); if (m.nodes.get('aa')!.epoch !== 1) shape.push(`aa did not install view 1: ${meshState(m)}`) }
  else if (m.nodes.get('aa')!.epoch !== 0) shape.push('aa installed before it died')
  for (const u of ids.slice(1)) if (m.nodes.get(u)!.membership.votedFor.e !== 1 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} does not hold a vote at 1 for aa`)
  m.destroy('aa')
  settle(m, 60, ids.slice(1).map((u) => [u, 'aa'] as [string, string]))
  return outcomeM(m, shape, quietSplit(m))
}

//! proposerAndGranterDie — the proposer AND one granter of a two-evictee ballot die for good (the second review's
// minor: a liveness cost of the rule with no cut among the living): aa evicts dd and ee at 2 (`{aa,bb,cc}`), bb and
// cc grant, aa and bb die, open or committed with the VIEW unsent. cc, dd and ee are alive and fully linked. Today's
// kernel: cc, the lowest live, re-forms `{cc,dd,ee}`@3, writable — which is UNSAFE when aa and bb are merely cut
// (they are 2 of `{aa,bb,cc}` and writable at 2: evictTwo's shape seen from cc). Under the rule cc holds a vote for
// `{aa,bb,cc}`, a ballot joint over it needs two of its three members, and only cc is there: cc stays held, and dd
// and ee are held too once they grant the joint ballot (`{cc,dd,ee}` is two apart from view 1) — all three read-only
// for good with every link up (the third review: the first banner here said dd was a minority; it grants, so it is
// held). The CP answer, because from cc's seat dead and cut look the same; a new class beside "the far side of a
// cut". Pinned as the end state (live today), so the rule moves it only with the why. The shape checks that bb and
// cc granted (as allHeld does), so a drifted schedule cannot pass as the shape.
export const proposerAndGranterDie = (variant: 'open' | 'committed'): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc')
  if (variant === 'committed') { m.deliver('bb', 'aa'); m.deliver('cc', 'aa'); if (m.nodes.get('aa')!.epoch !== 2) shape.push('aa did not commit {aa,bb,cc}@2 on two grants') }
  else if (m.nodes.get('aa')!.epoch !== 1) shape.push('aa committed before it died')
  for (const u of ['bb', 'cc']) if (m.nodes.get(u)!.membership.votedFor.e !== 2 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} does not hold a vote at 2 for aa`)
  m.destroy('aa'); m.destroy('bb')
  settle(m, 60, [...m.nodes.keys()].flatMap((u) => [[u, 'aa'], [u, 'bb']] as [string, string][]))
  return outcomeM(m, shape, quietSplit(m))
}

//! keptBallotReversed — the kept ballot at n=4 in the order keptBallot does NOT draw (DESIGN-LEAVE §10.10.1; the
// second review drew it): the same duel and escalation, but aa's PROPOSE@3 lands at cc and dd BEFORE bb's VIEW 2 —
// they grant it from view 1 (one member apart: nothing to warn about) and THEN install view 2 from bb's flood; aa
// reads both VOTEs before any VIEW 2 reaches it and commits `{aa,cc,dd}`@3 over view 1, three of four old and three
// of three new. Then the same cuts as keptBallot. Today's kernel: aa and dd writable at 3 beside bb and cc at 2 at
// the quiet point, then two views at epoch 4 once the chains give up (red today, pinned exactly). A hold counted
// against the voter's OWN view re-reads cc's and dd's vote at the install of view 2 — now two apart — and holds them;
// a hold counted against the proposer's base would not (the ballot is one apart from its base).
export const keptBallotReversed = (): OutcomeM => {
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd'])
  const shape: string[] = []
  const node = (u: string) => m.nodes.get(u)!
  m.cut('aa', 'bb')
  for (let i = 0; i < 3; i++) { m.tick('aa'); m.tick('bb') }
  m.giveUp('aa', 'bb'); m.giveUp('bb', 'aa')
  m.tick('aa'); m.tick('bb')
  if (proposals(m, 'aa') !== 'P(2,3)' || proposals(m, 'bb') !== 'P(2,3)') shape.push(`the duel at 2: aa ${proposals(m, 'aa')}, bb ${proposals(m, 'bb')}`)
  allOf(m, 'bb', 'cc'); allOf(m, 'bb', 'dd'); allOf(m, 'cc', 'bb'); allOf(m, 'dd', 'bb')
  if (node('bb').epoch !== 2) shape.push(`bb did not commit {bb,cc,dd}@2: ${meshState(m)}`)
  allOf(m, 'aa', 'cc'); allOf(m, 'aa', 'dd'); allOf(m, 'cc', 'aa'); allOf(m, 'dd', 'aa')
  for (let i = 0; i < 20 && !proposals(m, 'aa').includes('P(3'); i++) { m.giveUp('aa', 'bb'); m.tick('aa') }
  if (proposals(m, 'aa') !== 'P(2,3) P(3,3)' || node('aa').epoch !== 1) shape.push(`aa did not escalate to 3 over view 1: ${proposals(m, 'aa')} at epoch ${node('aa').epoch}`)
  //! REVERSED: aa's PROPOSE@3 lands at cc and dd first (the queues are FIFO per direction; bb's VIEW 2 waits on bb→cc
  // and bb→dd), both grant from view 1; then bb's VIEW 2 lands and they install it
  allOf(m, 'aa', 'cc'); allOf(m, 'aa', 'dd')
  for (const u of ['cc', 'dd']) if (node(u).epoch !== 1 || node(u).membership.votedFor.e !== 3 || node(u).membership.votedFor.p !== 'aa') shape.push(`${u} did not grant aa at 3 from view 1: ${meshState(m)}`)
  allOf(m, 'bb', 'cc'); allOf(m, 'bb', 'dd')
  for (const u of ['cc', 'dd']) if (node(u).epoch !== 2) shape.push(`${u} did not install view 2 after its grant: ${meshState(m)}`)
  //! aa reads cc's and dd's VOTEs — queued before their VIEW 2 floods — and commits over view 1
  const upToView = (a: string, b: string) => { while ((m.q.get(a + '>' + b) ?? [])[0] && m.q.get(a + '>' + b)![0].verb !== VERB.VIEW) m.deliver(a, b) }
  upToView('cc', 'aa'); upToView('dd', 'aa')
  if (node('aa').epoch !== 3) shape.push(`aa did not commit {aa,cc,dd}@3 over view 1 on the two VOTEs: ${meshState(m)}`)
  m.cut('cc', 'aa'); m.cut('cc', 'dd'); m.cut('bb', 'dd')
  const quiet = quietSplit(m)
  settle(m, 30, [['aa', 'bb'], ['bb', 'aa'], ['aa', 'cc'], ['cc', 'aa'], ['cc', 'dd'], ['dd', 'cc'], ['bb', 'dd'], ['dd', 'bb']])
  return outcomeM(m, shape, quiet)
}

// ── the third review's shapes (DESIGN-LEAVE §10.10, 2026-10-10): whose word a stayer may read, the fresh link, and
// genesis — each one fixed schedule on real Nodes ──
//! clientAsk — a CLIENT's word teaches nothing (I-23). zz, a client, links into aa with a HELLO and then a PULL that
// both name a hold, `{e: 9, h: 'q1,q2,q3', p: 'q1'}`: three members that do not exist, nine epochs up. Then aa loses
// ee and evicts it. Today's kernel ignores both fields and commits `{aa,bb,cc,dd}`@2 on the first ballot. A rule
// that reads a hold from ANY admitted link and makes the proposer's ballot joint over it (the third review's minor
// against the first fixed scratch kernel: node.byUuid holds client uuids too) re-opens the same ballot every two
// ticks and never commits — one PULL from a client stops every ballot of the server it reached. Pinned as the end
// state and the proposal list (live today), so the build inherits the client case.
export const clientAsk = (): OutcomeM => {
  const shape: string[] = []
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'])
  const aa = m.nodes.get('aa')!
  const hold = [{ e: 9, h: 'q1,q2,q3', p: 'q1' }]
  aa.step({ kind: 'linkUp', link: 7777, dialed: false })
  aa.step({ kind: 'bytesIn', link: 7777, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1, v: hold }) })
  const zl = aa.links.get(7777)
  if (zl?.state !== LS.admitted || !zl.client) shape.push(`zz was not admitted as a client: state ${zl?.state}, client ${zl?.client}`)
  aa.step({ kind: 'bytesIn', link: 7777, bytes: encodeControl(VERB.PULL, { e: 1, vs: hold }) })
  m.cut('aa', 'ee')
  for (let i = 0; i < 3; i++) m.tick('aa')
  m.giveUp('aa', 'ee')
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(2,4)') shape.push(`aa did not open the eviction of ee at 2: ${proposals(m, 'aa') || 'nothing'}`)
  settle(m, 30, ['aa', 'bb', 'cc', 'dd'].map((u) => [u, 'ee'] as [string, string]))
  return outcomeM(m, shape, quietSplit(m), [`aa proposed: ${proposals(m, 'aa')}`])
}

//! freshLink — a held member's link to a stayer FLAPS (the third review's minor: the fresh-link window). evictTwo's
// witness, settled as in lateAsk: aa and bb at `{aa,bb,cc}`@2; cc cut from both before the VIEW; dd and ee cut from
// aa and bb. Then the cc-dd link drops and comes straight back: a fresh link, HELLO exchanged, both ends admitted.
// `mid` is the state the instant the link is admitted, before any frame on it lands, and once every frame has landed.
// Today's kernel: dd is writable at view 1 at both points — it holds nothing and counts cc's link as before the flap —
// beside aa and bb at 2 (the quiet-point witness again). A rule that holds cc must keep dd from counting cc on the
// fresh link from the FIRST instant: a stayer that forgets the old link's word at admit and learns the new one from
// an ask one round trip later is writable at view 1 for that round trip, across the cut, and settle flushes its parked
// writes into it — on every flap. The pin is the exact state and the number of writable views at both points.
export const freshLink = (): OutcomeM => {
  const shape: string[] = []
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'])
  for (const a of ['aa', 'bb']) for (const b of ['dd', 'ee']) m.cut(a, b)
  for (let i = 0; i < 3; i++) m.tick('aa')
  for (const b of ['dd', 'ee']) m.giveUp('aa', b)
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(2,3)') shape.push(`aa did not evict dd and ee at 2: ${proposals(m, 'aa')}`)
  for (const x of ['bb', 'cc']) { m.deliver('aa', x); m.deliver(x, 'aa') }
  if (m.nodes.get('aa')!.epoch !== 2) shape.push(`aa did not commit {aa,bb,cc}@2: ${meshState(m)}`)
  m.cut('aa', 'cc'); m.cut('bb', 'cc')
  rounds(m, 6)
  if (m.nodes.get('cc')!.epoch !== 1) shape.push(`cc learned view 2: ${meshState(m)}`)
  const mid: string[] = []
  m.cut('cc', 'dd'); m.connect('cc', 'dd')
  mid.push(`admitted: ${meshState(m)} | writable views ${writableViews(m)}`)
  drain(m)
  mid.push(`landed: ${meshState(m)} | writable views ${writableViews(m)}`)
  rounds(m, 2)
  return outcomeM(m, shape, quietSplit(m, 0), mid)
}

//! genesisProposerAndGranterDie — the genesis hold's cost (the third review's minor: the epoch-0 form of
// proposerAndGranterDie). n=3 genesis: aa proposes view 1 over everyone, bb and cc grant, aa dies with the ballot
// open or after installing view 1 with its VIEW unsent, and cc dies too. bb is the one survivor, at epoch 0 with a
// vote for `{aa,bb,cc}`@1 — three members apart from its empty view. `fresh`: a new node dd links to bb. `reborn`:
// aa and cc come back MEMORY-ONLY as the fresh identities a2 and c2 (V4-2/V4-3: a restart without a dir is a new
// uuid), linked to bb and each other. Today's kernel: bb, the lowest live, proposes `{bb,dd}`@2 over the empty old
// set and the two form; the reborn pair forms `{a2,bb,c2}`@1 on a2's and c2's votes alone (bb refuses, its vote is
// spent at 1, and installs the VIEW at epoch 0 — the rebirth rule: fresh uuids start the count again; in the
// `committed` variant that is a second view at epoch 1 beside the one aa installed, today's genesis class, so the
// reborn pair is drawn `open` only). Under the rule bb's hold makes every ballot it leads or grants joint over
// `{aa,bb,cc}`, which needs two of its three members, and a2 reads the same hold from bb's HELLO before it proposes:
// no view forms until an operator forgets the dead — the CP answer at epoch 0, because from bb's seat aa and cc dead
// look exactly like aa and cc cut and writable at `{aa,bb,cc}`@1. Pinned as the end states (live today), so the rule
// moves them only with that why.
export const genesisProposerAndGranterDie = (variant: 'open' | 'committed', who: 'fresh' | 'reborn'): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc']
  const m = new Mesh()
  for (const u of ids) m.add(u)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m.connect(ids[i], ids[j])
  for (const k of m.q.keys()) m.q.set(k, [])
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(1,3)') shape.push(`aa did not propose view 1 over everyone: ${proposals(m, 'aa') || 'nothing'}`)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc')
  if (variant === 'committed') { m.deliver('bb', 'aa'); m.deliver('cc', 'aa'); if (m.nodes.get('aa')!.epoch !== 1) shape.push(`aa did not install view 1: ${meshState(m)}`) }
  else if (m.nodes.get('aa')!.epoch !== 0) shape.push('aa installed before it died')
  for (const u of ['bb', 'cc']) if (m.nodes.get(u)!.membership.votedFor.e !== 1 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} does not hold a vote at 1 for aa`)
  m.destroy('aa'); m.destroy('cc')
  if (who === 'fresh') { m.add('dd'); m.connect('bb', 'dd') }
  else { m.add('a2'); m.add('c2'); m.connect('a2', 'bb'); m.connect('c2', 'bb'); m.connect('a2', 'c2') }
  settle(m, 60, [['bb', 'aa'], ['bb', 'cc']])
  //! `mid` (the fourth review): every node's proposal list and the shape of bb's vote — the epoch it is at and how
  // many earlier votes it carries. Today bb's vote is the one it gave aa at 1 and carries nothing. A rule that holds
  // bb re-proposes at every age-out (the frozen cluster) and must do so at the SAME epoch: without the same-members
  // clause of §10.10.2 the re-offer is refused, the epoch burns, and the list climbs — P(3,3), P(4,3) — while bb's
  // vote climbs with it and carries one earlier vote per burn.
  const vf = m.nodes.get('bb')!.membership.votedFor as { e: number; p: string; prior?: unknown[] }
  const mid = [`proposals: ${[...m.nodes.keys()].map((u) => `${u}=${proposals(m, u) || '-'}`).join(' ')}`, `bb vote: e=${vf.e} p=${vf.p} prior=${vf.prior?.length ?? 0}`]
  return outcomeM(m, shape, quietSplit(m), mid)
}

//! genesisSplit — today's kernel commits two views at ONE epoch at genesis (the third review's minor: §10.10.1 named
// the shape in passing as what the rule is safer than, and nothing drew it). n=5, HOSTLESS — as on this mesh, or an
// I-22 listener given no hosts; the Sim's cluster() gives every node every other as a host, so dd could never propose
// there. aa proposes view 1 over everyone and all four grant; aa installs it on bb's and cc's VOTEs; dd and ee are
// cut from aa, bb and cc before the VIEW reaches them. Today's kernel: aa evicts dd and ee (`{aa,bb,cc}`@2); dd, the
// lowest of its side, at epoch 0 with its vote spent at 1, proposes `{dd,ee}`@2 over the EMPTY old set, ee grants,
// and two views commit at epoch 2 — both writable at the quiet point, the recorder firing. Under the rule dd and ee
// each hold a vote for a five-member view, five apart from their empty view: dd's ballot is joint over it and needs
// three of its five members, so they stay at epoch 0 (open genesis, in no view). Pinned RED today as the exact quiet
// point, split list and end state.
export const genesisSplit = (): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee']
  const m = new Mesh()
  for (const u of ids) m.add(u)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m.connect(ids[i], ids[j])
  for (const k of m.q.keys()) m.q.set(k, [])
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(1,5)') shape.push(`aa did not propose view 1 over everyone: ${proposals(m, 'aa') || 'nothing'}`)
  for (const u of ids.slice(1)) m.deliver('aa', u)
  m.deliver('bb', 'aa'); m.deliver('cc', 'aa')
  if (m.nodes.get('aa')!.epoch !== 1) shape.push(`aa did not install view 1 on bb's and cc's grants: ${meshState(m)}`)
  for (const u of ['dd', 'ee']) if (m.nodes.get(u)!.membership.votedFor.e !== 1 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} does not hold a vote at 1 for aa`)
  for (const a of ['aa', 'bb', 'cc']) for (const b of ['dd', 'ee']) m.cut(a, b)
  const pairs: [string, string][] = []
  for (const a of ['aa', 'bb', 'cc']) for (const b of ['dd', 'ee']) pairs.push([a, b], [b, a])
  settle(m, 40, pairs)
  return outcomeM(m, shape, quietSplit(m))
}

// ── the fourth review's shapes (DESIGN-LEAVE §10.10, 2026-10-10): one pin per kernel line of the rule's wire, and the
// hold a HELLO alone announced — each one fixed schedule on real Nodes, or one seeded Sim run on real HELLOs ──
//! the hold a stranger names in clientGenesis and serverAsk: three members that do not exist, nine epochs up
const STRANGER_HOLD = [{ e: 9, h: 'q1,q2,q3', p: 'q1' }]
//! stranger — a link into aa from a uuid outside the mesh: a HELLO (a client's with `r: 1`) that names the hold, or
// a plain HELLO and then a PULL that names it. The mesh carries no frame on this link; aa's answers go nowhere.
const stranger = (m: Mesh, via: 'hello' | 'pull', client: boolean, e: number): void => {
  const aa = m.nodes.get('aa')!
  aa.step({ kind: 'linkUp', link: 7777, dialed: false })
  aa.step({ kind: 'bytesIn', link: 7777, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: client ? '' : 'sim:zz', ...(client ? { r: 1 } : {}), ...(via === 'hello' ? { v: STRANGER_HOLD } : {}) }) })
  if (via === 'pull') aa.step({ kind: 'bytesIn', link: 7777, bytes: encodeControl(VERB.PULL, { e, vs: STRANGER_HOLD }) })
}
//! clientGenesis — a CLIENT's word at epoch 0 (the fourth review: clientAsk goes red only when BOTH halves of the
// I-23 fix are gone, so each half needs its own shape). n=3, fully linked, no view yet; a client zz links into aa
// before genesis with a HELLO that names the hold (`hello`), or a plain client HELLO and then a PULL at epoch 0 that
// names it (`pull`). Then everyone ticks. Today's kernel: aa proposes view 1 over the three and it forms, `P(1,3)`
// once. A rule whose proposer reads the holds of EVERY linked uuid at epoch 0 (the formation set) and takes a
// client's word there makes aa's genesis ballot joint over three members that do not exist: nothing ever forms
// (`aa@0{} bb@0{} cc@0{}`, `P(1,3) P(1,3)`) — one client stops genesis. Pinned as the end state and aa's proposals.
export const clientGenesis = (via: 'hello' | 'pull'): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc']
  const m = new Mesh()
  for (const u of ids) m.add(u)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m.connect(ids[i], ids[j])
  for (const k of m.q.keys()) m.q.set(k, [])
  stranger(m, via, true, 0)
  const zl = m.nodes.get('aa')!.links.get(7777)
  if (zl?.state !== LS.admitted || !zl.client) shape.push(`zz was not admitted as a client: state ${zl?.state}, client ${zl?.client}`)
  settle(m, 20, [])
  return outcomeM(m, shape, quietSplit(m), [`aa proposed: ${proposals(m, 'aa') || 'nothing'}`])
}
//! serverAsk — a NON-MEMBER SERVER's word (the other half of I-23's fix): a formed five-node mesh; zz, a server that
// is in no view (a joiner that never knocked), links into aa with a HELLO and a PULL that both name the hold; then
// aa loses ee and evicts it. Today's kernel: `{aa,bb,cc,dd}`@2 on the first ballot, `P(2,4)` once — as clientAsk. A
// rule that widens a ballot with ANY linked server's holds, member or not, makes aa's every ballot joint over
// `{q1,q2,q3}` and nothing commits (`P(2,4)` three times, ee never evicted). Pinned as the end state and the
// proposals: only a MEMBER's word may widen a ballot (§10.10.6).
export const serverAsk = (): OutcomeM => {
  const shape: string[] = []
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'])
  stranger(m, 'hello', false, 1)
  m.nodes.get('aa')!.step({ kind: 'bytesIn', link: 7777, bytes: encodeControl(VERB.PULL, { e: 1, vs: STRANGER_HOLD }) })
  const zl = m.nodes.get('aa')!.links.get(7777)
  if (zl?.state !== LS.admitted || zl.client) shape.push(`zz was not admitted as a server: state ${zl?.state}, client ${zl?.client}`)
  m.cut('aa', 'ee')
  for (let i = 0; i < 3; i++) m.tick('aa')
  m.giveUp('aa', 'ee')
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(2,4)') shape.push(`aa did not open the eviction of ee at 2: ${proposals(m, 'aa') || 'nothing'}`)
  settle(m, 30, ['aa', 'bb', 'cc', 'dd'].map((u) => [u, 'ee'] as [string, string]))
  return outcomeM(m, shape, quietSplit(m), [`aa proposed: ${proposals(m, 'aa')}`])
}

//! helloHold — a hold a stayer learned from a HELLO ALONE, and its release (the fourth review's liveness finding
// against the scratch kernel: at epoch 0 no ask goes out, so a hold the HELLO announced was never taken back). n=5,
// hostless genesis: aa proposes view 1 over the five, bb and cc grant, aa installs it on their two VOTEs and is cut
// from everyone before the VIEW or the PROPOSEs to dd and ee land; the four give up on aa. bb, the lowest of the
// rest at epoch 0, proposes `{bb,cc,dd,ee}`@2 over the empty old set; dd grants it (a vote at 2 for a view four
// apart from its empty view); then bb is cut from cc and ee, so its PROPOSEs to them die and the ballot holds two of
// four on either kernel — it cannot commit (at n=4 it would: two of three IS a majority of the new set over an
// empty old one, today's genesis class). Then aa re-links to dd — a FRESH link, so dd's HELLO is where a hold would
// ride — and aa's VIEW 1 lands at dd: dd installs it, and its vote at 2 for `{bb,cc,dd,ee}` is now ONE apart from
// view 1, no hold; dd's answer lands at aa. aa re-links to cc the same way. Now aa holds links to cc and dd, three
// of its five: it must be writable. Today's kernel: aa is writable there (it reads no hold), and after three quiet
// rounds too. A rule that reads dd's hold from its HELLO must take it back when it ends, or aa stays `minority`
// with a reachable majority until a view change — and its own next ballot, joint over the phantom hold, may never
// commit: the release is a frame, never silence (§10.10.6), at epoch 0 too. `mid` is the exact state at the two
// points; the end is after the chains give up and aa evicts bb and ee.
export const helloHold = (): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee']
  const m = new Mesh()
  for (const u of ids) m.add(u)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m.connect(ids[i], ids[j])
  for (const k of m.q.keys()) m.q.set(k, [])
  const node = (u: string) => m.nodes.get(u)!
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(1,5)') shape.push(`aa did not propose view 1 over the five: ${proposals(m, 'aa') || 'nothing'}`)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa'); m.deliver('cc', 'aa')
  if (node('aa').epoch !== 1) shape.push(`aa did not install view 1 on bb's and cc's grants: ${meshState(m)}`)
  for (const u of ['bb', 'cc', 'dd', 'ee']) { m.cut('aa', u); m.giveUp(u, 'aa') }
  m.tick('bb')
  if (proposals(m, 'bb') !== 'P(2,4)') shape.push(`bb did not propose {bb,cc,dd,ee}@2 from epoch 0: ${proposals(m, 'bb') || 'nothing'}`)
  m.deliver('bb', 'dd'); m.deliver('dd', 'bb')
  if (node('dd').membership.votedFor.e !== 2 || node('dd').membership.votedFor.p !== 'bb') shape.push(`dd did not grant bb at 2: ${meshState(m)}`)
  m.cut('bb', 'cc'); m.cut('bb', 'ee')
  if (node('bb').epoch !== 0) shape.push(`bb committed on two of four: ${meshState(m)}`)
  const mid: string[] = []
  for (const u of ['dd', 'cc']) {
    m.connect('aa', u); allOf(m, 'aa', u)
    if (node(u).epoch !== 1) shape.push(`${u} did not install view 1 from aa: ${meshState(m)}`)
    allOf(m, u, 'aa')
  }
  mid.push(`aa with cc and dd: ${meshState(m)}`)
  rounds(m, 3)
  mid.push(`three rounds: ${meshState(m)}`)
  settle(m, 30, [['aa', 'bb'], ['bb', 'aa'], ['aa', 'ee'], ['ee', 'aa'], ['bb', 'cc'], ['cc', 'bb'], ['bb', 'ee'], ['ee', 'bb']])
  return outcomeM(m, shape, quietSplit(m), mid)
}

// ── the fifth round's shapes (DESIGN-LEAVE §10.10's last note, 2026-10-10; built 2026-10-12): the four items the fourth
// re-check left open for the build, each one fixed schedule on real Nodes ──
//! askAfterHello — a hold a stayer learned from NOTHING, because the held member announced it by a HELLO on ANOTHER link
// (item 1 of the note). n=5, hostless, aa never linked to ee: aa proposes `{aa,bb,cc,dd}`@1 over its four links, bb
// and cc grant, aa installs it and is cut from bb, cc and dd before the VIEW or dd's PROPOSE land. bb, at epoch 0 with
// its vote at 1 spent, proposes `{bb,cc,dd,ee}`@2 over its links; dd grants it — a vote for a view four apart from its
// empty view, a hold — and bb is cut from everyone, so its ballot sits on two of four, commits on neither kernel, and
// nothing can release dd's hold until bb is back. aa re-links to cc (cc installs view 1; its vote at 1 is for view 1
// itself, no hold) and then to dd: dd's HELLO on that fresh link is where its hold rides, and aa's VIEW 1 lands at dd,
// which installs it. dd's hold `{bb,cc,dd,ee}`@2 is TWO apart from `{aa,bb,cc,dd}` and stays. cc, linked to dd since
// genesis, has heard no word from dd: a kernel whose "last word" was set by the HELLO on aa's link skips the install's
// ask (the holds did not change) and cc counts dd — three of four with aa, writable, while dd is read-only — until
// dd's next tick. The pin is the state the instant dd's install has landed everywhere (no tick) and after one round.
// Then bb re-links to dd, learns view 1, drops its ballot and disowns dd's hold at its next ask; the end is live.
// Today's kernel reads no hold: everyone writable.
export const askAfterHello = (): OutcomeM => {
  const shape: string[] = []
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee']
  const m = new Mesh()
  for (const u of ids) m.add(u)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!(ids[i] === 'aa' && ids[j] === 'ee')) m.connect(ids[i], ids[j])
  for (const k of m.q.keys()) m.q.set(k, [])
  const node = (u: string) => m.nodes.get(u)!
  m.tick('aa')
  if (proposals(m, 'aa') !== 'P(1,4)') shape.push(`aa did not propose {aa,bb,cc,dd}@1 over its four links: ${proposals(m, 'aa') || 'nothing'}`)
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa'); m.deliver('cc', 'aa')
  if (node('aa').epoch !== 1) shape.push(`aa did not install {aa,bb,cc,dd}@1 on bb's and cc's grants: ${meshState(m)}`)
  for (const u of ['bb', 'cc', 'dd']) { m.cut('aa', u); m.giveUp(u, 'aa') }
  m.tick('bb')
  if (proposals(m, 'bb') !== 'P(2,4)') shape.push(`bb did not propose {bb,cc,dd,ee}@2 from epoch 0: ${proposals(m, 'bb') || 'nothing'}`)
  m.deliver('bb', 'dd'); m.deliver('dd', 'bb')
  if (node('dd').membership.votedFor.e !== 2 || node('dd').membership.votedFor.p !== 'bb') shape.push(`dd did not grant bb at 2: ${meshState(m)}`)
  for (const u of ['cc', 'dd', 'ee']) m.cut('bb', u)
  if (node('bb').epoch !== 0) shape.push(`bb committed on two of four: ${meshState(m)}`)
  //! cc first (it must hold view 1 to count anyone), then dd: its HELLO on the fresh link names the hold, the VIEW lands
  for (const u of ['cc', 'dd']) {
    m.connect('aa', u); allOf(m, 'aa', u)
    if (node(u).epoch !== 1) shape.push(`${u} did not install view 1 from aa: ${meshState(m)}`)
  }
  drain(m)
  const mid = [`dd installed: ${meshState(m)}`]
  rounds(m, 1)
  mid.push(`one round: ${meshState(m)}`)
  m.connect('bb', 'dd') // bb is back: it learns view 1 from dd and can answer dd's ask
  settle(m, 30, [['aa', 'bb'], ['bb', 'aa'], ['bb', 'cc'], ['cc', 'bb'], ['bb', 'ee'], ['ee', 'bb']])
  return outcomeM(m, shape, quietSplit(m), mid)
}

//! lostRelease — a release that dies on the link, and the fresh HELLO that must stand in for it (item 2 of the note,
// the `onAdmit` line that takes a peer's old word back when its HELLO names no hold). aa opens the two-evictee ballot
// `{aa,bb,cc}`@2; dd is cut from cc and ee, so once aa re-links to it its count rests on aa and bb alone. bb and cc
// grant (held; bb's ask reaches dd), bb's VOTE lands, dd and ee come back and aa abandons the ballot. bb and cc ask aa
// on their tick and aa disowns both; bb's empty ask — the release — is queued to dd and the bb-dd link is CUT before it
// lands. Then the link comes back: bb's HELLO names no hold, and dd must count bb again. A kernel that only ever ADDS
// what a HELLO names keeps bb's old word for good (bb holds nothing, so it never asks again) and dd sits `minority`
// with aa and bb linked, three of five. Today's kernel reads no hold: dd writable throughout.
export const lostRelease = (): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2)
  m.cut('cc', 'dd'); m.cut('dd', 'ee')
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa')
  for (const u of ['bb', 'cc']) if (m.nodes.get(u)!.membership.votedFor.e !== 2 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} did not grant aa at 2: ${meshState(m)}`)
  m.connect('aa', 'dd'); m.connect('aa', 'ee'); m.tick('aa') // dd and ee are back: the ballot is abandoned; cc's VOTE lands on no ballot below
  if (m.nodes.get('aa')!.epoch !== 1) shape.push(`aa committed before the abandon: ${meshState(m)}`)
  drain(m)
  const mid = [`abandoned: ${meshState(m)}`]
  for (const u of ['bb', 'cc']) m.tick(u) // the ask on the tick
  allOf(m, 'bb', 'aa'); allOf(m, 'cc', 'aa'); allOf(m, 'aa', 'bb'); allOf(m, 'aa', 'cc') // the asks land, the disowns come back
  m.cut('bb', 'dd') // bb's release toward dd dies with the link
  drain(m)
  mid.push(`released, the bb-dd frame lost: ${meshState(m)}`)
  m.connect('bb', 'dd') // the fresh link: bb's HELLO names no hold
  drain(m)
  mid.push(`re-linked: ${meshState(m)}`)
  settle(m, 10, [])
  return outcomeM(m, shape, quietSplit(m), mid)
}

//! askAtAdmit — the holds change while a HELLO is in flight (item 2 of the note, the other `onAdmit` line: the ask on
// the fresh link when the holds are not what its HELLO said). The same ballot; dd is cut from bb, cc and ee, so it has
// heard nothing. bb and cc grant and are held. Then the bb-dd link OPENS: bb's HELLO leaves naming its hold, and before
// either HELLO lands dd and ee come back, aa abandons, bb and cc ask, and aa disowns — bb's release goes to its admitted
// member links, and the dd link is not one yet. Then the HELLOs land: dd admits bb knowing the hold the HELLO carried,
// a hold that no longer exists; bb admits dd and, its holds not being what that HELLO said, asks on this link at once.
// A kernel without that line leaves dd `minority` for good (bb never asks again). Today's kernel: dd writable at
// every point, reading no hold.
export const askAtAdmit = (): OutcomeM => {
  const shape: string[] = []
  const m = evictionBallot(shape, 2)
  m.cut('bb', 'dd'); m.cut('cc', 'dd'); m.cut('dd', 'ee')
  m.deliver('aa', 'bb'); m.deliver('aa', 'cc'); m.deliver('bb', 'aa')
  for (const u of ['bb', 'cc']) if (m.nodes.get(u)!.membership.votedFor.e !== 2 || m.nodes.get(u)!.membership.votedFor.p !== 'aa') shape.push(`${u} did not grant aa at 2: ${meshState(m)}`)
  const link = m.open('bb', 'dd') // bb's HELLO leaves now, with the hold on it
  m.connect('aa', 'dd'); m.connect('aa', 'ee'); m.tick('aa')
  if (m.nodes.get('aa')!.epoch !== 1) shape.push(`aa committed before the abandon: ${meshState(m)}`)
  drain(m)
  for (const u of ['bb', 'cc']) m.tick(u)
  allOf(m, 'bb', 'aa'); allOf(m, 'cc', 'aa'); allOf(m, 'aa', 'bb'); allOf(m, 'aa', 'cc')
  drain(m)
  const mid = [`released before the admit: ${meshState(m)}`]
  link.land()
  mid.push(`admitted: ${meshState(m)}`)
  drain(m)
  mid.push(`landed: ${meshState(m)}`)
  settle(m, 10, [])
  return outcomeM(m, shape, quietSplit(m), mid)
}

//! freshLinkSim — freshLink on REAL HELLOs (the fourth review: the mesh writes its own HELLO for every link, so
// freshLink tests the mesh's copy of the rule and never the node's own HELLO). evictTwo's cut shape in the Sim:
// n04 and n05 cut from n01 and n02; n01 evicts both at 2 on n03's grant; the VIEW to n03 dies on the sever and n03
// is cut from n01 and n02 the instant n01 is at 2. 1.5 s later the n03-n04 and n03-n05 links FLAP: partitioned, healed
// 30 ms later, re-dialed and re-admitted with a real HELLO each way. The far side's writable split is sampled every
// ms for 4 s from the flap: a ms counts when a far-side node (n03, n04, n05) is WRITABLE at view 1 beside a node
// writable at a higher view — the evictTwo split itself, and not the ordinary propagation of a view change nor the
// far side's own later view (item 3 of §10.10's last note: the first version counted every writable split in the
// window and never checked the shape, so a correct kernel could read non-zero on timing). The run is "not the shape"
// unless n01's view at 2 evicts BOTH n04 and n05. The line is the three far-side gates before the flap, the count of
// split-ms, n04's gateOpen rows in the window, and the monitors' count. Today's kernel: n03 is writable at 1 with n04
// and n05 beside n01 and n02 at 2 until n03 leads them into `{n03,n04,n05}`@3 (counted up to there; the split goes
// on, at 2 against 3, uncounted here and caught by the monitors). A rule that holds n03 shows 0 everywhere ONLY when
// n03's own HELLO carries its hold: without it n04 admits the fresh link not knowing the hold, counts n03 for the
// round trip until n03's ask lands, and writes at 1 beside n01 at 2. Pinned exactly per seed and link delay, so a
// kernel change moves it only with the why.
export const freshLinkSim = (seed: number, delay: [number, number]): string => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, 5, { heartbeatMs: 50, durable: true, fault: { delay } })
  sim.run({ until: 800 })
  const label = `seed ${seed} delay ${delay.join('-')}:`
  if (!nodes.every((x) => x.epoch === 1)) return `${label} not the shape: never formed`
  for (const f of ['n04', 'n05']) { sim.partition('n01', f); sim.partition('n02', f) }
  sim.severOnFrame('n01', 'n03', VERB.VIEW)
  //! the split this shape is about: a far-side node writable at view 1 beside anyone writable at a higher view
  const farSplit = (): boolean => {
    const open = [...sim.nodes.values()].filter((x) => x.membership.gate(x).open)
    return open.some((x) => x.epoch === 1 && ['n03', 'n04', 'n05'].includes(x.uuid)) && open.some((x) => x.epoch > 1)
  }
  //! the sample clock is `t` (sim.now is the last event's time and lags it): the window is the 4000 samples from the flap
  const t0 = sim.now
  let voted = -1, cutAt = -1, flapAt = -1, healAt = -1, hits = 0, before = ''
  const gateOf = (u: string) => { const n = sim.nodes.get(u)!; return `${u}:${n.membership.gate(n).reason || 'W'}` }
  for (let t = t0; t <= t0 + 12000; t += 1) {
    sim.run({ until: t })
    if (voted < 0 && nodes[2].journal.read().some((e) => e.kind === JK.vote && e.a === 2 && e.b === 1 && e.c === 'n01')) voted = t
    if (voted >= 0 && cutAt < 0 && nodes[0].epoch >= 2) {
      cutAt = t; sim.partition('n01', 'n03'); sim.partition('n02', 'n03')
      if (members(nodes[0]).join() !== 'n01,n02,n03') return `${label} not the shape: n01's view at 2 is {${members(nodes[0])}}, not the two-evictee one`
    }
    if (cutAt >= 0 && flapAt < 0 && t >= cutAt + 1500) { flapAt = t; before = ['n03', 'n04', 'n05'].map(gateOf).join(' '); for (const f of ['n04', 'n05']) sim.partition('n03', f) }
    if (flapAt >= 0 && healAt < 0 && t >= flapAt + 30) { healAt = t; for (const f of ['n04', 'n05']) sim.heal('n03', f) }
    if (flapAt >= 0 && farSplit()) hits++
    if (flapAt >= 0 && t >= flapAt + 3999) break
  }
  if (voted < 0) return `${label} not the shape: n03 never granted the eviction`
  if (cutAt < 0) return `${label} not the shape: n01 never committed`
  if (healAt < 0) return `${label} not the shape: the flap never came`
  const opens = sim.nodes.get('n04')!.journal.read().filter((e) => e.kind === JK.gateOpen).length
  return `${label} before [${before}] split-ms ${hits} of 4000; n04 gateOpen rows ${opens}; monitors ${sim.violations.length ? 'fired' : 'quiet'}`
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
