//! The leave sweep's generators and runners (V4-6 on today's kernel, the I-20 salvage, 2026-10-08). A plain module,
// not a test: sim/leave-sweep.test.ts imports it and asserts; a scratch script can import it too, to run more seeds
// or re-derive the known-not-live sets when the kernel's liveness changes on purpose, without running the sweep as
// a side effect (node:test runs every test() call at import time). The families themselves are described in the
// test file's banner.
import { Sim } from './exec.ts'
import { cluster } from './harness.ts'
import { converged } from './monitors.ts'
import { VERB } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import type { Node, NodeOpts } from '../kernel/node.ts'

const mul = (seed: number) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const members = (x: Node) => x.membership.view.members.map((m) => m[0])

//! split — the end-state SAFETY check: two nodes WRITABLE in different views. The per-event monitor sees two views at
// one epoch; this sees what it cannot — a stale majority writable at a lower epoch beside the view without it.
// Checked at a quiet point, never mid-flood. A node at epoch 0 holds no committed view (open genesis: a newcomer
// before any view reached it), so it is not writable IN a view and is not one side of this split — the same rule as
// the mesh's quietSplit (sim/mesh.ts), so the two checks name one invariant.
export const split = (sim: Sim): string | null => {
  const open = [...sim.nodes.values()].filter((x) => x.epoch > 0 && x.membership.gate(x).open)
  const views = new Set(open.map((x) => `${x.epoch}:${members(x)}`))
  return views.size > 1 ? `SPLIT: writable in different views: ${open.map((x) => `${x.uuid}@${x.epoch}{${members(x)}}`).join(' ')}` : null
}
//! verdict — what went wrong at the end of a schedule (empty = safe AND live). The SAFETY problems come first and
// start with VIOLATION or SPLIT; everything after is liveness: every node left holds the one wanted view, writable,
// and the data converged.
export const verdict = (sim: Sim, want: string[]): string[] => {
  const live = [...sim.nodes.values()]
  const problems: string[] = []
  if (sim.violations.length) problems.push('VIOLATION ' + JSON.stringify(sim.violations.slice(0, 2)))
  const sp = split(sim)
  if (sp) problems.push(sp)
  if (new Set(live.map((x) => x.epoch)).size !== 1) problems.push('epochs differ ' + live.map((x) => `${x.uuid}@${x.epoch}`))
  for (const x of live) {
    if (members(x).join() !== want.join()) problems.push(`${x.uuid} members ${members(x)} want ${want}`)
    const g = x.membership.gate(x)
    if (!g.open) problems.push(`${x.uuid} gate ${g.reason}`)
  }
  const c = converged(sim)
  if (c) problems.push('not converged: ' + c)
  return problems
}
export const unsafe = (problems: string[]) => problems.some((p) => p.startsWith('VIOLATION') || p.startsWith('SPLIT'))

// ── family 1: stalls, slow links, lingering leavers, a join ──
export interface Schedule { seed: number; n: number; ids: string[]; leavers: string[]; stalls: [string, string, number][]; stall: { node: string; ms: number } | null; offsets: number[]; linger: number[]; join: boolean }

//! schedule — the seeded shape: who leaves when, which links are slow, who is stalled, who lingers, whether someone joins
export const schedule = (seed: number): Schedule => {
  const r = mul(seed * 7919 + 17)
  const n = 2 + Math.floor(r() * 4) // 2..5
  const k = 1 + Math.floor(r() * Math.min(3, n - 1)) // 1..min(3, n-1) leavers
  const ids = Array.from({ length: n }, (_, i) => `n0${i + 1}`)
  const leavers = [...ids].sort(() => r() - 0.5).slice(0, k).sort()
  //! slow links: constant delays small enough that a ballot can still complete (RTT < PROPOSAL_AGE × 50 ms)
  const stalls: [string, string, number][] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (r() < 0.35) stalls.push([ids[i], ids[j], pick(r, [3, 30, 60, 100])])
  //! a STALLED survivor: its process is paused for D ms (longer than the four-tick bound), then it wakes and reads
  // everything at once (sim.pause; DESIGN-LEAVE §10.7). `RunOpts.stall` scales D to put it past the knock window.
  const survivors = ids.filter((u) => !leavers.includes(u))
  const stall = r() < 0.6 ? { node: pick(r, survivors), ms: pick(r, [250, 300, 450, 700]) } : null
  const offsets = leavers.map(() => pick(r, [0, 0, 0, 10, 60, 120]))
  const linger = leavers.map(() => pick(r, [0, 0, 0, 100, 400, 1200])) // ms a leaver keeps running after `left`
  const join = r() < 0.25
  return { seed, n, ids, leavers, stalls, stall, offsets, linger, join }
}

