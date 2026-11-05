# The slot move, checked by exhaustive search

[slot_move.py](slot_move.py) is a small model checker for the slot move in [DESIGN-V5.md](../DESIGN-V5.md) §4.2 "Moving a slot". It is plain Python 3, standard library only, with no outside tools. It builds every state the model can reach, checks each one, and prints the shortest trace to any state that breaks a property (it searches breadth first, so the first bad state it finds is a nearest one).

Some words used below:
- A **slot** is one of a resource's 1,024 fixed hash buckets. A **shard** is a Raft group that holds some slots. A **move** hands one slot from shard A to shard B (DESIGN-V5 §2).
- The **slot table** is a row per slot in `#meta`, the cluster's own shard, naming the shard that holds the slot.
- An **unclean recovery** (`fero recover --unclean`) rebuilds a shard from one surviving copy after its majority is lost. The copy may lag, so recent entries can be gone. The shard gets a new **incarnation**, and its slots a new **epoch**.

```sh
python3 docs/v5-spec/slot_move.py --jobs 4        # the second round's runs below: TBD CPU-minutes
python3 docs/v5-spec/slot_move.py --quick         # a smoke test, seconds
python3 docs/v5-spec/slot_move.py --only fixed --bound move   # one run
python3 docs/v5-spec/slot_move.py --list          # the run names and the bounds
```

