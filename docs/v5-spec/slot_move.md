# The slot move, checked by exhaustive search

[slot_move.py](slot_move.py) is a small model checker for the slot move in [DESIGN-V5.md](../DESIGN-V5.md) §4.2 "Moving a slot". It is plain Python 3, standard library only, with no outside tools. It builds every state the model can reach, checks each one, and prints the shortest trace to any state that breaks a property. It searches breadth first, so the first bad state it finds is a nearest one.

A **slot** is one of a resource's 1,024 fixed hash buckets. A **shard** is a Raft group that holds some slots. A **move** hands one slot from shard A to shard B (DESIGN-V5 §2).

```sh
python3 docs/v5-spec/slot_move.py --jobs 4     # every run below: about 90 CPU-minutes
python3 docs/v5-spec/slot_move.py --quick --jobs 4   # a smoke test, about a minute
python3 docs/v5-spec/slot_move.py --only design --bound deep   # one run, about 5 minutes
python3 docs/v5-spec/slot_move.py --list       # the run names and the bounds
```

## The result, first

- **The design holds.** With each guard read the safe way, all seven properties hold, and an eighth added one, on both bounds: 3,669,799 states (`deep`: two writes to s, two depositions per shard) and 4,302,406 states (`wide`: three writes under the issuer window, one deposition per shard). From every reachable state, the move can still finish.
- **Two sentences in DESIGN-V5, read literally, describe a protocol that fails** (findings 1 and 2):
  - "Every step acts only on committed entries" is right for a step that waits for an entry, and wrong for a guard that forbids a step. Read literally, A takes a write after its own uncommitted fence, B aborts after its own uncommitted `open`, or B opens after its own uncommitted `abort`. Two shards then hold s, and acknowledged writes are lost (properties 1, 2, 4, 5, 6).
  - §2 says "a new leader stamps on from its committed state, after any uncommitted tail it drops", but §4.3 says Raft keeps that tail. Read literally, two committed records get the same sequence number (6, and through the move 3 and 4).
- **One minor one** (finding 3): appending the `stale-attempt` refusal of a resent copy lets duplicates grow the log without bound.
- **Mutants.** 12 of 13 one-rule-removed mutants are caught, including the review's two (A fencing before B's `importing` commits; A streaming before its `fenced` commits). The one not caught, B serving after appending `open` but before it commits, turns out not to be needed for any modelled property, and the text below says why.

## What it models

### A shard is an abstract Raft group

Each of A and B has:
- a **committed log**;
- the current leader's **uncommitted tail**;
- a count of **depositions** (its terms, in effect).

Three things happen to a shard:
- **Append.** The leader adds an entry to its tail.
- **Commit.** The tail's first entry moves into the committed log.
- **Depose.** The leader loses office and its tail. The new leader's tail is any prefix of the old tail, or of a tail lost earlier: none of it, some or all, as in Raft. A lost tail can come back only until the current leader commits something, since after that its own entry holds a majority and beats any older log.

So the abstraction keeps what broke earlier drafts: a leader appends, is deposed before the entry commits, and the new leader lacks it. It keeps the converse too: an entry a deposed leader appended may still commit under the next leader, though nobody answered its client.

**What leaders look at.** A leader judges writes against its log end, committed plus tail: dedup, the floor, the next sequence number, and `N` (DESIGN-V5 §4.3, "Two states on the writer"). Move steps act only on committed entries (§4.2, "Every step acts only on committed entries"). A guard that forbids a step after an entry (A taking a write to s after `fenced`, B aborting after `open`, B opening after `abort`) looks at the whole log end; finding 1 is about that choice.

### The move

Slot s moves from A to B. Slot t stays at A, so the issuer's highest call id at A can come from a write the move does not carry.

| DESIGN-V5 §4.2 | In the model |
|---|---|
| 1. B's leader commits `importing(s, from A)` | B appends `importing` once. Nobody re-drives the move if that entry is lost uncommitted |
| …then copies s while A still takes writes, by subscribing in `state` mode | A sends s's committed records whenever B's `importing` has committed; B appends each new part as an import entry |
| From then until `open` commits, B answers writes to s `retry` | B takes no write to s until `open` is committed |
| 2. A commits `fenced(s, to B, N)` only after B reports `importing` committed | A appends `fenced(N)` once B's `importing` is committed. N is s's last sequence in A's log end |
| A appends nothing to s after the fence | A takes no write to s once `fenced` is in its log end (it answers `retry`, then `moved(B)`) |
| Only once `fenced` commits does A send the delta, `END(N)`, the carried state | A sends `END(N)` and the carried state only from a committed fence |
| 3. B writes everything it copied into its own log and commits it, then commits `open(s, N)` | B appends `open(N)` only once an import holding `END(N)`, the rows up to N and the carried state is committed |
| B serves only after `open` commits | B takes writes to s only once `open` is committed |
| A cancels only after B commits `abort(s)`; B aborts only before `open` | B may append `abort` at any time while its log end has no `open`; A appends `cancel` once B's `abort` is committed, and never fences after a cancel |
| Each leader resumes from its own committed log | A new leader has only its committed log and the tail it kept; a new B leader re-subscribes |

