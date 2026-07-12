//! ── kernel/env — the ONLY doorway between the kernel and the world ───────────
// The v3 organizing idea (plan-v3.md §2): the entire distributed core is a
// single-threaded deterministic kernel advanced only by explicit Events and
// emitting only explicit Effects. This file is the whole contract. The kernel
// may import NOTHING from node:* (enforced by kernel/purity.test.ts) — real
// sockets/timers (shell/) and the simulator (sim/) are both just implementations
// of the interfaces below, which is what makes every protocol behaviour a
// seeded, reproducible trajectory instead of a wall-clock race.
//
// Design note: Effects are a typed METHOD-PER-KIND sink rather than a pushed
// tagged-union object. Pushing `{kind:'send', ...}` objects would allocate one
// wrapper per effect on the hottest path (v2 ate a 3x GC regression from exactly
// one per-write object); methods with scalar args allocate nothing. Events stay
// a closed tagged union — they are allocated by the I/O boundary anyway (one per
// socket chunk / timer fire), so the union costs nothing extra and keeps
// node.step() a single fail-closed dispatch site.

//! One inbound stimulus. The closed union node.step() dispatches on — nothing else moves the kernel.
export type Event =
  //! start: boot stimulus — dial the configured hosts. Posted once by the embedder (shell runtime or sim).
  | { kind: 'start' }
  //! linkUp: the env opened a socket. `link` ids are minted by the ENV (shell/sim), never the kernel. `to` is set on dialed links only.
  | { kind: 'linkUp'; link: number; dialed: boolean; to?: string }
  //! bytesIn: raw bytes arrived on a link — the highest-frequency event; framing/decoding is kernel work (kernel/codec).
  | { kind: 'bytesIn'; link: number; bytes: Uint8Array }
  //! linkDown: the link is gone (close/error/refused). Terminal per link id — ids are never reused. `to` rides along on a FAILED DIAL (no linkUp ever fired) so the kernel can still schedule a redial for that target.
  | { kind: 'linkDown'; link: number; reason: string; to?: string }
  //! pause/drain: send-plane backpressure, from the first commit (plan §5) — the env's write buffer filled / emptied.
  | { kind: 'pause'; link: number }
  | { kind: 'drain'; link: number }
  //! timer: a timer the kernel set via sink.timer() fired. `id` is kernel-minted; `tag` says why it was set.
  | { kind: 'timer'; id: number; tag: number }
  //! write: local write attempts issued by the embedder (api layer / test). A BATCH per event so a synchronous burst coalesces into one frame per link (the one-frame-per-peer-per-tick counted invariant).
  | { kind: 'write'; recs: Rec[] }
  //! persisted/persistFail (M4b): a WAL batch the kernel emitted via sink.persist() RESOLVED (fsync
  // completed) or failed. Resolution is the sole trigger for the durable watermark — never the emit.
  | { kind: 'persisted'; batch: number }
  | { kind: 'persistFail'; batch: number; reason: string }
  //! confirm/confirmCancel (M4c): the embedder opens a guarantee-ladder probe for (origin, seq) at a
  // CONFIRM level (kernel/confirm.ts); the answer arrives via sink.confirm. Cancel is the embedder's
  // deadline (the kernel never times out on its own — evidence is monotone and eventually sufficient).
  // `part` (M6): the record's partition — armed nodes count the probe over holdersOf(part) at the
  // W-quorum instead of the view majority; ignored (and never set) unscoped.
  | { kind: 'confirm'; id: number; origin: string; seq: number; level: number; part?: string }
  | { kind: 'confirmCancel'; id: number }
  //! replay (M4b): one WAL row fed back at boot, BEFORE the network exists — the same bytes that were
  // persisted, re-entering through the same ingest (source=replay in kernel/write.ts). Restore is not a
  // special path; it is the wire path pointed at the disk. `prev` is the row's per-origin CHAIN LINK
  // (see sink.persist): a row whose prev does not match the replayed chain tail is an INTERIOR hole —
  // a lying disk lost something before it — and is skipped, converting interior loss into the tail
  // loss that suffix anti-entropy knows how to heal.
  | { kind: 'replay'; bytes: Uint8Array; prev?: number }
  //! ── the M5c method plane: the kernel ROUTES method traffic, the api HOST runs the handlers ──
  // (purity: a user handler is arbitrary async code — it can never run inside step()). rpc is the
  // CALLER side: mode CALL/SUB/UNSUB, shipped on the client's primary (no primary ⇒ an immediate
  // failed `result` effect — the api's failover policy owns retries). reply/subOut are the HOST side:
  // the api answers an invoke, the kernel frames it back down the link it came in on.
  | { kind: 'rpc'; id: number; mode: number; m?: string; a?: unknown }
  | { kind: 'reply'; link: number; id: number; ok: boolean; value?: unknown }
  | { kind: 'subOut'; link: number; id: number; recs: Rec[] }

