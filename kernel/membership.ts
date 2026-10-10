//! ── kernel/membership — committed views, joint-consensus ballots, the write-gate ──
// M2 (plan §5 Membership + build order M2). The design splits the two planes v2
// entangled (its V1d self-fencing divergence lived exactly in that entanglement):
//
//   - the DATA plane stays open: replication, digests, and LWW convergence run
//     over every transport-admitted link exactly as in M1 — an evicted or stale
//     node still converges (loudly), it just cannot COMMIT writes.
//   - the CONTROL plane is view-governed: a committed view {epoch, members} is
//     the sole input to majority math and (at M3) ring ownership. Views change
//     ONLY by ballot: joint consensus — a proposal for epoch e+1 needs a majority
//     of the OLD members AND a majority of the NEW members.
//
// BALLOT IDENTITY (the adversarial review broke the first draft here — a member
// that had GRANTED its epoch-e vote could still PROPOSE epoch e and self-vote,
// committing two different views for one epoch): a vote is votedFor =
// (epoch, proposer, membersHash), enforced at BOTH the grant site and the
// propose site. The rules, each load-bearing:
//   - grant iff the ballot's epoch is ABOVE the committed view AND (my vote for
//     this epoch is unspent OR was spent on THIS proposer) — re-grants to the
//     same proposer are idempotent, so a lost VOTE frame heals on the next
//     re-offer instead of burning the epoch forever (the review's wedge
//     finding); epochs above view+1 are lawful ESCALATIONS past burned epochs
//     (see #burned — the M4-review permanent-wedge fix), never evidence that
//     the skipped epochs committed;
//   - a proposer counts only votes echoing its own proposal's members-hash, so
//     grants for an abandoned same-epoch ballot cannot be miscounted;
//   - proposer identity is the LINK's authenticated uuid, never a frame field;
//   - proposing spends your own vote — and you cannot propose an epoch your
//     vote is already spent on for another proposer;
//   - my own ballots never go DOWN in epoch (2026-10-08, the I-20 salvage):
//     votedFor remembers only the latest ballot, so a fresh ballot of mine
//     below my last one could re-spend a vote given away in between — the
//     proposer-side double vote (see #nextEpoch; pinned in membership.test.ts
//     and drawn by chance in sim/explore.test.ts).
// Single-proposer discipline keeps honest contention out of the ballot layer:
// every proposal path (genesis, eviction, join, rejoin, leave) requires being
// the lowest-uuid LIVE member; a JOIN landing elsewhere is relayed one hop.
//
// LEAVE (V4-6, 2026-09-07) is the graceful exit. A member stopping on purpose
// asks for the view WITHOUT itself while it can still vote: leave() proposes
// the shrunk view when this node is the lowest live member, else knocks LEAVE
// on every member link and the lowest live member proposes it. The leaver's
// own grant is the old-majority vote an eviction of a DEAD member can never
// get — so a two-member view loses one member cleanly, where suspicion +
// eviction wedge it forever. The leaver goes once a survivor's VIEW echo
// proves the commit reached someone who stays; LEAVE_TICKS without that echo
// and with no member linked that could answer — LEAVE_WINDOW with one (the
// knock window below) — and it goes anyway (journal `left` b=0) — from there
// it looks like a crash and the pre-V4-6 path (suspicion, eviction) takes
// over. Nothing else moved: ballots, majorities, and vote-once are exactly
// as above.
//
// THE KNOCK WINDOW (DESIGN-LEAVE §10.7, 2026-10-10) is how long the leaver keeps asking. A tick counts
// toward the LEAVE_TICKS bound only while the leaver has NO admitted link to a member that could answer
// the knock: a member of its view that has neither knocked LEAVE at it nor proposed its own exit to it
// (#leavers — a fellow leaver can commit nothing). While such a link is up the leaver keeps knocking,
// up to LEAVE_WINDOW ticks in all (tune row leaveWindow; the config key leave.ms), so a survivor that is
// stalled for a few seconds still reads the knock with the leaver there to grant — TCP delivers the
// buffered knocks before the FIN. No new vote source: the leaver still votes only in onPropose over a
// live link or proposes its own exit; nothing is counted without a link, nothing is seeded, nothing is
// remembered across a restart (#leavers is in-memory and pruned on every install). The ballot rules
// above are untouched. What it does not cover: a survivor stalled past the window, or whose link is
// DOWN (a tick is spent, so the old bound applies, as before).
//
// DRAIN-THEN-GO (DESIGN-SCALE §7 stage 1 (b), 2026-10-10) is the scoped leaver's second wait. Once the
// view without it has committed and echoed, every partition it held is an orphan (kernel/scope.ts: the
// install's rescope froze it) and the new holders acquire from it as from any orphan. A scoped leaver
// holds the `left` effect until each orphan with content is DRAINED — every reachable current holder
// has attested, in a HAVEA/HAVEQ, floors at or above the orphan's frozen content tails, which is the
// shed bar itself (scope.evaluateSheds; when every holder covers, the entry sheds and leaves the count
// by construction) — bounded by drainTicks (DRAIN_TICKS). Past the bound, or when nobody can be
// drained to (no reachable holder; the solo view), it goes at once with `left` b=0 and an `undrained`
// row naming how many partitions went with it. A leaver bounded out of the view half drains too when
// its own view already dropped it (it committed as the proposer; the echo was lost): the rows are handed
// over, the verdict stays b=0. The ballot rules are untouched: the drain begins AFTER the view change
// commits (a leaver whose shrunk view the survivors installed is out of it, so none can suspect or evict
// it; one bounded out of the view half may still be in theirs and may be evicted while it drains — harmless,
// it is cut off and goes at the next tick) and BEFORE the process goes. Unscoped leavers never drain (no scope ⇒ nothing to count): byte-identical.
//
// A CLIENT node is a VIEW of the control plane, never a voice in it (I-23, 2026-09-28
// — DECISIONS V4-5 carried up from the data plane): it installs the views its
// servers announce, but never announces one (no view-on-admit, no flood, no PULL
// answer, no "help a laggard up"), and node.ts drops VIEW/PROPOSE/VOTE/JOIN/LEAVE
// arriving on a client link. What it holds is a picture of its feeder's cluster —
// so a view from its PRIMARY link with different members, at an equal or even LOWER
// epoch, is not split-brain to a client but the cluster having re-formed without it
// (memory-only members reborn under fresh uuids start the epoch count again), and it
// adopts that view where a member must refuse (I-23, amended 2026-10-08: a client
// follows its feeder; its epoch is the feeder's number). Other links stay higher-only.
//
// Genesis is the OPEN mode: epoch 0 has no members, no gate, no ballots — byte-
// for-byte the M0/M1 behaviour, so everything below this milestone is unchanged
// until the first view commits (the lowest-uuid node proposes view 1 over the
// fully-formed mesh; joint consensus degenerates to new-set majority because the
// old set is open). Explicit protocol mode, like heartbeats: membership ACTS
// only on heartbeat ticks, so heartbeatMs 0 (the sweep mode) never enters here.
//
// The write-gate (plan: CP, majority-of-committed-view): local writes commit iff
//   open genesis  OR  (member of the view AND a majority of members reachable
//   AND not epoch-stale AND not below the rejoin floor).
// Gated writes park in the write pipeline's ONE bounded queue (kernel/write.ts
// since M3 — attempts, not batches) and re-drive through the normal ingress when
// the gate opens, re-resolving ownership and re-stamping attemptEpoch at that
// flush boundary (the plan's knowing-overwrite rule; the v2 epoch-dominance
// stamp max(view, cell) stays deleted).
//
// View PROPAGATION is gossip-flooded: every install re-announces the view on
// every admitted link (equal-epoch frames are ignored, so the flood terminates),
// and every admission announces it (view-on-admit) — a detached evictee learns
// its status from ANY member it can reach, not just the committer (review
// finding: the commit-time broadcast alone left un-linked evictees committing
// at their stale view indefinitely).
//
// Epoch staleness (plan contract, verbatim): observing ANY record or membership
// frame with epoch > the committed view epoch closes the gate and starts a
// targeted VIEW pull; bounded retries; if no reachable peer holds the implied
// view, the gate RELEASES with a journal alarm — a wedged gate is a named,
// alarmed state, never silent.
//
// Boot modes: NodeOpts.boot restores the last committed view (it WAS committed —
// it seeds ballot arithmetic and pull targets) but the node is REJOINING: read-
// only until a live peer confirms a view ≥ the restored epoch, or — full-cluster
// restart, nobody can confirm anything — the lowest restored member self-ballots
// the restored view at epoch+1 after REJOIN_TICKS (majority of the restored set
// must grant, so a live newer cluster always wins instead).
//
// Known M2 debt (stated, closed at M4): votedFor and the committed view are not
// yet durable — a crash-restart inside one ballot round can double-vote; M4's
// boot record carries votedFor to close it.

