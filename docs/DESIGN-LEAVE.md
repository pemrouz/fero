# DESIGN-LEAVE — the two-member stall (I-20): what was tried, what broke, and how to go on (parked 2026-10-08)

This record is for the owner. It is written so a decision can be made before any more code is
written. It covers one bug and one question that sits behind it.

The bug: a clean stop of one of two members can turn into a crash, and at two members a crash is
permanent. The question behind it: why fero says "three members to be crash safe", and whether a
rule could let two members survive a crash.

Every number here comes from one of these sources. Nothing was re-measured for this record.

- **The plan**: `~/.claude/plans/fero-status-plan-2026-10-03.md` §2.1 (the I-20 item) and §4
  (the owner's answers and the wave-1 outcome).
- **The reports**: `~/.claude/plans/fero-i20-lane-2026-10-08/`. `membership.json` holds the build,
  the first review, the review fix and the first re-check. `membership-r2.json` holds fix round 1,
  re-check 1, fix round 2, re-check 2. `membership-r3.json` holds fix round 3 and re-check 3.
  Below they are called R1, R2, R3, and each part by its name in the file (`review`, `recheck`,
  `fix1`, `recheck1`, and so on).
- **The branch**: `w1/membership` at `6de8eee`, 19 commits on `43ea245`, +1749/−99 over 11 files
  (`commits.txt`, `lane.diff`). Line numbers marked *branch* are in its `kernel/membership.ts`.
- **The base**: the untouched `v4` tree (`w1/base` at `97bd6be`). Line numbers marked *base* are in
  its `kernel/membership.ts`. It differs from the branch's start point `43ea245` only by the
  client-follows-feeder change (`688aea6`), which has nothing to do with leaves.
- **The decision on record**: V4-6 in `docs/DECISIONS.md` (lines 522-643), with its 2026-09-14
  amendment.

Terms, each explained once. A **view** is the committed list of members, numbered by an **epoch**.
A **ballot** is a proposal for the next view; it **commits** when enough members **grant** it.
**Joint consensus** means a ballot for epoch e+1 needs a majority of the OLD view's members and a
majority of the NEW view's members (base `kernel/membership.ts:115-116`, `:408`). **Vote-once**
means a member grants at most one proposer per epoch, remembered durably as `votedFor` (base `:136`,
`:384-389`). The **proposer** is the one member allowed to open a ballot: the lowest uuid among the
members it does not suspect (base `:193-196`). A member is **suspect** after three heartbeat ticks
without a link to it (`SUSPECT_TICKS`, base `:106`). **Eviction** is a ballot that drops a suspect.
The **gate** is the write-commit decision: open when a majority of the view's members is reachable
(base `:180-191`); "writable" means the gate is open. A **knock** is the LEAVE frame a leaver
sends. The **sim** runs the same kernel on a seeded, deterministic schedule; a **seed** names one
schedule; a **monitor** is a check that runs on every event, and **one-view-per-epoch** is the
monitor that fires when two nodes install different views for one epoch. A **cut** is a severed
link between two nodes; a **stall** is a node that stops reading its sockets for a while but is not
dead. **Durable** means the node has a `dir` and a boot record on disk; **restart from disk** means
it comes back as the same node with its last view and its last `votedFor`.

## §0 Where this stands

The owner approved the plan's fix on 2026-10-05 and wrote: *"this really needs to be fixed, need to
be able to say can scale down to 1 or up to any number, not '3 to be crash safe'"* (plan §4). It was
built in wave 1 and reviewed five times in one day. Every review found a new safety hole or a new
wedge. The branch is not merged. On 2026-10-08 the owner chose to park it and design first.

| When (2026-10-08) | What | Commits | Result |
|---|---|---|---|
| 02:41 | The build: the plan's pre-vote | `851796b`, `416d8ac`, `be78891` | R1 `review`: **rework**. Two clean stops at n=4 commit two views at one epoch. |
| 03:19-03:21 | The review fix: a knocking leaver refuses every ballot that keeps it in | `eed1eaa`, `62d6089`, `915d027` | R1 `recheck`: **rework**. Two clean stops at n=3 wedge for good; n=2 lingering leaver splits. |
| 07:22 | Fix round 1: the pre-vote becomes a PLEDGE to one proposer; the "alone-install" | `7d5289a`, `02f65ed` | R2 `recheck1`: **rework**. The alone-install commits two views at one epoch, in life and after a restart; seed 157 wedges where the base heals. |
| 09:35-10:05 | Fix round 2: the lowest leaver pledges too; a ballot commits only at its proposer; a restored leaver waits; four more rules | `18c0e39` … `7766fa5` | R2 `recheck2`: **fix-first**. One crash plus one restart freezes membership for good at n=3, n=4; seeds 740, 1077 wedge where the base heals. |
| 11:52-12:07 | Fix round 3: a restored leaver grants; the stayers lead around a rejoiner; the sweep gets teeth | `0aa9279` … `6de8eee` | R3 `recheck3`: **fix-first**. A cut-off proposer commits alone on pledges and restarted leavers give a stale stayer a second writable view; the n=3 crash twin stays read-only. |

Only `be78891` (a client follows its feeder) has landed on `v4`, as `688aea6`.

What the owner has to decide is in §9 (how to continue) and §7 (the crash-at-two question). The
rest of this record is the evidence.

**2026-10-09, the owner's answers (DECISIONS V4-31).** §9: go design first, the zero-risk candidate
first. §7: (a) stays while the owner weighs a third vote; the directory as that vote is ruled out
and the witness member is the open option (the dated note at the end of §7).

**2026-10-10, §9 steps 1 and 2 done (§10).** The argument per vote source is written (§10.1-§10.7, a
ten-line summary first) and the reviewers' generators are in-tree as `sim/leave-harness.ts`, pinned on
today's kernel (§10.8). No kernel change. One new fact: today's kernel splits on its own when a ballot
evicts two suspects at once (§10.2, `evictTwo`); every hole the three rounds found goes red on the
kernel that had it. The review of the same day corrected §10.3: the pledge restricted to one change
is still unsafe with two pledgers, because a read-only leaver is counted by a stale stayer's gate
(`pledgeTwo`, §10.8); the gate rule of §10.5 comes before any pledge (§10.9). The second review of the
day found the hole in that rule itself: "a vote above my view closes my gate and I lead nothing" turns
`evictTwo` green and leaves a schedule of the same class, `evictTwoB`, splitting, because the stale voter
GRANTS a never-voted member's higher ballot (§10.2: the rule needs a third part, the grant, and with
it a release question nobody has answered). It also found `pledgeTwo` had no teeth (its cut came 3 ms
late; now 0 ms, red on round 3). The third review of the day found two more things. The kept
ballot's two-member shape at n=4, which the page called undrawn, splits today's kernel: two writable
views at the quiet point, then two views at epoch 4 (`keptBallot`, pinned red; §10.2) — so today's
kernel has THREE known splits, `evictTwo`, `evictTwoB` and `keptBallot`. And the cost of the candidate
rule was put in the wrong place: the release is needed by the gate and lead parts as much as by the
grant, because a ballot that fails in a HEALTHY cluster — one member flaps, or the proposer crashes —
leaves every live member read-only for good under the rule, two parts or three, while the base heals
both (`flapDuringBallot`, `proposerCrash`, pinned writable; §10.2). The knock window (§10.7) is next;
the rule of §10.9 step 2 is back in design, with the release as its first question.

## §1 The problem

When one of two members presses Ctrl-C, it asks the other to vote it out and waits about four
heartbeats for the answer. If the other member is stalled for longer than that, the leaver gives up
and goes anyway. The survivor wakes, reads the request out of its socket buffer, but the leaver's
link is already gone, and a view change needs the leaver's vote. The survivor sits at `members 2
writable false` for good. STATUS.md:21 counts "25 of 384 stall schedules in the sim". With three or
more members the same stall only costs time: the others evict the leaver the slow way.

The schedule, step by step, on today's kernel. Two members S and L hold view `{S, L}` at epoch 1.

1. L calls `destroy()`. The kernel's `leave()` starts the leave (base `:504-526`).
2. If L is the lower uuid it PROPOSES `{S}` at epoch 2 itself (base `:542-545`). Otherwise it sends
   LEAVE to S every tick (base `:547`) and S, as the lowest live member, is meant to propose
   (base `:358-359`).
3. S is stalled: its process is alive and its socket is open, but it reads nothing. L's frames sit in
   S's TCP receive buffer.
4. L counts ticks. After `LEAVE_TICKS` (4, base `:110`) without a survivor's echo of the shrunk view
   it journals `left` b=0 and tells the shell to go (base `:263-264`, `:551-556`). The shell tears L
   down and closes the socket with a FIN, after reading everything (plan §2.1, verified fact 1).
5. S wakes. TCP delivers data before close, so S reads the buffered LEAVE (or PROPOSE) first, then
   sees the link drop.
6. If S reads a PROPOSE, it grants (its `votedFor` becomes `{2, L}`) and sends VOTE to a dead link.
   A ballot commits only at its proposer (base `:408-411`), and the proposer is gone.
7. If S reads a LEAVE and is the lowest live member, it proposes `{S}` at 2 and sends PROPOSE to a
   dead link. The ballot needs a majority of the OLD view `{S, L}`, which is both of them. It ages
   out after `PROPOSAL_AGE` (10 ticks, base `:108`, `:255`).
8. L becomes suspect after three ticks. The eviction path needs `live.length * 2 > members.length`
   (base `:245`): one of two is not a majority. No ballot ever opens again.

Why four heartbeats is the window: the leaver's bound is `LEAVE_TICKS` = 4 heartbeat ticks
(base `:110`); at the default `heartbeat.ms` of 500 (README.md:124) that is about two seconds
(V4-6). The shell adds a wall-clock cap of `heartbeatMs × (LEAVE_TICKS + 2)`, at least 250 ms
(`shell/runtime.ts:453`), so `destroy()` can never hang. A survivor that does not read its socket
for longer than that window never sees the knock while the leaver is still there to be answered.
The plan's two "cheap" options do not apply: the survivor's link is UP, it is only not reading, so
"spend no tick while there is no member link" never triggers; and surfacing the failed leave at the
api fixes nothing by itself (plan §2.1 "Why the cheap options do not fix it").

The sim has no stall primitive. Every probe below models a stall as a constant delay on every link
of one node, lifted after the leavers are gone (plan §2.1 fact 2; branch `sim/leave-sweep.test.ts:
102-110`).

## §2 Today's rule (V4-6) and its safety argument

V4-6 (2026-09-07) made a clean `destroy()` LEAVE before it tears down. The rule:

- A member stopping on purpose asks for the view WITHOUT itself while it can still vote. When it is
  the lowest live member it proposes the shrunk view itself; otherwise it sends LEAVE on every
  member link each tick and the lowest live member proposes (base `:528-548`).
- The leaver's own grant is the old-majority vote an eviction of a DEAD member can never get. On a
  two-member view that is 2 of 2 old and 1 of 1 new, so the survivor ends writable alone.
- The leaver goes only when a VIEW at or above its epoch that does not hold it arrives from a peer
  that stays: the exit proof (base `:432-436`). Bounded by `LEAVE_TICKS`; then it goes anyway,
  `left` b=0, and from there it looks like a crash.
- A knocking leaver may grant a ballot that keeps it in and rebase (base `:372-383`); a leaver that
  has ANSWERED its leave refuses such a ballot (`backIn`, base `:383`). A ballot that takes it out
  is grantable even when its gate is stale (`leavingOut`, base `:382`, `:384`).
- The 2026-09-14 amendment: "nothing to leave" needs evidence (base `:506-522`), because a leaver
  at epoch 0 may already have granted a view the survivor installed.

The safety argument, as it stands: nothing about ballots moved. One view per epoch rests on
vote-once per epoch plus the proposer's joint majorities. The leaver's grant is an ordinary live
vote, given over a live link to a ballot that exists. Refusing a vote can only cost liveness.
V4-6 says so in one line: "Nothing else moved. Ballots, majorities, vote-once-per-epoch, escalation
past burns, view-on-admit, the gate: untouched."

V4-6 also recorded, as rejected or deferred: a two-member tie-break (one-directional, "two cannot
lose the primary"), an operator force (the unguarded hand-edited `boot.json` self-ballot already
exists), a witness ("needs a third failure domain, and a third bare copy already is one that also
holds data"), and a quorum-of-one gate. The stall across the leave window was filed as I-20, not
fixed: "the graceful leave is the only exit a two-member view has".

## §3 The pre-vote: the plan's design, and the schedule that broke it

The plan (§2.1, "The fix: the LEAVE carries the leaver's vote"):

- The LEAVE body becomes `{ e, m }`: the epoch the leaver would propose and its view without itself.
- A receiver records it as the leaver's GRANT for exactly that one change, keyed by the two member
  sets (old = `m` plus the leaver, new = `m`), never by the epoch number.
- When the lowest live member proposes exactly that view, the recorded grant counts as the leaver's
  old-majority vote, link or no link. The existing solo-commit check then commits at once.
- A PROPOSE whose members omit its own proposer is the lowest-member leaver's leave, and keeps the
  same record.
- The safety argument (fact 3): the leaver's recorded vote serves exactly ONE view, O∖L, and
  `majority` counts only voters inside the set it measures, so the vote can never help the NEW set.
  For two views to commit at one epoch, O∖L needs more than (n−1)/2 non-L voters and the other
  ballot at least ⌊n/2⌋ non-L voters; vote-once makes those sets disjoint, and
  ⌊n/2⌋ + ⌊(n−1)/2⌋ + 1 = n > n−1 available voters. "Holds for every n ≥ 2."

The build (`851796b`, R1 `build`) did this, plus one deviation it needed: the eviction gate counts a
kept vote too, because at n=2 "one live of two" never opens a ballot (R1 `build` deviations #0).

The first review broke it (R1 `review`, finding #0, blocker). The argument counts "n−1 non-leaver
voters", which assumes one leaver. With two leavers, each one's live vote goes to the other's
ballot while its kept vote counts at its own.

The schedule, four members `{aa, bb, cc, dd}` at epoch 1:

1. The aa-bb link drops. bb suspects aa but is still redialing it, so bb is the lowest live member
   from bb's point of view, and aa from aa's.
2. cc and dd both stop cleanly. Each sends LEAVE `{e: 2, m: view without me}` on every member link.
3. aa reads cc's LEAVE first. It proposes `{aa, bb, dd}` at 2, seeded with cc's kept vote.
4. bb reads dd's LEAVE first. It proposes `{aa, bb, cc}` at 2, seeded with dd's kept vote.
5. aa never asks cc, and bb never asks dd: the kept vote stands in.
6. dd reads aa's PROPOSE. It keeps dd in, and a knocking leaver may grant such a ballot (V4-6's
   rebase rule). dd grants aa. cc reads bb's PROPOSE and grants bb the same way.
7. aa's ballot: old votes aa, cc (kept), dd (live) = 3 of 4; new `{aa, bb, dd}`: aa, dd = 2 of 3.
   bb's ballot: bb, dd (kept), cc (live) = 3 of 4; new `{aa, bb, cc}`: bb, cc = 2 of 3.
8. Both commit. "aa holds epoch 2 aa,bb,dd, bb holds epoch 2 aa,bb,cc"; `votedFor` cc→bb, dd→aa.

The sim shape: `Sim(71)`, `cluster(4, heartbeatMs 50, delay [3,3])`, partition n01-n02 at 600 ms,
run to 900, then constant delays n01-n03 `[5,5]`, n01-n04 `[40,40]`, n02-n04 `[5,5]`, n02-n03
`[40,40]`, post `leave` to n03 and n04, run to 1200. The one-view-per-epoch monitor fires at event
634: "n02 installed a DIFFERENT view for epoch 2: [n01,n02,n03] vs [n01,n02,n04]".

The base on the same schedule: nothing commits, all four stay at epoch 1, violations `[]`. Each
leaver's one live vote goes to one ballot, and no ballot reaches 3 of 4.

The review fix (`eed1eaa`) made a knocking leaver refuse every ballot that keeps it in. That closed
this schedule and opened the next one (§4.3, H3).

## §4 The pledge, as it stands on the branch

### §4.1 The rule in words

The LEAVE is a **pledge**: the leaver's one vote at one epoch, given to one proposer before any
ballot exists. Everything else on the branch follows from making that vote behave like a live vote.

**Who pledges to whom.** The LEAVE body is `{ e, m, p }` (branch `:818`). `e` is the epoch the
leaver votes at: its view's epoch + 1, or one above a vote it already placed when that placing has
gone stale (branch `:794-796`). `m` is its view without itself. `p` is the proposer: the lowest
member the leaver does not suspect, does not know to be leaving, and does not see rejoining
(`#proposer`, branch `:330-331`). Knocking SPENDS the vote: `votedFor = { e, p, hash(m) }`, written
to disk before the frame leaves (branch `:814-817`). From then on the leaver grants `p` at `e` and
refuses everyone else at `e`, by the base's vote-once rule unchanged (branch `:564-566`, `:585`).

