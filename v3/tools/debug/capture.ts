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
import { diagNode } from '../../kernel/diag.ts'
import type { Node } from '../../kernel/node.ts'
import type { Sim } from '../../sim/exec.ts'
import type { Shrunk, Step } from '../../sim/shrink.ts'
import { encodeVal } from './model.mjs'

//! captureNode — one node's slice: journal + logs + state + watermarks + links, values made JSON-safe.
// RE-BASED (M7, DESIGN-M7 §1) onto the kernel's diagNode fold — the SAME producer the DIAG wire's
// q:'node' serves, so the in-process capture and a remote attach can never drift (parity by
// construction; the deepEqual pin in diag.test.ts backstops). This file adds only what the wire
// chunks separately (journal, logs, state) plus encodeVal — the JSON-safety pass the wire doesn't
// need (the value codec carries NaN/bytes/undefined natively).
export const captureNode = (node: Node) => {
  const d = diagNode(node)
  return {
    uuid: d.uuid,
    listen: d.listen,
    seq: d.seq,     // Lamport clock — the node's own next-write stamp
    epoch: d.epoch,
    //! M2 membership facts: the committed view, the write-gate verdict, and any parked writes
    view: d.view,
    gate: d.gate,
    pendingWrites: d.pendingWrites,
    stateHash: d.stateHash,
    dropped: d.dropped,
    journal: node.journal.read(0),
    logs: Object.fromEntries(
      [...node.logs].map(([origin, entries]) => [
        origin,
        entries.map((e) => ({ k: e.rec.key, at: e.rec.at, ty: e.rec.type, v: encodeVal(e.rec.value), seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid })),
      ]),
    ),
    state: [...node.state].map(([k, v]) => [k, encodeVal(v)]),
    //! the full watermark ladder per stream (M4a): a = applied, s = shippable, d = durable
    streams: d.streams,
    links: d.links,
  }
}

//! encodeSteps — Step lists made JSON-safe: only write recs carry values (NaN/undefined/bytes survive encodeVal).
const encodeSteps = (steps: Step[]) =>
  steps.map((s) => (s.op === 'write' ? { ...s, recs: s.recs.map((r) => ('value' in r ? { ...r, value: encodeVal(r.value) } : r)) } : s))

//! captureSim — a whole seeded trajectory: the failure report IS the debug artifact (tests ARE debug artifacts).
// The optional shrunk block (M7, DESIGN-M7 §2) is ADDITIVE on capture v1: the minimal steps, the
// original-vs-final honesty pair, and a standalone-replayable repro — the viewer says "shrunk", never guesses.
export const captureSim = (sim: Sim, shrunk?: Shrunk) => ({
  v: 1,
  kind: 'sim' as const,
  vocab: JK,
  seed: sim.seed,
  events: sim.events,
  quiesced: sim.quiesced,
  violations: sim.violations,
  nodes: [...sim.nodes.values()].map(captureNode),
  ...(shrunk
    ? {
        shrunk: {
          from: shrunk.from,
          steps: encodeSteps(shrunk.steps),
          repro: { ...shrunk.repro, steps: encodeSteps(shrunk.repro.steps) },
          removed: shrunk.removed,
          runs: shrunk.runs,
          capped: shrunk.capped,
          fail: shrunk.fail,
          atViolation: shrunk.atViolation,
        },
      }
    : {}),
})

//! captureLive — a running cluster polled in-process (the pull-spine: truthful state on demand, v2's O rule).
export const captureLive = (nodes: Node[]) => ({
  v: 1,
  kind: 'live' as const,
  vocab: JK,
  seed: null,
  nodes: nodes.map(captureNode),
})

//! Absent — a target that yielded NO truthful slice this rebuild, with the closed reason set. Absence
// renders as absence: an absent row changes the header and NOTHING else (folds range over nodes[] only,
// so no fold can mint a route status or a replay verdict for an uncaptured node — structural honesty).
export interface Absent {
  target: string
  reason: 'refused' | 'timeout' | 'unauthorized' | 'frame' | 'vocab-mismatch' | 'restarted' | 'error'
}
//! AttachAnswer — one target's truthful pull: its OWN vocabulary + its captureNode-shaped slice.
export interface AttachAnswer { target: string; vocab: Record<string, number>; node: ReturnType<typeof captureNode> }

//! captureAttached (M7, DESIGN-M7 §3) — the /capture.json envelope for a REAL (multi-process) cluster,
// assembled from DIAG pulls. Vocab rule: UNION-if-consistent — JK is append-only, so honest version
// skew between nodes is subset/superset and the union renders every node's events; a CONFLICTING
// mapping (same name→different code, or same code→different name) marks an impossible/lying vocabulary
// and demotes that node to absent 'vocab-mismatch' (first-seen wins the union — deterministic given the
// pool's sorted answer order). Same v1 'live' shape as captureLive, so viewer/model work unchanged.
export const captureAttached = (answers: AttachAnswer[], failures: Absent[]) => {
  const vocab: Record<string, number> = {}
  const byCode = new Map<number, string>()
  const nodes: ReturnType<typeof captureNode>[] = []
  const absent: Absent[] = [...failures]
  for (const a of answers) {
    const clash = Object.entries(a.vocab).some(
      ([name, code]) => (vocab[name] !== undefined && vocab[name] !== code) || (byCode.has(code) && byCode.get(code) !== name),
    )
    if (clash) { absent.push({ target: a.target, reason: 'vocab-mismatch' }); continue }
    for (const [name, code] of Object.entries(a.vocab)) { vocab[name] = code; byCode.set(code, name) }
    nodes.push(a.node)
  }
  return { v: 1, kind: 'live' as const, vocab, seed: null, nodes, absent }
}