import { VERB, encodeControl } from './codec.ts'
import { LS, type Link } from './link.ts'
import { JK } from './journal.ts'
import type { Node } from './node.ts'

//! View: the committed membership fact — epoch + [uuid, listen] pairs, sorted by uuid (deterministic everywhere).
export interface View { epoch: number; members: [string, string][] }

//! protocol constants — ticks are heartbeat ticks (the membership clock). Each is the DEFAULT of its
// tune-table row (kernel/tune.ts: suspectTicks, pulls, proposalAge, rejoinTicks, leaveTicks); tick() reads node.tune.
export const SUSPECT_TICKS = 3    // member unreachable this many consecutive ticks → suspect
export const MAX_PULLS = 5        // targeted view-pull retries before the alarmed gate release
export const PROPOSAL_AGE = 10    // ticks before an uncommitted proposal is abandoned (unblocks JOINs; re-grants make retry safe)
export const REJOIN_TICKS = 10    // rejoining ticks without live confirmation before the self-ballot
export const LEAVE_TICKS = 4      // ticks a leaver waits WITHOUT a member link that could answer before it goes like a crash
//! LEAVE_WINDOW (DESIGN-LEAVE §10.7, 2026-10-10): the most ticks the view half of a leave may run in all while a member
// that could answer the knock is linked — a stalled survivor wakes inside it with the leaver still there to grant. Never
// less than LEAVE_TICKS in effect (a row at or below it means the bound alone). 16 = drainTicks: 8 s at the default
// cadence, inside docker stop's 10 s grace with the shell's two slack ticks (9 s). The config key leave.ms sets it.
export const LEAVE_WINDOW = 16
//! DRAIN_TICKS (DESIGN-SCALE §7 stage 1 (b), 2026-10-10): ticks a SCOPED leaver, already out of the view, waits for
// the new holders of what it held to prove they hold it (the shed bar) before it goes anyway (`undrained`, `left` b=0)
export const DRAIN_TICKS = 16

const sorted = (m: [string, string][]) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))
//! majority of `of`, counting ONLY voters that are in `of` (a voter in both joint sets counts in both;
// a voter in neither counts in neither). The empty set (open genesis as the old view) is trivially satisfied.
const majority = (of: string[], got: Set<string>) =>
  of.length === 0 || [...got].filter((u) => of.includes(u)).length * 2 > of.length
//! hashOf — the proposal identity a VOTE must echo: the member uuids, order-stable.
const hashOf = (m: [string, string][]) => m.map((x) => x[0]).join(',')
//! viewOk — frame validation: a members array must be a bounded list of unique [uuid, listen] string
// pairs. A crc-valid frame with a malformed body must be REJECTED here, never allowed to throw past
// the FrameError net or install garbage into committed state (adversarial-review crash finding).
const viewOk = (m: unknown): m is [string, string][] => {
  if (!Array.isArray(m) || m.length === 0 || m.length > 4096) return false
  const seen = new Set<string>()
  for (const x of m) {
    if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'string') return false
    if (seen.has(x[0])) return false
    seen.add(x[0])
  }
  return true
}

