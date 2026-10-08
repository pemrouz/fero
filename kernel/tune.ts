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
// The three node-level constants are DEFINED here and re-exported by kernel/node.ts under their
// old names: node.ts imports this file, so defining them there would make an import cycle.

import { SUSPECT_TICKS, MAX_PULLS, PROPOSAL_AGE, REJOIN_TICKS, LEAVE_TICKS } from './membership.ts'
import { MAX_PENDING, RETRY_TICKS, DEDUP_KEEP, MAX_ISSUERS } from './write.ts'
import { MAX_PROBES } from './confirm.ts'
import { MAX_QUEUED } from './link.ts'
import { COMPACT_AT } from './log.ts'
import { SHED_TICKS, STAGE_TICKS, ACQ_LIVE_MAX, STALL_AT } from './scope.ts'

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
  //! leaveTicks — ticks a leaver waits for the view without it to commit and echo before it goes like a crash
  leaveTicks: number
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
}

//! TUNE — the defaults: today's constants, by name. Frozen; a node copies it, never mutates it.
export const TUNE: Readonly<Tune> = Object.freeze({
  redials: MAX_REDIALS,
  memberRedials: MEMBER_REDIALS,
  redialGrowth: 2,
  redialCap: 32,
  suspectTicks: SUSPECT_TICKS,
  leaveTicks: LEAVE_TICKS,
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
})

//! tuneOf — the validated, frozen table for one node: TUNE under the embedder's overrides. Fails
// closed: a row that is not in TUNE, or a value that is not a non-negative integer, throws — a
// typo must never silently leave a bound at its default, and a fraction or a negative bound has no
// meaning the kernel could honour. No overrides ⇒ the shared frozen TUNE itself (zero allocation).
export const tuneOf = (over?: Partial<Tune>): Readonly<Tune> => {
  if (over === undefined) return TUNE
  if (typeof over !== 'object' || over === null || Array.isArray(over)) throw new Error('tune must be an object of rows')
  const out: Tune = { ...TUNE }
  for (const k of Object.keys(over)) {
    if (!Object.hasOwn(TUNE, k)) throw new Error(`tune: unknown row '${k}'`)
    const v = (over as Record<string, unknown>)[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`tune: ${k} must be a non-negative integer, got ${String(v)}`)
    out[k as keyof Tune] = v
  }
  return Object.freeze(out)
}
