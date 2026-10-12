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

**2026-10-10, later: the release page (§10.10).** The rule for a vote above my view is written in full
and measured on a scratch kernel (`docs/leave-release.diff`, never committed). Its scope is what
changes everything: a vote warns only when it is for a view two or more members apart from the one
the voter holds, so a leave, a join and a one-suspect eviction hold nobody, and the flap and the
proposer crash cost nothing. The release is the proposer's word (a disown) where the proposer is
there, and supersession by the held view's own majority (a ballot joint over it) where it is not;
a clock is rejected with teeth (`releasedEarly`). The acceptance of §10.9 step 2 holds: the three
red pins and `releasedEarly` green, every family safe, the flap and the crash writable, `pledgeTwo`
safe and still settled, and not one liveness pin of the existing families moves. The harness grew
five release shapes first (§10.8, §10.10.8). The kernel is still unchanged; the build is next.

**2026-10-10, later still: the second review of §10.10.** It found two holes in the argument and
three things the harness did not draw, and the page now closes them, each with a shape pinned on
today's kernel first and re-measured on the scratch kernel. (1) A stayer that forgot a held member's
ask after two ticks was a clock in disguise: with the held member's heartbeat late the far side wrote
beside the new view with every link up (`lateAsk`). The stayer now keeps the ask until the member's
next ask replaces it or a fresh link is admitted, and the held member asks the instant its holds
change — never a clock. (2) "A held member leads nothing" left nobody to lead when every live member
was held: the granters of a dead proposer's two-apart ballot (`allHeld`), and every granter at
genesis, whose empty view is n members apart from the first (`genesisProposerDies`). A held member
now leads like any member, with its ballot joint over its own holds. (3) The rule's one liveness cost
with no cut among the living is named and pinned: the proposer and a granter of a two-evictee ballot
dead, the third granter frozen (`proposerAndGranterDie`, the CP answer). (4) The kept ballot in the
reversed order is drawn and splits today (`keptBallotReversed`); the rule holds it. (5)
`releasedEarly` is said plainly to be `evictTwo` with a delay; the disown's teeth are
`twoFailedBallots`. The acceptance of §10.9 step 2 still holds, and still not one liveness pin of the
existing families moves (§10.10.8). The kernel is still unchanged.

**2026-10-10, the third review of §10.10.** Four more things, each drawn as a shape on today's kernel
first and closed on the page and in the scratch kernel. (1) The scratch kernel read a hold from ANY
admitted link, a client's included, and one PULL from a client stopped every ballot of the server it
reached (I-23 broken): a stayer now reads a hold only from a server's word and uses only a member's
(`clientAsk`). (2) The fresh-link window: a stayer forgot the old link's word at admit and learned
the new one from an ask one round trip later, and for that round trip it counted the held member
and wrote at the old view across the cut, on every flap. The HELLO now carries the sender's holds,
so a link is admitted knowing them (`freshLink`). (3) The genesis hold has a cost the page had not
named: one survivor with memory beside a newcomer or a reborn pair never forms a view, the epoch-0
form of `proposerAndGranterDie` (`genesisProposerAndGranterDie`), pinned live today. (4) Today's
kernel commits two views at one epoch at genesis when two granters are cut before the VIEW,
hostless (`genesisSplit`, red today; the rule closes it). Also found in the re-measurement: a
ballot whose member set is the held view's members is joint over it by construction; without that
clause a frozen cluster burned an epoch every age-out. The kernel is still unchanged.

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
    (§10.2). *Later the same day: §10.10 finishes it — the scope (two members apart, against the
    voter's own view), the release (the proposer's word, or supersession by the held view's own
    majority; never a clock) and the measurement that meets §10.9 step 2's acceptance. Its second
    review found the stayer's two-tick memory to be a clock and the lead rule to leave nobody to lead
    when all are held; both are closed on the page and re-measured. Its third review found a client's
    word read as a member's (I-23), a one-round-trip window at a fresh link, an unnamed cost of the
    genesis hold and an undrawn genesis split of today's kernel; all four are closed or named and
    pinned (§10.10.6, §10.10.1, §10.10.8).*

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
base epoch is 1 while they hold view 2 and a vote at 2, either one above it ((β) reads the higher
of the two, below). Either way the rule for it is §10.9 step 2's, and no
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
  any ballot whose base is below the HIGHER of its view and its vote. Both are needed: a voter that
  installed a newer view from a VIEW frame without voting at it has its vote BELOW its view
  (`install()` never touches `votedFor`, `:465-505`; `onView` installs any higher view, `:445`), and
  by its vote alone it would grant a kept ballot over its older view. For a stale proposer (β) says
  what (α) says; it also refuses the KEPT ballot (ii) at every voter that has moved on, by view or
  by vote, so "no ballot outlives an install" needs no rule at the proposer. It is a wire change,
  the same class as what a stale stayer's gate needs (§10.5).

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
leaving too and the rule above has not yet heard their knocks; the same wait, ending unclean, when the
survivor is healthy but the ballot cannot complete — at three members with one crashed and not yet
voted out, the leave ballot's new set is {stayer, dead} and needs the dead member's vote, so the leaver
knocks for the whole window and goes `left` b=0 all the same, where before the window it went at the
fifth tick (the wave 5c review; the built note below has the numbers); the shell cap grows with it, so
`destroy()` still never hangs; one config key for the window (the tune row has none today: `api/index.ts:455-457` maps
only `redial.tries` to the table), a README row, a `config.test.ts` case, and the sim's stall model
(a constant delay on every link of one node, `sim/leave-sweep.ts:78-85`) gains a knob to prove the
survivor wakes inside the window. The sweep's family 1 known-not-live list (36 of 100) shrinks on
purpose and is re-recorded with the why; the harness's rebirth and crash floors should not move,
because no ballot rule moves.

