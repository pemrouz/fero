//! ── sim/scoped-sweep — the scale harness's adversaries, family runner and mutation runner (DESIGN-SCALE stage 0) ──
// A plain module, like sim/leave-sweep.ts: sim/scoped-sweep.test.ts imports it and asserts; a scratch script can
// import it to run more seeds (FERO_SCOPED_SEEDS) without running the sweep as a side effect.
//
// What lives here:
//   - frameTally: the verb peek at the sink. Byte [2] of every frame is its verb (MAGIC | flags | verb, kernel/
//     codec.ts:33-37 and Frame.verb), so counting frames per verb is one array increment per send. It rides the
//     sim's `tap` (the frame oracle every node's sink calls before delivery) and chains any tap already there.
//   - mesh / plan: a scoped cluster built like harness.cluster() but with a tune table (compactAt and snapshotAt
//     low enough that passes really fire), and a workload over 50 to 500 partitions with row writes, field
//     writes, removes and re-writes of removed cells (harness.writesPlan draws from 20 keys only).
//   - the adversaries A1-A11 of DESIGN-SCALE §6, one schedule builder each, run by one family runner.
//   - the mutation runner: a switch that weakens one rule of today's injected-drop class (a release the kernel
//     does not do) and the monitors that must go red.
//
// Today's kernel never releases a tombstone on an armed node (kernel/log.ts maybeCompact returns at once), so in a
// lawful run M3 and M6 have nothing to check: their non-vacuity comes from the mutation runner and the planted
// tests in sim/scale-probes.test.ts. M8 (bounded logs) is red today by design and M9 (leave drain) is red today at
// R=1: both are recorded as `redToday`, not as problems, and the test pins them.

import { Sim } from './exec.ts'
import { perEvent, armScale, ledgerOf, scopedConverged, exactlyR, stampOracle, floorsAgree, boundedLogs } from './monitors.ts'
import { VERB } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import { SCOPE } from '../kernel/scope.ts'
import { REC, type Rec } from '../kernel/env.ts'
import type { Node, NodeOpts } from '../kernel/node.ts'
import type { Tune } from '../kernel/tune.ts'

const mul = (seed: number) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]

// ── the frame tally ──────────────────────────────────────────────────────────────────────────────

export interface Tally { frames: Float64Array; bytes: Float64Array; mark(): Float64Array; since(m: Float64Array, verb: number): number }
//! frameTally — count every frame a node ships onto a live link, by verb, from now on. `mark()` snapshots the
// counts; `since(mark, VERB.X)` is the number of X frames sent after it. Frames into a partitioned pair are
// counted (the node sent them; the wire ate them), exactly like Link.ship's caller sees it.
export const frameTally = (sim: Sim): Tally => {
  const frames = new Float64Array(256), bytes = new Float64Array(256)
  const prev = sim.tap
  sim.tap = (from, to, link, peerLink, dialed, b) => {
    frames[b[2]]++
    bytes[b[2]] += b.length
    if (prev !== null) prev(from, to, link, peerLink, dialed, b)
  }
  return { frames, bytes, mark: () => frames.slice(), since: (m, verb) => frames[verb] - m[verb] }
}

//! perTick — run `ticks` heartbeat ticks and return the number of `verb` frames sent in each one.
export const perTick = (sim: Sim, t: Tally, hb: number, ticks: number, verb: number): number[] => {
  const out: number[] = []
  for (let i = 0; i < ticks; i++) {
    const m = t.mark()
    sim.run({ until: sim.now + hb, maxEvents: 5_000_000 })
    out.push(t.since(m, verb))
  }
  return out
}

// ── the cluster and the workload ─────────────────────────────────────────────────────────────────

export interface MeshOpts { replicas?: number; durable?: boolean; hb?: number; tune?: Partial<Tune>; fault?: { delay?: [number, number]; dupP?: number } }
const idOf = (i: number) => `n${String(i).padStart(2, '0')}`
const optsOf = (id: string, hosts: string[], o: MeshOpts): NodeOpts => ({
  uuid: id, listen: `sim:${id}`, hosts, heartbeatMs: o.hb ?? 50, durable: o.durable ?? false,
  ...(o.replicas !== undefined ? { replicas: o.replicas } : {}),
  ...(o.tune !== undefined ? { tune: o.tune } : {}),
  redialMs: 20, journalCap: 1 << 16,
})