//! RunOpts — the knobs the knock window's tests turn (DESIGN-LEAVE §10.7): `tune` rows for every member (the window,
// leaveWindow), and `stall`, a factor on the schedule's stall length (3 puts every stall but the shortest past the
// default 16-tick window: 750/900/1350/2100 ms against 800). The generator is untouched, so a seed is the same shape
// under every knob and the pinned sets stay comparable.
export interface RunOpts { tune?: NodeOpts['tune']; stall?: number }

//! run — one schedule to its horizon; returns what went wrong (empty = safe AND live)
export const run = (s: Schedule, horizon = 12000, o: RunOpts = {}): string[] => {
  const sim = new Sim(s.seed)
  const nodes = cluster(sim, s.n, { heartbeatMs: 50, fault: { delay: [3, 3] }, ...(o.tune !== undefined ? { tune: o.tune } : {}) })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  for (const [a, b, d] of s.stalls) sim.fault(a, b, { delay: [d, d] })
  const t0 = sim.now
  //! the stall is a PAUSE of the survivor's process (sim.pause): frames pile up in its socket buffers and its one
  // armed heartbeat waits; at the wake it reads everything at once, as a process does after a long GC pause or a
  // swap-in. It used to be a constant delay on every link of the node, lifted once the leavers were gone — but a
  // delay keeps the node running and late, so a knock and each answer paid the stall in turn (four stalls per round
  // trip), and with the leaver knocking on (§10.7) the lift never came while it lived. The old model wedged every
  // stalled schedule for a reason no pause has; this one lets the survivor wake INSIDE the window, the shape the
  // window exists for (re-derived on the base kernel under this model first: the pinned set did not move).
  if (s.stall) sim.pause(s.stall.node, Math.round(s.stall.ms * (o.stall ?? 1)))
  s.leavers.forEach((u, i) => sim.post(u, { kind: 'leave' }, s.offsets[i]))
  let joiner: Node | null = null
  if (s.join) {
    const survivor = s.ids.find((u) => !s.leavers.includes(u))!
    joiner = sim.add({ uuid: 'n09', listen: 'sim:n09', hosts: [`sim:${survivor}`], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
    sim.post('n09', { kind: 'start' }, 30)
  }
  const gone = new Map<string, number>()
  const left = new Map<string, number>()
  let lastGone = t0
  for (let u = sim.now; u <= t0 + horizon; u += 5) {
    sim.run({ until: u })
    for (let i = 0; i < s.leavers.length; i++) {
      const id = s.leavers[i]
      if (gone.has(id) || !sim.left.has(id)) continue
      if (!left.has(id)) left.set(id, sim.now)
      if (sim.now < left.get(id)! + s.linger[i]) continue // a leaver that keeps running after its leave timed out
      for (const o of sim.nodes.keys()) if (o !== id) sim.partition(id, o)
      sim.nodes.get(id)!.destroy(); sim.nodes.delete(id)
      gone.set(id, sim.now); lastGone = sim.now
    }
    if (gone.size === s.leavers.length && sim.now > lastGone + 7000) break
  }
  if (gone.size !== s.leavers.length) return ['leaver never answered: ' + s.leavers.filter((u) => !gone.has(u))]
  return verdict(sim, [...s.ids.filter((u) => !s.leavers.includes(u)), ...(joiner ? ['n09'] : [])].sort())
}

// ── family 2: cuts and heals, leavers restarted from disk ──
export interface Schedule2 { seed: number; n: number; ids: string[]; leavers: string[]; delay: [string, string, number][]; cuts: [string, string, number, number][]; offsets: number[]; restart: number[] }

//! schedule2 — the seeded shape: who leaves when, per-pair delays, which pairs are cut when and for how long, and
// which leavers come back from their dir (ms after they were torn down; -1 = never)
export const schedule2 = (seed: number): Schedule2 => {
  const r = mul(seed * 104729 + 3)
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
  const restart = leavers.map(() => (r() < 0.4 ? pick(r, [0, 100, 500, 1500]) : -1))
  return { seed, n, ids, leavers, delay, cuts, offsets, restart }
}

//! run2 — one family-2 schedule: a durable cluster; a leaver is torn down the moment its leave is answered (cut from
// everyone, like the shell), and comes back FROM ITS DIR after `restart` ms when asked to — a node that was leaving
// and may be OUT of a view it never saw. Wanted at the end: the survivors plus every leaver that came back, in one
// view, writable. `o.tune` sets the members' tune rows (the knock window's tests).
export const run2 = (s: Schedule2, horizon = 30000, o: RunOpts = {}): string[] => {
  const sim = new Sim(s.seed)
  const nodes = cluster(sim, s.n, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] }, ...(o.tune !== undefined ? { tune: o.tune } : {}) })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  for (const [a, b, d] of s.delay) sim.fault(a, b, { delay: [d, d] })
  const gone = new Map<string, number>(), back = new Set<string>()
  const down = (u: string) => gone.has(u) && !back.has(u)
  for (const [a, b, at, dur] of s.cuts) { sim.at(at, () => sim.partition(a, b)); sim.at(at + dur, () => { if (!down(a) && !down(b)) sim.heal(a, b) }) }
  s.leavers.forEach((u, i) => sim.post(u, { kind: 'leave' }, s.offsets[i]))
  const t0 = sim.now
  let last = t0 + Math.max(0, ...s.cuts.map((c) => c[2] + c[3]))
  for (let t = sim.now; t <= t0 + horizon; t += 5) {
    sim.run({ until: t })
    s.leavers.forEach((u, i) => {
      if (!gone.has(u) && sim.left.has(u) && sim.nodes.has(u)) {
        for (const o of sim.nodes.keys()) if (o !== u) sim.partition(u, o)
        if (s.restart[i] < 0) { sim.nodes.get(u)!.destroy(); sim.nodes.delete(u) }
        gone.set(u, sim.now); last = Math.max(last, sim.now)
      }
      if (gone.has(u) && !back.has(u) && s.restart[i] >= 0 && sim.now >= gone.get(u)! + s.restart[i]) {
        back.add(u)
        for (const o of s.ids) if (o !== u) sim.heal(u, o)
        sim.left.delete(u)
        sim.restart(u)
        last = Math.max(last, sim.now)
      }
    })
    if (gone.size === s.leavers.length && s.leavers.every((u, i) => s.restart[i] < 0 || back.has(u)) && sim.now > last + 9000) break
  }
  if (gone.size !== s.leavers.length) return ['leaver never answered: ' + s.leavers.filter((u) => !gone.has(u))]
  return verdict(sim, s.ids.filter((u) => !s.leavers.includes(u) || back.has(u)).sort())
}