**2026-10-10, built (wave 5c).** The rule landed as the paragraphs above state it, in
`kernel/membership.ts` (the tick's leaving branch, `#answerable`, `#leavers`).

- *The rule.* A tick counts toward `leaveTicks` (4) only while the leaver has no admitted, live,
  non-client link to a member of its committed view that is not in `#leavers`; otherwise the leaver
  keeps knocking (a non-lowest re-knocks LEAVE every tick, the lowest keeps its own exit ballot
  re-offered), up to `leaveWindow` ticks in all. `leaving` carries both counts (`ticks` toward the
  bound, `total` toward the window). The window never cuts the bound short: the kernel reads
  `max(leaveWindow, leaveTicks)`, so a row at or below 4 is the bound alone. At epoch 0 there are no
  members, so nothing counts and the bound alone applies, as before. Once the leaver's own shrunk
  view is installed (the lowest, waiting for the echo) the survivors are still members of that view
  and their links keep the window open for the echo.
- *Which links count.* `#leavers` is fed by `onLeave` (the link's authenticated uuid knocked LEAVE at
  me) and by `onPropose` when a ballot leaves its own proposer out (the lowest live leaver's exit
  ballot; the line sits beside the `leave(proposer)` journal row V4-25's fix already wrote). It is
  pruned of non-members on every install (hygiene: `#answerable` checks membership first, so the
  prune changes no answer) and forgotten for a uuid on a fresh admit (a redial or a new life). The
  cost of forgetting is not always one tick (the review's probe P-b, 2026-10-10): a NON-lowest fellow
  leaver knocks LEAVE again next tick, so for it the error is one tick; the LOWEST fellow leaver
  re-offers its exit ballot only to members that have not voted (`#proposalTargets`), so a voter that
  re-admitted it hears nothing more until that ballot ages out and is re-proposed (`proposalAge`, 10
  ticks) or the window ends — measured: bb at {aa,bb,cc} linked to aa alone, aa proposing its own
  exit and holding bb's vote, the aa link flapping once: bb goes at tick 17 (the window), where
  without the flap it goes at tick 5 (the bound). In the shell aa's own teardown closes the link
  first, so the extra wait is about the bound; in the sim a lingering aa holds bb to the window.
  Liveness only: no ballot rule is involved. In-memory only; nothing rides the boot record.
- *What did not move.* The grant expression in `onPropose`, `onVote`, `#propose`, `#nextEpoch`,
  `gate()` and `majority()` are byte-identical (the diff of the kernel's code lines, comments
  stripped, is the two counters, the set, `#answerable`, the constant and the three `#leavers`
  lines). No new frame, no new journal kind. `#leavers` is read by `#answerable` alone.
- *A cost the paragraphs above did not name (the review, 2026-10-10).* A healthy survivor whose
  ballot cannot complete: three members, one crashed and not yet evicted, and a second one stops. The
  lowest stayer's leave ballot leaves the leaver out, so its NEW set is {stayer, dead}, whose majority
  needs the dead member's vote: it can never commit. The leaver knocks for the whole window and goes
  unclean all the same, where before the window it went at the fifth tick. Measured on the sim at
  heartbeat 50 with the third member cut 200 ms before the stop: `left` b=0 at 250 ms with a 4-tick
  window, 850 ms at 16, 3250 ms at 64; at the default cadence Ctrl-C takes about 8.5 s, and
  `fero.spawn`'s 5 s grace turns the verdict into `null`. The knocks also starve the eviction that
  would make the stop live: the eviction branch of the tick runs only with no ballot in flight, the
  leave ballot ages out inside a tick (`proposalAge`), and the next knock, landing between ticks,
  re-proposes it through `onLeave` before the branch runs again — in the 64-tick run the stayer
  proposed the stuck epoch-2 ballot six times over and never evicted the dead member, though its
  redial chain had long given up. The outcome is no worse than the base (the stayer sits `minority` in
  the old view either way, and with the eviction run first — the member cut 800 ms before the stop —
  the stop is clean in a tick under every window), but the wait is new and a longer `leave.ms` cannot
  help this shape. A fix is proposer logic (a knock must not reopen an aged-out leave ballot ahead of
  an evictable suspect), outside this candidate's zero-risk scope: recorded in STATUS as an idea for
  the leave chain. The README's Membership and Process bullets name the shape.
- *The window and its key.* The tune row `leaveWindow`, default `LEAVE_WINDOW` = 16 ticks: the
  drain's number, so the README says 16 heartbeats for both halves of a scoped stop; 8 s at the
  default cadence, which covers the stalls a process meets (a long GC pause, a swap-in) and keeps an
  unscoped stop's shell cap (window + 2 ticks = 9 s) inside docker stop's 10 s grace. A healthy
  survivor answers in the first tick or two, so the default changes nothing for it. The config key
  is `leave.ms` (V4-10: every layer, the name rung, a README row in the spellings table and the
  Membership-and-timing table): the composer divides by the effective heartbeat and rounds up into
  the row; 0 is the bound alone; with heartbeats off the row stays at its default (no clock). The
  shell's destroy cap is `max(leaveWindow, leaveTicks) + (scoped ? drainTicks + 1 : 0) + 2` ticks:
  18 ticks (9 s) unscoped, 35 ticks (17.5 s) scoped when the survivor was stalled AND a holder is slow
  to attest; the usual stop is one or two heartbeats. `fero.spawn`'s 5 s grace is not raised (the
  README's Process bullet says a stop cut short reads `null`). The cap is clamped to Node's timer
  ceiling (2^31 − 1 ms, about 24.8 days): `setTimeout` fires a longer delay after 1 ms, so a huge
  `leave.ms` — an operator meaning "wait as long as it takes" — made every stop with a slow survivor a
  crash within milliseconds, before the kernel ticked once (the review; `tests/knock.test.ts` pins the
  3e9 ms case: clean after the wake with the clamp, `took 0 ms` without it).
- *The numbers.* The sweep draws the stalled survivor two ways now (`RunOpts.model`). The new
  default is a PAUSE (`Sim.pause`: every event bound for the node held in order and replayed at the
  wake, each as its own event, so the monitors run between them as after every other event — the
  first build replayed the batch in one task, and one-view-per-epoch sampled the woken node once per
  batch: on 12 of 64 wakes in family 1 it passed through two to four views unsampled (the review);
  fixed, `sim/exec.test.ts` pins one pass per replayed event, and no sweep pin moved; `cluster()`
  takes `tune`; `run`/`run2` take the window and a stall factor): the survivor wakes inside the window
  and reads everything at once, the shape the window exists for. The old
  model stays beside it as `'delay'`: the survivor keeps running and every frame to and from it is
  held for the stall (a survivor alive but SLOW, each knock and each answer paying the stall in
  turn), lifted once the leavers are gone. The build first claimed the delay model could never let
  a stalled schedule go live under the window; the review measured it and that was false — under the
  window the delay model goes live on sixteen more seeds (36 → 20 at the default, 1 at 64 ticks),
  because a slow survivor's late answers still land while the leaver knocks on. Both models are run
  and both are pinned, so the second shape of I-20, repeated knocks at a slow survivor, stays
  measured. Re-derived on the base kernel (a 4-tick window) under both first: pause 25 not live,
  delay 36 (the eleven that differ, 2, 20, 31, 34, 35, 50, 60, 65, 74, 78, 87, had the stalled node
  not the proposer; under the pause its vote landed inside the proposal's age once it woke). With the
  window: pause 25 → 0 of 100 at the default — the like-for-like before-and-after; 36 → 0 compares
  the delay model's base to the pause's window — and with the stalls tripled (750/900/1350/2100 ms
  against the 800 ms window) 22 not live — exactly the 300/450/700 ms stalls tripled, the survivor
  waking to a leaver that is gone — and 0 at a 64-tick window; delay 36 → 20 at the default
  (8, 9, 15, 20, 21, 26, 27, 38, 40, 42, 44, 57, 66, 67, 71, 75, 81, 88, 92, 95) and 1 at 64 ticks
  (seed 42: n=4, three leavers in turn at four 700 ms stalls a round trip outlast 3.2 s; it wedges
  the same with the hold never lifted, and is live at a 200-tick window); family 2 13 → 10 (4, 44 and 89
  live: a leaver cut from the proposer but linked to another member knocked on until the cut healed
  inside the window), the same 10 at 64 ticks, since a longer window heals no cut. The harness
  (§10.8): the paragraph above predicted the rebirth and crash floors would not move; the prediction
  was wrong for rebirth, and the reason is the one it gave for the sweep — rebirth 78 → 80 of 100
  live, seeds 61 and 72, the cut-then-heal shape under a 300 ms cut: a leaver cut from the proposer
  kept an admitted link to another member and knocked on where it used to give up at the fifth tick,
  the cut healed inside the window, and the knock reached the lowest live member. A liveness gain, no
  ballot rule moved; the floor table in §10.8 reads 80 now, and §10.9 step 1's "must not move" is
  read as "must not move for a ballot-rule reason". Every other pin unchanged — the isolate grid's
  24, the seeded family's 8, the crash grid's 10, pledgeTwo's, evictsplit's and joinsplit's settled
  sets, `evictTwo`, `evictTwoB` and `keptBallot` red exactly as pinned, `flapDuringBallot` and
  `proposerCrash` writable everywhere, the explorer's 300 clean. Kernel tests: eight for the window
  in `kernel/membership.test.ts` — six red under the base rule (every leaving tick counts) at the
  fifth tick, among them the one for a member link dead on a wire fault before the shell's linkDown,
  which also pins the `!dead` check of `#answerable`; the heartbeats-off and two-leaver tests are
  guards, green under the base rule and red on the base kernel only by the `total` field's shape (the
  review counted; the build's "seven" counted the shape) — and the two round-1 two-leaver shapes on
  real Nodes; two `kernel/drain.test.ts` cases
  that assumed the bound fires with both member links up now wait for the window (the links could
  still echo). Shell: `tests/knock.test.ts` stops the survivor's process with SIGSTOP for 1.2 s — the
  real stall — and the leave is clean with the window open, `left` b=0 at the fifth tick with it
  shut. The api test reads the kernel row through `diag(f).tune()`, so a composer that stopped
  passing `leave.ms` to the table goes red. The counted pins 59,500 and 104,050, the 20-seed golden
  and the 300-seed sweep are unchanged.
- *The config layer's collateral (the review).* The `leave` group is five letters, and the config
  layer's near-miss rule (a top-level object within two edits of a declared group is a typo) pulled
  in live, lease, level, league, save, wave and lane: a sibling resource so named refused to start.
  The base had the same hole for teams (`seams`) and dial (`diag`). Fixed in `api/config.ts`: the
  object is read too, for the group's OWN options — a near miss that holds one of them
  (`heartbeats: { ms }`, `lease: { ms }`, `seam: { validation }`) is the typo and the hint names that
  leaf; one that holds none (`live: { heartbeat: … }`, `teams: { dir: … }`, `live: { heartbeats: … }`)
  is a resource's rung, whatever its name is near, and a typo inside it is that resource's to catch
  when it composes. (The first fix asked for ANY declared top-level name in the object, which let
  `seam: { validation }` pass silently where the base refused it and blamed `leave.ms` for a typo
  inside `live`'s rung: the review's second look, the same day.) And `leave` is a reserved resource
  name now, as every declared top-level name is (V4-10: a resource may not be named after a group): a
  resource named exactly `leave` and configured through its own rung (`FERO_LEAVE_HEARTBEAT_MS`,
  `--fero.leave.dir`) stops itself and every sibling from starting with `unknown option
  'leave.heartbeat'`. The README lists the reserved names; the call layer is not affected.
- *What remains.* A survivor stalled longer than the window (the I-20 line narrows to it); a survivor
  whose link is down (the bound alone, as before); the three splits of §10.2, untouched by design.

### §10.8 The harness (`sim/leave-harness.ts`, `sim/leave-harness.test.ts`): the floor, and the teeth

The families, rebuilt from the reports (every one asserts the split check and the monitors; liveness is
counted and pinned as exact seed sets; about 30 s at low priority on the loaded box, half that idle;
`FERO_LEAVE_FULL=1` for the full crash grid and 100 seeded isolate schedules):

| Family | The reviewer's generator | Today's kernel, the floor |
|---|---|---|
| `rebirth` | R2 `sweep2`: cuts and heals between pairs, leavers reborn fresh (here as NEW identities: fero never restarts a uuid without its dir; the epoch monitor would fire on epoch 0 under a known id) | live 80 of 100 since the knock window (78 before it: seeds 61 and 72 went live, §10.7's note; 944 of 1200 on the base); 0 splits; the not-live set pinned exactly. Named shapes: the reviewer's seed 157 heals under 10 sim seeds (seven distinct runs), the n=3 two-stop pair heals (one deterministic schedule each: the seed moves nothing in it). The three seeds of this generator the base heals and round 3 wedges, 306, 744 and 804 (`H9_SEEDS`), pinned live |
| `isolate` grid | R3 `isolate`: the proposer cut off 5/10/30 ms after one or two stops at n 3..5, the leavers back from their dirs 0.3/1.5/5 s later, 2 seeds: 108 | 0 splits; the proposer writable on 0; the far side settles on 84, the 24 not-settled pinned as an exact index set (every n=3 schedule cut 10 or 30 ms after the stops) |
| `isolate` seeded | the family the round-3 reviewer asked for: slow links, a joiner on the proposer's side one time in three | 0 splits in 100; settles on 79 (42 of the first 50); pinned exactly |
| `evictsplit`, `joinsplit` | R3's two pins, time-triggered as described | 0 splits, 5 of 5 settle, n01 never writable |
| `twoLeavers` | the first review's n=4 schedule (§3) | 0 splits, 10 of 10 |
| `pledgeTwo` | the 2026-10-10 review's probe (§10.3): n=5, two leavers knock to n01, then — the instant n01 has read both knocks — n01 keeps one stayer and the other stayer keeps both leavers; the leavers restart beside it | 0 splits, n01 never writable; the far side settles on 5 of 5, pinned as a counted set (it settles because n03 leads holding a vote above its view, so the rule of §10.9 step 2 moves this pin to 0 of 5). The family a restricted pledge fails |
| `crash` | R3 `crash2`: a stayer crashes at −200/0/20/100 ms from one or two stops, back after 2 s or never, leavers restarted after 0.4/3/25 s, n 3..5 | default grid (0.4 s, seed 1): 86 of 96 live; full grid: 516 of 576. Every wedge: the stayer crashes AFTER the leaves and never returns, the crash-at-two class (§7). 0 splits. Both not-live sets pinned exactly |
| `evictTwo`, `evictTwoB` | new (§10.2); B is the second review's probe: the stale voter is not the far side's lowest, so a never-voted member leads and the voter GRANTS | SPLITS on 4 of 5 seeds, cut and crash; B on 4 of 5; the one-evictee control 0 of 5. Pinned as the seeds, red until a kernel closes BOTH: gate + lead-nothing alone close `evictTwo` and leave B red |
| `keptBallot` | the third review's probe (§10.2 (ii)): the kept ballot's two-member shape at n=4, one fixed schedule on real Nodes — a duel at 2, the loser escalates over view 1, installs view 2 evicted, keeps the ballot and commits it on two granters at view 2 | SPLITS: `aa@3{aa,cc,dd} dd@3` writable beside `bb@2{bb,cc,dd} cc@2` at the quiet point, then two views at epoch 4 once the chains give up. Pinned red as the exact end state; gate + lead-nothing clear only the quiet point, the grant clause clears it all |
| `flapDuringBallot`, `proposerCrash` | the third review's probes (§10.2, the release): a FAILED ballot in a healthy cluster — one member flaps during an eviction ballot and the proposer abandons it; the proposer dies mid-ballot, open or committed with its VIEW unsent | writable everywhere, 0 splits; pinned as the exact read-only set (empty). Both scratch kernels: every live member read-only for good |
| `releasedEarly`, `proposerDeadStale`, `retrySameEpoch`, `twoFailedBallots`, `lateView` | the release shapes (§10.10): what a rule for a vote above the view must stay live and safe on | `releasedEarly` red on 1, 2, 3, 4 (it is `evictTwo` with a delay); `lateView`'s mid point red (the `evictTwo` window drawn on purpose); the other three live, pinned as end states and mid read-only sets |
| `lateAsk`, `keptBallotReversed`, `allHeld`, `genesisProposerDies`, `proposerAndGranterDie` | the second review of §10.10: the held member's heartbeat late; the kept ballot granted one apart and installed over; every live member held, at view 1 and at genesis; the proposer and a granter dead | `lateAsk` red at every point (cc writable at 1 beside aa and bb at 2); `keptBallotReversed` red as `keptBallot`; the three others live, pinned as end states. Under the rule: `lateAsk` one writable view at every point, `keptBallotReversed` safe, `allHeld` and genesis re-form as today, `proposerAndGranterDie` frozen — the CP answer, named in §10.10.4 |
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
   *Built 2026-10-10 (V4-39):* the sweep's pins moved as planned, and of the harness only `rebirth`
   moved, 78 → 80 live — a liveness gain from the window itself, no ballot rule involved (§10.7's
   note says how), so "must not move" reads as "must not move for a ballot-rule reason".
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
   expected to stay settled. *Answered in §10.10 (2026-10-10): the acceptance holds on the scratch
   kernel; of the pins listed here only the red-today witnesses move, and `pledgeTwo` stays settled.*
3. Then, and only on top of step 2's gate rule, the pledge restricted to one change (§10.3): the
   leaver read-only from the knock is necessary and not sufficient (a read-only leaver is still
   counted), and the owner's yes or no on H12 (§10.6) comes in writing before a line is written.
4. A review of THIS argument before any of the three: each round's argument was wrong somewhere, and
   §10.2's hole was in the base all along, under the sentence "nothing else moved".

### §10.10 The rule for a vote above my view, and the release (2026-10-10; §10.9 step 2)

Line numbers below are in today's `kernel/membership.ts` (`v4` at `145a70b`; the branch
`w5c/release` adds only harness and docs commits on top of it) unless marked *scratch*, which means
the scratch kernel of this section: `docs/leave-release.diff`, built on a copy of that tree outside
any git tree, measured and never committed. A **hold** is a vote that warns (defined in §10.10.1).
**Joint over a view** means a ballot that needs a majority of that view's members too, beside the
majorities of its old and new sets (`:139-140`, `:450`). The **ask** is the frame a held member sends
with its holds; the **disown** is its proposer's answer that the ballot is gone.

*The second review (2026-10-10, the same day) found two holes in the first draft of this section and
three things the harness did not draw; each is closed below where it lives, and the summary and the
measurement are the ones after it. The holes: the stayer's two-tick memory of the ask was a clock
(§10.10.6, `lateAsk`), and "a held member leads nothing" left nobody to lead when every live member
was held (§10.10.2, `allHeld`, `genesisProposerDies`). The shapes: the kept ballot in the reversed
order (§10.10.1, `keptBallotReversed`), the rule's cost with no cut among the living (§10.10.4,
`proposerAndGranterDie`), and the honest teeth of `releasedEarly` and of the disown (§10.10.4).*

*The third review (2026-10-10, the same day again) found four more, closed below where they live:
the scratch kernel read a client's PULL as a member's word and one such PULL stopped every ballot of
the server it reached (§10.10.6, `clientAsk`, I-23); a stayer forgot a held member's word at a fresh
link's admit and counted it for one round trip (§10.10.6, `freshLink`: the HELLO now carries the
holds); the genesis hold's liveness cost was unnamed (§10.10.1, §10.10.4, §10.10.8,
`genesisProposerAndGranterDie`); and today's genesis split, which §10.10.1 named only in passing, was
undrawn (§10.10.1, `genesisSplit`). The re-measurement also taught that a ballot whose member set is
the held view's members is joint over it by construction (§10.10.2).*

*The fourth review (2026-10-10, the same day) checked the argument under its own probes — no safety
hole at a quiet point, the acceptance numbers reproduced on a scratch kernel it built itself — and
left four minors and a nit, each closed below where it lives. Three of the third review's kernel
lines had no pin that goes red without them, because the mesh harness writes its own HELLO for every
link and so never tests the node's (§10.10.8: `freshLinkSim`, the fresh link on REAL HELLOs in the
Sim; `clientGenesis` and `serverAsk`, one per half of the client fix, which `clientAsk` catches only
together; and `genesisProposerAndGranterDie` now pins its proposal list, which is what the
same-members clause changes). One liveness gap in the diff: a hold announced only by an epoch-0 HELLO
was never taken back, so a stayer stayed `minority` with a reachable majority (§10.10.6, `helloHold`;
fixed in the diff: a HELLO that names holds is an announcement). And two build notes (§10.10.9: how
`v` is signed, and the gate's per-call `holds()` on the write path, which now has its fast path).*

**The summary, in ten lines.**

1. A vote above my view warns only when it is for a view TWO or more members apart from the one I
   hold. One apart, the count of §10.2 (a) protects every pair of views at a quiet point, so nothing
   closes; this is candidate 3 of §10.2 counted against the VOTER'S OWN view, re-read at every
   install from `votedFor.h`, which is the member list (`:142`). It needs no wire change, it catches
   the kept ballot, and it is why `flapDuringBallot` and `proposerCrash` stay writable everywhere: a
   one-member eviction, a leave and a join never hold anyone (§10.10.1).
2. The rule has four parts for a held member: its gate is closed (`held`), no stayer counts its link,
   its own ballots are JOINT over every view its holds are for, and it grants only a ballot that is
   joint over those views — or the same proposer's at the same epoch, or one whose member set IS the
   held view's (its new-set majority is that view's majority). Who leads does not change: the
   lowest live member, held or not, with its ballot joint over its own holds and every hold a linked
   member named. (The first draft had a held member lead nothing and the lowest UNHELD member lead
   instead; that left nobody when every live member was held — the second review's major, §10.10.2.)
3. The grant takes form (β): a PROPOSE carries the epoch of the view it is over (`o`) and the held
   views it is joint over (`j`); a voter refuses a ballot over a view below its own, so the kept
   ballot dies at the voter and its proposer, which now drops every ballot on an install, re-proposes
   over the view it holds. (α) alone would have let `keptBallot`'s granters become held instead of
   refusing (§10.10.3).
4. THE RELEASE. Candidate 2 of §10.2, a hold that ends on a clock, is REJECTED: `releasedEarly`,
   `evictTwo` and `evictTwoB` split on the clock variant of the scratch kernel exactly as on the base.
   From the voter's seat a committed view whose VIEW was lost and a ballot its proposer dropped look
   the same, so no local clock is safe (§10.10.4).
5. Candidate 1, the proposer's word, is sound and is HALF the release: a held member asks its vote's
   proposer every tick — on the proposer's link whether or not it is a member of the view the voter
   holds (the fifth review, after the build: the kept ballot's proposer, evicted at view 2, is no
   member of it, and asking members alone never reached it); the proposer answers with a VIEW at or
   above the vote, or DISOWNS the ballot when it holds no ballot of that identity and no view at or
   above it. A disowned vote stays spent and warns no more. Only the proposer could commit that
   ballot, it counts only VOTE frames that reach it after the ballot opened, and the voter's next
   VOTE for it re-reads the hold — so a disowned vote can never be a committing vote (§10.10.4).
6. The other half answers "fire with the proposer dead": nothing releases the hold, and nothing
   needs to. The held view is SUPERSEDED by a ballot joint over it, which commits only when a
   majority of that view's members consent and are therefore at the new view — exactly when the held
   view cannot be live. That is Raft's answer with a configuration entry on a follower, and it is
   live whenever a majority of the held view's members are reachable, held or not: `proposerDeadStale`
   ends writable at 3 in all three variants, `allHeld` (every live member held, n=7) re-forms at 3,
   and `genesisProposerDies` forms at 2. Supersession needs a BALLOT, and the fifth review found the
   shape where no membership change opens one — the kept ballot's proposer dead, a member of nobody's
   view — so the lowest live member opens it (the opener, §10.10.4, `keptBallotProposerGone`): the
   same members at the next epoch, joint, when and only when it can commit. Where a majority of the
   held view is NOT reachable the rule
   freezes, and that is the CP answer in three shapes: the far side of a cut (`evictTwo`), where the
   held view may be live on the other side; the proposer and one granter of a two-evictee ballot
   dead for good with no cut among the living (`proposerAndGranterDie`): the third granter cannot
   tell dead from cut, and today's kernel re-forms it only because it would split the same way if
   they were cut; and the same at epoch 0 (`genesisProposerAndGranterDie`, the third review): one
   survivor of a genesis ballot, with memory, never forms a view with a newcomer or with the others
   reborn memory-only, where today it does (§10.10.4).
7. A node must remember EVERY vote it gave above its view, not only the latest (`:160`): a held
   member that grants a joint ballot which then fails must still hold the view it was joint over.
   The first scratch kernel forgot it and split `evictTwo` again, at epoch 5 (§10.10.7).
8. A held leaver needs no exemption: its exit is a ballot joint over its hold — its own when it is
   the lowest live member, else the lowest live member's, which it grants like any joint ballot
   (§10.10.5). A node's own vote never warns, in
   life or restored: its proposer is itself, and a restored own vote above the boot view never
   committed, because the view persists before the VIEW leaves and the vote before the PROPOSE
   (`:499`, `:679`).
9. A stale stayer's gate counts no link to a member whose last word names a hold above the stayer's
   view (§10.5). The wire is two frames that exist already: a HELLO carries the sender's holds
   `{e, h, p}` (`v`), so a link is admitted KNOWING them, and PULL carries them as the ask (`vs`) on
   every tick while held, the instant the holds change (a grant that holds it, a disown, an install),
   once more when the last hold ends, and at admit only when they changed while the HELLO was in
   flight. The receiver keeps what a SERVER last said until its next word replaces it (the HELLO of a
   fresh link included) — NEVER a clock (the first draft's two-tick memory: with the held member's
   heartbeat late the far side wrote beside the new view with every link up, `lateAsk`, the second
   review's blocker) and NEVER a window (the second draft forgot the word at admit and read the new
   one from an ask one round trip later, `freshLink`, the third review). A HELLO that names holds is
   itself a word, so the first change after it goes out as the ask — at epoch 0 the HELLO is the
   only word there is, and a hold it announced must still be taken back (`helloHold`, the fourth
   review). A client's word is not read (I-23, `clientAsk`), and only a member's widens a ballot. The
   gate needs `e`, the next proposer needs `h` to be joint, and the disown needs `p` (§10.10.6).
10. The acceptance of §10.9 step 2 holds on the scratch kernel: `evictTwo`, `evictTwoB`, `keptBallot`
    and `releasedEarly` green, and `keptBallotReversed`, `lateAsk`, `freshLink`, `freshLinkSim` and
    `genesisSplit` with them; every family safe; `flapDuringBallot` and `proposerCrash` writable
    everywhere; `pledgeTwo` safe AND still settled; `allHeld`, `genesisProposerDies`, `clientAsk`,
    `clientGenesis`, `serverAsk` and `helloHold` as today; and NOT ONE liveness pin of the existing
    families moves — rebirth, both isolate families, the crash grid, evictsplit, joinsplit and the
    in-tree sweep are exactly as on the base. The pins that move are the red ones, the quiet-point
    witness, the mid states of three release shapes, and TWO liveness pins frozen on purpose,
    `proposerAndGranterDie` and `genesisProposerAndGranterDie`, each with its why (§10.10.8). Every
    kernel line of the wire has ONE pin that goes red without it (§10.10.8, the one-line mutants).
    The build is step 3 (§10.10.9); the kernel is unchanged.

**What is proven, and what is open — in plain words.** PROVEN means: measured on the scratch kernel
that `docs/leave-release.diff` builds (apply it to `v4` at `145a70b` plus this branch's harness
commits), by the harness in `sim/leave-harness.ts`, whose test file pins today's kernel and whose
numbers on the scratch kernel are the table of §10.10.8 — every number there is a run of that file
or of the three in-tree suites on that tree. Proven that way: the three red pins of today's kernel
and the genesis split close; the fresh-link window closes on real HELLOs; every family of the harness
is safe; no liveness pin of any existing family moves; the two costs are exactly the two named
freezes; each rejected variant reopens exactly the holes its row names; and each kernel line of the
wire has a pin that goes red without it. ARGUED, not measured: the safety argument itself (§10.10.2,
reviewed four times; a fifth look before the build is §10.9 step 4); the pledge under the rule; the
ask and the HELLO key under real TCP. OPEN, by design or for the owner: a hold that arises after a
HELLO left at genesis (a hosts question, §10.10.1); epoch-0 nodes that hold a vote and stay writable
in no view (§10.1 excludes epoch 0 from the check); the growth of `prior` and of `#heldPeers`, bounded
by proposers and by server uuids and never pruned here; the scratch kernel's own performance (the
common case of `holds()` is a fast path; the build's pins measure it); and the build itself.

#### §10.10.1 When a vote above my view warns: two members apart, against my own view

What a vote above my view proves is only this: a view at that epoch MAY exist, with the members my
vote named, and I may be in the majority that made it. The question is whether acting on my own view
beside that possible view can break §10.1. Take my view X with n members and the vote's view M.

At a quiet point two linked members hold the same view: `onView` installs any higher view and
answers a lower one with its own (`:471-473`), and the flood on install (`:521`) and the view on
admit (`:345`) reach every link. So a member writable at X is linked to a majority of X's members
(`:219-222`) who all hold X, and a member writable at M to a majority of M's members who all hold M.
If |M Δ X| ≤ 1 those two majorities need n + 1 of n members (the count of §10.2 (a), both ways: X
minus one, or X plus one), so they cannot both exist. The vote is harmless by arithmetic, whatever
happens to the ballot. If |M Δ X| ≥ 2 they can be disjoint (§10.2 (b)), and then my vote is the only
warning there is.

So the hold is: a vote above my view, given to another proposer, not disowned (§10.10.4), for a
view two or more members apart from the view I hold NOW (*scratch* `holds()`, `#apart`). It is
re-read on every call, so an install re-reads it against the new view by construction — which
matters for the kept ballot in the REVERSED order, now drawn (`keptBallotReversed`, the second
review): cc and dd grant aa's `{aa,cc,dd}`@3 from view 1 (one apart, no hold), then install
`{bb,cc,dd}`@2 from bb's VIEW, and aa reads both VOTEs before any VIEW 2 and commits over view 1.
Today's kernel splits on it exactly as on `keptBallot` (two writable views at the quiet point, two
views at epoch 4). Under the rule the same vote is two apart the moment view 2 installs, cc and dd
are held, bb is a minority without them, and the end is one writable view (`aa@4{aa,dd}` with dd;
bb `minority`, cc `held`). Counting against the PROPOSER'S base (§10.2's other reading) would miss
that shape — the ballot is one apart from its base — and needs the base members on the wire;
counting against my own view needs nothing (`h` is the member list, `:142`, durable with the vote,
`:205`, `:1180` of `node.ts`).

