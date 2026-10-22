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
//   - the adversaries A1-A11 of DESIGN-SCALE §6, A12 (wave 6a: a spoke across two hand-offs), A13 (its review: a
//     spoke whose feeder repairs and re-enters through the latch) and A14 (wave 8: a spoke whose paused feeder link
//     owes it the shed's word across a re-latch, V4-62's clause 3), one schedule builder each, run by one family runner.
//   - the mutation runner: a switch that weakens one rule of today's injected-drop class (a release the kernel
//     does not do) and the monitors that must go red.
//
// Today's kernel never releases a tombstone on an armed node (kernel/log.ts maybeCompact returns at once), so in a
// lawful run M3 and M6 have nothing to check: their non-vacuity comes from the mutation runner and the planted
// tests in sim/scale-probes.test.ts. M8 (bounded logs) is red today by design and is recorded as `redToday`, not
// as a problem; the test pins it. M9 (leave drain) was red today at R=1 until the drain landed (DESIGN-SCALE §7
// stage 1 (b), 2026-10-10): a leave-drain violation is now UNSAFE like any other.

import { Sim } from './exec.ts'
import { perEvent, armScale, ledgerOf, scopedConverged, exactlyR, stampOracle, floorsAgree, marksAgree, boundedLanes, boundedTombs, screenMatches, spokeMirror, spokeStale, spokeQuiet, laneUniqueCounts, feedWords, feedWordsOf } from './monitors.ts'
import { VERB, Frame } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import { SCOPE } from '../kernel/scope.ts'
import { REC, partitionOf, type Rec } from '../kernel/env.ts'
import { stable, type Node, type NodeOpts, type LogEntry } from '../kernel/node.ts'
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
  //! a scoped mesh carries the api's cluster contract, so a spoke reads `replicas=` off its feeder (node.feederScoped,
  // DESIGN-SCALE stage 2) as a real client does; unscoped meshes send none (sim/harness.ts cluster says why)
  ...(o.replicas ? { contract: `v1;heartbeat.ms=${o.hb ?? 50};replicas=${o.replicas};methods=0;validation=none` } : {}),
  ...(o.tune !== undefined ? { tune: o.tune } : {}),
  redialMs: 20, journalCap: 1 << 16,
})

//! mesh — n nodes, full dial mesh, the per-event monitors AND the scale monitors (M1-M10) installed.
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
//! The STAGE-2 mutations (DESIGN-SCALE §6 "a dropped dirty site (M7)", §7's stage-2 gate; the review of 2026-10-10):
// each switches off one of the two repair legs announce-on-change added, and M7's knowledge form (marks-agree) must
// go red — its floor form cannot, since every loss the sim can make is healed by a round of its own.
//   no-sweep      — the sweep off (the tune row aeFan 0) with the owner's announcement intact. Red on an R=3 shape:
//                   a co-holder↔co-holder pair (neither the owner) is re-proved by the sweep alone, so after a write
//                   neither ever hears the other's floor again. Green on an R=2 shape (every pair has its owner).
//   drop-dirty    — the stamp site's dirty mark dropped (a per-event monitor empties every stepped armed node's
//                   dirty set, so the tick finds nothing to announce), measured with the sweep off so the sweep
//                   cannot heal what the dirty leg should have. Red on an R=2 shape where `no-sweep` alone is green:
//                   that difference is the dirty leg.
//! The OWED-WORD mutation (wave 8, for A14; V4-62's clause 3):
//   owed-x-dropped — a feeder never owes a shed's word a clear took: every server's `owe` drops the kind 'x', so the
//                    word is never said again at the heal and the answer's start is never lowered for it (the kernel
//                    mutant "the {x} half off", made from outside: owe is a public method). The spoke keeps the rows
//                    of a partition that left its feeder. Caught by A14's heal-end check (and M12 or spokeStale where
//                    the partition stays away).
export type Mutation = 'none' | 'drop-one' | 'release-all' | 'version-only' | 'no-sweep' | 'drop-dirty' | 'owed-x-dropped'
export const MUTATIONS: readonly Mutation[] = ['drop-one', 'release-all', 'version-only']
export const STAGE2_MUTATIONS: readonly Mutation[] = ['no-sweep', 'drop-dirty']
//! the monitors a mutation must turn red (any one of them counts as caught)
export const CATCHERS = new Set(['stamp-oracle', 'release-safety', 'census-truth'])