**The carried state** (§4.2) is the slot's rows and sequence, plus, per issuer, the committed outcomes tagged with s above A's floor, and A's highest call id for the issuer. B merges the highest id by `max`. Lock fence tables are not modelled.

### Clients and dedup (DESIGN-V5 §4.3)

- **One issuer** issues writes with rising call ids. Each write goes to s or t. Each may be resent once.
- **Routing.** Each copy of a write to s goes to A or to B: a fresh or a stale slot table. `moved` and `retry` are not definitive answers, so they are modelled as the shard changing nothing. The client may resend to either shard at any time anyway.
- **The window.** On the `wide` bound the issuer keeps its highest issued id minus its oldest unanswered id below `issuer.window` = 2. So id 3 waits until id 1 has its answer.
- **The writer.** Dedup checks the outcomes in the log end. The floor is (highest id seen) − window. An attempt at or below the floor gets `stale-attempt`. Outcomes at or below the floor are assumed already dropped, the worst case the doc allows.
- **No answer before commit.** An answer waits until the commit offset reaches what it was judged against. It is lost if the leader is deposed first.
- **Latest copy only.** The issuer takes only the answer to its latest copy.

### Messages

Messages sit in a set. Delivering one does not remove it, so it can arrive again (duplication), at any time (delay, reordering). A message never delivered is a lost one. Every copy of a client's write, and every copy of s that A sends B, is such a message, so a late copy can land at either shard at any later point. Two simplifications, neither of which loses a behaviour:
- **Stable facts.** B's reports "importing committed" and "abort committed", and its live subscription, state facts of B's committed log, which never become false. A report sent once such a fact holds, delivered at any later time, is the same as A reading the fact at that later time. So A reads B's committed log. This is a superset: A may also act on a fact that B never got round to reporting. The two mutants whose report names an uncommitted entry keep a real message, since that report can go stale.
- **Taken or lost.** The client takes a released answer at once, or it is lost. Taking it later reaches no new state: taking changes only the client, which commutes with every shard step, and an answer that arrives after a resend is ignored.

### Bounds

| Bound | Writes | Window | Resends | Depositions per shard | For |
|---|---|---|---|---|---|
| `quick` | w1→s, w2→t | 1 | 1 | 1 | a smoke test |
| `deep` | w1→s, w2→s | none | 1 | 2 | two writes to s in flight; a lost tail coming back |
| `wide` | w1→s, w2→s, w3→t | 2 | 1 | 1 | the window, the floor and the `max` merge |

One move, one slot moving, one issuer, every bound.

## The properties

| # | Property | How it is checked |
|---|---|---|
| 1 | At most one shard has a committed `open` for s with no later committed `fenced` | A counts as open from the start, and again after a `cancel`. Checked in every state |
| 2 | No slot sequence number is stamped on committed records by both shards | the sequence numbers of committed writes at A and at B never meet |
| 3 | Every write committed to s at A before the fence is in B's state when B opens | once B's `open` is committed, B's imports before it hold every write committed at A before A's fence |
| 4 | No write is acknowledged to a client as committed and then missing from s's final state | every write the client took as committed is in the state of whichever shard holds s now (B after a committed `open`, else A), at every state |
| 5 | No attempt id commits twice | across both committed logs |
| 6 | A slot's sequence never goes back | in each committed log, each write's number is above every number before it, and no fence, import or open names a lower one; and across shards, on every commit, the position of the shard holding s does not drop |
| 7 | Liveness, bounded: with no more faults, the move completes or aborts | from every reachable state, with every message in flight lost and then no deposition, no loss and no new abort (clients idle), some path reaches done: `open` committed at B; or `abort` committed at B and `cancel` at A; or the move never got going (no `importing` in B's log, no `fenced` in A's). Losing every message is the worst case: a path that works from an empty network works from any. From no state is done out of reach, so over finitely many states a strongly fair run finishes |
| 8 | (added) An attempt its issuer took as refused never commits | answers agree with the log |

