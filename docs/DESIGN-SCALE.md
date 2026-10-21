# DESIGN-SCALE — scoped replication at scale, designed once (wave 4)

*Status: the design record (2026-10-09). Nothing is built. The owner reads
this first; the build waits for the yes in §14. Three proposals and three
skeptic critiques went into it (a protocol angle, a storage angle, an operator
angle). Where a skeptic disagreed with a proposal, this record sides with the
evidence and says so. Every file:line below was read on the tree at
`e9c1a77`. Three of the panel's probes were re-run here, read-only, through
the low-priority runner; §2 says which. The DECISIONS number is assigned at
landing.*

Terms, each explained once. A **partition** is a top-level row; `replicas: N`
puts each one on exactly N members, its **holders**; the first holder is the
**owner**, the only one that stamps new records for it. A **lane** is one
node life's stream of stamped records (its origin). A **floor** for (lane,
partition) is the highest seq a node can prove it holds or covers for that
pair (kernel/streams.ts:39-45). A **tombstone** is the stamp a remove leaves
behind so an older write still loses (kernel/node.ts:1596). **Compaction**
drops log entries that are no longer their cell's winner (kernel/log.ts:91-
108). **Anti-entropy** (AE) is the background repair that ships what a peer
lacks; today it runs on a **digest** (every lane's tail) that every pair of
members swaps every heartbeat (kernel/node.ts:714-731). An **orphan** is a
partition a node still has but no longer holds; it is frozen until its
**shed** (kernel/scope.ts:19-25). A **latch** is the one-teacher transfer: a
node behind on a partition asks one holder, which ships what the learner
lacks and then an attested **cut** (its floors) (kernel/scope.ts:480-499).
An **epoch** numbers a committed member list (a **view**). The **sim** runs
the same kernel bytes on a seeded schedule; a **monitor** checks an invariant
after every event; a **pin** is a counted or timed number a test refuses to
let drift.

**Note, 2026-10-09 (stage 0 built).** The harness of §6 and §7's stage-0
row is in the tree, sim only plus the one kernel line §2 names. Monitors
M1-M9 live in sim/monitors.ts (M4 is a stub that goes red once
`node.byPart` exists); each has a planted-violation test and was
mutation-checked (sim/scale-probes.test.ts). A tenth, M10 resync-end,
was added for a finding below. The adversaries A1-A11, the frame tally
and the mutation runner live in sim/scoped-sweep.ts; the sweep runs 2
seeds per family in the battery plus every pinned unsafe seed, more with
`FERO_SCOPED_SEEDS`. What the build found against this record: (1) the
§2 seed probe holds: a boot record written ahead of its WAL rows restored
a floor the disk did not back; the restored `s` is now capped at `d`
(kernel/node.ts), which moved 4 of 12 A4 sweep trajectories and none of
the 25 CHURN seeds. (2) The join floor re-measures at 2,446 HAVEQ, not
2,555, for two reasons: the panel's probe fired its 300 writes at
8.1-8.4 s, inside the window it called idle, and the sim pairs a joiner
at its default delay [1,5] unless told otherwise (with the joiner at
[1,5] the join costs 2,585); 1,067 for the writes and 52,110 DIGEST for
the join stand. (3) A10 IS representable: a sever's linkDown travels at
the pair's delay, like a FIN behind data in a slow buffer, so with only
the dying member's pair to one co-holder slowed, its frames land after
that survivor installed the view without it, on a link still up, and the
kernel applies them (8 of 8 seeds). That is §5's shared residual, so §14
Q15's one-epoch GC floor is warranted. (4) Both unscoped probes reproduce
without the test seams (a clean leave moves ownership; `severOnFrame`
strands the zombie's write), pinned red today; M6 is red on the zombie
at the release itself. (5) Two new findings from the sweep, pinned as
known-unsafe seeds. One attempt committed twice across an ownership move
(A3 seed 6): the owner was cut off 1.5 ms after committing, before its
fan-out or its WACK left, the issuer retried at the next owner, and the
heal delivered both. It is the zombie's class, not missing dedup tuples
(the latch already feeds the window). And a spoke's resync ending on a
stale digest reply (A11 seeds 2, 5, 6 and 10, M10): on every A11 failover onto
a feeder behind the spoke, the reply to the spoke's first digest ends
the resync before the re-download, so the spoke shows older values of
live rows for a few events. (6) The G1 mutation (release the stamp, keep
every lane) is caught only where an older record still arrives (A1,
A11): today every lane keeps the remove, so a refold re-derives it;
stage 3 is what makes G1 bite.

**Note, 2026-10-09 (stage 1 built, without the drain).** Three of §7's
stage-1 parts are in the tree; the drain (part b of the row, Q8) waits
for the owner's answer and `#finishLeave` is untouched. (a) The `acked`
effect: an armed owner names its lane (with its incarnation) in the WACK
(`o`), `onAck` emits `sink.acked(iss, cid, origin, seq, epoch)` for a
cleared attempt this node issued whose record will never fold here
(scope.expects: not held, acquiring or assigned), a relay hops `o` to
its spoke only in that same case, and the Bind settles it through the
`lost` path. Where the record WILL fold here the WACK stays silent and
the apply join settles after the value shows (V4-7): the WACK lands
first on the same link, so settling from it would resolve a write
before its value showed. Unscoped nodes never set or read `o`. The
STATUS probe is now api/scoped.test.ts ACKED (six `methods.update`
from the non-holder, six ok; a spoke through it; a delete from it).
One rule the old hang had hidden: the lens swallowed a delete of a
cell absent from the local fold as a no-op, which on a scoped
non-holder is wrong (the row lives at the owner); Bind #local now says
a scoped node's fold speaks only for the partitions it holds. (b) The
Q12 hook: NodeOpts `admit(rec)`, Bind.hole (the sparse-hole half of
admit), run by an armed owner on a member-forwarded remove below the
row; refused ⇒ WNACK `invalid` + reason, staged ⇒ `withheld`. (c) The
indexes: `node.byPart` and `node.tombs`, allocated with `scope`
(replicas > 0), null unscoped; ten maintenance sites (commit, inbound,
splice, both replay branches, the ACQDONE fold, the shed, compact,
#resetFold; apply's three tomb sites, GC); #teach, #tailsOf, #abort,
#shed and rescope read through them. M4 is live in sim/monitors.ts
(entries by identity and order, tombs against versions-minus-state);
the mutation "drop the inbound indexAppend" turns it red in five
scale-probes tests. R1 (kernel/scope.perf.ts) measured 0.98 (2.69 ms
vs 2.73 ms, tmpfs, low priority) against 9.40 with the old lane walk.
Found while building: the old shed walked `node.logs`, so a stream with
no lane at all (a floor learned from a cut, with no record of that
origin) kept its floor past the shed; it now drops from every stream
(the first version of this note said "lanes with no entries of p" —
those the old walk did visit; the skeptic's reading). One claim
narrowed by the same review: `#shed` is O(the lanes that hold p), not
O(entries of p) — a lane is an array and each lane that holds p is
filtered whole; the index saves the lanes with nothing of p and the
version-key parse. `#teach`, `#tailsOf`, `#abort` and the census are
O(entries of p) as stated.

**Note, 2026-10-09 (stage 1 reviewed).** The skeptic's pass found three
holes in the build above, all fixed. (1) `acked` never fired on one
recovery path: a commit that entered the owner's dedup window through an
ACQ fold or a WAL replay had no lane, so a write re-sent after a lost
WACK was answered without `o` and a non-holder issuer still timed out;
every window site names the lane now (kernel/scoped.test.ts 'ACKED
after a lost WACK'). (2) A client of a scoped primary lost its plain
deletes: its fold is the feeder's held shard, so a row it wrote through
a non-holder never showed, and once `acked` settled the write the lens
swallowed `delete client.data.k` as a no-op. The kernel keeps the
primary's HELLO contract on the link (`node.feederContract`, read live
like the methods-only hint) and the api reads `replicas=` out of it: a
client of a scoped feeder has no local partitions, so such a delete is
forwarded. (3) `until()` in #utils did not await an async check, so the
api pins built on `until(async …)` could never fail; it awaits now and
the ACKED test goes red without Bind #local. Also from the review: the
shed sentence and the `#shed` O() claim above are corrected; the
compaction site of the index is pinned by a direct `compact()` call
(no armed node reaches it before stage 3); Q12 gains the relayed client
remove and a mixed forwarded batch; R1 times the two nodes interleaved
and reads 0.88 (0.95 ms vs 1.07 ms). Still open from §14: Q8 (the
drain) and the yes on stages 2-5.

**Note, 2026-10-09 (stage 1, second review).** Two holes were left,
both closed. (1) The `acked` decision was made once, at the WACK: a
co-holder whose record was expected to fold here (acquiring, or
assigned with no entry yet — the review's K2/K3) was WACKed silently,
and if a view change then moved the partition off it before the record
landed, nothing ever settled the write. The write pipeline now keeps
such cleared attempts (`#awaiting`) and the install's rescope settles
every one whose partition no longer folds here: `acked` for an own
attempt, a second WACK with the lane for a relayed one, which its
spoke reads as the settlement (kernel/scoped.test.ts 'ACKED after a
view change'). The STATUS line about `methods.update` from a
non-holder is closed for every shape the review named. (2) The client
delete rule read the feeder's contract live off the primary link, so
with no primary (an outage, not only the first milliseconds) a scoped
client looked unscoped and swallowed a delete. The kernel now
remembers the last primary's contract, and with no contract known at
all (before the first HELLO) the api forwards the delete: the rule
fails toward sending (api/scoped.test.ts 'OUTAGE DELETE', its unscoped
control, and 'PRE-HELLO DELETE'). What is still not settled: a spoke
whose feeder DIES between the WACK and the tap (a link loss, not a
scope change) — the relay's bookkeeping dies with the link, and the
spoke's write waits for a value that reaches it only if its next
feeder holds the partition. That is the one residual of the `acked`
effect.

**Note, 2026-10-11 (wave 5e: the feeder-death residual closed).** The
residual above is closed, and the fix settles, never re-commits. What the
repro showed first (sim/feeder-death.test.ts): the common order is not the
owner's WACK. The owner flushes its fan-out before it answers, so a
co-holder relay folds the record first, and the replicated record clears
the relayed attempt and hops the WACK to the spoke at once; the tap rides
the frame's flush right behind it on the same link. A link that dies in
that gap leaves the spoke with its WACK (the attempt has left its queue,
nothing is re-sent) and without the value. Shape chosen: the spoke keeps
the coordinates itself. An armed relay that expects to tap the record
names the lane in the hop as a new optional key `l` (all three hop sites:
the owner's WACK in onAck, the in-order clear in inbound and the interior
clear in #splice); `o` keeps its meaning (settle now, no tap is coming). The spoke keeps each such attempt in `#awaiting` while its record
is unseen; the fold sites drop it. At a primary failover the spoke marks
every kept entry (`strand`), and at the end of the resync onto the next
feeder it settles every marked entry still unseen through `acked`, on the
owner's lane (`settleStranded`). A record the next feeder holds comes in
its ship first and settles through the join, after its value shows (V4-7).
A scoped feeder elected at an admit with an empty fold resyncs when
something is stranded, so the end comes. A spoke past dedupKeep kept
entries settles the evicted one from its coordinates. The other shape the
plan named, asking the new feeder to settle each attempt from the owner's
dedup window, was not needed: the spoke already holds the answer the
window would give, so nothing asks the window, an aged-out window changes
nothing, and no `unknown` outcome is needed. One trade the fix makes (new
with it, not left over): a next feeder that holds the partition but has
not yet received the record when its ship leaves. Before wave 5e that
schedule kept V4-7's order (the record reached the new feeder later, it
tapped it, and the join settled the write as the value showed). Now the
resync's end settles it through `acked` first, and the value shows as
long after as the next feeder lags the record. Nothing in the kernel
bounds that gap; it ends when the record reaches the next feeder and is
tapped (measured 43-48 ms in the review's probe, n=4 R=3, where the
owner's record frame to the next feeder is lost with their link and the
gap is the redial; pinned as a known cost in sim/feeder-death.test.ts,
on STATUS). The same trade reaches one step further: if the spoke writes
the same cell again in that gap, the early-settled write's late record
reaches the api as a foreign apply (its pending entry is gone), the
api's settlement probe runs, and it can resolve the newer write, WACKed
but not yet tapped, from the dedup window before its value shows (the
second review's binding-tier probe; narrow: the lag window, a rewrite of
the same cell, the newer WACK overtaking the older record, and the two
taps in separate steps). The spoke cannot tell "holds it but
lags" from "does not hold it" without knowing its feeder's holdings, so
keeping the order there needs a new piece of protocol. The costs that do
stay from before: a spoke with no feeder at all keeps the write
pending until a feeder admits it. A feeder that sends no `l` (a feeder
older than this note: mixed versions, V4-14) still strands its spokes.
And `l` is the feeder's expectation, not a promise. A relay that is
ACQUIRING the partition when its spoke's write commits hops the WACK
with `l`, but at ACQDONE it folds the teacher's copy through node.apply
and taps nothing to its spokes (scope.ts onAcqDone; only the live span
above the cut goes through inbound). The spoke's floor exchange ships
only what is above its own tail on that lane, so once that tail has
passed the write's seq the record never comes while the feeder lives.
The write stays pending until a failover's resync end or the dedupKeep
eviction (before wave 5e: for ever). This gap is older than wave 5e
(V4-33) and lives in scope.ts; it is on STATUS for the next change
there.
Unscoped feeders never send `l`: unscoped bytes are unchanged.

**Note, 2026-10-10 (stage 1 complete: the drain, part (b)).** The owner
said yes to Q8 (DECISIONS V4-31), and the drain-then-go is in the tree.
What "drained" means, in the kernel's terms: the shed bar. Once the view
without the leaver has committed and echoed, every partition it held is
an orphan (the install's rescope froze it, kernel/scope.ts) and the new
holders acquire from it as from any orphan. A partition is drained when
every REACHABLE current holder (an admitted, live link) has attested, in
a HAVEA ok or a HAVEQ announcement, floors at or above the orphan's frozen
content tails on every lane — `evaluateSheds`' quantifier narrowed to the
holders that can still answer (`Scope.undrained`); when every holder
covers, the entry sheds and leaves the count by construction, so the
journal reads orphaned → teachShip → shed → left. The acquirer's ACQDONE
alone is not proof: its attestation comes after its fold (durable: after
its snapshot echo, `sealed`), on the leaver's next shed poll. The hold:
`Membership.#finishLeave` no longer ends a scoped leave at the exit
proof; it asks `#exit`, which holds `left` (`leaving.drain` counts
ticks) while something is waiting and the heartbeat clock is on, and
goes at once otherwise. The bound is the new tune row `drainTicks` (16;
not a config key). Past it, or when nobody can be drained to (every
holder of some partition unreachable; the solo view, reached through
`leave()`'s "nothing to leave" branch), the leaver goes at once with a
new journal row `undrained` (a = partitions) and `left` b=0; the api
folds it into `cluster.me.undrained`, the shell's destroy cap adds
`drainTicks` on a scoped node, and `destroy()` resolves the verdict
(`Promise<boolean>`). One reading of §6 I13 changed: it said "or no
reachable member is a current holder" counts as `left(true)`; the §7
row and Q8 say nobody-to-drain-to is `left(false)` with `undrained`
counted, and that is what landed — a stop that could not copy its rows
is not reported clean. Heartbeats off: no drain clock (the shed poll
never runs either), so the leaver decides at once from the evidence. A
leaver cut off while draining has left its own view; when the survivors
installed that view too they never suspect or evict it (suspicion ranges
over view members). A leaver bounded out of the view half drains on its
own install alone: the survivors may still hold it and may evict it under
V4-20 while it drains, at no cost — cut off, it is stranded and goes at
the next tick. Either way the leaver goes at the bound, or at the next tick
once every holder is unreachable (a link loss is not a tick: `linkDown`
only aborts latches, and the bar is re-read on the heartbeat). Two
leavers at once: the first drains to
the second (a live holder, leaving or not), which drains on. M9 flipped
from red-today to green in the scoped sweep (a leave-drain violation is
now unsafe) and in sim/scale-probes.test.ts (3→2→1 at R=1, two leavers,
the cut-off leaver). The unscoped leave is byte-identical (no scope ⇒
`#exit` is never asked): the golden, the 300-seed sweep, 59,500 and
104,050 stand. Scoped trajectories with leaves moved (A6's leave leg, A7).

Three readings that differ from the §7 row's words, settled at the
review of the same day. (1) The row says the hold waits for a "live,
non-leaving" holder; what landed waits for every REACHABLE holder,
leaving or not. A holder that is itself leaving still acquires and drains
on, and knowing who is leaving would need the ballot code (the leave
chain's lines); two leavers at once both finish clean inside the bound
(sim/scale-probes). (2) At R≥2 a holder that is unreachable and never
attested does not hold the leaver: once the reachable holders cover the
frozen tails the drain ends `left(true)`, with no `undrained` row, while
the orphan itself stays unshed (the shed still wants every holder) for
the teardown to take. The data is safe (a live copy exists; M9 agrees),
and I13 above now says so. (3) A leaver whose vote never came back
(leaveTicks) goes like a crash and never drains: no install froze its
partitions, so there is no orphan to hand over; `undrained` counts the
drain window only (kernel/drain.test.ts pins it). Two more facts from the
review: the sweep's battery seed count (2) gives A7 only R=2 shapes, so
A7 always runs its seed 4 (n=2 R=1), the shape on which M9 can bite; and a
lawful scoped stop can outlast `fero.spawn`'s 5 s stop grace (up to
max(leaveWindow, leaveTicks) + drainTicks + 3 heartbeats, 17.5 s at the default cadence since the knock window of V4-39, when
a new holder cannot attest) — the README says so rather than the grace
being raised, since spawn cannot know the child's cadence.

Two more notes from the second review of the same day. (1) §9 lists
`undrained` among the scalars `cluster.partitions` gains; it landed on
`cluster.me.undrained` instead, because a stopping node paints no
partitions frame (api/index.ts fold: the shrunk view installs on the
leaver too, and a screen must not end on the survivors' picture), while
the `me` row is still written before the teardown. (2) A cost the §7 row
chose, named here so nobody reads it as a bug: at R=1 a new holder that
crashes mid-drain takes with it the rows it was about to receive. The
leaver sees the link die, finds that partition with no reachable holder,
and goes at the next tick (about two heartbeats after the crash in the
sim, the link death included) with `left(false)` and `undrained` counted —
honest, and the rows are lost unless the leaver kept a `dir`. The
survivors evict the crashed holder afterwards and re-range the
partition, but the leaver did not wait for that: waiting "while any
other member is reachable" instead was tried at review (n=4, R=1, five
seeds) and kept every row, but ended only just inside the 16-tick
bound, because the eviction waits out the redial chain first. Whether a
holderless partition should wait for a re-range while other members are
still reachable is the owner's call (a Q for §14 if wanted); today the
rule is the row's: stopped at once when nobody can be drained to.

One more from the third review of the same day: a leaver bounded out of
the view half (leaveTicks, no survivor echo) drains all the same when its
OWN view no longer holds it. That is the proposer's shape: it commits the
shrunk view from the votes alone, its partitions freeze into orphans with
reachable new holders, and the echo is lost. Before, `#finishLeave(false)`
skipped `#exit`, so at R=1 the only copy went with the leaver and
`undrained` read 0. Now the drain runs and carries the view half's
verdict: the rows are handed over, but `left` is b=0 even when every
holder covers, because the commit was never proved to have reached a
survivor; past the bound, or stranded, `undrained` counts what went.
Reading (3) above narrows to its real case: a leaver STILL IN its own
view (the vote never came back) has nothing frozen, goes like a crash
and counts nothing (kernel/drain.test.ts pins both).

**Note, 2026-10-10 (stage 2 built: announce-on-change anti-entropy).** The
§7 stage-2 row is in the tree in four commits (the keys; the announcement
plan and the targeted rounds; the member digest's retirement; the spoke
path). What landed, where it differs from §3, and why — each difference
settled at the build with its reason, for the two reviews to weigh.

*What landed.* On an armed node the heartbeat sends no DIGEST on a member
link, and the DIGEST handler ships no suffix to a member (the frame still
syncs the link and answers r=0: an admit, a drain). A client link is
unchanged. Repair is the holder handshake: the owner's announcement of what
it stamped (one batched HAVEQ per co-holder at the next tick), the
never-answered leg (a co-holder that never attested a held partition is
asked every tick until it does), the orphan poll, the probe-driven round,
and the sweep (`aeFan` 8, a tune row: the next aeFan co-holder links in
uuid order behind a cursor that survives installs, each told every held
partition it shares). `round(node, only?, parts?)`: the post-fold and
sealed rounds go to the partition's holders only, the admit and drain
rounds to that one peer for what the two share, the install's round is the
full one. HAVEQ carries `d` (a durable node's durable floors), `g` (the
partitions the sender is gapless for: content tail = floor on every lane)
and `x` (released, sent by the shed to the current holders, batched per
link per step); a HAVEA partition answers `g: 1` and `x: 1` (none, where the
old code was silent). No MAGIC bump (V4-14). Paused links are skipped by
every leg.

*The numbers.* The counted floors of §2 re-recorded (sim/scale-probes):
idle member DIGEST per tick 870 → 0 (and 930 → 0 after the join); the join
window's DIGEST 52,110 → 60 (the joiner's 30 admit exchanges, two legs);
the 300-writes window 1,067 → 5,337 HAVEQ (the sweep: 20 ticks × 30 × 8 =
4,800 frames, plus the owners' announcements merged per link) and its
RECORDS exactly 300 × (R−1) = 600; the join 2,446 → 14,791 HAVEQ (about
13,500 sweep frames + the install round + 38 targeted post-fold rounds + 81
release frames). The pins of §8 (sim/announce.test.ts): **P1** idle n=25
R=3: member DIGEST 0, HAVEQ = HAVEA = Σᵢ min(aeFan, cᵢ) = 200 per tick
exactly, nothing shipped to a member; **P2** n=100 R=3 3,000 rows idle:
non-PING frames per tick exactly Σᵢ 2·min(aeFan, cᵢ) = 1,600 and 249,878
bytes (today 9,900 frames, 2.93 MB); **P3** one write on a settled n=100 R=3
mesh with aeFan 0: exactly 2 RECORDS deliveries, then 2 HAVEQ + 2 HAVEA at
the next tick, then silence. The unscoped pins did not move: the golden,
the 300-seed sweep, 59,500, 104,050, the idle law — no line of stage 2 is
reached on an unscoped node.

*Where it differs from §3, and why.*

1. **The dirty set marks at the stamp site only**, not at the fast path,
   the splice, the fold or the truing. On a scoped cluster a holder's floor
   moves at an inbound site only as the echo of the owner's stamp (the live
   fan-out, or that fan-out replayed from a latch buffer) — and the owner
   announces it; the fold, the seal, the arming truing and a boot each run
   their own round at once; a durable echo is carried by the next answer
   (`md`) or sweep (`d`). Announcing the echoes too would cost R(R−1)
   entries per write where (R−1) do the work, and §3's own frames
   arithmetic and §8's P3 count (R−1): the owner's. So the hot path is one
   `Set.add` per committed record on an armed OWNER and nothing on the
   inbound path (§8 budgeted both). Co-holder↔co-holder marks refresh at
   the sweep (a lap at most); the owner↔co-holder pair converges in one
   round trip.
2. **The drain round runs on every drain of an armed member link**, not
   only after a drop: every announcement skipped the link while it was
   paused, so the one round to that peer is what catches it up; the
   re-sync digest still follows a drop.
3. **P2's frame bound is the law, not 1,000.** With aeFan 8 at n=100 and
   c ≥ 8 everywhere the sweep is 800 HAVEQ + 800 HAVEA = 1,600 frames (§3
   says so itself); and a sweep frame is about 156 bytes (the epoch, the
   ~1.8 partitions a pair shares with their lane floors, the `g` list, the
   echoed `m`), so the idle tick is 250 KB, not 100 KB: 11.7× less than
   today. Stage 5's "lanes changed since the last answer" is the next cut.
4. **`aeFan` 0 is allowed** (ZERO_OK): the sweep off, announce-on-change
   alone — the measurement posture P3 needs ("then silence" is unmeasurable
   under a sweep); every real cluster keeps the default.
5. **The sweep's walk is O(held × R) per tick**, not O(aeFan × shared): one
   walk over the held entries builds the per-peer shared list the slice
   reads (and serves the dirty and never-answered legs). A per-link index
   makes it O(slice); that is stage 5's install work.
6. **A node teaches whatever it holds, mid-latch too** (kernel/scope.ts
   `#teach`; a change to C8's teacher side). The digest's suffixes had been
   masking a deadlock: two holders of one partition each ahead on a
   DIFFERENT lane (an owner change leaves exactly this shape — A2's demoted
   owner and the joiner that re-committed its attempt) each found
   themselves behind the other's announcement, latched each other, and an
   acquiring node refused to teach, so both timed out, aborted to orphan on
   their residue, re-latched at the next round and cycled for ever (A2 seed
   9 went not-live the moment the digest retired; live on the base tree
   only through the admit digest's suffixes). Now a node teaches its held
   base, its frozen orphan content or its PRE-LATCH base with its current
   floors as the cut — sound whatever the latch state, since floors never
   regress inside a life and a latch stages new records outside the lanes.
   I6's "h latches x and folds the gap" needed this to be true.
7. **The spoke path** (STATUS's three parked lines; the parked branch
   w5b/a11's probes rebuilt as tests, kernel/client.test.ts and sim/scale-
   probes). Every r=1 a client sends carries `q`, a server's r=0 toward a
   client echoes it, and a resync ends only on a reply whose q ≥ its own;
   what a stale reply shipped stays in the fold; in resync a client
   announces d = {} on every digest; a client whose resync ask is a tick old
   answers a feeder's r=1 with an r=1 of its own (the paused-feeder late
   end: one tick late at most, no re-ship at every heartbeat) — *amended at
   the second review (2026-10-10): that tick-age rule bought a ship per
   heartbeat on a link slower than one heartbeat; now the spoke re-asks only
   on the feeder's drain digest (`h: 1`) and sends no floor in resync, see
   the note below; and at the third re-check (2026-10-10): a feeder whose
   answer tears — its queue overflowing partway through the ship — resumes
   it at the drain, so a torn ship is a late reply, never a missing one,
   and the drain digest's `h: 1` is for an ask that arrived while the link
   was paused, see that note; made true at the resume-cost fix
   (2026-10-11): the ship stops at a full queue instead of overflowing it,
   and an answer stays resumable until its reply has left the queue, so a
   clear that takes a queued reply no longer costs a re-download*; and a client
   of a SCOPED feeder (`replicas=` in the feeder's HELLO contract,
   `node.feederScoped`) resyncs at every failover, unioning the sweep set
   when begun mid-resync. The sim's scoped clusters now carry the api's
   contract so a sim spoke reads it as a real one does (unscoped sim
   clusters send none). Member bytes are unchanged; an unscoped CLIENT's
   r=1 digest gains the one key `q` — the one place stage 2 touches a
   client's bytes, and no golden carries a client.
8. **The monitors** M11 resync-behind and the per-spoke screen check
   (`screenMatches`) came in from the parked branch as its reviews left
   them; the sweep's verdict names a screen-only row UNSAFE.

*The harness.* Every family safe and live; A8 heals; floors agree at the
horizon on every seed, and at `FERO_SCOPED_SEEDS=8` (the knob). The row
asks for M7 over 1,000 seeds: that is the script tier's run, not this
box's (its rules cap a lane at single files and one battery, so 8 per
family is what was run; the reviewed note below says what the review ran
on top). KNOWN_UNSAFE: A11's four
resync seeds leave (fixed; they stay in every battery as RESYNC_SEEDS, M10
and M11 green, a resync end on each); A3 seed 6 leaves — safe now, but
because its 1.5 ms window between the commit and the cut does not open on
the new trajectory, not because the class is fixed; A2 seed 9 enters so the
class (the zombie's: a commit stranded on a cut-off owner) stays pinned in
every battery. The scan of A2/A3 seeds 1-12 reads exactly as stage 0 did
(A2 seeds 9, 10, 12 unsafe; A3 seed 10's partition not held where the ring
assigns it). The mutation pins follow the trajectory: `drop-one` on A6 seed
3, A7 seed 4 and A1 seed 8, `version-only` on A11 seed 7, each scanned over
the family's seeds. Two debugger fixtures (tools/debug) followed the
trajectory; no kernel law they check changed.

*What stage 2 does not close.* The double commit across an ownership move
(the zombie's class; §14 Q7's decision); A3 seed 10's not-held partition
(pre-existing, unchanged). The record's I6 cadence bound now reads: within
one tick of the owner's stamp, at the next (re)admit or drain, or within
⌈c / aeFan⌉ ticks for a pair whose announcement was lost.

**Note, 2026-10-10 (stage 2 reviewed).** One review, ten findings, no
blocker, no hole in the protocol argument (the reviewer tried an
announcement lost on a cut, a paused link skipped by a sweep lap, a joiner
mid-announcement and a holder set changing between announce and answer:
each heals through the re-admit, drain or install round or the
never-answered leg). The one major finding was a hole in the HARNESS
argument, fixed in §6 first, then in the harness, with no kernel change.

*The harness could not see either repair leg.* The §7 gate says "harness
green with the stage-2 mutations caught" and §6 lists "a dropped dirty site
(M7)". The reviewer dropped the dirty mark at the stamp site and the sweep
went 13/13 green; switched the sweep off (`AE_FAN` 0) and every family
stayed safe and live. Why: M7's floor form checks floors, and the sim loses
no frame on a live link — every loss it can make (a cut, a pause, an
install) is followed by a round of its own, so floors agree whether or not
the owner announces and whether or not the sweep runs. What the two legs
repair is KNOWLEDGE: what each holder knows of its co-holders (its marks),
which compaction and GC will wait on. So M7 gained its knowledge form
(`marksAgree`, §6 I6 as amended): at the horizon every holder's marks of
each co-holder equal that co-holder's floors (durable marks the durable
floors). It runs in every family's verdict (`notLive`) and is green on
every family at 2 and 8 seeds per family. The two stage-2 mutations in the
runner: `no-sweep` (aeFan 0, the dirty leg intact) is red on A8 seed 3
(n=5 R=3) — "n02 knows n90's floor for 'p9' lane n01 as 4; n90 is at 30 —
never heard": a co-holder↔co-holder pair has no owner to announce for it;
`drop-dirty` (a per-event monitor empties every stepped armed node's dirty
set, with the sweep off so it cannot heal what the dirty leg should have)
is red on A8 seed 1 (n=3 R=2) — "n01 knows n02's floor for 'p319' lane n01
as 7; n02 is at 27", where `no-sweep` alone on that seed is green (the
control: at R=2 every pair has its owner). Neither is a safety hole:
`unsafe` stays empty, floors still agree. Mutation-checked against the
kernel once each: the dirty mark removed from node.ts's stamp site turns
the control red; `AE_FAN` 0 turns the seed-3 clean run red. Both M7 forms
now count what they compared (`eng.floorLanes`, `eng.markPairs`) and the
family test asserts both non-zero wherever a seed drew R ≥ 2 — the
reviewer noted the floor form had no counter (it compared 29-89 lanes on
18 of 22 runs, nothing at R=1, lawfully).

*The crossing double ship.* The new `resync` comment said a feeder's r=1
crossing the ask "costs no duplicate ship". The reviewer measured the
opposite: at a tick-aligned scoped failover the new feeder shipped its
whole held subset twice on 30 of 30 seeds (the spoke answered the crossing
r=1 with r=0, and in resync it says d = {}). The lane dropped the
duplicates; the cost was a second download per crossing (about
RTT/heartbeat of failovers). Now a feeder's r=1 that arrives inside the
ask's first tick gets no answer at all: the ask is on its way on this very
link (the single-feeder rule: only the primary reaches that arm) and its
reply is the end; the gate the crossing digest carried is still read. Out
of resync, and once the ask is a tick old (kernel probe B's rule), nothing
changes. Pinned in kernel/client.test.ts and, at the sim level, by the
four-seed scoped failover in sim/scale-probes.test.ts, which now cuts at
the feeder's tick boundary and asserts exactly one `aeShip` toward the
spoke (two before).

*The failover bug's second path.* The new kernel test's first run found
it: when the feeder dies with NO other link up, the linkDown arm finds
nobody, and the feeder admitted later is elected at the admit site — which
sent the spoke's REAL tails. The same shape as the bug stage 2 fixed (the
tails came from a feeder that held a different subset). A scoped spoke that
holds anything, or has a resync open, now resyncs onto a feeder elected at
the admit too (the open-resync case unions the sweep set, as the linkDown
arm does). A spoke that holds nothing yet asks its first feeder as before:
no byte of a fresh spoke's start changes, no journal row; unscoped is
unchanged. Pinned in the same kernel test with the first-feeder and the
unscoped controls.

*The smaller findings.* The gapless bit's last-value clearing on the HAVEQ
leg had no test (reversing it left everything green): now asserted on both
legs, with a pure probe leaving the bit alone. The §7 row's "skewed frames
dropped at a mid-announcement install" is now tested as an INSTALL between
the owner's announcement and the co-holder's answer (the answer is dropped
whole, the install's round re-asks at the new epoch, an answer at the new
epoch converges the marks). The RESYNC_SEEDS comment overstated what the
A11 sweep pins: as a sweep those seeds catch the two spoke fixes together
(each alone leaves them green); each alone is pinned in
kernel/client.test.ts. `#gapless` walks the lanes with entries of p, not
every lane with a floor for p: §3 now says so, with the stage-4 note that
the bit must be redefined once compaction drops entries below the floor
(the §3 "tail = floor" definition reads false at every compacted holder).

*What the reviewer ran that the lane could not.* The row's gate names the
sim:scale scoped scenarios; this box's rules keep a lane off sim:scale.
The review ran them alone at nice 15 on the built tree: exactly-3-of-100
5/5, rescope-storm-100 2/2, spokes-20-on-50 2/2 (unscoped, twenty clients
failing over at once: the new client `q`), all green. The row's "M7 over
1,000 seeds" is the script tier's; what ran is 8 per family, twice (the
build and the review).

*Left as questions and records, not code.* **P2** is pinned at the law's
1,600 frames and 249,878 bytes per idle tick, 2.5× above §1's and §8's
"under 100 KB" target: §3's own arithmetic gives 1,600 frames and a sweep
frame is about 156 bytes, so the record's target missed its own per-frame
body. 11.7× under today, but a design target missed, not a moved number —
the owner should accept it, or not, in the V4-39 text (stage 5's "lanes
changed since the last answer" is the next cut). **R2** (§8: armed commit
with the dirty mark ≤ 1.05× without, back-to-back) has no `*.perf.ts` pin:
a with/without ratio needs a kernel switch for the mark, and no measurement
deserves one. It is judged structurally — one `Set.add` of an already-held
string per committed record on an armed owner, nothing on the inbound
path, nothing unscoped — and by the build's scratch A/B (20,000 armed
commits, medians of 7, interleaved base/stage2/base/stage2: 173.2 / 195.2
/ 203.1 / 158.8 ms, 7.9-10.2 µs per commit: the two trees differ less than
two runs of one tree). P3 is the pin that would move if the mark cost a
frame. The parked branch's two scoped second-cut sim probes were not
carried over: the kernel-level mid-resync test pins the shape, and on the
new kernel a scoped failover is itself a resync, so the one assertion
those probes would add is "one resync end where there were two".

**Note, 2026-10-10 (stage 2, the second review: one ask per resync).**
The second review shipped the tree (772 tests, 50 pins, both run by the
reviewer) with one minor finding and three nits. The minor was real and
is fixed; the fix is one key on the wire and a simpler spoke.

*The finding.* In resync every digest a spoke sends says d = {}, so every
ask makes the feeder ship its whole held subset — and the ask's reply is
the end. The spoke re-asked on a tick-age proxy: its own heartbeat floor
every tick when its uuid sorted below the feeder's, and an answer to the
feeder's heartbeat r=1 once the ask was a tick old when the feeder's
sorted below. On a normal link that was one ship (50 of 50 runs, both
orderings, every cut phase). On a link slower than one heartbeat it was
one ship per tick until the reply landed: at 60 ms each way with a 50 ms
heartbeat, 2 and 3 ships; at 200 ms each way, 5 (feeder floors) and 9
(spoke floors), on every seed and phase, re-measured here. Every run
ended correct (B arrived, A swept, screen = kernel, one resync end): the
cost was downloads, not rows. The built note's item 7 said the late end
"never re-ships at every heartbeat"; that was true of a paused feeder, not
a slow one. Stage 2 widened the exposure (d = {} stays after records
land, and every scoped failover is now a resync); the api's default
heartbeat is 500 ms, so a real link pays this above half a second of RTT.

*Why the proxy, and what replaces it.* The spoke could not tell a
feeder's heartbeat r=1 from its drain r=1 — both are `{d, r: 1}` — and
the tick age stood in for "the reply should have come by now". The fact
it lacked: on this FIFO link the feeder answers an ask in the very step
that handles it, so an r=1 that lands before the reply was SENT before
the feeder handled the ask (the heartbeat floor crossing it), whatever
its age; and the only way a live feeder leaves an ask unanswered is its
queue overflowing while paused — the ask swallowed on arrival
(kernel/node.ts, the paused branch of the DIGEST handler) or its reply
dropped with the ship (kernel/link.ts `ship`: an overflow drops the whole
queue, and the shell steps `pause` inside a send, so a reply queued
behind a big ship can go with it). The feeder knows both: that is
`droppedWhilePaused`, and its drain digest is the one r=1 it sends
because of it. *Corrected at the third re-check (2026-10-10): that
premise was false. The likelier case is the SHIP torn and the reply
surviving behind its last frames — the ship loop ran on past the clear,
so the spoke's tails rose above the hole and its resync ended over it.
The feeder now resumes a torn answer at the drain and the reply follows
the whole ship, so the one ask a live feeder leaves unanswered is the
swallowed one; see the third re-check's note below. That was still not
quite true: a reply queued behind the ship's last frames went with any
later clear, and the spoke downloaded everything again. Since the
resume-cost fix (2026-10-11) an answer stays resumable until its reply
has left the queue, so now it is true; see that note.* So now that
digest, toward a CLIENT, carries `h: 1`
(`#sendDigest`; member digests never carry it — member bytes unchanged),
and a spoke in resync (1) sends no heartbeat floor to its primary (the
ask is the floor), (2) answers a feeder's r=1 that carries `h: 1` with an
r=1 of its own (a fresh q) — the exchange ships everything and its reply
ends the resync, one exchange after the drain, at any age of the ask —
and (3) answers any other r=1 from its feeder with nothing. A feeder that
dies is a failover, which asks afresh (`#resyncBegin`). The `ticks`
counter is gone. One ship per resync on any link, both orderings, every
phase (the four-seed and the new slow-link tests in sim/scale-probes;
2 seeds × 2 phases × 2 orderings at 200 ms each way: exactly one ship,
where 5 and 9 stood). The one extra ship left: a drain whose drop
happened before the ask arrived re-asks once more than needed — one per
drop event, never per tick.

*The wire.* DIGEST gains the optional key `h` on a server's drain digest
toward a client; no MAGIC bump (V4-14), the codec comment names it with
`q`. An unscoped spoke's digest bytes across a failover, a full outage
and a re-admit are identical to base once q is stripped (the reviewer's
probe re-run on this kernel: 223/225/224 digests on three seeds, 675
lines, no difference); inside a resync window an unscoped spoke now sends
fewer digests (no floor) — the one place its bytes change.

*The tests.* kernel/client.test.ts: probe B is rebuilt around the drain
digest — the drain r=1 INSIDE the ask's first tick is answered at once
(the case the review found untested: before, it was swallowed and the
end came one tick late), a heartbeat r=1 gets no answer, the tick sends
no floor, the floor is back after the end, a drain digest out of resync
is answered with the tails like any r=1; the crossing test's tail follows
the new rule; a feeder-side test pins `h: 1` toward a client and no `h`
toward a member. sim/scale-probes.test.ts: the slow-link failover. Red
on the previous kernel: client 19/22 (probe B at "the drain digest is
answered with a request", actual []; "the client's drain digest says
h: 1", actual undefined; the crossing test at "no floor in resync", two
digests for one) and the sim test at "O shipped its held subset to the
spoke exactly once", actual 5. Mutation-checked once each: `h` sent on
member digests too turns the member-bytes assertions red (client and
node tests, 3 reds); every feeder r=1 answered in resync turns probe B,
the crossing test and the slow-link sim test red (actual 6 ships). No
perf pin moved (sim/scale, kernel/node, kernel/scope, kernel/alloc,
tests/baseline, api/data run alone: all pass; 59,500, 104,050, the idle
law, fan-out 99, R1 ratio 0.91).

*The nits.* The counted-floors test is named after the floors it now
asserts (its name still printed the pre-stage-2 numbers). The bundled
commit (5ef923e: two kernel fixes and two unrelated test additions) stays
as it is — no rewrite of commits already on the branch — and is noted for
the integrator. The crossing comment's premise ("its reply is the end"
for any ask less than a tick old) is gone with the rule it described.

**Note, 2026-10-10 (stage 2, the third re-check: a torn answer).** The
third re-check ran the tree (774 tests, 50 pins) and found one major,
with a probe: a scoped spoke could lose rows for good when it failed
over or re-admitted and the new feeder's link backed up during the
re-download.

*The finding.* kernel/link.ts `ship` clears the WHOLE queue when a
paused link's bounded queue overflows, and the shell steps `pause` from
inside a send (shell/runtime.ts). The DIGEST handler's suffix ship
checked `paused` only on entry, so it could pause partway, have its
queue cleared, and keep going: the ship's last frames and the r=0 reply
went out at the drain, the spoke's lane tails rose above the hole, the
resync ended on the reply (its q matched), and the ghost sweep removed
the hole's rows from the screen. The drain digest (`h: 1`) was then
answered with those raised tails, so the feeder shipped nothing. The
probe — a real feeder Node against a client Node, pausing re-entrantly
after the second frame of the ship, queue bound 4 — lost 5 of 10 rows;
with 600 rows at the default bound of 256, 257. The second review's
premise ("the only way a live feeder leaves an ask unanswered is … the
ask swallowed, or its reply dropped with the ship") was false: the
likelier case was the ship torn and the reply surviving. Stage 2 put
this on every scoped failover and re-admit (each is a resync, and a
resync's ship is the whole held subset) and added the sweep that takes
rows off a screen that showed them; the class itself is older — a
spoke's FIRST connect (d = {}) and an unscoped member's digest exchange
lost rows the same way on the base tree. No sim test could see any of
it: the sim posts pause and drain between steps, never inside a send.

*The fix (kernel/node.ts `#answer`).* The ship stops at the first
clear; the link stays unsynced; no reply goes out; the rest of the
answer is kept on the link (`torn`: the peer's tails, the digest's r
and q, and the first frame the socket did not take — encodeRuns reports
each frame's first record through an optional `starts` out-param). The
drain handler resumes it from that frame BEFORE the drain digest and
the drain round, and the reply follows the whole ship. A resume that
tears again leaves the drain digest for the drain that completes it, so
the re-ask never goes out ahead of the rest of the ship; a flush that
fills the socket again waits for the next drain. The link counts its
clears (`drops`); `droppedWhilePaused` stays the sticky debt the drain
settles. The reviewer's trial — stop the ship, send no reply, let the
drain's `h: 1` re-ask — was not taken as it stood: a spoke in resync
asks with d = {}, so it would download from zero again, and a ship
bigger than the socket plus the queue that tears at the same frame each
round would never end (a livelock where the loss was). The resume
delivers at least what the socket takes per drain, so it always ends.
The spoke is unchanged: a torn ship is a late reply, never a missing
one; the `h: 1` re-ask is for an ask that arrived while the link was
paused. The first-connect case and the unscoped member case are fixed
by the same rule, with tests; the journal's aeShip row on a torn ship
counts what the socket took.

*What it changes for the UNSCOPED member path.* In an unscoped cluster
a member's digest answer ships suffixes too, so a torn one now stops at
the tear, leaves the link unsynced (live records withheld until the
exchange; before, they flowed over the hole) and resumes at the drain.
This can only happen under a real socket: the sim never pauses inside a
send, so the golden (59,500 and 104,050 events), the 300-seed sweep,
the idle law, fan-out 99 and every sim test are byte-identical (all
re-run; no pin moved; kernel/node, kernel/scope, kernel/alloc,
sim/scale, tests/baseline and api/data perf files pass alone).

*The tests.* kernel/client.test.ts: four tests on a real feeder Node
and a client Node, with a `send` hook that steps `pause` from inside a
send as the shell does — the scoped failover resync (the finding: two
frames reach the socket, nothing is queued past the tear, `torn` holds
seq 5 for q 2, no reply; the drain ships eight frames, then the reply,
then `h: 1`; the resync ends with every row and sweeps nothing; the
drain digest is answered with whole tails and ships nothing more), a
resume that tears again (torn at 9 after 5; the drain digest waits; the
second drain finishes; aeShip 2, 2, 6), a spoke's first connect (no
resync; the tails sit at the tear), and an unscoped member link (member
bytes: no q, no h). Red on the previous kernel at: "nothing queued past
the tear" (actual 4), `torn` undefined, "the link stays unsynced over
the tear" (actual true); the reviewer's probe went 5 of 10 → 10 of 10,
first connect included. Four mutations, each caught: no stop at the
tear (4 red: queued 3), no resume at the drain (4 red), no wait on a
second tear (1 red: the drain digest went out ahead), resume from the
origin's start instead of the tear (4 red: ten frames re-shipped where
eight).

*Superseded in part on 2026-10-11 (the note below): the ship no longer
overflows the queue, so "stops at the first clear" became "stops at a
full queue"; `torn` holds a cover map, not a frame; `starts` and
`drops` are gone; and the tests above assert the new middle (the queue
kept, no drain digest, aeShip 6, 4).*

**Note, 2026-10-11 (stage 2, the resume costs).** The third re-check
recorded two costs of the resume and named the fix; this note is that
fix (kernel/node.ts `#answer`, kernel/link.ts).

*What was wrong.* (1) CPU grew with the square of a torn ship: every
drain round re-walked the rest of the torn lane, re-encoded all of it,
shipped about one socket buffer, and queued 257 more frames only to
clear them. (2) The text above said a torn ship is a late reply, never
a missing one. But a reply still in the paused queue went with any
later clear — one live tap-forward, or the drain digest right after a
resume — and a spoke in resync then re-asked on `h: 1` and downloaded
the feeder's whole held subset again (the re-check's cases B, C, C0).

*The fix.* (a) Each lane's resume point is a binary search (lanes are
seq-ascending; a splice inserts at its seq). (b) The answer collects
one frame's run at a time by the codec's own rule (`continuesRun`, the
predicate encodeRuns now splits by) and encodes a frame only to hand it
to the link. (c) No deliberate overflow: when the link is paused and
the queue is full, the ship stops BEFORE the next frame; the reply is
one more frame and is held to the same rule. The drain delivers the
queue, then the resume goes on past it, so each drain round delivers
the queue plus what the socket takes and nothing encoded is wasted.
(d) `torn` is now a cover map: the peer's tails raised to what the
answer already handed the link. The resume is an answer to that map,
so it also covers records committed on an already-walked lane while
the ship was stopped (the link stays unsynced meanwhile, so live
records wait rather than overflow the full queue). (e) `Link.inQueue`
holds the cover at the answer's FIRST queued frame (at its reply, when
only the reply is queued); a clear in `ship` makes it the torn answer,
so the drain re-sends what the clear took and the reply. The drain's
flush empties it. A cover is a map of tails, so it cannot hold a record
below it: a record spliced into a lane's interior under a cover (an
armed feeder's dual fence, a scoped fetch fold) lowers that lane's
cover to just under it (`Node.indexInsert`, the one place every
interior insert passes). Without that, a splice under a stopped
answer's cover was never shipped, and one tap-forwarded behind a queued
reply and cleared with it was never shipped again (found by the
review, below). (f) The drain digest never
goes into a full queue: the debt stays and the next drain sends it,
after the reply.

So the premise is now true: a torn ship or a cleared reply is a late
reply, never a missing one, and the one ask a live feeder leaves
unanswered is an ask that arrived while its link was paused.

*Measured* (feeder CPU, a first connect, sparse lane, a socket that
pauses at 64 KiB, queue 256, on this box): 20k records 166-186 ms →
48-55 ms; 160k 20.8 s → 246-262 ms, where an untorn ship of 160k is
310 ms. Frames handed to the link: 22,829 → 20,001 for 20k, 183,903 →
160,001 for 160k (N records plus the reply, each once). A cleared reply
(C0): aeShip [10, 11] → [10, 4]; the spoke asks once.

*What moves.* Only a link that really pauses inside a send: a stopped
ship keeps its queue (no clear, no drop row, no `h: 1` drain digest
after it), and the journal's aeShip row counts what the answer handed
the link. The sim never pauses inside a send, and an untorn walk ships
the same frames in the same order, so the golden, the 300-seed sweep,
59,500 and 104,050 stay byte-identical.

*The tests.* kernel/client.test.ts: the four torn-answer tests keep
their scenarios and their ends; their middles assert the stop (queue
4 kept, no drop, no drain digest, aeShip 6, 4; the second uses a queue
of 2 so the resume stops again). New: C0, C and B as one-ship tests
(aeShip [10, 4], [6, 4, 4], and the drain digest waiting with no
clear), the reply that would overflow (it waits instead), the cover over
a lane walked before the stop (first connect and resync), the cost
probe at 3,000 records (every seq once and in order, the reply last),
and from the review: a splice under the cover (three shapes), a cleared
reply with only the reply queued (aeShip [10, 1]), and a stop on an
already-synced link (the live record waits; no clear).
kernel/node.perf.ts pins the cost on two shapes: handed = sent = N + 1
and 160k / 20k under 20× (about 6-8× measured; 76.7× with the old
re-encode put back; on the small-socket shape 134× with a linear
resume-point scan put back).
Mutations, each caught: no inQueue → torn on a clear, no drain-digest
wait, a cover that skips walked lanes, no stop at a full queue, a reply
that may overflow.

*The review (2026-10-11).* A skeptic found four things, all settled
on the branch. (1) A regression: a record spliced under a cover was
lost, where the old kernel got it back through the second full download
this fix removed — on an armed feeder, a spoke in resync ended without
the spliced row and swept it (pause inside frame 7 or 10 of an answer,
then a splice of seq 11 tap-forwarded behind the queued reply and
cleared with it). The stop path (pause inside frame 2) lost it on the
old kernel too. Fixed by the cover lowering in (e); a test in three
shapes (frames 2, 7, 10), red without it: the spoke held 10 of 11 rows.
(2) The binary search had no pin: the pin's one shape (64 KiB socket,
queue 256) needs only 93 drain rounds for 160k records, so a linear
scan from the lane's end hides in its noise there (8×). The pin now
runs a second shape under the same 20× bound, a 512-byte socket and a
queue of 4 (about 11k rounds): about 7× with the search, 38× in a
probe and 134× in the pin with the scan put back. (3) The reply-only
`inQueue` line and (4) the unsync at a stop on an already-synced link
had no test; each has one now, and each goes red when its line is
deleted.

*The second review (2026-10-11).* It found no lost row and two costs.
(1) The cost claim above ("costs what it ships, each frame encoded
once") holds only when no record is spliced under a cover. Lowering a
cover re-sends that lane's whole suffix above the splice, frames the
peer already holds included. So splices that keep landing under one
long torn answer keep moving its resume point back, and its reply
waits until they stop. Every row still arrives. A probe (1,000 sparse
records, a socket that pauses after every frame, a queue of 4): no
splices, 1,000 records shipped in 400 drain rounds; a splice every
round, 3,998 records (ideal 1,999) in 999 rounds; every 10 rounds,
25,405 (ideal 1,977) in 9,770; every 50 rounds, 110,505 (ideal 1,877)
in 43,850. Splices are cold on a feeder (a heal, a fetch fold), so this
stays as written, and a STATUS idea names the cheaper shape: a small
per-link list of spliced entries, sent at the resume ahead of the
cover walk, falling back to lowering the cover past a size cap. (2)
The cover check walked every client link on every interior insert,
holding a cover or not: 19 ns per insert with no client links, 3,891
ns with 1,000 idle ones. The node now keeps `#covered`, the client
links where `#answer` set a cover; indexInsert walks only those and
prunes a link once both its covers are null (linkDown prunes too), so
an interior insert with no answer stopped or queued pays one size
check (the same probe after: 10-29 ns per insert for 0 to 1,000 idle
client links). Mutations: dropping the inQueue add turns the frame-7 splice
test red, and pruning a link that still holds one cover turns frames 7
and 10 red. Dropping the torn add turns nothing red, and cannot: a
stop needs a full queue, and with `queued` ≥ 1 the same call queued a
frame first, which already added the link.

*Still open, older than this fix.* A record tap-forwarded to a synced
spoke and cleared from the queue in steady state (no answer in flight)
leaves a hole the drain digest cannot see when the record is an
interior one (a splice): the spoke's tails already sit above it. The
old kernel loses it the same way. It is a STATUS bug line.

*Closed on 2026-10-11 (wave 5f, the note below).*

**Note, 2026-10-11 (wave 5f: a clear in steady state).** The line
above, fixed (kernel/link.ts `onClear`, kernel/node.ts `#clearCover`).

*What was wrong.* A synced client link is fed by tap-forward, and a
clear (the paused queue overflowing) left only the drain digest to heal
what it took. That digest answers above the spoke's tails, so two kinds
of record were lost for good. (1) A record spliced into a lane's
interior: its tap-forward sits below the spoke's tails (the filed
line). (2) Found while building its test: any record whose lane a
frame shipped after the clear, in the same flush, leapfrogs. A tap
flush can ship several frames: on a scoped feeder one inbound frame's
tap is gappy (a record of a partition it does not hold, or one it
already has, breaks the run), and the frames after the clear are
queued and survive it. They land first and raise the spoke's
tail above the lost records, plain appends included.

*The fix.* A clear on a client link hands the frames it took to
`Link.onClear` (null on every other link). `#clearCover` reads each
record frame's header and lowers each lane of the link's cover
(`Link.torn`) to just under the lowest record the clear took there.
Every other lane stays where the cover already was: at the torn
answer's cover when an answer's frames were in the queue (V4-42's
inQueue move runs first; the drain resumes it as ever), else at the
feeder's tail right now. A cover the clear SETS this way (no answer was
owed) is a ceiling, marked `c`, never a claim about what the spoke
holds (the second review's correction, below): the drain does not
resume it; it sends the drain digest as before, and the spoke's reply
is answered from the lower of the spoke's own tail and the ceiling on
each lane, which uses the ceiling up. EVERY clear on a synced client
link sets one (`onClear` gets the synced flag from just before the
clear), even a clear that took no record frame (only method replies,
SUBREC deltas or a WACK): from that clear on the link is unsynced and
nothing is tapped to it, and only a cover lets a later clear lower a
lane and a later splice be lowered into it. A clear on an unsynced
link with no cover changes nothing: such a link has had no answer
complete since its admit (synced falls only at a clear on a synced
link, which now sets a cover, or at a torn ship, which sets one; a
cover leaves only at the answer that resumes or uses it up, which
syncs the link or tears again), so nothing was tapped to it, and the
drain digest heals it as before.

*Why nothing else is lost.* After the clear the link is unsynced, so
nothing is tapped until the answer that uses the cover. A record
committed before that answer is above the spoke's tail, so the answer
ships it. A record spliced before it is lowered into the cover by
`indexInsert` (the link joins `#covered`). A second clear lowers the
same cover again and never raises it. A clear that
takes an answer's frames, its reply and tap frames together keeps the
answer's cover and its reply: a tap frame's records sit above that
cover, or a splice already lowered it. A clear that took no record
frame still leaves the tails cover, so a later splice or a later clear
has a cover to lower.

*The review's correction (same day).* The first version of this fix
left a cover only when a clear took a record frame. The review found
two losses in that gap. (a) A regression: a clear of control frames
only (in the common relay order the WACK hop ships before the tap is
flushed, so it can overflow a queue of method replies) left the link
unsynced with no cover; the tap frame flushed after it survived; a
record on another lane folded and was not tapped; a second clear took
the tap frame and set the cover at the feeder's tails, above that
record. Once a later record on its lane was resumed, it was lost (the
spoke held 8 of 9 rows; the old kernel heals it through the drain
digest). (b) A splice between a control-only clear and the drain was
never tapped and lowered no cover, so the drain digest answered above
it (6 of 7 rows; the old kernel loses it too). Both close with the
rule above: every clear on a synced link leaves a cover.

*Costs.* One frame-header read per frame a clear took (the clear is
cold: it already writes a journal row). The answer that uses the cover
re-sends a lowered lane's suffix above the lowest lost record, frames
the spoke holds included (its lane drops them). There is one cover per
link, and no frame is encoded twice inside one answer. A member link's
clear is unchanged.

*What moves.* Only a client link that was synced when a clear emptied
its queue: the drain exchange's answer now starts, on each lane the
clear took a record from, just under the lowest one, where it started
at the spoke's tail. The timing does not move: the re-send goes out
with that answer, one round trip after the drain, as before. The sim
never pauses inside a send, so the golden, the 300-seed sweep, 59,500
and 104,050 stay byte-identical.

*Tests* (kernel/client.test.ts): the steady-state splice, the leapfrog
inside one flush, two clears in a row with a splice and a commit before
the drain, the mixed clear, and a member link unchanged. The first
three are red on the old kernel (the spoke misses r11; r32 and r34;
r11). Five mutations, each caught: no `onClear` at admit, a second
clear that starts a fresh cover, no `#covered` add, no lowering, the
last lost seq instead of the lowest. From the review: a control-only
clear then a splice, with method replies and with SUBREC deltas (red
on the old kernel and on the first fix: r11 missing), the relay
WACK-hop clear then a second clear (red on the first fix only: c25
missing), and a clear on a never-synced link that leaves no cover
(dropping the synced guard turns it red; with the ceiling below, such a
cover would only cap the answer to the spoke's first download, which
starts from its empty tails anyway, but the guard keeps a never-synced
link exactly as before).

*The second review's correction (same day): a ceiling, not a claim.*
The version above first resumed the clear's cover at the drain, before
the drain digest, on the claim that every record the feeder had folded
so far was tapped to a synced link. That is false on a scoped feeder:
a record it folds through the latch (`kernel/scope.ts` onAcqDone) is
never tapped (the open STATUS latch bug). The cover sat at the
feeder's tails, above that record; when a later record on the same
lane folded before the drain, the resume shipped the later record
alone, the spoke's tail rose past the latch row, and the row never
arrived while the feeder lived (the spoke held 7 of 8 rows, and 8 of 9
after heartbeats and one more live record). The old kernel heals that
row through the drain digest, so it was a regression in that window.
Now the cover the clear sets is a ceiling (`Link.torn.c`): not resumed
at the drain, but capping the spoke's reply to the drain digest lane
by lane. A lane the clear did not touch is answered from the spoke's
own tail, exactly the old drain exchange, so the latch row is shipped
as before; a lowered lane is answered from just under what the clear
took. Test: 'a clear's cover is a ceiling, never a claim' (red on the
first resume version: the latch row did not reach the spoke). Four
mutations, each caught: the drain resumes the ceiling, or the clear's
cover is not marked as one (that test red either way); the spoke's
reply answered from its own tails alone (6 red: the steady splice, the
leapfrog, the two clears, the two control-only clears and that test);
the reply answered from the ceiling alone (that test red).
The latch bug itself is unchanged and still open: with no clear, a
later record on the lane goes live and the latch row is lost, on this
tree and the old one alike.

