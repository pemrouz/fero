//! ── kernel/diag — the authenticated DIAG plane: attach, pull, never participate (M7, DESIGN-M7 §1) ──
// The diagnostics channel plan §8 reserved from the first protocol byte. A debug client opens a normal
// TCP link and HELLOs with r:2 + a bearer token; a match against the config allowlist latches the link
// to LS.diag — a state that is STRUCTURALLY outside membership: never in byUuid (a spoofed uuid cannot
// trip the dup-link keeper against a real member), never LS.admitted (excluded from admitted(), genesis,
// suspicion, heartbeats, AE, and every admitted-only verb), never in clientLinks (zero per-record
// fan-out/flush tax while attached). After the latch, per-frame auth is the state check alone — the
// records-before-hello shape. Everything here is pure (node, link, value) → journal emits + link.ship:
// no new Event kinds, no EffectSink methods, and nothing reachable without an r:2 HELLO or verb 23/24
// arriving — the 1000-seed sweep stays byte-identical by construction.
//
// The wire is pull-only (v2 DECISIONS O end-to-end): no push, no watch, no mutation ops — the bridge's
// poll is the only cadence in the system. WAL segments are NOT pullable (captureNode parity is the bar;
// WAL bytes are the shell's file). The token crosses cleartext — run DIAG on trusted networks or a
// tunnel (plan §12: auth beyond this allowlist is post-1.0, stated out loud).

import { VERB, encodeControl, FrameError } from './codec.js'
import { LS,           } from './link.js'
import { JK } from './journal.js'
import { partitionOf } from './env.js'
                                     

//! DIAG_MAX: rows per journal/logs chunk — chunked cursor pulls are what keep a big node servable
// (the review killed the monolithic whole-node pull: one oversized frame = FrameError = link drop = a
// deterministic re-dial loop on exactly the busy nodes a debugger attaches to).
export const DIAG_MAX = 4096
//! DIAG_P: the DIAG payload protocol version — reported in meta/ACCEPT; version skew degrades typed ('bad-op'), never fatally.
export const DIAG_P = 1

