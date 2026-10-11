//! ── kernel/tune — the tune table: every kernel knob in one frozen object per node ─────────────
//
// The kernel used to read its bounds and tick counts as module constants (MAX_REDIALS,
// SUSPECT_TICKS, MAX_PENDING …). Those constants still exist, with their names, as the
// DEFAULTS: tests and tools import them. What changed is the read site. Every site now reads
// `node.tune.<row>`, one frozen object built once in the Node constructor from TUNE plus the
// embedder's `NodeOpts.tune` overrides. A row is a plain integer; the table is validated once
// (an unknown row or a non-integer or negative value throws) and never changes after that.
//
// Defaults equal the old constants, so a node with no `tune` runs byte-identical trajectories
// (sim/exec.test.ts freezes 20 seeds as a golden). A hot site pays two monomorphic field loads
// and allocates nothing; the tick loops hoist the row into a local.
//
// NOT in the table, on purpose (wire hygiene and protocol identity — a member with a different
// value would drop legal frames or mean something else by a frame): REASON_MAX, the 4096 member
// bound, DIAG_*, VNODES, the snapshot chunk, and MAX_RUN (write.ts — the longest WACK/WNACK run a
// peer may send us, split off MAX_PENDING so tuning the queue cannot change what the wire accepts).
//
// The row `frame` (V4-51) is not wire hygiene, though it sounds like it: it bounds only what this node BUILDS —
// records frames, WAL rows, RESULT and SUBREC — and a node may only cut smaller, which no peer can tell from a
// bigger write; receivers never read it (the Framer's MAX_FRAME is the wire's one receive bound). It has no config
// key and the composer never passes it: it is the test seam that makes every cut reachable with KB-sized values,
// and production runs at MAX_FRAME (api/index.test.ts guards it). Tests run one cap per cluster: a node with a
// smaller cap than a peer could meet a peer's record it cannot send alone (its answer, its tap, its WAL), a loud throw.
//
// The three node-level constants are DEFINED here and re-exported by kernel/node.ts under their
// old names: node.ts imports this file, so defining them there would make an import cycle.

import { SUSPECT_TICKS, MAX_PULLS, PROPOSAL_AGE, REJOIN_TICKS, LEAVE_TICKS, LEAVE_WINDOW, DRAIN_TICKS } from './membership.ts'
import { MAX_PENDING, RETRY_TICKS, DEDUP_KEEP, MAX_ISSUERS } from './write.ts'
import { MAX_PROBES } from './confirm.ts'
import { MAX_QUEUED } from './link.ts'
import { COMPACT_AT } from './log.ts'
import { SHED_TICKS, STAGE_TICKS, ACQ_LIVE_MAX, STALL_AT, AE_FAN } from './scope.ts'
import { MAX_FRAME } from './codec.ts'

//! MAX_REDIALS: bounded dial persistence per target — after this, give up loudly (JK.giveUp). With
// heartbeats on, the heartbeat tick revives given-up targets (JK.revive) — give-up is a cool-down.
export const MAX_REDIALS = 10
//! MEMBER_REDIALS (2026-10-08): the chain for an ADMITTED MEMBER link that died — a crashed member.
// Eviction is HELD while the proposer is still dialing the suspect (reachability unknown), so this
// chain sets the time from a crash to the eviction ballot: 5 tries at the 100 ms base is
// 100+200+400+800+1600 = 3.1 s plus jitter, eviction at the next tick ≈ 4 s (10 tries was ≈ 20 s).
// A dial that never linked up, or a link that died before HELLO, keeps the long chain. Never more
// than `redials` (the cap reads the lower of the two).
export const MEMBER_REDIALS = 5
//! LAMPORT_LEASE: how far past the durable clock ceiling a node may stamp before re-persisting the
// boot record. A restore resumes AT the ceiling, so no seq can ever be issued twice across lives —
// the lease is what keeps that guarantee off the per-write hot path (one cold boot-write per LEASE).
export const LAMPORT_LEASE = 4096
//! SNAPSHOT_AT: WAL rows appended since the last snapshot that arm a whole-WAL snapshot+swap on the
// heartbeat tick (M4e — the disk counterpart of COMPACT_AT). Counting rows-since-snapshot (not file
// rows) bounds RELATIVE growth: even when the log itself is large (frontier pinned), at most
// SNAPSHOT_AT appended rows separate swaps, so the file is O(log entries + SNAPSHOT_AT) always.
export const SNAPSHOT_AT = 4096
//! PROVE_MS (DESIGN-DOOR §3): how long a secured link may sit in LS.proving — from the HELLO that carried
// `k` to the DOOR that proves it — before the node gives up on it (doorReject 'timeout'). A timer per
// proving link, never a heartbeat sweep (heartbeat.ms 0 is an opt-out). Draws nothing on the open path.
export const PROVE_MS = 5000
//! FRAME_MIN — the smallest `frame` a node may run with: a frame must still hold a record beside its envelope
export const FRAME_MIN = 1024

