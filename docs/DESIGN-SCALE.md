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
leaveTicks + drainTicks + 3 heartbeats, 11.5 s at the default cadence, when
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
   end: one tick late at most, no re-ship at every heartbeat); and a client
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
horizon on every seed, and at `FERO_SCOPED_SEEDS=8` (the knob; the M7 run
the row asks for — see the battery of the day). KNOWN_UNSAFE: A11's four
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
legs); `g: [p…]`, the partitions for which this node is **gapless** (its
content tail equals its floor on every lane of p); `x: [p…]`, the
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
the swap's echo rewrites the boot record (today only when a dirty entry
clears, node.ts:535-536). A crash before the echo restores the previous
snapshot plus appended rows: still honest. Memory nodes have no replay and
no constraint.

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
  floors within ⌈c/aeFan⌉ + `stageTicks` ticks.
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
  scope.ts:580, node.ts:535-539); the boot seed is rewritten at every
  snapshot echo that follows a compacting pass. Residual: G5.
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
gapless bit (A2, G4); volatile instead of durable floors (A4); release of
the version only, lanes untouched (G1, every family); teach without the
`keep` filter (A3); compaction over orphans or over an acquiring holder's
zero (M2); a dropped dirty site (M7); a dropped index site (M4). Note the
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