//! One outbound consequence. Typed methods (not pushed objects) so the steady-state path allocates no effect
// WRAPPERS by construction (frame buffers and Applied records still allocate; the full alloc-counter
// verification with --expose-gc heap deltas is an M8 pinned-runner deliverable, per plan §7 — not yet a test).
export interface EffectSink {
  //! connect(to): open a socket to 'host:port'. The env answers later with linkUp{dialed:true,to} or linkDown.
  connect(to: string): void
  //! send(link, bytes): ship one encoded frame. `bytes` is owned by the CALLER after return — envs that deliver later must not assume the buffer survives (codec's Outbox already hands over a fresh slice per flush; see kernel/codec.ts).
  send(link: number, bytes: Uint8Array): void
  //! close(link, reason): tear a link down. The env echoes linkDown (once) so kernel state changes only via events.
  close(link: number, reason: string): void
  //! timer(id, tag, ms): one-shot timer. `id` is kernel-minted (monotone), `tag` is a TAG.* discriminant echoed back on fire.
  timer(id: number, tag: number, ms: number): void
  //! cancel(id): best-effort cancel — a raced fire is delivered and must be ignored by the kernel (ids are checked against live sets).
  cancel(id: number): void
  //! apply(rec): a committed record materialises downstream (state proxy / api layer). The kernel NEVER mutates user state directly — apply is an output, which is what makes re-entrant capture (v2's applying/discarding flag family) structurally impossible.
  apply(rec: Applied): void
  //! persist(batch, bytes, prev) (M4b): append one encoded frame to the WAL. `batch` is kernel-minted;
  // the env echoes {kind:'persisted', batch} when the fsync batch RESOLVES (or persistFail — surfaced,
  // never silent; the kernel treats a failed WAL as DEAD thereafter — the fsyncgate policy). `bytes`
  // are owned by the env after return. The WAL row IS the wire frame — one format — plus `prev`, the
  // per-origin chain link (the seq the origin's chain stood at before this row): replay uses it to
  // detect rows a lying disk silently dropped from the MIDDLE of the file, which no seq can reveal
  // (Lamport streams are legitimately gappy) and suffix digests can never heal.
  persist(batch: number, bytes: Uint8Array, prev: number): void
  //! boot(record) (M4b): atomically replace the durable boot record (write-tmp + rename in the shell).
  // Cold path — per view install / vote grant, never per write. What it carries is what a restart may
  // trust: the committed view, the ballot identity already spent, the Lamport floor, the incarnation.
  boot(record: BootRecord): void
  //! confirm(id, ok, count) (M4c): a guarantee-ladder probe's answer — ok with the member count whose
  // ladder covered it, or false (cancel/overflow) with the count reached. Downstream delivery, like apply.
  confirm(id: number, ok: boolean, count: number): void
  //! ── the M5c method plane (see the rpc/reply/subOut events) ──
  //! invoke (HOST side): a CALL/SUB/UNSUB frame arrived — the api runs the handler and answers with a
  // reply/subOut event. `link` identifies the caller for the answer route AND for sub reaping on death.
  invoke(link: number, id: number, mode: number, m: string, a: unknown): void
  //! result (CALLER side): a RESULT frame answered our rpc id (local=false), OR the kernel failed the
  // rpc LOCALLY before it ever shipped (local=true: no primary / link died pre-dispatch — value is the
  // reason). `local` is the unforgeable channel bit that keeps a handler REPLY whose value happens to
  // equal a kernel reason string from being misread as a pre-dispatch failure (M5-review #7).
  result(id: number, ok: boolean, value: unknown, local: boolean): void
  //! subRecs (CALLER side): one SUBREC frame — change records for a live subscription id.
  subRecs(id: number, recs: Rec[]): void
  //! snapshot(batch, rows) (M4e): ATOMICALLY REPLACE the whole WAL with `rows` — the disk counterpart
  // of compaction (a swap is not an append; it gets its own verb). Rows are [frame + fresh chain link]
  // in replay order; the store must make the swap all-or-nothing (write-tmp + fsync + rename in the
  // shell) BEFORE this call returns — the old file survives any crash mid-swap. The env echoes
  // persisted/persistFail with `batch` like any other batch; on the echo the durable watermarks advance
  // to the snapshot tails. Cold path — per SNAPSHOT_AT appended rows, never per write.
  snapshot(batch: number, rows: { bytes: Uint8Array; prev: number }[]): void
}