Genesis is a hold too, and on purpose. A granter's vote at epoch 1 is for an n-member view and its
own view is empty: n members apart. At genesis the old set is EMPTY, so the argument of §10.10.2 has
nothing to bite on by itself — a ballot over the empty set needs no old majority, only a majority of
its new set. What protects is the GRANT and the LEAD: a held node's own ballot is joint over the
first view (§10.10.2), a held voter grants only a ballot joint over it, and a fresh proposer learns
the hold before its first ballot from the held node's HELLO (`v`, §10.10.6: at epoch 0 too — the
genesis condition is a fully-formed mesh, so every HELLO has landed when the lowest node proposes)
and from any refusal (`hm`, §10.10.3). So a second genesis ballot over a set that holds a member of
the first view commits only with a majority of the first view's members. That is SAFER than today in
a shape now drawn and red there (`genesisSplit`, the third review): n=5, aa installs view 1 on bb's
and cc's grants, dd and ee are cut before the VIEW, and today dd — at epoch 0 with its vote spent at
1 — proposes `{dd,ee}`@2 over the empty old set, ee grants, and two views commit at epoch 2, both
writable (hostless genesis; the Sim gives every node hosts, so no Sim family draws it). Under the
rule dd's ballot is joint over the five and needs three of them: dd and ee stay at epoch 0. What
the hold does not do: the gate at epoch 0 is open genesis whatever the node holds (`:217`, before
the hold is read; an epoch-0 node is in no view and is no side of a split, §10.1), and no ask is
sent at epoch 0 (nobody is a member yet). One gap stays, by design: a hold that arises AFTER the
HELLO left — two genesis ballots over overlapping sets in flight at once — is learned only from the
refusal, so whether the second ballot is joint depends on which lands first; that is a genesis duel
over different member sets, which the hosts rule (I-22) exists to prevent, not I-20.

What the genesis hold COSTS (the third review): `genesisProposerAndGranterDie`, the epoch-0 form of
`proposerAndGranterDie` (§10.10.4). n=3, aa proposes, bb and cc grant, aa dies (open or committed
with its VIEW unsent) and cc dies too. bb, the one survivor, holds a vote for `{aa,bb,cc}`@1. A
newcomer dd links to it: bb leads `{bb,dd}`@2 joint over `{aa,bb,cc}`, which needs two of its three
members, and only bb is there — frozen, where today bb and dd form `{bb,dd}`@2. The same when aa and
cc come back memory-only as fresh identities a2 and c2 (V4-2/V4-3: a restart without a dir is a new
uuid): a2 reads bb's hold from its HELLO, its ballot is joint over `{aa,bb,cc}` from the start, and
nothing forms — where today the pair forms `{a2,bb,c2}`@1 on its own two votes (bb refuses, its vote
is spent at 1, and installs the VIEW at epoch 0: the rebirth rule, fresh uuids start the count
again — which in the committed variant is a second view at epoch 1 beside aa's, today's genesis
class). From bb's seat aa and cc dead look exactly like aa and cc cut and writable at `{aa,bb,cc}`@1,
so this is the CP answer again; the remedy is the operator's, as for the crash-at-two class (§7):
forget the dead, or start the survivor fresh too. Pinned live today in both forms so the build pays
it on purpose. `genesisProposerDies` is the other pin: the first proposer dies at epoch 0, open or
committed, and the survivors — a majority of the first view — form `{bb,…}`@2 as today.

Which ballots today's kernel opens that are two apart from a voter's view: the eviction of two or
more suspects at once (`:277-284`, k < n/2: §10.2 (b)); a ballot over an OLDER view, kept across an
install (`:503` keeps one above the view) or led by a stale proposer (`evictTwo`'s n03), seen from a
voter that has moved on. Every leave (`:397`, `:591`), every join (`:384`), every one-suspect
eviction and every rejoin self-ballot (`:323`, the same members) is one apart or none, and holds
nobody. That is the whole reason the flap and the proposer crash of §10.2 cost nothing under this
rule, where the rule as drafted there froze every live member: the votes in `flapDuringBallot` and
`proposerCrash` are for `{aa,bb,cc,dd}`, one apart from view 1.

The own vote. A vote whose proposer is me never warns (*scratch* `#votesAbove` drops it). While my
ballot is open I am the one who counts it and installs it (`:450-453`), and I drop it when it ages
out (`:290`) or when its suspect returns (`:263`): I know its outcome. Restored from my dir, an own
vote above the boot view means the ballot never committed: `install` persists the view (`:499`)
before the VIEW floods (`:521`), and `#propose` persists the vote (`:679`) before the PROPOSE
leaves (`:688`), so a crash after the commit restores a view at or above the vote, and a crash
before it restores no ballot (`#proposal` is not durable) that anyone else could complete — only its
proposer counts its votes (`:447`). `retrySameEpoch` restores aa with view 1 and its own vote at 2
and ends writable in both variants.

#### §10.10.2 The four parts, and who leads

For a member with at least one hold, in today's lines:

- **The gate.** Closed, `held` (*scratch* `gate()`, before the count at `:219`). Writing at X beside
  a possible M two apart is the split of §10.2 (b).
- **The count.** No stayer counts its link (`:221`, *scratch* `#heldPeer`): a link proves
  reachability, not consent to write at my view (§10.5). The wire for it is §10.10.6.
- **The lead.** Unchanged: the lowest live member leads (`:228-230`), held or not, and a held
  leader's ballot is joint over every view its own holds are for (*scratch* `#propose`: `joint`
  starts from `holds(node)`). Its holds stay behind its own vote in `prior` (§10.10.7, *scratch*
  `#remember` keeps every vote above the view at another epoch), so leading does not forget them. The
  first draft had a held member lead nothing and "the lowest live UNHELD member" lead instead,
  reasoning that its own vote would replace the hold (`:678`); with `prior` that reason was gone, and
  the rule left NOBODY to lead when every live member was held (the second review's major): a dead
  proposer's two-apart ballot granted by every survivor (`allHeld`: n=7, ff and gg down, aa evicts
  both and dies — bb, cc, dd and ee were held for good, four of the held view's five members
  linked), and every genesis whose first proposer dies (`genesisProposerDies`: each granter's vote is
  n apart from its empty view). Both re-form as today under this rule. Why it is safe for a held
  member to lead: the lead is a liveness discipline, not a safety one — two proposers at once are
  what vote-once is for (banner `:13-29`) — and its ballot's commit still needs a majority of the
  held view, in which its own vote counts exactly as a held granter's would.