**The lowest member leaving pledges too.** On the base the lowest member proposes its own exit. On
the branch it pledges to the next member that stays, S, whenever it holds a live link to one
(branch `:799-811`), because a node that stays can wait for a stalled peer as long as it takes and
holds the committed view on disk, while a leaver dies after `LEAVE_TICKS` and takes the count with
it (branch banner `:60-72`). Only with no reachable stayer does it propose (branch `:801-808`). At
n=2 the lowest member therefore knocks like everyone else and the survivor proposes. Other leavers
that had pledged to the lowest member re-pledge one epoch up to S when its knock tells them it is
leaving (branch `:795-796`); S opens its ballot at the highest epoch its pledges name
(`#ballotEpoch`, branch `:824-828`) or lifts a ballot in flight when later pledges outnumber the
votes in hand (`#reoffer`, branch `:876-879`). A pledge to a member that stays is never moved, even
when that member goes quiet or dies (branch `:773-776`).

**When a pledge counts.** The receiver named `p` keeps it (`#pledges`, branch `:832-839`); every
receiver notes that the leaver wants out (`#leavers`, branch `:543`). When `p` proposes a ballot at
`e` that leaves the pledger out, the pledge is the pledger's grant, link or no link: it is seeded
into the ballot (branch `:928`), counted toward opening an eviction (branch `:395-397`), and counted
at once when it arrives for a ballot in flight (branch `:838`). A ballot commits only at its
proposer (`#count`, branch `:843-849`); the round-1 "alone-install" that committed at the granter
is gone.

**The ballot's shape.** A proposer's ballot leaves out every member known to want out, except a
pledger to itself whose link is live and who has not refused (`#shape`, branch `:856-862`). When the
members who did not ask to leave come down to the proposer alone, every leaver goes at once. A
leaver's refusal teaches no burn and the ballot is re-offered without it (branch `:606-611`,
`:868-884`). A leaver is read-only from the moment it knocks (gate reason `leaving`, branch `:310`),
takes no joins (branch `:505`) and proposes nothing but its own exit (branch `:331`, `:548`). A node
that has ANSWERED its leave never proposes a view that keeps it in (branch `:913`); one still
knocking may grant such a ballot and rebase, as in V4-6 (branch `:576-579`).

**What a restored leaver does.** A node restarted from disk whose durable vote is for a view that
omits itself, above its restored view, was leaving and may be OUT of a view it never saw
(`#voteWithoutMe`, branch `:289-291`). Its rejoin floor is that epoch (branch `:282`). While the
floor sits above its view (`#maybeOut`, branch `:295`) it leads nothing (no rejoin self-ballot,
branch `:443`; no eviction or join, because a rejoining node never opens either, branch `:364`,
`:501`), announces no view on admit (branch `:479`), answers no PULL (branch `:667`) and writes
nothing (branch `:311`). Since round 3 it still GRANTS (branch `:580-585`). The floor clears on a
view at or above it, on any view from the proposer it pledged to, or, for a ballot of its own, once
every other member of its restored view has answered below it (branch `:638-647`). The stayers lead
around a rejoiner: a member that keeps pulling a view at or above mine is skipped as the proposer
for two ticks after its last PULL (`#rejoiners`, branch `:333-338`, `:362`, `:670`).

**Housekeeping rules added on the way.** A late grant revives the last ballot that aged out while
my vote is still on exactly that ballot (branch `:619-622`). A returned leaver's pledge is void in
the ballot in flight and in the aged one (branch `:468-473`). The epoch a fresh ballot targets is
never below a ballot of my own (`#nextEpoch`, branch `:905-907`, see §8). Pledges, leavers,
rejoiners, answers and the aged ballot all clear on every install (branch `:687-691`).

Wire: LEAVE `{}` (old) → `{ e, m, p }`; PROPOSE unchanged `{ e, m, p }`; new journal kind `prevote`
(76). An old receiver ignores the new fields; a new receiver reading `{}` behaves as the base.

### §4.2 The safety argument the fixer gave

From R3 `fix3`'s DECISIONS draft, the paragraph "Why it is safe, in plain words":

> The pledge adds no vote, and nothing commits anywhere but at its proposer. Every node has one
> vote per epoch (votedFor, durable). The pledge is the leaver's vote at e, given to p — the only
> node allowed to count it, and the only node the leaver will grant at e live. A ballot commits
> ONLY at its proposer, from votes it alone counts for its one current ballot, so p counting a
> pledge for its ballot at e is the base's same-proposer re-grant. Two views at one epoch from an
> n-member view would need two old majorities, ⌊n/2⌋+1 each, from voters who each gave that epoch
> to one proposer: 2⌊n/2⌋+2 > n, impossible. A pledge, a live vote and a leaver's own proposal all
> fall under that sentence. A restart keeps votedFor and forgets the pledges it held: a forgotten
> pledge is a lost vote, never a second one.

And for restarts: "The read-only leaver and the non-leading restored leaver close the hole the
one-view-per-epoch rule does not see", with one class named as the base's own and not claimed
closed: "a stale stayer that never saw a committed view, cut from its majority, can count restored
stale members toward a ballot of the old view at a higher epoch".

Where it falls short, as re-check 3 showed (H11 below): the argument proves "no two views at ONE
epoch". The split it misses is two WRITABLE views at DIFFERENT epochs. That needs two things the
argument does not cover. First, a pledge counts for ANY ballot of `p` at `e` that leaves the
pledger out (branch `:396`, `:928`), including a ballot that also evicts a stayer or adds a joiner,
built after the pledger can no longer be reached. So a proposer cut off from everyone can commit a
view alone on votes from nodes that will never learn it did. Second, the guard against the
different-epoch split is the restored leaver's floor, and it can be defeated: `votedFor.h` can
include the leaver itself when a live same-proposer grant overwrote the pledge (branch `:587`
overwrites, `:814` never rewrites), so `#maybeOut` is false; and even when the floor holds, the
stale stayer's gate counts the restored leaver's link as a reachable member (branch `:315-316`) and
the restored leaver now grants above its floor (round 3).

### §4.3 The holes, one by one

For each: who found it, the schedule, what the base does on it, and whether it is closed on the
branch. "Closed" means a pin exists on the branch and the re-check that followed confirmed it.

#### H1. Two clean stops at n=4, the two lowest cut apart (first review, blocker) — closed