export class Membership {
  view: View = { epoch: 0, members: [] }
  //! ballot state: one vote per epoch, identified by (epoch, proposer, membersHash) — see the banner
  votedFor = { e: 0, p: '', h: '' }
  #proposal: { view: View; old: string[]; h: string; votes: Set<string>; ticks: number; age: number } | null = null
  //! #burned — the highest epoch known to hold SPENT votes for a ballot that never committed (the
  // proposer vanished mid-round). Vote-once-per-epoch means a burned epoch is unwinnable by any OTHER
  // proposer, and with every proposal pinned to view.epoch+1 that was a PERMANENT liveness wedge: a
  // live majority could never change membership again (M4-review, repro'd — and M4b's durable votedFor
  // made the burn survive restarts). Escalation is the classic consensus answer (Raft terms): propose
  // PAST the burn. Learned from a refusal's `ve` (the voter's votedFor.e) and from this node's own
  // spent vote. Safety is untouched: one-view-per-epoch rests on vote-once-per-epoch, and the burned
  // majority is exactly what makes the skipped epoch uncommittable by anyone else.
  #burned = 0
  //! suspicion: consecutive ticks each member has been unreachable
  #suspectTicks = new Map<string, number>()
  #suspects = new Set<string>()
  //! epoch-staleness gate state
  epochStale = false
  #staleWant = 0
  #pullTicks = 0
  //! rejoin floor: a restored node is read-only until a committed view ≥ this is CONFIRMED live (plan boot modes)
  rejoinFloor = 0
  #rejoinTicks = 0
  //! leaving — the graceful exit in progress (V4-6): `ticks` spent waiting with no member link that could answer
  // (the leaveTicks bound), `total` ticks since the leave began (the leaveWindow; DESIGN-LEAVE §10.7), and
  // whether the VIEW half is over (`done`: the view without me committed and echoed, or a bound ran out —
  // nothing more to knock for, and no ballot may vote me back in). `drain` (DESIGN-SCALE stage 1 (b)) is the
  // scoped leaver's second wait: defined while `left` is held for the new holders, counting its own ticks
  // against tune.drainTicks; `clean` is the view half's verdict it carries (the echo came: true; bounded out:
  // false), so the final `left` is clean only when BOTH halves were — set with `drain`, read when the drain ends.
  leaving: { ticks: number; total: number; done: boolean; drain?: number; clean?: boolean } | null = null
  //! #leavers — members this node has heard are LEAVING: they knocked LEAVE at it (onLeave) or proposed their own
  // exit to it (onPropose: a ballot that leaves its proposer out). A fellow leaver can commit nothing, so its link
  // does not keep a knock window open (DESIGN-LEAVE §10.7). In-memory only: pruned of non-members on every install
  // (hygiene — #answerable checks membership first, so the prune changes no answer; it keeps the set from growing
  // across many leaves), and forgotten for a uuid on a fresh admit (a new life, or a redial). The cost of forgetting:
  // a non-lowest fellow leaver knocks LEAVE again next tick, so the error is one tick; the LOWEST fellow leaver
  // re-offers its exit ballot only to members that have not voted (#proposalTargets), so a voter that re-admitted it
  // hears nothing more until that ballot ages out and is re-proposed (tune.proposalAge, 10 ticks) or the window
  // ends — in the shell the leaver's own teardown closes the link first. Read by #answerable alone; no ballot rule
  // reads it.
  #leavers = new Set<string>()
  #wasOpen = true // last journaled gate state, for transition events
  //! wasMember — has any view this node held ever named it? Set in install() (the boot view counts: it is
  // the view install() replaces). It splits the not-a-member gate word: a node that was in a view and is
  // not any more was voted out ('evicted'); one never named yet is a newcomer waiting for its JOIN ballot
  // ('joining') — onView hands a joiner the current view at admit time, before anyone votes it in.
  #wasMember = false

  constructor(boot?: { epoch: number; members: [string, string][]; votedFor?: { e: number; p: string; h: string } }) {
    if (boot && boot.epoch > 0 && viewOk(boot.members)) {
      //! the restored view WAS committed — it seeds ballot arithmetic and pull targets. But the node is
      // REJOINING: read-only until a live peer (or the rejoin self-ballot) confirms a view ≥ this epoch
      // (v2 DECISIONS AA.5 carried up a layer: restored-with-peers must not self-trust its own gate).
      this.view = { epoch: boot.epoch, members: sorted(boot.members) }
      this.rejoinFloor = boot.epoch
    }
    //! the restored SPENT ballot (M4b): a crash inside one ballot round restarts remembering who it
    // voted for — the M2 double-vote-after-restart debt is unrepresentable once this rides the WAL
    if (boot?.votedFor) this.votedFor = { ...boot.votedFor }
  }

  //! isMember — of the COMMITTED view (open genesis has no members: nobody is excluded).
  isMember(uuid: string): boolean { return this.view.members.some((m) => m[0] === uuid) }

  rejoining(): boolean { return this.rejoinFloor > 0 }