## Runs

Every run is a full breadth-first search unless marked +. A run marked + is a mutant that stopped once a safety property had failed and 1,000,000 states had been explored (`--cap`, the default; `--cap 0` explores every mutant in full). A + count is what was explored, and properties not listed as failing there may fail too.

The **liveness graph** is the separate search for property 7: every reachable state with its messages lost, then every step with no faults. Its states leave out the client, so it is small.

**The design and the readings.** A *reading* is the design with one sentence read literally (finding 1 and 2). Each is searched in full.

| Run | `deep` states | `wide` states | Result (property: steps in its shortest counterexample) |
|---|---:|---:|---|
| `design` | 3,669,799 | 4,302,406 | all 8 hold on both; liveness graphs 947 and 3,582 states |
| `read-A-fence-committed` | 8,191,739 | 7,433,241 | fails 4 (12), 6 (12), 2 (15), 5 (15) |
| `read-B-abort-committed` | 4,105,694 | 4,947,281 | fails 1 (13), 4 (14), 2 (19), 5 (19) |
| `read-B-open-committed` | 4,141,700 | 5,105,191 | fails 1 (13), 4 (16), 6 (16), 2 (19), 5 (19) |
| `read-new-leader-stamps-committed` | 7,816,002 | 7,298,705 | fails 6 (7), 3 (19), 4 (19) |

The design runs take 3 to 4 minutes each on one core. The `quick` bound (56,810 states for the design) runs every variant in about a minute and agrees with the table, except that the three runs that need two writes to s in flight (`read-new-leader-stamps-committed`, `stamp-from-committed` and `no-carried-sequence`) pass there.

A check that the design result is not empty: on the `quick` bound, 882 reachable states have B's `open` committed, 1,652 have A fenced and then cancelled, 172 have a write B committed after opening, and 4,404 have a non-empty carried outcome. No state has the client take a `stale-attempt` answer.

## Findings

The design passes every property on every bound once each guard is read the safe way. The bugs below are in the text: sentences that, read literally, describe a protocol that fails. Each comes with the shortest trace the checker found, in plain English.

### 1. "Every step acts only on committed entries" is wrong for a guard that forbids a step

**The sentence** (§4.2, "Moving a slot"): "Every step acts only on **committed** entries: appending is not enough, since a leader can be deposed before its entry commits."

It is right for a step that **waits for** an entry: A fences on B's committed `importing`, A streams on its own committed `fenced`, B opens on its committed copy, A cancels on B's committed `abort`. Each of those rules, removed, is caught (see Mutants).

It is wrong for the three guards that **forbid** a step once an entry exists. Read literally, such a guard looks only among committed entries, misses the entry still in the leader's own tail, and takes the step the entry should have stopped. Both then commit, in the wrong order.

**(a) A takes a write after its own uncommitted fence.** "A appends nothing to s after the fence." Run `read-A-fence-committed`, 12 steps, property 4; in short:
1. The client sends w1 to A.
2. B appends `importing`, and it commits.
3. A's leader appends `fenced(N=0)`. It has not committed.
4. w1 reaches A. A looks for a fence among its committed entries, finds none, and appends w1 with sequence 1, after the fence.
5. The fence commits. A sends B `END(0)`. B appends the (empty) copy, and it commits.
6. w1 commits. A tells the client: committed at 1.
7. B appends `open(N=0)`, and it commits.

B now holds s, and w1, acknowledged, is not in it (property 4). If the client's resend of w1 reaches B, B commits it again (5) with sequence 1, which A also stamped (2). s's position fell from 1 to 0 at the open (6).

**(b) B aborts after its own uncommitted open.** "B aborts only before open." Run `read-B-abort-committed`, 13 steps, property 1; in short:
1. B appends `importing`, and it commits. A appends `fenced(N=0)`, and it commits.
2. A sends `END(0)`. B appends the copy, and it commits.
3. B's leader appends `open(N=0)`.
4. B's leader decides to abort (say on a timeout). Its committed log has no `open`, so it appends `abort`.
5. `open` commits, then `abort`.
6. A sees B's `abort` committed and appends `cancel`, and it commits.

Both shards now hold s open (property 1). B serves s, since its `open` committed ("serves s only after it commits"), and so does A. A resent write commits at both, with sequence 1 at each (2, 4, 5).

