//! ── sim/harness — the scenario DSL, carrying v2's proven chaos vocabulary ─────
// v2's harness predicates (cluster/formed/converged/kill-vs-partition as
// distinct verbs) were the good bones — the scenarios are expensive knowledge,
// the wall-clock harness they ran on is not (plan §6). This re-platforms the
// vocabulary on the executive: `formed` is a state QUERY after run-to-
// quiescence, not an until() poll; writes are scheduled at exact virtual times;
// convergence is asserted at true quiescence.

import { Sim, type Fault } from './exec.ts'
import { perEvent } from './monitors.ts'
import { REC, type Rec } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'
import type { Step } from './shrink.ts' // type-only: no runtime cycle (shrink imports harness at runtime)

//! cluster — n nodes, full dial mesh (everyone dials everyone: deliberately redundant so the one-link-per-pair dedup is exercised on every formation).
export const cluster = (sim: Sim, n: number, opts: { heartbeatMs?: number; durable?: boolean; replicas?: number; fault?: Fault } = {}): Node[] => {
  //! id width follows n: lexicographic order IS uuid order (the lowest uuid is the genesis proposer,
  // membership.ts gate) — at n=100 a 2-wide pad would sort n100 between n10 and n11. n≤99 keeps the
  // historical 2-wide ids so every seeded golden stays byte-identical.
  const pad = Math.max(2, String(n).length)
  const ids = Array.from({ length: n }, (_, i) => `n${String(i + 1).padStart(pad, '0')}`)
  const addrs = ids.map((id) => `sim:${id}`)
  const nodes = ids.map((id, i) =>
    sim.add({
      uuid: id,
      listen: addrs[i],
      hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: opts.heartbeatMs ?? 0, // explicit protocol mode — heartbeats OFF by default so quiescence is reachable
      durable: opts.durable ?? false, // explicit protocol mode — storage OFF by default (zero persist effects)
      ...(opts.replicas !== undefined ? { replicas: opts.replicas } : {}), // explicit protocol mode — scoping OFF by default (M6)
      redialMs: 20,
      journalCap: 1 << 16, // capture-grade history: time-travel replay needs the journal un-truncated
    }),
  )
  //! per-pair fault personalities for the whole mesh. sim.fault() draws NO rng and the ids are
  // literal, so passing `fault` perturbs only this cluster's own trajectory — never another seed's
  // draw order. Joiners added later via sim.add pair at the sim's DEFAULT personality; a scenario
  // wanting faulted joiners installs sim.fault for those pairs explicitly.
  if (opts.fault)
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) sim.fault(ids[i], ids[j], opts.fault)
  sim.monitors.push(...perEvent())
  for (const id of ids) sim.post(id, { kind: 'start' })
  return nodes
}

//! formed — every node admits every other (the mesh is fully identified). A query, never a poll.
export const formed = (nodes: Node[]): boolean =>
  nodes.every((n) => n.admitted().length === nodes.length - 1)

//! client — a SPOKE (M5b): dials the given members, elects one primary feeder, folds the same
// replication stream, writes as ae=0 relayed attempts. Convergence checks range over it like any node.
export const client = (sim: Sim, id: string, servers: Node[], opts: { heartbeatMs?: number } = {}): Node => {
  const c = sim.add({
    uuid: id,
    listen: `sim:${id}`,
    hosts: servers.map((s) => `sim:${s.uuid}`),
    heartbeatMs: opts.heartbeatMs ?? 0,
    client: true,
    redialMs: 20,
    journalCap: 1 << 16,
  })
  sim.post(id, { kind: 'start' })
  return c
}

//! writesPlan — the same workload as `writes`, PLANNED as literal Steps instead of posted (M7 shrinker
// contract, DESIGN-M7 §2): every rng draw happens here, at plan time, in EXACTLY the draw order the
// pre-split writes() used (node, key, key-suffix, roll, value draws, delay — per iteration) so the split
// is byte-invisible to every seeded trajectory (pinned by shrink.test.ts's golden + the frozen 1000-seed
// sweep count). Posting a Step draws NOTHING — which is what lets the shrinker remove one step without
// shifting any other step's randomness (replan-to-burn: determinism is self-enforcing).
export const writesPlan = (rng: () => number, uuids: string[], count: number, spanMs = 300): Step[] => {
  const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsi']
  const out: Step[] = []
  for (let i = 0; i < count; i++) {
    const uuid = uuids[Math.floor(rng() * uuids.length)]
    const key = keys[Math.floor(rng() * keys.length)] + Math.floor(rng() * 4)
    const roll = rng()
    const rec: Rec =
      roll < 0.15
        ? { type: REC.remove, key: [key] }
        : roll < 0.5
          ? { type: REC.update, key: [key], value: valueOf(rng, i) }
          : roll < 0.75
            ? { type: REC.update, key: [key, 'nested'], value: valueOf(rng, i) }
            : { type: REC.insert, key: [], at: key, value: valueOf(rng, i) }
    out.push({ at: 1 + rng() * spanMs, op: 'write', uuid, recs: [rec] })
  }
  return out
}

//! writes — schedule a deterministic-random workload: `count` writes spread over (0, spanMs], mixed types/values drawn from the sim's seeded rng. Now plan-then-post; API and draw order unchanged.
export const writes = (sim: Sim, nodes: Node[], count: number, spanMs = 300) => {
  for (const s of writesPlan(sim.rng, nodes.map((n) => n.uuid), count, spanMs))
    if (s.op === 'write') sim.post(s.uuid, { kind: 'write', recs: s.recs }, s.at)
}

//! valueOf — a value zoo: scalars, unicode, NaN, nested obj/arr, bytes — every VT the codec claims, exercised on every sweep.
const valueOf = (rng: () => number, i: number): unknown => {
  switch (Math.floor(rng() * 8)) {
    case 0: return i
    case 1: return rng() < 0.5 ? null : undefined
    case 2: return rng() < 0.5
    case 3: return `v${i}-é中文` // unicode strings cross the utf8 path
    case 4: return rng() < 0.3 ? NaN : rng() * 1e9 // NaN must survive bit-exactly (f64 codec claim)
    case 5: return { n: i, s: `s${i}`, deep: { ok: true, list: [1, 'two', null] } }
    case 6: return [i, `x${i}`, { y: i }]
    default: return new Uint8Array([i & 0xff, (i >> 8) & 0xff])
  }
}
