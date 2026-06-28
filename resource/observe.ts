//! L4 observe push-hook: a gated, bounded ring-buffer ViewProxy carrying the live provenance/contention stream (applied/lost/forwarded/local).
// resource/observe.ts — the L4 PUSH channel (plan.md L4 §3 family [b]).
//
// The pull spine (inspect.ts) reports truthful slow state on a ~1s poll. This is its
// complement: the fast contention stream a poll structurally CANNOT show — the LWW
// LOSERS (a losing record never lands in a snapshot — it's dropped at apply) and the
// sub-poll transition fidelity (every committed write, in order, with provenance). A
// fero server arms it ONLY while a subscriber is attached (refCount). When nobody is
// watching, the gate is null and every emit-site is a single predicted-false branch —
// `observe?.onRecord(...)` short-circuits before its args even evaluate, so a
// configured-but-unwatched node pays ~nothing (guarded in observe.perf.ts).
//
// Mechanism: ONE $({}) ViewProxy holding a bounded DROP-OLDEST ring buffer — slot
// `t % cap` is overwritten with each event's flat provenance {t,kind,origin,seq,epoch,
// key}. data emits one clean per-slot update record per write, which the EXISTING
// serveSubscribe default-ViewProxy branch streams to the bridge — no second data sink,
// no log.onAppend listener, and NO value payload on the wire (the value rides the poll
// snapshot). The buffer is bounded so a slow/deaf subscriber can't grow it toward OOM.

import { $ } from '../../data/index.ts'
import { type ChangeRecord } from '../transport/message.ts'

//! ProvKind: the provenance/contention tag the dashboard colours by — three ACCEPTED kinds (local=owner-authored · forwarded=owner-routed · applied=inbound record applied here), the LWW loser `lost`, the dedup `dropped`, and the membership transitions `view`/`writable`. All three accepted kinds audited & KEPT (`won`→`applied`) — DECISIONS AB.
// The three "accepted" kinds split a committed/applied record by WHERE it was sequenced. Audited
// against every consumer + derivability + cost + the fallback interaction; all three KEPT (DECISIONS AB):
//   • local     — this node committed a write under its OWN provenance because it owns the partition
//                 (or is solo). Drives writes/s + the hot-keys / top-origins boards. After DECISIONS-AA
//                 Part 1 (the never-drop fallback is gone) `local` ≈ "owner-authored"; three residual
//                 paths (AA #2–#4) keep that from being airtight until the full four-part program lands.
//   • forwarded — this OWNER committed a write ROUTED here from another node (commitForwarded → sink →
//                 commitLocal, the `committingForward` guard). SAME wire shape as `local`: origin is
//                 RE-STAMPED to us at commitLocal, so a forwarded record's `origin === me`, and the
//                 original writer's identity is preserved NOWHERE (not here, not on the committed record,
//                 not on `cluster.writes`). The ONLY discriminator is the transient `committingForward`
//                 flag — NOT a record field — so forwarded-ness is recoverable from no other stored
//                 signal. KEPT for that reason even though no consumer surfaces it yet (its consumer is
//                 the planned forward-traffic view, IDEAS Write-route JOIN); writer-anonymous, so it
//                 answers "how much routing" not "from whom". Merge-eligible only if that view is
//                 abandoned — re-addable in ~1 line since `committingForward` stays (the re-forward guard).
//   • applied   — an inbound REPLICATED record this node applied to local state (applyInbound, after it
//                 won LWW). origin is the SENDER/owner (≠ me). Drives repl/s — the per-replica apply signal
//                 a pull snapshot structurally cannot show. NOT derivable from ProvRecord scalars (the LWW
//                 outcome needs the held version history a downstream consumer lacks). Named for the ACTION
//                 (like local/forwarded — the accepted trio reads by where-the-record-was-sequenced); `won`
//                 over-implied contention (most applies are uncontested), so `won`→`applied` (DECISIONS AB).
// lost = an LWW loser — fence (epoch < winner) or conflict (same-epoch (seq,origin) loser); the {we,ws}
// winner stamp lets a surface tell the two apart. dropped = a dedup re-delivery (verbose-only, off the
// steady path). view/writable = membership transitions, emitted off the per-record path.
export type ProvKind = 'applied' | 'lost' | 'forwarded' | 'local' | 'dropped' | 'view' | 'writable'