**(c) B opens after its own uncommitted abort.** Run `read-B-open-committed`, 13 steps, property 1: B's leader appends `abort` before its copy commits; once the copy commits, its committed log shows no abort, so it appends `open` after the `abort`. `abort` commits, A cancels, and then `open` commits.

**The fix**, one sentence after the quoted one: "A step that waits for an entry acts once that entry is committed. A guard that forbids a step after an entry counts the leader's whole log, committed or not: A takes no write to s once `fenced` is in its log (it answers `retry` until the fence commits, then `moved(B)`); B never aborts once `open` is in its log, and never opens once `abort` is." The `design` run reads the guards this way, and every property holds.

### 2. §2 "Positions" still says a new leader drops its uncommitted tail

**The sentence** (§2, "Positions"): "A new leader stamps on from its committed state, after any uncommitted tail it drops."

§4.3 says the opposite: "A new leader's log may end with entries of earlier terms not yet committed. Raft never drops them from its own log". A leader that keeps such an entry, and stamps on from its committed state, reuses the entry's number. Run `read-new-leader-stamps-committed`, 7 steps, property 6:
1. The client sends w1 and w2 to A.
2. A appends w2 with sequence 1.
3. A's leader is deposed. The new leader keeps w2 in its log, uncommitted.
4. w1 reaches A. The new leader stamps on from its committed state, which has no write yet, so w1 also gets sequence 1.
5. w2 commits, then w1.

Two records of s now carry sequence 1. A cursor, a version or a fence token at 1 names two writes. The move's copy, which keeps the records above B's position, drops one of them (19 steps), so properties 3 and 4 fail too.

**The fix:** "A new leader stamps on from its log end: its committed entries, and the entries of earlier terms it keeps, which its first entry of its own term commits (4.3)."

### 3. A resent copy below the floor can grow the log without bound (minor)

**The sentence** (§4.3, "Refusals"): "The writer appends the refusal of a resent attempt as an entry with no data, under its attempt id", with "every committed outcome above the floor" kept (§4.3, "What the writer keeps").

A resent copy at or below the floor is refused `stale-attempt`. Its appended outcome is at or below the floor too, so it may be dropped at once. The next duplicate of that copy finds no outcome, and appends again. The first version of this model did exactly that, and its state space had no end: every duplicate delivery added an entry. The answer is the same each time, so nothing unsafe happens, but a duplicating link can grow the log with no write behind it, until the attempt's time budget runs out.

**The fix:** "A `stale-attempt` refusal is never appended: the floor that gives it comes from the highest id, already in the log, and it only rises." The model does this.

### Two rules that turned out not to be safety rules

- **"B serves only after `open` commits"** breaks no property when removed (`b-serves-before-open-commits`). A write B appends sits after `open` in B's log, so it commits only if `open` does, and no answer goes out before commit (§4.3). Reads see only committed state, which while A is fenced is A's frozen copy. Under this model the rule is defense in depth. The rule that carries the weight is that B serves only once `open` is in its log at all: `b-serves-before-open`, which serves once the copy is committed, breaks 2, 4, 5 and 6.
- **"A fences only after B reports `importing` committed"** (case R-90) is a liveness rule. Its mutant breaks only property 7: B's leader loses its uncommitted `importing`, B forgets the move, and A stays fenced with nobody to finish or abort it.


## Mutants

Each mutant removes or changes one rule. "Caught" names the properties that failed, with the steps in each shortest counterexample. Counts marked + stopped at the cap (see Runs).

