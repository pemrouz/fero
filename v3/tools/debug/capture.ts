//! ── tools/debug/capture — one capture format for sim runs AND live clusters ──
// A capture is everything the debugger needs and nothing it must guess at
// (plan §8): per-node journals (the typed event history), per-origin record
// logs (the payloads replay joins to), end state + hash (the replay oracle),
// stream watermarks and link tables (the topology facts) — plus the event
// VOCABULARY itself, generated from the kernel's JK const so a capture is
// self-describing and viewer filters cannot drift from the wire (append-only
// kinds mean old captures stay renderable). Sim traces and production captures
// are the SAME format viewed in the SAME tool.

import { JK } from '../../kernel/journal.ts'
import { LS } from '../../kernel/link.ts'
import type { Node } from '../../kernel/node.ts'
import type { Sim } from '../../sim/exec.ts'
import { encodeVal } from './model.mjs'

//! captureNode — one node's slice: journal + logs + state + watermarks + links, values made JSON-safe.
export const captureNode = (node: Node) => ({
  uuid: node.uuid,
  listen: node.listen,
  seq: node.seq,     // Lamport clock — the node's own next-write stamp
  epoch: node.epoch,
  //! M2 membership facts: the committed view, the write-gate verdict, and any parked writes
  view: { epoch: node.membership.view.epoch, members: node.membership.view.members.map((m) => m[0]) },
  gate: (() => { const g = node.membership.gate(node); return g.open ? 'open' : g.reason })(),
  pendingWrites: node.writes.pending.size,
  stateHash: node.stateHash,
  dropped: node.journal.dropped,
  journal: node.journal.read(0),
  logs: Object.fromEntries(
    [...node.logs].map(([origin, entries]) => [
      origin,
      entries.map((e) => ({ k: e.rec.key, at: e.rec.at, ty: e.rec.type, v: encodeVal(e.rec.value), seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid })),
    ]),
  ),
  state: [...node.state].map(([k, v]) => [k, encodeVal(v)]),
  //! the full watermark ladder per stream (M4a): a = applied, s = shippable, d = durable
  streams: Object.fromEntries([...node.streams].map(([origin, w]) => [origin, { a: w.applied, s: w.shippable, d: w.durable }])),
  links: [...node.links.values()].map((l) => ({
    id: l.id, uuid: l.uuid, dialed: l.dialed, admitted: l.state === LS.admitted, synced: l.synced,
    paused: l.paused, queued: l.queued.length,
  })),
})

//! captureSim — a whole seeded trajectory: the failure report IS the debug artifact (tests ARE debug artifacts).
export const captureSim = (sim: Sim) => ({
  v: 1,
  kind: 'sim' as const,
  vocab: JK,
  seed: sim.seed,
  events: sim.events,
  quiesced: sim.quiesced,
  violations: sim.violations,
  nodes: [...sim.nodes.values()].map(captureNode),
})

//! captureLive — a running cluster polled in-process (the pull-spine: truthful state on demand, v2's O rule).
export const captureLive = (nodes: Node[]) => ({
  v: 1,
  kind: 'live' as const,
  vocab: JK,
  seed: null,
  nodes: nodes.map(captureNode),
})