  //! gate — the write-commit decision, computed from committed facts only (never from transport optimism).
  gate(node: Node): { open: boolean; reason: string } {
    if (this.epochStale) return { open: false, reason: 'stale-epoch' }
    if (this.rejoining()) return { open: false, reason: 'rejoining' }
    if (this.view.epoch === 0) return { open: true, reason: '' } // open genesis — the M0/M1 mode
    if (!this.isMember(node.uuid)) return { open: false, reason: this.#wasMember ? 'evicted' : 'joining' }
    let reachable = 1 // self
    for (const l of node.links.values())
      if (l.state === LS.admitted && !l.dead && this.isMember(l.uuid)) reachable++
    return reachable * 2 > this.view.members.length
      ? { open: true, reason: '' }
      : { open: false, reason: 'minority' }
  }

  //! #lowestLive — the single-proposer rule: the lowest-uuid non-suspect member proposes; everyone else defers.
  #lowestLive(): string {
    return this.view.members.map((m) => m[0]).filter((u) => !this.#suspects.has(u))[0] ?? ''
  }

  //! tick — the membership clock (called from the heartbeat branch): genesis, suspicion, eviction
  // proposals, proposal retry/abandon, stale-pull retries + alarmed release, rejoin/evictee recovery.
  tick(node: Node) {
    const j = node.journal
    //! genesis: fully-formed open mesh + lowest uuid ⇒ propose view 1 over the admitted set.
    // CLIENT links are invisible here (M5b): a spoke never counts toward formation, never enters the
    // member sweep, and never wins the lowest-uuid race — and a client NODE runs none of the member
    // machinery at all (the node.client guards here and below; stale-pulls + settle stay live for it).
    // The formation set is the hosts this node was told to dial — or, for a listener given NONE, the
    // members that dialed it (I-22, 2026-09-28): in a one-sided static pair (`{ listen }` + `{ listen,
    // hosts: [it] }`) the hostless side never proposed, so whenever its uuid sorted lowest the pair sat at
    // epoch 0 for good. One admitted member link is enough; a later arrival joins at the next epoch (V4-3).
    if (!node.client && this.view.epoch === 0 && !this.#proposal && !this.rejoining() && !this.epochStale) {
      const hosts = node.hosts
      const links = this.#admitted(node).filter((l) => !l.client) // dedup-race losers are dead and excluded (review: a dead twin once double-counted)
      if (links.length >= Math.max(1, hosts.length) && [node.uuid, ...links.map((l) => l.uuid)].sort()[0] === node.uuid) {
        const byUuid = new Map<string, string>([[node.uuid, node.listen]])
        for (const l of links) byUuid.set(l.uuid, l.listen)
        this.#propose(node, { epoch: this.#nextEpoch(node), members: sorted([...byUuid.entries()]) })
      }
    }
    //! suspicion: a committed-view member with no admitted link for suspectTicks (SUSPECT_TICKS) ticks is suspect
    if (!node.client && this.view.epoch > 0 && this.isMember(node.uuid) && !this.rejoining()) {
      const suspectTicks = node.tune.suspectTicks
      for (const [uuid] of this.view.members) {
        if (uuid === node.uuid) continue
        const id = node.byUuid.get(uuid)
        const live = id !== undefined && node.links.get(id)?.state === LS.admitted && !node.links.get(id)?.dead
        if (live) {
          this.#suspectTicks.delete(uuid)
          if (this.#suspects.delete(uuid) && this.#proposal && !this.#proposal.view.members.some((m) => m[0] === uuid) && this.isMember(uuid))
            this.#proposal = null //! the suspect came BACK: abandon the eviction ballot before a post-heal vote commits it against a live member
          continue
        }
        const t = (this.#suspectTicks.get(uuid) ?? 0) + 1
        this.#suspectTicks.set(uuid, t)
        if (t >= suspectTicks && !this.#suspects.has(uuid)) {
          this.#suspects.add(uuid)
          j.armed && j.emit(JK.suspect, uuid)
        }
      }
      //! eviction: the lowest-uuid LIVE member proposes the shrunk view. A suspect the proposer is STILL
      // DIALING is held back (node.dialing): an un-exhausted backoff chain — the pending-redial window
      // right after a heal — means reachability is unknown, and holding one tick converts a spurious
      // evict/rejoin churn cycle into a plain re-admit. Give-up ends the hold.
      if (this.#suspects.size && !this.#proposal && !this.epochStale) {
        const live = this.view.members.map((m) => m[0]).filter((u) => !this.#suspects.has(u))
        const evictable = this.view.members.filter(([u, listen]) => this.#suspects.has(u) && !node.dialing(listen))
        if (evictable.length && live[0] === node.uuid && live.length * 2 > this.view.members.length) {
          const gone = new Set(evictable.map((m) => m[0]))
          this.#propose(node, { epoch: this.#nextEpoch(node), members: this.view.members.filter(([u]) => !gone.has(u)) })
        }
      }
    }
    //! proposal upkeep: re-offer to members that have not voted (idempotent re-grants make this safe and
    // make it HEAL a lost VOTE frame); abandon when the epoch passed or the ballot aged out (an aged-out
    // ballot was blocking every JOIN — the review's zombie-proposal wedge).
    if (this.#proposal) {
      if (this.#proposal.view.epoch <= this.view.epoch || ++this.#proposal.age > node.tune.proposalAge) this.#proposal = null
      else if (++this.#proposal.ticks >= 2) {
        this.#proposal.ticks = 0
        this.#send(node, this.#proposalTargets(node), this.#proposeFrame(node))
      }
    }
    //! leaving (V4-6): re-knock every tick until a survivor's echo, bounded — then go like a crash.
    // Once my shrunk view is installed here there is nothing left to knock for: only the echo is awaited.
    //! The knock window (DESIGN-LEAVE §10.7): a tick counts toward the leaveTicks bound only while no member that
    // could answer is linked (#answerable); with one linked the leaver keeps knocking, up to leaveWindow ticks in
    // all (never fewer than leaveTicks: a window at or below the bound is the bound alone). A link that dies is
    // not a tick: from then on the bound counts, as it always did.
    if (this.leaving && !this.leaving.done) {
      if (!this.#answerable(node)) this.leaving.ticks++
      this.leaving.total++
      if (this.leaving.ticks > node.tune.leaveTicks || this.leaving.total > Math.max(node.tune.leaveWindow, node.tune.leaveTicks)) this.#finishLeave(node, false)
      //! epoch 0 = no view has reached me yet: keep knocking (a peer that HAS one answers). Past that,
      // only a member knocks — once my shrunk view is installed here there is nothing left to ask for.
      else if (this.isMember(node.uuid) || this.view.epoch === 0) this.#knockLeave(node)
    }
    //! draining (DESIGN-SCALE stage 1 (b)): the view half is over; the scoped leaver counts a drain tick and
    // re-reads the shed bar — done when every reachable holder covers, bounded by drainTicks (then `undrained`)
    else if (this.leaving && this.leaving.drain !== undefined) this.drain(node, true)
    //! stale-epoch pulls: targeted, bounded; then the alarmed release (a wedged gate is named, never silent)
    if (this.epochStale) {
      if (this.#pullTicks++ < node.tune.pulls) {
        this.#send(node, this.#admitted(node).filter((l) => !l.client), encodeControl(VERB.PULL, { e: this.view.epoch })) // a spoke holds no view of its own to answer with
      } else {
        this.epochStale = false
        j.armed && j.emit(JK.gateAlarm, this.#staleWant)
      }
    }
    //! rejoining: pull the live view from restored members; if NOBODY confirms (full-cluster restart),
    // the lowest restored member self-ballots the restored view at epoch+1 — majority of the restored
    // set must grant, so a live newer cluster always outruns this (its VIEW clears the floor first).
    if (!node.client && this.rejoining() && !this.epochStale) {
      const memberLinks = this.#admitted(node).filter((l) => this.isMember(l.uuid))
      this.#send(node, memberLinks, encodeControl(VERB.PULL, { e: this.view.epoch }))
      if (++this.#rejoinTicks >= node.tune.rejoinTicks && !this.#proposal && this.#lowestLive() === node.uuid)
        this.#propose(node, { epoch: this.#nextEpoch(node), members: this.view.members })
    }
    //! evicted: ask the lowest admitted MEMBER of my view to propose me back in (a fellow evictee would
    // silently drop the knock — the review's two-evictees-knocking-on-each-other wedge). A LEAVER is out
    // on purpose (V4-6): once its shrunk view installs it is a non-member too, and must never knock its
    // way back in during the ticks between `left` and the shell's teardown.
    if (!node.client && !this.rejoining() && !this.leaving && this.view.epoch > 0 && !this.isMember(node.uuid) && !this.epochStale) {
      const target = this.#admitted(node).filter((l) => this.isMember(l.uuid)).sort((a, b) => (a.uuid < b.uuid ? -1 : 1))[0]
      if (target) {
        target.ship(encodeControl(VERB.JOIN, { u: node.uuid, i: node.incarnation, l: node.listen }), node.env.sink, j)
        target.ship(encodeControl(VERB.PULL, { e: this.view.epoch }), node.env.sink, j)
        j.armed && j.emit(JK.join, node.uuid)
      }
    }
    this.settle(node)
  }

  //! onAdmit — view-on-admit, symmetric with digest-on-admit: every admission announces the committed
  // view, so a healed partition re-converges its VIEWS even when no epoch-stamped records flow (the
  // plan's split-brain-heal re-announce). A rejoiner/evictee learns its status in one round-trip.
  onAdmit(node: Node, link: Link) {
    this.#leavers.delete(link.uuid) // a fresh admit forgets what an earlier link heard: a non-lowest leaver still leaving knocks again next tick; the lowest re-proposes only after its ballot ages out (§10.7, the #leavers note)
    if (!node.client && this.view.epoch > 0) // a spoke announces nothing: its view is its feeder's, and a reborn feeder must not inherit it
      link.ship(encodeControl(VERB.VIEW, { e: this.view.epoch, m: this.view.members }), node.env.sink, node.journal)
  }

  //! staleObserved — the epoch-staleness contract: any epoch above the committed view closes the gate
  // and starts the targeted pull (the frame's own link answers first, no waiting for the next tick).
  staleObserved(node: Node, epoch: number, from?: Link) {
    if (!Number.isFinite(epoch) || epoch <= this.view.epoch) return
    this.#staleWant = Math.max(this.#staleWant, epoch)
    if (!this.epochStale) {
      this.epochStale = true
      this.#pullTicks = 0
      node.journal.armed && node.journal.emit(JK.epochStale, epoch)
      from?.ship(encodeControl(VERB.PULL, { e: this.view.epoch }), node.env.sink, node.journal)
      this.settle(node)
    }
  }

  //! ── frame handlers (dispatched by node.ts on admitted links only) ──
  onJoin(node: Node, link: Link, v: { u?: unknown; l?: unknown }) {
    if (typeof v?.u !== 'string' || typeof v?.l !== 'string') return
    node.journal.armed && node.journal.emit(JK.join, v.u)
    if (this.view.epoch === 0 || !this.isMember(node.uuid) || this.isMember(v.u) || this.epochStale || this.rejoining()) return
    //! churn guard: only propose re-admission of a joiner I hold an ADMITTED link to. A proposer that
    // cannot reach the joiner would evict it again three ticks later — a persistent asymmetric cut
    // stabilizes as CP read-only for the unreachable node instead of churning epochs forever (review
    // finding: epoch 303 in 60s). Reachability, not suspicion memory: install() prunes non-member
    // suspects, so a suspects-based guard would be vacuous one install later.
    const jid = node.byUuid.get(v.u)
    const jlink = jid !== undefined ? node.links.get(jid) : undefined
    if (!jlink || jlink.state !== LS.admitted || jlink.dead) return
    //! single-proposer discipline: a non-lowest member RELAYS the knock one hop instead of dueling ballots
    if (this.#lowestLive() !== node.uuid) {
      const id = node.byUuid.get(this.#lowestLive())
      const l = id !== undefined ? node.links.get(id) : undefined
      if (l && l.state === LS.admitted && !l.dead)
        l.ship(encodeControl(VERB.JOIN, { u: v.u, i: 0, l: v.l }), node.env.sink, node.journal)
      return
    }
    if (this.#proposal) return
    this.#propose(node, { epoch: this.#nextEpoch(node), members: sorted([...this.view.members, [v.u, v.l]]) })
  }

  //! onLeave (V4-6) — a member is stopping on purpose and asks for the view without it. The lowest live
  // member proposes it (single-proposer discipline — the leaver knocks on EVERY member link, so the
  // proposer hears it directly and the rest ignore it), under the join's guards: a committed view,
  // membership on both sides, no ballot in flight, no stale gate. Identity is the link's authenticated
  // uuid — the frame carries none. Never an empty view (the last member simply goes).
  onLeave(node: Node, link: Link) {
    const leaver = link.uuid
    node.journal.armed && node.journal.emit(JK.leave, leaver)
    this.#leavers.add(leaver) // this peer is leaving: its link no longer keeps my own knock window open (§10.7)
    if (node.client || this.view.epoch === 0 || !this.isMember(node.uuid) || !this.isMember(leaver) || this.epochStale || this.rejoining()) return
    if (this.#lowestLive() !== node.uuid || this.#proposal || this.view.members.length < 2) return
    this.#propose(node, { epoch: this.#nextEpoch(node), members: this.view.members.filter(([u]) => u !== leaver) })
  }

  onPropose(node: Node, link: Link, v: { e?: unknown; m?: unknown }) {
    if (typeof v?.e !== 'number' || !viewOk(v.m)) return
    const j = node.journal
    const proposer = link.uuid // authenticated by HELLO — never trust a frame field for identity
    const h = hashOf(v.m)
    //! one spelling for a clean leave: a ballot that leaves its OWN proposer out is a leave (the lowest live
    // leaver proposes its exit itself, see #knockLeave). Journal it as leave(proposer) — the row a knocked
    // leave writes in onLeave — so a survivor's diary reads the same either way — and remember the proposer
    // as a leaver for my own knock window (#leavers, §10.7). Nothing else: no ballot rule reads it.
    if (!v.m.some((m) => m[0] === proposer)) { j.armed && j.emit(JK.leave, proposer); this.#leavers.add(proposer) }
    //! the vote-once rule with same-proposer idempotency (see banner): unspent epoch, or re-grant to the
    // same proposer (his abandoned/re-offered ballots — at most one of HIS can commit; a rejoining node
    // may vote: voting is not writing). ANY epoch above the committed view is grantable — a ballot
    // above view+1 is a lawful ESCALATION past a burned epoch, not evidence that the middle committed
    // (the old `=== view.epoch + 1` pin plus the e-1-committed inference was the wedge's other half).
    //! the leave's two vote rules (V4-6 wedge fix). A node that has ANSWERED its leave never grants a
    // ballot that puts it back IN the view: that vote is exactly what a two-member ballot needs, and
    // spending it hands the cluster a member that is already gone (the shell is tearing it down). One
    // still KNOCKING may grant such a ballot — it rebases onto the newer view and re-knocks from there,
    // so nothing stalls. And a ballot that takes me OUT is grantable even when epoch-stale: removing me
    // cannot depend on how current my view is (safety rests on vote-once + the proposer's joint
    // majorities, never on the voter's freshness). Refusing a vote is always safe — it can only cost
    // liveness, and the ballot it costs here is one that must not commit.
    const going = this.leaving !== null
    const inBallot = going && v.m.some((m) => m[0] === node.uuid)
    const leavingOut = going && !inBallot
    const backIn = this.leaving?.done === true && inBallot
    const grant = v.e > this.view.epoch && !backIn && (leavingOut || !this.epochStale) && (this.votedFor.e < v.e || this.votedFor.p === proposer)
    if (grant) {
      this.votedFor = { e: v.e, p: proposer, h }
      //! the vote is DURABLE before the VOTE frame leaves (sink.boot precedes the ship in this step —
      // the env contract): a crash between grant and send must not forget the spent ballot
      node.persistBoot()
    }
    j.armed && j.emit(JK.vote, v.e, grant ? 1 : 0, proposer)
    link.ship(encodeControl(VERB.VOTE, { e: v.e, g: grant ? 1 : 0, ce: this.view.epoch, h, ve: this.votedFor.e }), node.env.sink, j)
  }

  onVote(node: Node, link: Link, v: { e?: unknown; g?: unknown; ce?: unknown; h?: unknown; ve?: unknown }) {
    if (typeof v?.e !== 'number' || typeof v?.g !== 'number') return
    if (typeof v.ce === 'number') this.staleObserved(node, v.ce, link)
    //! a REFUSAL carrying the voter's spent epoch (ve) teaches the burn in one round: this voter's
    // vote is gone for every epoch ≤ ve, so the next proposal must escalate past it (see #burned)
    if (v.g !== 1 && typeof v.ve === 'number' && Number.isFinite(v.ve) && v.ve > this.#burned && v.ve > this.view.epoch)
      this.#burned = v.ve
    const p = this.#proposal
    //! count only grants that echo THIS proposal's identity — a stale grant for an earlier same-epoch
    // ballot (different members) must not commit a view nobody voted for
    if (!p || p.view.epoch !== v.e || v.g !== 1 || v.h !== p.h) return
    p.votes.add(link.uuid)
    //! joint consensus: majority of the OLD set AND of the NEW set (open genesis: old set is empty → new only)
    if (majority(p.old, p.votes) && majority(p.view.members.map((m) => m[0]), p.votes)) {
      const view = p.view
      this.#proposal = null
      this.install(node, view)
    }
  }

  onView(node: Node, link: Link, v: { e?: unknown; m?: unknown }) {
    if (typeof v?.e !== 'number' || !viewOk(v.m)) return
    //! live confirmation clears the rejoin floor even at EQUAL epoch (the restored view re-confirmed by a peer)
    if (this.rejoining() && v.e >= this.rejoinFloor && v.e >= this.view.epoch) {
      this.rejoinFloor = 0
      this.settle(node)
    }
    //! a CLIENT follows its FEEDER (I-23, amended 2026-10-08): on its primary link a view whose members
    // differ installs at ANY epoch — equal or lower too. The cluster it looks at re-formed without it
    // (memory-only members reborn under fresh uuids start the count again at 1); its members row and its
    // epoch must show what its feeder shows, never dead ids kept for their bigger number. Every other
    // link stays "higher only": a stale non-primary server must not teach a stale row. A member refuses
    // all of it: one view per epoch is the safety rule, and a VIEW is not a ballot.
    const feeder = node.client && v.e >= 1 && link.id === node.primary && hashOf(v.m) !== hashOf(this.view.members)
    if (v.e > this.view.epoch || feeder) this.install(node, { epoch: v.e, members: v.m })
    else if (v.e < this.view.epoch && !node.client) // help a laggard up — a spoke never teaches, so it never "helps"
      link.ship(encodeControl(VERB.VIEW, { e: this.view.epoch, m: this.view.members }), node.env.sink, node.journal)
    //! the leaver's exit proof (V4-6): a VIEW at or above my committed epoch that does not hold me, from a
    // peer that stays — the commit reached a survivor, so going now cannot un-commit it. Covers both shapes:
    // the proposer's VIEW (installed just above) and a survivor's flood-back of my own self-proposed view.
    if (this.leaving && !this.leaving.done && v.e >= this.view.epoch && !v.m.some((m) => m[0] === node.uuid))
      this.#finishLeave(node, true)
  }

  onPull(node: Node, link: Link, v: { e?: unknown }) {
    if (typeof v?.e !== 'number') return
    if (!node.client && this.view.epoch > v.e) // a spoke's view is hearsay — only a member answers a PULL
      link.ship(encodeControl(VERB.VIEW, { e: this.view.epoch, m: this.view.members }), node.env.sink, node.journal)
  }

  //! install — the ONE place a view becomes committed fact: bump the node epoch, clear satisfied stale/
  // rejoin states, prune suspicion, journal evictions, dial members we lack, and FLOOD the view to every
  // admitted link (equal-epoch frames are ignored, so the gossip terminates after one install per node —
  // and a detached evictee hears its fate from ANY member, not just the committer).
  install(node: Node, view: View) {
    const j = node.journal
    for (const [u] of this.view.members)
      if (!view.members.some((m) => m[0] === u)) j.armed && j.emit(JK.evict, u)
    if (this.isMember(node.uuid)) this.#wasMember = true // the view being replaced (a restored boot view too)
    this.view = { epoch: view.epoch, members: sorted(view.members) }
    if (this.isMember(node.uuid)) this.#wasMember = true
    node.epoch = view.epoch
    node.persistBoot() // the committed view is a durable fact from the instant it installs
    node.confirm.recount(node) // the view-change recount: thresholds are majorities OF THE COMMITTED VIEW
    if (this.epochStale && view.epoch >= this.#staleWant) { this.epochStale = false; this.#pullTicks = 0 }
    if (this.rejoining() && view.epoch >= this.rejoinFloor) this.rejoinFloor = 0
    if (this.#proposal && this.#proposal.view.epoch <= view.epoch) this.#proposal = null
    //! a leaver REBASES (V4-6): a newer view that still holds me makes my in-flight shrunk ballot stale
    // (its old set is no longer the committed view) — drop it; the next tick re-knocks from this view
    if (this.leaving && !this.leaving.done && this.#proposal && this.isMember(node.uuid)) this.#proposal = null
    for (const u of [...this.#suspects]) if (!this.isMember(u)) { this.#suspects.delete(u); this.#suspectTicks.delete(u) }
    if (!this.isMember(node.uuid)) { this.#suspects.clear(); this.#suspectTicks.clear() } // an evictee's grudges expire with its membership
    for (const u of [...this.#leavers]) if (!this.isMember(u)) this.#leavers.delete(u) // hygiene: a leaver out of the view is no longer "leaving" (§10.7); #answerable checks membership first, so this changes no answer
    //! dial any member this node holds no link to (the joiner's side of a join, a healed evictee's peers),
    // unless a redial chain is still trying it: that chain owns the target until it ends. A dial over it
    // failed into the same chain entry and armed a second timer line that shared the tries, so the chain
    // (and the eviction hold it carries) gave up in about half its time. A given-up chain is not dialing.
    for (const [u, listen] of this.view.members) {
      if (u === node.uuid || node.byUuid.has(u) || !listen || listen === node.listen || node.dialing(listen)) continue
      j.armed && j.emit(JK.dial, listen)
      node.env.sink.connect(listen)
    }
    //! THE VIEW FLOODS FIRST (M6-review finding 39): rescope's install round ships HAVEQ on these
    // same FIFO links — a peer still on the old epoch must receive the VIEW before the round, or it
    // deterministically drops the round for epoch skew and the offer waits a full re-round cadence.
    if (!node.client) this.#send(node, this.#admitted(node), encodeControl(VERB.VIEW, { e: this.view.epoch, m: this.view.members })) // a spoke never floods (I-23)
    //! M6: every install re-derives the scope machine against the new ring — held partitions that
    // left the R-set freeze into orphans HERE, the instant the duty changes (kernel/scope.ts)
    if (node.armed) node.scope!.rescope(node)
    //! ...and the boot record is rewritten AFTER rescope (findings 31/47): the arming install's
    // held/orphan lists and an epoch-abort's residue orphan are durable facts of THIS install —
    // the pre-rescope record above only guaranteed the epoch itself before any frame left.
    if (node.armed && node.durable) node.persistBoot()
    j.armed && j.emit(JK.viewInstall, view.epoch, view.members.length)
    this.settle(node)
  }

  //! settle — journal gate transitions and drive the write pipeline's flush boundary: parked attempts
  // re-resolve their owner and re-enter the world whenever membership state moves (gate transitions,
  // installs, admits, link losses — the queue itself lives in kernel/write.ts, plan §3.4).
  settle(node: Node) {
    const g = this.gate(node)
    if (g.open !== this.#wasOpen) {
      this.#wasOpen = g.open
      const j = node.journal
      if (g.open) j.armed && j.emit(JK.gateOpen)
      else j.armed && j.emit(JK.gateClose, g.reason)
    }
    if (g.open && node.writes.pending.size) node.writes.flush(node)
  }

  //! leave — the GRACEFUL exit (V4-6; see the banner). Starts the leave and returns; the outcome
  // arrives on sink.left exactly once: at once with clean=true when there is nothing to leave (open
  // genesis, a client, a non-member, a solo view, a rejoiner, a stale gate — the caller tears down
  // now), later with clean=true on a survivor's echo, or clean=false when the bound ran out (LEAVE_TICKS
  // with no member linked that could answer, the knock window LEAVE_WINDOW with one).
  leave(node: Node) {
    if (this.leaving) return
    //! "nothing to leave" is a claim about OTHER nodes, so it needs EVIDENCE, not a local mood. A client
    // is never in anyone's view. Otherwise: a committed view that holds me alongside someone else — or,
    // while I hold NO view yet, any admitted peer at all, because a view that holds me may be committing
    // this instant (I may already have granted it; a peer may already have installed it and its VIEW
    // frame may be in flight, unread, or dropped). epochStale/rejoining describe how current MY
    // knowledge is; they never prove that nobody holds me (V4-6 wedge: they answered clean=true at once,
    // the shell tore the node down, and a two-member survivor kept a member it can never evict).
    const held = this.view.epoch > 0
      ? this.isMember(node.uuid) && this.view.members.length >= 2
      : this.#admitted(node).some((l) => !l.client)
    if (node.client || !held) {
      //! answered at once — but LATCHED as going, so the microtask hop before the shell's teardown
      // cannot vote this node INTO a view it has already said it left (see onPropose).
      this.leaving = { ticks: 0, total: 0, done: true }
      //! nothing to LEAVE, but maybe something to LOSE (DESIGN-SCALE stage 1 (b)): a scoped node that is in no
      // view with anyone else — the last member, or one already voted out — asks the same last question as a
      // leaver past its exit proof (#finishLeave): drain to a reachable holder, or go saying what goes with it.
      if (node.armed && this.#exit(node)) return
      node.env.sink.left?.(true)
      return
    }
    this.leaving = { ticks: 0, total: 0, done: false }
    node.journal.armed && node.journal.emit(JK.leave, node.uuid)
    this.#knockLeave(node)
  }

  //! #answerable — is a member that could answer my knock linked? (DESIGN-LEAVE §10.7) A member of my committed
  // view, on an admitted live non-client link, that has neither knocked LEAVE at me nor proposed its own exit to
  // me (#leavers). At epoch 0 there are no members, so nothing counts and the leaveTicks bound alone applies, as
  // before. Once my shrunk view is installed here the survivors are still members of it and I am not: their
  // links keep the window open for the echo I am waiting for.
  #answerable(node: Node): boolean {
    if (this.view.epoch === 0) return false
    for (const l of node.links.values())
      if (l.state === LS.admitted && !l.dead && !l.client && this.isMember(l.uuid) && !this.#leavers.has(l.uuid)) return true
    return false
  }

  //! #knockLeave — one round of the leave: propose the shrunk view myself when I am the lowest live
  // member (replacing any OTHER ballot of mine — leaving outranks it, and re-spending my vote on my own
  // new ballot is the idempotent same-proposer case), else send LEAVE on every admitted member link —
  // the one that is lowest live proposes, the rest ignore it. Idempotent per tick.
  #knockLeave(node: Node) {
    //! before any view reaches me the knock still means something to a peer that HAS one: I cannot
    // filter by a membership I do not know, so it goes to every admitted peer. Its lowest live member
    // proposes the view without me exactly as below, and its VIEW echo is my exit proof (onView).
    if (this.view.epoch === 0) {
      this.#send(node, this.#admitted(node).filter((l) => !l.client), encodeControl(VERB.LEAVE, {}))
      return
    }
    const shrunk = this.view.members.filter(([u]) => u !== node.uuid)
    if (shrunk.length === 0) { this.#finishLeave(node, true); return } // the last member simply goes
    if (this.#lowestLive() === node.uuid) {
      if (this.#proposal && this.#proposal.h !== hashOf(shrunk)) this.#proposal = null
      if (!this.#proposal) this.#propose(node, { epoch: this.#nextEpoch(node), members: shrunk })
      return
    }
    this.#send(node, this.#admitted(node).filter((l) => !l.client && this.isMember(l.uuid)), encodeControl(VERB.LEAVE, {}))
  }

  //! #finishLeave — the VIEW half of the leave is over, once. Unscoped, or bounded out (clean=false), or with
  // heartbeats off (no drain clock: the shed poll never runs either), the leave is over here: journal `left`
  // (b = clean) and tell the env. A SCOPED leaver that left cleanly first DRAINS (DESIGN-SCALE §7 stage 1 (b)):
  // the install that took it out of the view already froze every partition it held into an orphan
  // (scope.rescope), and the new holders acquire from it as from any orphan. `left` is held while some
  // orphan with content has a reachable current holder that has not yet attested covering its frozen
  // tails (scope.undrained — the shed bar over reachable holders); the hold ends at the shed, at the
  // bound (tune.drainTicks), or when nobody can be drained to. What was not drained is counted in an
  // `undrained` row and makes the exit `left` b=0: the rows went with the leaver.
  //! Bounded out (clean=false) the leaver still drains when its OWN view no longer holds it: as the proposer
  // it commits the shrunk view from the votes alone, and when every survivor's echo is lost inside the bound
  // (leaveTicks unlinked, leaveWindow with a survivor linked) its partitions are orphans with reachable new holders all the same (third review, 2026-10-10 — before, at
  // R=1 the only copy went with it, uncounted). The drain then carries the view half's verdict: the final
  // `left` is b=0 even when every row was handed over, since the commit was never proved to have reached a
  // survivor. Still in its own view (the vote never came back), nothing froze: it goes like a crash, drains
  // nothing and counts nothing — `undrained` is the drain window's count only.
  #finishLeave(node: Node, clean: boolean) {
    if (!this.leaving || this.leaving.done) return
    this.leaving.done = true
    if (node.armed && (clean || !this.isMember(node.uuid)) && this.#exit(node, clean)) return
    this.#left(node, clean, 0)
  }

  //! #exit — the scoped leaver's last question, once the view half is over: is anything this node holds not yet
  // proved held by a reachable current holder? Something waiting with the clock on ⇒ hold (the drain begins,
  // carrying `clean`, the view half's verdict); something waiting with no clock, or stranded (nobody to drain
  // to) ⇒ go at once, `undrained`, left(false). Returns true when it answered (held or went); false when
  // nothing is at stake — the caller's own verdict stands.
  #exit(node: Node, clean = true): boolean {
    const { waiting, stranded } = node.scope!.undrained(node)
    if (waiting > 0 && node.heartbeats) { this.leaving!.drain = 0; this.leaving!.clean = clean; return true }
    if (waiting + stranded > 0) { this.#left(node, false, waiting + stranded); return true }
    return false
  }

  //! drain — the draining leaver's re-check: from the tick (counting against drainTicks) and from the scope
  // after marks moved (scope.evaluateSheds — a shed, or a holder's attestation, ends the wait the instant it
  // lands, not a tick later). Nothing left waiting ⇒ over: clean iff the view half was AND nothing is stranded.
  drain(node: Node, tick = false) {
    const l = this.leaving
    if (!l || l.drain === undefined) return
    const { waiting, stranded } = node.scope!.undrained(node)
    if (waiting === 0) this.#left(node, l.clean === true && stranded === 0, stranded)
    else if (tick && ++l.drain > node.tune.drainTicks) this.#left(node, false, waiting + stranded)
  }

  //! #left — the exit itself, once per leave: the `undrained` row (when any partition goes with the leaver),
  // then `left` (b = clean) and the env's effect. `clean` now means the whole stop was clean: the view without
  // this node committed and echoed AND (scoped) everything it held was proved held elsewhere.
  #left(node: Node, clean: boolean, undrained: number) {
    this.leaving!.drain = undefined
    const j = node.journal
    if (undrained > 0) j.armed && j.emit(JK.undrained, undrained, this.view.epoch)
    j.armed && j.emit(JK.left, this.view.epoch, clean ? 1 : 0)
    node.env.sink.left?.(clean)
  }

  //! #nextEpoch — the epoch a fresh proposal must target: past the committed view, past every KNOWN
  // burn, past this node's own vote if it is spent on someone else (see #burned) — and never BELOW a
  // ballot of its own (the same epoch again is the idempotent same-proposer case). votedFor remembers
  // only the LATEST ballot: a node that granted another proposer at 2, then opened its own ballot at 3
  // and lost it, once started again at view+1 = 2 — spending at 2 a vote it had already given away
  // there, which nothing remembered any more. That is a double vote, and with two old-set majorities
  // sharing only that voter it committed two views at one epoch (pinned in membership.test.ts, 2026-10-08).
  #nextEpoch(node: Node): number {
    return Math.max(this.view.epoch, this.#burned, this.votedFor.p === node.uuid ? this.votedFor.e - 1 : this.votedFor.e) + 1
  }

  #propose(node: Node, view: View) {
    //! proposing SPENDS your vote — and a vote already spent on another proposer for this epoch cannot
    // be spent again here (the review's critical: double-voting via propose committed two views/epoch).
    // The refusal records the burn so the next attempt escalates past it instead of wedging forever.
    if (this.votedFor.e >= view.epoch && this.votedFor.p !== node.uuid) {
      if (this.votedFor.e > this.#burned) this.#burned = this.votedFor.e
      return
    }
    const h = hashOf(view.members)
    this.votedFor = { e: view.epoch, p: node.uuid, h }
    node.persistBoot() // the self-vote is spent — durable before any PROPOSE frame leaves
    this.#proposal = { view, old: this.view.members.map((m) => m[0]), h, votes: new Set([node.uuid]), ticks: 0, age: 0 }
    node.journal.armed && node.journal.emit(JK.propose, view.epoch, view.members.length)
    //! a solo proposal (single-member old and new sets) commits immediately — solo boot mode
    if (majority(this.#proposal.old, this.#proposal.votes) && majority(view.members.map((m) => m[0]), this.#proposal.votes)) {
      this.#proposal = null
      this.install(node, view)
      return
    }
    this.#send(node, this.#proposalTargets(node), this.#proposeFrame(node))
  }

  #proposeFrame(node: Node): Uint8Array {
    const p = this.#proposal!
    return encodeControl(VERB.PROPOSE, { e: p.view.epoch, m: p.view.members, p: node.uuid })
  }

  #proposalTargets(node: Node): Link[] {
    const p = this.#proposal!
    const want = new Set([...p.old, ...p.view.members.map((m) => m[0])])
    return this.#admitted(node).filter((l) => want.has(l.uuid) && !p.votes.has(l.uuid))
  }

  #admitted(node: Node): Link[] {
    const out: Link[] = []
    for (const l of node.links.values()) if (l.state === LS.admitted && !l.dead) out.push(l)
    return out
  }

  #send(node: Node, links: Link[], bytes: Uint8Array) {
    for (const l of links) l.ship(bytes, node.env.sink, node.journal)
  }
}