//! mesh — n nodes, full dial mesh, the per-event monitors AND the scale monitors (M1-M9) installed.
export const mesh = (sim: Sim, n: number, o: MeshOpts): Node[] => {
  const ids = Array.from({ length: n }, (_, i) => idOf(i + 1))
  const nodes = ids.map((id) => sim.add(optsOf(id, ids.filter((x) => x !== id).map((x) => `sim:${x}`), o)))
  if (o.fault) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim.fault(ids[i], ids[j], o.fault)
  if (!sim.monitors.some((m) => m.name === 'queued-implies-paused')) sim.monitors.push(...perEvent())
  armScale(sim)
  for (const id of ids) sim.post(id, { kind: 'start' })
  return nodes
}

//! join — a new member dialing everyone alive, started after `delay` ms.
export const join = (sim: Sim, id: string, o: MeshOpts, delay = 0): void => {
  const hosts = [...sim.nodes.keys()].filter((x) => x !== id).map((x) => `sim:${x}`)
  sim.add(optsOf(id, hosts, o))
  sim.post(id, { kind: 'start' }, delay)
}

export interface Planned { at: number; uuid: string; recs: Rec[] }
//! plan — `count` writes over `parts` partitions, every draw made here (posting draws nothing): row writes, field
// writes, row removes, field removes, and re-writes of cells removed earlier in the plan.
export const plan = (r: () => number, uuids: string[], count: number, parts: number, span: number): Planned[] => {
  const out: Planned[] = []
  const removed: string[][] = []
  for (let i = 0; i < count; i++) {
    const uuid = pick(r, uuids)
    const p = 'p' + Math.floor(r() * parts)
    const f = 'f' + Math.floor(r() * 3)
    const roll = r()
    let rec: Rec
    if (roll < 0.32) rec = { type: REC.update, key: [p], value: { v: i } }
    else if (roll < 0.52) rec = { type: REC.update, key: [p, f], value: i }
    else if (roll < 0.70) { rec = { type: REC.remove, key: [p] }; removed.push([p]) }
    else if (roll < 0.78) { rec = { type: REC.remove, key: [p, f] }; removed.push([p, f]) }
    else if (removed.length) { const k = removed[Math.floor(r() * removed.length)]; rec = { type: REC.update, key: k, value: k.length > 1 ? -i : { back: i } } }
    else rec = { type: REC.update, key: [p], value: { v: i } }
    out.push({ at: Math.floor(r() * span), uuid, recs: [rec] })
  }
  return out
}
const post = (sim: Sim, xs: Planned[], t0: number) => { for (const w of xs) sim.post(w.uuid, { kind: 'write', recs: w.recs }, t0 - sim.now + w.at) }

// ── the mutation runner ──────────────────────────────────────────────────────────────────────────

//! Mutation — one rule of today's injected-drop class switched off (DESIGN-SCALE §6, "Mutation checks"). Today's
// kernel never releases an armed tombstone; each mutation performs a release the real rule would refuse, at a
// seeded moment, and the named monitors must go red within the family's seed budget.
//   drop-one      — "drop one tombstone and its record at a random holder" (the §6 stage-0 proof): the stamp
//                   goes and the remove's own log entry with it, at ONE holder. Red when that holder later
//                   teaches the partition or re-folds it.
//   release-all   — the release step with no census and no lane accounting: at EVERY current holder the stamp
//                   goes and so does the remove's entry, while older writes stay in their lanes (the short-lane
//                   shape) and a straggler may still hold an older record (the zombie shape).
//   version-only  — G1: the stamp is released at every holder, every lane untouched. Red only where an older
//                   record still arrives (a straggler, a stranded lane): the dedup fence hides it otherwise.
export type Mutation = 'none' | 'drop-one' | 'release-all' | 'version-only'
export const MUTATIONS: readonly Mutation[] = ['drop-one', 'release-all', 'version-only']
//! the monitors a mutation must turn red (any one of them counts as caught)
export const CATCHERS = new Set(['stamp-oracle', 'release-safety', 'census-truth'])