*Members.* A member link has no such hole. An unscoped member gets
one frame per flush (a commit is one contiguous run, and a member
never taps), so nothing survives a clear, and the drain digest heals
the tail it took. An armed member is repaired by the holder handshake
and the drain round, not by the digest, and its floors move only
through the pp chain.

**Note, 2026-10-12 (wave 6a: the latch forwards to the spokes).** The
STATUS line "a scoped feeder that folds records through the latch taps
none of them to its spokes" is closed (kernel/scope.ts `onAcqDone` and
`feeds`, kernel/node.ts `#answer`; the review of the same day reshaped
the rule — see "the fix, and the mechanism argued").

*What was wrong.* The ACQDONE fold took the teacher's records into the
lanes through `node.apply` alone; only the staged live span above the
cut went through `inbound`, which taps. So a spoke never heard a record
its feeder learnt through the latch. Its own floor exchange ships what is
above its tail on each lane, so the rows still above it came with the
next heartbeat, and a row folded after a later record on the same lane
had been tapped live was below the tail for good — missing while that
feeder lived, and no monitor fired, because nothing compared a spoke to
its feeder. Both sightings reproduce as tests (sim/scale-probes.test.ts).
Sighting 1, the wave-5e review's probe P2 (n=4 R=3, a spoke fed by P,
fifty rows owned by T and held by P, the T→P frame of the tenth lost
with the link, forty more writes): P repairs through the latch (one
acquire per partition) and the spoke's lane T reads 1-13, 15-50 on seeds
1 and 4 (k124, seq 14) and 1-14, 16-50 on seeds 2 and 3 — one row of
fifty, not the "1-8 and 10" the STATUS line quoted from the review's
own shape. Sighting 2, the debugger's recipe (Sim(11), four members at
R=2, a client of ALL FOUR admitted after formation, eight writes from
2.5 s, n04 leaves at 4 s): the feeder n01 acquires `gamma3` from n03's
orphan copy and the client lacks n04#4 at 40 s; a client of three
members, or writes from formation, elects another feeder and the
recipe does not bite.