//! BootRecord: the durable facts a restart derives its boot mode from (plan §5 membership, verbatim).
// votedFor durability is what makes crash-inside-a-ballot double-votes unrepresentable (the M2 debt).
// `lamport` is a clock CEILING, not the current value — a LEASE (kernel/node.ts LAMPORT_LEASE): no
// stamp beyond it ever existed, so a restore resumes AT the ceiling and can never re-issue a seq its
// previous life spent (the durable+restart sweep caught exactly that: a stale per-ballot floor let a
// reborn node re-stamp seqs whose originals still lived at peers — silent loss both ways). Crossing
// the ceiling re-persists the record first; the cold path stays cold, amortized per LEASE stamps.
// The M6 fields are ARMED-ONLY (absent unscoped — R=∞ boot bytes stay byte-identical with M4):
// heldPartitions = the data-authoritative held ∪ orphaned set (the ring is duty-authoritative; replay
// classifies WAL rows against BOTH — DESIGN-M6 C10); dirtyParts = partitions holding a spliced
// interior record no WAL snapshot has captured yet — their replay-rebuilt floors would OVERCLAIM
// (row maxes cover seqs the rows provably miss), so restore zeroes those floors and the handshake
// re-heals honestly-low.
export interface BootRecord {
  epoch: number
  members: [string, string][]
  lamport: number
  incarnation: number
  votedFor: { e: number; p: string; h: string }
  heldPartitions?: string[]
  dirtyParts?: string[]
}

//! Env: what the kernel is allowed to know about the world — a clock, a seeded rng, and the sink. Nothing else.
export interface Env {
  //! now(): milliseconds on the env's clock (virtual in sim). For journal stamps and backoff arithmetic only — NEVER for correctness decisions.
  now(): number
  //! rng(): [0,1) from the env's SEEDED generator — jitter must be reproducible per seed, so Math.random is banned in kernel/.
  rng(): number
  sink: EffectSink
}

//! ── the change record — memory format, log entry, and wire payload at once ───
// Carried over from v2 verbatim (the one day-0 hypothesis that proved out):
// {type, key, value, at?} is what `data` emits, what the log stores, and what
// crosses the wire — no translation layer anywhere.

//! REC: record type discriminants (3 bits on the wire — see kernel/codec.ts).
export const REC = { update: 0, insert: 1, remove: 2 } as const

//! Rec: one change record. `key` is a path (['user42','active']); `at` is the ordered-insert position key.
export interface Rec {
  type: number
  key: string[]
  value?: unknown
  at?: string
}

//! Applied: a record + the provenance it committed under — what sink.apply() delivers downstream and what monitors/replay hash.
// `iss`/`cid` (M5a) are the ATTEMPT IDENTITY when the committed record carried one (forwarded/relayed
// runs always do; FLAG_ATTEMPT rides replication and the WAL, so inbound and replay applies carry it
// too) — the api layer joins its own issued cids against the apply stream to resolve write promises
// and drop cid-overlay entries. Absent on fast-path local commits (epoch-0 genesis writes), which the
// embedder observes synchronously inside its own write() call instead.
export interface Applied extends Rec {
  origin: string
  seq: number
  epoch: number
  iss?: string
  cid?: number
}

//! partitionOf: the routing/segmentation unit — key[0], or `at` for a root insert (v2's BI0 case, kept).
export const partitionOf = (r: Rec): string => r.key.length ? r.key[0] : (r.at ?? '')

//! TAG: timer discriminants. A closed set so step()'s timer dispatch is a flat switch that fails closed.
export const TAG = { redial: 1, heartbeat: 2 } as const