export interface Tune {
  //! redials — dial attempts per target before the chain gives up (JK.giveUp; heartbeats revive it)
  redials: number
  //! memberRedials — the shorter chain for an admitted MEMBER link that died (see MEMBER_REDIALS): it sets
  // the time from a member's crash to its eviction. Never more than `redials`.
  memberRedials: number
  //! redialGrowth / redialCap — the backoff curve: the delay grows ×growth per try, capped at base × cap
  redialGrowth: number
  redialCap: number
  //! suspectTicks — heartbeat ticks a member is unreachable before it is suspect
  suspectTicks: number
  //! leaveTicks — ticks a leaver waits with NO member link that could answer its knock before it goes like a crash
  leaveTicks: number
  //! leaveWindow — the most ticks the view half of a leave may run in all while a member that could answer is linked
  // (DESIGN-LEAVE §10.7, the knock window): a stalled survivor wakes inside it with the leaver still there to grant.
  // Never less than leaveTicks in effect; the config key leave.ms sets it (ms ÷ heartbeat.ms, rounded up)
  leaveWindow: number
  //! drainTicks — ticks a SCOPED leaver, out of the view, waits for the new holders to prove they hold what it held
  // before it goes anyway (`undrained`); the shell's destroy cap adds it on a scoped node (DESIGN-SCALE stage 1 (b))
  drainTicks: number
  //! pulls — targeted view-pull retries before the alarmed gate release
  pulls: number
  //! proposalAge — ticks before an uncommitted proposal is abandoned
  proposalAge: number
  //! rejoinTicks — rejoining ticks without live confirmation before the self-ballot
  rejoinTicks: number
  //! retryTicks — ticks a forwarded attempt waits for its ACK/NACK before it re-parks
  retryTicks: number
  //! pending — the ONE attempt-queue bound (drop-oldest, surfaced); also bounds the rejected map
  pending: number
  //! dedupKeep — committed cids kept per issuer for the exact-window duplicate test
  dedupKeep: number
  //! issuers — dedup lanes kept (oldest-evicted, surfaced)
  issuers: number
  //! probes — the confirm registry bound (overflow answers the oldest probe false)
  probes: number
  //! queued — frames a paused link may hold before the whole queue drops
  queued: number
  //! compactAt — per-origin log entries that arm a compaction pass
  compactAt: number
  //! snapshotAt — WAL rows since the last snapshot that arm a whole-WAL swap
  snapshotAt: number
  //! lamportLease — how far past the durable clock ceiling a node may stamp before re-persisting the boot record
  lamportLease: number
  //! shedTicks / stageTicks / acqLiveMax / stallAt — scoped handover pacing (kernel/scope.ts)
  shedTicks: number
  stageTicks: number
  acqLiveMax: number
  stallAt: number
  //! aeFan — co-holder links a scoped node's anti-entropy sweep re-announces to per heartbeat tick (kernel/scope.ts
  // AE_FAN; DESIGN-SCALE stage 2): every held partition is re-proved with each co-holder within ⌈c / aeFan⌉ ticks.
  // 0 switches the sweep off (announce-on-change alone; the counted pins measure that posture).
  aeFan: number
  //! proveMs — milliseconds a link may wait in LS.proving for the peer's DOOR before it is refused `timeout`
  proveMs: number
  //! frame — the most body bytes one frame this node BUILDS may hold (records frames, WAL rows, RESULT, SUBREC):
  // MAX_FRAME, or less in a test (FRAME_MIN..MAX_FRAME). See the banner: never wire hygiene, never configured.
  frame: number
}