The schedule is §3's. Base: nothing commits. Closed by `eed1eaa` (the refusal rule), then by the
pledge (`7d5289a`): both leavers pledge to aa, bb can count neither, and cc and dd refuse bb at
epoch 2 by vote-once. Pinned as a four-node kernel test and as the sim seed-71 test; family 3 of the
sweep draws the shape (branch `sim/leave-sweep.test.ts:264-291`), and removing the `votedFor` write
in `#knockLeave` makes 8 of 15 reached shapes split (R3 `fix3` item #3).

#### H2. The kept vote not cleared on install (first review, major + minor) — closed

Schedule (R1 `review` finding #2, `drop-rule-jump`): bb keeps cc's LEAVE vote at `{aa,bb,cc}`@1.
bb misses `{aa,bb}`@2 and jumps straight to `{aa,bb,cc}`@3 (cc came back through aa). aa drops,
cc's redial chain gives up. bb proposes `{aa,bb}` at 4 counting cc's old vote: `proposals [[4,2]]`,
an eviction ballot against a member that came back. Base: no record exists, no such ballot opens.
Closed by `eed1eaa`: every install clears every record (branch `:687`). Pinned.

#### H3. The refusal rule wedges two clean stops at n=3 (R1 `recheck`, blocker) — closed

Schedule: `Sim(1)` and `Sim(2)`, `cluster(3, heartbeatMs 50, delay [3,3])`, run to 600, post
`leave` to two members at once (pairs n01+n02 and n02+n03), destroy each node when `sim.left` has
it, run 6000 ms more. On `915d027` all four runs print `left [[nA,false],[nB,false]]` and the
survivor at `epoch 1 [n01,n02,n03] {open:false, reason:'minority'}`, for good. No stalls, no cuts:
just Ctrl-C on two of three. Why: the ballot that takes L1 out is `{S, L2}`; its new-set majority
needs L2's grant, and L2 refuses because the ballot keeps it in. Base and `be78891`: both stops
clean, survivor at `epoch 3 [self] {open:true}`. Closed by the pledge (`7d5289a`): the second knock
makes the proposer re-offer its ballot as `{S}`, which both pledges complete at once. Pinned (kernel
and sim, seeds 1 and 2, both pairs).

#### H4. Two clean stops at n=2 with the lowest leaver lingering (R1 `recheck`, major) — closed

Schedule (two real Nodes, hand-driven): aa and bb at `{aa,bb}`@1. `aa.leave()` proposes `{bb}`@2.
`bb.leave()` knocks LEAVE `{e:2, m:[aa]}`. aa's PROPOSE reaches bb: bb keeps aa's record and refuses
(the refusal rule). bb's LEAVE reaches aa: kept, but aa has a ballot in flight. Eleven aa ticks:
`left(false)` at tick 5, the ballot ages out at tick 11 (`PROPOSAL_AGE` 10 > `LEAVE_TICKS` 4).
bb's buffered LEAVE then reaches aa; `onLeave` had no `leaving` guard, so aa proposes `{aa}`@2,
seeds it with bb's kept vote and installs at once. bb's link drops, the chain gives up, bb's
eviction counts aa's kept record and installs `{bb}`@2. `SPLIT: aa 2 {aa}, bb 2 {bb}`. Reach: the
kernel must keep stepping about six heartbeats after `left(false)`; the api tears down at once, the
sim keeps a node until the scenario destroys it (`sim/exec.ts:76`). Base and `be78891`: bb grants
aa's ballot, aa holds `{bb}`@2, bb stays at 1, no split. Closed by `7d5289a`: a node that has
answered its leave never proposes a view that keeps it in (branch `:913`). Pinned in three knock
orders.

#### H5. The alone-install commits two views at one epoch, in life (R2 `recheck1`, blocker) — closed

Round 1 let the member a lowest leaver's ballot left ALONE install it as it granted, away from the
proposer, with a memory-only pin `#aloneAt` on that epoch. Schedule (real Nodes, FIFO per link,
`inlife-alone.test.ts`): `{aa,bb,cc,dd}`@1. The aa-bb link drops; bb keeps dialing aa. Newcomer ee
joins through bb; bb opens `{aa,bb,cc,dd,ee}`@2; cc, dd, ee grant, their VOTEs are slow. aa's
eviction at 2 is refused by cc and dd, so aa learns burn 2. aa's eviction at 3 is granted by cc and
dd, VOTEs slow too. aa, cc and dd stop at once: cc and dd pledge to aa at 3; aa re-offers `{bb}`@3
alone with `v=[cc,dd]` (`#aloneAt`=3); the cut heals; bb commits view 2, then grants the alone
ballot and installs `{bb}`@3. View 2 reaches aa through cc before bb's VIEW 3 does; aa installs it
(the pin is reset in `install()`) and re-knocks. cc and dd re-pledge at 3 (their `votedFor` is
`{3, aa}`). aa proposes `{aa,bb,ee}`@3 seeded with both pledges; ee grants; aa installs.
`SPLITS ["epoch 3: {bb} vs {aa,bb,ee} (at aa)"]`. Both views were counted from the same voters by
the same proposer, so the 2⌊n/2⌋+2 > n arithmetic did not apply. Base: every node at view 2, no
split. Closed by `18c0e39`: the alone-install is removed; nothing installs but at the proposer.
Pinned ("a PROPOSE that leaves me ALONE is granted and nothing more").

#### H6. The alone-install pin is memory-only; a restart re-offers at the pinned epoch (R2 `recheck1`, blocker) — closed

Schedule (`restart-sim.test.ts`): `Sim(seed)`, `cluster(3, heartbeatMs 50, durable, delay [3,3])`,
run to 800, `leave` to n01 and n02. The moment n01 journals `propose(2, 1)` (the alone ballot
`{n03}`@2), n03 is partitioned from both. n03 installs `{n03}`@2 as it grants; its VOTE and VIEW die
at send. n01 and n02 time out (`left` false) and are restarted from disk while n03 stays cut off.
Seeds 1-5, all five: "one-view-per-epoch: n01 installed a DIFFERENT view for epoch 2: [n01,n02] vs
[n03]", both gates open. Mechanism: the restored `votedFor` is `{2, n01, 'n03'}`, `#aloneAt` is 0,
`#nextEpoch` returns 2, and n02 re-grants n01 at 2 as the same proposer. Base: no violation; n03
read-only at epoch 1; n01 and n02 go to `{n01,n02}`@2. Closed by `18c0e39` (no alone-install; the
restored-leaver floor). Pinned as a kernel mesh test and a sim test with real disks (seeds 1-3);
family 3's restart-split shape; removing the floor splits every reached shape (R3 `fix3` item #3).

#### H7. "The knocking lowest leaver takes its pledgers out first and stays in" strands survivors (R2 `recheck1`, blocker) — closed

Schedule (seed 157 of the reviewer's cut-and-rebirth generator, replayed under 20 sim seeds): n=5;
n05 stops; 120 ms later n01 (the lowest) and n04 stop; a 60 ms n01-n02 link; n01-n05 cut for
600 ms; no stall, no rejoin. Round 1: live 0 of 20, ending with n02 and n03 at `{n01,n02,n03,n05}`
gate `minority`. Without the cut, or with a 30 ms link, 20 of 20. Trace: n05's pledge never reaches
n01; the "stay in" round takes only n04 out and keeps n01; n01's own leave at 3 needs n02's grant
over the 60 ms link and does not finish inside `LEAVE_TICKS`; n02 and n03 are left with their
epoch-3 votes spent on the dead n01, at 2 of 4 for good. Base: 20 of 20 (n01 is removed first; n02
handles n04 and evicts n05). Seed 104 ends the same way by another route. The same extra round cost
time on 14 of 275 commonly-healed schedules: seed 97 heals in 653 ms on the base and 4859 ms on
round 1; seed 4 in 1409 vs 5959 ms. Closed by `18c0e39` (the lowest leaver pledges to a stayer) and
`02e6fe9` (a late grant revives an aged ballot): seed 157's shape heals 20 of 20 on every variant.

#### H8. A restored leaver that grants nothing freezes membership after one crash (R2 `recheck2`, blocker) — closed

Round 2 made a restored leaver refuse every ballot while it might be out. Schedule (sim, durable,
heartbeat 50, seeds 1 and 2): the crash of n01 (the lowest) and the leave of n03 (or n02) start at
the same instant; the leaver is torn down when its leave times out; restarted from disk 0.5, 3 or
25 s later; the run goes on for 60 s. Round 2: wedges in all 24 runs at n=3 and n=4, and at n=5 when
the leaver is n02 and comes back within 3 s (28 of 54). End state at n=3: `n02@1{n01,n02,n03} gate
open | n03@1{n01,n02,n03} rejoining floor=2`. n02 proposes the eviction at 2 and then at 3 six
times; n03 answers `vote 2 0` six times and `vote 3 0` 36 times. After that, one more clean stop is
unclean and one more crash closes the gate. Base: all 54 heal; n=3 ends `n02@2{n02,n03}` and
`n03@2{n02,n03}`, both writable. Closed by `7900e02` (a maybe-out restored leaver grants) and
`0aa9279` (the stayers lead around a member that keeps pulling): the fixer's 42-run probe heals 42
of 42, as the base does. Pinned (sim: n=3, 4, 5, back after 0.5, 3, 25 s).

#### H9. Seeds 469, 740, 1077 wedge where the base heals (R2 `recheck2`, major) — OPEN

Measured on the reviewer's cut-and-rebirth generator over seeds 1..1200: base live 1043, branch
1106, branch-only losses exactly 469, 740 and 1077, 0 violations (R3 `fix3`, confirmed by R3
`recheck3` checked #3).

Seed 1077: n=4; n01, n02, n03 leave (offsets 0, 0, 30 ms); cut n01-n04 from 0 to 600 ms; cut
n03-n04 from 20 to 320 ms; slow links of 20 and 60 ms. Branch end state: `n04 members
n01,n02,n03,n04 want n04; n04 gate minority`. Trace: n01 pledges n02@2 and n02 pledges n01@2 (each
learned the other was leaving one tick later); both bump: n01 to n03@3 then to its own ballot at 4
(no stayer reachable), n02 to n03@3 then n04@4; n03 pledges n02@2 then grants n01 live at 4; n04
hears only n02 (the cuts), holds one pledge at 4, proposes `{n01,n03,n04}`@4: 2 of 4 for good.
Base: n01 led `{n02,n03,n04}`@2 with n02's and n03's live grants (no vote from n04 needed), then
n02 led, then n03; all three leave clean.

Seed 740: n=4; n01 leaves at 0, n02 at 30, n04 at 120 ms; n01-n02 cut at 0; n02-n04 cut from 0 to
1500 ms; n02 reborn after 1.5 s. n01's pledge goes to n02 on a link the same-instant cut kills:
spent, never delivered, never taken back. n04 pledges to n02 across the cut. n03 ends holding
nothing; n02 and n03 end at view 1 with four members, minority. Base: n01 led with n03's and n04's
live grants; the reborn n02 later joined `{n02,n03,n04}`.

Seed 469 is the same family: n=4, three leavers including the lowest, a 100 ms cut n02-n04 at the
start, n03 reborn fresh under its uuid 500 ms after teardown. Not traced.

The fixer designed a fix and did not build it: a leaver follows the pledge chain at the SAME epoch
(bumping only on a cycle), plus a relay of a knock addressed to `p` by any member linked to `p`,
under a new verb. "It is a wire change and a retargeting redesign" (R3 `fix3` item #1).

#### H10. The aged-out ballot keeps a voided pledge (R2 `recheck2`, minor) — closed

Schedule (mesh, durable, n=4): dd leaves, pledges to aa at 2. aa proposes `{aa,bb,cc}`@2 with
votes `{aa, dd}`. bb grants but its VOTE is held back; cc never answers. After 12 ticks the ballot
ages out into `#aged`. dd times out, restarts from disk (floor 2), reconnects to aa; aa's view-on-
admit clears dd's floor; once dd is linked to bb and cc its gate is open at view 1. bb's held grant
reaches aa: `aa INSTALL 2 {aa,bb,cc}`, aa + dd's voided pledge + bb = 3 of 4. Without the pledge
it is 2 of 4. The window closes when aa's VIEW 2 reaches dd; no lasting split was found. Closed by
`ca43847`. Pinned.

#### H11. A cut-off proposer commits alone on pledges; restarted leavers give a stale stayer a second writable view (R3 `recheck3`, blocker, SAFETY) — OPEN

Three probes, all in `scratchpad/review-membership-r3/`, each run on both trees with the same
time-triggered schedule.

`evictsplit.test.ts` (n=3, durable, heartbeat 50):

1. n01-n02 is cut.
2. n03 stops cleanly and pledges its vote at epoch 2 to n01.
3. Three ms after n01 has read the LEAVE, n01-n03 is cut too.
4. n03 times out at +250 ms (`left` false) and is torn down. It comes back from its dir at +750 ms,
   linked to n02 only, with floor 2.
5. At +3950 ms n01's redial chains give up. It evicts both suspects using n03's pledge: proposals
   `[[1,3],[2,2],[2,1]]`, installs `[[1,3],[2,1]]`. n01@2`{n01}` is WRITABLE.
6. At the same moment n02@1`{n01,n02,n03}` is WRITABLE too: its gate counts the restored n03's
   link. n02 then commits `{n02,n03}`@3 with n03's grant above its floor.
7. Two writable views until the 20 s horizon, on seeds 1, 3 and 4.

Base: n01 cannot count a vote it never received live. It stays read-only at view 1 (proposals
`[[1,3],[2,2]]`). No split.

`isolate.test.ts` (n=3..5; one or two non-lowest leavers; n01 isolated 5, 10 or 30 ms after the
stops; leavers back after 0.3, 1.5 or 5 s, healed to everyone but n01): branch splits on 17 of 108
(n=3: 11, n=4: 4, n=5: 2; each 13 to 21 s long). Base: 0 of 108. The round-2 kernel (`7766fa5`):
22 of 108. So the hole predates round 3.

`joinsplit.test.ts` (n=3 plus a joiner): n06 joins through n01, which opens B1 =
`{n01,n02,n03,n06}`@2. n03 grants B1, then stops; n01-n03 is cut. `#reoffer` re-proposes B2 =
`{n01,n02,n06}`@2 seeded with n03's pledge (branch `:928`), and n06's grant completes it. n03 comes
back with floor 1, because its `votedFor.h` is `'n01,n02,n03,n06'`, which includes itself:
`#knockLeave` (branch `:814`) never rewrote `h`, and `onPropose` (branch `:587`) overwrote it. So
`#maybeOut` is false. n02 and n03 are writable at view 1 and commit `{n02,n03}`@3 while n01 evicts
n02 into `{n01,n06}`@3. The monitor fires, "one-view-per-epoch: n02 installed a DIFFERENT view for
epoch 3", on 5 of 5 seeds. Base: 0 of 5. The reviewer patched `h` to stay "without me" for one run:
n03 then restored with floor 2, but the split and the violation stayed, through round 3's grant
plus the stale stayer's gate.

The reports disagree here. The fixer's R3 ledger calls this "the base's own stale-majority class ...
round 3 is exactly the base here". The reviewer measured the base on the same schedules and found no
split on any of them: "The base does not split on any of these schedules." The reviewer has the
measurements; the fixer's claim was not measured by schedule.

#### H12. The n=3 crash twin: the one stayer crashes during a double clean stop (R3 `recheck3`, blocker, LIVENESS) — OPEN, not named on the branch

`crash2.test.ts`, 672 cases: crash offset −200, 0, 20 or 100 ms from the leaves; the crashed member
back after 2 s or never; leavers restarted after 0.4, 3 or 25 s; seeds 1 and 2. Branch live on 570.
The base heals 30 of the branch's 102 failures.

The 24 that matter (cases #144-149, #156-161, #192-197, #204-209): n=3; leavers n01+n02 with n03
crashed, or n02+n03 with n01 crashed; the crash at −200 or 0 ms; the crashed member never back.
Branch: `n01@1 rejoining floor=5; n02@1 rejoining floor=1` (#144), `floor=3; floor=3` (#156):
read-only for good. Base: 24 of 24 healed. With the crashed member back after 2 s, the branch heals.
The other 6 branch-only cases (#660-665, n=5, n05 crashes 100 ms after three leaves) are not a
regression: the branch finished the leave to `{n04,n05}` and then hit the documented crash-at-two
rule; the base was just slower.

Why: this is the crash twin of the restart split (H6). The restored leavers cannot tell "the stayer
died" from "the stayer committed alone and was cut off", so they lead nothing. The base never
reaches that shape. The fixer's own 42-run probe and sim pin are clean on both trees because they
only crash n01 with a single leaver. The branch banner (`:108-111`) says only a two-member view
stays read-only, "the base's crash-at-two class"; the reviewer: "Both claims are false."

#### Rules the fixer added without a reviewer finding (round 2)

Each came from a probe or a sweep trace during fix round 2 (R2 `fix2` summary): a leaver is
read-only from the moment it knocks (two knocking leavers whose proposer committed the view without
them are a majority of the OLD view); a restored node whose durable vote omits itself has its
rejoin floor at that epoch; `#nextEpoch` is never below a ballot of my own (§8); a late grant
revives a ballot that aged out (a stalled lowest stayer's round trip outlived `PROPOSAL_AGE`).
Round 1 also added: a pledger's refusal teaches no burn (a false burn escalated the proposer past
every pledge it held).

#### What is open on the branch, in one list

- H11, safety: an isolated proposer commits on pledges; restarted leavers and a stale stayer form a
  second writable view. 17 of 108 on `isolate`, 5 of 5 on `joinsplit`. Base: 0.
- H12, liveness: the n=3 crash twin, 24 cases. Base heals all 24.
- H9, liveness: seeds 469, 740, 1077 of 1200. Base heals all three.
- Family 2's nine not-live seeds of 100 (13, 31, 35, 44, 70, 75, 87: two-member pairs cut apart
  inside the leave window; 48, 56: n=3 with the survivor cut from a leaver whose vote it needs).
  The base loses the pair cuts too (branch `sim/leave-sweep.test.ts:201-206`).
- A nit: `onPull` marks a rejoiner when this node is itself maybe-out and the PULL is below its
  epoch, against what the banner says (R3 `recheck3` finding #4).
- The banner and the DECISIONS draft carry claims H11 and H12 refute (R3 `recheck3` finding #3).

## §5 The reviewer's "shortest path", as a proposal

From R3 `recheck3` notes, "Shortest path, one fix round":

1. A pledge counts only for a ballot that removes nobody but members who asked to leave, and adds
   nobody. The ballot's members must equal the LEAVE's `m` minus known leavers. Check it at the
   eviction count (branch `:396`) and at the seeding (branch `:928`, which covers `#reoffer`).
2. A pledge that rides on a vote already spent on the same proposer makes the durable vote say
   "without me" (branch `:814`), and a live same-proposer re-grant does not overwrite it (branch
   `:587`).
3. Pin `evictsplit` at n=3 and the join variant as sim tests (red on the branch, green after); add
   a sweep family in which the pledged proposer stays isolated while the leavers come back on the
   other side with a stale stayer present; re-run `isolate`, the three families and the
   cut-and-rebirth generator on both trees; re-measure the round-3 grant against them.
4. Name the n=3 crash twin honestly in the banner, STATUS and DECISIONS, for the owner to accept,
   or find a rule that heals it without reopening family 3.

My assessment.

Step 1 closes both named instances by construction. In `evictsplit`, `{n01}` removes n02, a stayer,
so n03's pledge may not seed it; n01 could only build `{n01,n02}`@2, whose new set needs n02's live
grant, and n02 is cut. In `joinsplit`, B2 adds n06, so the pledge may not seed it. Both commits
vanish.

Step 1 also does something larger: it takes the pledge back to the plan's original shape, "the kept
vote serves exactly ONE view, the old view without the leavers". The rounds widened that to "any
ballot of `p` at `e` that leaves the pledger out", and H11 lives in the widening. With step 1, a view
completed by pledges holds exactly the old view's stayers, so a proposer can be writable alone only
when every other member was a leaver, and then there is no stale stayer left to count the restored
leavers. That is an argument that the CLASS "isolated proposer plus stale stayer" closes, not just
the two instances. But it is an argument of the same kind each round offered, and each round's was
wrong somewhere. It has not been checked against every vote source (§9).

Two things step 1 does not touch. The different-epoch split still depends on the restored leaver's
floor holding, and step 2 is what makes it hold. Step 2 changes what a durable record means
(`votedFor.h` must say "without me" after a pledge), so a crash between the knock and the persist,
and boot records written by today's kernel, have to be argued again. And the base's own transient
remains: a stayer that missed a VIEW counts restored leavers as reachable members until an
epoch-2 stamp or a PULL reaches it (branch `:315-316`; base `:185-190`). The fixer named that class;
nobody measured it on the base by schedule.

Step 1 has a liveness price nobody has measured. A ballot that drops a leaver AND evicts a crashed
stayer in one step can no longer use the pledge. Reading the branch code, at n=3 with n02 leaving
(pledged to n01) and n03 crashing, n01's first ballot `{n01,n03}`@2 waits for n03 and ages out, and
once its redial chains give up the eviction path opens `{n01}`@2 and the pledge completes it
(branch `:386-399`, `:856-862`); under step 1 that second ballot is not seedable, and n01 waits for a
vote from n03 that never comes. The base wedges on that shape too (its leaver's live grant cannot
fill n03's new-set seat either), so it is a loss against round 3, not against the base. This is my
reading, not a measurement; it should be measured before step 1 is accepted.

Step 4 is a decision, not a fix. The pledge trades "a clean stop can wedge a two-member survivor"
for "a leaver that consented to a view it never saw may be read-only after a restart, until someone
tells it". At n=2 that is no worse than today. At n=3 (H12) it is new. The owner has to say whether
that trade is wanted.

In two sentences: the shortest path very likely closes H11's class, not only its instances, because
it restores "one pledge, one view"; but "very likely" is exactly what rounds 1, 2 and 3 said of their
own arguments, and the only way to know is the per-vote-source argument and the adversarial sweep on
the base first (§9), neither of which exists yet.

## §6 The liveness ledger

"Live" means every survivor (and every leaver that came back) ends in one view holding exactly them,
writable. "Safe" means no monitor fired and no two nodes ended writable in different views. Every
row is from the reports; the trees are the base (`43ea245`), round 1 (`02f65ed`), round 2
(`7766fa5`) and round 3 (`6de8eee`).

**Family 1: the fixer's generator.** n 2..5, one to three leavers at once, slow links, a stalled
survivor, lingering leavers, a join mid-leave. No cuts, no restarts. Seeds 1..1000.

| Tree | Live | Not live | Violations | Seeds |
|---|---|---|---|---|
| base | 691 | 309 | 0 | — |
| round 1 | 995 | 5 | 0 | base wins by timing: 506 (a 100 ms link vs the leaver's 250 ms window). Both lose: 87, 436, 459, 866 (three leavers at n≥4 with the lowest among them and a stalled survivor). |
| round 2 | 1000 | 0 | 0 | — |
| round 3 | 1000 | 0 | 0 | unchanged (R3 `fix3` deviation #4) |

Heal time on schedules both trees heal (round 2 vs base, 691 schedules): medians 580 ms (base) vs
600 ms; the branch slower by 200 ms or more on 17 (at most +1.9 s, seed 781), faster on 121; heals
through the eviction chain 16 vs the base's 111. Round 1 vs base on 275 schedules: slower on 14
(seed 97: 653 → 4859 ms; seed 4: 1409 → 5959 ms), faster on 10.

**The reviewer's cut-and-rebirth generator** (`sweep2.test.ts`). Random cuts and heals between
pairs during the leave window; leavers reborn fresh under the same uuid (no disk restart).

| Tree | 1..600 | 601..1200 | 1..1200 | Branch-only losses | Base-only losses |
|---|---|---|---|---|---|
| base | 516 | 527 | 1043 | — | — |
| round 1 | 552 | — | — | 104, 157 | — |
| round 2 | 551 | 555 | 1106 | 469; 740, 1077 | 36 (1..600); 30 (601..1200) |
| round 3 | 551 | 555 | 1106 | 469, 740, 1077 | 66 |

Violations: 0 on every tree. Seed 157 replayed under 20 sim seeds: round 1 live 0/20, base 20/20;
round 2 and 3: 20/20 on every variant.

**Family 2: in-tree, durable restarts from disk plus cuts** (branch `sim/leave-sweep.test.ts:139-196`).

| Tree | Seeds 1..100 | Branch-only losses | Base-only losses |
|---|---|---|---|
| base | 87 | — | 4, 15, 89, 94 |
| round 2 | 90 | 47 (restarted leaver whose vote is on a dead proposer) | — |
| round 3 | 91 (47 turned live) | known not live: 13, 31, 35, 44, 48, 56, 70, 75, 87 | — |

Round 3 over 1..300: 281 live. The re-check's run over 1..400: 372 live, 28 not live, 0 unsafe.

**Crash plus restart probes.**

| Probe | Shape | Runs | Base | Round 2 | Round 3 |
|---|---|---|---|---|---|
| R2 `recheck2` crash probe | n01 crashes at the instant of a clean stop; the leaver restarted from disk 0.5, 3, 25 s later; n=3, 4, 5; seeds 1, 2 | 54 | 54 heal | 28 wedge | — |
| fixer's `crash.test.ts` | the same shape, ROOT-parameterised | 42 | 42 | 14 ok / 28 bad | 42 |
| R3 `recheck3` `crash2.test.ts` | crash at −200/0/20/100 ms, crashed member back after 2 s or never, leavers back after 0.4/3/25 s | 672 | heals 30 of the branch's 102 failures | — | 570 live; the 24 n=3 crash-twin cases (H12) and 6 n=5 timing cases (#660-665, not a regression) |

**Safety probes (splits).** A split here is two nodes writable in different views, or a monitor firing.

| Probe | Base | Round 2 | Round 3 |
|---|---|---|---|
| `isolate.test.ts`, 108 schedules | 0 | 22 | 17 (n=3: 11, n=4: 4, n=5: 2) |
| `evictsplit.test.ts`, seeds 1-5 | no split | — | seeds 1, 3, 4 split to the 20 s horizon |
| `joinsplit.test.ts`, 5 seeds | 0 of 5 | — | 5 of 5, monitor fires at epoch 3 |
| R2 `recheck2` explorer over real Nodes, about 33,000 random schedules | splits on seeds 947 and 1855 (`RESTART=1 BURST=1`) | 0 | — |
| Family 3, 40 seeded shapes (branch `sim/leave-sweep.test.ts:234-331`) | the cut-apart kind is never reached (no pledges) | — | 0 splits; the knock not spending its vote splits 8 of 15 reached cut-apart shapes; no restored floor splits every restart-split shape |
| Family 1 (1000) and the 1200 cut-and-rebirth schedules | 0 | 0 | 0 |

The explorer's two base splits are the only evidence that the `#nextEpoch` double vote (§8) reaches
two committed views on the base. Their traces are not in the reports.

**The reverse direction, in one list**: schedules where the branch is live and the base is not.
Family 1: 309 of 1000 (every one the base loses). Cut-and-rebirth: 66 of 1200. Family 2: seeds 4,
15, 89, 94 of 100. The branch is better on breadth and worse on three named cut shapes (H9), one
crash shape (H12), and the safety class in H11.

## §7 The two-member crash question: options for the owner

The owner asked why fero says "three to be crash safe". The honest answer, given on 2026-10-08: at
two members a CRASH cannot be told from a cut cable. Each survivor sees the same thing, a link that
died. If both went on alone, a cut would give two writable copies of one resource, and nothing could
merge them. So the survivor stops taking writes: a write needs the majority side of the view, and
one of two is not a majority (README.md:39; base `:185-190`). A clean stop is different because the
leaver says so, and its vote finishes the change. The pledge, if it lands, makes a CLEAN scale-down
to one reliable; a crash at two still closes the gate. That is a separate decision. These are the
options. Each says what it gives, what it risks, and what it costs to build.

**(a) Keep the majority rule (today).** Gives: no split-brain by any schedule; one rule for every
n; what V4-6 decided. Risks: a crash of one of two leaves the survivor read-only until the crashed
member comes back (with `dir`) or an operator acts; "scale down to one" is true only for a clean
stop. Cost: nothing; the README already says it (line 39). Note that "two members plus `dir` on
both" already heals every crash that comes back: the restarted member rejoins and the pair goes on
(V4-6 context, "a pause-while-down cluster").

**(b) A static tie-break: the lowest uuid may continue alone when its partner is unreachable; the
higher may not.** Gives: a crash of the HIGHER member heals by itself, with no operator; the lower
evicts it unilaterally and is writable alone. Risks, spelled out. One: it heals half the crashes. A
crash of the lower member leaves the higher read-only exactly as today (V4-6: "one-directional,
heals only the light member's crash"; "two cannot lose the primary"). Two: under a cut, not a
crash, the lower goes on alone while the higher is alive. The higher is read-only (minority), so no
second writer, but it still serves reads of data that is now stale, and any client attached to it
cannot write until the cut heals. Three: when the cut heals the higher is an evictee and must
rejoin; writes it had committed as a row's owner before the cut, but had not yet replicated, meet
the lower's later writes on the same cells by last-writer-wins, as they would after a crash today.
Four: the rule must be mutual knowledge, since a tie-break only the lower applies while the higher
applies a different one is a fork; it belongs in the HELLO contract hash (plan §2.1, wave 3). Five:
it turns two members into "one member plus a hot spare that can follow but never take over", which
is less than "scale down to one". Cost: S to M. The eviction gate (base `:245`) gets a two-member
branch for the lowest; a DECISIONS line; README line 39 rewritten; a sim family for the cut case;
the contract hash row. Opt-in, so it must also be a config key (`api/config.ts` LEAVES row).

**(c) A witness or an external lock.** The directory (`127.0.0.1:3376`, `api/directory.ts:41`) is
loopback only, by design: it is on the same box as the members, so for two boxes it is not a third
failure domain, and for one box both members already share the box's fate. A file lock needs
storage both members can reach, which is a third thing to run, and a lease with an expiry, which
needs a clock assumption fero does not make today. Gives: with a real third domain, a crash of
either member heals by itself, and a cut resolves to whichever side holds the lease. Risks: a lost
or late lease renewal is a false crash; a third thing to deploy and to explain; V4-6 already
rejected a witness because "a third bare copy already is one that also holds data": a third member
IS a witness that also replicates. Cost: L. A lease protocol in the kernel's membership tick, a
shell seam for the lock, the sim must model the lease's clock, docs. Not recommended by V4-6 and
nothing since has changed that.

**(d) An operator command: "force alone".** Gives: the one party that CAN know whether the partner
is dead or cut, the operator, makes the call; nothing automatic; works for either member. The
unguarded form exists today: hand-edit `boot.json` to a one-member view and restart, and the rejoin
self-ballot commits it (base `:278-285`, `:109`; V4-6 "the unguarded self-ballot via a hand-edited
boot.json already exists"). Risks: a wrong call is a split by hand; if both members are forced, two
writable copies. A guard helps: refuse while any member link is admitted, bump the epoch past
everything known, journal it loudly, and let the other member learn it is evicted on heal. Cost: S
to M. A `fero.force` entry or a `--fero.<name>.alone` flag that writes a guarded boot record, a
kernel check, one example rung, a DECISIONS line. V4-6 called a guarded door "a last resort to file
if ever needed".

My view, in two sentences: keep (a) until the clean-stop design is settled, because (b) and the
pledge both make a node act on a vote it cannot confirm, and settling one before the other means
arguing safety twice. Of the rest, (d) is the only one that adds no automatic rule to the kernel,
and it already exists in an unguarded form.

**2026-10-09: could the directory be the third view? (the owner's question.)** A third vote is what
breaks a tie at two, but the box's `#directory` cannot cast it as it stands. One: it runs on one of
the members' boxes (`127.0.0.1:3376`, or a routable rendezvous on one of them since V4-27), so it
shares that box's fate and sides with it in a cut; it is a third failure domain only on a third
machine. Two: it keeps nothing on disk. An entry lives as long as its registrant's link, so "B is
not registered" is not proof that B is dead (a directory restart drops every entry until the
registrants come back), and a restarted directory forgets any answer it gave. Two members that
each read "my partner is gone" would both go on alone: the split this rule exists to prevent.
Three: it is unauthenticated and shared by every resource on its box, which may run different
secrets (DESIGN-DOOR §6), so a stranger could ask it or pose as it.

Fixing all three turns it into a member. The safe form of (c) is a **witness member**: a third
member of the resource, on a third machine, that votes in the ordinary ballot, keeps its vote on
disk (`dir`), holds the secret and stores no rows. With the view {A, B, W}, A and W are a
majority, so A stays writable when B crashes and votes B out by the ordinary rule; a cut goes to
whichever side reaches W. No lease, no clock and no new vote source: the lease is what made (c)
expensive above, and a new vote source is what sank the pledge. What it needs: a member role
that is never a holder (outside the ring, sent no records, never a client's feeder), its `dir`,
the door's secret, and a sim family for crashes and cuts at two plus a witness. V4-6 weighed a
witness against a third full member ("a third bare copy already is one that also holds data");
the owner's ask, scale down to one rather than three to be crash safe, makes a data-less third
vote on a small machine worth its own design. Not built; (a) holds until the owner decides.

## §8 What to salvage now, whatever is decided

### §8.1 The leave sweep harness (`sim/leave-sweep.test.ts`, 331 lines on the branch)

What it does. Three seeded families, each run to a horizon with the monitors on, and a verdict per
schedule (branch `:55-70`): no monitor fired, no two writable nodes in different views (the
quiet-point split check, `:48-52`), one epoch everywhere, every node in the wanted view with its
gate open, data converged. Family 1 (`:72-137`): n 2..5, one to three leavers, slow links, one
stalled survivor (a constant delay on every link of one node, lifted once every leaver is destroyed,
`:102-110`), lingering leavers, a join; 100 seeds in tree. Family 2 (`:139-196`): a durable cluster,
random pair cuts and heals, leavers torn down on `left` and restarted from their dirs; 100 seeds,
with a known-not-live list (`:206`). Family 3 (`:234-331`): the two shapes that split earlier drafts
(the n=4 cut-apart, the n=3 restart split), safety only, 40 seeds, with a "reached the shape" count
that must be at least 10 of each kind. About six seconds at low priority for all three.

What it proves and does not. The split check and the monitors are the safety half and are
tree-independent. The reviewer showed in round 2 that families 1 and 2 never fired under five rule
mutations; family 3 was added in round 3 and does go red when the knock stops spending the vote or
the restored floor is removed (R3 `fix3` item #3, confirmed R3 `recheck3` checked #5). The
reviewers' own generators in the scratchpad are more adversarial than the in-tree sweep: `sweep2`
(cuts and rebirth), `isolate`, `evictsplit`, `joinsplit`, `crash2`, the explorer over real Nodes.
They are ROOT-parameterised (`ROOT=<tree>`) and are the ones that found H9, H11 and H12.

To run it against the base as a safety-only guard, these must change:

- Family 1 asserts LIVE on every seed (`:217`). The base is live on 691 of 1000, so a base run needs
  either a per-tree known-not-live list or liveness dropped to a count that may only go up.
- Family 2's `KNOWN_NOT_LIVE_2` is the branch's list (`:206`); the base's differs (round 2 measured
  the base at 87 of 100, losing 4, 15, 89, 94 and not 47). Re-derive it on the base.
- Family 3 imports `JK.prevote` (`:38`, `:283`), a journal kind the base does not have, and its two
  shapes need a pledge to be reached at all: on the base the cut-apart kind is never reached and
  the restart-split kind needs n03 to commit alone, which the base never does. On the base family 3
  returns "not the shape" everywhere and fails its reached-count assertion (`:330`). Either skip
  family 3 on the base or make "never reached" a pass there.
- The stall workaround (`:102-110`) and the `#sever` trap (plan §2.1 fact 2; `sim/exec.ts` was not
  touched by any round) are inside the test and need nothing.
- The reviewers' generators should come in-tree with it, ROOT-free, as the harness §9 asks for.
  They are the ones with teeth.

The value of landing it first, on the base, is a measured floor: "the base is live on 691 of 1000
and safe on all" becomes a pin, so a future change's "never worse than the base" is a diff of two
runs, not a sentence. The round-3 banner had to retract exactly that sentence.

### §8.2 The `#nextEpoch` double vote the fixer says is latent in the base

The base (`:560-562`):

```ts
#nextEpoch(node: Node): number {
  return Math.max(this.view.epoch, this.#burned, this.votedFor.p === node.uuid ? 0 : this.votedFor.e) + 1
}
```

The branch (`:905-907`) replaces the `0` with `this.votedFor.e - 1`. The schedule, from the pin
the branch adds (`lane.diff`, "#nextEpoch never goes back below my own ballot"):

1. `{aa,bb,cc}` at epoch 1. bb proposes `{aa,bb,cc,dd}` at 2 (a join). aa grants: `votedFor =
   {2, bb}`.
2. cc dies. aa, the lowest live member, evicts it. `#nextEpoch` = max(1, 0, 2) + 1 = 3. aa
   proposes `{aa,bb}` at 3: `votedFor = {3, aa}`. aa's epoch-2 vote with bb is now forgotten, since
   `votedFor` remembers only the latest.
3. bb never votes. The ballot ages out after `PROPOSAL_AGE`.
4. aa proposes again. `#nextEpoch` = max(1, 0, **0**) + 1 = 2, because `votedFor.p` is aa. aa
   opens a ballot at 2 and self-votes. Its vote at 2 is now in two ballots: bb's and its own.

Could I confirm it from the diff and the base code: yes, the arithmetic above is the base's line
561 and the refusal in `#propose` (base `:568-571`) only refuses when `votedFor.p` is someone else.
Whether it reaches two COMMITTED views on the base: the only evidence is the reviewer's explorer,
which reports base splits on seeds 947 and 1855 with `RESTART=1 BURST=1` (R2 `recheck2` checked #3).
No trace of those two seeds is in the reports; the explorer is `scratchpad/review-membership-r2/
explore.test.ts` with `mesh.ts`. The step-4 ballot is at the same epoch as bb's; for both to commit
the two old majorities must be made of different voters apart from aa, which by my count needs
n ≥ 5 and bb's ballot still alive at bb. The shape is narrow; the explorer's two seeds are the only
evidence it is reachable, and they must be replayed on the base before this is called a base bug.

To land it: run the pin on the base (red), apply the one-line change (green), run the explorer on
the base at seeds 947 and 1855 before and after, then `npm test`, `npm run perf` and `sim:scale`,
because every trajectory where a node re-proposes after its own ballot aged out moves. Formation
never does that, so the 69,400-event pin should hold, but measure it.

### §8.3 A smaller one, outside the ask

`416d8ac` and `62d6089` (api only) print one stderr line when a clean stop goes unanswered:
`fero <name>: stopped before a survivor confirmed the leave — the others finish the change without
it`. The first review said it could ship on its own (R1 `review` notes). STATUS already lists
"show a failed leave at the api" as an option. The line's wording must not promise a vote.

## §9 How to continue: design first

Three rounds show the shape of the failure. Each fix was built from an argument about one vote
source, and each review found the hole in another vote source. The rounds added rules, and each new
rule needed its own argument. The way out is to write the argument once, for every source, before
code.

**Step 1: write the safety argument per vote source.** One page per source, each stating the
invariant it must keep and what a restart forgets. The invariant is not "one view per epoch" alone;
the sweep's split check says the real one: at no quiet point are two nodes writable in different
views, at any epochs. The sources:

- A live grant (`onPropose`): the base's argument, unchanged.
- A pledge: a vote given before the ballot exists, to a proposer who may build any ballot. The
  question is exactly which ballots it may complete (the reviewer's step 1 says: only the leavers'
  own view without them). This is the page H11 falls under.
- A leaver's own proposal (the lowest member on the base; on the branch only when no stayer is
  reachable), and what a lingering leaver may do after `left` (H4).
- A restart: what `votedFor` means when its `h` omits me; what a forgotten pledge means at the
  proposer and at the pledger; what a restored leaver may lead, grant, announce and write (H6, H8,
  H12); what a stale stayer's gate may count (H11).
- A commit the voter never sees: the pledge's defining trade. State plainly that a pledged leaver
  may be read-only after a restart until told, and decide whether that is accepted (H12) before any
  rule is written to soften it.

**Step 2: build the adversarial harness on the base first.** Bring the reviewers' generators
in-tree, ROOT-free: `sweep2` (cuts and rebirth), `isolate` (the isolated proposer), `evictsplit`
and `joinsplit` as pins, `crash2` (crash at every offset of the leave window, with restarts), the
explorer over real Nodes, plus the three families of §8.1 with per-tree known-not-live lists. Run it
on the base and record the numbers as the floor. Add the family the reviewer asked for: the pledged
proposer isolated while the leavers restart on the other side with a stale stayer. Every later
"never worse than the base" is then a diff.

**Step 3: pick the narrowest rule the argument supports, and only then build.** The candidates, in
order of how much they add:

- The zero-risk one, to evaluate first: no new vote source. The leaver keeps knocking while its
  link to a member is UP, bounded by a longer, configurable window (`LEAVE_TICKS` is a tune-table
  row in plan §2.1, "table only"). A stalled survivor's socket is open and its buffer holds the
  knock; the leaver only has to still be there when it wakes. The cost is a slow Ctrl-C while the
  survivor stalls, and a longer shell cap (`shell/runtime.ts:453`). It does not cover a survivor
  stalled longer than the window, but it makes the window the operator's choice and changes no
  ballot rule. The plan did not consider it; STATUS's "wait only while there is a member to ask" is
  its neighbour.
- The plan's pre-vote with its invariant restored: "one kept vote, one view" (the reviewer's step 1),
  plus the lowest leaver pledging to a stayer (so a proposer that stays holds the count), plus the
  restored-leaver floor with step 2's durable `h`. This is roughly the branch minus the widening.
- The branch as it stands plus the shortest path (§5).

Each candidate gets its page from step 1 before a line is written. Then pins that go red under
mutation (the round-3 A/B style), one logical change per commit, and two independent reviews. A
review that finds a hole in the argument sends the work back to step 1, not into a fix round.

**Size.** The plan sized I-20 at M (half a day). The actual was 19 commits in one day across one
build, five reviews and three fix rounds, and it is still open. The design-first path: step 1 about
a day of writing and one review of the argument; step 2 about a day (the generators exist, they
need to be made ROOT-free and given per-tree lists); step 3 one to two days of build with two
reviews. Call it L, a week of sessions, and expect the argument review to send something back once.
The crash-at-two decision (§7) is independent and can be made now.

**Before anything lands on `v4`**: `node site/strip.mjs` (every round left `site/lib` stale), STATUS
and DECISIONS by the integrator, and the branch's claims in its banner and its DECISIONS draft
corrected by H11 and H12 (R3 `recheck3` finding #3).

## §10 The argument per vote source, and the harness that checks it (2026-10-10; §9 steps 1 and 2)

**The summary, in ten lines.**

1. The rule to keep is the sweep's split check, not "one view per epoch": at no quiet point are
   two nodes writable in different views, at any epochs (§10.1).
2. Today's kernel keeps it for every ballot over the CURRENT view that changes one member, by
   arithmetic: the new view's writable majority and a stale majority of the old view must share a
   voter, and that voter is linked to the proposer and learns the view. A ballot over an OLDER view
   is not covered even when it changes one member of that view: the kept ballot (line 3) does, and
   splits (§10.2).
3. Today's kernel BREAKS it, and the argument has found THREE splits in it. Two are the one ballot
   that changes two members at once: the eviction of two suspects at n=5 (two or three at n=7,
   three at n=8; n=6 has no such shape, §10.2). A voter cut or crashed right after its grant keeps
   the old view, and the two "suspects" are a majority of it with him. Two views commit at one
   epoch and both sides write. Measured: 4 of 5 seeds, cut and crash, pinned (`evictTwo`, §10.2,
   §10.8), and the same 4 of 5 when the stale voter is not the far side's lowest member and only
   GRANTS (`evictTwoB`). The third is a ballot KEPT across an install (STATUS's "built on an older
   view" line, `:477`): the view it commits is two members apart from the view it was kept across,
   and at n=4 the loser of a duel commits `{aa,cc,dd}`@3 over view 1 after installing
   `{bb,cc,dd}`@2 — two writable views at the quiet point, then two views at epoch 4 (`keptBallot`,
   one fixed schedule, pinned red; §10.2). The second draft of this page called that shape
   undrawn; the third review drew it.
4. The root of 3 and of every hole the three rounds found is the same: a node acts on a view BELOW
   a vote it has spent. The gate (`kernel/membership.ts:191-202`) and the proposer rule (`:205`)
   never read `votedFor`; the grant rule (`:400`) reads it only to refuse a second proposer at the
   SAME epoch, so the vote is spent again one epoch up, on a ballot over the older view
   (`evictTwoB`, `keptBallot`). The pledge makes this the normal case (§10.3, §10.6); a restart
   makes it durable (§10.5). The rule that closes it has three parts — gate, lead, GRANT — and
   EVERY part needs a release nobody has designed: a vote for a ballot that failed, with nothing
   coming to supersede it, is a closed gate for good, and a ballot fails in a healthy cluster
   whenever a member flaps or the proposer crashes mid-ballot. Under the rule as drafted, two parts
   or three, that leaves every live member read-only for good; the base heals both (§10.2).
5. A pledge may complete at most one change: the pledger's own view minus the leavers, nothing
   else. Any wider use counts a vote for a change the voter never consented to (§10.3; H11). Even
   so restricted it is UNSAFE with two or more pledgers at n ≥ 5 until a stale stayer's gate stops
   counting a member that sits on a vote above its view (§10.5): the leaver's own read-only gate does
   not stop it being COUNTED. Pinned on today's kernel as `pledgeTwo`, red on the round-3 kernel 5
   of 5 (§10.3, §10.8).
6. A pledged leaver that times out and restarts may be read-only until a view at or above its
   vote reaches it. At n=3 with the one stayer dead that is for good (H12). I recommend accepting
   it only with the knock window first (§10.6).
7. The zero-risk candidate adds no vote source: the leaver keeps knocking while a member link is
   up, for a window the operator sets. It changes no ballot rule and covers a survivor stalled
   shorter than the window. Cost: a slow Ctrl-C while the survivor stalls, a longer shell cap, one
   config key (§10.7). Build it first.
8. The harness exists (`sim/leave-harness.ts`, its test): the reviewers' generators rebuilt
   in-tree, pinned on today's kernel as the floor; every hole H1, H3, H7, H9, H11 and H12 goes red
   on the kernel that had it, and `pledgeTwo` goes red on round 3, the family a restricted pledge
   fails (§10.8). Today's kernel's three holes are red on the base: `evictTwo`, `evictTwoB` and
   `keptBallot`. What the candidate rule costs is pinned too: `flapDuringBallot` and
   `proposerCrash` are writable everywhere on the base and read-only everywhere under the rule.
9. The kernel has not changed in this step. STATUS gains one line for the two-evictee split, and
   its "ballot built on an older view" line becomes a bug line of today's kernel: the kept ballot
   breaks one view per epoch at n=4 (§10.2).
10. Step 3 is now: the knock window; then, before any pledge, the page for "a vote above my view"
    — gate, lead and GRANT, what a stale stayer's gate may count, and the RELEASE for a vote whose
    ballot failed, which must work with the proposer dead — which closes §10.2's three holes on the
    base and is what the restricted pledge needs to be safe at all (§10.9). The rule is not
    finished: without the release it trades three splits for a cluster that freezes on one flap
    (§10.2).

### §10.1 The invariant, and what a restart forgets

A node is **writable** when `gate()` says so (`kernel/membership.ts:191-202`): not epoch-stale, not
rejoining, a member of its committed view, and linked to a majority of that view's members (`:196-199`;
open genesis is writable with no view, `:194`). The **split check** (`sim/leave-sweep.ts:22-26`) reads
every node's gate at a quiet point and fails when two writable nodes hold different `epoch:members`.
The per-event monitor (`sim/monitors.ts:38-52`) fails only when two nodes install different members
at ONE epoch. The split check sees more: a majority of an OLD view still writable beside the new view.

Why the invariant holds when it holds. A view at epoch e+1 commits at its proposer when a majority of
the OLD set and a majority of the NEW set have granted (`:424-427`, `:604`); the old set is the
proposer's committed view when the ballot opened (`:601`). Every granter spent its vote (`:402`) and
is, at that moment, linked to the proposer (a VOTE travels the link the PROPOSE came on, `:408`). A
majority of view e that is still writable at view e must, by counting, include one of those granters
whenever the two majorities cannot be disjoint. That granter is linked to the proposer, the proposer
floods the view on install (`:495`), and any later link announces it (`:319`); the granter installs it
(`:445`) and is no longer at view e. So the invariant rests on three things: the count, the link, and
the VIEW arriving. §10.2 shows where the count fails. The link can die between the VOTE and the VIEW
(one round trip; the sim's `severOnFrame`), and then the VIEW never arrives: every hole below has a
voter who voted and never learned the outcome.

What a restart keeps and forgets (`:172-183`). Kept: the committed view, as a boot view with the rejoin
floor at its epoch (`:178`), and `votedFor` (`:182`). Forgotten: the ballot in flight, the burn, the
suspects, `leaving`, and, on the branch, every pledge held. The floor clears on ANY view at or above it
from a live peer, including an EQUAL-epoch view from a peer as stale as the restored node (`:434-437`).
So a restart turns "a voter that missed the VIEW" into a durable fact: the node comes back holding the
old view and a vote above it, and nothing in the gate reads the vote.

### §10.2 Source 1: a live grant (`onPropose`) — the base's argument, and where it stops

The rule (`:396-400`): grant when the epoch is above my view, I am not a leaver being put back in,
my gate is not stale (or the ballot takes me out), and my vote at that epoch is unspent or already on
this proposer. Proposing spends my own vote too (`:594-600`). A proposer counts only VOTEs that echo its
own members hash (`:421`) and installs only its own ballot (`:424-427`).

**One view per epoch**, the base's argument, written down: two ballots at epoch e by two proposers
over the SAME old view O each need a majority of O. Vote-once gives every member of O one grant at e
(the last clause of `:400`; `:594` for the proposer's own). Two majorities of O share a member; it
granted one of them. So at most one commits. This is sound, and it is what the banner (`:13-37`) says.

**The writable split at different epochs** is the invariant §10.1 names, and the argument above does
not reach it. Two cases.

(a) One member changes (a leave, `:371`; a join, `:358`; an eviction of one suspect, `:259`). Let the
old view have n members and the new one n−1 (or n+1 with the joiner J). A writable stale majority of
the old view needs ⌊n/2⌋+1 members at view e. A writable new-view majority needs ⌊(n−1)/2⌋+1 of the
new view's members, all of them old members. ⌊n/2⌋+1 + ⌊(n−1)/2⌋+1 = n+1 > n: the two sets share a
member; being in the new view's writable majority it is linked to the new view's holders and learns
it. For the join: ⌊(n+1)/2⌋+1 reachable new members, at most one of them J, so at least ⌊(n+1)/2⌋ old
members, plus ⌊n/2⌋+1 stale ones: ⌊(n+1)/2⌋ + ⌊n/2⌋ + 1 = n+1 > n again. Holds for every n.

That is the adjacent pair, view e against e+1. Across a chain the count alone is not enough: from
five to four to three, a stale majority of view e (3 of 5) and a writable majority of view e+2 (2 of
3) need only five nodes. The step that closes the chain is the order on the link. A PROPOSE goes out
only on admitted links (`:620`), and on every such link the proposer's committed view went ahead of
it: the flood on install (`:495`) on a link that was up then, the view-on-admit (`:319`) on one
admitted since; a re-offer (`:270`) is later still. Links are FIFO, and `onView` installs before the
next frame is read (`:445`). So every granter of a ballot over view V has installed V, or a higher
one, before it reads the PROPOSE; and a view never goes down: a restart keeps the committed view
(`:178`) and comes back at it or above (read-only until confirmed, never lower). The ballot for e+2
is over view e+1's members and needs a majority of them, ⌊(n−1)/2⌋+1 nodes that hold e+1 or above
for good. That leaves at most n − ⌊(n−1)/2⌋ − 1 < ⌊n/2⌋+1 nodes at view e: no majority of view e can
still be there. (When e+1 was a join the majority is ⌊(n+1)/2⌋+1, at most one of them the joiner,
which is never a member of view e and never counts toward its majority, `:198`: ⌊n/2⌋ old members
are left at e, again short of one.) The same for every later view. So a chain of one-member changes reduces to its
adjacent pairs, and each pair is closed by the count above. This step is what a ballot over an
OLDER view breaks (the kept ballot, below): its granters hold only that older view or above.

(b) Two or more members leave in one ballot. The only such ballot on today's kernel is the eviction
branch, which drops EVERY suspect whose redial chain has given up in one proposal (`:256-259`), and
opens only while the live members are a majority of the view (`:257`: `live × 2 > n`, so k < n/2).
With k evictees the count is ⌊(n−k)/2⌋+1 + ⌊n/2⌋+1 ≤ n. Under the guard that is first true at n=5
with k=2 (2 + 3 = 5); n=6 has no such shape (k=2 gives 3 + 4 = 7 > 6, and k=3 cannot open: 3 live
of 6 is not a majority); then n=7 with k=2 or 3 (3 + 4 = 7) and n=8 with k=3 (3 + 5 = 8). The two
majorities can be disjoint, and then no granter need ever learn the view.

The schedule (`sim/leave-harness.ts`, `evictTwo`, pinned in `sim/leave-harness.test.ts`; the trace
below is the base's journals on seed 1, the cut variant): five members at view 1. n04 and n05 are cut from n01 and n02 but stay linked to n03. n01's chains to them
give up; n01 proposes `{n01,n02,n03}`@2 (`:259`); n02 and n03 grant; n01 installs. The VIEW to n03
dies on the link (or n03 crashes on its grant and comes back from its dir 500 ms later linked to n04
and n05). n03 keeps view 1 and a vote at 2. In view 1, n04 and n05 are live members to it and n01
and n02 are suspects; n03 is the lowest live member (`:205-207`), `live.length * 2 > 5` (`:257`), so
when its chains give up it proposes `{n02,n03,n04,n05}`@3 (one chain gave up first) and n04 and n05
grant (their votes at 3 are unspent). Meanwhile n01 evicts n03: `{n01,n02}`@3. The monitor fires:
"n03 installed a DIFFERENT view for epoch 3". n03 then evicts n02: `{n03,n04,n05}`@4. End state:
`n01@3{n01,n02}` and `n03@4{n03,n04,n05}`, both writable, until the cut heals. Measured on today's
kernel: seeds 1, 2, 4 and 5 of 5, cut and crash; the one-evictee control (n05 alone cut) never splits.
The parked branch: the same 4 of 5.

**Two ballots at one epoch over DIFFERENT old views.** The one-view-per-epoch argument above takes
one old view O. Two ways exist for two ballots at e to carry different old sets, and the trace above
is one of them. (i) A STALE PROPOSER: a member that missed a VIEW holds the old view as its committed
one and leads a ballot over it, the lowest live member in its own eyes (`:205`, `:257`): `evictTwo`'s
n03, over view 1 at epoch 3, while n01 is over view 2. (ii) A KEPT BALLOT: `install()` keeps a
proposal whose epoch is above the view it installs (`:477`); `#proposal.old` was fixed when the
ballot opened (`:601`), and a PROPOSE carries no base epoch (`:614`), so a voter cannot tell. The
proposer then counts a majority of a set it no longer holds. That is STATUS's "a ballot built on an
older view still commits" line, the variant of the double-vote mesh scenario
(`kernel/membership.test.ts`, 2026-10-08) it describes: aa's `{aa,cc}`@3 over view 1 commits after
view 2 (`{aa,bb,cc,ee}`) has landed at aa, with 2 of view 2's four members, dropping ee, which its
old set never held.
The two are different mechanisms: in (i) no node keeps a ballot across an install (n03's journal reads
`vote(2,1,n01) PROPOSE(3,4) INSTALL(3,4)`; its ballot is over the view it holds); in (ii) the
proposer's own view has moved under its ballot. The count is the same for both. Let the old sets be
O1 and O2. Vote-once still gives every node one grant at e, so both commit only when a majority of
O1 and a majority of O2 are disjoint inside O1 ∪ O2. One member apart (one left, joined or was
evicted between them) they cannot be: ⌊n/2⌋+1 + ⌊(n−1)/2⌋+1 = n+1 > n, the count of (a). Two apart
they can: `evictTwo`'s view 1 (five) against view 2 (three), 3 + 2 = 5. So one view per epoch holds
for a stale proposer and for a kept ballot on every one-member path, and fails on a two-member one.
The mesh scenario is a one-member path (view 1 to 2 added ee) and settles to one view, as the STATUS
line says; `evictTwo` is a two-member path and does not. STATUS gains one line for the two-evictee
split, and its kept-ballot line becomes a bug line: the kept ballot has a two-member path of its
own, below.

The kept ballot has a second shape of its own, by the same count, and today's kernel SPLITS on it
(the third 2026-10-10 review's probe; `keptBallot` in the harness, one fixed schedule on real
Nodes, pinned red). The view it commits is its old view changed by one member; the view it was kept
across is that same old view changed by another. Against each other they can be TWO members apart,
so the writable split of (a) is not forbidden by the count between them. At n=4: aa and bb lose
each other and duel at 2; bb wins `{bb,cc,dd}`@2 on cc's and dd's grants; aa, refused at 2, ages
its ballot out (`:264-267`) and escalates past the burn to `{aa,cc,dd}`@3 (`:587`) over view 1,
because bb's VIEW has not reached it. bb's VIEW lands at cc and dd first; they install view 2 and
then read aa's PROPOSE@3 — above their view, so they grant it (`:400`; the frame carries no base
epoch). aa reads cc's VIEW 2, installs it evicted and KEEPS the ballot (`:477` drops only a ballot
at or below the view), then cc's VOTE — its own vote and cc's are 2 of view 1's four, not a
majority (`majority()`, `:121`), so nothing commits yet. cc is cut from aa and dd, bb from dd; dd's
VOTE lands, aa counts 3 of view 1's four (itself, cc and dd; its old set, `:601`) and 3 of 3 new,
and installs `{aa,cc,dd}`@3. The
quiet point: `aa@3{aa,cc,dd} dd@3{aa,cc,dd}` writable beside `bb@2{bb,cc,dd} cc@2{bb,cc,dd}`
writable — one view per epoch intact, so the recorder sees nothing. Once the chains give up, bb
evicts dd (`{bb,cc}`@4) and aa evicts cc (`{aa,dd}`@4): two views at epoch 4, both writable. So
the kept-ballot STATUS line is a bug line of today's kernel, not a "settles to one view" note: the
mesh scenario it describes is the one-member path and is safe (3 of 4 at view 2 and 2 of 2 at view
3 need five of four); the two-member path is not. No random family had drawn it (the explorer,
1..2000 and the quiet 2001..2300, and every family of §10.8): it needs the escalation to open
before the VIEW lands and two cuts inside one round trip. Which parts of the candidate rule close
it, measured on the scratch kernels: gate and lead-nothing alone clear the quiet point (cc's gate
shuts on its vote at 3 above view 2, so bb is 1 of 3 and read-only) but NOT the end state — cc,
still holding that vote, grants bb's `{bb,cc}`@4 and the epoch-4 split stands; with the grant
clause (α) it ends safe, `aa@4{aa,dd}` writable, bb and cc read-only for good (`minority`,
`stale-vote`). Form (β) would close it at the voter without (α): cc and dd refuse a ballot whose
base epoch is 1 while they hold view 2. Either way the rule for it is §10.9 step 2's, and no
ballot should outlive an install (a leaver's already does not, `:480`).

Where the argument stops, in one sentence: **a voter that has spent a vote above its view may be
acting on a view that no longer holds, and nothing in the base reads that vote as a warning**: not
the gate (`:196-199` counts links), not the proposer rule (`:205`), not the eviction count (`:257`),
not the floor on a restart (`:178`, cleared at an equal epoch `:434`), and not the grant rule
either — `:400` reads `votedFor` only to refuse a second proposer at the SAME epoch, so the same
vote is spent again one epoch up, on a ballot over the older view (`evictTwoB`, below). The branch's
`#maybeOut` (branch `:289-295`) is this rule applied to one case, a vote for a view WITHOUT me;
n03's vote is for a view WITH it, so round 3 has the same 4 of 5.

**The candidate rule for §10.9 step 2, and the hole the second review found in it.** The first
draft of this page proposed two parts — a node whose `votedFor.e` is above its view treats itself as
stale: gate closed, a targeted pull (as `epochStale` does, `:282-289`), no ballot led, until a view
at or above that epoch installs — and said they cover (b) in life and after a restart. They do not.
`evictTwoB` (the second 2026-10-10 review's probe, now in the harness beside `evictTwo`): n=5; {n02,
n03} cut from n01, n04 and n05, so neither can open a ballot (two of five live, `:257`); n01 evicts
both on n04's and n05's grants, `{n01,n04,n05}`@2; n04 CRASHES on its grant and comes back from its
dir 500 ms later linked to n02 and n03 only — view 1, a vote at 2 for n01 above it. The far side's
lowest live member is n02, which never voted at 2. It evicts n01 and n05 at 2; n04 refuses (`:400`,
its vote at 2 is on n01) and its `ve` teaches n02 the burn (`:416`); n02 escalates to 3 (`:587`);
and n04 GRANTS at 3 while it still holds view 1 (`:400`: 3 is above its view and above its vote).
n01 meanwhile evicts n04 at 3. Today's kernel: seeds 1, 2, 4 and 5 of 5, `n01@3{n01,n05}` beside
`n02@4{n02,n03,n04}`, the monitor firing at 3. "Gate closed, lead nothing" never fires at n02,
which holds nothing above its view, and does not stop n04's grant. Built faithfully on a scratch
kernel (gate closed and `#propose` returning while `votedFor.e > view.epoch` and the vote is not my
own; a stayer's gate skipping a member that sits on a vote above my view, through a sim-only
registry standing in for the wire change), the two parts turn `evictTwo` green on 10 of 10 and the
k=1 control, and leave `evictTwoB` red on 1, 2, 4 and 5, exactly as on the base. So the rule has
THREE parts, and the third is about the grant:

- (α) at the voter, by its own vote: while my vote sits above my view I grant no NEW ballot that
  keeps me in — not another proposer's, not the same proposer's at another epoch. The re-grant to
  the same proposer at the same epoch stays (it heals a lost VOTE, banner `:19-23`, and it is what
  lets H8's and H12's shapes heal below). The probe also kept a ballot that takes a LEAVER out
  grantable (`leavingOut`, `:397-398`: only a node that is itself leaving; a non-leaver holding a
  vote above its view refuses a ballot that takes it out, too); that exception is not argued here.
  And a vote that is my OWN — an open or aged-out ballot of mine — is exempt too, as for the gate
  and lead parts (the probe's clause reads `votedFor.p !== node.uuid`): a proposer holding its own
  ballot above its view still grants other proposers. Not argued here either. With (α) the scratch
  kernel closes `evictTwoB`: 0 of 5.
- (β) at the voter, by the ballot: a PROPOSE carries the epoch of the view it is over
  (`#proposal.old` is fixed at `:601`; the frame has no field for it, `:614`), and a voter refuses
  any ballot whose base is below its vote's epoch. For a stale proposer (β) says what (α) says; it
  also refuses the KEPT ballot (ii) at every voter that has moved on, so "no ballot outlives an
  install" needs no rule at the proposer. It is a wire change, the same class as what a stale
  stayer's gate needs (§10.5).

What the rule costs, measured on two scratch kernels — the three parts with (α), and the two parts
alone (gate and lead-nothing, the grant line deleted) — every family of §10.8 and the in-tree sweep
run unchanged. Safety with three parts: 0 splits, 0 violations everywhere, `evictTwo`, `evictTwoB`
and `keptBallot` included. Liveness, on the families that were already there, kernel by kernel.
The same on BOTH kernels: `pledgeTwo`'s far side settles on 0 of 5 (the base 5 of 5 — n03, n04 and
n05 all hold a vote at 2 above view 1, so nobody may lead); the isolate grid loses 36 of 108, every
`isolate = 5 ms` case (the VOTEs leave and die on the cut; the far side, the old view's majority,
holds votes above its view and nobody leads it), the seeded isolate family 11 of 50; the sweep's
family 1 three (17, 52, 83); the crash grid 4 of 96 (#8, #10, #24, #26). Where the grant part (α)
costs MORE than gate and lead-nothing alone: `evictsplit` and `joinsplit` 0 of 10 with three parts
(the base 10 of 10; with two parts they still settle: n02 never voted and leads, and n03 grants);
`rebirth` 6 of 100 with three parts (seeds 7, 51, 59, 69, 83, 96), 4 with two (59, 69, 83, 96; 7
and 51 heal without the grant line); the sweep's family 2 four with three parts (46, 47, 65, 90),
three with two (46, 47, 65; 90 heals without the grant line). The crash grid's four are NOT H12's.
#8, #10, #24 and #26 are the n=3 two-leaver cases with the stayer crashed at −200 or 0 ms and BACK
after 2 s: the
lowest leaver's exit ballot at 2 failed (one of two new-set votes), both leavers restart, the stayer
returns, all three are linked at view 1 again, and nothing ever proposes a view at 2 or above — the
other leaver holds its vote at 2 for good, `gate stale-vote`, read-only beside two writable
members. H12's four (#9, #11, #25, #27, the stayer never back) still heal: the lowest leaver, now
the lowest live, re-proposes at 2 and the same-proposer re-grant is allowed. H8's shape heals the
same way. So neither H8 nor H12 comes back; what comes is a new class.

**The second draft of this section put that class in the wrong place and made it too small** (the
third 2026-10-10 review). It said the GRANT part costs the release, and counted the cost as "a
read-only member in the four crash cases, the 36 isolate cases, and the far side of every cut
inside one round trip". Both are wrong. The gate and lead parts need the release just as much, and
the cost is not one member on the far side of a cut: it is EVERY live member of a healthy cluster,
for good, with no cut anywhere. Two shapes, now in the harness (§10.8), each one fixed schedule on
real Nodes, measured on the base and on both scratch kernels:

- `flapDuringBallot`: five members, all linked but aa–ee. aa suspects ee, its chain gives up, it
  proposes `{aa,bb,cc,dd}`@2; bb's VOTE lands (2 of the 3 it needs). ee comes back, and aa
  ABANDONS the ballot (`:240`: the suspect returned). Every frame lands, everyone ticks, forty
  rounds. The base: all five writable at view 1; bb, cc and dd each hold a vote at 2 for aa above
  their view, and nothing reads it. Both candidate kernels: all five read-only for good — bb, cc
  and dd `stale-vote`; aa and ee `minority`, because the stayer's-gate skip of §10.5 drops the
  three granters from every count. aa holds its own vote and may lead, but there is nothing to
  propose: no member is suspect, and a ballot opens only on a suspect, a knock or a join (`:259`,
  `:371`, `:358`); nothing will ever propose a view at 2 or above.
- `proposerCrash`: the same ballot; bb and cc grant, and aa dies for good — with the ballot open
  (the VOTEs never reach it), or after it installed `{aa,bb,cc,dd}`@2 and before its VIEW left.
  The base: the four re-form, `{bb,cc,dd,ee}`@3, writable. Both candidate kernels: all four
  read-only for good — bb and cc `stale-vote`, dd and ee `minority` — with every link up.

So the release is needed by parts 1 and 2, not only by the grant: the two-part rule freezes exactly
as the three-part one does. The class covers a flap and a proposer crash, the two most ordinary
failures a ballot can meet, not only cuts inside one round trip. And the one release the second
draft named — the vote's proposer, linked, reporting a committed epoch below the vote — can never
fire in the proposer-crash case: there is no proposer. The committed variant adds one more fact: the
base's re-form there is SAFE, because the dead proposer's ballot changed ONE member of the view
every voter held, and (a)'s count protects that. That suggests the hold may need to bind only for
ballots that change two or more members, the ones the count does not protect — a design question
for §10.9 step 2, not a rule argued here, and one with a catch, below.

That class is the open question of the rule, and the page for step 2 must answer it before the rule
is built: **a vote above my view, for a ballot that did not commit, with nothing coming to supersede
it, is a closed gate for good — and under the rule as drafted it closes every gate in a healthy
cluster on one flap.** The base's alarmed release (`:285-288`: pull five ticks, then reopen with a
journal alarm, the liveness-over-safety choice on record, banner `:85-89`) is the wrong answer here
— it would reopen `evictTwoB`'s far side at view 1 with 3 of 5 links and bring the split back. The
step-2 page has to find a release that (1) fires with the proposer dead, (2) fires when the
proposer abandoned the ballot, and (3) never fires while a majority of the old view may still
commit the vote it holds. The candidates it should weigh, none of them argued here: the proposer
reporting the ballot uncommitted (only its proposer installs a ballot, `:424-427`, so the report is
a proof — but it fails (1), and the proposer may still be collecting the ballot it reports, the
§10.1 window again); a hold that ages out at the voter after the ballot itself would have
(`PROPOSAL_AGE`, `:114`, `:264-267`, is the proposer's bound — but the proposer may commit on its
last tick with the VIEW still in flight); a hold that binds only to ballots that change two or more
members — which must say which view the change is counted AGAINST, because the two answers differ.
Against the proposer's base (its old set, `:601`): a one-member change over the CURRENT view is safe
by (a)'s count, so the freeze would narrow to the multi-evict case and leave the flap, the crash, H8
and H12 untouched; but the kept ballot is a one-member change against ITS base (view 1 to
`{aa,cc,dd}`) and splits, so this hold does NOT catch it — and the base is a per-ballot fact the
voter must learn from the PROPOSE, a wire change of (β)'s class. Against the voter's own view: the
kept ballot is caught (cc and dd hold view 2, two members apart from `{aa,cc,dd}`) and no wire
change is needed. Which to count against is the step-2 page's choice. Until a
release exists, the rule trades the base's three splits for a read-only member in the four crash
cases, the 36 isolate cases, the far side of every cut inside one round trip — and a whole cluster
frozen by one flap or one crashed proposer. (b) and the kept ballot are closed by the rule only with
its third part, and the rule is not finished.

### §10.3 Source 2: a pledge (H11's page)

A pledge is a vote given before the ballot exists (branch `:814-817`: `votedFor = {e, p, hash(m)}`,
durable before the LEAVE leaves). It is a live grant with two things removed: the link at the time
the proposer counts it (branch `:928` seeds it into any ballot of `p` at `e` that omits the pledger;
`:395-397` counts it toward opening an eviction), and the VIEW afterwards (the leaver is gone after
`LEAVE_TICKS`, §10.6).

Which ballots may it complete. The argument of §10.2 needs the pledge to be the vote the pledger WOULD
have given live, for a ballot over the SAME old view, changing the members the pledger agreed to. A
LEAVE says one thing: "the view I hold, without me". So a pledge may complete exactly the ballot
whose old set is the pledger's view and whose members are that view minus leavers who have asked to
leave; nothing that also evicts a stayer, nothing that adds a joiner. That is the reviewer's step 1
(§5). Every widening is a vote for a change the voter never consented to: `evictsplit` (`{n01}` from
`{n01,n02,n03}` evicts the stayer n02 on n03's pledge) and `joinsplit` (`{n01,n02,n09}` adds n09 on
n03's pledge) are the two widenings, and both split on rounds 1 and 3 and never on the base (§10.8).

Even so restricted, the pledge has §10.2's shape by construction: the pledger is a granter who never
sees the VIEW. The count saves it only if the ballot drops one member. Two pledgers at once make a
k=2 shrink of the same old view, and at n=5 two leavers plus one stale stayer are a majority of the
old view. The branch answers that with the leaver's own gate (read-only from the knock, branch `:310`)
and, after a restart, with the floor (§10.5). **Neither is enough** (the 2026-10-10 review's
blocker; the first draft of this page called the first sound, and it is not). A leaver's own gate
stops the LEAVER writing; it does not stop the leaver being COUNTED. A stayer's gate counts every
admitted link to a member of its view (`:196-199`; the branch's gate, `:315-316`, the same), and a
read-only leaver that is still knocking is linked and is a member. So at n=5 with n04 and n05 pledged
to n01: n01 commits `{n01,n02,n03}`@2 on its own vote, n02's live grant and the two pledges, exactly
"the view minus the leavers"; and n03, cut from n01 and n02 with its links to n04 and n05 up, counts
1 + 2 = 3 of 5 at view 1 and is writable. Two writable views for the whole leave window, and for good
once the leavers time out and restart beside n03 (measured with the in-tree family on the round-3
kernel: 5 of 5 — two writable views from +56 ms, `n01@2{n01,n02,n03}` beside `n03@1`, 46 to 3,553
one-view-per-epoch violations once both sides reach epoch 3, and `n01@3{n01,n02}` beside
`n03@3{n03,n04,n05}` or @4 at the horizon; the review's hand probe saw the same shape). The schedule
is `pledgeTwo` (§10.8): the proposer keeps ONE stayer, the other stayer is cut off holding links to
both leavers, and the leavers restart on the stale side. The isolate family cannot draw it, because
it cuts the proposer from everyone. Today's kernel is clean on it: n01 opens the view minus the
FIRST leaver it read (`:370` ignores the second knock while a ballot is in flight), the cut comes
the instant both knocks are read, its PROPOSE lands across the cut (frames in flight land,
`sim/exec.ts` `partition`) but the VOTEs leave after it and die, so it has two of the five it needs
(its own and n02's) and commits nothing. The instant matters: the first version of the family cut
3 ms later, the VOTEs already in flight landed, and BOTH kernels committed a four-member view at 2
(the base `{n01,n02,n03,n05}`, read-only at 2 of 4; round 3 the same), so no kernel split it and
the family had no teeth until the second review moved the cut.
With the knock window (§10.7) built first the leavers keep a member link (n03) and keep knocking,
so the split in life would last the whole operator window. So the restricted pledge is unsafe at n ≥ 5
with two or more pledgers until the rule of §10.5 exists: a member sitting on a vote above my view is
not counted toward my writable majority. That rule is step 2 of §10.9, and the pledge is after it.
The floor after a restart is where H11's other half lives.

A re-pledge (branch `:795-796`: the vote moves one epoch up to the next stayer when the first proposer
turns out to be leaving) is a second consent by the same node, for a second shrink of the same old
view at a higher epoch. One vote per epoch holds. Whether two such ballots can both commit and both be
writable has not been argued; both drop leavers from one old view, so their writable majorities are
stayers of that view and overlap when they drop the same leavers, and §10.2(a) covers them when they
differ by one. The rebirth family (three leavers at n=4 with cuts) is the shape that would show it:
0 splits in 1200 on round 3, evidence rather than proof.

### §10.4 Source 3: a leaver's own proposal, and a lingering leaver (H4)

On the base the lowest live member leaving proposes its own exit (`:563-567`), replacing any other
ballot of its own (`:564`): the vote is re-spent at the same epoch on itself, the same-proposer case
`#propose` allows (`:594`), and the dropped ballot can commit nowhere, since only its proposer counted
its votes. The ballot shrinks by one; §10.2(a) applies. The exit proof (`:451-452`) makes the leaver go
only when a survivor holds the view, so a clean leaver never comes back holding a stale view with a
vote above it. The unclean one (`:276`) does: §10.5.

After `left` with b=0 the node keeps stepping until it is torn down (the api at once; the sim until
the scenario destroys it; `sim/exec.ts:76`). What it may do: it knocks no more (`:275`), grants a
ballot that takes it out (`:398`), refuses one that keeps it in (`:399`). What the base still lets it
do: open an eviction as the lowest live member (`:254-261` reads `leaving` nowhere) and rejoin as an
evictee it never is (`:303` excludes a leaver). The eviction is a legal ballot of a live member and
shrinks by one, so it is safe, and a view that keeps a dying member costs only the eviction that
follows. H4's split on the branch came from a kept vote seeding a self-keeping ballot (branch `:913`
closed it); on the base no vote outlives its link, and the sweep's family 1 lingers leavers up to
1200 ms with 0 splits. A lingering leaver on the base is a liveness nuisance, not a safety hole.

### §10.5 Source 4: a restart

**What `votedFor` means when its `h` omits me.** I was leaving (or I proposed my own exit, `:599`):
the view I voted for may hold, without me. The base reads none of it (`:182` restores it; `:400` reads
`e` and `p`). A restored unclean leaver is therefore an ordinary restored member: floor at its boot
epoch (`:178`), cleared by an equal-epoch view from a peer as stale as itself (`:434`), writable with a
majority of the OLD view (`:196-199`). Is that a split on the base? The view it voted for shrank by
one, so §10.2(a) holds: the old view's stale majority must include a stayer of the new view who was
linked to the proposer and learned it. The one exception is §10.2(b): a stayer who also missed the
VIEW, which needs a second cut inside one round trip, or a multi-eviction. So on the base the restored
leaver is safe by the count, and it is live (it re-forms with whoever it finds: H12's base column).

The branch's floor (`#voteWithoutMe`, branch `:289-295`) is the right idea on the wrong condition.
"My vote omits me" is one way to hold a vote above my view; `evictTwo`'s n03 holds one WITH it.
§10.2's candidate rule, "any vote above my view", covers both, in life and restored.

**A forgotten pledge.** At the proposer (a restart drops `#pledges`, branch `:687-691`): a lost vote,
never a second one; the pledger's `votedFor` stays spent on `p` at `e` (`:182`), so it refuses every
other proposer there (`:400`) and the ballot `p` re-opens may count it again as a live re-grant, or go
unanswered. Liveness only. At the pledger: it keeps the pledge as `votedFor` and knows it was leaving
(`h` omits it); what it may do with that is §10.6.

**What a restored leaver may lead, grant, announce and write.** The branch's answers after three
rounds: lead nothing, announce nothing, write nothing, GRANT (branch banner; H8 showed that refusing
the grant freezes membership after one crash). The argument for each. Write nothing: it may be out of
a writable view it consented to; writing beside it is the split. Lead nothing: a ballot of its own over
the old view is a second change from a view that may be history (H6's restart split was exactly a
re-offer at the pinned epoch). Announce nothing: a fellow restored leaver's floor must not clear on a
view that may be history (`:434` clears at an equal epoch; branch `:638-647`). Grant: its vote at the
pledged epoch is spent and vote-once refuses every other proposer there; a vote above it is the one
any member gives; voting is not writing. The first three are sound. The fourth is not, as written
(the second 2026-10-10 review): a restored leaver holds a vote above its view, and `evictTwoB`
(§10.2) is a node in exactly that state granting a never-voted stale proposer's higher ballot — the
spend that turns one view per epoch into two. "A vote above it is the one any member gives" is true
of a member whose view is current; a member whose vote is above its view may be in the committed
majority of a view it never saw, and its next grant lets a second majority of the OLD view form at a
higher epoch. What such a node may grant is §10.2's third part: the same proposer at the same epoch,
yes (that is H8's heal, and the crash grid confirms it: #9, #11, #25 and #27 heal under the clause);
a new ballot that keeps it in, no. What the four cost is H12 (§10.6) and the release question of
§10.2, which every part of the rule raises, the grant clause included.

**What a stale stayer's gate may count** (H11's other half). A link to a member proves reachability,
not that the member holds my view or is willing to write at it. The gate counts the link (`:196-199`).
A linked pair converges to the HIGHER view (flood `:495`, view-on-admit `:319`, help-a-laggard
`:446-447`), so a member holding a higher view is never miscounted for long. The member that is
miscounted is one at MY view or below with a vote above it: the restored n03 of `evictsplit` (floor 2
on the branch, read-only, and n02 counts its link: two writable views), and n04 and n05 of `evictTwo`
on the base counting n03. No frame today carries "I hold a vote above my view"; a VOTE carries the
voter's committed epoch (`ce`, `:408`), which is how the proposer learns the voter is behind, not how a
peer learns the voter is ahead. The rule the invariant needs: a member's link counts toward my writable
majority only when that member is not sitting on a vote above my view. It is a wire change (the
heartbeat or the HELLO would carry `votedFor.e`), and it belongs with the candidate rule of §10.2, not
before it.

### §10.6 Source 5: a commit the voter never sees

This is the pledge's defining trade, and the base has a weaker form of it already: a leaver's live
grant counts at the proposer after the leaver has gone (`:421-427` count received VOTEs with no check
that the voter still lives), so a view can commit on a vote whose voter is dead. The pledge makes it
the design: the vote is counted with no link at all, and the leaver is gone after `LEAVE_TICKS` by
construction. So the pledger never learns whether the ballot committed, and after a restart from its
dir it holds the old view and a vote above it, the §10.2 shape made durable.

What follows, plainly: **a pledged leaver that times out and restarts may be read-only until a view at
or above its vote reaches it.** How long is "until told":

- At n=2: the survivor is writable alone on the pledge, or wedged if the pledge never arrived. The
  restored leaver is read-only until it links to the survivor, which tells it the view at once; then
  it joins. No worse than today, where the restarted leaver rejoins the same way.
- At n=3 with two leavers and the stayer alive but cut off (`isolate`, n=3, two leavers): the stayer
  is writable alone on two pledges; the restored leavers are read-only until the cut heals. That is
  the correct CP answer: they gave the stayer the right to go on alone, and they cannot take it back
  while they cannot reach it.
- At n=3 with two leavers and the stayer DEAD (H12; `crash`: the n=3 two-leaver cases with the stayer
  crashed at −200 or 0 ms and never back, 4 of the test's default grid, 24 of 576 in the full one): the
  restored leavers cannot tell dead from cut, so they stay read-only
  for good. The base re-forms them (`{L1,L2}`@3, above the vote they spent, `:587`), and that is safe
  on the base by §10.5's count: the stayer alone cannot be writable at the view they voted for
  without a vote it never got live.

So the trade is exactly: the pledge lets the stayer go on alone, which is what the owner asked for,
and the price is that two leavers who gave it that right and then lose it cannot re-form without it.
Is that accepted? My recommendation: not as a blanket rule, and not yet. The knock window (§10.7)
costs nothing here and removes most of the stall cases that motivated the pledge; the pledge should
be argued again after it, with §10.2's base hole closed first, because a pledge is a durable "vote
above my view" and the kernel has no rule for one. If the owner wants the pledge regardless, H12 is
the line to accept in STATUS, in these words: at three members, when the one stayer crashes during a
double clean stop and both leavers are restarted, they stay read-only until an operator forgets the
stayer; today's kernel re-forms them.

### §10.7 The zero-risk candidate: the leaver keeps knocking while a member link is up

The rule: a leaver knocks every tick (`:279`) and gives up after `leaveTicks` ticks (`:276`; the
tune row `kernel/tune.ts:64-65`, default `LEAVE_TICKS` = 4, `:116`). The candidate counts a tick toward
the bound only while the leaver has NO admitted member link, and otherwise keeps knocking up to a
longer, operator-set window. The shell's wall-clock cap follows the window (`shell/runtime.ts:460`:
`max(250, heartbeat.ms × (leaveTicks + 2))`).

Why it adds no vote source: the leaver still votes only in `onPropose` over a live link (`:400`), or
proposes its own exit (`:563-567`); nothing is counted without a link, nothing is seeded, nothing is
remembered across a restart. Every argument in §10.2 and §10.4 is unchanged, line for line. The
frames it adds are LEAVE frames (`:568`), which carry no vote (`{}`); a receiver that already
proposed ignores them (`:370`). A stalled survivor's socket is open and its receive buffer holds the
knocks; when it wakes it reads them before the link closes (TCP delivers data before the FIN, §1 step
5) and proposes with the leaver still there to grant (`:371`, then `:398`). That is the whole
mechanism: the leaver is still present when the survivor wakes.

What it does not cover: a survivor stalled longer than the window (the leaver goes with `left` b=0 as
today and the two-member survivor wedges); a survivor whose link is DOWN (a tick IS spent while there
is no link, so the leaver waits only the old bound, as today); a survivor that reads the knock and
then stalls before granting (the knock is answered live or not at all, as today). It changes nothing
about crashes (§7). The I-20 line narrows from "about four heartbeats" to "longer than the window the
operator set".

Which links count. "A member link is up" must mean a link to a member that could answer the knock:
not a fellow leaver. At n=3 with the one stayer crashed and both others stopping (the crash family's
case #9: n01 crashed 200 ms before n02 and n03 stop, never back) each leaver holds an admitted member
link to the other for the whole window on today's kernel and both go unclean at +250 ms; under the
bare rule neither would spend a tick, and both would knock until the operator's window ran out with
nobody able to commit. The receiver of a LEAVE knows the sender is leaving (`:366-368`), and a
PROPOSE that leaves its own proposer out is a leave too (`:382` journals it as one: the lowest live
leaver proposes its exit itself and never sends LEAVE, `:563-567` — in case #9 that is n02, so n03
hears of n02's exit only from the PROPOSE), so the rule is: a tick is spent while the leaver has no
admitted link to a member that has neither knocked LEAVE at it nor proposed its own exit to it. A
fellow leaver it has not heard from yet counts for a tick or two, no longer.

What it costs: a slow Ctrl-C while the survivor stalls, up to the window (an operator who sets 30 s
waits up to 30 s for a stalled peer, by choice), and the same wait when every member it can reach is
leaving too and the rule above has not yet heard their knocks; the shell cap grows with it, so
`destroy()` still never hangs; one config key for the window (the tune row has none today: `api/index.ts:455-457` maps
only `redial.tries` to the table), a README row, a `config.test.ts` case, and the sim's stall model
(a constant delay on every link of one node, `sim/leave-sweep.ts:78-85`) gains a knob to prove the
survivor wakes inside the window. The sweep's family 1 known-not-live list (36 of 100) shrinks on
purpose and is re-recorded with the why; the harness's rebirth and crash floors should not move,
because no ballot rule moves.

### §10.8 The harness (`sim/leave-harness.ts`, `sim/leave-harness.test.ts`): the floor, and the teeth

The families, rebuilt from the reports (every one asserts the split check and the monitors; liveness is
counted and pinned as exact seed sets; about 30 s at low priority on the loaded box, half that idle;
`FERO_LEAVE_FULL=1` for the full crash grid and 100 seeded isolate schedules):

| Family | The reviewer's generator | Today's kernel, the floor |
|---|---|---|
| `rebirth` | R2 `sweep2`: cuts and heals between pairs, leavers reborn fresh (here as NEW identities: fero never restarts a uuid without its dir; the epoch monitor would fire on epoch 0 under a known id) | live 78 of 100 (944 of 1200); 0 splits; the not-live set pinned exactly. Named shapes: the reviewer's seed 157 heals under 10 sim seeds (seven distinct runs), the n=3 two-stop pair heals (one deterministic schedule each: the seed moves nothing in it). The three seeds of this generator the base heals and round 3 wedges, 306, 744 and 804 (`H9_SEEDS`), pinned live |
| `isolate` grid | R3 `isolate`: the proposer cut off 5/10/30 ms after one or two stops at n 3..5, the leavers back from their dirs 0.3/1.5/5 s later, 2 seeds: 108 | 0 splits; the proposer writable on 0; the far side settles on 84, the 24 not-settled pinned as an exact index set (every n=3 schedule cut 10 or 30 ms after the stops) |
| `isolate` seeded | the family the round-3 reviewer asked for: slow links, a joiner on the proposer's side one time in three | 0 splits in 100; settles on 79 (42 of the first 50); pinned exactly |
| `evictsplit`, `joinsplit` | R3's two pins, time-triggered as described | 0 splits, 5 of 5 settle, n01 never writable |
| `twoLeavers` | the first review's n=4 schedule (§3) | 0 splits, 10 of 10 |
| `pledgeTwo` | the 2026-10-10 review's probe (§10.3): n=5, two leavers knock to n01, then — the instant n01 has read both knocks — n01 keeps one stayer and the other stayer keeps both leavers; the leavers restart beside it | 0 splits, n01 never writable; the far side settles on 5 of 5, pinned as a counted set (it settles because n03 leads holding a vote above its view, so the rule of §10.9 step 2 moves this pin to 0 of 5). The family a restricted pledge fails |
| `crash` | R3 `crash2`: a stayer crashes at −200/0/20/100 ms from one or two stops, back after 2 s or never, leavers restarted after 0.4/3/25 s, n 3..5 | default grid (0.4 s, seed 1): 86 of 96 live; full grid: 516 of 576. Every wedge: the stayer crashes AFTER the leaves and never returns, the crash-at-two class (§7). 0 splits. Both not-live sets pinned exactly |
| `evictTwo`, `evictTwoB` | new (§10.2); B is the second review's probe: the stale voter is not the far side's lowest, so a never-voted member leads and the voter GRANTS | SPLITS on 4 of 5 seeds, cut and crash; B on 4 of 5; the one-evictee control 0 of 5. Pinned as the seeds, red until a kernel closes BOTH: gate + lead-nothing alone close `evictTwo` and leave B red |
| `keptBallot` | the third review's probe (§10.2 (ii)): the kept ballot's two-member shape at n=4, one fixed schedule on real Nodes — a duel at 2, the loser escalates over view 1, installs view 2 evicted, keeps the ballot and commits it on two granters at view 2 | SPLITS: `aa@3{aa,cc,dd} dd@3` writable beside `bb@2{bb,cc,dd} cc@2` at the quiet point, then two views at epoch 4 once the chains give up. Pinned red as the exact end state; gate + lead-nothing clear only the quiet point, the grant clause clears it all |
| `flapDuringBallot`, `proposerCrash` | the third review's probes (§10.2, the release): a FAILED ballot in a healthy cluster — one member flaps during an eviction ballot and the proposer abandons it; the proposer dies mid-ballot, open or committed with its VIEW unsent | writable everywhere, 0 splits; pinned as the exact read-only set (empty). Both scratch kernels: every live member read-only for good |
| explorer, quiet | R2's explorer with the end-state check (`sim/mesh.ts`, `quietSplit`, opt-in) | seeds 2001..2300, above the 1..2000 `sim/explore.test.ts` pins, so every seed adds coverage: 0. The check's own teeth: a hand pin, and `evictTwo`'s shape built move by move on real Nodes, which it names while one view per epoch holds; the sweep's `split()` has the same hand pin (an epoch-0 node is in no view and is no side of a split) |

The seeds 469, 740 and 1077 of the reviewer's generator (H9) are not rebuilt: the reports omit which
links were slow and how long one cut lasted, and three guesses wedged on the base for the known
pair-cut reason. Their COUNT reproduces: the rebirth family over 1..1200 has exactly three seeds the
base heals and round 3 wedges (306, 744, 804), against 104 the other way; those three are pinned live
(`H9_SEEDS`), so round 3's kernel turns them red. They are not the reports' shape (n=4, three leavers,
the lowest among them): 306 is n=4 with two leavers, 744 and 804 are n=5 with three.

The teeth, measured by putting each parked kernel's `kernel/membership.ts` (and the two one-line
`node.ts` hooks, and a renumbered `prevote` journal kind) over a scratch copy of this tree outside any
git tree, and running the same harness:

| Hole | Kernel | Family that goes red | Count |
|---|---|---|---|
| H1 two leavers at n=4 commit two views at epoch 2 | round 0, `851796b` | `twoLeavers` | 10 of 10, the monitor at event 622 (the report: 634) |
| H3 two clean stops at n=3 wedge for good | the review fix, `915d027` | `rebirth` named `r1-n3-two-stops`, `r1-n3-lowest-too` | 0 of 10 live (the base 10 of 10) |
| H7 seed 157 | round 1, `02f65ed` | `rebirth` named `r2-157` | 0 of 10 live (the base 10 of 10) |
| H9 branch-only losses | round 3, `6de8eee` | `rebirth` `H9_SEEDS` 306, 744, 804 | 3 of 3 live on the base, 3 of 3 wedged on round 3 (the review's measurement on both kernels; the count over 1..1200 is 3, the report's 3 of 1200) |
| H11 the isolated proposer commits on pledges; a stale stayer beside restored leavers | rounds 1 and 3 | `evictsplit` 2 and 4 of 5; `joinsplit` 5 and 5 of 5 (the monitor at epoch 3); `isolate` grid 11 and 9 of 108; seeded 12 and 8 of 100 | the report: 17 of 108, 3 of 5, 5 of 5 |
| the restricted pledge with two pledgers (§10.3) | round 3 (any kernel that counts two knocks as votes) | `pledgeTwo` | 5 of 5 UNSAFE on round 3 with the cut at 0 ms: two writable views from +56 ms, 46 to 3,553 one-view-per-epoch violations, `n01@3{n01,n02}` beside `n03@3{n03,n04,n05}` or @4 at the horizon, n01 writable throughout; the base 0 of 5. The first version's 3 ms cut: 0 of 5 on BOTH kernels (the VOTEs in flight landed and each committed a four-member view) — no teeth, caught by the second review |
| H12 the n=3 crash twin | round 3 | `crash` | 4 more wedges in the default grid (#9, #11, #25, #27), 24 more in the full one, all n=3 with two leavers and the stayer crashed at −200 or 0 ms and never back (the report: 24) |
| §10.2 two evictees at once | the base AND every round | `evictTwo`, `evictTwoB` | 4 of 5 each (cut and crash; B crash). On the scratch kernel with gate + lead-nothing only: `evictTwo` 0, `evictTwoB` still 4 of 5; with the grant clause 0 and 0, and every liveness pin above moves (§10.2) |
| §10.2 the kept ballot at n=4 | the base AND every round | `keptBallot` | the base: two writable views at the quiet point, two views at epoch 4. The two-part scratch kernel: the quiet point clean, the epoch-4 split still there (cc grants bb at 4 holding a vote at 3 above view 2); the three-part kernel: safe, bb and cc read-only for good |
| the candidate rule's cost (§10.2, the release) | the two-part AND the three-part scratch kernels | `flapDuringBallot`, `proposerCrash` | the base: writable everywhere; both scratch kernels: all five after the flap and all four after the crash read-only for good (`stale-vote`, `minority`), with no proposer left to release the vote |
| H4 (n=2 lingering leaver) | — | not drawn: the harness has no linger; the branch's kernel pin carries it | — |

The in-tree sweep's three families run unchanged on every kernel; on round 3 family 1 is live on 100
of 100 (the base 64) and family 2 on 92 (the base 87), family 3 never fires: the sweep measures the
branch's breadth and sees none of its holes, which is what §8.1 said.

### §10.9 What follows for step 3

1. The knock window first (§10.7): no vote source, no ballot rule, the operator's choice of window;
   measured against the sweep's family 1 and the harness's floor, which must not move.
2. Before any pledge: the base holes of §10.2 need their own page and rule, in THREE parts — a vote
   above my view closes my gate, I lead nothing, and I GRANT no new ballot that keeps me in (or, by
   the wire, no ballot over a view below my vote: §10.2 (α) and (β)) — together with what a stale
   stayer's gate may count (§10.5: not a member sitting on a vote above my view) and the RELEASE for
   a vote whose ballot failed and that nothing supersedes (§10.2: needed by EVERY part, not only the
   grant; the alarmed release is unsafe for it; the one candidate the second draft named cannot fire
   with the proposer dead; the three candidates to weigh are listed there). The pledge is that hole
   made the normal case and is unsafe without the gate half (§10.3, `pledgeTwo`). The same page
   settles the kept ballot (§10.2 (ii), `keptBallot`: the grant clause (α) or form (β) closes it;
   gate and lead-nothing alone leave its epoch-4 split; a leaver's own ballot already does not
   outlive an install, `:480`). Acceptance: `evictTwo`, `evictTwoB` AND `keptBallot` green — gate
   and lead-nothing alone turn only the first; every family SAFE; `flapDuringBallot` and
   `proposerCrash` WRITABLE everywhere, as on the base — a rule that leaves them read-only has no
   release and is not done; the liveness pins moved only with the why in the commit. The pins the
   rule as drafted moves are known (§10.2): `pledgeTwo`'s settled set to all five, `evictsplit`'s
   and `joinsplit`'s (with three parts), the isolate grid's 5 ms cases, the crash grid's #8, #10,
   #24, #26, six rebirth and seven sweep seeds with three parts (four and six with two); and the
   red-today witnesses turn green and are
   re-recorded with the why — the three red pins, and the quiet-point test's `evictTwo` run on the
   mesh (cc's gate shuts on its vote and nothing splits, so its named split string goes away). The
   release decides which of the liveness pins stay moved. `pledgeTwo` must stay SAFE; it is not
   expected to stay settled.
3. Then, and only on top of step 2's gate rule, the pledge restricted to one change (§10.3): the
   leaver read-only from the knock is necessary and not sufficient (a read-only leaver is still
   counted), and the owner's yes or no on H12 (§10.6) comes in writing before a line is written.
4. A review of THIS argument before any of the three: each round's argument was wrong somewhere, and
   §10.2's hole was in the base all along, under the sentence "nothing else moved".