//! inject — perform the mutation now and return a short description, or null when no tombstone was there to release
// (the seed did not engage). `drop-one` picks (seeded) one removed cell of a partition a live armed node holds and
// drops it at that node; the other two act like a broken release rule would: on EVERY tombstone of every held
// partition, at every armed node holding it.
//! cellOf — a record's cell key, the way Node.apply derives it (a new top-level row's key is [] and its row is `at`)
const cellOf = (rec: Rec) => JSON.stringify(rec.key.length ? rec.key : [rec.at ?? ''])
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
    n.tombDrop(k) // a broken RELEASE rule, not a broken index: the indexes follow the drop (M4 stays green here)
    //! the remove's OWN entry: its stamp AND its cell. A field that a row write swept carries the ROW's stamp as its
    // tombstone (V4-18), so a match by stamp alone found the parent row's winning entry and dropped it — a broken
    // release of a field never drops its parent's record. A swept cell has no entry of its own: its stamp goes alone.
    if (m !== 'version-only') {
      const lane = n.logs.get(t.origin)
      if (lane) {
        const own = (e: LogEntry) => e.seq === t.seq && e.epoch === t.epoch && cellOf(e.rec) === k
        const gone = lane.filter(own)
        if (gone.length) {
          n.logs.set(t.origin, lane.filter((e) => !own(e)))
          n.indexDrop(t.origin, gone)
        }
      }
    }
    sim.stepped.add(n.uuid) // the walk diffs only stepped nodes: this step happened outside a node event
  }
  return `${m} ${chosen.length} tombstone(s): ${chosen.slice(0, 3).map((c) => c.k + '@' + c.n.uuid).join(' ')}`
}

// ── the family runner ────────────────────────────────────────────────────────────────────────────

export interface Out {
  family: string; seed: number; shape: string
  //! the replica count the seed drew (an R=1 seed has no co-holder pairs for M7 to compare)
  R: number
  //! safety problems: a monitor fired (other than a red-today row), or M1's horizon form disagrees
  unsafe: string[]
  //! liveness problems at the horizon: holders disagree, exactly-R not restored, floors unequal, marks stale (M7's two forms)
  notLive: string[]
  //! the rows expected red on today's kernel: M8 at the horizon (M9 at R=1 left this list with the drain)
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
  //! the workload's partition count (a family that posts a second burst draws over the same range)
  parts: number
  //! when the mutation runner injects (absolute virtual ms); a family may move it from inside its chaos
  mutAt: number
  //! every 5 ms of virtual time, these run (the leave sweep's slice loop): reactive chaos
  polls: (() => void)[]
}
//! `tune`, when a family has one, draws extra tune rows for its mesh after the shared draws (A14: a small paused queue);
// a family without it draws nothing more, so its runs are exactly what they were
interface Family { name: string; ns: readonly number[]; Rs: readonly number[]; durable?: boolean | 'mix'; mutateAt: number; tune?: (r: () => number) => Partial<Tune>; chaos: (c: Ctx) => void }

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