export const shape1 = (s: Schedule) => `${s.seed} n=${s.n} leavers=${s.leavers} stall=${s.stall ? `${s.stall.node}/${s.stall.ms}` : '-'} slow=${s.stalls.map((x) => x.join(':')).join(',')} offsets=${s.offsets} linger=${s.linger}${s.join ? ' join' : ''}`
export const shape2 = (s: Schedule2) => `${s.seed} n=${s.n} leavers=${s.leavers} cuts=${JSON.stringify(s.cuts)} restart=${s.restart} slow=${s.delay.filter((d) => d[2] > 3).map((d) => d.join(':')).join(',')}`

// ── family 3: the two shapes the parked I-20 drafts split on, seeded — SAFETY only ──
export interface Schedule3 { seed: number; kind: 'cut-apart' | 'restart-split'; n: number; near: number; far: number; offsets: number[] }

export const schedule3 = (seed: number): Schedule3 => {
  const r = mul(seed * 7907 + 11)
  const kind = seed % 2 === 1 ? 'cut-apart' : 'restart-split'
  const n = kind === 'cut-apart' ? 4 : 3 // at n=5 the fifth member's one live vote settles the duel; the duel needs the two leavers alone
  return { seed, kind, n, near: pick(r, [3, 5, 8]), far: pick(r, [20, 40, 60]), offsets: [pick(r, [0, 0, 5, 20]), pick(r, [0, 0, 5, 20])] }
}