*The V4-40 question, answered.* No: stage 2 did not introduce the
repair variant, and the acquire variant is as old as the latch (M6).
Evidence from the parent of 237bab1, unpacked and run: the same probe
P2 loses MORE rows there — lane T seqs 10-13 on seeds 1, 3 and 4, and
10-15 on seed 2 — because at the re-admit the holder's HAVEQ round
latched the partition before the admit digest's suffix landed, and the
digest's live copy of each record then staged and was discarded at
ACQDONE as covered by the cut; the member digest repaired through
`inbound` only when it won that race. `onAcqDone` folded through
`node.apply` on that tree too (its line 588). V4-40 made the latch the
only repair path, so every repaired row now went through the hole; it
did not open it. The hand-off recipe does not reproduce on the old tree
(the client elects n04 itself there), so the old tree's acquire variant
is shown by code and by P2's acquires, not by that recipe.

*The fix, and the mechanism argued.* THE RULE: a synced spoke holds the
whole of every partition its feeder FEEDS it. `Scope.feeds(p)` says
which: held, or acquiring from a held base or from nothing (a repair, a
hand-off); only an orphan's frozen copy, and a latch re-entering from
one, is withheld. A client's digest answer (node.ts `#answer`) walks the
lanes with `feeds`, where it used `held`. The fold then forwards each
teacher record it takes in (not one already in the lane) to every
SYNCED client link, exactly as the live tap does in `inbound`:
`link.add` with the record, its lane coordinates and its attempt
identity, no pp (a spoke attests nothing), then one flush per fold on
each client link after the live replay — which also makes the replayed
live span leave in the same step (before, `inbound`'s adds sat in the
outbox until the feeder's next frame or commit). A fold that RE-ENTERS
from an orphan (preState orphan) forwards the WHOLE partition instead
(`#forwardWhole`): every lane entry of p, in lane order — a spoke synced
since the freeze has nothing of it and one synced before holds the
frozen rows and drops the copies — and lowers a stopped or queued
answer's cover (Link.torn / Link.inQueue, a clear's ceiling included) to
just under p's lowest row on each of its lanes, so the answer that
resumes from it ships p whole.

Why the answer had to change (the review of 2026-10-12, the same day):
as first landed the answer shipped the HELD subset and the fold the
delta alone, and that left a hole. A spoke that synced while its feeder
was re-latching a partition it held — sighting 1's own repair path — or
while the partition was an orphan got nothing of it from the answer
(`held()` is false in both states), and the fold's delta did not bring
the base: the rows stayed missing while that feeder lived (the base tree
healed the narrow kernel shape through the heartbeat floor exchange; the
tree as first landed did not). When the forwarded delta was OLDER than a
base record the spoke never got, the spoke showed an overwritten value
as current, for good (bb#3 px.a = 1 forwarded, bb#5 px.a = 2 in the lane
and never sent). A spoke failing over onto such a feeder lost ten of
forty cells on three of eight seeds of a plain sim schedule, and only
M12 saw it. The review's four probes are tests (kernel/client.test.ts,
kernel/scoped.test.ts, sim/scale-probes.test.ts sighting 3).

Against the constraints: (1) no new round trip — the forward rides the
tap, no ask, no reply, one flush; the answer's filter is one more field
read per entry it already visits; (2) V4-7 — the record is in the
feeder's lane and fold before it is added to any outbox, and it carries
its attempt identity, so a spoke whose write a relay WACKed with `l`
while acquiring the partition sees the value and then settles through
the join (the "or never, while that feeder lives" clause of the api's
STATUS line is gone); the end-to-end test drives it (a spoke's write
relayed through an ACQUIRING feeder, the WACK hopped with `l`, the
record reaching the feeder through the teacher alone, one apply with
the identity, no `acked`; with the identity dropped the write hangs);
(3) the dedup window is untouched (`remember` runs as before); (4) the
forward feeds a SYNCED link only, as the live tap does, and every
unsynced link is covered by the answer that syncs it. Unsynced are: a
link whose answer TORE (it paused with its queue full), a link a clear
left a ceiling on, and a link never answered since its admit. A torn
answer's cover, and a ceiling, are lowered to just under each interior
insert by `node.indexInsert`, which the fold already calls, and at a
re-entry from an orphan to just under p's lowest row, since that answer
walked the lane while p was frozen and skipped it; a never-answered
link's first answer ships p, fed by then. A link whose answer's reply
merely sits in the queue is SYNCED (node.ts `#answer` sets `synced`
when the ship did not tear and queues the reply behind it), and so is
the link of a spoke resyncing on the same feeder (the DIGEST handler's
`#resyncBegin` leaves it): both are fed, and the forward queues behind
the answer, FIFO. A spoke whose failover resync a NEW feeder answers
asks with d = {} and is answered with everything that feeder feeds,
the partition under repair included (the note as first written called
a queued answer's link and a resyncing spoke unsynced; the code was
right, the text was not); (5) a spoke whose link dies mid-forward loses a tail of
frames and fails over, and on a scoped cluster a failover is a resync
onto the next feeder, which ships what it feeds from zero — the forward
adds no hole the resync does not already cover; (6) unscoped bytes are
untouched: `Scope` is built only on scoped nodes, `onAcqDone` is reached
only armed, and `#answer`'s filter runs only armed for a client. The
other shapes the plan named were not taken: an honest lane mark at the
spoke would still leave the spoke asking, one round trip per repair; a
resync trigger would re-download the whole held subset for one row; a
per-link memory of which spokes held the base when the latch opened
(the review's option 1) was built and dropped for the answer rule,
which needs no per-link state and carries a fed latch's base in the
answer itself. NEITHER rule closes the vanish-and-return at a resync
ending across the fold (measured below): the rows a feeder LACKS when
it builds the answer, or withholds as an orphan or a re-entry, are not
in it, so a spoke that had them from its first feeder loses them at
the ghost sweep and gets them back at the fold. The note as first
written said the answer rule removed it; it does not. The spoke's side
needed nothing: its dual fence already
takes an interior record below its tail (kernel/scoped.test.ts CLIENT)
and drops one it holds, so the whole-partition forward costs frames,
never rows.

*The vanish-and-return, measured (the review's review, 2026-10-12).*
Sighting 3's schedule (n=4 R=3, five partitions of eight rows, the
tenth T→P frame lost, the spoke cut from its first feeder Q as P
re-latches) with the cut delayed 0 to 30 ms, over seeds 2, 4, 5 and 6:
56 runs. On this tree the spoke mirrors P at the horizon on all 56 (M12
green, screen = kernel). On 22 the ghost sweep at the resync's end
removed 7 to 20 of the forty cells, which the fold's forward then
brought back — on the four pinned seeds at the exact cut too (9, 10, 7
and 8 cells), where M11 stays green only because the fold landed after
the end. M11 fired on two: seed 2 with the cut 1 ms later (a delta row
the lost frame carried, n01#12: P lacked it when it built the answer
and folded it while the reply was in flight) and seed 6 with the cut
10 ms later (a base row, n01#1: P's five repair latches had aborted
into orphans on a link loss at 2046 ms and were re-entering at 2049
when the answer was built at 2050, so `feeds` withheld them; the sweep
at 2055 took 20 cells; the re-entry folds at 2056-2057 forwarded them
back). M11 is right to fire: its one exact line says a record at or
below the reply's tail was shipped before the reply, and an interior
latch fold between the build and the end breaks that. The base tree on
the same 56 runs: M11 on 8, and on 23 the rows never came back (M12
red). Not a regression, then, but a cost the fix leaves: a spoke that
fails over onto a feeder that is repairing a partition, or holding it
as an orphan, loses that partition's rows from its screen at the
resync's end — up to half its cells here — until the fold forwards them
back. Closing it needs the answer to carry what the feeder is folding
(an open latch's teacher records are staged, not yet in the lane), or
the spoke to keep its rows across the end until the fold lands; a
STATUS line. The two M11 schedules are pinned as KNOWN in
sim/scale-probes.test.ts (the swept count, the one monitor, the
message's shape, the mirror at the horizon), with the four pinned
seeds' swept counts beside them. M11 now picks the rows it judges with
`feeds`, not `held`: the answer ships what the feeder feeds, so the
base rows of a partition under repair at the end are judged too — a
superset; nothing new fires on the probes or the sweep.

*The sweep's coverage of the two legs (the same review).* A11 and A12
fold only from zero at a spoke's feeder (a probe classing each fold at
a node with a synced client link by the partition's prior state: A12
seeds 1-6 zero 4/10/5/8/7/4, repair 0, re-entry 0; A11 no folds), so
the repair and re-entry legs had the kernel tests and sighting 3's
fixed seeds alone. A13-spoke-repair (sim/scoped-sweep.ts): a client of
every member; four times, one RECORDS frame from another member O to
the spoke's feeder F dies with their link and O writes twenty rows over
the next 40 ms to the partitions it owns and F holds, so the lost rows
fold BELOW the spoke's tail on O's lane — sighting 1's shape; without
the later writes the heartbeat exchange healed every seed, forwards or
not, and the family proved nothing; the first 5 ms slice that finds F
mid-repair cuts F from its teacher for 60 ms (under SUSPECT_TICKS), so
the open latches abort into orphans and re-enter. A per-event probe
counts F's folds by the partition's state when its latch opened; the
engagement key is a repair AND a re-entry, which every seed of 1-8
reaches (repairs 7-41, re-entries 2-27), so no ALWAYS seed is needed.
Mutation-checked on seeds 1 and 2: the re-entry forward out, M12 names
a row of a re-entered partition on both; the delta forward out, a row of
a repaired one on both; the answer's filter back to `held`, green (its
spoke is synced all along — sighting 3 and the kernel tests cover that
rule). Two kernel tests close the review's other gaps: the re-entry
twin of the V4-7 join (the attempt identity on `#forwardWhole`'s
entries: 0 joins with it dropped, the value shows and the promise never
settles) and a clear between the re-entry fold and the drain (the
`inQueue` lowering: without it `indexInsert` leaves that cover at 6,
under the one row the fold added, the clear promotes it, and the
resumed answer never ships the base).

*The oracle, M12.* `spokeMirror` (sim/monitors.ts): at the quiet point a
spoke of a scoped cluster holds exactly its feeder's HELD subset, cell
for cell by value, read from the kernel, with a count of the partitions
and cells compared; a spoke still in resync at that point is reported.
It runs on every spoke in the sweep's verdict (UNSAFE, red
`spoke-mirror`), on A11, on A13 (above) and on a new family A12-spoke-handoff (a client
of every member; a join at 400 ms; a clean leave of a member that is
not the feeder at 2 s, so the feeder acquires the leaver's partitions
through the latch; a second burst of writes), whose engagement key is
the feeder's acquires. Mutation-checked with the fix taken out: M12
names the row on both sightings (`s1 lacks ["k124"], which its feeder
n02 holds = number:14 @1/14/n01 for 'k124', a partition n02 holds`;
`zc1 lacks ["gamma3"], which its feeder n01 holds = b:1,0 @1/4/n04 for
'gamma3', a partition n01 holds`) and on A12 seeds 1-4 (a missing field
on seeds 1 and 3, a missing row on seed 2, a cell under a held
partition the feeder lacks on seed 4); with the fix in, every seed is
green. M12's own plants (a row removed from the spoke's kernel, a value
changed, an extra cell under a held partition) are each named
(sim/scale-probes.test.ts). Non-vacuity in the sweep: cells compared
on both spoked families, acquires at the feeder on A12 (4, 10, 5, 8 on
seeds 1-4).