//! TUNE — the defaults: today's constants, by name. Frozen; a node copies it, never mutates it.
export const TUNE: Readonly<Tune> = Object.freeze({
  redials: MAX_REDIALS,
  memberRedials: MEMBER_REDIALS,
  redialGrowth: 2,
  redialCap: 32,
  suspectTicks: SUSPECT_TICKS,
  leaveTicks: LEAVE_TICKS,
  leaveWindow: LEAVE_WINDOW,
  drainTicks: DRAIN_TICKS,
  pulls: MAX_PULLS,
  proposalAge: PROPOSAL_AGE,
  rejoinTicks: REJOIN_TICKS,
  retryTicks: RETRY_TICKS,
  pending: MAX_PENDING,
  dedupKeep: DEDUP_KEEP,
  issuers: MAX_ISSUERS,
  probes: MAX_PROBES,
  queued: MAX_QUEUED,
  compactAt: COMPACT_AT,
  snapshotAt: SNAPSHOT_AT,
  lamportLease: LAMPORT_LEASE,
  shedTicks: SHED_TICKS,
  stageTicks: STAGE_TICKS,
  acqLiveMax: ACQ_LIVE_MAX,
  stallAt: STALL_AT,
  aeFan: AE_FAN,
  proveMs: PROVE_MS,
  frame: MAX_FRAME,
})

//! ZERO_OK — the rows where 0 means something: no redial at all (the config key redial.tries allows
// it), and no anti-entropy sweep (aeFan 0: a scoped node announces on change only — the posture the
// counted pins of DESIGN-SCALE §8 measure; repair then comes from the dirty announcements, the admit and
// drain rounds alone). Every other row is a tick count, a bound, a growth or a cap, and 0 would switch a
// guarantee off instead of tuning it: shedTicks 0 makes `% shedTicks` NaN so no orphan ever polls, dedupKeep
// or issuers 0 turns exactly-once dedup off, pending 0 drops every attempt, redialGrowth 0 makes
// every later wait pure jitter (review finding). Those start at 1.
const ZERO_OK: ReadonlySet<string> = new Set(['redials', 'memberRedials', 'aeFan'])

//! tuneOf — the validated, frozen table for one node: TUNE under the embedder's overrides. Fails
// closed: a row that is not in TUNE, or a value that is not an integer at or above the row's floor
// (0 for the two redial counts and aeFan, 1 for everything else), throws — a typo must never silently leave a
// bound at its default, and a fraction or a negative bound has no meaning the kernel could honour. `frame` has a
// range of its own, FRAME_MIN..MAX_FRAME: a node may cut smaller than the wire allows, never bigger.
// No overrides ⇒ the shared frozen TUNE itself (zero allocation).
export const tuneOf = (over?: Partial<Tune>): Readonly<Tune> => {
  if (over === undefined) return TUNE
  if (typeof over !== 'object' || over === null || Array.isArray(over)) throw new Error('tune must be an object of rows')
  const out: Tune = { ...TUNE }
  for (const k of Object.keys(over)) {
    if (!Object.hasOwn(TUNE, k)) throw new Error(`tune: unknown row '${k}'`)
    const v = (over as Record<string, unknown>)[k]
    if (v === undefined) continue
    if (k === 'frame') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < FRAME_MIN || v > MAX_FRAME) throw new Error(`tune: frame must be an integer from ${FRAME_MIN} to ${MAX_FRAME}, got ${String(v)}`)
    } else {
      const floor = ZERO_OK.has(k) ? 0 : 1
      if (typeof v !== 'number' || !Number.isInteger(v) || v < floor) throw new Error(`tune: ${k} must be an integer ≥ ${floor}, got ${String(v)}`)
    }
    out[k as keyof Tune] = v
  }
  return Object.freeze(out)
}