//! run3 — one family-3 schedule; returns the safety problems (empty = safe). Two quiet points: before the heal and at
// the end. A seed whose timing misses the shape says so ('not the shape') and proves nothing either way.
export const run3 = (s: Schedule3): string[] => {
  const sim = new Sim(s.seed)
  const problems: string[] = []
  const check = (at: string) => {
    if (sim.violations.length) problems.push(`VIOLATION at ${at}: ` + JSON.stringify(sim.violations.slice(0, 1)))
    const sp = split(sim)
    if (sp) problems.push(`${sp} at ${at}`)
  }
  if (s.kind === 'cut-apart') {
    const nodes = cluster(sim, s.n, { heartbeatMs: 50, fault: { delay: [3, 3] } })
    sim.run({ until: 600 })
    if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
    //! n01 and n02 lose each other; the eviction each would open waits for its redial chain to give up
    sim.partition('n01', 'n02')
    const gaveUp = () => nodes[1].journal.read().some((e) => e.kind === JK.giveUp && e.a === 'sim:n01')
    for (let t = sim.now; t <= 6000 && !gaveUp(); t += 5) sim.run({ until: t })
    if (!gaveUp()) return ['not the shape: n02 never gave up on n01']
    //! the leaves land as the chain gives up: n02 is near both leavers and asks them first; n01 is far from both. Each
    // side is the lowest live member in its own eyes and opens a ballot at the same epoch asking the same two leavers:
    // vote-once must let at most one of them commit
    const [l1, l2] = ['n03', 'n04']
    sim.fault('n01', l1, { delay: [s.far, s.far] }); sim.fault('n01', l2, { delay: [s.far, s.far] })
    sim.fault('n02', l1, { delay: [s.near, s.near] }); sim.fault('n02', l2, { delay: [s.near, s.near] })
    sim.post(l1, { kind: 'leave' }, s.offsets[0]); sim.post(l2, { kind: 'leave' }, s.offsets[1])
    const t1 = sim.now
    sim.run({ until: t1 + 1500 })
    //! the shape, read at the two proposers: both opened a ballot at 2
    const opened = (x: Node) => x.journal.read().some((e) => e.kind === JK.propose && e.a === 2)
    if (!opened(nodes[0]) || !opened(nodes[1])) return [`not the shape: n01 proposed ${opened(nodes[0])}, n02 proposed ${opened(nodes[1])}`]
    check('1.5 s')
    sim.heal('n01', 'n02')
    sim.run({ until: sim.now + 3000 })
    check('the end')
    return problems
  }
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true, fault: { delay: [3, 3] } })
  sim.run({ until: 800 })
  if (!nodes.every((x) => x.epoch === 1)) return ['never formed']
  //! n01 (the lowest) and n02 leave: n01 is the proposer of the first shrunk view (without itself, or without n02 —
  // whichever knock lands first) and commits it on the others' grants. The instant it does, its VIEW is the frame
  // that severs each link, and the pairs stay cut: nobody else learns the commit, both leavers time out, and both
  // come back from their dirs — n01 holding a committed view the survivor never saw
  sim.severOnFrame('n01', 'n02', VERB.VIEW); sim.severOnFrame('n01', 'n03', VERB.VIEW)
  sim.post('n01', { kind: 'leave' }, s.offsets[0]); sim.post('n02', { kind: 'leave' }, s.offsets[1])
  let cut = -1
  const restarted = new Set<string>()
  const t0 = sim.now
  for (let t = sim.now; t <= t0 + 4000 && restarted.size < 2; t += 1) {
    sim.run({ until: t })
    if (cut < 0 && nodes[0].epoch >= 2) { cut = sim.now; sim.partition('n01', 'n02'); sim.partition('n01', 'n03') }
    for (const u of ['n01', 'n02']) if (!restarted.has(u) && sim.left.has(u)) { restarted.add(u); sim.restart(u) }
  }
  if (cut < 0) return ['not the shape: n01 never committed a shrunk view']
  sim.run({ until: sim.now + 3000 })
  check('3 s after the restarts')
  sim.heal('n01', 'n02'); sim.heal('n01', 'n03')
  sim.run({ until: sim.now + 4000 })
  check('the end')
  return problems
}

export const shape3 = (s: Schedule3) => `${s.seed} ${s.kind} n=${s.n} near=${s.near} far=${s.far} offsets=${s.offsets}`