*One monitor reading changed.* M1's per-event form read a spoke's
`applied` watermark as coverage. For a spoke of a SCOPED feeder that
was never a claim: its copy of each lane is the feeder's held subset,
sparse by design, and an interior record lawfully lands at any time —
the kernel's own client leg says so (write.ts #splice). The forward
makes it visible: a partition's history leaves in lane order, one frame
per contiguous run, so an older value of a row and its later remove on
one lane arrive in separate events while the spoke's fence already sits
above both (other partitions' records raised it), and until the remove
lands the spoke shows the row — for as many events as there are frames
between them, not one: with the old reading restored, A12 seeds 2, 4
AND 5 fired M1 at the spoke with the fix in and M12 green, and on seed 4
the spoke showed p27 at two older stamps in two events before its
remove. The shape is the resync re-download flicker's, which M1 already
excuses for a spoke in resync. Now a spoke of a scoped feeder covers
nothing per event (`covers`, sim/monitors.ts); its oracle is M12 at the
quiet point, cell for cell against a feeder that M1's horizon form, M3
and M6 judge. An unscoped spoke's `applied` is still coverage. A
narrower excuse — only the (lane, partition) pairs the spoke received
an interior record for since the last quiet point — would need the
monitor to watch every spoke's lanes per event or a kernel journal row
for the client leg's splice; the blanket reading is what the kernel's
own client leg says of the fence, so it stays. The flicker itself is a
cost of the fix worth naming: a row the cluster removed can show at a
spoke for a few events (one per frame of that partition's history) when
its feeder acquires that partition; before, the spoke showed nothing of
it at all, for ever.

*What the oracle found.* A spoke keeps the rows of a partition that
moved OFF its feeder (a join: the feeder's copy freezes into an orphan
and sheds; a shed tells no spoke) until a failover's resync wipes them,
and no new record of that partition reaches it (the feeder gate-drops
them). `spokeStale` counts those rows without judging them: A12 seeds 2
and 3 read 1 and 6 at the horizon; seeds 1 and 4 read 0. Pinned as a
known count in sim/scoped-sweep.test.ts (if it reads 0 the gap closed;
flip the pin) and named on STATUS. "Spokes subscribe to what they
watch" is the idea that changes it.

*V4-49's ceiling.* The clear's-cover-is-a-ceiling rule was motivated by
this bug (a cover at the feeder's tails sat above the latch row). The
note as first written called the ceiling belt and braces because "a
cover at a synced link's feeder tails would be a sound claim"; the
review showed that false on the tree as first landed (a synced link that
synced mid-latch lacked the base under those tails). With the rule as
it now stands — a synced spoke holds the whole of every partition its
feeder feeds it, and a re-entry fold lowers a cover under the one
partition that was withheld — a cover at a synced link's feeder tails
lowered by what a clear took is sound for every FED partition, and the
fold repairs it at the one transition where it is not. The ceiling
stays as V4-49 recorded it: it costs nothing and it guards the next
hole of this kind. Its test in kernel/client.test.ts is re-recorded to
what the kernel does: the fold taps the latch row onto the paused link,
the clear takes that frame and lowers the ceiling to just under it (bb:
22), the drain does not resume it, the spoke's reply uses it up, the
row arrives.

*A lane duplicate the review found (pre-existing, out of this lane).* A
teacher record ABOVE the teacher's cut that also staged live goes into
the feeder's lane twice: the fold splices it, and the live replay's
`inbound` appends it again, since the fold raises `d.applied` only to
the cut and the fast path checks the fence, not the lane (lane bb at aa
[3, 5, 7, 7] in the probe; the base tree has the same lane). The forward
now ships the record twice too; the spoke drops the copy. Benign today
(a teach of it re-ships both and the learner's fold skips the second;
the index holds both), a lane-invariant break for stage 3's compaction:
a STATUS line.

*What moves.* Only scoped trajectories with a spoke whose feeder folds
through the latch (more frames to the spoke, in the fold's step; the
sim's random delays are drawn per frame, so the trajectory after the
first forward shifts), or whose digest is answered while its feeder has
a partition under repair (the answer now carries that partition's base:
more frames in the answer, after the review). Members are untouched. Unscoped: byte-identical
— the golden, the 300-seed sweep, 59,500 and 104,050 stand (sim/scale,
kernel/node, kernel/scope, kernel/alloc and tests/baseline perf files
run alone: all pass; no pin moved). The debugger's scopedTenure fixture
and the suites that read it stay green; the client in it converges now,
which made the model test's walk over its bad rows vacuous (the review
caught the note saying the opposite), so that test pins the run as
converged and the never-arrived naming on a planted miss;
sim/feeder-death.test.ts 'known cost' stays as pinned (its schedule has
no latch fold at the feeder).

*Tests.* kernel/scoped.test.ts 'ACQUISITION forwards to spokes' (red on
the base: the synced spoke heard `[]`) and 'the two legs' (a spoke
synced mid-repair is answered the base and hears the delta; a spoke
synced all along hears the whole partition at a re-entry);
kernel/client.test.ts the review's four shapes end to end with a real
spoke (synced mid-repair, with and without another partition on the
lane; synced while the partition was an orphan; the superseded value;
a stopped answer across a re-entry, its cover lowered to 2 where
indexInsert alone left 6) and the V4-7 join through an acquiring relay;
sim/scale-probes.test.ts the three sightings (red on the base at "lane T
at the spoke is whole", actual 1-13, 15-50; at "the client got gamma3",
actual false; sighting 3 red as first landed at M12 `s1 lacks
["p4","r0"]` on seeds 2, 4, 5) with M12's plants;
sim/scoped-sweep.test.ts A12 with its engagement, M12 non-vacuity on
both spoked families and the spokeStale pin; kernel/client.test.ts the
ceiling test re-recorded; tools/debug/model.test.ts the scopedTenure
client pinned as converged and the never-arrived naming pinned on a
planted miss. Mutation-checked: `feeds` narrowed to `held` (5 tests red,
the sim one naming the row), the re-entry forward off (2), its cover
lowering off (1), the delta forward off (10), the identity dropped (2:
the join hangs). The review's review added kernel/client.test.ts the
re-entry join and the clear between fold and drain (each red with its
guard out), sim/scale-probes.test.ts the KNOWN vanish-and-return and the
swept counts on sighting 3, and sim/scoped-sweep.test.ts A13 with its
engagement and M12 non-vacuity; M11 reads `feeds`.

**Note, 2026-10-12 (wave 6b: the lane rule).** The STATUS line "a
teacher record above the cut that also staged live goes into the
feeder's lane twice" is closed (kernel/scope.ts `onAcqDone`).

*The rule.* A lane holds each (origin, seq) ONCE, and the scalar fence
(`streams.applied`) never sits below the lane's tail. The second half is
what the first rests on: the fast path (write.ts `inbound`) appends at
the tail on `seq > applied` alone, and only an arrival at or under the
fence takes the dual fence (`#splice`: present in the lane ⇒ dropped,
absent ⇒ spliced at its seq). So every site that puts an entry into a
lane above the fence must raise the fence over it. The fold did not.

*What was wrong.* A teacher ships every entry of p it holds, with its
OWN floor as the cut (`#teach`, `#myFloors`). An entry above the
teacher's floor — a gapped chain there, a lost frame not yet repaired —
arrives above the cut. The fold spliced it and raised the fence only to
the cut, so three arrivals of a record the fold already held went down
the fast path and appended: the same record staged live during the latch
and replayed after the fold (the review's probe: lane bb at aa
[3, 5, 7, 7]; the forward shipped it twice and the spoke dropped the
copy), a later re-ship of it (a third copy), and any record between the
cut and the tail (appended out of order: [3, 5, 7, 6]). The base tree
has the same lanes.

*The fix, and the choice.* The fence rises to the top of what the
teacher shipped on each lane (`top`, one Map set per teach record),
after the cut loop. Not the other shape the plan offered ("the live
replay skips what the fold already holds"): that closes one site and
leaves the tail above the fence, so the next re-ship or the next record
between the cut and the tail still appends twice or out of order. With
the fence at the tail the replay drops the copy on the dual fence (one
`dupDrop`), V4-53's forward ships each record once (the fold forwards it,
the replay forwards nothing), the spoke's fence rule is untouched, and
the floor stays at the cut: the fold attests what the teacher attested,
never the chain (the floor law). The one behaviour that moves is the
floor's: on the base the staged copy appended through the fast path and
its chain rule walked the floor up (the probe's second shape, live 7
with pp 5 and live 9 with pp 7 after a cut of 5: lane [3, 5, 7, 7, 9],
floor 9); now the copy drops, the chain is not walked, and the floor
stays at the cut (lane [3, 5, 7, 9], fence 9, floor 5). What it costs:
the floor waits for a holder whose floor is higher to answer, and that
answer opens a SECOND latch (held-found-lagging: `onHaveA`'s asker-behind
leg, `acquireStart` once more) which re-ships every entry above the cut,
each dropping on the dual fence, and stages whatever arrives live while
it is open. No data is lost, and the shape never occurs in the sweep
(below). A chain-walk at the fold would spare the second latch; that is
a floor-law change, left for its own decision. Nothing peer-facing reads
`applied` on an armed node: the digest
body is the lane tail (node.ts `#sendDigest`), coverage for M1 is the
floor (`covers`), the frontier is pinned while armed; a client compares
its own `applied` to its feeder's digest, and a client never folds.

*What the sweep says.* With the fence rise switched off and a counter in
the fold, the scoped sweep at FERO_SCOPED_SEEDS=8 made 4,646 folds and
NOT ONE had a teacher record above the cut: the sweep's repairs close a
lagging floor within one round trip (the owner's announce, the admit
round after a redial), and no learner latched from a lagging teacher in
that window on any seed. So no seeded schedule makes the duplicate, no
monitor could have fired on it there (log-monotone would have: a copy
appended at the tail is `7 after 7`), and the sweep is not this fix's
mutation check. Every scoped trajectory is unchanged — the sweep's
counts (spokeStale 6 on A12 seed 3, sighting 3's swept 9, 10, 7 and 8,
the counted floors 5,337 / 600 / 14,791 / 60) stand as recorded, and the
unscoped golden, the 300-seed sweep, 59,500 and 104,050 are untouched
(`Scope` is built on scoped nodes only).

*The invariant in the sim.* `lane-unique` (sim/monitors.ts `perEvent`):
after every event, on every stepped node's lanes, the pairs it reads
must be STRICTLY ASCENDING (`<=` fires, the same test as log-monotone's).
A strictly ascending lane holds each seq once, wherever a copy sits: a
copy beside its original is an equal pair ("n01 lane n02 holds seq 7
TWICE (at 2 and 3; epochs 1 and 1) — the lane rule"); a copy put
anywhere else reads as an entry out of place ([l0, l2', l1, l2]: "holds
seq l1 OUT OF PLACE at 2: after l2'"). The first shape of the scan
tested equal neighbours alone, on the argument that lanes are ascending
so equal seqs sit side by side — but the only monitor that proves a
lane ascending in its interior is this one, so a copy away from its
original was seen by nothing (the 2026-10-12 review's probe: a copy of
lane[2] at index 1, or of lane[0] at index 2, fired no monitor on any
variant). log-monotone proves the rule for the tail it scans but scans
from the length it last saw, so a copy an interior insert puts below
that length is outside its window; lane-unique keeps the entry it last
saw at the tail, scans the new tail while that entry still stands at its
index, and the whole lane when it moved (an interior insert) or the
array was replaced. The extra coverage over log-monotone is exactly the
in-place interior copy: a REPLACED array (a `compact()` rewrite) is
rescanned from the start by log-monotone too, since its cursor keys on
the array's identity (`cursorOf`). Counted (`laneUniqueCounts`: lane
scans and neighbouring pairs); the scoped sweep records `eng.lanePairs`
and asserts it above zero on every family. Checked: the kernel probe
(kernel/scoped.test.ts 'THE LANE RULE', red on the base at "the lane
holds 7 once", actual [3, 5, 7, 7]); the same frames on a formed sim
node (sim/scale-probes.test.ts 'the lane rule in a sim': lane-unique and
log-monotone both fire with the fence rise reverted, since the copy
lands at the tail; nothing fires now); and two plants in
sim/monitor-walk.test.ts on a lane of six or more that the monitors
already read whole (from step 150): a copy of lane[1] at index 1 (beside
its original) and a copy of lane[2] at index 1 (away from it). On both,
lane-unique fires (event 973 on the seeded run), the test pins that
log-monotone never does (`silent`), and the scoped and full walks agree.
The second plant is red on the equal-neighbours scan ("the plant bit:
the full walk saw lane-unique (it saw nothing)", four variants). The
plants' first shape (a lane of three from step 35) landed on a lane that
had just grown, so the copy sat at log-monotone's cursor and both fired
at one event; a lane-unique with log-monotone's cursor rule passed it.
The 2026-10-12 review caught that too; the deeper plant turns that
mutant red. `silent` rides on Sim(11)'s trajectory (log-monotone's
cursor must already be past the copy when the plant lands); a merge that
moves the trajectory can only make it fail loudly, and the cure is a
later plant step.

*For stage 3.* Compaction may assume a lane holds each seq once and the
fence covers the tail. A rewrite that kept a copy at the tail or
replaced the array is named by log-monotone and lane-unique both at the
next pass; a copy an interior insert put anywhere, beside its original
or not, is named by lane-unique alone, because the insert moved the last
entry. The limit (the third review): an in-place rewrite that keeps the
array, its length and its last entry is seen by NO per-event monitor —
lane-unique skips a lane whose tail stands, and M4 reads the entries, not
their order — so a rewrite of a lane must replace the array (compact()
builds a new one) or bring its own check.

**Note, 2026-10-12 (stage 3 built: compaction on scoped nodes).** The §7
stage-3 row is in the tree (kernel/log.ts `compactScoped`,
`scopedFrontier`, `keep`; kernel/scope.ts `stableMarks`, `evidence`,
`memo`, `#teach`, `onAcqDone`; kernel/node.ts `compacted`, the snapshot
echo; kernel/write.ts `windowOf`), on top of the lane rule above. A
scoped node forgets now. Terms used once: a **pass** is one walk of one
lane by compaction; the **frontier** F(o, p) is the highest seq of lane
o that every current holder of p has attested it is past, on floors a
crash cannot take back.

*What landed, against §4.* Rule C1-C4 as written. C1: a partition
compacts only while held and sealed here with no latch open; orphans,
acquiring and unsealed bases never (the compactor's own open latch pins
it: kernel/scoped.test.ts COMPACTION PIN (d)). C2: `winner()`, the one
test both passes share. C3: F ranges over the current holders at the
pass, self included; self counts at its durable floor when durable, else
its possession floor; a peer at its durable marks when it has announced
any for p (HAVEQ `d`, HAVEA `md`) or confirm has ever seen a `p` map
from it, else at its marks; absent is 0 and pins, so a holder that has
attested nothing this epoch (acquiring, unsealed, never heard) pins F at
0. C4: the lane's last entry stays. One `keep(e)` = tail ∨ above F ∨
winner, used by `compactScoped` and by `#teach` above the learner's
marks. The memo keys a lane's last fruitless pass on (length,
`Scope.evidence`), the counter bumped where a mark rises or is voided,
at an install, a seal, a fold, a shed, and where a durable floor
advances. A compacting pass on a durable node arms the snapshot swap and
the boot record is written when that swap is issued (at its echo until
the second review, see below), so the floor seed sits above the pp gaps
the pass opened at every crash point. ACQDONE gains `w`, the teacher's
dedup-window tuples for p, and armed window entries record their
partition. The shed bar, the drain and `shedWaitingOn` read the same
crash-stable ladder as C3. Tombstone GC stays pinned while armed (stage
4). `Link.torn` and `Link.inQueue` are maps of tails and the resume is a
binary search for the first entry above each, so compaction leaves a
stopped answer resumable (V4-40's note for this stage: answered, no
change needed).

*Where it differs from §4 and §7, and why.*

1. **`JK.compacted` carries a count, not the partition.** The row said
   "carries the partition". As first built the pass emitted one row per
   (lane, partition) it dropped from, and P4's probe put 62,494 rows
   into the journal over 50,000 updates: a lane on a node holding
   thousands of partitions would push thousands of rows per pass into a
   4,096-row drop-oldest ring and evict every other kind. Now a=lane,
   b=entries dropped, c=how many partitions the pass dropped from. M2
   never read the row (it diffs the replaced lane against the holders'
   real floors), so nothing the harness checks moved.
2. **`w` tuples carry the lane** as a fifth element, `[issuer, cid, seq,
   epoch, lane]`: a dup WACK must name the lane (the stage-1 review's
   K1), and the learner's `remember` wants it.
3. **`keep()` in `#teach` filters nothing in stage 3.** This follows
   from C3 itself: the learner is a current holder that attests nothing
   while it acquires, so it pins the teacher's F for p at 0, and `keep`
   passes everything above its marks — what a teach always shipped. The
   predicate is shared all the same: the day stage 4 releases a stamp,
   a released cell's entry is no winner and reaches nobody. The kernel
   test shows both halves (a compacted teacher ships its compacted lane;
   an uncompacted twin ships every entry above the marks).
4. **The evidence counter is node-wide**, not per lane. A winner on lane
   o that a newer record on ANOTHER lane supersedes waits for the next
   evidence change or growth of lane o before its pass; under writes
   marks move every tick. Per-lane versions were not worth the
   bookkeeping before a measurement asks for them.
5. **The durability discriminator** reads two sources: a peer is durable
   for p when it has announced `d` or `md` for p, or when confirm has
   seen a `p` map on any of its digests. Either alone would do (a
   durable sender puts `d` beside every `q` it attests, and `md` beside
   every sealed ok), the pair fails toward pinning.
6. **P4 lives in the perf tier** (sim/scale.perf.ts), at compactAt 128:
   the 50,000 writes take about a minute here, and the default 4,096
   would hide the trigger behind 6,250 writes per owner lane. The lane
   law itself (M8's lane half, `boundedLanes`) runs on every seed of the
   scoped sweep as a liveness assertion — but at the sweep's workload it
   holds with compaction off too (checked with the frontier forced to
   0), so the sweep's catch for "compaction off" is its per-family
   `compactions > 0` count, and P4 is where the bound bites.
7. **The boot record is written when the compaction-armed swap is
   issued**, not at its echo (the row's words; the second review, below).
   At the echo it left a window between the swap's fsync and its echo
   where the compacted file sat under the old seed: a crash there
   re-latched once, and the marks the node had announced were above what
   its disk restored while peers counted them as crash-stable. The seed
   written at the issue is the pre-swap durable floor, which is at or
   above every gap and backed by either file on disk (§4).

*The numbers.* Every family of the sweep compacts (2 to 111 passes per
seed at compactAt 16) and every family is safe and live at the battery's
seeds and the pinned ones, M2 green on every pass. compact.perf: the
scoped pass over a 100,000-winner lane that drops nothing costs 0.94× the
unscoped pass, 1.61 µs per entry (tmpfs, low priority). P4: 3,566
entries for 1,500 held cells over eight nodes after 50,000 updates, the
worst node 311 entries over its cells. A durable holder restarted after
its lanes compacted below their floors and its WAL swapped restores its
floors from the seed and re-latches nothing (5 re-latches with the boot
write removed). A client of a scoped server across its
feeder's passes: zero resyncs, M12 green. Mutation checks, each once:
the acquiring/absent pin removed turns M2 red on 2 of 26 sweep runs
(A2 seed 1: "n01 compacted (n01, 51) of 'p114' while holder n02's real
floor for that lane is 0"; A13 seed 1); volatile marks for a durable
co-holder drop the whole lane at once where the durable mark allows
1,000; `w` not fed leaves the retry's coordinates unknown at the new
owner; the memo on length alone turns four kernel tests red; C4 removed
empties a lane whose last entry lost; the shed on volatile marks sheds
an orphan a durable holder covers in memory only.

*The sweep's pins moved with the trajectory*, each re-recorded with its
why in sim/scoped-sweep.test.ts. `version-only` (G1) bites across the
families now, as this record predicted: the released stamp makes the
remove's entry a loser, the next pass drops it, and the next teach or
spoke forward ships the older record without it — caught on A1 seeds
1-8, A3 seeds 5-7, A11 seeds 5-7, A12 seeds 1, 2, 5, 7 (before: A1 and
A11 only); A3 seed 5 and A12 seed 1 join the pins. `drop-one` lost its
bite on most seeds for the same reason read the other way: the older
write under the dropped remove is already compacted at that holder when
the mutation fires, so its later teach has nothing to resurrect; it is
caught where an older record survives outside the frontier (A1 seed 8,
the zombie's stranded lane; A2 seed 14), and A6 seed 3 and A7 seed 4
leave the table. `release-all` moves from A7 seed 2 to seed 5 (both
monitors catch there; on seed 2 stamp-oracle alone named a joiner lacking
a row). M8 splits into its lane half (a law now) and its tombstone half
(red today until stage 4).

*Found while building, not fixed here.* (1) The mutation runner's
`inject` matches the remove's lane entry by the TOMBSTONE's stamp; a
field a row write swept carries the row's stamp as its tombstone
(V4-18), so for such a cell `inject` drops the parent row's winning
entry. M2 names that drop in mutated runs and always did (M2 is not a
CATCHER). A harness flaw, pre-existing; fixing it moves every mutation
pin again, so it is a STATUS line. (2) A HAVEQ that attests a partition
above the owner's own floor for it (a mark of seq 8 for (aa, r) when
r's last record is 7) reads at the owner as "I am behind" and opens a
latch, which pins r under C1. Not a bug — a hand-built attestation can
say it, a real one cannot — but it bit twice while writing tests; the
tests say so.

*What stage 4 will need from this stage.* The `g` (gapless) bit's
definition, "content tail = floor on every lane of p", reads false at a
compacted holder whenever a partition's top entry on a lane was a loser
(C4 keeps the LANE's tail, not each partition's); nothing reads `g` yet,
and R2 must redefine it before it does — the stage-2 review's note,
now live. The release step drops dead entries on every lane through
`byPart`; it must bump `Scope.evidence` (a release makes entries
compactable) and must respect C4 or re-derive the client digest's tail,
since a released cell's entry that is a lane's last entry stays until
the lane grows. `keep()` in `#teach` becomes load-bearing at the first
release. `stableMarks` is R2's "crash-stable floor per lane" and
`scopedFrontier` its per-(lane, partition) minimum. `gcTombstones` keeps
the unscoped rule and must gain the armed per-partition one (R0-R4);
`boundedTombs` is the red-today pin that flips. Stage 3 is the resting
point the record names: logs are bounded, tombstones are not, and
nothing here is unsound if stage 4 never lands.

*Reviewed, 2026-10-12 (one review, four findings, no hole in the
argument).* (1) M2 frontier-sound read every holder's possession floor
(`pe.s`), never a durable holder's crash-stable one (`pe.d`), so the §6
mutation "volatile instead of durable floors" was caught by the two kernel
tests above and by no sweep family: A4's writes land in its first 600 ms
under a 40-80 ms fsync delay, so every pass there runs after the lagging
disk has caught up (A4 is green under the mutation at both its seeds). In
stage 3 this class has no state-level consequence (removes are never
compacted, every winner is kept, a learner folds winners), which is why
M1, M3 and M6 cannot see it; it bites at stage 4. M2 reads a durable
holder at `pe.d` now, and sim/compaction.test.ts has the schedule the
sweep lacks: n=3 R=2 durable, one holder's fsync answering 1.5-2 s late
under 240 hot writes, so every pass the writes arm runs inside the lag
(28 passes dropped entries while the slow holder's durable floors were
behind its possession floors). Under the mutation the test is red with 20
M2 violations ("n03's real floor for that lane is 0 — below the
frontier"); with the old M2 line it passes, so both halves are needed.
§6's list names the schedule. It never crashes a node, so it says nothing
about what a disk restores; stage 4's R2 ("crash-stable floor per lane")
has the window test below for that. (2) `scopedFrontier`'s
self-is-a-holder guard (`mine`) was not pinned: removing it left every
test green, because an install that moves p off a node makes it an orphan
in the same step. It is pinned now through the ring's test seam
(kernel/scoped.test.ts "C1 at the ring"): a held partition the ring no
longer places here never compacts though both holders attest the tail,
and placed back the same marks compact it. (3) P4 summed the cluster-wide
pass count once per node; the printed line was right, the sum is out of
the loop. (4) §4 said "a crash before the echo restores the previous
snapshot plus appended rows"; it then named the window after the swap's
fsync and before its echo: the compacted lanes under the old boot record,
one re-latch, nothing lost — the shape the restore test's mutation shows.

*Reviewed again, 2026-10-12 (the second review: one minor, one nit; the
window closed in the kernel).* The minor: §4's window sentence described
only the node's own re-latch. In that window the node's already-announced
durable marks were higher than what its disk would restore, and peers' C3
frontier and the shed (both on `stableMarks`) counted them as crash-stable
until the reborn's HELLO voided them; the slow-disk schedule never
crashes, so it could not show this. The reviewer's probe (n=3 R=2
durable, one holder's fsync at 150-500 ms, a crash inside the window on 8
of 8 runs) found 12 (lane, partition) pairs where peers held marks of
2-5 while the disk restored 0, and 0 in the control that crashed after
the echo. Harmless in stage 3 (every winner is kept, removes are never
compacted, the restore re-latches once), an R2 hazard for stage 4.
Confirmed by reading node.ts: the only write of the seed after a pass was
at the echo. Closed in the kernel rather than in the text, since the close
is one line and clearly right: `snapshot()` writes the boot record right
after it hands a compaction-armed swap to the sink, with the pre-swap
durable floors as the seed (§4 above says why either file backs it), and
the echo writes nothing more — one boot write per compacting swap, as
before. The test (sim/compaction.test.ts "window"): compactAt 2 so the
quiet leaves no loser for a later pass, six fresh FIELD cells written
above the seed on disk (a fresh row is a fresh partition, whose seal at a
durable holder writes the record), the holder's fsync slowed to 400-500
ms, a burst that turns the six into losers, the sim stepped one virtual
ms at a time until the holder has issued a compaction-armed swap whose
echo has not landed, then a restart: the seed on disk covers every gap,
the floors restored equal the pre-crash floors, 0 re-latches, and no
mark a peer held for the holder is above what its disk restored. With
the write moved back to the echo it is red at "the seed on disk covers
the gap" and, with that line removed, at "no re-latch" (5); the restore
test stays green under the same mutation. The kernel test pins the write
at the issue and none at the echo. The nit: the COMPACTION PIN's title
said the journal row carried the partition; it carries the count since
b0291a7. The deviation list above gains a seventh entry: the row's "the
boot record rewritten at its echo" is "written when the swap is issued".

*Re-checked, 2026-10-12 (the third look: one minor, one nit; the kernel
fix held).* The minor: two of the window test's checks, "the floor
restored equals the pre-crash floor" and "no mark a peer held is above
what its disk restored", read the reborn 3 s after the restart, when the
peers' digests and the re-latch had already healed a wrong seed; with the
write moved back to the echo both stayed green, and so did the restore
test's floors line with no boot write at all. Both tests now read those
lines at the restore instant (`sim.run({ until: sim.now })` right after
`sim.restart`: replay and start done, nothing on the wire). Mutation
check in a scratch copy: with the write at the echo, each of the window
test's four restore checks is red on its own with the other three off
(the seed covers the gap; n01|c1 restored 158, was 211; a peer held 162,
the disk restored 158; 5 re-latches), and the old 3 s placement is green;
with no boot write at all, the restore test is red at its floors line
(restored 2, was 158) and, with that off, at "no re-latch" (5). So the
window test is the R2 check stage 4 is handed above. The nit: I11 below
still said the seed is rewritten at the echo; it now says it is written
when the compaction-armed swap is issued.

**Note, 2026-10-21 (wave 6c: the spoke edges the M12 oracle found).**
Four STATUS lines close, all on the spoke side of a scoped cluster (a
spoke is a client fed by one scoped server, its feeder). They share one
new verb, FEED (28): a feeder's word to its spokes, read from the
PRIMARY link only (a spare's word says nothing about what the feeder
holds; a server drops it). One verb, the op inside the value, as DIGEST
carries `r`. Unscoped nodes never send it.

*The shed tells its spokes (STATUS "a spoke keeps showing the rows of a
partition that moved off its feeder").* A join moved a partition off the
feeder; the feeder's copy froze into an orphan and was shed once every
current holder attested its tails; nothing told the spoke, so its rows
stayed on the screen, frozen (the orphan gate-dropped every new record),
until a failover's resync wiped them. `spokeStale` counted 6, 5, 1, 2
and 1 such rows on A12 seeds 3, 5, 6, 8 and 11. Now `evaluateSheds`
ships one FEED {x: [p…]} per admitted client link naming what it shed,
synced or not (a spoke whose answer is still torn held the rows too;
a word a clear takes is owed and said again at the answer that heals
the link, before its ship: the vanish-and-return below, clause 3),
and the spoke drops each partition with its feeder (node.ts `#unfeed`):
its cells, versions and deep-index entries, its lane entries (a kept
entry would make the dual fence drop a later re-feed of the same record
as present, so the rows would never come back when the feeder
re-acquires the partition), its place in an open resync's sweep set and
in the kept cells below, and its screen rows through the ghost sweep's
own removal (`#ghost`, now shared). The versions of the partition's
unindexed tombstones stay: a tombstone is sound LWW memory, and finding
them would cost a walk of every version. Every seed of A12 1-12 reads 0;
the pin flips to 0 on the five ALWAYS seeds; with the spoke's handler
off, seed 3 reads 6 again. Journal `unfed` (84). Not taken: the spoke's
digest answer carrying the feeder's held set (a walk of every held
partition per heartbeat per client; the shed is one frame, cold); the
word at the freeze (the feeder's own screen keeps the frozen rows until
the shed, and the spoke should mirror it).

*The ceiling crosses a failover (STATUS "on an unscoped feeder, a row
can still be lost when a spoke fails over between the drain and the
capped answer").* V4-49 left a clear's ceiling on the feeder's link and
used it up at the spoke's reply to the drain digest. A spoke that failed
over after that digest and before the capped answer asked its next
feeder with its own tails, which sit above the hole; on an unscoped
feeder (a scoped failover resyncs: d = {}) the records the clear took
were lost for good. Now a drain digest after a clear carries the ceiling
(`c`); the spoke keeps it (`#ceiling`) and every digest it sends while
it holds one — the drain exchange's answer, a heartbeat's answer, the
failover's ask — carries the lower of its tails and the ceiling, lane by
lane. It answers the carrying drain digest with an r=1 of its own so a
reply comes, and the first reply at or above the first capped ask's q
drops the ceiling: any later ask to any feeder carried the cap, so that
answer fills the hole wherever it comes from. A resync drops it. The
feeder's own cap stays for older spokes. The test is the review's shape:
V4-51's cuts of one run in one flush, a queue of one, the clear taking
the first two cuts and the third surviving, the failover between the
drain digest and the answer; red before at "the hole is filled by the
next feeder" (the spoke held w5, w6). Cost: one optional key on a drain
digest after a clear and one extra r=1/r=0 exchange there; every other
digest is the frame it was; with no ceiling the spoke's digests are
byte-identical.

*The fold group (STATUS "a spoke can show a removed row for a few events
when its feeder acquires that partition").* The forward of a latch fold
(V4-53) left in lane order, one frame per contiguous run, so an older
value of a row and its later remove on one lane arrived in separate
events: the spoke showed the row between them (A12 seed 4, p27 at two
older stamps in two events). Now `onAcqDone` ships FEED {b: p} on every
synced client link before the forward (after a flush, so the group holds
the fold's frames alone) and FEED {e: p} after it; the spoke (node.ts
`group`) keeps the RECORDS frames between them, each its own copy of the
bytes, and lands them as ONE apply at the end (`#groupLand`, through the
RECORDS handler's body, now `#ingest`). A lost end is closed by the next
frame that proves the feeder's step ended (its digest, a PING or PONG, a
FEED {x}): the frames land and nothing is judged, the end is owed and
said again after the heal (the vanish-and-return below, clause 3);
a {b} while a group is open lands the open one first; a failover drops
an open group (the resync onto the next feeder brings the partition
whole). Bounded by the fold's size, which the spoke is about to hold in
its lanes anyway. Not taken: one frame per fold (a RECORDS frame is one
run; a multi-run frame is a new encoding) and a continuation mark on
RECORDS (a codec change that touches unscoped bytes). What it costs: two
control frames per fold per synced spoke; on a paused link with a nearly
full queue the group's three frames can force a clear one frame earlier
than before (the clear's cover heals it as ever; one client test runs
with a queue of four where it ran with two, pinning the same clear). The
scoped sweep, the spoked families on seeds 1-12 and sim/scale-probes did
not move: the markers ride behind the fold's forward.

*What M1 reads for a spoke of a scoped feeder.* From wave 6a to now it
read nothing per event: the forward's flicker made the spoke's applied
watermark a false claim. The watermark is no claim even with the flicker
gone — a spoke's copy of each lane is the feeder's held subset, sparse by
design, and a lost owner-to-holder frame leaves the FEEDER lawfully
showing a row whose remove the spoke's fence already sits above (A13's
repair shape: an applied reading fires at the spoke while the feeder,
judged by its floor, is green). What is a claim is V4-53's rule: a
synced spoke holds the whole of every partition its feeder feeds it. So
M1 now reads a scoped spoke's coverage of (lane, partition) as its
FEEDER's possession floor, once everything the feeder sent has landed:
the spoke not in resync, the feeder's link to it synced and flowing with
an empty queue, nothing from the feeder on the wire (sim.inflight), no
fold group open at the spoke. The ledger's walk sees a cell once, at the
pass where it changed, and at that pass a frame is often in flight, so a
scoped spoke's changed cell waits in a small map and is judged at the
first quiet pass after the change, or dropped when it changed again, the
spoke resynced, or it is gone. The plant (sim/scale-probes.test.ts): a
removed cell put back at the spoke at its older stamp is silent while
the feeder's link to it is paused and named at the first quiet pass
after the drain, against the feeder's floor; with the old reading
restored, red. The spoked families 1-12, monitor-walk (the scoped and
full walks agree) and the probes are green under it.

*The vanish-and-return (STATUS "a spoke that fails over onto a feeder
that is repairing a partition, or holding it as an orphan, loses that
partition's rows from its screen at the resync's end, until the fold
forwards them back"), the rule argued.* The failover's resync answer
carries what the new feeder holds of each FED partition when it builds
it; the rows it is about to fold — a latch's staged delta, a re-entry's
whole partition, a from-zero acquire — are not in it, and the spoke had
them from its first feeder, so the ghost sweep at the end took them from
the screen and the fold's forward brought them back. Today's base, on
sighting 3's schedule over seeds 2, 4, 5, 6 × fourteen offsets (56
runs): the end swept 7 to 20 of forty cells on 12 runs and M11 fired on
none of them; the two offsets where M11 fires (seed 2 at 1 ms, seed 6 at
10 ms) are the pins' own, not on the grid. The two shapes the plan named: (a) the answer carries an
open latch's staged records as a provisional tail the fold confirms or
withdraws; (b) the spoke keeps its rows across the end until the fold
lands, under a mark the end sweep respects. (a) was not taken: it cannot
carry what the feeder does not have yet — the teacher's delta lands over
one or more steps after the latch opens, and a from-zero or re-entry
latch has nothing staged until its ACQ frames arrive — so in that window
the rows still vanish and return; it also ships records the feeder may
never fold (a latch that aborts), which the spoke would then hold under a
partition its feeder does not. (b) is the rule: the resync's ask says
`f: 1` (scoped spokes only; the unscoped ask is the frame it was), the
feeder's reply names the partitions IN FLIGHT at that moment
(`Scope.inFlight`: every open latch, whatever its base, and every orphan
the ring still assigns it — a re-entry in waiting, which the next round
latches; an orphan the ring does not assign is on its way to a shed and
not in flight), and the end KEEPS a ghost cell of a named partition on
the screen (`#deferred`) instead of removing it. A kept cell is
screen-only (the kernel lacks it), so the
rule must give it a BOUNDED life, and the first build did not: the
skeptic's review of 2026-10-21 showed three ways a kept cell stayed for
good, each a deterministic probe green on the base and red on the build
(a from-zero latch aborted cleanly at an install and no word came; a
kept cell above a lane that never moved again waited for ever; a clear
took the fold's markers and nothing judged). The rule, said as what a
kept cell waits for: ITS PARTITION STOPS BEING IN FLIGHT, AND THE SPOKE
HOLDS THE FEEDER'S WHOLE PARTITION AFTER THAT. Three clauses make it
bounded.

(1) THE END JUDGES EVERY KEPT CELL. The fold's end for p (FEED {e})
judges every kept cell of p at once: one the group brought is back in
the kernel and done; every other one leaves the screen, a ghost. No
waiting for the lane. At the end the feeder holds p whole as the teacher
attested it, plus what it staged, and the spoke holds the base (the
answer) plus the group: a kept cell not in the kernel now is one the
feeder does not hold. The cost: a record in flight TO the feeder at that
moment (the owner's frame to it still on a paused link after the
failover, the ask, the answer and the fold; or a frame lost on the way
and repaired by a later latch, the double fault) leaves the screen at
the end and returns when it lands: one bounded vanish-and-return, which
M12 reads, and never more than the base, which swept every ghost at the
resync end. The first build waited instead, until the feeder's lane had
moved past the cell's stamp, and that wait had no bound: a record that
died with its owner and the spoke's first feeder sits above a lane that
never moves again, and the spoke showed it for good (the review's
PROBE5). Weighed and not taken: FEED {e} carrying the feeder's lane
tails. It sorts the kept cells into "surely gone" (at or under the tail)
and "maybe in flight" (above it), and the second kind still needs a
bound, so it needs this clause anyway, and then it buys nothing.

(2) EVERY WAY OUT OF IN FLIGHT SENDS A WORD. In flight is an open latch
or an orphan the ring still assigns. The exits, each with its word: a
latch FOLDS, FEED {b}..{e} (clause 1). A latch ABORTS CLEAN, no residue
(a torn teach, the teacher's death, a stage overflow, an install's
rescope): the feeder holds nothing of p now, and says FEED {x: [p]} to
every client link at the abort (scope.ts `#abort`, the drop leg); the
spoke drops p, its kept cells with it (its kernel has nothing of p from
this feeder), and if the ring still assigns p the next round's latch
re-feeds it whole through the fold's forward, a vanish-and-return in
that rare case and an honest one (the feeder held nothing of p in
between; PROBE1 was the install with p moved off). A latch ABORTS TO AN
ORPHAN (residue: an acquiring owner's own commits): assigned, it is
still in flight (a re-entry in waiting; the next round latches it and
the fold's end judges); not assigned, it is on its way to a shed, and
the shed's FEED {x} is the word. An ASSIGNED ORPHAN loses its assignment
at an install: the shed's word (an orphan the ring assigns is never
shed, "never shed our own duty"). The FEEDER DIES, or the spoke moves:
the failover's resync folds the kept cells into its sweep set, and the
next reply says which to keep again. THE LINK IS LOST AND THE FEEDER
LIVES ON (a blip; the spoke re-dials the same feeder): the word for p
went to the dead link, or to no admitted link at all, so the re-admit's
first ask is a resync whenever the spoke holds anything a reply must
judge: a non-empty kernel, stranded writes, or kept cells (node.ts, the
admit arm; `#deferred` joins the sweep set there as at a failover), and
the reply says which to keep again. The first build resynced on a
non-empty kernel alone, and a spoke whose only fed rows were in flight
has an EMPTY kernel: it asked plainly, and its kept cells stayed for
good (the second review's SK2, a fold during the blip; SK3, a clean
abort during it). Nothing else leaves the in-flight set: an entry is in
flight while it is acquiring or an orphan the ring assigns; it leaves
those states only through a fold, an abort or a shed, each with its
word above; and a word reaches the spoke unless the link is lost (this
exit) or a clear takes it (clause 3).

(3) NOTHING A CLEAR CAN TAKE IS THE ONLY THING THAT ENDS A KEPT CELL. A
FEED word is one frame on a client link, and a clear takes the whole
queue (PROBE4: {b}, the frames and {e} gone, the kept cells never
judged; PROBE3: the shed's {x} gone, the partition kept for good). So
the feeder REMEMBERS the words it owes each client link (node.ts
`#owed`: the partitions whose {e} or {x} a clear took, read in
`#clearCover`'s walk of the dropped frames, which reads every frame's
verb already; and the partitions whose fold ended while the link was not
synced but answered, where no {b}, no forward and no {e} go out at all)
and says them
again at the next answer that syncs the link (`#answer`, the untorn
path), EACH AT ITS OWN PLACE IN THE ORDER. The two kinds of word sit at
different places. An owed {e} leaves AFTER the answer's whole ship and
its reply, and only while p is HELD (a latch open for p again says its
own end; an orphan's or a gone partition's exit is an {x}): that is the
first moment the spoke holds the feeder's fed subset above the cover
again (the clear's cover was lowered under every record the clear took,
V4-49, and a fold on an unsynced link lowers it under the fold's rows,
V4-53), so the end judges against a complete kernel. An owed {x} leaves
BEFORE the answer's ship, unfiltered (`#answer` → `#payOwed(link, 'x')`,
then the ship, the reply, then `#payOwed(link, 'e')`): that is where
the word stood when the clear took it, in front of everything of p the
feeder has sent since. A word said there is true when said: p LEFT the
feeder when the word was queued (a shed filters p's rows out of every
lane, scope.ts `#shed`; a clean abort held none), so what the spoke
holds of p is from before the word. And the answer that follows
re-sends the named partitions WHOLE: `#payOwed` says the word and, in
the same breath, lowers the answer's start on every lane to just under
its lowest entry of a named partition (read off the per-partition
index, as `#forwardWhole` lowers a cover for a re-entry), and the ship
walks each lane from there to its end, so every entry of p the feeder
feeds leaves behind the word. The rule is one place, checked at the
word: whatever of p the feeder holds when the word is said, on
whichever lane, by whichever path it came (tapped behind the word,
appended since the clear, spliced by a fold, re-entered whole), sits
above the start. Neither the cover nor the spoke's tails can stand in
for it, and the fifth review (R5-1, R5-2) showed why. The fourth round
argued that a record of p tapped behind the word was taken by the same
clear, "since a paused queue lets nothing out and a clear takes the
whole queue"; false on a client link, where a flush goes on shipping
after a clear (kernel/link.ts `flush`: the clear's cover lowers the
lanes it took, so a survivor of ANOTHER lane leapfrogging the hole was
safe before this rule). A frame of p queued behind the word in the same
flush that cleared the queue survives, reaches the spoke at the drain,
BEFORE the word is said again, and the re-said word drops it; the clear
took nothing from its lane, so the cover sits at that lane's tail, the
spoke's reply (sent before the word, from the lane that still held the
frame) carries a tail at or above it, and an answer from the lower of
the two never re-sends it: px.c lost for good when a later row of
another partition held the spoke's tail on that lane (R5-2), back one
heartbeat late when the unfeed emptied the lane and the next digest
asked from zero (R5-1). Reachable when one partition is shed and comes
back inside one pause of a synced client link, with the clear landing
inside a fold's forward that spans two or more lanes. So at the end of
the heal exchange, at the reply, the spoke holds exactly what its
feeder feeds, kernel and screen, in every state p can be in: no entry;
a latch from zero, with or without the owner's own mid-latch commits;
held again, by a fold or by one minted first record; a repair latch
open on a held base; an orphan, assigned or not; a fold that carries no
remove of a row the spoke once held, because the holders released the
partition's tombstones while it was off this feeder (stage 4's
`gcRow`); and a fold forwarded across two or more lanes whose frames
leapfrogged the clear. Weighed and not taken: lowering the COVER
instead, at the clear, when `#clearCover` reads a dropped {x} (under
every entry of p then, as `#forwardWhole` does for a re-entry). It
closes the two shapes and leaves `#answer`'s head alone, but it puts the
rule in four places: what p held at the clear is under the lowered
cover, and everything of p that reaches the feeder between the clear
and the heal rests on `indexInsert` for a splice, `#forwardWhole` for a
re-entry and the append argument for the rest, the chain of claims that
broke once already; and a reader of `#clearCover` cannot see the word
being said. The start lowered where the word is said is one line under
the word, true at the word. The word is one frame straight to the
socket: `#answer` runs on a flowing link only (the DIGEST handler marks
a paused link's debt instead of answering, and the drain resumes a torn
answer only once its flush left the link flowing), so the {x} half
never meets the full-queue guard; the {e} half, after a ship that may
have paused the link, does, and the next untorn answer pays it. The
cost, taken on purpose: when p is held again at the heal, p's rows
leave with the word and come back with the same answer, a
vanish-and-return INSIDE the heal exchange. One flicker, on a cold path
(a paused client link whose queue a clear emptied), bounded to one
exchange, visible (M12 reads it), and never a ghost; and the kept cells
of a partition in flight leave with the word and come back with the
fold, as before. And the lowered start re-sends, on each lane of p, the
lane's whole suffix above p's lowest entry: rows of other partitions
the spoke already holds among them, each dropped at the spoke by the
dual fence (write.ts `#splice`, the client leg: present, dropped;
absent, spliced at its seq, which is how p's own rows come back below
the spoke's tail), one frame per run, a cold path. An orphan's frozen
rows lower the start too, for a ship that filters them out (`feeds`):
a lane suffix re-sent for nothing, dropped at the spoke, at the heal of
a cleared link while a partition sits frozen; a `feeds` test on the
lowering would save it and add a second predicate to the one line, so
it is not there. Why the two kinds sit at different places: an {x} said
AFTER the answer drops what the answer just re-sent, and nothing brings
it back — the spoke's tails equal the feeder's, so no later exchange
re-sends p (the second review's SK1: the shed's {x} cleared, p placed
back and folded on the unsynced link, the heal re-sent p's rows, then
said {e: p} and {x: [p]}; p was gone from the spoke for good); an {e}
said BEFORE the answer would judge the kept cells against a kernel the
clear left incomplete, and sweep rows the answer is about to bring.

Why not a filter. Two rounds kept the {x} after the answer and held it
back where it looked stale, and the stale test was wrong each time.
"While p has no entry" (the second fix round) held it back for a latch
from zero and for an orphan, where the answer ships nothing of p, so
the spoke kept a row the cluster had removed until the fold landed or
the orphan shed (the third review's R3-2 and R3-6). "While the feeder
feeds p and some lane holds a row of it" (the third fix round,
`feeds(p) && byPart.has(p)`) held it back for a from-zero latch at the
OWNER with one own mid-latch commit, and for a partition held again by
one minted first record: entries with no base, where the answer ships
that one row alone and the spoke kept its rows from before the shed, a
removed one among them, next to it until the fold or the repair (the
fourth review's R4-1 and R4-2). "While p is not held" loses the base of
a repair latch for good (the fourth review's R4-3 on that mutant).
Every such filter is a rule a reader cannot check without the lane
states at the feeder: which entries exist, which lane holds a row of p,
what the cover sits under. And a word held back where it was still true
can leave a GHOST: once stage 4 releases a partition's tombstones at its
holders while the partition is off this feeder, a from-zero fold
carries no remove, so a row the held-back word would have dropped stays
on the spoke for good, past every exchange, until a resync (the fourth
review's R4-4: the held shape, the teacher's fold shipping px.a alone
with no trace of px.b's remove; the release census sees holders, never
spokes). The order rule carries no such state: the word says what was
true at its place, and the answer re-sends the named partitions whole.
A word may be said
twice: a shed inside one pause whose first {x} a clear took and whose
second went out direct reaches the spoke as the direct word at the
drain, then the owed one before the heal answer's ship; the second
drops nothing (JK.unfed with b = 0; the third review's R3-1). The debt is consumed
word by word as each one ships: a word the clear
takes is owed again by `#clearCover`'s read of the dropped frames, and
the words behind it were never taken out of the debt; a word is never
pushed into a full paused queue (the next answer pays: a word there
would force a clear of the reply it follows; one guard, both kinds);
the link's death drops the debt. And a word is owed only to a link the spoke has been ANSWERED on
(a cover or a torn answer: `Link.torn`). A link never answered since
admit carries nothing of this feeder: the spoke holds nothing of it to
drop or judge, a spare's word is dropped at the spoke, and the link's
first answer is a fresh spoke's or a failover's resync, whose end sweeps
or keeps by the reply. Owing there was one end per fold per spare link,
never paid while the link stayed a spare and said as a burst of stray
ends after a later failover (SK9); and `#clearCover` reads the dropped
frames only where it leaves a cover, as before the rework. A group
whose end was lost is
closed at the spoke by the feeder's next frame of a later step (a
digest, a PING, a PONG, a FEED {x}): its frames land and it judges
NOTHING, the end is owed and comes after the heal. Weighed and not
taken: tying "ended" to the drain exchange's reply alone. A clear cannot
take that reply, but it says nothing about WHICH partitions ended: a
partition whose latch is still open must not be judged there, so it
would need the in-flight list on every drain digest (a walk per drain),
and it still misses the fold on a link whose answer is torn, where no
clear happened at all. The owed word is per partition and only where a
word was lost or withheld: cold and exact.

Two more holes the review found on the same page, closed with the rule.
The in-flight list rode a link flag the first reply used up (`#askF`,
deleted at the reply), so a reply a clear took from the paused queue
resumed without `f` and the end swept the partition under repair
(PROBE2): the flag now lives until the spoke's next digest on that link,
so a torn or cleared reply's resume carries the list. And a FEED {x}
that arrived while a fold group of the same partition was open (its end
lost) dropped the partition, and then the group landed and put a row
back (PROBE6): a FEED {x} is a frame of a later step at the feeder, so
it closes an open group first, as a digest does, and the unfeed runs on
the landed kernel, in one step.

The in-flight walk runs once per resync (only for a reply to an ask that
said `f: 1`), never per heartbeat. M11 skips the rows of the named
partitions (the spoke keeps them by design; the rows M11 is for, swept
while the feeder holds them, are not swept) and counts them
(`resyncKept`). What stays open in the rule is clause 1's cost: a record
in flight to the feeder at the fold's end (a paused owner-to-feeder link
spanning the failover, the ask, the answer and the fold; or a record
lost twice, its frame to the feeder lost, the spoke's first feeder had
it, the repair not yet folded at the end) is judged gone at the end and
comes back when it lands or when the repair folds. Bounded and visible
(M12 reads it); reached by no seeded schedule; named here, not pinned.

*Measured.* The 56-run probe on this tree, before and after the rework:
swept 0 on 56, kept on the same 12 runs the base sweeps on (7 to 20 of
forty; 9, 10, 7, 8 at the cut 0 on the four pinned seeds, where the base
swept 9, 10, 7, 8), ghosts judged 0 (every kept cell came back in the
fold; nothing in these schedules is in flight to the feeder at the end,
so clause 1 judges nothing gone), M11 0, M12 green and screen = kernel
on all 56. The two KNOWN offsets (seed 2 at 1 ms: kept 7; seed 6 at 10
ms: kept 20) are CLOSED pins now: swept 0, judged 0, no monitor, M11
counting 7 and 10 of the kept rows (the other ten on seed 6 are
re-entries from orphans, which M11 never judges). The kernel tests
(kernel/client.test.ts, seven wave-6c shapes for this rule): the
vanish-and-return (a spoke first fed by qq fails over onto aa
mid-repair; the end keeps three cells, JK.resynced c=3; the fold's end
confirms two and judges the third, a record aa never gets, gone at once,
JK.fed b=2 c=1; then lane bb's owner dies and nothing is left waiting);
the clean abort's word (a from-zero latch aborted by an install that
moves the partition off: FEED {x}, the kept cells leave); the owed end
on an unsynced link (a queue of one, the clear takes {b} and the first
frame, the exchange re-ships it, the end is said after the reply: two
back, the third gone); the owed end a later tap cleared from the queue
(a queue of four); the owed shed word (FEED {x} cleared by live taps,
said again after the exchange); the in-flight list surviving a cleared
reply (the feeder pauses inside the answer); a shed word closing an open
group first. Each is red on the first build (115a0e5) at the line that
names its bug, and nine one-line mutants of the new guards (the end
never judging; the abort's word off; the owe at the fold off; the owe in
#clearCover off; #payOwed off; the ask flag used up; the {x} landing
off; the held filter off; a lost end judging) each turn their test red.
Seven pinned scoped resync asks carry `f: 1`; the unscoped pins did not
move. The second review (2026-10-21, SK1-SK9) added the shapes above:
the stale {x} (SK1, red on the rework at "the spoke holds what its
feeder holds"), the blip onto the same feeder with an empty kernel (SK2
and SK3, red at "the screen mirrors the feeder"), the failover exit
pinned (SK8; the mutant that leaves the kept cells out of the sweep set
was green on every test before it), the never-answered link (SK9, red
at "no word is owed"; and a never-answered link whose clear took two
shed words), and the debt paid into a paused queue (a queue of one: the
reply fills it and no word forces a clear; a queue of two: the second
word overflows, the clear takes it and the reply, the third stays owed
and the drain exchange pays all three). The third review (2026-10-21,
R3-1 to R3-6) found the owed {x} held back while the partition was a
latch from zero or an orphan (R3-6 and R3-2: the spoke showed px.b,
removed at the cluster, until the fold or the shed) and the second shed
word of one pause said twice (R3-1); the rule now reads "while the
answer shipped nothing of p", with three shapes, each red on the second
round with the spoke showing px.a and px.b: a latch from zero at the
heal ("mid-latch the spoke shows nothing of px"); an orphan the ring no
longer assigns ("between the heal and the shed the spoke shows nothing
of px"); an orphan the ring assigns ("nothing of px at the spoke while
aa holds it frozen"), whose re-entry fold then brings px whole. The
fourth review (2026-10-21, R4-1 to R4-4) found that filter wrong too
(R4-1, R4-2: entries with no base; R4-4: a ghost for good once a fold
carries no remove) and the rule became the ORDER rule above: the {x}
before the answer's ship, unfiltered. Its tests in kernel/client.test.ts
(the owed shed word, eight shapes, each asserting the spoke equal to its
feeder on kernel and screen at the exchange's end and at the end): back
and HELD (the cost pinned: JK.unfed [px, 2] at the word, the rows back
with the answer, FEED [{x}, {e}]); a latch from zero; an orphan the
ring no longer assigns (R3-2's shape, px.b removed at the cluster); an
orphan it assigns; a from-zero latch at the owner with one own
mid-latch commit (R4-1; red on the filter at "between the heal and the
fold the spoke never shows a row its feeder does not hold"); held again
by one minted first record (R4-2; red at the same line, "the repair");
a repair latch open on a held base (R4-3; red on the filter at the FEED
line, no {x}, and on the old order with the base lost for good); the
stage-4 shape, a fold with no remove of a row the spoke kept (R4-4; red
on the filter at "the spoke holds what its feeder holds", px.b for
good). The cleared-shed-word test pins the wire: the drain digest, the
owed word, the capped answer, the reply. Six one-line mutants of the
order each turn tests red (kernel/client.test.ts, 91 tests): the {x}
said after the reply, the old order (six: the held test and R4-3 lose
rows for good, the wire line moves); the {x} half off (nine); each
filter put back on the {x} half ('no entry': eight; `feeds && byPart`:
five, the held test and R4-1 to R4-4; `!held`: three, the held test,
R4-2 and R4-4); the full-queue guard off (the queue-of-one pin: a word
forces a clear). The repeated word is named above.

*What moves.* Scoped trajectories with a spoke: a FEED {x} per shed and
per clean latch abort, two FEED frames per fold forwarded, the owed
words at an answer that heals a client link (one {x} before its ship
for the partitions a cleared word named, that answer's start lowered
under their entries, one {e} after its reply per
partition whose end a clear took or whose fold ran while the link was
unsynced and that is still held), `f: 1` on a scoped spoke's resync ask and the list on its
reply, `c` on a drain digest
after a clear and the r=1 it buys. The scoped sweep's counts stand
(16/16 green before and after the rework: spokeStale reads 0 where it
read 6; sighting 3's swept counts are kept counts now; the mutation pins
did not move). Unscoped: byte-identical where no clear ever happened on
a client link (FEED and `f` are armed-only; `c` rides only a drain
digest after a clear, which the golden, the 300-seed sweep, 59,500 and
104,050 never see).

*Left for its own change.* The api line (a spoke's write can settle
before its value shows when its feeder dies between the WACK and the tap
and the next feeder lags the record): the pieces are here now — the
reply's `f` says which partitions the new feeder is folding, and the
spoke's lanes after the re-download say which it feeds — so the end
could wait for the tap instead of settling through `acked` when the
write's partition is named or fed; the attempt's partition is not kept
on a client's awaiting entry yet (write.ts `#awaiting`, `p` is '' there)
and the known-cost pin in sim/feeder-death.test.ts would flip. Not built
in this wave.

## §0 The decision, in ten lines

1. On a scoped cluster the heartbeat DIGEST between members stops. A holder
   tells a partition's other holders its floors when they change, in the
   HAVEQ frame it already sends, plus a slow sweep that re-proves every
   partition once in a bounded number of ticks. The admit and drain digests
   stay, but they sync the link only and ship no records to a member. There
   is then exactly one way for a member to receive history it lacks: the
   one-teacher latch with its attested cut.
2. Compaction turns on for scoped nodes, one (lane, partition) at a time,
   behind a frontier: an entry drops only if it is not its cell's winner and
   every current holder of its partition has attested, on crash-stable
   floors, that it is past it. Orphaned, acquiring and unsealed partitions
   never compact. A lane's last entry never compacts. A teacher ships
   exactly what compaction keeps.
3. Tombstone GC turns on per partition under three gates: a **census**
   (every member installed this epoch and holds no orphan), a **holder
   quorum** (every holder is gapless and at the same crash-stable floor on
   every lane that touches the partition), and **lane accounting** (every
   node that ever owned the partition since its last release is a current
   member). The release is one step: the stamps go, and so does every lane's
   dead entry for those cells.
4. A clean leave drains first: a leaver stays until the new holders have
   its rows. That is what makes "scale down to 1" lose nothing. A node that
   crashed and was voted out pins its partitions' tombstones until it comes
   back; the pin is shown, never silent.
5. The panel found two holes in today's UNSCOPED tombstone GC (a short lane
   keeps a dead update after the remove is compacted; an evicted owner's
   stranded write comes back after heal). Both re-run here. They are filed
   now and fixed by their own decision, because the fix moves unscoped
   trajectories.
6. The harness comes first (stage 0). Every rule must turn a monitor red
   when it is switched off, on a schedule the harness can build, before the
   rule lands. That is the I-20 lesson (docs/DESIGN-LEAVE.md §9).
7. Unscoped clusters do not move. Every new path sits behind `node.armed`
   (kernel/node.ts:325). The 20-seed golden, the 237,451-event sweep, the
   59,500 formation pin and the 46 perf pins stay byte-identical.
8. Six stages, each shippable alone, each gated by the harness, the battery
   and the perf tier. Stage 3 (compaction) is a safe resting point if stage
   4 (GC) does not pass review.
9. The `methods.update`-from-a-non-holder bug lands in stage 1 as the
   `acked` effect. The forwarded array-remove bug is a separate one-line
   follow-up, to land before stage 4's bounded-log pin.
10. Out of scope: the member mesh itself (PING/PONG and the VIEW flood are
    O(n²) and stay so), the door, the platform.

**What the owner must say yes to** (§14 has each with a default): retire the
member heartbeat digest on scoped clusters; GC waits for evidence instead of
fencing and dropping (a crash-evicted node pins until it returns or an
operator forgets it); a clean leave is slower on a scoped member; R=1 loses
a partition on a crash until its disk returns; two unscoped bugs are filed
now and fixed by a separate decision; the harness and the two bug fixes
land before any protocol change.

## §1 The problem, and what "at scale" means in numbers

The owner wrote on 2026-10-05: *"Replication and compaction must work
properly before the platform work, so users can scale out for capacity"*,
and about membership: *"need to be able to say can scale down to 1 or up to
any number"*. Today a scoped cluster cannot scale out for capacity, for
three reasons that are one design.

First, a scoped node never forgets anything. `maybeCompact` returns before
any pass when the node is armed (kernel/log.ts:160), so compaction and
tombstone GC are both pinned. The pin is deliberate: the unscoped frontier
ranges over every member's lane tail (kernel/log.ts:76-85), and under
scoping a non-holder's tail says nothing about a holder's possession. The
comment names DESIGN-M6 C3 as the fix. Memory grows with every write, for
ever, and a durable node re-encodes the whole log at every WAL snapshot
(kernel/node.ts:905-950).

Second, anti-entropy costs O(n²) frames every tick whether or not anything
moved. Every heartbeat the lower uuid of each admitted pair sends a PING and
an r=1 DIGEST (kernel/node.ts:721-730); the peer answers r=0 (:1449). The
digest lists every lane's tail (:1536-1538), and the answer walks every
lane's suffix before the scoped filter runs (:1428-1434). The filter is
ring-derived, not announcement-gated; the code says so itself: "slice 3b
tightens to possession-announced" (:1417-1418), and that slice was never
built (no `announced` set exists on `Link`). STATUS.md:63 and :64 carry both
halves of this and say they are coupled.

Third, the handshake re-announces too much. Under steady writes an owner's
floors run ahead of its co-holders' marks until a round answers, so
`#lagging` (kernel/scope.ts:721-734) fires a FULL round to every co-holder
every two ticks (:715-716), announcing every held partition each time.

These three are coupled, as STATUS.md:64 says. Un-pinning compaction while
members still heal through ring-filtered multi-source AE would reopen H3,
the two-teacher resurrection (docs/DESIGN-M6.md §2 H3; sim/scoped-repl.
test.ts:115-120 relies on "multi-source is provably safe with no
compaction"). So AE changes first, compaction second, GC last, in that
order, and the record covers all three.

**The numbers this design is for.** Members 1 to 100 (the sim's n=100 tier;
the design is valid to the member bound but the mesh is the ceiling past
about 100-200, §10). Replicas 1 to 5, design point R=3; W is the majority
of the R-set (kernel/confirm.ts:177-180). Partitions: 3,000 measured, sized
for 1,000,000 (about 30,000 held per node at n=100, R=3). Writes: about
1,000 per second cluster-wide (the relay measured about 110 µs per relayed
record on 2026-10-09, STATUS.md:30). Idle bytes per tick, n=100, R=3, 3,000
rows: today about 3 MB, almost all digests; the target is under 100 KB of
non-PING traffic. Logs: after the change, entries per node are bounded by
live winners plus `compactAt` slack per lane, and a quiet partition's
tombstones go to zero. Today both grow without bound.

**Where today's design stops.** (1) log.ts:160, as above. (2) The digest
floor: n(n−1) frames per tick, pinned at n=25 unscoped (sim/scale.perf.ts:
56-71); sim/scale-run.ts:154-156 already notes that at n=100 and hb=100 the
floor alone passed 10M events. (3) The lag round (scope.ts:715-734). (4)
Every hand-over operation scans the whole log: `#tailsOf` (:280-288),
`#teach` (:485-487), `#abort`'s residue check (:616) and `#shed` (:675-678)
each filter every lane for one partition; `rescope` walks every cell,
version and entry (:162-164). (5) Every install clears all marks and
re-announces every partition (:168-169, :202). (6) A clean leave finishes
on the first VIEW without the leaver (kernel/membership.ts:448-452) and
never waits for scoped hand-over; at `replicas: 1` the leaver's rows go
with it. (7) `writesPlan` draws from 5 names × 4 suffixes (sim/harness.ts:
77-81), so every scale test has at most 20 partitions: nothing about many
partitions per node is tested today.

## §2 Today, measured

The panel ran six probes. Three were re-run here (marked **re-run**),
read-only against the untouched tree through the low-priority runner; the
others are the panel's numbers, consistent with the code and the arithmetic
but not re-measured.

| Probe | Setup | What it found |
|---|---|---|
| Frames at a join (protocol) | sim, seed 13, n=30, R=3, hb 200, delay [1,1], 300 single-row partitions, then one join | During the join: DIGEST 52,110 frames = 6.77 MB, **93% of frames and 80% of bytes**; HAVEQ 2,555 (about 2.75 full co-holder rounds); 38 partitions moved, 38 shed, 0 aborts. 300 writes cost 1,067 HAVEQ + 1,067 HAVEA (3.7 pairs per write, all from the lag round). Idle after the join: 930 DIGEST per tick, 0 handshake frames. |
| Frames at n=100 (operator) | sim, seed 0, n=100, R=3, hb 200, 3,000 rows then 600 removes | Idle: DIGEST 9,900 frames = **2.93 MB per tick** (mean 296 B); PING/PONG 4,950 each. The digest answers' suffix walk visited **868,353 entries per tick and shipped none**. Write window: 1,890 HAVEQ + 1,890 HAVEA per tick. 10,800 log entries and 1,800 tombstones, never reclaimed. 54.2 co-holders per node of 99. Formation: VIEW flood 22 MB, DIGEST 13.1 MB. |
| Co-holders (storage) | ring.ts as is, VNODES 32, 100,000 rows | n=100, R=3: each node shares a holder set with 64 / 72 / 79 of 99 peers (min/median/max); 7,148 ordered co-holder pairs of 9,900. **A digest limited to co-holders saves about 28%.** One join changes 2,771 of 100,000 holder sets. |
| Tick-pass cost (storage) | unscoped kernel, isolated passes | gcTombstones walks 1,000,000 versions in 168 ms per idle tick (log.ts:138-146). A `compact()` pass over a 100,000-winner lane that drops nothing costs 92 ms and re-runs every tick once the lane is at `compactAt` (log.ts:162-166, `JSON.stringify` per entry at :98). |
| Short-lane resurrection, unscoped (storage) — **re-run** | sim, 2 nodes, hb 50, `compactAt` 64, `snapshotAt` 32; x written on z's lane, ownership moved, a removes x, then 100 other rows | After quiescence: tombstoneGC 1/1, compacted 1/1; the remove is gone from a's lane, the superseded write is still in z's one-entry lane, version of x undefined on both. Memory: a joiner ends with x = {v:1} while a and z have it absent (`converged`: "n01 vs n03 at [x]: undefined vs {v:1}"). Durable: after three snapshots `sim.restart('n01')` comes back with x = {v:1} from its own disk. |
| Zombie lane, unscoped (storage) — **re-run** | sim, 4 nodes, hb 50; x pinned to z; z commits x={v:2} with its links unsynced, is cut off and evicted; a removes x at epoch 2; all three GC; heal | After heal n01-n03 hold x = {v:2} with version {epoch 1, seq 2, origin n04}; n04 holds nothing; `sim.violations` is empty. A remove stamped at epoch 2 lost to a write stamped at epoch 1, and the cluster split for good. |
| Teach ships losers (protocol critique) — **re-run** | two armed Nodes, hand-driven | A teacher holding U (lane bb, seq 1) and R = remove (lane xx, seq 5), with the proposed GC and a compaction of lane xx applied by hand, ships `bb:1` with cut {bb:1, xx:5} to a from-zero learner; the real latch and fold leave the learner with g = 'old' while the teacher has none. A lagging learner at floor bb:3 is shipped only seqs 4-5: the delta teach ships nothing at or below the learner's own marks. |

What the first two rows say together: the member digest is the cost, and
cutting its graph (co-holders only) saves little because at real partition
counts almost every pair shares a partition. Frames must be cut by
**cadence**, not by graph. What the last three rows say: tombstone GC and
compaction are one rule or none. A release that drops the stamp but leaves
a dead entry on any lane resurrects the cell at the next fresh fold, and
today's unscoped kernel already does exactly that. The `single-writer`
monitor rows the short-lane probe prints are the probe's own artefact (it
moves ownership through the ring's test seam at one epoch, as its comment
says); the resurrection does not depend on them.

Read, not run: `#floorSeed` persists `[s, d]` per (lane, partition) (node.
ts:1062-1072) and the constructor restores `pe.s = sd[0]` (node.ts:287-294).
The boot record is written synchronously and fsynced (shell/runtime.ts:
249-259); WAL rows are queued and fsynced later (:182-208). So a restored
`s` can claim rows a crash ate, which contradicts "a stale seed is honest-
low" (DESIGN-M6 §7). Stage 0 probes it (A4 below). If it holds, the fix is
one line (cap the restored `s` at `d`) and moves scoped durable
trajectories only.

## §3 The anti-entropy design, frame by frame

**Who announces.** Every node that holds partition p, sealed (folded, and
on disk if durable: kernel/scope.ts:273-276), announces its floors for p.
Orphans keep announcing their frozen floors to p's CURRENT holders (the
shed poll, :293-311). Acquiring nodes and unsealed bases announce nothing,
as today.

**To whom.** Only to p's other current holders, from the memoized ring
(kernel/ring.ts:154-166). An orphan announces only to current holders. A
non-holder's confirm probe asks only the holders of its probe partitions
(scope.ts:315-328), as today.

**When.** Four triggers, all armed-only:

1. *On change.* Every floor advance marks p in a per-node `dirty` set: one
   `Set.add` per (partition, frame) at the stamp site (node.ts:839), the
   fast path and splice (write.ts:681, :750), the fold (scope.ts:556-563)
   and the arming truing (:192-201). At the next tick every dirty partition
   goes to each co-holder in one batched HAVEQ per link, as `round()`
   already builds it (:297-311), restricted to the dirty set. A co-holder
   that has never answered for a held partition (the `!per` leg of
   `#lagging`, :729) counts as dirty until it does, so a lost install offer
   still heals within a tick, as today. The "trails" clause (:730) goes:
   after a write the owner's one announcement carries the new floor and the
   answer carries the co-holder's; marks converge in one round trip instead
   of a full round every two ticks.
2. *On (re)admit and on drain after a pause.* The admit round (node.ts:
   1225) goes to the admitted peer only, for the partitions the two share.
   A drained link whose queue dropped (node.ts:703-706) gets a scoped round
   to that peer instead of a record-carrying digest. The heartbeat skips
   paused links (node.ts:721); so does the round.
3. *On install.* Today a full round (scope.ts:202). Stage 5 shrinks it to
   the partitions whose holder set changed.
4. *The sweep.* Each tick a node re-announces its held partitions to the
   next `aeFan` co-holder links in uuid order (a cursor that survives
   installs; a new tune row, default 8), so every pair is re-proven from at
   least one side every ⌈c / aeFan⌉ ticks, c = co-holders (about 9 ticks at
   n=100 with c ≈ 72). This replaces the heartbeat digest's "belt and
   braces against any loss mode" (node.ts:724-726) with a bounded cost. A
   lost announcement delays evidence (compaction and GC wait, the safe
   direction); the sweep heals it.

**Targeted rounds.** `round(node, only?: Set<Link>, parts?: Set<string>)`
gains two filters. The post-fold round (scope.ts:592), the `sealed` round
(:604), the probe-driven round (:715) and the orphan poll go to the
partition's holders only, not to every co-holder. The protocol critique
counted these as full rounds per acquisition; they are, today.

**What a digest covers now.** On an armed node the heartbeat loop
(node.ts:730) sends no DIGEST on a member link: `if (!this.armed ||
link.client)`. The admit and drain digests still flow once per (re)admit
to set `link.synced` (node.ts:1447), but on an armed member link the
answer's suffix walk (:1428-1443) is skipped: the frame still answers r=0
and still syncs. A client link is unchanged: it floors its primary only
(node.ts:1394-1403) and keeps the held-subset suffix (:1423). The DIGEST
wire shape is untouched (DESIGN-M6 rule 2); what changes is when it is
sent and that it carries no records to a member. Reviewers may read that
as a rule break; it is a cadence change on the same bytes.

**The HAVEQ body is the digest for a holder set.** Today: `{e, q: {p: {o:
floor}}}` (scope.ts:329-330). Three optional top-level maps join it, all
armed-only: `d: {p: {o: durable floor}}` from durable nodes (today `md`
rides only on a HAVEA ok answer, :382-386; GC and shed need it on both
legs); `g: [p…]`, the partitions for which this node is **gapless** (on
every lane that holds entries of p, the content tail equals the floor —
the code's definition since stage 2, narrower than "every lane of p": a
lane with a floor and no entries of p cannot arise before stage 3, and once
compaction drops entries below the floor, "tail = floor" reads false at
every compacted holder, so stage 4's R2 must redefine the bit before it
reads it; noted at the stage-2 review); `x: [p…]`, the
partitions this node has just released (sent by `#shed`, :670-687, in the
same step as the boot write). They are top-level because `onHaveQ`
iterates a partition's object as lanes (:354). HAVEA's per-partition object
is read by named fields (`ok, need, m, md`, :347), so it gains `x: 1`
("none: I neither hold nor am assigned this", replacing the silence at
:362) and `g: 1` in place. On `x` the receiver deletes that peer's marks
for p. No MAGIC bump: a reader ignores unknown keys, and mixed versions are
unsupported before 1.0 (V4-14).

**Frames at n=100, R=3, 3,000 rows (90 held per node).** Idle: 0 member
DIGEST (today 9,900); the sweep sends about ⌈90 / 9⌉ ≈ 10 partitions' floors
to 8 links per node per tick, so at most 800 HAVEQ + 800 HAVEA cluster-wide,
about 100 KB; PING/PONG stay at 9,900 frames (118 KB). Writes at 200
distinct partitions per tick: 2 × (R−1) = 4 entries per written partition,
batched per link, about 800 frames and 60 KB (today 9,900 DIGEST + 3,780
handshake frames, 2.28 MB). One join: about 3/101 × 3,000 ≈ 89 partitions
move; stage 5 brings the install round to about 89 × 3 entries plus 89
teaches (today about 9,000 entries re-announced from every node). At P =
100,000 (30,000 held per node at n=100) the sweep carries about 3,300
partitions per tick per node across 8 frames, roughly 60 KB per node: close
to today's digest bytes but with zero wasted entry visits, and the sweep
cadence `aeFan` is the knob. The counted law per node is Σᵢ 2·min(aeFan,
cᵢ) frames per idle tick.

**A holder set that changes mid-announcement.** Every HAVEQ, HAVEA and
ACQDONE carries its epoch and is dropped on mismatch (scope.ts:341-344,
:401-404, :532). The VIEW floods before the rescope round on the same FIFO
link (membership.ts:495-498), so a peer installs before it reads the new
round. Install clears marks (:168-169), aborts every latch (:170), freezes
what left the R-set (:173-181). A release `x` with a stale epoch is dropped;
the stale pin it would have cleared is cleared by the `none` answer when
the sweep next asks that peer about p ("you claimed p; do you still?"). An
acquisition that spans an install aborts whole (:611-635). The sweep cursor
is an index over the sorted link list; a view change only changes which
links share partitions.

## §4 The compaction design

**Rule C, per node h, per lane o, per partition p.** Entry e = (o, q, p) may
drop at h iff:

- (C1) p is `held` and sealed at h, with no latch open (orphans are frozen
  and their content tails are the shed evidence, :646-664; acquiring and
  unsealed bases attest nothing).
- (C2) e is not its cell's current winner: `compact()`'s existing test
  (log.ts:96-101). A remove is a winner while its tombstone lives, so it
  survives until stage 4 releases it. V4-18 is already handled: a field
  swept by a row write carries the row's stamp as its version (node.ts:
  1623-1637), so its own entry is a loser; a fenced field remove keeps its
  stamp (node.ts:1759-1765) and its entry.
- (C3) q ≤ F(o, p) = the minimum over every CURRENT holder of p (self
  included) of its crash-stable attested floor for (o, p). Self reads
  `parts[p].d` when durable, else `.s` (the `stableMark` ladder, log.ts:
  71-74). A peer reads its `marksD` if it has ever announced a `d` map,
  else its `marks`. Absent is 0 and pins. An acquiring or unsealed holder
  has attested nothing this epoch, so it pins F at 0 (DESIGN-M6 C3's named
  invariant). Orphans are not in F: they never advance, never learn, and a
  loser is never needed for state.
- (C4) e is not the lane's last entry. The digest to a client reports the
  lane tail as the last entry's seq (node.ts:1538), and a client resyncs
  when its applied runs past its feeder's tail (node.ts:1397-1399). Keeping
  the tail entry keeps the spoke contract untouched.

**Why the frontier holds when the holder set can change.** F ranges over
the holders at the moment of the pass. (a) Every current holder already
holds or covers e, so none needs it. (b) A future holder never learns from
a compacted log through a seq chain any more: after §3 no member receives
AE suffixes, so it learns through the one-teacher fold, whose cut sets its
floors (scope.ts:556-563) and whose records are the winners. (c) The stored
pp chains of later entries are needed only by nodes below F; there are none
among current holders. (d) A held-delta learner's marks are at or above F,
because it is one of the holders F ranged over and floors are monotone in
one life. **Stage 3 therefore requires stage 2**: today the admit/drain
digest still ships ring-filtered suffixes with stored pp (node.ts:1436-
1441), and a compacted lane's kept winners point at dropped losers, so a
suffix receiver's chain walk would stall at every gap.

**The teacher ships exactly what compaction keeps.** One predicate,
`keep(e)` = winner ∨ above F ∨ tail, shared by `compact()` and `#teach`
(today `#teach` ships every entry above the learner's marks, :485-487, no
winner test). The re-run probe in §2 shows why this is load-bearing once GC
exists: a from-zero learner taught losers without their remove shows the
removed row. In stage 4 the GC step drops the released cells' entries on
every lane, so this filter is a belt; it is also what makes a learner's
fold equal the teacher's state while a pass is mid-way.

**The dedup window.** A loser that carries an attempt identity (`iss`,
`cid`) feeds the dedup window on every node that applies it (write.ts:695,
scope.ts:552), so a retry whose WACK was lost dup-acks its original
coordinates after an owner move (the M3 exactly-once story, write.ts:381-
384). A from-zero acquirer of a compacted partition would not learn a
compacted loser's cid; if the issuer is still retrying across the owner
move, the new owner re-commits it with a fresh stamp and an old value lands
on top of a newer one. The fix: armed dedup entries also record the
partition, and ACQDONE carries `w: [[iss, cid, seq, epoch]…]`, the
teacher's window entries for p; the learner feeds its window. Bounded by
the window itself (`dedupKeep` × issuers, kernel/tune.ts:72-75). The
alternative, keep every loser that carries `iss`, unbounds the log under a
steady client workload (every relayed write carries one).

**Trigger.** Today's size-armed trigger stays (`compactAt` 4,096 per lane,
log.ts:50-51, tune.ts:80-81) with F memoized per partition per pass. A
lane at or over `compactAt` whose pass dropped nothing is not re-walked
until its length or any relevant mark changes (a per-lane memo of (length,
F-version)); the storage critique showed that a memo on length ALONE
(hysteresis to 2 × kept) can stop compaction for good when F was pinned at
the pass, so the memo keys on both. Unscoped keeps log.ts:162-166 as it is
(the 92 ms re-walk per tick is a follow-up, §12).

**What an acquirer needs re-taught, and from whom.** One teacher, chosen
by the existing latch (:356-361, :373-376, :423-431): a sealed current
holder, or an orphan when no current holder has p yet (grow past R, H2's
A leg). It ships `keep(e)` entries above the learner's marks, then ACQDONE
with the cut, `w`, and (stage 4) `o`: the lane-accounting set for p.

**The WAL replay of a holder.** Compaction rewrites memory; the next
snapshot swap writes the compacted log atomically (node.ts:905-950, the
swap after `maybeCompact` at :739-744). Replay rebuilds floors from the
boot record's seed and then only through chain-verified rows (write.ts:
846-849). Compaction opens pp gaps at or below F ≤ my own durable floor,
so the seed must cover them: a pass that dropped entries arms the snapshot
(`#walRows = snapshotAt`, the `spliced()` idiom at node.ts:333-339) and
the boot record is written WHEN THAT SWAP IS ISSUED (`snapshot()`, right
after the swap is handed to the sink; before the second review it was
written at the swap's echo, which left the window below). The seed it
carries is the pre-swap durable floor per (lane, partition): at or above
every gap the pass opened (the pass dropped at or under it), and backed by
either file on disk — the old WAL has no gap above it, the new one none
at all. The shell writes the record synchronously and queues the swap, so
the seed lands first; the sim lands the swap at once. So every crash point
restores floors that chain to the content: before the swap lands, the old
rows under the new seed; after it, the compacted rows under the same seed;
the echo writes nothing more. The marks a durable node announced are
therefore never above what its disk restores on account of compaction,
which is what C3 and the shed assume when they count them as crash-stable
(a splice's dirty partition is DESIGN-M6's own honest-low case, zeroed at
the restore, unchanged here). With the write at the ECHO, a crash after
the swap's fsync and before its echo restored the compacted lanes under
the OLD seed: replay chained from it, stopped at the first gap, and the
floors came up below the content — one re-latch (the window test's
mutation: 5), nothing lost in stage 3, but peers' C3 frontier and the
shed had counted the announced marks as crash-stable until the reborn's
HELLO voided them, which stage 4's R2 would have inherited. Memory nodes
have no replay and no constraint.

**Memory after the change, per node.** Log entries ≤ Σ over lanes of
(winners for held partitions + `compactAt`) at quiescence; winners = live
cells + fenced field removes + removes whose tombstones are pending. At
1,000,000 rows, n=100, R=3: about 30,000 winners per node (about 7.5 MB at
250 B each) plus slack on hot lanes.

**Shed on durable marks** (STATUS.md:64). `evaluateSheds` (:646-664) reads
the same crash-stable ladder as C3: `marksD` for a durable holder, `marks`
for a memory one. Strictly more conservative than today; moves scoped
trajectories only. Lands with stage 3.

## §5 The tombstone GC design

**The hazards that shape it**, each named by a critique and checked against
the code:

- **G1 lane-skew.** update(X) on lane o1, remove(X) on lane o2. GC drops
  X's stamp (log.ts:143); o2 reaches `compactAt` and drops the remove (no
  longer a winner); o1 is short and keeps the dead update. Any fresh fold
  (a joiner's teach, a durable replay at write.ts:850, a reborn holder's
  re-ship) shows X again. Re-run here on today's unscoped kernel (§2).
- **G2 the stale possessor.** An orphan frozen before the remove, cut off
  through the GC, re-assigned later; or a durable holder evicted and
  rebooting with old content; or an owner demoted at install that keeps
  minting at the old epoch until it installs (its fan-out carries no epoch
  check at the receiver: node.ts:1247-1249 raises `staleObserved` only for
  a HIGHER epoch; the gate admits a held partition, write.ts:633-645). A
  from-zero learner latches the first announcer (scope.ts:356-361); a
  lagging holder latches any announcer ahead of it (:373-376). Re-run
  here as the zombie lane (§2).
- **G3 volatile floors.** HAVEQ `q` carries raw `s` floors (:260-267,
  :309); `md` rides only on ok answers (:382-386). A durable holder that
  attested `s` covering the remove, then crashed before its row was
  fsynced, reboots without the remove but with the update; if the stamp is
  already released and compacted everywhere else, nothing re-teaches the
  remove. The seed-27 class `stableMark` exists for (log.ts:65-74).
- **G4 floors versus content.** Floors may lawfully under-claim content
  (DESIGN-M6 §7: epoch-0 rows carry no pp, bootDirty restores, gap-folds);
  the shed bar moved onto content tails for exactly this reason (scope.ts:
  637-645). A partition whose floors are stuck below content can look
  "all equal" with records above the floor sitting in a holder's log.
- **G5 the lying disk.** A disk that lies about a lane's newest row
  overstates a durable floor by one row (log.ts:62-64; STATUS.md:63).

**The rule R(p)**, evaluated at a current, sealed holder N of p, at epoch
e, once per tick, only for partitions with pending tombstones (a per-
partition tombstone index, §7 stage 1):

- **R0** N holds p, sealed, with no latch open for p.
- **R1 Census.** Every member of view e has sent N a `CENSUS {e, z: 1}`:
  it has installed e (so it stamps at e or later only, and by FIFO every
  older frame from it to N has already arrived) and holds no orphan and no
  latch whose pre-state was orphan. A member sends `z: 1` after install
  when its orphan count is 0 and again whenever the count returns to 0; it
  sends `z: 0` when it freezes an orphan mid-epoch (`#abort` with residue,
  :611-635). `z` is last-value per member, not monotone. A lost `z: 0` is
  safe: a mid-epoch orphan's content was announced before the freeze and
  R2 already covers it. One small frame per member link; the table clears
  at install. New verb, numbered at landing (after the door's `DOOR`, 26:
  docs/DESIGN-DOOR.md §2).
- **R2 Holder quorum.** Every current holder h of p (N included) has
  attested at epoch e, sealed, gapless (`g`), and for every lane o of p
  (every lane with a (o,p) entry here, a mark here, or an announced tail):
  min over h of the crash-stable floor(o,p) ≥ max over h of floor(o,p) ≥
  N's own content tail for (o,p). Crash-stable = `d`/`md` for durable
  nodes, `s`/`m` for memory ones. So every record of p that any holder has
  is at every holder, durably where disks exist, and nothing of p is in
  flight between holders (an owner stamps and floors in one step, node.ts:
  807-839; equality means every possessor is at that point).
- **R3 Lane accounting.** Each held partition keeps `owners(p)`: every
  **uuid** that owned p at some epoch since p's last release. Added at
  each install from the old and new rings, inherited by learners through
  ACQDONE `o`, merged across holders in the round, persisted in the boot
  record beside the floor seed (node.ts:1056). Release needs every uuid in
  `owners(p)` to be a current member of e; then R1 covers its content. A
  uuid is the right key, not a life: a life never returns (`origin =
  uuid~incarnation`, node.ts:270), and the only way a departed life's
  stranded record can re-enter is its own disk replayed by the same uuid
  (node.ts:352-355), which a durable restart does and a memory restart
  cannot. The storage proposal keyed it by life; its critique is right
  that this would pin for ever after ANY restart.
- **R4** The cell is not live and not fenced (node.ts:1759-1765, V4-18
  rule 5).

**The release step**, one synchronous step at N (I-7, closes G1): delete
the version of every non-live, non-fenced cell of p; drop every non-winner
(·, p) entry on every lane (O(row) through the per-partition index); unlink
the deep index; clear the tombstone index for p; journal `gcRow(p, n)`;
set `owners(p)` to the current owner's uuid; arm the snapshot. A field
tombstone and its row's tombstone go together (V4-18: a late field write
older than the row's stamp must still lose, node.ts:1577-1594, so one row's
tombstones never go half). The next compaction pass has nothing left to
drop for those cells.

**Why a late older write still loses.** Its stamp is below the tombstone's.
By R1 no member can mint it now (every member stamps at e or later; the
tombstone was stamped at e or earlier, and a write minted later carries a
newer stamp and wins lawfully). By R2 it is at every holder already or in
flight to none of them. By R1 it is not frozen at any member's orphan. By
R3 every node that ever stamped p is a member, so R1 and R2 cover its
copies. So at release time no copy exists outside the holders, and the
holders all have the remove. Afterwards no fold anywhere can bring it back:
the holders' logs no longer contain it (the release step), teaches ship
winners only, and no member receives AE suffixes.

**Partition retirement.** When a release leaves p with no live cell, the
scope entry and its marks go, `owners(p)` goes, and the round stops
announcing p. The floors `parts[o][p]` stay for lanes whose uuid is a
current member (they are the pp anchor the owner's next stamp chains from:
`lastStamp` is never cleared, node.ts:810-815, so the first write to a
re-created row carries pp = the old last seq and needs a floor to chain
from) and drop for lanes of non-members. A fully removed partition thus
keeps about one small number per member lane that ever wrote it, surfaced
as `cluster.partitions.retired`. Reclaiming that too means retiring
`lastStamp`, which is the pp forgery window (node.ts:812-814); a mechanism
is sketched in §12 and left as a follow-up.

**Hot rows.** R2 needs p quiet on every lane. A row whose fields are added
and removed many times a second keeps its field tombstones until it
pauses. Logs stay bounded by compaction; only the stamps wait. Surface it;
do not weaken it. A per-tombstone refinement (quiet only on lanes older
than the tombstone) is designed if a workload needs it.

**What is pinned, and shown.** `cluster.partitions` gains `tombstones` (a
count), `gcWaitingOn` (uuids pinning any release, like `shedWaitingOn`,
api/index.ts:596-606) and `retired`. A uuid that was crash-evicted pins
every partition it owned since that partition's last release until it
rejoins (and its content surfaces and sheds) or an operator forget door
exists. A clean leave drains first (§7 stage 1), so scaling down leaves no
pin. The lying disk (G5) stays a written residual until chained durable
marks land; it matters more once releases are per partition and frequent.

**The shared residual, named.** A frame from an EVICTED member that was in
a TCP buffer when it died, arriving after the eviction's install, carries
an old epoch and is not covered by R1 (the member is gone) nor R3 (it is
pinned only if it owned p). Eviction takes about 4 s (V4-20) and TCP
flushes in milliseconds, so it is practically nil but not evidence-based.
Adversary A10 tries to produce it; if the sim can, the fix is a one-epoch
GC floor (a stamp is released only when its epoch < e − 1), decided then.

## §6 The safety argument, and what the harness checks

Each invariant: why it holds, and the monitor that checks it. Every
expected-empty monitor carries a vacuity guard like `exactlyR`'s (sim/
monitors.ts:322-328), and every new per-event monitor walks only the node
that stepped (STATUS.md:66).

- **I1 Exactly-R** (existing, monitors.ts:320-343). Duty is a pure function
  of the committed view; `rescope` runs at every install (membership.ts:
  498); the no-bypass rule still gates every entry into `held` (scope.ts:
  4-13). §3 changes when offers arrive, not what they mean.
- **I2 Holders agree** (existing, `scopedConverged`, :289-314). Every
  record reaches a holder live (node.ts:853-857) or through one teacher's
  cut; LWW is total and identical everywhere; compaction keeps winners; GC
  fires only when nothing older is in flight (I7).
- **I3 Floor soundness** (the pp law, DESIGN-M6 §7; widened). floor(o,p)
  = s ⇒ my log contains every (o,p) record ≤ s, or a version I hold
  dominates it, or it was released under R(p). Floors advance only by
  sender-stamped predecessor (write.ts:681, :749-754) or an attested cut
  (scope.ts:556-563). Compaction never touches floors; the seed is
  rewritten before replay can need it. Monitor **M5 floorTruth**: per
  event, against the sim's global ledger of every minted (origin, seq,
  partition).
- **I4 Winners-only compaction** (new). An entry is dropped only if C1-C4
  hold. Monitor **M2 frontierSound**: every `JK.compacted` row (which
  gains the partition) is re-checked against the holders' REAL floors in
  the sim, not their marks, and every dropped entry was a non-winner.
- **I5 One teacher, no member AE** (existing, narrowed). A member receives
  history only through its latch. Monitor: `stageDrop` expected-empty in
  lawful runs, plus a counted law that an armed member link receives zero
  AE records (`aeShip` to a member = 0).
- **I6 Repair liveness** (new; replaces the digest floor). If holder x
  covers (o,q,p) and holder h does not, h hears x's higher floor within one
  tick of x's floor moving, or at the next (re)admit, or within ⌈c/aeFan⌉
  ticks at worst, latches x and folds the gap. Monitor **M7
  repairLiveness**: once writes stop, every partition's holders have equal
  floors within ⌈c/aeFan⌉ + `stageTicks` ticks. *Amended at the stage-2
  review (2026-10-10):* M7 has two forms. The floor form (`floorsAgree`)
  cannot see either repair leg in the sim — a sim link loses no frame, and
  every loss the sim can make (a cut, a pause, an install) is healed by a
  round of its own (the re-admit, drain or install round) — so it stays
  green with the owner's dirty mark dropped and with the sweep off. The
  KNOWLEDGE form (`marksAgree`) is what the two legs repair: once writes
  stop, every holder's marks of each co-holder equal that co-holder's floors
  (h HEARD x; durable marks the durable floors). It sees both legs: with the
  sweep off, a co-holder↔co-holder pair of an R=3 partition (neither is the
  owner, so neither announces for it) never hears the other's floor again
  after a write; with the dirty mark dropped too, an owner↔co-holder pair
  does not either. Stale knowledge is a liveness hole (compaction and GC
  wait on marks), never a safety one; both forms are `notLive` in the sweep.
- **I7 Release safety** (the goal). After a release of tombstone t for
  cell k in p at any node, no record stamped below t, for k or any cell
  under k, is ever applied at any node that holds p. Holds by R1 + R2 + R3
  and the release step (G1). Monitors **M1 stampOracle** and **M3
  releaseSafety**.
- **I8 Census truth** (new). A member counted `z: 1` at e stamps nothing
  below e and holds no frozen content of p. Monitor **M6 censusTruth**: at
  every `gcRow` the sim checks ground truth only it can see: no node
  anywhere (member or not), no frame in any link queue, no row on any
  stored WAL holds a record of p stamped below a released stamp that the
  releasing node lacks. This is the check the operator critique asked for:
  in-flight frames and crashed disks, not only live nodes.
- **I9 Lane accounting** (new). Every uuid that could hold an undelivered
  record of p, other than the current owner, is in `owners(p)`. Only
  owners stamp p (single-writer per partition per epoch); owners are added
  at every install that changes ownership, inherited at every fold,
  persisted at every boot write, merged across holders. A uuid leaves the
  set only at a release, when R1-R3 proved it has nothing unseen. Monitor:
  part of M6.
- **I10 Epoch scoping** (new). Every compaction and release decision uses
  only evidence attested at the current epoch: every evidence frame
  carries `e` and is dropped on mismatch; install clears marks, marksD,
  the census table and aborts latches before the new round.
- **I11 Durability** (new). A durable holder counts at its durable floors;
  a just-folded base attests nothing until its snapshot echo (`sealed`,
  scope.ts:580, node.ts:535-539); the boot seed is written when a
  compaction-armed snapshot swap is issued (the pre-swap durable floors).
  Residual: G5.
- **I12 Bounded logs** (new, horizon). At quiescence with no orphan and no
  open latch, every lane at every node holds ≤ winners + `compactAt`
  entries, and every tombstone is either fenced or pinned by a named
  uuid. Monitor **M8 boundedLogs**, per node, worst lane named.
- **I13 Leave drain** (new; amended 2026-10-10 to what landed). A leaver
  reports `left(true)` only when the view without it committed and echoed
  AND every partition it still holds with content is covered by the
  attestation of every REACHABLE current holder (the shed bar, quantified
  over the holders that can still answer). Past the bound, or when some
  partition it holds has no reachable current holder at all (the last
  member), it reports `left(false)` and counts `undrained`. Monitor **M9
  leaveDrain**. The first wording said "holds no orphan" and that
  no-reachable-holder counts as `left(true)`; the drain that landed reads
  both the other way: a stop that could not copy its rows is not clean,
  and at R≥2 a partition whose unreachable holder never attested is
  drained once the reachable holders cover it (a live copy exists; the
  orphan itself stays for the teardown, since the shed still wants every
  holder). M9 agrees with both.
- **I14 Unscoped identity.** No unscoped byte or trajectory changes.
  Gate: the golden, the sweep, 59,500, the idle law, the 46 pins.

**M1 stampOracle, the oracle the tree lacks.** The sim records every
committed record globally from the commit effects it already sees (sim/
exec.ts folds records per node). Per event, the floor-relative form: for
every cell X present at node N with stamp s, no remove of X or of an
ancestor exists in the ledger with s < r ≤ N's floor for r's (lane, p).
That follows from I3 and fires at the exact event a resurrection happens.
At the horizon, the exact form: each lawful holder's value or absence
equals the V4-18 fold of all committed records by stamp (sim/fold.ts).
`converged()` compares nodes to each other (monitors.ts:349-368) and so
passes a UNIFORM resurrection; the zombie probe had zero violations. M1
runs on today's kernel first and must turn red on the two re-run probes.

**M4 indexOracle** (stage 1): for every armed node and partition, the
per-partition index equals the filter of every lane by partition, after
every event. The index has about seven maintenance sites (write.ts:663,
:741; scope.ts:550, :676-677; log.ts:104; replay; the release step); a
missed one makes a teach ship an incomplete base and a shed destroy data on
attested-but-wrong floors.

**The adversarial sweep** (`sim/scoped-sweep.ts`, shaped like sim/leave-
sweep.ts; a 300-seed in-suite slice, 1,000 in the script tier). Each seed
draws n from {1, 2, 3, 5, 8}, R from {1, 2, 3} (R ≥ n included), durable or
memory, a workload of row writes, field writes, removes and re-writes of
removed cells over 50 to 500 partitions (a new `writesPlan` mode; today's
is 20 keys), with `compactAt` and `snapshotAt` lowered through the tune
table so passes really fire, and chaos from this list. Engagement counters
(sheds, acquires, compactions, releases, latch stalls, undrained) are
printed so a seed whose chaos never bit reads as exactly that.

- **A1** stranded commit, owner cut off and evicted, then healed (the
  zombie lane; produced without poking `link.synced`: a paused link whose
  queue dropped, or a commit between re-admit and the digest).
- **A2** ownership moves (a join) while the old owner's fan-out is delayed
  400-500 ms; the demoted owner keeps minting until it installs.
- **A3** an orphan frozen before the remove reaches it, cut off past the
  release, then a second view change re-assigns it and a fresh acquirer
  can reach only it.
- **A4** durable holders restarted between eligibility and release;
  `storeFault` lie on the newest row (G5); a crash between the boot write
  and the WAL fsync (the §2 seed question).
- **A5** a member's VIEW frames severed (`severOnFrame`, sim/exec.ts:199)
  so it keeps stamping at the old epoch.
- **A6** a view flip during a latch with a release pending.
- **A7** scale down to 1 and back up to N with GC on, clean leaves
  (V4-6), leaves with records in flight from the leaver.
- **A8** a co-holder partitioned and healed during announcements (lost
  dirty announcements; the sweep must heal).
- **A9** a lost WACK, then an owner move to a from-zero acquirer, then the
  issuer's retry (the dedup window across compaction).
- **A10** linger: a frame from a member killed after it was sent,
  delivered after the eviction's install, if the exec can represent it
  (today frames already sent land, later ones die at a sever: exec.ts:
  17-27); if it cannot, the family reports itself as not representable.
- **A11** a spoke whose link pauses across a release; a spoke that fails
  over to another feeder after one.

**Mutation checks, required before the real rule is written.** Each
weakened rule must be caught by M1, M3 or M6 within the pinned seed
budget: no census (A3, A5); lane accounting off (A1, A7); R2 without the
gapless bit (A2, G4); volatile instead of durable floors (A4's class — M2
on the slow-disk schedule of sim/compaction.test.ts, since A4's own passes
all run after its lagging disk has caught up; for what a disk RESTORES
against announced marks, the window test of the same file, which crashes
a holder between a compaction-armed swap and its echo; the stage-3 note
and its second review); release of
the version only, lanes untouched (G1, every family); teach without the
`keep` filter (A3); compaction over orphans or over an acquiring holder's
zero (M2); a dropped dirty site (M7's knowledge form, measured with the
sweep off on an R=2 shape where the sweep-off run alone is green — A8 seed
1) and the sweep switched off (M7's knowledge form on an R=3 shape — A8
seed 3); a dropped index site (M4). Note the
operator critique's point: deleting log.ts:160 alone does NOT make GC fire
under scoping (today's rule needs every member at every lane's tail, log.
ts:124-135, which a scoped member never is), so the stage 0 proof that the
harness sees the resurrection class uses an injected "drop one tombstone
and its record at a random holder" step, not log.ts:160. A mutation the
harness cannot catch means the harness is not done, and the rule does not
land.

**Expected on today's kernel.** Green everywhere except two rows marked
`expect: red-today`: M8 (logs are unbounded) and M9 at R=1 (the leave does
not drain). M1 red on the two re-run probes, run unscoped. Each red-today
row flips to green when its stage lands; that is the gate.

## §7 The staged builds

Each stage is shippable alone. Each ends with one quiet run of `npm test`,
`npm run perf` and, where named, `npm run sim:scale`, serialized under the
box lock. Two independent reviews per stage from stage 2 on; a review that
finds a hole in the argument sends the work back to §6, not into a fix
round.

| Stage | Lands | Tests and pins | Moves | Gate |
|---|---|---|---|---|
| **0 harness** | This record. M1-M9 in sim/monitors.ts (stepped-node scoped). `sim/scoped-sweep.ts` + test with A1-A11 and the mutation runner. The frame tally (verb peek at the sink, codec.ts:58-63). The two unscoped probes as pinned red-today seeds. The §2 seed probe. STATUS bug lines for both unscoped holes and, if confirmed, the seed overclaim. Three counted floors recorded from today: idle scoped = n(n−1) DIGEST per tick; one join at n=30 R=3 P=300 = 2,555 HAVEQ; 300 writes = 1,067 HAVEQ. | Every monitor has a planted-violation test; every family a non-vacuity counter test; M1 red on the probes. No pin moves. | Nothing (sim-only code). | Owner reads the record and answers §14; every mutation of today's injected-drop class is caught. |
| **1 plumbing and the two bugs** | (a) `acked`: `onAck` (write.ts:512-547) emits `sink.acked(iss, cid, origin, seq, epoch)` for a cleared attempt with `via < 0`, on armed nodes and on clients (a spoke relayed through a scoped feeder never sees a non-held commit either: the tap carries the feeder's held subset, write.ts:690-693); `EffectSink.acked?` beside `lost?` (env.ts:123); Bind resolves idempotently with the apply join and `#lost` (api/data.ts:182-188); the lane named with its incarnation. (b) Drain-then-go: `#finishLeave` (membership.ts:572-577) holds the `left` effect while any orphaned partition has a live, non-leaving current holder with an admitted link, bounded by a new `drainTicks` row (default 16); past it, or with nobody to drain to, `left(false)` at once and `undrained` counted; the shell cap follows. Ballot rules untouched (the parked I-20 lane, `w1/membership`, is told). (c) `node.byPart`: the per-partition entry index and `node.tombs`: the per-partition tombstone index, both armed-only; `#teach`, `#tailsOf`, `#abort`, `#shed`, `rescope` through the index. | The STATUS probe as a test (2 members, `replicas: 1`, six `methods.update` from aa, six ok); a client relayed through a non-holder. Scale-down 3→2→1 at R=1 loses nothing (M9 flips). M4 index oracle across a 200-seed sweep; a mutation dropping one site. A teach-cost ratio pin (R1: a 1,000-entry partition from a 200,000-entry node ≤ 2× from a 1,000-entry node). | Scoped trajectories with leaves. Unscoped identical. | Battery, perf, harness 1,000 seeds. |
| **2 anti-entropy** | The dirty set at every floor-advance site; per-tick announcements to co-holders; `round(node, only?, parts?)`; targeted post-fold, sealed, probe and orphan rounds; the sweep (`aeFan` 8, a tune row) with its cursor; `#lagging`'s trails clause removed, its `!per` leg kept as dirty; the armed heartbeat sends no member DIGEST; admit/drain digests answer r=0 and ship nothing to a member; HAVEQ `d`, `g`, `x`; HAVEA `x: 1`, `g: 1`; paused links skipped. | kernel/scoped.test.ts: announce on change (one commit → R−1 entries next tick, then silence); no member DIGEST armed; client digests unchanged; the admit answer ships nothing to a member and the round repairs it; sweep covers every held partition within ⌈c/aeFan⌉ ticks; `x` clears marks; `none` clears a stale pin; skewed frames dropped at a mid-announcement install. Counted pins P1-P3 (§8). M7 over 1,000 seeds; A8 heals. | Scoped scenarios that count digests (scoped-repl, q3a, scale-chaos, scale.test exactly-R-of-50, scale-run's two scoped scenarios); the two scoped kernel tests that pin the ring-filtered suffix and the lag round are retired and named in the commit. Golden, sweep, 59,500, idle law: unchanged. | Harness green with the stage-2 mutations caught; sim:scale scoped scenarios green; two reviews. |
| **3 compaction** | Rule C1-C4 in `maybeCompact`'s armed branch with F over current holders' crash-stable attested marks; `keep(e)` shared by `compact()` and `#teach`; the (length, F-version) memo; the snapshot armed by a compacting pass and the boot record rewritten at its echo; ACQDONE `w` (dedup tuples) with armed window entries recording the partition; shed on crash-stable marks; `JK.compacted` carries the partition. kernel/scoped.test.ts's COMPACTION PIN (:390-419) becomes "compacts only on attested crash-stable marks; an acquiring holder pins". | M2 clean across the sweep with releases still off; a durable restore after compaction restores floors from the seed and does not re-latch; a learner taught by a compacted teacher converges; V4-18 cases (swept field entries drop, fenced removes stay, row removes stay until release); A9 (WACK lost, owner move, retry) dup-acks; a client on a scoped server across a pass: zero resyncs. Pin P4 bounded logs (50,000 updates over 500 cells at n=8 R=3: entries per node ≤ held cells + `compactAt`); a `compact.perf` µs-per-entry number, structural ratio vs the unscoped pass. | Scoped trajectories with long lanes. Unscoped untouched. | Harness + stage-3 mutations; the fold model (tools/debug/model.mjs) and the honesty gate agree with the kernel on a capture that compacted under scoping; two reviews. **Requires stage 2.** The resting point if stage 4 does not pass. |
| **4 tombstone GC** | The CENSUS verb; R0-R4; the atomic release step through `byPart`; `owners(p)` with install update, ACQDONE `o`, round merge and boot persistence; partition retirement; journal kind `gcRow`; `cluster.partitions` gains `tombstones`, `gcWaitingOn`, `retired`; model.mjs folds `gcRow` (today it folds neither `compacted` nor `tombstoneGC`: stateAt :102-182). | M1, M3, M6, M8 live over 1,000 seeds × A1-A11; every mutation red-then-green; the H3 schedule with GC on; the 14-window matrix rows 4-7 and 14 (DESIGN-M6 §2) with GC on; release at n=1; a departed uuid pins and is named; its return unpins after shed; field and row tombstones of one row go together; the gather's coverage sweep (api/fold.ts:28-34, built for GC'd removes and never run with one) exercised; the honesty gate. Pin P5: tombstones of a quiet partition reach 0 within one census round plus one sweep lap. | Scoped trajectories with removes. | Harness, battery, perf, sim:scale rescope-storm with `compactAt` small; the owner's yes on Q4-Q6; three to four reviews (V4-18, smaller than this, took four). |
| **5 scale and follow-through** | Installs keep a partition's marks when its holder set is identical across two consecutive installed epochs and no peer changed incarnation, so the install round and the teach cost scale with moved partitions; HAVEQ bodies carry only lanes changed since the last answer; chunked install rounds (≤ 4,096 partitions per frame). sim:scale scoped scenarios at n=100 R=3 with write-heavy and remove-heavy workloads asserting entries, tombstones, digest and HAVEQ frames per tick; tests/scale-tcp.test.ts gets a scoped run with compaction and GC on; STATUS and DECISIONS; site/strip.mjs rerun; examples/16 re-checked on a private port. | Pin P6: one join at n=100 R=3 with 3,000 rows announces ≤ moved × R × 2 entries; a generous wall tripwire (scoped n=50 formation + 500 writes + one join under 60 s). | Scoped grow trajectories. | sim:scale green; battery; perf; owner sign-off. |

## §8 Perf and the pins

**Paths and how often.** Hot path, per record, armed only: one `Set.add`
for the dirty set at the stamp site and the fast path (the sites already
branch on `armed`: node.ts:836, write.ts:677); one `byPart` push on append;
one `tombs` add on a remove apply. Unscoped: zero added work. Tick path:
the member digest encode and its suffix walk go away (9,900 encodes and up
to 868,353 entry visits per tick measured at n=100); added: the dirty
announcement build O(dirty × R) and the sweep slice O(aeFan × shared). Com-
paction: the same size-armed trigger plus the memo; F memoized per
partition per pass; one extra `Map.get` per entry. GC: per partition with
pending tombstones, O(its tombstones + its entries), never a walk of every
version. Hand-over: `#teach`, `#tailsOf`, `#abort` O(entries of p)
through the index; `#shed` O(the lanes that hold p), each filtered whole
(a lane is an array — the stage-1 note). Install: O(moved) after stage 5. Wire: at n=100 idle
3 MB → about 100 KB per tick; writes 2.28 MB → about 60 KB per tick.

**Pins that must not move** (unscoped, structural): 59,500 (scale.perf.ts:
32-44); events(100)/events(25) < 25 (:46-54); the idle floor 4·25·24 with 0
aeShip (:56-71); fan-out exactly 99 (:73-80); the 20 s wall (:82-95); the
20-seed golden (exec.test.ts:37-59); the 300-seed in-suite sweep and the
1,000-seed script sweep at 237,451 events (docs/DECISIONS.md:1311-1312);
write.perf, node.perf, alloc.perf and the other pins. No threshold is
widened. On this box perf is judged structurally and by back-to-back A/B,
never by an absolute number.

**New pins** (counted first, machine-independent): **P1** idle armed n=25
R=3 over 4 ticks: member DIGEST = 0, HAVEQ+HAVEA = Σᵢ 2·min(aeFan, cᵢ) per
tick exactly, aeShip to members = 0. **P2** n=100 R=3 3,000 rows idle:
non-PING frames per tick ≤ 1,000 and bytes ≤ 100 KB (today 9,900 and
2.93 MB). **P3** one write on a settled n=100 R=3 mesh: exactly 2 RECORDS
deliveries, then exactly (R−1) HAVEQ + (R−1) HAVEA entries, then silence.
**P4** bounded logs after 50,000 updates over 500 cells at n=8 R=3. **P5**
tombstones of a quiet partition reach 0 within one census round plus one
sweep lap. **P6** one join at n=100 announces ≤ moved × R × 2 entries. Two
ratio pins: **R1** teach cost (above); **R2** armed commit with the dirty
mark ≤ 1.05× without, back-to-back. One wall tripwire (stage 5). The relay
pin STATUS.md:30 asks for is separate and still missing.

## §9 Compatibility

**Unscoped clusters: byte-identical.** Every new frame, field and path is
behind `node.armed` (node.ts:325) or allocated only when armed; open
genesis is always unarmed. The two behaviour-preserving unscoped
optimizations the storage probe motivates (a tombs-pending flag so an idle
GC walk visits nothing; a memo so a winner-heavy lane is not re-walked
every tick) are NOT in this design: the first is a hot-path change in both
modes and the second changes compaction timing in a way no golden can see
(the golden's seeds have 162-270 events each). Both go to §12 as
follow-ups with their own A/B.

**A scoped cluster of today's shape.** Mixed versions are unsupported
before 1.0 (V4-14), and the failure direction is safe: an old node drops
CENSUS as an unknown verb (node.ts:1519-1521) and never sends one, so new
nodes never release tombstones in a mixed cluster; old nodes ignore the new
top-level HAVEQ keys and per-partition HAVEA keys; an old armed node that
still relied on the heartbeat digest repairs more slowly. A boot record
without `owners(p)` restores with `owners(p)` = the lanes found for p plus
the current owner and merges with peers' sets in the first round. A boot
record without a per-partition fence has nothing to miss (there is none).

**examples/16-scoped.** Three members, `replicas: 2`, nine rows, no
removes, far below `compactAt`. Its printed lines are ring placement, hold
counts and typed throws; none changes. Its check is re-run on a private
port after each stage.

**The api.** `cluster.partitions` keeps every field and gains `tombstones`,
`gcWaitingOn`, `retired`, `undrained` as bounded scalars (rates and alarms,
not a firehose). `ScopedError` and its reasons are unchanged. `methods.
update` from a non-holder now resolves (a fix). `destroy()` on a scoped
member may take longer (the drain) and resolves false when it could not
drain within the bound. The gather (api/fold.ts) is untouched: its parking
and coverage sweep already treat a GC'd remove as attested absence.

**The debugger.** New journal kinds (`gcRow`; `compacted` gains the
partition) need fold rows in tools/debug/model.mjs and the honesty gate, in
the same lane as each stage. The scoped-capture STATUS lines (:47, :49) are
the debugger's; noted only.

**The door.** DESIGN-DOOR touches HELLO and admission only; nothing here
touches HELLO, and the sweep runs over admitted links whatever admitted
them. CENSUS takes the verb number after DOOR (26).

**Config.** Two new tune rows (`aeFan`, `drainTicks`), no config key
(V4-19: a tune row is not a key unless asked).

## §10 What the sim proves, and what only real sockets and a real disk prove

The sim proves, seed-exactly at delay [1,1]: the counted laws (P1, P3, P5,
P6); every invariant of §6 under every schedule of §6's families, with the
in-flight frames in its event queue and the stored WAL bytes both visible
to M6; that each rule turns its monitor red when switched off. It cannot
prove bytes per second or wall time on this box (WSL2 swings 2-3×); it can
prove bytes per tick by summing frame lengths at the sink.

Only real sockets prove: the TCP buffer that outlives a killed process
(A10's shape, the shared residual of §5); backpressure pauses on a real
link under a real burst (STATUS.md:63's "pause burst"); the wall cost of a
scoped join at n=50 on tests/scale-tcp.test.ts. Only a real disk proves:
fsync ordering between the boot record and the WAL (the §2 seed question;
the sim's `storeFault` models a lie, not the ordering); a crash between
the boot write and the row fsync (A4) on a real filesystem; the snapshot
swap's rename durability under power loss (shell/runtime.ts:226-230). The
real-TCP and real-WAL tiers run the scoped scenarios with GC on in stage 5.
What neither proves: a lying disk about a lane's newest row (G5) stays a
residual until chained durable marks exist.

## §11 The two open STATUS bugs

**"On a scoped cluster, `methods.update` from a node that does not hold
the partition never resolves committed"** (STATUS.md:28). Cause, confirmed
in the code: the issuer awaits the coordinates promise `bind.issue`
returns (api/index.ts:527-539); Bind settles it from the apply join, from
`#lost` (api/data.ts:182-188) or from the drop sweep, which is gated on
drops (api/data.ts:481). The owner's WACK clears the pending attempt and
feeds the dedup window (write.ts:536, :543) but tells the api nothing:
`#ack` returns at once for `via < 0` (write.ts:386-388) and is only called
for hops with `via >= 0` (:531-534). A non-holder never applies its own
commit (the fan-out goes to holders only, node.ts:853-857; the inbound
gate drops it, write.ts:637), so the join never fires and the timeout wins.
A client relayed through a scoped feeder for a partition the feeder does
not hold hangs the same way (the tap carries the feeder's held subset).
Fix: the `acked` effect DESIGN-M6 C6 planned, emitted from `onAck`'s loop
when `a.via < 0`, on armed nodes and on clients; Bind resolves
idempotently. The WACK is the evidence; this is the evidence plane's job.
Lands in stage 1 with the STATUS probe as its regression.

**"A scoped node that does not hold the row forwards such a remove to the
owner, who does not re-check forwarded writes"** (STATUS.md:29). Cause: the
owner's forwarded leg checks epoch, ownership, gate and orphan state only
(write.ts:488-496); the relay leg validates (write.ts:440-451); the
sparse-hole rule lives in the api (V4-28). NOT folded in: it is a write-
pipeline question (which predicate runs where) that has nothing to do with
anti-entropy, compaction or GC, and it belongs beside the door's admission
work. But it matters here: such a tombstone is stamped above a live array
row, so `fenced()` keeps it for as long as the row lives (node.ts:1759-
1765), a permanent tombstone this design can never release, and stage 4's
bounded-tombstone pin would hide a slow leak. Recommended one-line follow-
up, to land BEFORE stage 4: a NodeOpts `admit(rec)` hook the owner runs on
member-forwarded (`ae > 0`) removes, the Bind's sparse-hole half only;
WNACK `invalid` with reason `sparse-hole`; `withheld` only when the shape
check cannot run because the owner's fold is staged (mid-latch own-lane
commits stay lawful, write.ts:492-494). Regression: the two-member scoped
remove of `g[0]` from the non-holder.

## §12 What was rejected, with the panel's reasons

From the protocol proposal, not taken:

- **Compaction with no cross-node frontier** (losers drop at once). Its
  critique and the re-run teach probe show the trap: once GC releases a
  stamp, a loser on a short lane outlives the remove on a long one and a
  from-zero teach ships it. A frontier over current holders costs one
  `Map.get` per (o,p) per pass with marks that announce-on-change keeps
  fresh, and keeps every holder's pp chain intact.
- **A write adds zero handshake frames** (marks refreshed only by the
  rotation). It starves confirm evidence and GC of fresh marks for up to a
  rotation lap; one announcement of (R−1) entries per written partition is
  the price of marks that are current.
- **Replace-below-cut** at the re-entry fold. The re-run probe shows the
  delta teach ships nothing at or below the learner's marks, so "drop every
  entry ≤ cut the teacher did not re-ship" deletes the learner's whole
  legitimate base; narrowed to (mark, cut] it no longer covers the stale
  cell it exists for. Census plus lane accounting close G2 with evidence.
- **A `dropP` per-frame loss fault** for the sweep's healing proof. The sim
  leaves per-frame drops out on purpose (sim/exec.ts:20-27); loss is
  produced with `severOnFrame` and partition/heal.
- **Two-sided equality over `K(p)` fed by marks alone**, without census.
  A live demoted owner minting at e−1 is not in any mark set and its
  fan-out carries no epoch check at the receiver; the census is what makes
  "nothing in flight from a member" true.

From the storage proposal, not taken:

- **Periodic digests to co-holders only.** At n=100 co-holders are 64-79 of
  99 (its own probe); the saving is 28%, and still per tick.
- **`complete` and `ann` flags to gate member AE.** Unneeded once no member
  receives AE at all; one path, one proof.
- **Compaction hysteresis keyed on length alone.** Its critique shows it
  can stop compaction for good when F was pinned at the pass.
- **Lane accounting keyed by life.** Any restart would pin for ever; a uuid
  is the unit that can ever return with data.
- **The tombs-pending flag and the hysteresis as both-modes changes.** They
  touch the unscoped hot path or unscoped timing; follow-ups with their own
  A/B.
- **A delta round every `shedTicks` plus a full round every 32 ticks**
  instead of announce-on-change plus a sweep: the same cost shape, but a
  co-holder with no marks waited up to 32 ticks for an offer; the `!per`
  leg stays dirty instead.

From the operator proposal, not taken:

- **The per-partition GC fence** (`gcFence(p)`, `fenceDrop`, the absence
  sweep). It drops a never-replicated write that comes back from a cut-off
  node after a release, by design. The owner asked that nothing be lost or
  resurrected; this record waits for evidence (R1-R3) and pins instead. The
  fence is the alternative if pins prove too sticky (Q5).
- **The from-zero teacher rule (b)** (an orphan whose last-held epoch is
  e−1 may teach). Its critique shows the G2 resurrection reaching a `{L,
  O}` island at R ≥ 2. With the census there is no GC while any member
  holds an orphan, so the question does not arise.
- **`settleTicks`** as a GC condition. A timer is not evidence (the I-20
  lesson); the census carries the same fact as an attestation.
- **A 60-tick drain bound.** Its critique shows the battery's scoped
  teardowns and examples/16's check would wait up to 30 s per node; the
  drain stops at once when nobody can be drained to, and the default is
  16 ticks.
- **A `told` map per peer** to suppress repeat announcements. The dirty
  set and the sweep cover it; one less structure to void on rebirth.

Rejected by every angle, kept on record: per-(o,p) marks on the DIGEST
(DESIGN-M6 §5, re-confirmed: O(held pairs) every heartbeat for ever);
Merkle or range digests per partition (heavier and still periodic; floors
compare in O(1)); a wall-clock tombstone TTL (no clock in the kernel, no
proof under partitions); today's global-quiescence GC rule applied to
scoped nodes (never settles at scale, and unsound under scoping anyway);
per-cell fences (cost the memory GC is meant to free); orphans in the
frontier or compacting orphans (their tails are the shed evidence); a
separate GC verb or GC epoch (HAVEQ already carries the marks); PING on the
sweep (liveness is membership's; out of scope); changing the per-record
inbound path (perf is a hard requirement; the fence law was reviewed 55
findings deep); a kernel-side gather or remote-handle work (api items on
STATUS Someday; untouched here).

**Follow-ups this record names but does not take**, each one line: the
unscoped short-lane and zombie fixes (the same release step at
`gcTombstones`, and lane accounting unscoped; both move unscoped
trajectories and need a golden re-pin, Q7); the idle unscoped GC walk and
the winner-heavy lane re-walk (storage probe 2: 168 ms and 92 ms per tick;
behaviour-preserving memos with their own A/B); `lastStamp` retirement (an
epoch-stamped retirement that makes pp = 0 lawful again once every member
has installed a later epoch and the census is clean); chained durable
marks (G5); the operator forget door for a uuid that never returns (Q5);
the one-epoch GC floor if A10 is representable; the relay perf pin.

## §13 Size

XL. About 3,500 lines including tests, 10 to 12 lane-days with review
rounds, one lane at a time on this box with the battery serialized.
Stage 0: about 800 lines (eleven monitors, the ledger hook, the sweep, the
mutation runner, three probes as pins), 2 days. Stage 1: about 450 lines,
1 day. Stage 2: about 650 lines (scope.ts and node.ts about 350; tests and
pins about 300), 1.5 days and two reviews. Stage 3: about 450 lines, 1 day
and two reviews. Stage 4: about 900 lines, 2 days and three to four reviews
(the rule with the most ways to be wrong). Stage 5: about 450 lines, 1
day. Expect the argument review to send one rule back once (the I-20
lesson's own estimate).

## §14 Open questions for the owner, each with a default

*Answered by the owner on 2026-10-09: every default (DECISIONS V4-31). Stages 0 and 1 are built
first; stage 1's drain (Q8) follows the rest of stage 1 in the next wave.*

- **Q1.** Retire the heartbeat DIGEST between scoped members, keeping the
  admit and drain digests as link sync only? Repair then comes from
  announce-on-change, re-admit and drain rounds, and a sweep of `aeFan`
  links per tick (about 9 ticks per lap at n=100). Default: yes, `aeFan`
  8, a tune row and not a config key.
- **Q2.** Compaction under a frontier over current holders' crash-stable
  attested floors, winners kept, orphans never, a lane's last entry never?
  Default: yes.
- **Q3.** Tombstone GC under census + holder quorum + lane accounting, with
  the release as one step over stamps and every lane's dead entries?
  Default: yes.
- **Q4.** A crash-evicted uuid pins the tombstones of every partition it
  owned since that partition's last release, shown in `gcWaitingOn`,
  until it rejoins or an operator forget door exists. Accept, with the
  forget door as a follow-up when the platform work needs one? Default:
  yes, accept and surface.
- **Q5.** Prefer waiting for evidence (Q4's pins) over the operator
  proposal's fence, which releases sooner but drops a never-replicated
  write that returns from a cut-off node after a release. Default: wait;
  revisit if the pins prove too sticky under autoscaling.
- **Q6.** The census is one global orphan-free bit per member: one stuck
  orphan anywhere pauses every release cluster-wide, bounded by hand-over
  time and surfaced by `shedStall` and `gcWaitingOn`. Accept, with a
  per-partition census as the fallback? Default: the global bit.
- **Q7.** File the two unscoped holes (short-lane resurrection, zombie
  lane) in STATUS now with the probes as evidence, and fix them by their
  own decision after stage 4, since the fix moves unscoped trajectories and
  re-pins the golden? Default: yes, file now, fix separately.
- **Q8.** A clean leave on a scoped member drains first, bounded by
  `drainTicks` (default 16) and stopped at once when nobody can be drained
  to; `destroy()` resolves false past the bound and `undrained` counts it.
  Default: yes.
- **Q9.** R=1 ("scale down to 1"): a crash loses the partition until its
  disk returns (memory-only: for ever). Accept, with a one-time note when
  `replicas: 1` and no `dir`? Default: yes.
- **Q10.** Hot rows keep their field tombstones until they go quiet (logs
  stay bounded; only stamps wait). Ship the simple rule; design the
  per-tombstone refinement only if a workload shows growth? Default: yes.
- **Q11.** Land stage 0 (harness, monitors, recorded floors) and stage 1
  (the `acked` fix, the drain, the index) before the yes on stages 2-4?
  Neither changes the protocol. Default: yes.
- **Q12.** The forwarded array-remove bug: a one-line owner-side `admit`
  hook beside the door work, landed before stage 4? Default: yes.
- **Q13.** Optional top-level HAVEQ keys and per-partition HAVEA keys with
  no MAGIC bump, under V4-14's "mixed versions unsupported before 1.0"?
  Default: yes.
- **Q14.** The stated ceiling for this design is 100 members; the mesh
  (9,900 PING/PONG per tick and a 22 MB VIEW flood at formation, measured)
  is a later design. Default: yes, 100.
- **Q15.** If A10 can deliver a frame from a killed member after its
  eviction, adopt a one-epoch GC floor (a stamp is released only when its
  epoch < current − 1)? Default: decide after A10 reports; it costs nothing
  at quiet points.