//! the adversaries A1-A11 (DESIGN-SCALE §6), A12 (wave 6a) and A13 (its review). Each draws its own timings from the seeded rng; `mutateAt` is when the
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
    // stamped at an epoch below the newest one any node had installed at that event, on a partition whose owner at
    // that newest view is ANOTHER node: a demoted owner minting for a partition that already moved. That is the
    // engagement key. (A commit that is merely stamped late, on a partition the node still owns, does not count.)
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
          let max = 0, top: Node | null = null
          for (const n of sim.nodes.values()) if (n.armed && n.epoch > max) { max = n.epoch; top = n }
          for (const id of sim.stepped) {
            const n = sim.nodes.get(id)
            if (!n || !n.armed) continue
            const lane = n.logs.get(n.origin)
            const len = lane?.length ?? 0
            const from = seen.get(n) ?? len
            seen.set(n, len)
            if (!lane || !top) continue
            for (let i = from; i < len; i++) {
              if (lane[i].epoch >= max) continue
              //! the owner at the newest installed view (the same ring ownerOf reads, built at top's own epoch)
              const ring = top.writes.ring
              if (ring.epoch !== top.epoch) ring.build(top.epoch, top.membership.view.members)
              const owner = ring.holders(partitionOf(lane[i].rec), top.replicas)[0]
              if (owner !== undefined && owner !== n.origin) c.eng.stale = (c.eng.stale ?? 0) + 1
            }
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
  {
    //! A12 a spoke across two hand-offs at its feeder (wave 6a, 2026-10-12; STATUS's second sighting, the debugger's
    // recipe): a client that dials every member; a join at 400 ms (partitions move onto the joiner — the feeder's
    // copies of those freeze into orphans and shed, and the spoke keeps their rows: `spokeStale` counts them); a clean leave
    // at 2000 ms of a member that is NOT the spoke's feeder (the feeder acquires the leaver's partitions from their
    // orphan copies through the latch — the records it folds there must reach the spoke); a second burst of writes
    // after the leave. M12 (spokeMirror) judges the spoke at the horizon; `feederAcquires` is the engagement key (a
    // feeder that acquired nothing proves nothing about the latch's forward).
    name: 'A12-spoke-handoff', ns: [3, 5], Rs: [2, 3], mutateAt: 300,
    chaos: (c) => {
      const spoke = c.sim.add({ uuid: 's1', listen: 'sim:s1', hosts: c.nodes.map((x) => `sim:${x.uuid}`), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
      c.sim.post('s1', { kind: 'start' }, 0)
      c.sim.at(400, () => join(c.sim, 'n90', c.o))
      c.sim.at(2000, () => {
        const f = spoke.primary !== null ? spoke.links.get(spoke.primary)?.uuid : undefined
        const leaver = c.nodes.map((x) => x.uuid).filter((u) => u !== f && c.sim.nodes.has(u)).at(-1)
        if (leaver === undefined || f === undefined) return
        c.eng.handoff = 1
        leaveAndGo(c, leaver, 0)
      })
      c.sim.at(2600, () => post(c.sim, plan(c.r, [...c.sim.nodes.values()].filter((x) => !x.client).map((x) => x.uuid), 30, c.parts, 400), c.sim.now))
    },
  },
  {
    //! A13 a spoke whose feeder REPAIRS held partitions through the latch and RE-ENTERS some from orphans (the review of
    // wave 6a's review, 2026-10-12: the other spoked families fold only from zero at the spoke's feeder, so the two legs
    // the forward has — the delta of a repair, the whole partition at a re-entry — and the answer for a partition under
    // repair had fixed-seed tests alone). A client of every member. From 300 ms on, four times at 400 ms intervals, the
    // next RECORDS frame from one other member O to the spoke's feeder F dies with their link (severOnFrame), and O
    // writes twenty rows over the next 40 ms to the partitions it owns and F holds: the first frame's rows are lost, the
    // ones after the redial reach F and are tapped to the spoke, and O's announce then has F repair each lagging
    // partition through the latch — the lost rows fold BELOW the spoke's tail on O's lane, where only the forward brings
    // them (sighting 1's shape; the heartbeat exchange ships above the tail). The first time a 5 ms slice finds F
    // mid-repair, F is cut from that teacher for 60 ms (under SUSPECT_TICKS): the open latches abort into orphans and
    // re-enter when the link is back. The engagement key counts F's folds by what the partition was when its latch
    // opened (a per-event probe reads F's scope entries: repairFolds, reentryFolds, zeroFolds); M12 judges the spoke at
    // the horizon.
    name: 'A13-spoke-repair', ns: [3, 4], Rs: [2, 3], mutateAt: 250,
    chaos: (c) => {
      const spoke = c.sim.add({ uuid: 's1', listen: 'sim:s1', hosts: c.nodes.map((x) => `sim:${x.uuid}`), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
      c.sim.post('s1', { kind: 'start' }, 0)
      c.sim.at(300, () => {
        const f = spoke.primary !== null ? spoke.links.get(spoke.primary)?.uuid : undefined
        const F = f !== undefined ? c.sim.nodes.get(f) : undefined
        if (f === undefined || F === undefined) return
        const os = c.nodes.map((x) => x.uuid).filter((u) => u !== f)
        const O = os[Math.floor(c.r() * os.length)]
        //! the partitions O owns and F holds: what the lost frames carry and the repairs bring back
        const ring = F.writes.ring
        if (ring.epoch !== F.epoch) ring.build(F.epoch, F.membership.view.members)
        const ps: string[] = []
        for (let i = 0; i < c.parts; i++) { const p = 'p' + i, h = ring.holders(p, F.replicas); if (h[0] === O && h.includes(f)) ps.push(p) }
        if (!ps.length) return
        let v = 0
        for (let k = 0; k < 4; k++) c.sim.at(k * 400, () => {
          if (!c.sim.nodes.has(O) || !c.sim.nodes.has(f)) return
          c.sim.severOnFrame(O, f, VERB.RECORDS, 1); c.eng.severArmed = (c.eng.severArmed ?? 0) + 1
          for (let i = 0; i < 20; i++) c.sim.post(O, { kind: 'write', recs: [{ type: REC.update, key: [ps[(i + 20 * k) % ps.length], 'b' + k], value: ++v }] }, 2 * i)
        })
        //! the cut mid-repair: once, the first slice that finds a repair latch open at F, from its teacher
        let cut = false
        c.polls.push(() => {
          if (cut || !c.sim.nodes.has(f)) return
          for (const [, e] of F.scope!.entries) {
            if (e.state !== SCOPE.acquiring || e.preState !== SCOPE.held || e.teacher === undefined || !c.sim.nodes.has(e.teacher)) continue
            cut = true; c.eng.cutMidRepair = 1
            const T = e.teacher
            c.sim.partition(f, T); c.sim.at(60, () => c.sim.heal(f, T))
            return
          }
        })
        //! the folds at F by the partition's state when the latch opened: read per event (a latch opens and folds in
        // different events — the announce and the ACQDONE — so the open latch is seen before its fold row)
        const pre = new Map<string, number | undefined>()
        let jn = F.journal.n
        c.sim.monitors.push({
          name: 'a13-folds-probe',
          check: (sim) => {
            if (!sim.stepped.has(f) || !sim.nodes.has(f)) return null
            for (const [p, e] of F.scope!.entries) if (e.state === SCOPE.acquiring) pre.set(p, e.preState)
            for (const row of F.journal.read(jn)) {
              if (row.kind !== JK.acquire) continue
              const was = pre.get(row.a as string)
              const k = was === SCOPE.held ? 'repairFolds' : was === SCOPE.orphan ? 'reentryFolds' : 'zeroFolds'
              c.eng[k] = (c.eng[k] ?? 0) + 1
              pre.delete(row.a as string)
            }
            jn = F.journal.n
            return null
          },
        })
      })
    },
  },
  {
    //! A14 the owed word (wave 8, 2026-10-22; STATUS's Sim and scale line, V4-62's clause 3, which no seeded schedule
    // reached before: with a counter, the sweep and the scale probes owed and paid a shed word 0 times). A client of
    // every member. Once the workload is in, its feeder F's link to it pauses, with a small queue (the tune rows queued
    // and queuedBytes, drawn per seed), and a joiner n90 takes some of F's partitions: F's copies freeze and shed, and
    // the shed's FEED {x} waits in the paused queue. While they are away, a burst of writes and removes lands on them
    // at their new holders (so they come back on more than one run, with rows the spoke never saw and rows it must lose).
    // Then either a second burst onto partitions F still holds taps the paused link until a clear takes the word
    // (`taps`), or nothing does until the re-latch's own forward overflows the queue (`quiet`: its first frames go with
    // the word, and the ones behind the clear survive and reach the spoke at the drain ahead of the word said again —
    // the leapfrog of kernel/client.test.ts, counted in eng.survivors). Then n90 leaves cleanly and F latches its
    // partitions back from zero; a fold that runs on the unsynced link owes its end too. The heal (the link's drain)
    // comes a seeded delay after the re-latch folds (`after`), or, in `taps`, while a latch is open (`mid`: F's member
    // links are slowed from the leave on, so the latches stay open past the heal) or before the leave (`before`): the
    // word is paid while the partition is back, coming back, or away (eng.healHeld, healAcquiring, healGone; counted per
    // shed partition at the drain). The
    // engagement key: words owed and paid (sim/monitors.ts feedWords: eng.owedX, paidX, owedE, paidE). Judged at the
    // horizon by M12 and the screen check like every spoked family, and at the heal exchange's end by this family's
    // own check (`a14-heal-end`): the first quiet point after the drain (sim/monitors.ts spokeQuiet: everything the
    // feeder sent has landed, its link synced and flowing), where the design says the spoke holds exactly what its
    // feeder feeds — M12 over the partitions F holds, F's cells of every partition it feeds, nothing of a partition F
    // has no entry for, the screen equal to the kernel. kernel/client.test.ts asserts the same there, on its hand-built
    // shapes. The heal comes a seeded delay after the FIRST re-latched fold (`after`) or the first re-latch (`mid`).
    name: 'A14-spoke-owed', ns: [3, 4], Rs: [1, 2, 3], mutateAt: 250,
    tune: (r) => ({ queued: pick(r, [2, 3, 4]), queuedBytes: pick(r, [512, 4096, 1 << 20]) }),
    chaos: (c) => {
      const spoke = c.sim.add({ uuid: 's1', listen: 'sim:s1', hosts: c.nodes.map((x) => `sim:${x.uuid}`), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
      c.sim.post('s1', { kind: 'start' }, 0)
      feedWords(c.sim) // the counter of owed and paid words (eng.owedX, paidX, owedE, paidE at the verdict)
      //! the shape and its timings, drawn up front
      const taps = c.r() < 0.5
      //! in `quiet` nothing clears the queue before the re-latch's forward, so only a heal after the folds finds a word owed
      const heal = taps ? pick(c.r, ['after', 'after', 'mid', 'before'] as const) : 'after'
      const tp = 650 + Math.floor(c.r() * 150) // the pause, once the workload is in (its writes span 0-600 ms)
      const tj = 10 + Math.floor(c.r() * 90) // the join, after the pause
      const away = 4 + Math.floor(c.r() * 12) // the writes onto the shed partitions while they are away, 2 ms apart
      const tb = Math.floor(c.r() * 40), burst = 4 + Math.floor(c.r() * 12) // taps: the burst onto F's own, after the first shed
      const tl = 2 * away + 30 + Math.floor(c.r() * 400) // the leave, after the first shed (after the heal, for `before`)
      const th = Math.floor(c.r() * (heal === 'mid' ? 15 : 300)) // the heal, after its trigger
      c.eng.taps = taps ? 1 : 0
      c.eng.heal = heal === 'before' ? 1 : heal === 'mid' ? 2 : 3
      c.sim.at(tp, () => {
        const pl = spoke.primary !== null ? spoke.links.get(spoke.primary) : undefined
        const F = pl !== undefined ? c.sim.nodes.get(pl.uuid) : undefined
        const l = F !== undefined ? [...F.links.values()].find((x) => x.uuid === 's1') : undefined
        if (F === undefined || l === undefined) return
        c.sim.post(F.uuid, { kind: 'pause', link: l.id }, 0)
        c.eng.paused = 1
        c.sim.at(tj, () => join(c.sim, 'n90', c.o))
        const shed = new Set<string>()
        const members = () => [...c.sim.nodes.keys()].filter((u) => u !== F.uuid && u !== 's1')
        //! at the heal, what the shed partitions are at F, and how many frames of them leave the queue ahead of the
        // owed word (the re-latch's frames a clear left behind it: the leapfrog); `mid` takes the slow links off after it
        let healed = false, left = false, due = false
        const drain = (ms: number) => {
          if (healed) return
          healed = true
          c.sim.at(ms, () => {
            for (const p of shed) {
              const st = F.scope!.entries.get(p)?.state
              const k = st === SCOPE.held ? 'healHeld' : st === SCOPE.acquiring ? 'healAcquiring' : st === undefined ? 'healGone' : 'healOrphan'
              c.eng[k] = (c.eng[k] ?? 0) + 1
            }
            for (const b of l.queued) {
              const f = new Frame(b)
              if (f.verb === VERB.RECORDS && f.records().some((rv) => shed.has(partitionOf(rv.rec())))) c.eng.survivors = (c.eng.survivors ?? 0) + 1
            }
            c.sim.post(F.uuid, { kind: 'drain', link: l.id }, 0)
            due = true
            if (heal === 'mid') c.sim.at(100, () => { for (const u of members()) c.sim.fault(F.uuid, u, { delay: [1, 5] }) })
          })
        }
        const leave = (ms: number) => {
          if (left) return
          left = true
          leaveAndGo(c, 'n90', ms)
          if (heal === 'mid') c.sim.at(ms, () => { for (const u of members()) c.sim.fault(F.uuid, u, { delay: [25, 40] }) })
        }
        c.sim.at(5000, () => drain(0)) // the backstop: the link heals whatever the schedule did
        //! F's sheds, latches and folds, read by cursor every 5 ms slice: the first shed starts the rest
        let jn = F.journal.n
        c.polls.push(() => {
          if (!c.sim.nodes.has(F.uuid)) return
          const first = shed.size === 0
          for (const row of F.journal.read(jn)) {
            const p = row.a as string
            if (row.kind === JK.shed) { shed.add(p); c.eng.fedSheds = (c.eng.fedSheds ?? 0) + 1 }
            else if (row.kind === JK.acquireStart && shed.has(p)) { c.eng.relatches = (c.eng.relatches ?? 0) + 1; if (heal === 'mid') drain(th) }
            else if (row.kind === JK.acquire && shed.has(p)) { c.eng.refolds = (c.eng.refolds ?? 0) + 1; if (heal === 'after') drain(th) }
          }
          jn = F.journal.n
          if (!first || !shed.size) return
          //! the first shed: rows onto the shed partitions while they are away (writes, field writes, removes), posted at
          // another member (routed to their owner: nothing of them reaches F, nor its paused link)
          const gone = [...shed], at = members().filter((u) => u !== 'n90')
          if (at.length) for (let i = 0; i < away; i++) {
            const q = pick(c.r, gone), roll = c.r()
            const rec: Rec = roll < 0.45 ? { type: REC.update, key: [q], value: { away: i } } : roll < 0.75 ? { type: REC.update, key: [q, 'f' + (i % 3)], value: i } : { type: REC.remove, key: roll < 0.9 ? [q] : [q, 'f0'] }
            c.sim.post(pick(c.r, at), { kind: 'write', recs: [rec] }, 2 * i)
          }
          //! taps: a burst onto partitions F still holds, tapped onto the paused link until a clear takes the word
          if (taps) {
            const mine = [...F.scope!.entries].filter(([, e]) => e.state === SCOPE.held).map(([q]) => q)
            if (mine.length) for (let i = 0; i < burst; i++) c.sim.post(F.uuid, { kind: 'write', recs: [{ type: REC.update, key: [pick(c.r, mine), 'tap'], value: i }] }, tb + 2 * i)
          }
          if (heal === 'before') { drain(2 * Math.max(away, burst) + tb + 20 + th); leave(2 * Math.max(away, burst) + tb + 20 + th + tl) }
          else leave(tl)
        })
        //! the heal exchange's end: the first quiet point after the drain (spokeQuiet: everything F sent has landed, its
        // link synced and flowing again, the spoke not in resync, no fold group open) judges the spoke against F, as
        // kernel/client.test.ts does right after the heal's settle: M12 over the partitions F holds; for every partition F
        // FEEDS (held, or a latch from a held base or from nothing) the spoke holds exactly F's cells, and nothing of a
        // partition F has no entry for (an orphan's frozen rows are left alone: its shed says the word); and the screen
        // equals the kernel. Armed by the drain, not by a pay, so a word never said is judged too.
        c.sim.monitors.push({
          name: 'a14-heal-end',
          check: (sim) => {
            if (!due) return null
            const s = sim.nodes.get('s1')
            if (s === undefined || !sim.nodes.has(F.uuid) || spokeQuiet(sim, s) !== F) return null
            due = false
            c.eng.healEnds = (c.eng.healEnds ?? 0) + 1
            const m = spokeMirror(sim, 's1')
            if (m !== null) return `at the heal exchange's end: ${m}`
            const sc = F.scope!
            for (const [k, v] of s.state) {
              const p = (JSON.parse(k) as string[])[0]
              if (!sc.entries.has(p)) return `at the heal exchange's end: s1 shows ${k} of '${p}', a partition its feeder ${F.uuid} has no entry for (the owed {x} drops it)`
              if (!sc.feeds(p)) continue
              if (!F.state.has(k)) return `at the heal exchange's end: s1 shows ${k} of '${p}', which its feeder ${F.uuid} feeds without that cell`
              if (stable(F.state.get(k)) !== stable(v)) return `at the heal exchange's end: s1 shows ${k} = ${stable(v)}; its feeder ${F.uuid} feeds ${stable(F.state.get(k))}`
            }
            for (const k of F.state.keys()) {
              const p = (JSON.parse(k) as string[])[0]
              if (sc.feeds(p) && !s.state.has(k)) return `at the heal exchange's end: s1 lacks ${k}, which its feeder ${F.uuid} feeds for '${p}'`
            }
            const scr = screenMatches(sim, 's1')
            return scr === null ? null : `at the heal exchange's end: screen: ${scr}`
          },
        })
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
  const ft = fam.tune !== undefined ? fam.tune(r) : {}
  //! the stage-2 mutations switch the sweep off through the tune row (drop-dirty: so the sweep cannot heal what the
  // dirty leg should have); the injected-drop class leaves the tune alone
  const stage2 = mut === 'no-sweep' || mut === 'drop-dirty'
  const o: MeshOpts = { replicas: R, durable, hb: 50, tune: { compactAt: 16, snapshotAt: 16, ...ft, ...(stage2 ? { aeFan: 0 } : {}) }, fault: { delay: [1, 5] } }
  const sim = new Sim(seed)
  const eng: Record<string, number> = {}
  const out: Out = { family: fam.name, seed, shape: `${fam.name} seed ${seed} n=${n} R=${R}${durable ? ' durable' : ''} parts=${parts} writes=${count}${Object.entries(ft).map(([k, v]) => ` ${k}=${v}`).join('')}${mut !== 'none' ? ' mut=' + mut : ''}`, R, unsafe: [], notLive: [], redToday: [], red: new Set(), eng, sim }
  const nodes = mesh(sim, n, o)
  if (mut === 'no-sweep') eng.mutated = 1
  //! drop-dirty: after every event, every stepped armed node's dirty set is emptied — the stamp site's one mark never
  // reaches the tick, exactly as a dropped dirty site would read
  if (mut === 'drop-dirty') sim.monitors.push({
    name: 'mutation-drop-dirty',
    check: (s) => {
      for (const id of s.stepped) { const x = s.nodes.get(id); if (x !== undefined && x.armed && x.scope !== null && x.scope.dirty.size) { x.scope.dirty.clear(); eng.mutated = 1 } }
      return null
    },
  })
  //! owed-x-dropped: each server's `owe` drops the kind 'x' from the first pass that sees the server step (a word is
  // owed many events later); this monitor sits before any counter a family installs, so a counter still sees the call
  if (mut === 'owed-x-dropped') {
    const seen = new WeakSet<Node>()
    sim.monitors.push({
      name: 'mutation-owed-x-dropped',
      check: (s) => {
        for (const id of s.full || s.allDirty ? s.nodes.keys() : s.stepped) {
          const x = s.nodes.get(id)
          if (x === undefined || x.client || seen.has(x)) continue
          seen.add(x)
          const owe = x.owe.bind(x)
          x.owe = (link, kind, p) => { if (kind === 'x') { eng.mutated = 1; return } owe(link, kind, p) }
        }
        return null
      },
    })
  }
  sim.run({ until: 1500 })
  if (!nodes.every((x) => x.armed)) { out.notLive.push('never formed'); return out }
  const t0 = sim.now
  const c: Ctx = { sim, r, n, R, durable, o, nodes, eng, t0, parts, polls: [], mutAt: t0 + fam.mutateAt }
  post(sim, plan(r, nodes.map((x) => x.uuid), count, parts, 600), t0)
  fam.chaos(c)
  //! the mutation fires at the first 5 ms slice at or past c.mutAt; its draws come from a separate stream so the
  // schedule itself is the same with and without it
  const mr = mul(seed * 31 + 7)
  let mutated = mut === 'none' || stage2 || mut === 'owed-x-dropped'
  for (let t = sim.now; t <= t0 + horizon; t += 5) {
    sim.run({ until: t })
    for (const f of c.polls) f()
    if (!mutated && sim.now >= c.mutAt) { mutated = true; if (inject(sim, mr, mut)) eng.mutated = 1 }
  }
  //! the verdict
  for (const v of sim.violations) {
    out.red.add(v.monitor)
    if (out.unsafe.length < 3) out.unsafe.push(`${v.monitor} @${v.event}: ${v.detail}`)
  }
  const m1 = stampOracle(sim)
  if (m1) { out.red.add('stamp-oracle'); out.unsafe.push('M1 horizon: ' + m1) }
  //! M7's two forms, each with its non-vacuity count (eng.floorLanes, eng.markPairs); stale knowledge is named by
  // monitor so the stage-2 mutation runner can read the catch off `red`
  const fc = { lanes: 0 }, mc = { pairs: 0 }
  const live = [scopedConverged(sim), exactlyR(sim), floorsAgree(sim, fc)].filter((x): x is string => x !== null)
  const m7k = marksAgree(sim, mc)
  if (m7k !== null) { out.red.add('marks-agree'); live.push(m7k) }
  out.notLive.push(...live)
  eng.floorLanes = fc.lanes; eng.markPairs = mc.pairs
  //! every spoke's screen equals its kernel at the horizon (a spoke is compared to no other node, so projected()
  // does not cover it): a screen-only ghost is UNSAFE, whatever the kernel holds
  for (const [id, n] of sim.nodes) if (n.client) { const m = screenMatches(sim, id); if (m !== null) { out.red.add('screen'); out.unsafe.push('screen: ' + m) } }
  //! M12 (wave 6a): every spoke's kernel holds exactly its feeder's held subset, by value — a missing or differing
  // row is UNSAFE (a spoke that silently lacks a row its feeder holds is a lost write to its reader). Counted:
  // eng.spokeParts / eng.spokeCells (non-vacuity), eng.feederAcquires (what the spoke's feeder folded through the
  // latch — the records the forward must carry), eng.spokeStale (rows of partitions that moved off the feeder, kept at
  // the spoke: counted, not judged — STATUS names the gap; its own key: eng.stale is A2's count of a demoted owner's
  // commits)
  const m12 = { parts: 0, cells: 0 }
  for (const [id, n] of sim.nodes) {
    if (!n.client) continue
    const m = spokeMirror(sim, id, m12)
    if (m !== null) { out.red.add('spoke-mirror'); out.unsafe.push(m) }
    eng.spokeStale = (eng.spokeStale ?? 0) + spokeStale(sim, id).n
    const f = n.primary !== null ? sim.nodes.get(n.links.get(n.primary)!.uuid) : undefined
    if (f !== undefined) for (const e of f.journal.read()) if (e.kind === JK.acquire) eng.feederAcquires = (eng.feederAcquires ?? 0) + 1
  }
  eng.spokeParts = m12.parts; eng.spokeCells = m12.cells
  //! the FEED words (A14 installs the counter; no other family does, so their engagement rows are what they were)
  const fw = feedWordsOf(sim)
  if (fw !== undefined) Object.assign(eng, { owedX: fw.owedX, owedE: fw.owedE, paidX: fw.paidX, paidE: fw.paidE, saidX: fw.saidX, saidB: fw.saidB, saidE: fw.saidE, feedOdd: fw.odd })
  //! M8 in two halves (DESIGN-SCALE stage 3, 2026-10-12): the LANE half is a law now — scoped compaction keeps every lane
  // at or under winners + compactAt at the horizon, so a lane over it is a liveness problem (compaction did not keep up);
  // the TOMBSTONE half stays red today (no pin surface until stage 4)
  const lanes = boundedLanes(sim)
  if (lanes !== null) { out.red.add('bounded-lanes'); out.notLive.push('M8 lanes: ' + lanes) }
  if (boundedTombs(sim)) out.redToday.push('M8')
  const L = ledgerOf(sim)
  Object.assign(eng, { cells: L.counts.cells, advances: L.counts.advances, releases: L.counts.releases, census: L.counts.census, drops: L.counts.drops, leaves: L.counts.leaves, resyncs: L.counts.resyncs, resyncRows: L.counts.resyncRows, resyncKept: L.counts.resyncKept })
  eng.sheds = jcount(sim, JK.shed); eng.acquires = jcount(sim, JK.acquire); eng.compactions = jcount(sim, JK.compacted)
  eng.stalls = jcount(sim, JK.shedStall); eng.epoch = Math.max(...[...sim.nodes.values()].map((x) => x.epoch))
  //! the lane rule (wave 6b): how many neighbouring (seq, seq) pairs the lane-unique monitor compared over the run
  eng.lanePairs = laneUniqueCounts(sim)?.pairs ?? 0
  return out
}

export const familyByName = (name: string): Family => FAMILIES.find((f) => f.name === name)!