//! ctEq — length + constant-time XOR compare: token checks must not leak match-prefix length via timing.
const ctEq = (a        , b        )          => {
  if (a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

//! reply — every DIAGA leaves through this gate: the encode is guarded (a FrameError from an oversized
// body becomes a TYPED {ok:0, e:'too-large'} answer, never an escape into the bytesIn net where it
// would read as a wire fault and drop the session).
const reply = (node      , link      , body                         )       => {
  const j = node.journal
  let bytes            
  try {
    bytes = encodeControl(VERB.DIAGA, body)
  } catch (err) {
    if (!(err instanceof FrameError)) throw err
    bytes = encodeControl(VERB.DIAGA, { id: body.id, u: body.u, i: body.i, ok: 0, e: 'too-large' })
  }
  link.ship(bytes, node.env.sink, j)
}

//! diagHello — the whole session machine. Guards in order: used-link (an r:2 on an admitted member/client
// link, or a re-HELLO on an already-latched session, closes WITHOUT touching the link's existing
// identity — byUuid must never ghost), fail-closed config, malformed token, then the constant-time
// allowlist sweep. DENY ships ONE constant wire reason ('denied' — no enumeration oracle: the wire never
// distinguishes no-config from bad-token); the TYPED reason goes to the journal, where the audit lives.
// The presented token itself is never journaled. LATCH ships the ACCEPT {id:0, ok:1, u, i, p} — kept
// because the deny frame is best-effort under the shell's socket.destroy, so close-before-ACCEPT is the
// one reliable client contract.
export const diagHello = (node      , link      , v                         )       => {
  const j = node.journal
  if (link.state !== LS.hello || link.uuid !== '') {
    j.armed && j.emit(JK.frameDrop, link.id, 'diag hello on used link')
    link.dead = link.noRedial = true
    return node.env.sink.close(link.id, 'diag-denied')
  }
  const deny = (reason        ) => {
    j.armed && j.emit(JK.diagDeny, link.id, reason)
    reply(node, link, { id: 0, ok: 0, e: 'denied' })
    link.dead = link.noRedial = true
    node.env.sink.close(link.id, 'diag-denied')
  }
  const allow = node.diagAllow
  if (!allow) return deny('no-config')
  const names = Object.keys(allow)
  if (!names.length) return deny('no-config')
  const t = v.t
  if (typeof t !== 'string') return deny('malformed')
  for (const name of names)
    if (ctEq(t, allow[name])) {
      link.state = LS.diag
      link.noRedial = true // a closed diag session is the client's to re-open; the node never redials it
      j.armed && j.emit(JK.diagAuth, link.id, name)
      return reply(node, link, { id: 0, ok: 1, u: node.uuid, i: node.incarnation, p: DIAG_P })
    }
  deny('bad-token')
}

//! diagNode — THE one-node fold, shared by the wire (q:'node') and the in-process capture (capture.ts
// re-bases captureNode onto this): one producer, two consumers, drift impossible by construction.
// Every field is a codec-safe scalar/array; `origins` adds the per-lane {tail, base} the logs cursor
// needs (base = the compaction floor: empty-answer-with-tail>f means "compacted past you", not "caught up").
//! ownHolders — the holder set of every partition in this node's OWN lane (ISSUES I-3): the ring's own
// answer (holders(p, replicas), holder[0] = the owner), carried in the capture so the debugger never
// re-derives placement (the page cannot import ring.ts, and a re-implemented hash would drift). Own lane
// only: a route's partition is named by its origin's writeLocal row, so the origin's slice answers it.
// The stale-ring guard is the scope.ts one — a lazy rebuild to the committed view, the same arrays the
// write path would build on its next record. Armed nodes only (scoped, view committed).
// The own writeLocal journal rows are walked too: a partition this node wrote but no longer holds (it
// shed it, or wrote it before the view armed and was never one of its holders) has left the log, yet
// its route still needs the holder fact. The rows are the routes' own source, so the two always match.
const ownHolders = (node      )                           => {
  const ring = node.writes.ring
  if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
  const out = new Map                  ()
  const add = (p        ) => { if (!out.has(p)) out.set(p, [...ring.holders(p, node.replicas)]) }
  for (const e of node.logs.get(node.origin) ?? []) add(partitionOf(e.rec))
  for (const e of node.journal.read(0)) if (e.kind === JK.writeLocal) add(String(e.b))
  return Object.fromEntries(out)
}

export const diagNode = (node      ) => ({
  uuid: node.uuid,
  listen: node.listen,
  seq: node.seq,
  epoch: node.epoch,
  view: { epoch: node.membership.view.epoch, members: node.membership.view.members.map((m) => m[0]) },
  gate: (() => { const g = node.membership.gate(node); return g.open ? 'open' : g.reason })(),
  pendingWrites: node.writes.pending.size,
  //! client: this node's OWN role (M5b spoke) — the debugger's topology replay needs it for the single-feeder
  // synced rule (a client digests only its primary); additive, so an older bridge simply never sees it
  client: node.client,
  //! replicas + holders (ISSUES I-3): scoped replication sends a write to its holders only, so a member
  // outside the set never getting it is the design, not a loss — additive, an older bridge never sees them
  replicas: node.replicas,
  ...(node.armed ? { holders: ownHolders(node) } : {}),
  stateHash: node.stateHash,
  jn: node.journal.n,
  dropped: node.journal.dropped,
  streams: Object.fromEntries([...node.streams].map(([origin, w]) => [origin, { a: w.applied, s: w.shippable, d: w.durable }])),
  origins: Object.fromEntries(
    [...node.logs].map(([o, entries]) => [o, { tail: entries.length ? entries[entries.length - 1].seq : 0, base: entries.length ? entries[0].seq : 0 }]),
  ),
  links: [...node.links.values()].map((l) => ({
    id: l.id, uuid: l.uuid, dialed: l.dialed, admitted: l.state === LS.admitted, synced: l.synced,
    paused: l.paused, queued: l.queued.length, client: l.client, diag: l.state === LS.diag,
  })),
})

//! onDiagQ — the op switch. Requests are {id ≥ 1, q, ...args}; every reply echoes {id, u, i} so the
// bridge detects a restart PER PULL (an incarnation change opens a new capture segment, never stitches —
// the origin-lane rebirth rule applied to diagnostics). Unknown q → typed 'bad-op', KEEP the link (a
// newer bridge probing an older node degrades typed, never fatally).
//
// EMISSION POLICY (deliberate asymmetry — do not "fix" it into spam): diagPull is emitted for the
// data-bearing reads (node/logs/state) AFTER the reply builds (a pull never contains its own row).
// q:'journal' and q:'meta' emit NOTHING: journaling reads-of-the-journal at follow cadence evicts the
// very history being followed (a 1 Hz live-dash would eat a 4096-cap ring in minutes). The audit anchor
// for a session is diagAuth + linkDown.
export const onDiagQ = (node      , link      , v                         )       => {
  const j = node.journal
  const id = typeof v.id === 'number' && v.id >= 1 ? Math.floor(v.id) : 0
  const base = { id, u: node.uuid, i: node.incarnation }
  if (!id) return reply(node, link, { ...base, ok: 0, e: 'bad-args' })
  switch (v.q) {
    case 'meta':
      //! the node serves its OWN vocabulary — a capture stays self-describing across processes; version skew is data
      return reply(node, link, { ...base, ok: 1, l: node.listen, p: DIAG_P, vocab: JK })
    case 'node': {
      reply(node, link, { ...base, ok: 1, n: diagNode(node) })
      j.armed && j.emit(JK.diagPull, link.id, 'node', 1)
      return
    }
    case 'journal': {
      //! journal cursor f is INCLUSIVE (Journal.read's own convention); the ring is drop-oldest, so loss
      // is triple-surfaced: d (total ever dropped), f0 (where the answer actually starts), lost (f0 - f).
      // The bridge disables time-travel below f0 loudly — never splices across a gap.
      const f = typeof v.f === 'number' && v.f >= 0 ? Math.floor(v.f) : 0
      const max = Math.min(typeof v.n === 'number' && v.n >= 1 ? Math.floor(v.n) : DIAG_MAX, DIAG_MAX)
      const all = j.read(f)
      const f0 = all.length ? all[0].t : f // empty ⇔ f ≥ n: nothing retained past the cursor, nothing lost

      const page = all.length > max ? all.slice(0, max) : all
      const body                          = {
        ...base, ok: 1, t: j.n, d: j.dropped, f0, lost: f0 - f,
        ev: page.map((e) => [e.t, e.kind, e.a, e.b, e.c]),
      }
      if (all.length > max) body.next = page[page.length - 1].t + 1
      return reply(node, link, body) // NOT journaled — the follow-cadence eviction rule above
    }
    case 'logs': {
      //! logs cursor f is EXCLUSIVE (the digest/AE convention: "I hold through f, ship me after"). The
      // TWO conventions in one protocol are an off-by-one factory — this comment and the adversarial
      // cursor tests are load-bearing; the one client everyone copies lives in tools/debug/attach.ts.
      const o = typeof v.o === 'string' ? v.o : null
      if (!o) return reply(node, link, { ...base, ok: 0, e: 'bad-args' })
      const f = typeof v.f === 'number' && v.f >= 0 ? Math.floor(v.f) : 0
      const max = Math.min(typeof v.n === 'number' && v.n >= 1 ? Math.floor(v.n) : DIAG_MAX, DIAG_MAX)
      const entries = node.logs.get(o) ?? []
      const tail = entries.length ? entries[entries.length - 1].seq : 0
      const ev                            = []
      for (const e of entries) {
        if (e.seq <= f) continue
        //! values ride the value codec RAW (NaN/±Infinity/bytes/undefined survive natively); encodeVal
        // is the BRIDGE's JSON-safety concern, applied at capture-assembly time, never on the wire
        ev.push({ s: e.seq, e: e.epoch, ty: e.rec.type, k: e.rec.key, at: e.rec.at, v: e.rec.value, iss: e.iss, cid: e.cid, pp: e.pp })
        if (ev.length >= max) break
      }
      const body                          = { ...base, ok: 1, o, tail, ev }
      if (ev.length && (ev[ev.length - 1].s          ) < tail) body.next = ev[ev.length - 1].s
      reply(node, link, body)
      j.armed && j.emit(JK.diagPull, link.id, 'logs', ev.length)
      return
    }
    case 'state': {
      //! SINGLE frame, never chunked: append-only sources chunk torn-proof, a MUTABLE map must not tear
      // across pulls. The guarded reply() turns an over-MAX_FRAME state into a typed 'too-large' (the
      // named ceiling: such a node's state is honestly unpullable — DESIGN-M7 §1 open risk, never silent).
      reply(node, link, { ...base, ok: 1, sh: node.stateHash, cells: [...node.state] })
      j.armed && j.emit(JK.diagPull, link.id, 'state', node.state.size)
      return
    }
    default:
      return reply(node, link, { ...base, ok: 0, e: 'bad-op' })
  }
}