This file has two rounds. The **second round** checks the revised protocol (the move's owner, the ready report, the slot table, unclean recovery). The **first round**, at the end, checked the protocol before that revision; its findings are fixed in the text.

## Second round: the revised protocol

### The result, first

TBD

### What the model now has

Everything from the first round (the abstract Raft groups, the client and dedup, the message set; see the first round) carries over, plus:

- **The move's owner (C2).** A's leader appends `exporting(s, to B)`. The move's name is that entry's position in A's log. Every message of the move carries the name. Before its fence, A may cancel on its own (`cancel`), and B then drops its copy. After the fence, only B gives up (`abort`, only while its log has no `open`). B writes `s → A` back, then reports the abort, and A reopens s with `unfenced` at N.
- **The ready report (S1).** B commits its bulk copy, then reports ready with the position its copy reached. A fences on that report. After the fence commits, only the delta since the ready position crosses, then `END(N)` and the carried state.
- **The slot table (C1).** `#meta` is a third party: a register that B writes by message, that answers with an ack, and that may be slow (a delayed message). B writes `s → B`, and only once the ack comes does it append `open`.
- **Unclean recovery.** At most once per run, either shard may be recovered:
  - its committed log becomes any prefix of itself (a lagging survivor's copy);
  - its tail and its leader's memory are lost;
  - its epoch goes to 1, and positions compare as (epoch, seq);
  - then the recovery rule decides s: reopen only if the table names this shard, its copy holds s's rows, and no other shard holds s open or is importing it; otherwise s stays shut there. The rule may always leave s shut (`#meta` or a shard did not answer).

  After the recovery, nothing else goes wrong: no deposition, and the client sends nothing new (copies already in flight may still land). There is no "residual case": the old majority is gone for good.
- **Incarnations.** A recovery makes a new incarnation of the shard. Messages addressed to the old incarnation are not delivered to the new one, since links are set up per incarnation ("a replica is its member id plus its disk incarnation", §4.1). Messages the old incarnation *sent* stay deliverable: they are true reports of its past.
- **Reports are messages again.** In the first round, A read B's committed log directly, because a committed fact never became false. A recovery can now truncate a committed log, so every report is a real message. It enters the network the moment the sender's log (or an ack) makes it true, and may be delivered at any later time, any number of times.

### The bounds

| Bound | Shards | Writes | Depositions per shard | Moves per run | Recovery | For |
|---|---|---|---|---|---|---|
| `move` | A, B | none | 2 | 1 | yes | the move, the table and recovery, deeply |
| `moves` | A, B | none | 1 | 2 | yes | a second move after the first ends; stale messages of an ended move |
| `three` | A, B, C | none | 1 | 2 | yes | moves to two targets |
| `write` | A, B | w1 to s, one resend, each copy to either shard | 1 | 1 | yes | positions and lost writes across a recovery |
| `dedup` | A, B | w1 to s, w2 to t, one resend each, window 1 | 1 | 1 | no | the floor, the carried outcomes, the `max` merge |
| `deep` | A, B | w1 and w2 to s, no resend | 1 | 1 | no | stamping and N with two writes in flight |

### The properties

| # | Property | Checked |
|---|---|---|
| 1 | At most one shard holds s open (a committed `open`, `unfenced`, reopening recovery, or genesis, with no later fence or shutting recovery) | every state |
| 2 | No position (epoch, seq) is stamped on committed writes by two shards | every state |
| 3 | Every write committed to s at A before a move's fence is at the target when it opens | every state |
| 4 | No acknowledged write goes missing from the state of the shard that holds s | every state before a recovery (after one, losses are allowed) |
| 5 | No attempt id commits twice | every state |
| 6 | A slot's position never goes back, and is never handed out twice | in each log; and on every commit of a write, its (epoch, seq) is above every position committed before, anywhere, ever |
| 7 | Liveness: with no more faults, every move finishes or is cancelled | from every reachable state with no recovery, with all messages lost, then no deposition, loss, recovery, or new cancel or abort; some path ends every move (AG EF) |
| 8 | An attempt its issuer took as refused never commits | every state |
| 9 | Whenever a shard holds s open, the table names it | every state |

### Runs

TBD

### What is still wrong in the text

TBD

### Mutants

TBD

### What this round leaves out

TBD

## First round: the protocol before the revision

The first round checked §4.2 as it stood at commit fc81eb7: no `exporting`, no ready report, no slot table, no recovery. The model, its traces and its full write-up are in commit 28ad0a2 (`git show 28ad0a2:docs/v5-spec/slot_move.md`). In short:

**The model.** Two shards A and B as abstract Raft groups (a committed log, a leader's tail lost on deposition, a lost tail that may come back until the next commit). One slot moved from A to B; slot t stayed at A. One issuer with rising call ids, resends, the window and the floor. A message set with duplication, delay and loss. Two bounds:
- `deep`: two writes to s, two depositions per shard;
- `wide`: writes to s, s and t under window 2, one deposition per shard.

**What held.** With each guard read the safe way, all eight properties held:
- `deep`: 3,669,799 states;
- `wide`: 4,302,406 states;
- property 7 (liveness): from every state.

**What was wrong in the text, now fixed:**
1. "Every step acts only on committed entries" was wrong for a guard that forbids a step.
   - Read literally, A took a write after its own uncommitted fence (12 steps to a lost acknowledged write), and B aborted after, or opened after, its own uncommitted `abort`/`open` (13 steps to two shards holding s).
   - Fixed by "Two kinds of rule".
2. §2 said a new leader "stamps on from its committed state, after any uncommitted tail it drops", though Raft keeps that tail.
   - Two committed records got one number (7 steps).
   - Fixed: §2 now stamps from the log end.
3. Appending the `stale-attempt` refusal of a resent copy let duplicates grow the log without bound.
   - Fixed: such a refusal is never appended.

**Mutants (first round).** 12 of 13 caught. The one not caught, B serving after appending `open` but before it commits, was not needed for any modelled property: a write after an uncommitted `open` commits only with it, and no answer goes out before commit.

| Mutant (rule removed) | Caught by (steps) |
|---|---|
| A fences before B's `importing` commits | 7 only (4) |
| A streams before its `fenced` commits | 1 (8), 7 (11), 3, 4, 6 (12), 2, 5 (15) |
| B serves after appending `open`, before it commits | not caught |
| B serves before `open` | 4 (10), 6 (12), 2, 5 (17) |
| B commits `open` without writing its copy | 3, 4 (12), 2, 5, 6 (15) |
| N from committed state | 6 (7), 7 (8), 3, 4 (12), 2 (15) |
| stamping from committed state | 6 (6) |
| sequence not carried | 2, 6 (15) |
| outcomes not carried | 5 (15) |
| no `max` merge | 5 (19), `wide` only |
| A cancels on B's appended `abort` | 7 (5), 1 (14) |
| A cancels without B's `abort` | 7 (6), 1 (11), 4, 6 (14) |
| B aborts after `open` | 1 (13), 4, 6 (14) |