| Mutant | The rule it removes (DESIGN-V5) | `deep` states | `wide` states | Caught |
|---|---|---:|---:|---|
| `fence-before-importing-commits` | §4.2: A fences "only after B reports that its `importing` has committed" (B reports it appended) | 4,354,428 | 4,887,296 | 7 (4) only |
| `stream-before-fence-commits` | §4.2: "Only once `fenced` commits does A answer `moved(B)` … and send B … `END(N)`" | 1,000,002+ | 1,000,003+ | 1 (8), 7 (11), 3, 4, 6 (12), 2, 5 (15) |
| `b-serves-before-open-commits` | §4.2: B "serves s only after it commits" (serves once `open` is appended) | 3,701,682 | 4,358,482 | **not caught** |
| `b-serves-before-open` | the same, B serving once its copy and `END(N)` are committed, before writing `open` | 1,000,001+ | 1,000,001+ | 4 (10), 6 (12), 2, 5 (17) |
| `open-before-copy-logged` | §4.2: "B writes everything it copied into its own log … and commits it" (B keeps it in memory) | 1,000,001+ | 1,000,002+ | 3, 4 (12), 2, 5, 6 (15) |
| `fence-N-from-committed` | §4.2: "N is s's last sequence number" (taken from the committed state) | 1,000,001+ | 1,000,005+ | 6 (7), 7 (8), 3, 4 (12), 2 (15) |
| `stamp-from-committed` | §2: numbers "stamped by the shard's leader in log-end order" | 1,000,001+ | 1,000,001+ | 6 (6) |
| `no-carried-sequence` | §4.2: the carried state holds "the sequence and epoch" | 1,000,001+ | 1,000,001+ | 2, 6 (15) |
| `no-carried-outcomes` | §4.2: "the committed outcomes tagged with s" are carried | 1,000,002+ | 1,000,004+ | 5 (15) |
| `no-max-merge` | §4.2: "the issuer's highest call id, merged by `max` at B" | 3,669,799 | 1,723,358+ | 5 (19), on `wide` only: `deep` has no window, so no floor |
| `cancel-on-appended-abort` | §4.2: "A cancels a move only after B commits `abort(s)`" (on an appended one) | 1,023,636+ | 1,000,001+ | 7 (5), 1 (14) |
| `cancel-without-abort` | the same rule, removed: A cancels on its own | 1,000,003+ | 1,000,006+ | 7 (6), 1 (11), 4, 6 (14) |
| `b-aborts-after-open` | §4.2: "B aborts only before `open`" | 1,000,002+ | 1,000,003+ | 1 (13), 4, 6 (14) |

Three traces, in short:
- **`stream-before-fence-commits`** (the review's M1, 8 steps, property 1): A appends `fenced`, and before it commits sends `END(0)`. B copies, commits and opens. A's fence is still uncommitted, so both shards hold s; if A's leader is now deposed, the new one has no fence and takes writes.
- **`fence-before-importing-commits`** (case R-90, 4 steps, property 7): B appends `importing` and reports it. A fences. B's leader is deposed and its successor never had `importing`. Nobody will finish the move, and A cannot cancel without B's abort, so s takes no writes until someone re-drives the move.
- **`no-max-merge`** (19 steps, property 5): the client sends w1 to B (a stale table), then resends it to A, which commits it at 1 and answers. w3, to slot t, commits at A, so A's highest id is 3 and its floor (3 − 2) is 1: w1's outcome may be dropped and is not carried. B opens with the rows and highest id 3, but without the merge its own highest id is 0. The first, delayed copy of w1 now reaches B, which finds no outcome and no floor, and commits w1 again at 2.

## What the abstraction leaves out

- **Raft's insides.** Each shard is one log, not a log per replica: no votes, terms beyond the deposition count, PreVote, CheckQuorum, read index or membership changes. A leader that keeps acting after it was deposed is modelled only up to its deposition. The design never acts on another leader's tail, so this narrows only the mutant runs.
- **Scale.** One move of one slot, one issuer, two or three writes, one resend each, one or two depositions per shard. No second move, no move back, no move of many slots at once, no shard rule, no planner or stale hint, no move lease, no shard deletion.
- **Readers.** No reads, `state` or `log` subscribers of s, views, cursors, `log` readers below N, segments or object store. So "B's imported copy is invisible to views and reads" and the `END` to subscribers are not checked.
- **Recovery.** No epochs, `fero recover --unclean`, a lost B, or re-fencing from the slot table.
- **Rows and refusals.** Each write is one opaque cell, with no conditions, ops, rules or batches, so the only refusal is `stale-attempt`, and refusals as carried outcomes (case E3 across a move) are not exercised. The lock fence tables of the carried state are not modelled.
- **Time.** No clocks: no time budgets, retry horizon, forgetting of silent issuers, `retry-after`, leases or TTLs. Messages may be delayed without limit, which is stronger than the design assumes.
- **Answers.** `moved` and `retry` are not told apart; a client may send any copy to either shard. Answers to a client are taken at once or lost (exact, as argued above).
- **The copy.** B's subscription is modelled in `state` mode as whole snapshots of s's committed records, which B trims to those above its own position, not as deltas from a cursor.
- **Liveness** is checked only as "some path finishes from every state" (no state is a trap), which needs strong fairness to mean "every run finishes". There are no timeouts, so a client or the move can wait for ever when a fair scheduler would not let it.