//! ProvRecord: one flat provenance event — scalars only (no cloned value), so an emit is cheap and the streamed frame is tiny.
export type ProvRecord = {
  t: number // monotonic emit counter — the dashboard orders + dedups by this (also the ring slot's identity)
  kind: ProvKind
  origin?: string // the WRITER's uuid (provenance) — node-agnostic, every replica that saw it agrees
  seq?: number // the writer's Lamport seq
  epoch?: number // the view epoch the write committed under
  key?: string // the contended key path (dotted), for the ticker — NOT the value
  members?: number // kind:'view' — committed member count after the change
  writable?: boolean // kind:'writable' — the new write-gate state
  we?: number // kind:'lost' — the WINNER's epoch (so the surface can show WHY: epoch-fence vs seq-contention)
  ws?: number // kind:'lost' — the winner's seq
}

//! Observe: the gated controller — the streamed proxy + refcounted attach/detach + the hot-path emit-sites (onRecord/onView/onWritable).
export type Observe = {
  proxy: ReturnType<typeof $> // the ring-buffer ViewProxy the bridge subscribes to
  attach: () => void // a subscriber arrived → arm (refCount++)
  detach: () => boolean // a subscriber left → returns TRUE when the LAST one left (caller nulls the gate)
  refCount: () => number
  onRecord: (record: ChangeRecord, kind: ProvKind, extra?: { we?: number; ws?: number }) => void // hot-path emit: one slot write (extra carries the winner stamp for a loser)
  onView: (epoch: number, members: number) => void // membership transition (off the per-record path)
  onWritable: (w: boolean) => void // write-gate flip (off the per-record path)
}

//! ObserveOpts: the `observe:` options object — ring-buffer size + the verbose (dedup-drop) flag.
export type ObserveOpts = {
  buffer?: number // ring-buffer slots (drop-oldest); default 256
  verbose?: boolean // also emit dedup-drops (the highest-frequency, least-useful event) — default OFF even when observe is on
}

const DEFAULT_CAP = 256

//! makeObserve(): build the controller — called ONCE, lazily, on the first __observe subscribe (so an unwatched node never allocates it).
export const makeObserve = (opts: ObserveOpts = {}): Observe => {
  // floor BEFORE validating: a fractional 0<buffer<1 floors to 0, which would make every
  // slot `count % 0` = NaN (one perpetually-overwritten 'NaN' key) — fall back to the default.
  const want = opts.buffer === undefined ? DEFAULT_CAP : Math.floor(opts.buffer)
  const cap = want >= 1 ? want : DEFAULT_CAP
  const proxy = $({} as Record<string, ProvRecord>)
  let count = 0 // total events emitted; the next slot is count % cap, the next t is count+1
  let refs = 0

  //! keyStr: the dotted contended-key path (with `at` folded in) — a small string, never the value.
  const keyStr = (r: ChangeRecord): string => {
    const k = r.key ?? []
    const base = k.length === 0 ? '' : k.join('.')
    return r.at !== undefined ? (base ? base + '.' + r.at : r.at) : base
  }

  //! push: write one flat event into the next ring slot — the single mutation every emit-site funnels through (drop-oldest by overwrite).
  const push = (rec: ProvRecord) => {
    const slot = count % cap
    count++
    rec.t = count
    ;(proxy as any)[String(slot)] = rec
  }

  return {
    proxy,
    attach: () => {
      refs++
    },
    // Clamp at 0 (never negative — tolerates the graceful UNSUBSCRIBE + socket-close
    // double-fire and a reapPeer-after-unsubscribe). TRUE only on the transition to 0,
    // so the caller nulls the closure gate exactly once (last observer left).
    detach: () => {
      if (refs > 0) refs--
      return refs === 0
    },
    refCount: () => refs,
    onRecord: (record, kind, extra) =>
      push({ t: 0, kind, origin: record.origin, seq: record.seq, epoch: record.epoch, key: keyStr(record), ...extra }),
    onView: (epoch, members) => push({ t: 0, kind: 'view', epoch, members }),
    onWritable: (w) => push({ t: 0, kind: 'writable', writable: w }),
  }
}