- **The grant.** It grants only a ballot that is joint over the view EACH of its holds is for, or the
  same proposer's ballot at the same epoch as one of them, or a ballot whose member set IS the held
  view's members (*scratch* `onPropose`, `jointOverMine`). The same-proposer re-grant is today's rule
  (`:426`, the banner's lost-VOTE heal): at most one of that proposer's ballots at that epoch
  commits, and the new one replaces the hold. The same-members clause is joint by construction — the
  ballot's new-set majority IS a majority of that view — and it is load-bearing for liveness (the
  third review's re-measurement): an escalation past a burn (`#nextEpoch`, `:665`) leaves each voter
  an older vote for the same proposer's same set at the lower epoch, a hold by `#apart`; without the
  clause the voter refused the re-offer at the new epoch, the proposer burned another epoch, and a
  frozen cluster climbed epochs for good (`genesisProposerAndGranterDie reborn`: `P(1,3) P(2,3)
  P(2,3) P(3,3) P(3,3) P(4,3)` on the second draft, `P(1,3) P(2,3) P(2,3) …` with it).

And for the proposer: its ballot is joint over its own holds, over every hold a linked member named
in its last ask, and over every hold a refusal names (*scratch* `#propose`, `onVote`); it commits
only with a majority of its old set, its new set, AND each of those held views (*scratch* `onVote`,
`#propose`'s solo commit). The targets of the PROPOSE include the held views' members (`:698`,
*scratch* `#proposalTargets`).

Why a held voter's consent is needed at all, and why joint is enough. A ballot over X needs a
majority of X (`:450`). The voters of a committed M two apart from X were a majority of X too, so
any majority of X contains a member that voted for M — and that member is at M (linked to M's
proposer, converged) or holds X with a hold on M. Members at M refuse the ballot (its base is below
their view, §10.10.3) and teach the proposer M (`:439`, the VOTE's `ce`). So a ballot over X cannot
gather its old majority without a HELD voter's grant, and a held voter grants only a ballot joint
over M. A ballot joint over M commits only when a majority of M's members granted it, and every
granter installs the new view (the flood, `:521`) or holds it; either way they are not at M, and M
can never again have a writable majority (§10.10.1's count: a majority of M at M would need members
that are at N or held). That is the supersession of line 6: the held view is not released, it is
outvoted by its own majority.

#### §10.10.3 The grant: form (β), and no ballot outlives an install

The choice. (α) "grant nothing new that keeps me in while held" and (β) "refuse a ballot over a view
below the higher of my view and my vote" (§10.2) answer two different questions, and the rule needs
both answers: (α)'s question is what a HELD voter may grant (answered above: only joint), and (β)'s
is what ANY voter may grant from a proposer that is behind it. The scratch kernel takes (β)'s wire
field and (α)'s shape for the hold. A PROPOSE carries `o`, the epoch of the view it is over
(`#proposal.old` is fixed at `:680`; the frame had no field for it, `:693`), and `j`, the held views
it is joint over. A voter refuses a ballot whose `o` is below its view epoch (*scratch* `onPropose`,
`over >= this.view.epoch`): the proposer is behind, and the refusal's `ce` (`:434`, `:439`) teaches
it the view. One view per epoch makes the epoch enough to name the view (§10.2's first argument);
`o` above my view cannot happen on one link (the view went ahead of the PROPOSE, §10.2's chain
argument) and is allowed.

What it buys: `keptBallot` dies at the voter. cc and dd, at view 2, refuse aa's `{aa,cc,dd}`@3 over
view 1 (the harness names the moved step: "cc did not grant aa at 3 from view 2"); aa installs view
2 evicted and holds nothing; bb and cc end writable at `{bb,cc}`@3 with dd `minority` and aa
`evicted` — one writable view, and more of the cluster live than under (α) alone, where cc and dd
would have granted, become held, and ended read-only for good (§10.2's three-part measurement:
`aa@4{aa,dd}` writable beside bb and cc read-only). The refusal does not depend on the voter being
held, so it also closes the one-member kept ballot the double-vote mesh scenario describes (STATUS's
line; `kernel/membership.test.ts`, 2026-10-08) at the voter instead of leaving it to the count.

And at the proposer: an install drops EVERY ballot (*scratch* `install`, replacing `:503`'s "at or
below the view" and `:506`'s leaver rebase, which was this rule for one case). A ballot over a view
I no longer hold cannot commit anyway under (β); dropping it lets the next tick re-propose over the
view I hold (the suspects are still suspects, `:277`; a knock is re-sent every tick, `:302`) instead
of waiting `proposalAge` ticks (`:129`, `:290`) for it to age out. `twoFailedBallots` and
`retrySameEpoch` show the re-proposal landing at the same epoch (V4-25's rule, `:665-667`).

The leaving-out exemption of today's grant (`:424`, `leavingOut || !this.epochStale`) stays as it is
for `epochStale`; §10.10.5 is why no exemption of the hold is needed.

#### §10.10.4 The release: three candidates against three requirements

The three requirements (§10.2): (1) fire with the proposer dead; (2) fire when the proposer
abandoned the ballot; (3) never fire while a majority of the old view may still commit — more
exactly, never fire while the view the vote is for may be LIVE, held by a writable majority
somewhere, because that is what the split needs.

**Candidate 3, the hold bound to two-member changes, is the SCOPE, not a release** (§10.10.1). It
removes the need for a release from every one-member ballot, which is every ballot but the
multi-suspect eviction and the stale or kept ballot. What is left needs an answer for (1) and (2).

**Candidate 2, a hold that ends on a clock, is rejected.** The claim in §10.2 against it was that the
proposer may commit on its last tick; the deeper reason is that no clock distinguishes (3) from (1).
`evictTwo` itself is the shape: n01 commits `{n01,n02,n03}`@2 on n03's grant, the VIEW to n03 dies on
the sever (`sim/exec.ts` `severOnFrame`), and n01 and n02 go on writable at view 2. n03 sees a grant
that is getting old and a proposer that never answers. If its hold ends on any clock — the ballot's
own age (`:129`) plus any slack, as the scratch kernel's `timeout` variant does — it is writable at
view 1 with n04 and n05 and leads them into `{n03,n04,n05}` while `{n01,n02}` write at 2 and 3.
`releasedEarly` is the same shape with the n01-n03 link slow, so the grant is 200 ms old when the
ballot commits; the first draft offered it as the clock's teeth, and the second review is right that
it has none `evictTwo` lacks: any clock shorter than the run splits both, because the VIEW never
arrives in either. It stays as the named witness, and its "commit 200 ms after the grant" check is a
guard that the slow link was in effect, true by construction when the ballot commits. The shape that
a clock fails and a lost VIEW does not show is the VIEW LATE rather than lost: `lateView` holds every
frame into cc back for 24 rounds, longer than the rejected variant's bound (`proposalAge` + 2 = 12
ticks), so a hold on that clock ends with the VIEW still in flight and the mid point shows two
writable views again (the first draft held the frames back 12 rounds, exactly the bound, and never
crossed it). Measured on the `timeout` variant of the scratch kernel: `evictTwo` splits on 1, 2, 4
and 5 cut and crash, `evictTwoB` on 1, 2, 4 and 5, `releasedEarly` on 1, 2, 3 and 4, `lateView`'s
mid point is `cc@1 W` beside `aa@2 W`, `keptBallotReversed` splits at epoch 4, and
`proposerAndGranterDie` re-forms — the base's numbers, every hole back. The base's alarmed release
(`:308-315`) is the same clock and is unsafe here for the same reason (§10.2 said so).

**Candidate 1, the proposer's word, is half the release, and sound.** The mechanism (*scratch* `tick`,
`onPull`, `onNack`): a member with holds sends, every tick, to every linked member, PULL `{e, vs}`
with its holds `vs: [{e, h, p}]`; a receiver that is the proposer `p` of one of them answers with its
VIEW when its view is at or above that epoch (`:483-484`, the existing answer: the hold's epoch is
above the asker's view `e`, so a proposer at or above it is above `e`), and otherwise, when it holds
no open ballot of that identity (`#proposal` with that epoch and that `h`), DISOWNS it: NACK `{e, h}`.
The voter marks that vote `f` (disowned), durably (`:431`'s rule: the vote persists before anything
leaves), and it warns no more; it stays spent, so vote-once at that epoch is untouched (`:426` still
reads `votedFor.e` and `.p`). The next grant to that proposer at that epoch replaces it (*scratch*
`#remember`), un-disowned, and re-reads the hold.

Why a disowned vote can never be the vote that commits a second view. Only the proposer of a ballot
installs it (`:447-453`: it counts VOTEs that echo its own hash, and installs its own view). A ballot
counts only VOTE frames that reach it after it opened (`:680` makes `votes` fresh per ballot). At the
disown, the proposer held no ballot of that identity, so the voter's earlier VOTE frame, consumed or
lost, counts toward nothing; for that proposer to commit a ballot of that identity later it must
open it again and the voter must send a NEW VOTE, which it does only in `onPropose`, where the grant
re-reads the hold before the frame leaves (`:428-434`). So between the disown and any later commit
of that ballot there is a fresh grant that re-holds the voter. And the proposer's word cannot
overtake its view: on one FIFO link its VIEW left before any disown it sends afterwards, so a voter
that reads a disown has not missed a VIEW from that proposer (`lateView`: aa's answers to cc's asks
queue behind aa's VIEW, cc stays held until it lands, then is at 2). The view check in the disown is
therefore belt-and-braces: the scratch kernel without it moves no pin (the mutation of §10.10.8).
What the disown does NOT say is that no view at that epoch exists elsewhere: another proposer may
have committed one at that epoch over another old set. That is why the vote stays spent, and why the
released voter's own view may still be two apart from a live view — but then that view's committed
majority of the voter's view holds it or is held (§10.10.2), and the released voter is not among
them.

What it fires on, and which pin is its teeth. (2), the abandoned ballot: `twoFailedBallots` — bb and
cc are held after each grant, aa abandons (`:263`), their asks reach aa, aa disowns, every member is
writable again within the ten settle rounds, twice; the third ballot commits and holds them until its
VIEW. This is the disown's ONE pin with teeth: on the variant whose disown releases nothing, its two
mid points move (bb and cc held at both) and nothing else does. The proposer's restart,
`retrySameEpoch`, is NOT: aa comes back with view 1 and its own vote, `#proposal` forgotten; bb's and
cc's asks are disowned, but aa's retry at the same epoch re-grants them anyway (the same-proposer
rule, `:426`), so the shape heals with or without the disown (the second review measured it). What
`retrySameEpoch` pins is the re-read of the hold against the ballot it is for: `one` retries as a
one-member eviction and holds nobody; `two` retries the same two-member ballot and re-holds until
the VIEW. (1), the proposer dead for good: the word never comes. That is the other half.

**Supersession, the other half.** With the proposer dead or cut, a hold is never released. It is
superseded: the lowest live member leads a ballot joint over it (§10.10.2; its own hold, or one it
learned from an ask), and that ballot commits only when a majority of the held view's members grant
it. If the held view is live somewhere, its writable majority is at that view, not linked to the
proposer (converged, §10.10.1), and cannot be in the ballot's joint majority, which needs more than
half of the same members: the ballot waits. If the held view is dead — its proposer died before
flooding, or with the ballot open — its members are exactly the held voters and the proposer, and a
majority of them reachable makes the ballot commit. `proposerDeadStale`: aa evicts dd and ee at 2 on
bb's and cc's grants and dies, open or committed; bb and cc are held (the mid point, two rounds
after the death: bb and cc `held`, dd and ee `minority`); bb, the lowest live member, held, proposes
`{bb,cc,dd,ee}`@3 joint over its own hold `{aa,bb,cc}`; cc grants it (joint over its hold), dd and
ee grant it (they hold nothing); a majority of X (bb, cc, dd), of N (bb, cc, dd) and of `{aa,bb,cc}`
(bb, cc) — it commits, and the four are writable at 3 exactly as on the base. `allHeld` is the same
with EVERY survivor held (n=7, two down, four granters): bb leads the same way and `{bb,cc,dd,ee}`@3
commits on four of the held view's five. `genesisProposerDies` is the same at epoch 0. In `restart`
aa comes back holding `{aa,bb,cc}`@2, a view nobody else has: a rejoiner at floor 2 (`:201`), it
reads view 3 on admit (`:345`, `:471`), is evicted, knocks (`:329-335`), and is voted back in at 4.

**Supersession needs a ballot, and someone must open it** (the fifth review, 2026-10-12, after the
build). Every ballot the kernel opened answered a membership change: a suspect, a knock, a leave, a
rejoin. The kept ballot in the reversed order with its proposer GONE is a hold with no such change
behind it: cc and dd granted aa's `{aa,cc,dd}`@3 from view 1, installed bb's `{bb,cc,dd}`@2 and were
held; aa died (open, or committed with its VIEW unsent). aa is no member of view 2, so it is nobody's
suspect; nobody joins, nobody leaves. bb counted neither held member (`minority`), cc and dd were
`held`, for good — with cc and dd two of the held view's three and every link among the three up.
Line 6 above promised liveness exactly here ("whenever a majority of the held view's members are
reachable") and the built kernel denied it; a join healed it twelve rounds later, by accident of the
ballot it brought. The same shape with aa alive but EVICTED (it read cc's VOTE, then cc's VIEW 2, and
dropped the ballot) froze too, for the other half's reason: the ask went to the members of the
asker's view, and aa was no member, so the one node that could disown was never asked. Both are
closed in the kernel, each by one line of the argument made real: the ask goes on the link of every
proposer of a vote above my view, member or not (`#askTargets`); and the lowest live member OPENS
the superseding ballot when no membership change would (`#openOverHolds`, from `tick`): the view it
holds again at the next epoch, past the holds' epochs (a held voter's vote there is spent on another
proposer, so a ballot there is refused for sure), joint over the holds its linked members named —
when, and only when, the ballot can commit: a majority of its own view linked COUNTING the held
members, and a majority of EACH held view's members linked or itself. Not for a hold whose proposer
is itself (its disown answers that ask in one frame); nothing where some held view's majority is out
of reach, so the far side of a cut and the two CP shapes below burn no epochs; nothing while a
ballot is in flight, and nothing while a member of my view is LOST (the sixth review, 2026-10-12):
the opener fires only with every member of my view linked. A lost member is a membership change in
the making — a suspect in `suspectTicks` ticks, and its eviction, joint over the same holds, is the
ballot; the eviction waits on the dialing hold of V4-39 (the pending-redial window right after a
heal: an un-exhausted chain means reachability is unknown), and the opener waits with it — or it is
back in a tick, and the opener fires then over the full view it holds, rightly. A majority linked
would do for the commit, and before this the opener asked no more: it stood in for an eviction that
was only HELD BACK or not yet due, not in flight. At n=5 with bb cut from aa and cc, bb proposes
`{bb,dd,ee}`@2 and dd grants, held; dd's ask lands at aa while bb is aa's lost member — not yet its
suspect, or a suspect it is still redialing — and aa re-proposes the FULL view, bb included, at 3:
it commits everywhere, bb's ballot is burned, and bb is evicted again at 4. Safe (no split, the
quiet point clean), one doubled ballot and one epoch with the lost member back in. With the wait aa
proposes nothing in either window, and the ballot already in flight wins the duel: ee grants bb and
`{bb,dd,ee}`@2 commits, aa and cc evicted across the cut (`openerBesideSuspect`, the `fresh` and
`dialing` variants; the given-up control is the ordinary duel in the same tick — aa `P(2,4)` joint
over `{bb,dd,ee}`, dd's vote already bb's, both escalate — `{aa,cc,dd,ee}`@3 with bb evicted; the mid
is aa's proposal list, nothing against `P(2,4)`). In life the windows are `suspectTicks` heartbeats
and then the give-up jitter between the two ends of a lost member link (both redial, `memberRedials`
5); in the mesh they are forced.
It does NOT wait for the opener's own gate to close (the reviewer's sketch had it fire only at a
`minority` stayer): a held member in a cluster that is writable without it is still a member whose
writes park and, past the bounded queue, drop, and no membership change may ever come; the ballot is
the same safe ballot either way, and it costs one same-members epoch, once. In every pinned shape the
two triggers coincide (the stayer that can open is the one the held members leave in the minority).
Safety is unchanged: the opener grants nothing and counts nothing new; its ballot commits under the
rule above and IS the supersession of §10.10.2. `keptBallotProposerGone` pins the three variants:
`evicted` is released by aa's disown the moment the asks land, before any tick (bb proposes nothing
new); `open` and `committed` by bb's `{bb,cc,dd}`@4 — `P(2,3) P(4,3)` — on cc's and dd's consent;
without the opener the end is `bb@2 r:minority cc@2 r:held dd@2 r:held`, without the ask to the
proposer `evicted` shows the three held after the asks land and heals by the opener instead. No
other pin of the harness moved: the opener never fires where a hold's view majority is unreachable,
where the held member is itself the lowest (its gate is `held`, and its eviction ballot is the joint
one), or where the hold's proposer is a member (then it is a suspect, and the eviction is the
ballot; or it is linked to the held member, and the ask reaches it).
The trigger reads the holds my linked MEMBERS named (`#heldPeers`), never my own, while the ballot it
opens is joint over both (`#jointViews`) — and my own holds need no trigger (the seventh review,
2026-10-12). A hold of mine is a vote for ANOTHER proposer's ballot. That proposer is a member of my
view, and linked: then my ask goes on its link (`#askTargets`) and it answers with a VIEW or a disown
in one round trip. Or a member of my view, and lost: then it is my suspect in `suspectTicks` ticks and
its eviction, joint over my holds, is the ballot the opener would have opened — the opener waits for
it, as above. Or no member of my view: then form (β) (its view at or above mine when I voted) and the
rule that every proposer is a member of its own view (the lowest live member proposes; a leaver its
own exit) make its view one ABOVE mine that I never installed, and the chain from my view up to it
starts with a ballot over my view by one of my own members, who committed and installed it before
anyone above could propose — linked, it is above me and answers my ask with its VIEW, which I install
and re-read the hold against; lost, it is a suspect again. At epoch 0 the formation ballot is the joint
one (`genesisProposerDies`), and the opener never fires there (a member of an empty view is nobody).
So the shape the trigger would miss — I am the lowest live member, the only one held, every member
of my view linked and my vote's proposer gone — cannot be built, and folding my own holds into the
trigger would add a guard no pin can turn red. The asymmetry is kept on purpose: the holds I was told
of OPEN my ballot, my own holds WIDEN it.

Where supersession cannot fire, it must not, and that has THREE shapes, not one. The far side of a
cut: `evictTwo`'s n03 (held) opens `{n03,n04,n05}`@3 joint over `{n01,n02,n03}` and needs n01 or n02,
which are writable at 2 across the cut; n04 and n05 grant it and are held on it in turn; all three
stay read-only until the cut heals. And, named by the second review, the proposer AND one granter of
a two-evictee ballot dead for good, with no cut among the living (`proposerAndGranterDie`): aa evicts
dd and ee at 2, bb and cc grant, aa and bb die; cc holds `{aa,bb,cc}`, leads `{cc,dd,ee}`@3 joint
over it, dd and ee grant (and are held on it: `{cc,dd,ee}` is two apart from view 1), and the ballot
needs two of `{aa,bb,cc}` — cc alone is there, for good. Today's kernel re-forms `{cc,dd,ee}`@3,
writable, and that is UNSAFE when aa and bb are merely cut (they are two of `{aa,bb,cc}` and
writable at 2: `evictTwo`'s split seen from cc), so the freeze is the price of closing `evictTwo`:
from cc's seat dead and cut are the same, and the CP answer is the same. It is a new class beside
"the far side of a cut" — three live, linked members frozen with no cut anywhere — and it is pinned
as a liveness shape so the build pays it on purpose (§10.10.8). And the same at epoch 0, named by
the third review (`genesisProposerAndGranterDie`, §10.10.1): the one survivor of a genesis ballot
holds a vote for the first view, every ballot it leads or grants is joint over it, and a newcomer or
the reborn pair cannot supply two of its three members — frozen at epoch 0, where today a view
forms. All three are the answer Raft gives a follower holding an uncommitted configuration entry
whose majority it cannot reach; an operator who knows the dead are dead forgets them, as today for
the crash-at-two class (§7), or starts the survivor fresh.

So the release is the proposer's word where the proposer is there to give it, and supersession by
the held view's own majority where it is not. Neither is a clock. Requirement (1) is met as liveness
whenever a majority of the held view's members are reachable, and refused, correctly, when they
are not — across a cut, or dead.

#### §10.10.5 The leaver

A held member that stops on purpose knocks LEAVE on every member link (`:302`, `:598`) or, when it
is the lowest live member, proposes its own exit (`:593-595`) — joint over its hold, like every ballot
of a held member (§10.10.2). Otherwise the lowest live member opens the view without it, joint over
its hold (learned from the ask), and the leaver grants it: a ballot joint over its held view, which
§10.10.2 allows. No exemption is needed, and none is given: a ballot that takes a held member out but
is NOT joint over its hold is refused like any other, because its old-set majority would otherwise
include a member of a possibly live view two apart from it. What this costs: a held leaver whose
held view's majority is unreachable times out and goes `left` b=0 (`:299`) — it was on the
read-only side of a split, where a clean exit is not available to anyone. The in-tree sweep's
family 1 (stalls, lingering leavers, a join) and family 2 (cuts and restarts) are unchanged on the
scratch kernel: no leave ballot holds anyone (§10.10.1), so the leave path never meets the rule.
(One care the re-measurement taught: the first version of the fixed kernel sent the ask at epoch 0
too, and the six extra frames at genesis shifted the sim's random draws enough that family 2's seed
89 — a duel at epoch 4 that today's kernel loses on timing — happened to heal. A moved pin with no
rule behind it is a bug, not a gain; the ask goes only to members, nothing at epoch 0, and the set
is unchanged.)

#### §10.10.6 What a stale stayer's gate may count, and the wire

§10.5's rule: a member's link counts toward my writable majority only when that member is not
sitting on a hold above my view. The wire for it is two frames that exist already, each carrying the
sender's holds as `[{e, h, p}]`: the HELLO (`v`, *scratch* `helloHolds`), so a link is admitted
knowing them, and the PULL (`vs`, *scratch* `#ask`), the ask of §10.10.4, on the sender's admitted
member links. Beside `o` and `j` on the PROPOSE and `hm` on a refusal, that is the whole wire change.

**When it is sent, and to whom.** The HELLO carries the holds as they are when the link opens (nothing when there
are none, so a fresh node's HELLO is byte-identical with today's; at epoch 0 too, §10.10.1). The ask
goes to every admitted member of the sender's view AND to the proposer of every vote the sender holds
above its view, member of that view or not (the fifth review: the proposer of a kept or stale ballot
is exactly a node the sender's view has left out, and only it can disown; a disowned vote keeps its
proposer in the list while it is above the view, so the release reaches it too). It goes on every
tick while the member holds anything (the refresh); the INSTANT its holds change — a
grant that holds it (behind the VOTE on the proposer's link), a disown, an install that re-reads
them — so that no quiet point sees a stayer counting a member that is already held; once more, with
an empty list, when its last hold ends — the release is this frame, never silence; and at admit, on
the fresh link, ONLY when the holds are not what the HELLO on that link said (they changed while it
was in flight; *scratch* `onAdmit` reads the key `helloHolds` left on the Link). Nothing at epoch 0
but the HELLO (§10.10.1). And a HELLO that names holds is itself an ANNOUNCEMENT (the fourth
review): what it said becomes the last word the sender gave (*scratch* `helloHolds` sets `#lastAsk`),
so the first change after it goes out as the ask on every member link. At epoch 0 that is the only
way a word can be taken back, because no ask goes out there: before this line the install that ended
a hold compared nothing with nothing and sent nothing, and a stayer that had read the hold from the
HELLO kept not counting a member that held nothing. `helloHold` is the pin (n=5, hostless): aa
installs view 1 and is cut off; bb at epoch 0 proposes `{bb,cc,dd,ee}`@2 and dd grants it; aa
re-links to dd — dd's HELLO names the hold at 2 — and aa's VIEW 1 lands at dd, whose vote at 2 is
now one apart from view 1, no hold; aa re-links to cc. With cc and dd linked, three of its five, aa
must be writable, and today it is. On the scratch kernel before the fix aa was `minority` at that
point and after three quiet rounds, and stayed so until its own eviction ballot — joint over the
phantom `{bb,cc,dd,ee}`, which needs three of them — aged out and was disowned, and dd's next word
(the empty ask after the disown) replaced the phantom: one proposal age of a stayer frozen with a
reachable majority, and a ballot burnt. What the line costs: one empty ask per member link, once,
at the first install of a node whose HELLO carried a hold — a link that formed AFTER its genesis
grant, which the genesis condition (a fully-formed mesh) makes rare. In the Sim that one frame
shifts the timing of exactly one `freshLinkSim` seed (3 at 3-40 ms) into the held shape, and moves
no pin of the in-tree sweep, the explorer or the harness families (§10.10.8).

**What the receiver keeps, and whose word it is.** What each SERVER last said, until that server's
NEXT word replaces it: its ask (an empty one included), or the HELLO of a fresh link to it, which
REPLACES the old link's word (*scratch* `#heldPeers`, `onPull`, `onAdmit`). The gate skips a member
link whose last word names a hold above the receiver's view (*scratch* `#heldPeer`, `gate()`), and a
proposer's ballot is joint over the holds of the MEMBERS of its view (at epoch 0: of every linked
server, the formation set), never over an ex-member's or a joiner's (*scratch* `#propose`). A
CLIENT's word is not read at all — not its HELLO's `v`, not its PULL's `vs` (I-23: a client's PULL is a
question, never a teaching, `node.ts:1830`). The third review's probe against the second draft: a
client linked into aa sent one PULL naming a hold over three members that do not exist, and aa's
every ballot was joint over them — one PULL from a client stopped every ballot of the server it
reached, because `byUuid` holds client uuids too. `clientAsk` is the pin, live today and under the
rule: aa evicts ee in one ballot.

NEVER a clock, and NEVER a window. The clock (the second review's blocker): the first draft kept each
ask for two ticks and let silence be the release; a held member whose heartbeat is late — a GC pause,
a slow scheduler — was counted again by its stayers when the memory ran out, with every link up and
every frame landed. `lateAsk` is the pin: `evictTwo`'s witness settled (cc held, dd and ee
`minority`), then cc's timer does not fire for four rounds while everyone else ticks and every frame
lands. On the two-tick variant dd and ee are writable at view 1 beside aa and bb at 2 from the third
late round; under this rule there is one writable view at every point, however late cc is. (The
review's Sim probe saw the same with a 400 ms stall on cc's links: 44 split-ms per seed at a strict
quiet point.) The window (the third review's minor): the second draft FORGOT the old link's word at
admit and had the held member ask again on the fresh link; for the round trip until that ask landed
the stayer counted the held member, was writable at the old view beside the new one — across the
cut, so the two sides never converge — and settle flushed its parked writes into it, on every flap.
`freshLink` is the pin: the witness settled, then the cc-dd link drops and comes straight back, and
the state is read the instant the link is admitted and again when every frame has landed. On the
second draft dd is writable at the first point (two writable views) and `minority` at the second;
under this rule dd is `minority` at both. (The review's Sim probe, the link partitioned and healed 30
ms later: 5 split-ms per flap on 3 ms links, 53 and 70 on 3-40 ms links, one `gateOpen` row at dd
each time; 0 and none with the HELLO carrying the holds. Today's kernel's own in-flight transient at
a plain one-member eviction is 3 to 34 split-ms between LINKED nodes that converge — a different
thing.) The HELLO closes it because the knowledge arrives WITH the admission: there is no instant at
which the link is counted and the holds are unknown. A duplicated HELLO (the open node's dup fault
re-runs the admit tail, `node.ts:1429`) re-sets the same word — idempotent, where the second draft's
delete would have forgotten an ask that landed between the two copies.

Why both frames, and why `{e, h, p}` and not `votedFor.e` alone on the heartbeat as §10.5 proposed:
the gate needs only `e`, but the next proposer needs `h`, the members of the held view, to make its
ballot joint over it, and the disown needs `p` to know which asks are its own to answer. PULL exists
already (`:481`): a member that is held is a member that wants a view it cannot see, which is what a
PULL has always asked for; its tick is the refresh and its change keeps the count exact at quiet
points. HELLO exists already and is the one frame that is read BEFORE a link is counted, which is
what the fresh link needs; a key on it is no new frame, and a node with nothing to say adds nothing.
The second draft said "nothing rides HELLO" because the ask carried more and the clock would expire
it; with the clock gone and the window found, the HELLO carries the same list.

The lag it leaves, named: NONE at a quiet point. A member that becomes held announces it in the same
step as its VOTE, so until the ask lands a frame is in flight and the point is not quiet; a member
whose hold ends announces that too; a fresh link is admitted knowing the holds. What remains: a
proposer that opened a ballot before a hold it did not know of reached it learns the hold from the
refusal (`hm`) and re-offers joint two ticks later (`:291-293`) — one re-offer, liveness only; and a
hold that arises between a HELLO leaving and that link's admit at epoch 0, where no ask is sent
(§10.10.1: a genesis duel, a hosts question).

Which is what makes `pledgeTwo` safe under a pledge, by argument (the pledge is not built, so this
is not measured): the two pledges of §10.3 are votes for `{n01,n02,n03}`, two apart from view 1, so
each pledger is held from the knock, and n03's gate counts neither of them: 1 of 5, read-only, while
n01 commits on them. On today's kernel, which counts no knock as a vote, `pledgeTwo` stays settled
on 5 of 5 under the rule: n01's ballot is the view minus ONE leaver (`:397`, the second knock is
ignored while a ballot is in flight), one apart, so n03's vote for it is no hold and n03 leads the
far side as before. §10.2 expected this pin to move to 0 of 5; it does not, because the scope of
§10.10.1 is narrower than the rule drafted there.

#### §10.10.7 Every vote above my view, not the latest: the hole the first scratch kernel had

`votedFor` remembers one vote (`:160`); a grant replaces it (`:428`) and so does a proposal of my
own (`:678`). The first scratch kernel hung the hold on it, and `evictTwo` split again, now at epoch
5: n03 (held on `{n01,n02,n03}`@2) granted n04's joint ballot `{n03,n04,n05}`@3, which replaced its
vote; n04's ballot could not commit (it needed n01 or n02) and aged out (`:290`); n03's ask reached
n04, which held no such ballot and disowned it; n03's only vote was now disowned, its hold gone, and
it led `{n03,n04,n05}`@4 over view 1 with no joint set at all. The hold on n01's view had been
forgotten the moment n03 consented to a ballot meant to supersede it.

So a node remembers every vote it gave above its view (*scratch* `Vote.prior`, `#remember`): the
latest is `votedFor` and vote-once reads it as today; the earlier ones ride behind it, pruned at
every install to those still above the view, each with its own `f`. It rides inside `votedFor`, so
the boot record (`node.ts:1180`), the sim's restart and the mesh's restart carry it unchanged. A
disown releases one vote; a VIEW at or above an epoch releases every vote at or below it; a grant
replaces only the vote at its own epoch, and so does a ballot of the node's own (`:678` goes through
`#remember` too) — which is what lets a held member lead without forgetting its hold (§10.10.2).
The list grows by one per failed joint ballot while the member learns no view at all — bounded in
practice by the proposers willing to try, and left unbounded on purpose: dropping an entry drops a
hold, and a dropped hold is this hole. With the list the scratch kernel closes `evictTwo` on 10 of
10, cut and crash.

#### §10.10.8 The measurement

The scratch kernel (`docs/leave-release.diff`, applied with `git apply`; 242 lines added and 23
removed over `kernel/membership.ts`, a verb in `kernel/codec.ts`, its dispatch and the HELLO's `v`
in `kernel/node.ts`, the `v` key in `kernel/door.ts`, a journal row, and the mesh's verb list and
fabricated HELLO), run against the whole harness, the in-tree sweep, the explorer and the kernel's
own membership pins, under `t1` on the loaded box. The base column is the committed pin. This is the
measurement AFTER the fourth review (the fix of `helloHolds` and the fast path of `holds()` in the
diff; the seven in-tree pins that move are byte-for-byte the moves of the third review's kernel,
and the three suites are 35 of 35 again); the earlier drafts' numbers that changed are named in the
last column.

| What | Today's kernel (the floor) | The scratch kernel | Why it moved |
|---|---|---|---|
| `evictTwo` cut, crash | splits on 1, 2, 4, 5 of 5, both | **0 of 5, both**; the k=1 control 0 of 5 | n03 is held and leads `{n03,n04,n05}`@3 joint over `{n01,n02,n03}`; it cannot reach n01 or n02; n04 and n05 grant it and are held on it; the far side stays read-only across the cut |
| `evictTwoB` | 1, 2, 4, 5 of 5 | **0 of 5** | n04 is held and grants n02 nothing that is not joint over `{n01,n04,n05}`; n02's joint ballot needs n01 or n05 |
| `keptBallot` | two writable views at the quiet point, two views at epoch 4 | **safe**: cc and dd refuse aa's ballot over view 1 (the step the shape names); end `aa@2{bb,cc,dd}r:evicted bb@3{bb,cc}W cc@3{bb,cc}W dd@2 r:minority`, no split at any epoch | form (β) at the voter |
| `keptBallotReversed` (new) | the same two splits as `keptBallot` | **safe**: cc and dd grant from view 1, install view 2 and are held; end `aa@4{aa,dd}W bb@2 r:minority cc@2 r:held dd@4 W`, no split at any epoch | the hold re-read against the voter's own view at the install |
| `releasedEarly` | 1, 2, 3, 4 of 5 | **0 of 5**; the slow link in effect on 5 of 5 | no clock: n03 holds until the cut heals (it is `evictTwo` with a delay) |
| `lateAsk` (new) | two writable views at every point (cc at 1 beside aa and bb at 2) | **one writable view at every point**: cc `held`, dd and ee `minority` through four late rounds and after cc ticks again | the stayer's memory of the ask is not a clock |
| `flapDuringBallot` | all five writable | **all five writable** | one apart, no hold |
| `proposerCrash` open, committed | the four re-form at 3, writable | **the same** | one apart, no hold |
| `proposerDeadStale` open, committed, restart | the four at 3 writable; the restored aa in at 4; mid (two rounds after the death) all four writable | **the same end states**; mid: **bb and cc `held`, dd and ee `minority`** | bb and cc held; bb leads joint over its own hold, cc consents (the first draft: dd led, being the lowest unheld) |
| `allHeld` open, committed (new) | `{bb,cc,dd,ee}`@3 writable | **the same** | bb, held, leads joint over `{aa,bb,cc,dd,ee}`; four of its five consent (the first draft: all four held for good, nobody led) |
| `genesisProposerDies` n=3, 5, open, committed (new) | `{bb,cc}`@2, `{bb,cc,dd,ee}`@2 writable | **the same** | bb, held on the first view, leads over the empty old set joint over it (the first draft: all at epoch 0 for good) |
| `proposerAndGranterDie` open, committed (new) | `{cc,dd,ee}`@3 writable | **cc, dd and ee `held` at view 1, for good** | the CP answer: cc's held view needs two of `{aa,bb,cc}` and only cc lives; one of the two liveness pins the rule moves (§10.10.4) |
| `genesisProposerAndGranterDie` fresh open, committed; reborn open (third review) | `{bb,dd}`@2 writable; `{a2,bb,c2}`@1 writable | **everyone at epoch 0, for good** (`bb@0{}`, `dd@0{}`; `a2@0{} bb@0{} c2@0{}`); bb re-proposes `{bb,dd}`@2 and a2 `{a2,bb,c2}`@2 every age-out, at the SAME epoch | the CP answer at epoch 0: bb's hold needs two of `{aa,bb,cc}`; a2 reads it from bb's HELLO, so its ballot is joint from the first; the other liveness pin the rule moves (§10.10.1) |
| `genesisSplit` (third review) | two views at epoch 2 (`{aa,bb,cc}` beside `{dd,ee}`), both writable at the quiet point, the recorder firing three times | **safe**: `aa@2{aa,bb,cc}W bb@2 W cc@2 W dd@0{}W ee@0{}W`, no split | dd's and ee's genesis votes are holds five apart from the empty view; dd's `{dd,ee}`@2 is joint over the five and needs three |
| `clientAsk` (third review) | `{aa,bb,cc,dd}`@2 in one ballot, `P(2,4)` | **the same** (the second draft: `P(2,4) P(2,4) P(2,4)` and no commit — every ballot joint over `{q1,q2,q3}`) | a client's HELLO `v` and PULL `vs` are not read (I-23) |
| `freshLink` (third review) | dd writable at 1 beside aa and bb at 2 at both points (`admitted`, `landed`): two writable views | **one writable view at both points**: dd `minority` the instant the fresh link is admitted (the second draft: dd W at `admitted`, two writable views, `minority` only at `landed`) | the HELLO carries cc's holds, so dd admits the link knowing them — the MESH's copy of the HELLO: this pin never reads `node.ts` (the fourth review), `freshLinkSim` does |
| `freshLinkSim` (fourth review: the Sim, real HELLOs; `evictTwo`'s cut shape, the n03-n04 and n03-n05 links flapped 1.5 s after the cut, the writable split sampled every ms for 4 s) | split through the window on the seeds `evictTwo` splits on — 4000 of 4000 ms on seeds 1, 2, 4, 5 at 3 ms and 1, 4 at 3-40 ms (n03 writable at 1 with n04 and n05 beside n01 and n02 at 2, later `{n03,n04,n05}`@3); 31 ms and one n04 `gateOpen` on seed 3 at 3-40 ms (a transient); 0 on the rest | **0 of 4000 on every seed and delay**; before the flap n03 `held` and n04, n05 `held` or `minority` on every seed that reaches the shape (seeds 3 at 3 ms, 2 and 5 at 3-40 ms never reach it: n03 learns view 2 before the cut, as on the base) | n03's OWN HELLO carries its hold; minus that one line (mC below) the window shows 15 to 160 ms per flap |
| `clientGenesis` hello, pull (fourth review) | view 1 forms, `P(1,3)` once | **the same** | a client's word is not read at epoch 0 either; minus the client guards alone (mA) nothing ever forms: `aa@0{}W bb@0{}W cc@0{}W`, `P(1,3) P(1,3) P(1,3)` — a proposer at epoch 0 reads every linked uuid's word |
| `serverAsk` (fourth review) | `{aa,bb,cc,dd}`@2, `P(2,4)` once | **the same** | only a MEMBER's word widens a ballot; minus the member filter alone (mB) `P(2,4)` three times and ee is never evicted |
| `helloHold` (fourth review) | aa writable with cc and dd linked at both points; end `aa@3{aa,cc,dd}W …` with bb and ee evicted | **the same** (the diff before the fix, mE: aa `minority` at both points, until its ballot joint over the phantom hold aged out and was disowned) | a HELLO that names holds is an announcement, so its release follows (§10.10.6) |
| `genesisProposerAndGranterDie` proposals and bb's vote (fourth review) | bb `P(2,2)` once; a2 `P(1,3)` once; bb's vote carries nothing | bb **`P(2,2)` six times**, a2 **`P(1,3) P(2,3)` five times** — the SAME epoch at every age-out — and bb's vote at 2 with ONE earlier vote behind it | the same-members clause (§10.10.2); minus it (mD) a2 `P(1,3) P(2,3) P(2,3) P(3,3) P(3,3) P(4,3)` and bb's vote at 4 with three behind it |
| `retrySameEpoch` one, two | writable everywhere at the mid point; ends `{aa,bb,cc,dd}`@2 and `{aa,bb,cc}`@2 | mid: **bb and cc `held`**; the ends **the same** | held after the first grant; the restarted aa re-grants at the same epoch (the disown is not what heals it, §10.10.4) |
| `twoFailedBallots` | writable everywhere at both mid points; `{aa,bb,cc}`@2 at the end | **the same** | disowned twice within the settle rounds, held a third time until the VIEW: the disown's teeth |
| `lateView` (24 rounds) | mid: `cc@1 … W` beside `aa@2 W` (red today); end at 2 | mid: **`cc@1 r:held`**, no two writable views; end **the same** | the ask is answered by the VIEW, behind the first VIEW on the link |
| the quiet-point check's `evictTwo` mesh witness | the named split string | **no split string** (cc held) | the pin §10.9 said would be re-recorded |
| `pledgeTwo` | safe, settled 5 of 5 | **safe, settled 5 of 5** | one apart (the view minus one leaver): no hold |
| `evictsplit`, `joinsplit` | settled 5 of 5 each, n01 never writable | **the same** | one apart |
| `rebirth` 1..100, named shapes, H9 seeds | not-live set of 22, named shapes heal, H9 heal | **the same set** | no leave ballot holds anyone |
| isolate grid 108, seeded 50 | not-settled 24 and 8, n01 writable on none | **the same sets** | the same |
| crash grid 96 | not-live set of 10 | **the same set** | the same |
| explorer 2001..2300 | clean | **clean** | — |
| in-tree sweep, families 1, 2, 3 | not-live 36 and 13, family 3 clean | **the same sets** | the same (after the ask was taken off epoch 0, §10.10.5: with it, family 2's seed 89 healed on timing alone) |
| `sim/explore.test.ts` 1..2000 with its reach floors | pass | **pass** | — |
| `kernel/membership.test.ts` | 31 pass | **31 pass** | the first draft's `since` stamp, which moved V4-25's two `deepEqual` pins, is gone: the rejected clock variant stamps a side map instead |

The teeth, each a one-line variant of the scratch kernel (`FERO_SCRATCH_VARIANT`), the harness run
whole under each:

| Variant | `evictTwo` cut / crash | `evictTwoB` | `releasedEarly` | `lateAsk` | the rest | What it shows |
|---|---|---|---|---|---|---|
| `timeout`: the hold ends after `proposalAge` + 2 ticks | 1, 2, 4, 5 / 1, 2, 4, 5 | 1, 2, 4, 5 | 1, 2, 3, 4 | one view at every point | `lateView`'s mid point two writable views; `keptBallotReversed` splits at 4; `proposerAndGranterDie` re-forms; `genesisSplit` splits again (dd's hold expires and it leads `{dd,ee}`@2 alone) | candidate 2 reopens every hole; the VIEW late is caught where the VIEW lost is not |
| `forget`: a stayer forgets a held member's ask after two ticks (the first draft of §10.10.6) | 0 / 0 | 0 | 0 | **two writable views from the third late round** | everything else as the candidate | the second review's blocker: the memory was a clock, and only `lateAsk` catches it |
| `counted`: a stayer counts a held member's link (the review's mutant B) | 1, 2, 4, 5 / 1, 2, 4, 5 | 1, 2, 4, 5 | 1, 2, 3, 4 | two writable views at every point | `keptBallotReversed` two writable views at the quiet point; `proposerDeadStale`'s mid has dd and ee writable; `freshLink` two writable views at both points and at the quiet point | the count is the piece that carries the safety |
| `nojoint`: the commit ignores the joint sets | 1, 2, 4, 5 / 1, 2, 4, 5 | 1, 2, 4, 5 | 1, 2, 3, 4 | one view | `keptBallotReversed` splits at 4; `proposerAndGranterDie` re-forms; `genesisSplit` splits again | supersession without the held view's majority is the split |
| `nolead`: a held member leads nothing (the first draft of §10.10.2, without its unheld fallback) | 0 / 0 | 0 | 0 | one view | `allHeld` all four held for good; `genesisProposerDies` all at epoch 0 for good; `proposerDeadStale` frozen | the second review's major: nobody leads when all are held (the first draft's fallback healed `proposerDeadStale` and still froze the other two) |
| the latest vote replaces the hold (the first scratch kernel, §10.10.7; measured on the first draft) | 1, 2, 4, 5 / 1, 2, 4, 5 (at epoch 5) | 1, 2, 4, 5 | 1, 2, 3, 4 | — | — | a hold must outlive a joint grant |
| `noviewcheck`: the disown without its view check | 0 / 0 | 0 | 0 | one view | everything as the candidate | masked by FIFO: the VIEW is ahead of the word on the link; the check is belt-and-braces |
| the second draft (the kernel the third review measured: the word forgotten at admit and re-asked; a hold read from any admitted link; no same-members clause) | 0 / 0 | 0 | 0 | one view | `freshLink`'s `admitted` point two writable views; `clientAsk` never commits (`P(2,4)` three times); `genesisProposerAndGranterDie reborn` climbs epochs while frozen | the third review's three findings against the kernel, each with its one pin |

The fourth review's teeth: ONE PIN PER KERNEL LINE of the wire. Each mutant is the scratch kernel
minus one line (or one pair of guards); the five new pins re-recorded to the scratch kernel's values
are run on each (`rfix3/pins-*.log`: 5 of 5 pass on the scratch kernel), and exactly that line's pin
goes red. Before this round `clientAsk` went red only with BOTH client guards gone, the
same-members clause moved nothing any pin read, and the node's own HELLO `v` was tested by nothing
— the mesh writes its own HELLO for every link (`sim/mesh.ts` `connect`), so every mesh shape ran
the same with or without it.

| Mutant | The line missing | The pin that goes red, and what it shows |
|---|---|---|
| mA | the client guards in `onAdmit` and `onPull` (`!link.client`) | `clientGenesis` hello AND pull: `aa@0{}W bb@0{}W cc@0{}W`, aa `P(1,3) P(1,3) P(1,3)` — one client linked in before genesis stops genesis, because `#propose` at epoch 0 reads every linked uuid's word; `clientAsk` and `serverAsk` unchanged |
| mB | `#propose`'s member filter (`this.view.epoch === 0 \|\| this.isMember(u)`) | `serverAsk`: all five at view 1, aa `P(2,4) P(2,4) P(2,4)`, ee never evicted — a server in no view widened every ballot; `clientAsk` and `clientGenesis` unchanged |
| mC | the node's own HELLO `v` (`node.ts`, `...(vs.length ? { v: vs } : {})`) | `freshLinkSim`: 15 and 51 split-ms (n04 `gateOpen` 2 and 1) on seeds 4 and 5 at 3 ms; 103, 144 and 160 (2, 1, 1) on seeds 1, 3, 4 at 3-40 ms; 0 where the shape is not reached — the stayer counts the fresh link for the round trip until the ask lands. The whole mesh harness and the mesh `freshLink` pin are IDENTICAL to the scratch kernel's (the mesh's copy of the rule carries the hold) |
| mD | the same-members clause (`\|\| x.h === h`) | `genesisProposerAndGranterDie` proposals: a2 `P(1,3) P(2,3) P(2,3) P(3,3) P(3,3) P(4,3)` and bb's vote at 4 with three earlier votes behind it (the scratch kernel: `P(2,3)` five times at the same epoch, one behind) — every end state and every other pin identical |
| mE | the announcement (`helloHolds` setting `#lastAsk`: the diff as it was before this round's fix, plus the fast path) | `helloHold`: `aa@1{…}r:minority` with cc and dd linked at both points (`aa with cc and dd`, `three rounds`) where the scratch kernel and today's kernel show aa writable; the end state the same (aa's ballot, joint over the phantom, ages out, is disowned, and dd's next word replaces the phantom). And `freshLinkSim`'s seed 3 at 3-40 ms no longer reaches the held shape (31 ms, one `gateOpen`, as on the base): the fix's one empty ask at a genesis install shifts that seed |

The new shapes under the rejected variants (the harness run whole under each, `rfix3/variant-*.log`;
every older column of the table above is unchanged): `timeout` and `nojoint` reopen `freshLinkSim`
on the base's seeds (4000 of 4000) and on seeds 3 and 4 at 3-40 ms too (3918 and 3922: the hold
ends on the clock, or the far side re-forms without the held view's majority); `counted` splits
through the window on every seed that reaches the shape (1442 to 3946 ms, n04 and n05 writable
before the flap on most of them: the stayer counts the held member); `forget` and `noviewcheck`
show 0 everywhere, as the scratch kernel (the HELLO is not the clock, and the view check is
belt-and-braces); `nolead` never reaches `helloHold`'s shape (bb, held at epoch 0, proposes
nothing: the second review's major again). `clientGenesis`, `serverAsk` and `helloHold` are as
the scratch kernel under every other variant.

The acceptance of §10.9 step 2, line by line: `evictTwo`, `evictTwoB` and `keptBallot` green (and
`releasedEarly`, `keptBallotReversed`, `lateAsk`, `freshLink`, `freshLinkSim` and `genesisSplit`
with them); every family safe; `flapDuringBallot` and `proposerCrash` writable everywhere;
`clientGenesis`, `serverAsk` and `helloHold` as today; `pledgeTwo` safe; the
liveness pins moved only with the why — the ones that move are three release shapes' mid states (held
members where the base had writable ones, released or superseded by the end), the witnesses §10.9
named, and TWO end states frozen on purpose as the CP answer: `proposerAndGranterDie` (§10.10.4) and
its epoch-0 form `genesisProposerAndGranterDie` (§10.10.1). Nothing that §10.2 measured as the rule's
cost is paid: not the 36 isolate cases, not the crash grid's four, not the six rebirth seeds, not the
seven sweep seeds, not `pledgeTwo`'s five, not `evictsplit`'s and `joinsplit`'s ten. The difference is
the scope of §10.10.1. What IS paid, named by the second and third reviews: a two-evictee ballot whose
proposer and one granter die for good freezes the third granter and the two evictees, three live and
linked members, until an operator forgets the dead; and at epoch 0, the one survivor of a genesis
ballot never forms a view with a newcomer or with the others reborn memory-only, until an operator
forgets the dead or starts it fresh. The genesis hold is not free; it buys `genesisSplit`.

#### §10.10.9 What the build does (§9 step 3, after a review of this argument)

- The kernel: `docs/leave-release.diff` as the starting point, minus the `V` line and every use of
  it (the rejected variants), the `#voteTick` map that serves one of them, and `#tickNo` with the
  `tick` field of `#heldPeers` that serve another (`forget`), which would be dead code without them.
  The frames: HELLO gains `v` (the sender's holds, absent when none — a fresh node's HELLO is
  byte-identical; the build gives it a shape check beside `n`, `c`, `m`, `k`, and SIGNS it: the
  scratch `proofMsg` names its keys and leaves `v` outside the proof); PROPOSE gains `o` and `j`;
  VOTE gains `hm` on a refusal; PULL gains `vs` (sent on the tick, on the change, once on the
  release, and at admit only when the holds changed since the HELLO); NACK is verb 27; all
  append-only, and a PROPOSE without `o` reads as over the voter's own view (today's behaviour). The
  key `helloHolds` leaves on the Link becomes a Link field (the scratch hangs it on the object), and
  `helloHolds` keeps setting `#lastAsk` from a HELLO that names holds (§10.10.6, the fourth review).
  The journal gains `release` (a=epoch, b=proposer) and the gate word `held`; the ELI5 and the
  debugger's fold learn both. The boot record's `votedFor` gains `prior` and `f` inside the same
  field; the two V4-25 kernel pins pass unchanged (no stamp rides in the vote). The mesh's
  fabricated HELLO carries the peer's holds as the node's own does (`sim/mesh.ts`).
- How `v` is signed (the fourth review's note). `proofMsg` signs a JSON array of strings and
  numbers, which has ONE encoding; `v` is an array of objects, whose key order is whatever the
  decoder produced, so it must not go into the array as decoded. The build signs it as one string:
  the canonical key `#keyOf` makes of it (`e:p:h|e:p:h` in the order the sender lists them, the
  latest vote first as `holds()` returns them; `''` when absent), appended to the array after `m`.
  Both ends compute it from the same list, so a rewritten `v` fails the proof like a rewritten `l`.
  Say plainly what that buys: consistency with the other HELLO keys — the door guards the admit, and
  the HELLO is the one word read before a link is counted — not protection of the holds afterwards:
  the same list travels UNSIGNED in every PULL `vs` after admission (DESIGN-DOOR: no frame after
  admission is signed), so a peer that can rewrite frames on a link can add a hold there (the
  receiver counts less, a ballot needs more) or drop one (the receiver counts a held member: the
  window back) exactly as it could rewrite a VOTE or a VIEW today.
- The pins to re-record, with this section as the why: the three red pins and `releasedEarly` to
  empty sets; `keptBallot` to its refused shape (the test's `shape` list becomes the pin of the
  refusal, or the schedule is redrawn to assert the refusal); `keptBallotReversed` to its safe end
  (no splits, `cc held`); the quiet-point test's mesh witness to "cc held, no split"; `lateAsk`'s
  mids to one writable view at every point; `freshLink`'s mids to one writable view at both points;
  `freshLinkSim` to `0 of 4000` on every seed and delay, with its `before` gates as §10.10.8 lists
  them; `genesisSplit` to no split, dd and ee at epoch 0; `lateView`'s mid to `cc held`;
  `retrySameEpoch`'s and `proposerDeadStale`'s mid read-only sets to bb and cc held (and dd and ee
  minority); TWO liveness end states, `proposerAndGranterDie` to all three held and
  `genesisProposerAndGranterDie` to everyone at epoch 0 — the costs of §10.10.4 and §10.10.1, with
  those whys — and the latter's proposal pin to `P(2,2)` six times, `P(1,3) P(2,3)` five times, bb's
  vote with one earlier vote behind it (the same epoch at every age-out: the same-members clause).
  Every other pin stays as it is — `allHeld`, `genesisProposerDies`, `clientAsk`, `clientGenesis`,
  `serverAsk` and `helloHold` included — and the commit says so. One pin per kernel line of the wire,
  so a line dropped in the build shows (§10.10.8's mutants): `freshLinkSim` is the pin for the node's
  own HELLO `v` (no mesh pin reads it), `clientGenesis` for the client guards, `serverAsk` for the
  member filter, `genesisProposerAndGranterDie`'s proposals for the same-members clause, `helloHold`
  for the announcement.
- Not measured here, to be argued or measured in the build: the ask under the real-TCP tier (a
  frame per tick per held member while held, and one per change); the growth of `prior` under the
  explorer with a hold that never ends; a held member under the knock window (the window changes no
  ballot, so nothing is expected to move); a pledge, if ever built, is a hold from the knock
  (§10.10.6) and is argued safe by this rule, not measured; and the gate's per-call `holds()` on the
  write path (the fourth review's note): `gate()` now calls `holds()` every time, and `gate()` runs on
  every write drain and every inbound write run (`kernel/write.ts`), so the build's perf pins must
  see it. The scratch `holds()` returns at once in the common case — no vote above the view and
  nothing behind it, which is every member of a settled cluster — and builds and filters
  `[votedFor, ...prior]` only while a vote above the view exists; the build keeps that fast path and
  measures the held case, which is bounded by the length of `prior`.
- STATUS: the I-20 line's "release" sentence and the two split lines' "the rule for it" sentences
  point here; the kernel is still unchanged.

**2026-10-10, after the fourth re-check: open for the build.** The page landed as a record with
these items open, each with the reviewer's probe under the session's scratch folder (`rsk2/`,
`rsk3/`):

1. `helloHolds` sets the node-wide `#lastAsk` from a HELLO sent on ONE link, so at the next
   install `#ask('change')` skips the ask on member links that never carried that HELLO, and a
   stayer that linked before the hold existed counts the held member for up to a heartbeat (two
   writable views in that window on the candidate). Fix in the diff: a HELLO that names holds forces
   the next change's ask onto every member link (a sentinel no key equals, or the last word per
   link, which `saidHolds` already tracks); pin the shape.
2. Two `onAdmit` lines of the diff have no pin: the fresh HELLO replacing a peer's old word
   (`else this.#heldPeers.delete(link.uuid)`; without it a lost release is never learned, and a
   node stays `minority` for good), and the ask at admit when the holds changed while the HELLO was
   in flight. The claim that every kernel line of the wire has one pin is true for the five lines
   §10.10.8 names, not for these two.
3. `freshLinkSim` counts every writable split in its window, the normal propagation of a view
   change included, and never checks that the run reached the two-evictee shape; a correct kernel
   can read non-zero on timing alone. Return "not the shape" unless n01's view at 2 evicts both,
   and count only the ms in which a far-side node at view 1 is writable beside a higher view.
4. The signing note: sign `v` inside proofMsg's JSON array as `[[e, p, h], …]` (strings and
   numbers, one encoding; a canonical string brings back the separator ambiguity the array exists
   to avoid); say what an old peer does with the new keys and that a secured pair of mixed versions
   fails as `bad-proof` (or bump the label to `fero-door/2`); mixed versions are unsupported before
   1.0 (V4-14).

**2026-10-12, BUILT (V4-51; branch `w6/relbuild` on v4 at 35d7300: eleven commits for the build itself; the three
reviews below add nine more, twenty in all, and the counts in THEIR notes are the tree's — this note's are the build's
at the time: 46 membership pins, 18 harness pins, 964 tests).** The rule of §10.10 is in the
kernel, applied by hand commit by commit (`docs/leave-release.diff` was built on 145a70b and no longer applies after
the knock window; it stays as the measured record). What landed, in the kernel's words: `Vote.prior` (§10.10.7) and
`Vote.f` (the disown); `holds()` with its common-case fast path and the gate word `held`; form (β) at the voter (`o` on
the PROPOSE, a ballot over a view below mine refused) and no ballot outliving an install; `hm` on a refusal, `j` on the
re-offer, the joint commit (`#jointOk`); the wire (`v` on the HELLO, `vs` on the PULL, `#heldPeers`, the stayer's
count, `Link.saidHolds`, `HELLO_WORD`); the release (NACK, verb 27; `onNack`; the disown in `onPull`; the journal row
`release`, 80); the door signing `v` inside the proof's array as `[[e, p, h], …]` under `fero-door/2`. The four items
of the note above are closed first: (1) `HELLO_WORD`, pinned by `askAfterHello`; (2) `lostRelease` and `askAtAdmit`
pin the two `onAdmit` lines (the first draft of `lostRelease` lost nothing — the drain carried the release before the
cut — and was redrawn so the cut falls between the stayer learning the hold and the release leaving; the mutant then
goes red); (3) `freshLinkSim` counts only a far-side node writable at view 1 beside a higher writable view and is
"not the shape" unless n01 evicts both; (4) the signing, as above. Stripped, as §10.10.9 said: the `V` variants,
`#voteTick`, `#tickNo` and the `tick` field of `#heldPeers`.

The acceptance of §10.9 step 2, measured on the built kernel (`sim/leave-harness.test.ts`, 18 of 18): `evictTwo`
cut and crash, `evictTwoB` and `releasedEarly` 0 of 5 (the base 1, 2, 4, 5 and 1, 2, 3, 4), the k=1 control 0;
`keptBallot` refused at cc and dd, end `aa@2{bb,cc,dd}r:evicted bb@3{bb,cc}W cc@3{bb,cc}W dd@2 r:minority`, no split at
any epoch; `keptBallotReversed` `aa@4{aa,dd}W bb@2 r:minority cc@2 r:held dd@4 W`; `genesisSplit` dd and ee at epoch
0 beside `{aa,bb,cc}`@2; the quiet-point witness `cc held, dd and ee minority`, no split; `lateView`'s mid `cc held`;
`lateAsk` and `freshLink` one writable view at every point; `freshLinkSim` 0 of 4000 on every seed that reaches the
shape (n03 `held` before the flap, the monitors quiet; seed 3 at 3-40 reaches the shape and seed 5 does not, the
base the other way round); `proposerDeadStale`'s mids bb and cc `held`, dd and ee `minority`, the same ends;
`retrySameEpoch`'s mids bb and cc `held`, the same ends; `twoFailedBallots` nobody held at either mid (disowned
within the settle); `flapDuringBallot` and `proposerCrash` writable everywhere; `pledgeTwo` safe and settled 5 of 5;
`allHeld`, `genesisProposerDies`, `clientAsk`, `clientGenesis`, `serverAsk`, `helloHold` as on the base; NOT ONE pin of
rebirth (20), the isolate grid (24), the seeded isolate family (8), the crash grid (10), `evictsplit` or `joinsplit`
moved. The two CP costs, pinned on purpose: `proposerAndGranterDie` `cc, dd, ee @1 r:held` for good (the base
re-formed `{cc,dd,ee}`@3) and `genesisProposerAndGranterDie` everyone at epoch 0 (`bb P(2,2)` six times, `a2 P(1,3)
P(2,3)` five times at the SAME epoch, bb's vote with one earlier vote behind it — the same-members clause). The
fifth round: `askAfterHello` cc `minority` the instant dd's install lands (the mutant that keeps the HELLO's key as
the last word shows cc writable there, counting a held dd, for one round); `lostRelease` dd writable after the fresh
HELLO (the mutant without the `onAdmit` delete: `minority` for good); `askAtAdmit` dd `minority` at the admit and
writable once the ask on the fresh link landed (the mutant without that ask: `minority` for good). Eleven one-line
mutants, each caught by its own pin: the HELLO's `v` (`freshLinkSim`: 160 split-ms and one n04 `gateOpen` on seed 4
at 3-40), the same-members clause (`P(3,3) P(4,3)`, bb's vote at 4 with three behind it), `HELLO_WORD`, the two
`onAdmit` lines, the gate's `held` line and the joint commit (`evictTwo` seed 1 splits), the stayer's count (`lateAsk`
two writable views), the disown (`twoFailedBallots` bb and cc held at both mids), the client guard (`clientGenesis`
never forms, `P(1,3)` three times), the member filter (`serverAsk` `P(2,4)` three times).

What did NOT move: the golden (`sim/exec.test.ts`, 20 seeds), the 300-seed leave sweep's lists, the 59,500 and
104,050 counted formation pins, the 1..2000 explorer, the 2001..2300 quiet explorer, the leave sweep's knock-window
tests, and the 31 membership pins of before (now 46 with the rule's own: the vote memory, the hold and the held
voter's grant, form (β) and the install, the joint commit, the stayer's count, the ask, the malformed `v`, the
release; one door pin for the signing). The PROPOSE frame grows by `o` on every ballot and by `j` only when joint; a
fresh node's HELLO is byte-identical; no ask at epoch 0. Perf: the 27 pins of `kernel/node.perf.ts`,
`kernel/alloc.perf.ts`, `kernel/write.perf.ts`, `tests/baseline.perf.ts` and the two counted pins of
`sim/scale.perf.ts` pass; `gate()` measured by hand on this box (`gate()` in a loop, 1M calls, four admitted links,
base and built back to back, the absolute numbers swinging with the box's load so only the A/B is the claim): the
common case neutral against the base; the held case, before the fifth review's memo, 0.9-1.1 µs on `votedFor` alone
and 4.1-4.3 µs with four earlier votes behind it — linear in `prior`, which grows only by one per failed joint ballot
while the member learns no view (§10.10.7). The fifth review's numbers, with the memo, are in its note below. The ask
costs one PULL per member link per tick while held and one per change; nothing while nobody holds anything. Not
measured here: the ask under the real-TCP tier (the battery's TCP tiers run the kernel unchanged with no held member),
the growth of `prior` under the explorer with a hold that never ends (bounded by proposers; left unbounded on purpose).

The STATUS lines this closes: the two-suspect split (`evictTwo`, `evictTwoB`), the kept ballot, the genesis split;
the I-20 line's release sentence. What the rule costs, in one line: the far side of a cut, the third granter of a
two-evictee ballot whose proposer and other granter are dead, and the one survivor of a genesis ballot are read-only
until the cut heals or an operator forgets the dead — the CP answer, where the base wrote on both sides.

**2026-10-12, the fifth review (the skeptic's, after the build): one major, two minors, three nits — each closed
where it lives, five commits on top of the build.** The major was a hole in the ARGUMENT, fixed in §10.10.4 first
("supersession needs a ballot, and someone must open it"), then in the harness (`keptBallotProposerGone`), then in
the kernel: the kept ballot in the reversed order with its proposer GONE left bb `minority` and cc and dd `held` for
sixty rounds with every link among them up and cc and dd two of the held view's three — line 6's own liveness claim
denied by the built kernel, because no membership change ever opened a ballot (aa was no member of view 2) and, with
aa alive but evicted, because the ask went to members only and never reached the one node that could disown. The
kernel gained two lines of the argument: the ask goes to the proposer of every vote above my view, member or not
(`#askTargets`, §10.10.6), and the lowest live member opens the superseding ballot when nothing else would
(`#openOverHolds`, §10.10.4) — the same members at the next epoch, past the holds' epochs, joint, only when it can
commit, never for a hold of its own. The three variants are pinned (`evicted` released by the disown before any tick,
bb proposing nothing new; `open` and `committed` superseded by `P(4,3)`); the two one-line mutants are each caught by
the variant that names them; no other pin of the harness moved (18 of 18 before the new one, 19 with it), and the
three CP shapes stay three. The minors: `holds()` fell off its fast path for good on a vote above the view that is
no hold (one apart: the common state after any failed one-member ballot, until the next install) — now memoized on
the identity of `votedFor` and `view`, which every grant, own ballot and install replace, with the disown's in-place
`f` mark dropping the memo by hand (measured on this box, 1M `gate()` calls with four admitted links, built tree with
the memo disabled vs enabled, back to back: one apart 1073-1078 ns → 227-260 ns, the common case's 225-282 ns; held
on `votedFor` alone 866-1064 ns → 59-84 ns; four earlier votes behind it 4.1-4.3 µs → 65-102 ns; the base's common
case in the same session 179-195 ns, so the absolute numbers are the box's and the A/B is the claim — this replaces
the earlier note's "205 ns", the third nit); and a member's malformed hold was trusted — `h: ''` is a view nobody can
be a majority of, so one such word from a member made the receiver skip it for good and every ballot joint over it
unable to commit — now one check (`holdOk`: a positive integer epoch above the asker's, a non-empty member list)
serves the HELLO (`holdsOk`, malformed) and the PULL (dropped). The nits: a refusal's `hm` widened the open ballot
on any same-epoch refusal, before the identity check — a late refusal of an earlier same-epoch ballot of mine could
leave a phantom joint set for a proposal age; now `v.h === p.h` guards it, as the grant count does. The ask at
admit's lack of a member filter is kept and explained in place: it corrects the HELLO, which told any peer, so the
fresh link is admitted knowing the holds as they ARE; the periodic ask is the narrower one (members and my
proposers). Pins added: three in `kernel/membership.test.ts` (46 → 49: the memo's identity, the ask reaching a
non-member proposer and not a bystander, the opener with its two negatives — the held view's majority out of reach,
and a hold whose proposer is me), two steps in existing ones (the malformed hold on both frames; a refusal of another
ballot widening nothing), and one in `sim/leave-harness.test.ts` (18 → 19). Every new guard was mutation-checked once
(the memo twice: never read, never dropped). What the opener costs: one same-members ballot, once, in a shape no
membership change would reach — and `tick` reads one map size (`#heldPeers`) to know it has nothing to do.

**2026-10-12, the sixth review (the skeptic's second pass, over the five fix commits): ship, one minor — closed
in the argument (§10.10.4 above), the harness and the kernel, two commits on top.** The opener did not wait on the
eviction's `dialing` hold-back (V4-39): while the lowest member was still redialing a suspect, a held member's ask
made it re-propose the FULL view, suspect included, which burned an epoch and undid the suspect's own two-member
eviction for one epoch before that eviction won again — safe, but the doubled ballot the page said never happens
(it said "nothing while a ballot is in flight"; here the eviction was held back, not in flight). The pin for it
found the window wider than the review said: a member whose link is lost is neither linked nor a suspect for
`suspectTicks` ticks, and in that window a suspect guard (the review's fix, and the first draft here) still let the
opener fire — the kernel pin's first tick read `P(3,5)`. So the guard is one comparison in `#openOverHolds`:
`reachable` must be EVERY member of my view, not a majority. A lost member is a membership change in the making
(a suspect, then its eviction, joint over the same holds, held back while its chain dials) or it is back in a tick;
either way the opener has nothing to stand in for. Every other case the review's narrower guard covered is already
stopped: when the eviction fires it sets the proposal, which the opener yields to; when the live set is a minority
or I am not its lowest, the opener's own checks stop it. Pinned twice: `kernel/membership.test.ts` (49 → 50: aa at
view 1 of five, bb's link lost and its chain running, dd's ask naming bb's `{bb,dd,ee}`@2 — nothing at the first
tick with bb not yet a suspect, nothing through `suspectTicks` more with bb a suspect still dialing, then `P(2,4)`
joint over `{bb,dd,ee}` the tick after the chain gives up) and `sim/leave-harness.test.ts` (19 → 20:
`openerBesideSuspect` — `fresh` (bb not yet aa's suspect) and `dialing` (a suspect, the chain running): aa proposes
nothing at the mid, and bb's ballot, already in flight, wins, `{bb,dd,ee}`@2 with aa and cc evicted across the cut;
the given-up control: `P(2,4)` at the mid, the ordinary duel, `{aa,cc,dd,ee}`@3 with bb evicted; without the guard
`fresh` and `dialing` read `P(3,5)` at the mid and end at `{aa,cc,dd,ee}`@4, with `{aa,bb,cc,dd,ee}`@3 installed
everywhere in between). Which side of a cut wins the duel was never the opener's to decide; the guard only stops it
from entering one. Mutation-checked once (the comparison back to a majority: both pins red, no other). No other pin
moved.

**2026-10-12, the seventh review (the skeptic's third pass, over the whole tree at ca98049): ship, one minor and
one nit — both closed on the page, two commits on top.** The minor was the record, not the kernel: the implementer's
report and its ledger text described the build at its eleventh commit (964 tests, a rule without the fifth and sixth
reviews' two lines), while the tree had eighteen commits and 970 tests (`kernel/membership.test.ts` 38 → 50,
`sim/leave-harness.test.ts` 17 → 20, `kernel/door.test.ts` 34 → 35; two full batteries at ca98049 read 970 of 970
and the 18-clause data contract), the ask to a non-member proposer (`#askTargets`), the opener (`#openOverHolds`,
every member linked), the `holds()` memo, the empty-hold check and the `hm` identity guard. The built note above now
says its counts are the build's at the time and the tree's are in the review notes; the ledger the integrator gets is
written from the tree. The nit: the opener's trigger reads only linked members' holds, never the lowest live member's
own, while its joint set reads both — §10.10.4 now says why that is complete (the proposer of my own hold is a linked
member, a lost member or a member of a view above mine, and each of those already has its path), and why the fold
was NOT made: the shape it would catch cannot be built, so the guard would have no pin. No kernel line moved; the
comment on `#openOverHolds` carries the same three lines. The targeted suites, the four gate-path perf files and one
full battery were run on the final tree; their numbers are in the lane's report, not here.
