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

//! cluster — n nodes, full dial mesh (everyone dials everyone: deliberately redundant so the one-link-per-pair dedup is exercised on every formation).
export const cluster = (sim: Sim, n: number, opts: { heartbeatMs?: number; durable?: boolean; fault?: Fault } = {}): Node[] => {
  const ids = Array.from({ length: n }, (_, i) => `n${String(i + 1).padStart(2, '0')}`)
  const addrs = ids.map((id) => `sim:${id}`)
  const nodes = ids.map((id, i) =>
    sim.add({
      uuid: id,
      listen: addrs[i],
      hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: opts.heartbeatMs ?? 0, // explicit protocol mode — heartbeats OFF by default so quiescence is reachable
      durable: opts.durable ?? false, // explicit protocol mode — storage OFF by default (zero persist effects)
      redialMs: 20,
      journalCap: 1 << 16, // capture-grade history: time-travel replay needs the journal un-truncated
    }),
  )
  sim.monitors.push(...perEvent())
  for (const id of ids) sim.post(id, { kind: 'start' })
  return nodes
}

//! formed — every node admits every other (the mesh is fully identified). A query, never a poll.
export const formed = (nodes: Node[]): boolean =>
  nodes.every((n) => n.admitted().length === nodes.length - 1)

//! writes — schedule a deterministic-random workload: `count` writes spread over (0, spanMs], mixed types/values drawn from the sim's seeded rng.
export const writes = (sim: Sim, nodes: Node[], count: number, spanMs = 300) => {
  const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsi']
  for (let i = 0; i < count; i++) {
    const node = nodes[Math.floor(sim.rng() * nodes.length)]
    const key = keys[Math.floor(sim.rng() * keys.length)] + Math.floor(sim.rng() * 4)
    const roll = sim.rng()
    const rec: Rec =
      roll < 0.15
        ? { type: REC.remove, key: [key] }
        : roll < 0.5
          ? { type: REC.update, key: [key], value: valueOf(sim, i) }
          : roll < 0.75
            ? { type: REC.update, key: [key, 'nested'], value: valueOf(sim, i) }
            : { type: REC.insert, key: [], at: key, value: valueOf(sim, i) }
    sim.post(node.uuid, { kind: 'write', recs: [rec] }, 1 + sim.rng() * spanMs)
  }
}

//! valueOf — a value zoo: scalars, unicode, NaN, nested obj/arr, bytes — every VT the codec claims, exercised on every sweep.
const valueOf = (sim: Sim, i: number): unknown => {
  switch (Math.floor(sim.rng() * 8)) {
    case 0: return i
    case 1: return sim.rng() < 0.5 ? null : undefined
    case 2: return sim.rng() < 0.5
    case 3: return `v${i}-é中文` // unicode strings cross the utf8 path
    case 4: return sim.rng() < 0.3 ? NaN : sim.rng() * 1e9 // NaN must survive bit-exactly (f64 codec claim)
    case 5: return { n: i, s: `s${i}`, deep: { ok: true, list: [1, 'two', null] } }
    case 6: return [i, `x${i}`, { y: i }]
    default: return new Uint8Array([i & 0xff, (i >> 8) & 0xff])
  }
}