//! inject — perform the mutation now and return a short description, or null when no tombstone was there to release
// (the seed did not engage). `drop-one` picks (seeded) one removed cell of a partition a live armed node holds and
// drops it at that node; the other two act like a broken release rule would: on EVERY tombstone of every held
// partition, at every armed node holding it.
export const inject = (sim: Sim, r: () => number, m: Mutation): string | null => {
  if (m === 'none') return null
  const cands: { n: Node; k: string }[] = []
  for (const n of sim.nodes.values()) {
    if (!n.armed || !n.scope) continue
    for (const [k] of n.versions) if (!n.state.has(k) && n.scope.entries.get((JSON.parse(k) as string[])[0])?.state === SCOPE.held) cands.push({ n, k })
  }
  if (!cands.length) return null
  const chosen = m === 'drop-one' ? [pick(r, cands)] : cands
  for (const { n, k } of chosen) {
    const t = n.versions.get(k)!
    n.versions.delete(k)
    n.unlink(k)
    if (m !== 'version-only') {
      const lane = n.logs.get(t.origin)
      if (lane) n.logs.set(t.origin, lane.filter((e) => !(e.seq === t.seq && e.epoch === t.epoch)))
    }
    sim.stepped.add(n.uuid) // the walk diffs only stepped nodes: this step happened outside a node event
  }
  return `${m} ${chosen.length} tombstone(s): ${chosen.slice(0, 3).map((c) => c.k + '@' + c.n.uuid).join(' ')}`
}

// ── the family runner ────────────────────────────────────────────────────────────────────────────

export interface Out {
  family: string; seed: number; shape: string
  //! safety problems: a monitor fired (other than a red-today row), or M1's horizon form disagrees
  unsafe: string[]
  //! liveness problems at the horizon: holders disagree, exactly-R not restored, floors unequal
  notLive: string[]
  //! the rows expected red on today's kernel: M8 at the horizon, M9 at R=1
  redToday: string[]
  //! every monitor that went red, by name (the mutation runner reads it)
  red: Set<string>
  //! engagement: what the chaos actually did, so a seed whose chaos never bit reads as exactly that
  eng: Record<string, number>
  //! the run itself, for a probe that wants to look further (a trace, a node's log)
  sim: Sim
}

interface Ctx {
  sim: Sim; r: () => number; n: number; R: number; durable: boolean; o: MeshOpts; nodes: Node[]
  eng: Record<string, number>; t0: number
  //! when the mutation runner injects (absolute virtual ms); a family may move it from inside its chaos
  mutAt: number
  //! every 5 ms of virtual time, these run (the leave sweep's slice loop): reactive chaos
  polls: (() => void)[]
}
interface Family { name: string; ns: readonly number[]; Rs: readonly number[]; durable?: boolean | 'mix'; mutateAt: number; chaos: (c: Ctx) => void }

const jcount = (sim: Sim, kind: number) => { let s = 0; for (const n of sim.nodes.values()) for (const e of n.journal.read()) if (e.kind === kind) s++; return s }
const ownerOf = (c: Ctx, p: string): string | null => {
  const n = [...c.sim.nodes.values()].find((x) => x.armed)
  if (!n) return null
  const ring = n.writes.ring
  if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
  return ring.holders(p, n.replicas)[0] ?? null
}
//! a cell some armed holder shows live right now (a remove target for the adversaries)
const liveCell = (c: Ctx): string | null => {
  for (const n of c.sim.nodes.values()) {
    if (!n.armed) continue
    for (const k of n.state.keys()) if ((JSON.parse(k) as string[]).length === 1) return k
  }
  return null
}
//! leaveAndGo — a clean leave (V4-6); the scenario tears the node down the moment `left` is reported, like the shell
const leaveAndGo = (c: Ctx, id: string, at: number) => {
  c.sim.post(id, { kind: 'leave' }, at)
  let gone = false
  c.polls.push(() => {
    if (gone || !c.sim.left.has(id) || !c.sim.nodes.has(id)) return
    gone = true
    if (!c.sim.left.get(id)) c.eng.undrained = (c.eng.undrained ?? 0) + 1
    for (const o of c.sim.nodes.keys()) if (o !== id) c.sim.partition(id, o)
    c.sim.nodes.get(id)!.destroy(); c.sim.nodes.delete(id)
    c.eng.left = (c.eng.left ?? 0) + 1
  })
}
const others = (c: Ctx, id: string) => [...c.sim.nodes.keys()].filter((x) => x !== id)
const cutFromAll = (c: Ctx, id: string) => { for (const o of others(c, id)) c.sim.partition(id, o) }
const healAll = (c: Ctx, id: string) => { for (const o of others(c, id)) c.sim.heal(id, o) }

//! the adversaries A1-A11 (DESIGN-SCALE §6). Each draws its own timings from the seeded rng; `mutateAt` is when the
// mutation runner injects (ms after the workload starts), placed BEFORE the family's fold-forcing step.
export const FAMILIES: readonly Family[] = [
  {
    //! A1 the zombie lane, without poking link.synced: the owner of a live row commits a re-write whose RECORDS frame
    // dies in the kernel buffer as each link severs (severOnFrame, tail loss), and the owner is cut off and evicted
    // with that stranded commit in its log only. A survivor removes the row at the new epoch. Then the owner heals.
    name: 'A1-zombie', ns: [3, 5], Rs: [2, 3], mutateAt: 3100,
    chaos: (c) => {
      c.sim.at(700, () => {
        const k = liveCell(c)
        if (!k) return
        const p = (JSON.parse(k) as string[])[0]
        const z = ownerOf(c, p)
        if (!z || !c.sim.nodes.has(z)) return
        for (const o of others(c, z)) c.sim.severOnFrame(z, o, VERB.RECORDS)
        c.sim.post(z, { kind: 'write', recs: [{ type: REC.update, key: [p], value: { zombie: true } }] }, 0)
        c.sim.at(2, () => cutFromAll(c, z))
        c.eng.stranded = 1
        //! after the eviction, a survivor removes the row; then the zombie heals
        c.sim.at(1900, () => { const a = others(c, z)[0]; if (a) c.sim.post(a, { kind: 'write', recs: [{ type: REC.remove, key: [p] }] }, 0) })
        c.sim.at(3300, () => { if (c.sim.nodes.has(z)) healAll(c, z) })
      })
    },
  },
  {
    //! A2 ownership moves (a join) while the old owner's fan-out is delayed 400-500 ms, and the demoted owner keeps
    // minting until it installs: one member D has every pair it is in slowed (the joiner's included), so the rest
    // commit and install the join's view while D still stamps at the old epoch. A burst of 30 writes, each posted AT
    // D for a partition D owns at epoch 1, lands from 100 ms to 1.5 s after the join starts. `stale` counts commits
    // stamped at an epoch below the newest one any node had installed at that event: the engagement key.
    name: 'A2-slow-owner-join', ns: [2, 3, 5], Rs: [1, 2, 3], mutateAt: 500,
    chaos: (c) => {
      const slow = 400 + Math.floor(c.r() * 100)
      const D = pick(c.r, c.nodes).uuid
      const peers = () => [...c.nodes.map((x) => x.uuid), 'n90'].filter((x) => x !== D)
      c.sim.at(550, () => { for (const o of peers()) c.sim.fault(D, o, { delay: [slow, slow + 20] }) })
      c.sim.at(600, () => {
        join(c.sim, 'n90', c.o)
        const mine: string[] = []
        for (let i = 0; i < 1000 && mine.length < 20; i++) if (ownerOf(c, 'p' + i) === D) mine.push('p' + i)
        if (!mine.length) return
        for (let i = 0; i < 30; i++) {
          const p = pick(c.r, mine)
          const roll = c.r()
          const rec: Rec = roll < 0.6 ? { type: REC.update, key: [p], value: { burst: i } } : roll < 0.8 ? { type: REC.update, key: [p, 'f0'], value: i } : { type: REC.remove, key: [p] }
          c.sim.post(D, { kind: 'write', recs: [rec] }, 100 + Math.floor(c.r() * 1400))
        }
      })
      c.sim.at(2600, () => { for (const o of peers()) c.sim.fault(D, o, { delay: [1, 5] }) })
      //! per event: each stepped node's NEW own-lane commits, against the newest installed epoch anywhere
      const seen = new Map<Node, number>()
      c.sim.monitors.push({
        name: 'a2-stale-probe',
        check: (sim) => {
          let max = 0
          for (const n of sim.nodes.values()) if (n.epoch > max) max = n.epoch
          for (const id of sim.stepped) {
            const n = sim.nodes.get(id)
            if (!n || !n.armed) continue
            const lane = n.logs.get(n.origin)
            const len = lane?.length ?? 0
            const from = seen.get(n) ?? len
            seen.set(n, len)
            if (lane) for (let i = from; i < len; i++) if (lane[i].epoch < max) c.eng.stale = (c.eng.stale ?? 0) + 1
          }
          return null
        },
      })
    },
  },
  {
    //! A3 an orphan frozen before the remove reaches it: a join makes orphans; the first node seen holding one is cut
    // off at once and a live cell of that orphaned partition is removed at a current holder; then a second join
    // re-assigns, with the second joiner's links to the cut node fast and the rest slow; then the cut heals
    name: 'A3-orphan-cut', ns: [3, 5], Rs: [1, 2], mutateAt: 1400,
    chaos: (c) => {
      c.sim.at(300, () => join(c.sim, 'n90', c.o))
      let cut: string | null = null
      c.polls.push(() => {
        if (cut || c.sim.now < c.t0 + 300) return
        let part: string | null = null
        for (const n of c.nodes) {
          if (!c.sim.nodes.has(n.uuid) || !n.scope) continue
          for (const [p, e] of n.scope.entries) if (e.state === SCOPE.orphan && n.state.has(JSON.stringify([p]))) { cut = n.uuid; part = p; break }
          if (cut) break
        }
        if (!cut || !part) return
        cutFromAll(c, cut)
        c.eng.orphanCut = 1
        const holder = ownerOf(c, part)
        if (holder && c.sim.nodes.has(holder) && holder !== cut) c.sim.post(holder, { kind: 'write', recs: [{ type: REC.remove, key: [part] }] }, 0)
        const x = cut
        c.mutAt = c.sim.now + 400
        c.sim.at(900, () => { join(c.sim, 'n91', c.o); c.sim.fault(x, 'n91', { delay: [1, 1] }); for (const o of others(c, 'n91')) if (o !== x) c.sim.fault(o, 'n91', { delay: [60, 80] }) })
        c.sim.at(1400, () => { if (c.sim.nodes.has(x)) healAll(c, x) })
      })
    },
  },
  {
    //! A4 durable holders restarted from disk at seeded moments; one disk lies about fsync (G5); a slow fsync clock
    // with a lamport lease of 1, so the boot record (with its floor seed) is written ahead of the WAL rows it
    // claims and a restart lands between the two (the DESIGN-SCALE §2 seed question)
    name: 'A4-restarts', ns: [2, 3, 5], Rs: [2, 3], durable: true, mutateAt: 250,
    chaos: (c) => {
      const victims = [...c.nodes].sort(() => c.r() - 0.5).slice(0, 2)
      if (c.r() < 0.4) c.sim.storeFault(victims[1].uuid, { lieP: 0.3 })
      c.sim.storeFault(victims[0].uuid, { delay: [40, 80] })
      const at = [300 + Math.floor(c.r() * 400), 1200 + Math.floor(c.r() * 600)]
      c.sim.at(at[0], () => { if (c.sim.nodes.has(victims[0].uuid)) { c.sim.restart(victims[0].uuid); c.eng.restarts = (c.eng.restarts ?? 0) + 1 } })
      c.sim.at(at[1], () => { if (c.sim.nodes.has(victims[1].uuid)) { c.sim.restart(victims[1].uuid); c.eng.restarts = (c.eng.restarts ?? 0) + 1 } })
    },
  },
  {
    //! A5 a member's VIEW frames severed so it keeps stamping at the old epoch across a join
    name: 'A5-view-severed', ns: [3, 5], Rs: [2, 3], mutateAt: 300,
    chaos: (c) => {
      const v = pick(c.r, c.nodes.slice(1)).uuid
      c.sim.at(350, () => { for (const o of others(c, v)) c.sim.severOnFrame(o, v, VERB.VIEW); join(c.sim, 'n90', c.o) })
    },
  },
  {
    //! A6 a view flip during a latch: a join, then a second view change (another join, or a leave) while the first
    // join's acquisitions are still open
    name: 'A6-flip-mid-latch', ns: [3, 5], Rs: [2, 3], mutateAt: 300,
    chaos: (c) => {
      c.sim.at(350, () => join(c.sim, 'n90', c.o))
      let flipped = false
      //! the first slice where some node's journal holds an acquireStart, read by cursor (journal.read(from)) so
      // each poll looks only at the rows emitted since the last one, not at every node's whole journal
      const cursor = new Map<Node, number>()
      const opened = (): boolean => {
        for (const n of c.sim.nodes.values()) {
          const from = cursor.get(n) ?? 0
          if (n.journal.n === from) continue
          cursor.set(n, n.journal.n)
          for (const e of n.journal.read(from)) if (e.kind === JK.acquireStart) return true
        }
        return false
      }
      c.polls.push(() => {
        if (flipped) return
        if (!opened()) return
        flipped = true
        c.eng.flip = 1
        if (c.r() < 0.5) join(c.sim, 'n91', c.o)
        else leaveAndGo(c, c.nodes[c.nodes.length - 1].uuid, 0)
      })
    },
  },
  {
    //! A7 scale down to 1 and back up: clean leaves one at a time (writes in flight from each leaver), then joins
    name: 'A7-down-to-one', ns: [2, 3], Rs: [1, 2], mutateAt: 300,
    chaos: (c) => {
      const go = c.nodes.slice(1)
      go.forEach((x, i) => {
        c.sim.post(x.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['lv' + i], value: i }] }, 600 + i * 900)
        leaveAndGo(c, x.uuid, 600 + i * 900 + 1)
      })
      c.sim.at(700 + go.length * 900 + 600, () => { join(c.sim, 'n90', c.o); join(c.sim, 'n91', c.o, 300) })
    },
  },
  {
    //! A8 a co-holder partitioned and healed across a join's announcement round
    name: 'A8-coholder-cut', ns: [3, 5], Rs: [2, 3], mutateAt: 300,
    chaos: (c) => {
      const [a, b] = [...c.nodes].sort(() => c.r() - 0.5)
      c.sim.at(350, () => join(c.sim, 'n90', c.o))
      c.sim.at(380 + Math.floor(c.r() * 100), () => c.sim.partition(a.uuid, b.uuid))
      c.sim.at(900 + Math.floor(c.r() * 400), () => c.sim.heal(a.uuid, b.uuid))
    },
  },
  {
    //! A9 a lost WACK (the owner's ack dies as the link severs), then an owner move (a join), then the issuer's retry
    name: 'A9-lost-wack', ns: [3, 5], Rs: [1, 2], mutateAt: 300,
    chaos: (c) => {
      c.sim.at(320, () => {
        const k = liveCell(c) ?? JSON.stringify(['p0'])
        const p = (JSON.parse(k) as string[])[0]
        const own = ownerOf(c, p)
        const iss = c.nodes.find((x) => x.uuid !== own && c.sim.nodes.has(x.uuid))
        if (!own || !iss) return
        c.sim.severOnFrame(own, iss.uuid, VERB.WACK)
        c.sim.post(iss.uuid, { kind: 'write', recs: [{ type: REC.update, key: [p], value: { retried: true } }] }, 0)
        c.eng.wackCut = 1
        c.sim.at(30, () => join(c.sim, 'n90', c.o))
      })
    },
  },
  {
    //! A10 linger: a frame from a member killed after it was sent, delivered after the survivors installed the view
    // without it. REPRESENTABLE: the sim's links are FIFO for frames, and a sever's linkDown travels at the pair's
    // delay too, so a slow pair delivers the dead member's frames first, on a link its peer still thinks is up.
    // z (the last member) owns a partition p whose only other holder is s (R=2); only the z–s pair is slowed to
    // 2.5 s, everyone else stays fast. z writes p (its RECORDS to s start their 2.5 s trip), and 5 ms later z is
    // cut from everyone and killed. The fast members see their links drop at once and evict z within a second; s
    // installs that view from them; z's frames then land at s, after the install, and the kernel applies them.
    // `onWire` counts z's frames to s in flight at the kill; `late` the ones s applied after its install (the
    // engagement key: a record from the killed member taken in by a survivor whose view no longer has it). This is
    // the residual DESIGN-SCALE §5 names, and the evidence for §14 Q15's one-epoch GC floor.
    name: 'A10-linger', ns: [5], Rs: [2], mutateAt: 300,
    chaos: (c) => {
      const z = c.nodes[c.nodes.length - 1].uuid
      c.sim.at(350, () => {
        const zn = c.sim.nodes.get(z)
        if (!zn || !zn.armed) return
        const ring = zn.writes.ring
        if (ring.epoch !== zn.epoch) ring.build(zn.epoch, zn.membership.view.members)
        let p = '', s = ''
        for (let i = 0; i < 10_000 && !p; i++) { const h = ring.holders('zl' + i, zn.replicas); if (h[0] === z && h.length === 2) { p = 'zl' + i; s = h[1] } }
        if (!p) return
        c.sim.fault(z, s, { delay: [2500, 2500] })
        c.sim.post(z, { kind: 'write', recs: [{ type: REC.update, key: [p], value: { linger: true } }] }, 0)
        c.sim.at(5, () => {
          const n = c.sim.nodes.get(z)
          if (!n) return
          const ids = new Set<number>()
          for (const [id, f] of c.sim.inflight) if (f.from === z && f.to === s) ids.add(id)
          c.eng.onWire = ids.size
          cutFromAll(c, z); n.destroy(); c.sim.nodes.delete(z); c.eng.killed = 1
          const sn = c.sim.nodes.get(s)!
          const tailOf = () => { const l = sn.logs.get(z); return l && l.length ? l[l.length - 1].seq : 0 }
          let tail = tailOf()
          //! per event, not per 5 ms slice: the delivery of one of z's frames is one event, so a tail that grows in
          // that event grew from that frame
          c.sim.monitors.push({
            name: 'a10-linger-probe',
            check: (sim) => {
              if (!ids.size) return null
              let landed = false
              for (const id of ids) if (!sim.inflight.has(id)) { ids.delete(id); landed = true }
              const t = tailOf()
              if (landed && t > tail && !sn.membership.view.members.some((m) => m[0] === z)) {
                c.eng.late = (c.eng.late ?? 0) + 1
                if ([...sn.links.values()].some((l) => l.uuid === z)) c.eng.lateOnLiveLink = (c.eng.lateOnLiveLink ?? 0) + 1
              }
              tail = t
              return null
            },
          })
        })
      })
    },
  },
  {
    //! A11 a spoke (client) whose feeder link pauses across the removes, and a spoke that fails over: its feeder
    // is cut from it mid-run, so it re-elects another feeder
    name: 'A11-spoke', ns: [2, 3], Rs: [1, 2], mutateAt: 500,
    chaos: (c) => {
      const spoke = c.sim.add({ uuid: 's1', listen: 'sim:s1', hosts: c.nodes.map((x) => `sim:${x.uuid}`), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
      c.sim.post('s1', { kind: 'start' }, 0)
      c.sim.at(400, () => {
        const f = spoke.primary !== null ? spoke.links.get(spoke.primary) : undefined
        const feeder = f ? c.sim.nodes.get(f.uuid) : undefined
        if (!feeder) return
        const l = [...feeder.links.values()].find((x) => x.uuid === 's1')
        if (l) { c.sim.post(feeder.uuid, { kind: 'pause', link: l.id }, 0); c.sim.post(feeder.uuid, { kind: 'drain', link: l.id }, 300); c.eng.paused = 1 }
        if (c.r() < 0.5) { const fu = feeder.uuid; c.sim.at(400, () => c.sim.partition(fu, 's1')); c.sim.at(1200, () => c.sim.heal(fu, 's1')); c.eng.failover = 1 }
      })
    },
  },
]

//! runFamily — one seed of one family to its horizon, with an optional mutation. Never throws on a red run.
export const runFamily = (fam: Family, seed: number, mut: Mutation = 'none', horizon = 9000): Out => {
  const r = mul(seed * 7919 + fam.name.length * 104729 + fam.name.charCodeAt(1))
  const n = pick(r, fam.ns)
  const R = pick(r, fam.Rs)
  const durable = fam.durable === true || (fam.durable === 'mix' && r() < 0.5)
  const parts = pick(r, [50, 120, 500])
  const count = pick(r, [60, 120])
  const o: MeshOpts = { replicas: R, durable, hb: 50, tune: { compactAt: 16, snapshotAt: 16 }, fault: { delay: [1, 5] } }
  const sim = new Sim(seed)
  const eng: Record<string, number> = {}
  const out: Out = { family: fam.name, seed, shape: `${fam.name} seed ${seed} n=${n} R=${R}${durable ? ' durable' : ''} parts=${parts} writes=${count}${mut !== 'none' ? ' mut=' + mut : ''}`, unsafe: [], notLive: [], redToday: [], red: new Set(), eng, sim }
  const nodes = mesh(sim, n, o)
  sim.run({ until: 1500 })
  if (!nodes.every((x) => x.armed)) { out.notLive.push('never formed'); return out }
  const t0 = sim.now
  const c: Ctx = { sim, r, n, R, durable, o, nodes, eng, t0, polls: [], mutAt: t0 + fam.mutateAt }
  post(sim, plan(r, nodes.map((x) => x.uuid), count, parts, 600), t0)
  fam.chaos(c)
  //! the mutation fires at the first 5 ms slice at or past c.mutAt; its draws come from a separate stream so the
  // schedule itself is the same with and without it
  const mr = mul(seed * 31 + 7)
  let mutated = mut === 'none'
  for (let t = sim.now; t <= t0 + horizon; t += 5) {
    sim.run({ until: t })
    for (const f of c.polls) f()
    if (!mutated && sim.now >= c.mutAt) { mutated = true; if (inject(sim, mr, mut)) eng.mutated = 1 }
  }
  //! the verdict
  for (const v of sim.violations) {
    out.red.add(v.monitor)
    if (v.monitor === 'leave-drain' && R === 1) { if (!out.redToday.includes('M9')) out.redToday.push('M9') }
    else if (out.unsafe.length < 3) out.unsafe.push(`${v.monitor} @${v.event}: ${v.detail}`)
  }
  const m1 = stampOracle(sim)
  if (m1) { out.red.add('stamp-oracle'); out.unsafe.push('M1 horizon: ' + m1) }
  const live = [scopedConverged(sim), exactlyR(sim), floorsAgree(sim)].filter((x): x is string => x !== null)
  out.notLive.push(...live)
  if (boundedLogs(sim)) out.redToday.push('M8')
  const L = ledgerOf(sim)
  Object.assign(eng, { cells: L.counts.cells, advances: L.counts.advances, releases: L.counts.releases, census: L.counts.census, drops: L.counts.drops, leaves: L.counts.leaves, resyncs: L.counts.resyncs })
  eng.sheds = jcount(sim, JK.shed); eng.acquires = jcount(sim, JK.acquire); eng.compactions = jcount(sim, JK.compacted)
  eng.stalls = jcount(sim, JK.shedStall); eng.epoch = Math.max(...[...sim.nodes.values()].map((x) => x.epoch))
  return out
}

export const familyByName = (name: string): Family => FAMILIES.find((f) => f.name === name)!
