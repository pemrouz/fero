# E-48: answers per operation (ack stages) inside Raft, on TiKV's shape

**Question (Q-48).** MEMORY.md recommends a `memory` option chosen per resource (form (a)). The owner asked: "re: option being per resource, did you rule out guarantees per operation where you can await different types of acks, e.g. wait till server received it, wait till replicated, wait till on disk etc? if so, can you explain tradeoff?" Q-48 asks three things, on TiKV's shape.
- **S1, ack stages.** Every write still commits on disk, exactly as `persisted`. Only the caller's own answer may come earlier, at a stage it picks per call: received, replicated or committed. Which promises break, and which rules fix them? Does S1 need any rule that `persisted` alone does not?
- **S2 and its cousins.** If writes commit in memory and each caller's answer waits for its own stage (S2), or for a fixed stage per kind of write (S3, MEMORY's form (e1)), or a caller awaits the disk on a memory resource (S4, MEMORY's (e4)), what breaks?
- **The details of an early answer.** Can it carry an operation's result? What does read-your-writes mean after it? What does a client's next pipelined write do if an early-answered write is lost? What does a resend do to exactly-once?

**Where the study stood** (cited: the files named).
- v4 had a per-write ladder: [kernel/confirm.ts](../../../../kernel/confirm.ts) (levels `replicated` and `persisted`, proven from the watermark ladder), [DECISIONS V3-7](../../../DECISIONS.md) ("evidence for confirms is the watermark ladder, never `applied`"), and [examples/10-confirm](../../../../examples/10-confirm/) ("the same write awaited at three rungs — committed, replicated, persisted").
- v5 dropped it for COMP2. AMENDMENTS footnote 13: "`maj-m` and `none` per resource, never per write, because G `pslot` cuts groups by durability". API.md Q-A9 and its `@ts-expect-error` case say the same. VERDICT's P-15 row: RR-11's closer "commit a saga unit's steps on a `memory` resource at `persisted`" "needs a rung chosen per write, which COMP2's Q forbids".
- So what was ruled out is a **commit level per write** (S2's shape), and only for COMP2's shared groups. Per-call **answer stages over a fixed commit** (S1) were never weighed. MEMORY.md weighed (e1), (e4) and (e5) (the leader alone answers), but not S1.

**Threshold.** None that kills a design. As in E-47, a form is priced at the smallest set of rules that makes every counted property hold on every bound, with every program still able to finish. A rule counts as needed only if dropping it brings a counterexample back (DEV-10's ablation).

**In short** (model-checked: every reachable state at small bounds; checked by brute force: three explicit copies; "reasoned" where marked):

- **S1 leaves Raft exactly as `persisted`** (checked by brute force, 1 to 4 entries, up to 116,874 states). Memory reports change no transition and no commit point, and nothing committed is ever lost.
- **What each early stage survives** (checked by brute force):
  - `received` is lost on any leader change, with no power loss at all.
  - `replicated` survives any process crash, but **not one power loss**: one machine losing power (the leader's or a follower's) can lose it, because under `persisted` Raft a copy that lost power still votes. "All three copies hold it in memory" survives one power loss, with no change to voting.
  - `committed` is never lost.
- **Without rules, S1 breaks promises to other parties** (model-checked; shortest traces):
  - a snapshot misses part of a transaction **with no fault at all** (ATOMIC, 10 steps): the coordinator takes its commit timestamp on an early prewrite answer, before the lock is visible to readers;
  - after a power loss (at `received`, after a plain process crash too): half a transaction (OTHERS.txn, 8), a protected write under a grant that was lost (OTHERS.lock, 6), pipelined writes out of order (ORDER, 7);
  - read-your-writes fails with no fault (RYW, 5);
  - when the library acts on early answers but the caller asked for a durable outcome, the caller's durable answer breaks too (DURABLE 17, REFUSED 19).
- **Three rules fix all of it (W1 has four parts), and none touches the servers' Raft** (model-checked: 160 runs over four stage maps, both result modes, both faults; each part needed; E-17's greedy ablation ends at the same set in all three orders run):
  - **W1**: the library's own protocol steps wait for durable answers (the commit after the prewrites, the secondaries after the primary, a reader's resolve after its check, a protected write after its claim). Only the caller's own answer may come early.
  - **O.seq**: a writer's sequence number, so a write sent after a lost one is refused `gap` and sent again in order. This is the "issue order" every row already owes (AMENDMENTS A-10), and the sequence [E-45] F4 proposes after it measured the break on the prototype. `persisted` alone needs it once a client pipelines (ORDER 7 under S0). With S1 even a client that awaits each answer needs it, since awaiting an early answer no longer keeps order (`pipe`: ORDER 7 under S1, ok under S0).
  - **Y**: a read waits until the writer's last answered write is visible.
  - E-47's epoch (R3) is not needed, and cannot stand in for W1.
- **What an early answer's contract must say** (model-checked, reported): it can vanish. Under `spec` its result can change after a loss: an early "aborted" became a commit (RESULT 16 and 18 steps), an early "ok" for a protected write became "fenced" (16), and an early grant's token changed (7). Under `blind` it carries no result, so it helps only blind writes. This model's plain writes can never be refused. fero's plain writes are judged (shape checks, `schema`, a `rules.write` that sees the current row, `read-only`, `disk-full`), so for them a blind early answer still means only "got this far": a resent copy is judged again and may be refused (reasoned; MEMORY 9.4).
- **S2 (commit in memory, an answer level per write) needs the `memory` rung's Raft rules on every group** (brute force). **Even when every caller waits for the disk (S4), readers act on writes that are later lost** (ATOMIC 21 and 22, OTHERS.read 5 and 11). **MEMORY's (e1) has the same gap, now model-checked.** With every reader on the disk prefix (W1+RD+O.seq+Y, model-checked, each part needed), S2 holds, but then it is S1 plus the `memory` rung's Raft rules. E-47's epoch cannot close the gap.
- **The tradeoff** (reasoned). S1 is the cheap form: no change to Raft's commit, election or recovery rules, no recovery step, no kind of write refused, transactions and locks on every resource, and with its three rules only the caller can ever be misled. But it buys only the caller's own wait. What others see, CPU per write, top speed and disk stalls stay as `persisted`. Form A buys those too, at the price of a lost-tail contract for everyone on a memory resource, refusals, and recovery rules. The two can be combined.
- **The study ruled out a commit level per write, not this.** Footnote 13's reason (a shared group has one commit point) does not reach S1, which never moves a commit point.

## Words used here

- **Stage**: when a caller's answer resolves.
  - **received** (`recv`): the range leader has appended the write to its log.
  - **replicated** (`repl`): two of the three copies hold it in memory. Here that means in the operating system's page cache, not yet fsynced: a follower reports receipt right after its write to the operating system, as E-02's `memory` rung acks ([E-02] `ts/pipeline.ts`: "no fsync on this rung"; cited).
  - **committed** (`cmt`): on disk at two of three copies, applied, visible to everyone. This is `persisted`.
  - Under S2: **`mem`** (committed in memory: applied and visible) and **`disk`**.
- **Early answer**: an answer at a stage before the durable one. **Durable stage**: `cmt` in S0 and S1, `disk` in S2.
- **m, k**: the longest start of the log that two copies hold in memory (m) and on disk (k). k ≤ m.
- **Commit point**: the start of the log that is applied and seen by readers. k in S0 and S1; m in S2.
- **Power loss** (an unclean stop): the machine keeps only what it fsynced. **Process crash**: the process dies but the page cache survives (a kill, a deploy, a partition that moves the leader).
- **Promise to others**: anything another client, reader, lock holder or range acts on. **The caller's own promise**: the answer the caller asked for.
- **spec** and **blind**, how an early answer gets a result. **spec**: the leader judges each command over its own log in log order before the command commits, and the early answer carries that result. TiKV judges conflicts before it proposes, under **latches** (a per-key queue that lets one command on a key run at a time); from memory, not checked here. **blind**: an early answer carries no result, only "accepted".
- **Stage map**: one stage per kind of operation (below).
- **Percolator, prewrite, primary, secondary, resolve, lock row, token, fence, epoch, TSO**: as in [E-47](../E47-memory-rung/README.md#words-used-here).
- **Come back as new (cbn)**: the `memory` rung's rule that a copy which stopped uncleanly neither votes nor leads until it has caught up (the settled `memory-rung` unit, MEMORY 3.1).

## Method

One exhaustive model in plain Python, [models/ackstage.py](models/ackstage.py), copied from E-47's [models/memrung.py](../E47-memory-rung/models/memrung.py) and changed (E-47 is not edited). It runs on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)) with E-17's rule language unchanged. Each run explores every reachable state breadth first, so every trace is a shortest one. Liveness is AG EF: from every reachable state, some path with no more faults ends every program. [run48.py](run48.py) runs every configuration; [tools/raftcheck48.py](tools/raftcheck48.py) checks the Raft step by brute force.

**What is kept from E-47.** Two Raft groups A and B and a TSO; only A can fail, B never stops. Percolator's two-phase commit with a primary and secondaries, judged in log order. A coordinator that may crash; readers that resolve expired locks; two lock holders with oracle tokens and fence tables, one of whose leases can lapse while it is paused; copies on the network delivered at most once, after any delay, in any order; a client sends a command again when it is gone (no copy in flight, no entry in the log).

**What is new.**
- **Group A is (log, m, k, term).** `repl` (a time step) moves m to the end of the log; `sync` moves k to m.
- **Two faults on A, each at most once per run.**
  - `stop`, a power loss of the leader alone or of a majority. The new leader keeps the log cut to any length l with k ≤ l ≤ len, plus a no-op (or E-47's epoch entry under R3). In S0 and S1, m falls to k; in S2 the recovery commits the kept log (as E-47's `memory` group).
  - `lcrash`, the leader's process crash with the page cache kept. The new leader keeps any l with m ≤ l ≤ len.
  - Section 1 checks both cut ranges by brute force. A bound named `…-c` has `lcrash` in place of `stop`.
- **The forms.**
  - **S0**, `persisted` only: every answer at `cmt`. The baseline (E-47's run 1, with m and the process crash added).
  - **S1**: commit, apply and reads exactly as S0; each kind of operation answers at its stage map's stage.
  - **S2**: commit, apply and reads at m; each answer at `mem` or `disk`.
  - **S3** is S2 with stage map `e1`, MEMORY's (e1). **S4** (await disk on a memory resource) is S2 with stage map `disk`.
  - **A**, MEMORY's per-resource form, is E-47's `MP` config and is not rerun here.
- **Stage maps** (which stage each kind of operation answers at):

| Map | Form | prewrite | reader's check | claim | primary commit (the transaction's outcome) | protected write | plain write | What it stands for |
|---|---|---|---|---|---|---|---|---|
| `cmt` | S0 | cmt | cmt | cmt | cmt | cmt | cmt | `persisted` |
| `recv` | S1 | recv | recv | recv | recv | recv | recv | every answer at received |
| `repl` | S1 | repl | repl | repl | repl | repl | repl | every answer at replicated |
| `mixr` | S1 | recv | recv | recv | cmt | cmt | recv | the library runs its own steps on early answers; the caller's outcome is durable |
| `mixp` | S1 | repl | repl | repl | cmt | cmt | repl | the same at replicated |
| `mem` | S2 | mem | mem | mem | mem | mem | mem | the `memory` rung everywhere |
| `disk` | S2 | disk | disk | disk | disk | disk | disk | S4: every caller awaits the disk |
| `e1` | S2 | disk | disk | disk | disk | disk | mem | S3, MEMORY's (e1) |

- **Results in early answers:** `spec` (the default) or `blind` (configs ending `-blind`). Under `blind` a step that needs a result waits for the durable stage.
- **Answers are told when first in.** The model records a caller's early answer in the first state where it is in at the caller's stage, so a later loss is always seen.
- **A plain writer and a plain reader.** The writer sends plain write 1 (and 2) of key p, each once the answer to the one before is in at its stage. It follows every write to the durable stage and sends a copy again, lowest first, when one is gone or refused (budget one each). Its copies reach the leader in the order sent (one connection). In bound `ryw` it then reads p. A plain reader reads p once.

**The rules** (each a switch; the ablation drops them):

| Rule | What the model does | Source |
|---|---|---|
| W1.pw | the coordinator commits the primary only once every prewrite is durable | found here |
| W1.cm | it sends the secondaries' commits only once the primary's commit is durable | found here |
| W1.chk | a reader resolves a key only once its check of the primary is durable | found here |
| W1.claim | a holder sends its protected write only once its claim is durable | found here |
| O.seq | the plain writer's writes carry a sequence; the group applies them in order, refuses a gap (`gap`), and answers a repeat `dup` | AMENDMENTS A-10's issue order, owed by every row; [E-45] F4 proposes this sequence, after Kafka's idempotent producer |
| Y | read-your-writes: a client's read waits until its last answered write is visible, or gone | Raft's ReadIndex with a lower bound (reasoned) |
| RD.txn, RD.plain | S2: readers of transaction keys (of the plain key) read the majority-disk prefix only | MEMORY's hand replay of (e1) |
| R1s, R2.*, R3.* | E-47's rules, unchanged | E-47 |

W1 together says: **the library's own protocol steps rest only on durable answers; only the caller's own promise may resolve early.** No server state carries it.

**Properties.** A promise to the caller counts only when the caller chose the durable stage for it.
- E-47's: **ATOMIC** (a snapshot holds part of a transaction), **DURABLE** (a durably acked entry gone, or a rollback record for a transaction durably told committed), **MONO** (a later snapshot older, on a key read from a durable prefix), **REFUSED** (a transaction durably told aborted commits), **ONCE**, **TOKEN**, **FENCE** and **HOLDERS** (durable grants only).
- New:
  - **OTHERS.read**: a reader was shown a value whose write is no longer committed. For a transaction key, neither that key's commit record nor the primary's (which decides the transaction) is committed any more.
  - **OTHERS.lock**: a protected write is committed under a token whose claim is gone from the lock row's log.
  - **OTHERS.txn**: a transaction holds a commit record at one key and a rollback record at another, or its primary is committed while a secondary's prewrite is gone and nothing can lock it again.
  - **ORDER**: the plain writer's committed writes are not 1, 2, … in order, with no gap and no repeat.
  - **RYW**: the plain writer's read missed its own answered write, and that same copy of the write is committed.
  - **done**: every program can end once faults stop.
- **Reported, not counted** (mode `info`): what an early answer's contract allows.
  - **EARLY-LOST**: an early-answered command is gone from the log and the network.
  - **RESULT**: an early answer's result differs from the result the committed log gives the same command.
  - **EARLY-HOLDERS**: two holders hold a grant at any stage, neither lease lapsed.
  - **READBACK**: a later snapshot older, on a key read from a memory prefix.

**Bounds** (each: one fault on group A).

| Bound | What runs | Other faults |
|---|---|---|
| `txn`, `txnb`, `txn1`, `dedup`, `lockAA`, `lockBA`, `lockAB` | E-47's bounds unchanged: a transaction over A and B (primary on A, or on B), one inside A, a commit sent twice, two lock holders with the lock row and key x on each mix of groups | as E-47: a coordinator crash, lock TTLs, a paused lease |
| `pipe` | the plain writer's two writes; a plain reader | |
| `pipe-t` | as `pipe`, and the writer may also resend a write on a timeout while a copy is still in the log or in flight | |
| `pipe-s` | as `pipe`, but the writer sends write 2 without waiting for any answer (pipelining under S0) | |
| `ryw` | one plain write, then the writer reads p | |
| `…-c` | the same bound with the leader's process crash in place of a power loss | |
| larger | `txn1-2r` (two snapshots), `dedup-v` (three commit copies, a coordinator crash, two readers), `lockAA-v`, `lockAB-v` (two paused leases, a second claim), `pipe3` (three writes and a read, a power loss and a process crash) | |

## Results

Machine: 4 vCPU, 15 GB, Python 3.13.17. Every step ran under the study's heavy lock and `nice -n 10`, up to four steps side by side. Raw output with every trace: [results/base.txt](results/base.txt), [results/crash.txt](results/crash.txt), [results/info.txt](results/info.txt), [results/rules.txt](results/rules.txt), [results/subs.txt](results/subs.txt), [results/greedy.txt](results/greedy.txt), [results/s2.txt](results/s2.txt), [results/verify.txt](results/verify.txt), [results/raftcheck.txt](results/raftcheck.txt). Every run's numbers are in [results/runs.json](results/runs.json) and as tables in [results/summary.md](results/summary.md). In all: 1,637 runs, 62,876,826 states and 4,856 s of CPU (about 81 minutes) in the cache. Add about 5 minutes of trial runs on earlier drafts of the model and about 20 s for raftcheck48. The largest run explored 1,279,361 states (S1 `recv`, no rules, `dedup-v`). Every run either explored every state or stopped at its first break. None stopped at the state limit, and no run has a stuck state.

### 1. The Raft step, checked by brute force

[tools/raftcheck48.py](tools/raftcheck48.py) builds three explicit copies, each with its log length and synced length, and the leader's view of each follower's memory report and disk report (the views lag). It explores every reachable state with 1 to 4 entries (up to 116,874 states with memory reports), then every fault and every election Raft allows ([results/raftcheck.txt](results/raftcheck.txt)).

**(A) S1 changes nothing in Raft** (checked by brute force). With and without memory reports, the reachable states seen through (log, synced length, disk reports) are the same set, and every fault gives the same set of new log lengths. That holds for 1 to 4 entries (8,058 states without memory reports, 116,874 with). Memory reports feed only answers.

**(B)** The leader's commit point never runs ahead of the true majority-disk point, and its `replicated` point never runs ahead of the true majority-memory point (0 states, every size).

**(C) What each stage survives** (S0 and S1; copies that stopped uncleanly vote on what they synced, as `persisted` Raft allows). At 4 entries:

| Fault | Outcomes (state, new leader) | Commit point lost | `replicated` lost | `received` lost |
|---|---|---|---|---|
| none: a leader change with every log intact (process crash, partition) | 140,648 | 0 | 0 | 23,774 |
| one copy loses power | 494,042 | 0 | 26,536 | 162,294 |
| two or three copies lose power | 776,165 | 0 | 155,826 | 436,897 |

- **`received` is lost on any leader change**, with no power loss at all.
- **`replicated` survives any process crash, but not one power loss.** One copy losing power was enough in 26,536 outcomes: 14,664 when the stopped copy was the leader, 11,872 when it was a follower. The shortest case (1 entry): the leader and follower 1 hold the entry in memory, follower 2 does not; follower 1 loses power and restarts without it; follower 2 asks for votes, follower 1 votes for it, and it wins with a log that lacks the entry. The old leader then truncates its own copy. (With pre-vote and check-quorum, as etcd's Raft has, follower 2 must also have lost touch with the leader first; reasoned, not modelled.)
- **A variant, "all three copies hold it in memory", survives one power loss** (0 losses on one stopped copy, every size; 27,988 at 4 entries when two or three lose power). It needs no change to voting. It waits for the slowest copy.
- **The commit point is never lost** (0 in every row): S1's `committed` is exactly `persisted`.

**(D) The model's two fault steps are sound.** Every election over intact logs keeps a length in [m, len] (the model's `lcrash`); every unclean stop keeps one in [k, len] (the model's `stop`), and for each (len, m, k) the unclean stops reach all of [k, len] (0 of 35 triples differ at 4 entries).

**(E) S2 needs the `memory` rung's rules.** If S2 commits at the memory point and copies that lost power may vote, one power loss already loses a committed entry (26,536 outcomes at 4 entries, the same count as `replicated` above). With "come back as new", no single fault loses a committed entry (0), a fault that stops two or three copies leaves no voting majority (467,496 cases at 4 entries) and needs the operator, and the operator's recovery from the longest log any copy holds stays inside [k, len] (0 below k). Recovering from the survivors alone cut below k in 12,870 of 350,622 cases. These are E-47's findings again (MEMORY rules 7 and 15); S1 needs none of them.

### 2. No rules (step `base`)

Each cell lists every property broken, with its shortest trace; the number in brackets is the states explored. "ok" means nothing breaks and no state is stuck. A power loss of group A, once per run.

| Config | `txn` | `txnb` | `txn1` | `dedup` | `lockAA` | `lockBA` | `lockAB` | `pipe` | `pipe-t` | `ryw` |
|---|---|---|---|---|---|---|---|---|---|---|
| S0 | ok (98,084) | ok (59,998) | ok (82,732) | ok (8,742) | ok (11,518) | ok (2,840) | ok (4,726) | ok (228) | ORDER 6 (1,372) | ok (46) |
| S1 `recv` | ATOMIC 13, OTHERS.txn 16 (738,326) | ATOMIC 10, OTHERS.txn 8 (122,888) | ATOMIC 12, OTHERS.txn 10 (483,699) | ok (16,858) | OTHERS.lock 8 (83,100) | ok (4,988) | OTHERS.lock 6 (23,086) | ORDER 7 (412) | ORDER 6 (9,065) | RYW 5 (85) |
| S1 `repl` | ATOMIC 15, OTHERS.txn 17 (537,986) | ATOMIC 11, OTHERS.txn 9 (103,386) | ATOMIC 13, OTHERS.txn 11 (392,154) | ok (15,817) | OTHERS.lock 9 (85,790) | ok (5,224) | OTHERS.lock 7 (23,284) | ORDER 8 (532) | ORDER 6 (9,740) | RYW 5 (97) |
| S1 `mixr` | ATOMIC 15, DURABLE 17, OTHERS.txn 16, REFUSED 19 (427,576) | ATOMIC 10, OTHERS.txn 8 (120,308) | ATOMIC 12, DURABLE 19, OTHERS.txn 10, REFUSED 21 (302,850) | ok (10,491) | OTHERS.lock 8 (46,418) | ok (2,840) | OTHERS.lock 6 (23,086) | ORDER 7 (412) | ORDER 6 (9,065) | RYW 5 (85) |
| S1 `mixp` | ATOMIC 16, DURABLE 18, OTHERS.txn 17, REFUSED 21 (328,653) | ATOMIC 11, OTHERS.txn 9 (101,226) | ATOMIC 13, DURABLE 20, OTHERS.txn 11, REFUSED 23 (248,900) | ok (10,211) | OTHERS.lock 9 (51,640) | ok (2,840) | OTHERS.lock 7 (23,284) | ORDER 8 (532) | ORDER 6 (9,740) | RYW 5 (97) |
| S2 `mem` | ATOMIC 16, OTHERS.read 16, OTHERS.txn 16 (529,291) | ATOMIC 12, OTHERS.txn 9 (133,362) | ATOMIC 13, OTHERS.read 13, OTHERS.txn 10 (847,725) | OTHERS.read 10 (23,114) | OTHERS.lock 8 (76,211) | ok (4,035) | OTHERS.lock 7 (20,585) | ORDER 7, OTHERS.read 5 (604) | ORDER 5, OTHERS.read 5 (11,177) | ok (61) |
| S4 = S2 `disk` | ATOMIC 21, OTHERS.read 21 (98,598) | ok (77,995) | ATOMIC 22, OTHERS.read 22 (113,923) | OTHERS.read 11 (8,418) | ok (9,955) | ok (2,239) | ok (4,031) | OTHERS.read 5 (223) | ORDER 5, OTHERS.read 5 (1,323) | ok (36) |
| S3 = S2 `e1` | ATOMIC 21, OTHERS.read 21 (98,598) | ok (77,995) | ATOMIC 22, OTHERS.read 22 (113,923) | OTHERS.read 11 (8,418) | ok (9,955) | ok (2,239) | ok (4,031) | ORDER 7, OTHERS.read 5 (604) | ORDER 5, OTHERS.read 5 (11,177) | ok (61) |

S0 on `pipe-s` (write 2 sent without waiting for write 1): ORDER 7 (426).

**The shortest traces, in words** (full ones in [results/base.txt](results/base.txt)):
- **S1, a snapshot misses a transaction with no fault at all** (ATOMIC, 10 steps, `txnb` at `recv`; 13 on `txn`, 12 on `txn1`). T prewrites a (group A) and hears "ok" as soon as A's leader appends it. T prewrites and commits b (its primary, on B). A reader takes a later snapshot and reads a: the lock is not yet committed, so the reader sees a's old value; then it reads b's new one. Percolator needs every lock visible before the commit timestamp is taken; an early prewrite answer breaks that. The same break shows at `repl` (11 steps) and with only process crashes (section 3).
- **S1, half a transaction after a power loss** (OTHERS.txn, 8 steps, `txnb` at `recv`; 9 at `repl`). T's prewrite of a is answered early; a power loss drops it; T commits its primary b. a can never be committed.
- **S1, a lock holder writes under a grant that was lost** (OTHERS.lock, 6 steps, `lockAB` at `recv`; 7 at `repl`). h0 hears "granted, token 2" early; a power loss drops the claim; h0's protected write commits under a token no lock row ever granted.
- **S1, the library's early steps break the caller's durable answer** (`mixr`: DURABLE 17, REFUSED 19). The caller asked for a durable outcome, but a reader acted on an early answer to its check of the primary. In the DURABLE trace the reader hears "rolled back" early and rolls b back; a power loss drops the check; T's commit then lands, and T is durably told committed with b rolled back. In the REFUSED trace the reader hears "committed" early and commits b; a power loss drops a's prewrite and commit; T's commit is sent again, finds no lock, and T is durably told aborted with b committed.
- **S1, pipelined writes out of order** (ORDER, 7 steps, `pipe` at `recv`; 8 at `repl`). Write 1 is answered early, the writer sends write 2, a power loss drops write 1, and write 2 lands alone. Write 1 sent again lands after it.
- **S1, read-your-writes, with no fault** (RYW, 5 steps, at `recv` and `repl`). The writer's write is answered early, the writer reads, the read is served from the committed state and misses it, then the write commits.
- **S0 too breaks ORDER**, but only with pipelining (`pipe-s`, 7 steps: write 2 sent before write 1's answer, write 1 lost) or a timeout resend (`pipe-t`, 6 steps: write 1 applied twice). The first is the break [E-45] F4 measured on the prototype (12 of 100 seeds), and the reason AMENDMENTS A-10 owes issue order on every row. The second needs writes with no id: this model's plain writes carry none, while TiKV-persisted's transaction ids, and A-10's caller keys, make a resend apply once. So O.seq is owed by every form already; S1 adds that a client which sends its next write after an early answer needs it too.
- **S2 with every caller at `disk`, i.e. S4** (ATOMIC 22 on `txn1`, OTHERS.read 11 on `dedup`, 5 on `pipe`). In the 11-step trace T's commit of x is committed in memory; a reader reads x = T; a power loss drops the commit. T was never told anything, but the reader saw it committed. The 22-step trace is MEMORY's hand replay of (e1): the reader reads a's commit from memory, a power loss drops it, the reader rolls the transaction back and reads c's old value. Locks and fences hold at `disk`.
- **S3, MEMORY's (e1)** breaks exactly as S4 on transactions (ATOMIC 21 and 22, OTHERS.read), and on plain writes as the `memory` rung does (ORDER 7, OTHERS.read 5). So **the gap MEMORY found by hand is real** (model-checked): a reader acts on a commit that is not on disk.
- **S2 at `mem`** is the `memory` rung everywhere: something breaks on every bound but `lockBA` and `ryw` (ATOMIC, OTHERS.txn, OTHERS.lock, OTHERS.read, ORDER).
- `dedup` and `lockBA` never break under S1 without rules: the coordinator's commit is answered early but nothing else rests on it there, and the lock row sits on the group that never fails.
- No run has a stuck state.

### 3. A process crash only (step `crash`)

The same bounds with the leader's process crash in place of a power loss ([results/crash.txt](results/crash.txt)).

| Config | `txn-c` | `txnb-c` | `txn1-c` | `dedup-c` | `lockAA-c` | `lockBA-c` | `lockAB-c` | `pipe-c` | `pipe-t-c` | `ryw-c` |
|---|---|---|---|---|---|---|---|---|---|---|
| S0 | ok (100,828) | ok (61,730) | ok (85,202) | ok (9,619) | ok (11,880) | ok (2,924) | ok (4,832) | ok (233) | ORDER 6 (1,447) | ok (47) |
| S1 `recv` | ATOMIC 13, OTHERS.txn 16 (808,041) | ATOMIC 10, OTHERS.txn 8 (128,510) | ATOMIC 12, OTHERS.txn 10 (512,646) | ok (18,592) | OTHERS.lock 8 (88,710) | ok (5,196) | OTHERS.lock 6 (24,164) | ORDER 7 (427) | ORDER 6 (10,129) | RYW 5 (87) |
| S1 `repl` | ATOMIC 15 (217,505) | ATOMIC 11 (95,688) | ATOMIC 13 (173,360) | ok (13,492) | ok (26,228) | ok (3,636) | ok (9,740) | ok (283) | ORDER 6 (6,610) | RYW 5 (66) |
| S1 `mixr` | ATOMIC 15, DURABLE 17, OTHERS.txn 16, REFUSED 19 (458,351) | ATOMIC 10, OTHERS.txn 8 (125,846) | ATOMIC 12, DURABLE 19, OTHERS.txn 10, REFUSED 21 (317,754) | ok (11,545) | OTHERS.lock 8 (49,198) | ok (2,924) | OTHERS.lock 6 (24,164) | ORDER 7 (427) | ORDER 6 (10,129) | RYW 5 (87) |
| S1 `mixp` | ATOMIC 16 (173,127) | ATOMIC 11 (93,684) | ATOMIC 13 (139,460) | ok (10,720) | ok (20,710) | ok (2,924) | ok (9,740) | ok (283) | ORDER 6 (6,610) | RYW 5 (66) |
| S2 `mem` | ok (224,670) | ok (113,992) | ok (262,918) | ok (19,176) | ok (26,228) | ok (3,636) | ok (9,740) | ok (332) | ORDER 5 (8,676) | ok (54) |
| S4 = S2 `disk` | ok (106,822) | ok (75,789) | ok (103,055) | ok (10,045) | ok (11,880) | ok (2,924) | ok (4,832) | ok (249) | ORDER 5 (1,591) | ok (47) |
| S3 = S2 `e1` | ok (106,822) | ok (75,789) | ok (103,055) | ok (10,045) | ok (11,880) | ok (2,924) | ok (4,832) | ok (332) | ORDER 5 (8,676) | ok (54) |

S0 on `pipe-s-c` (write 2 sent without waiting for write 1): ORDER 7 (441).

- **`replicated` answers survive a process crash.** At `repl` and `mixp` the only breaks left are the two that need no fault (ATOMIC from an early prewrite, RYW) and the timeout repeat S0 shares (`pipe-t`). Every OTHERS break is gone.
- **`received` answers do not:** every break of section 2 comes back at `recv` and `mixr` with a process crash alone.
- **S2 survives a process crash** (only `pipe-t` breaks, as S0): its commit is in memory at two copies, and a process crash keeps the page cache.

### 4. What an early answer's contract allows (step `info`, reported, not counted)

With the rules S1 needs (W1+O.seq+Y, section 5), the counted properties all hold; these are the losses left, which the early answer's contract must name ([results/info.txt](results/info.txt)).

| Config | EARLY-LOST (shortest) | RESULT (shortest) | Process crash only |
|---|---|---|---|
| S1 `recv`, spec | 3 to 10 steps on every bound but `txnb` | 7 (`lockAA`, `lockAB`), 16 (`dedup`, `lockBA`), 18 (`txn`, `txn1`) | the same |
| S1 `repl`, spec | 4 to 11 steps on the same bounds | 8, 17, 19 | **nothing lost** |
| S1 `mixr`, spec | 3 (`lockAA`, `lockAB`, plain bounds) | 7 (`lockAA`, `lockAB`) | the same |
| S1 `recv`, blind | as spec | **never** | as spec |
| S1 `repl`, blind | as spec | **never** | nothing lost |
| S2 `mem` (no rules) | 4 to 10 | 8 to 17; READBACK 18; EARLY-HOLDERS 9 | |

- **An early answer can carry a result, but the result is not final** (spec; model-checked). If the entry survives, the result is the committed one (the cut is a suffix, so everything it was judged on survives too). If the entry is lost, a copy sent again is judged afresh:
  - **an early "aborted" can turn into a commit** (RESULT 16 on `dedup`, 18 on `txn1`): T's primary commit is judged "rolled back" at the leader, behind a reader's check, and T is told aborted early; a power loss drops both; T's second copy commits. This is E-47's REFUSED trace (RR-13), now as an early answer. A caller that retries the whole order on that "aborted" gets it twice.
  - **an early grant's token can change** (RESULT 7 on `lockAA`): h0 hears "granted, token 2"; a power loss drops the claim; the claim sent again is granted token 3.
  - **an early "ok" can turn into a refusal** (RESULT 16 on `lockBA`): h0's protected write under token 2 is answered "ok" early; a power loss drops it; meanwhile h0's lease lapses and h1 claims (token 4) and writes; h0's copy sent again is fenced.
- **Under blind, RESULT never happens, but the early answer carries nothing a program can act on.** Every step that needs a result (prewrite, check, claim, a conditional write) waits for the durable stage anyway. Blind early answers help only blind writes.
- **`mixr` (the library acts early, the caller's outcome is durable) needs W1**, and then loses only the early grants and plain writes: with W1 the library waits anyway, so for transactions it is S0.

### 5. The rules S1 needs (steps `rules`, `subs`, `greedy`)

**W1+O.seq+Y holds everywhere** ([results/rules.txt](results/rules.txt)): on all four stage maps, with results `spec` and `blind`, with a power loss and with a process crash, on all 10 bounds each (160 runs, up to 116,640 states), and every program can always finish. S0 with O.seq holds on its 22 runs, `pipe-s` included.

**Each part is needed** (drop one, on `recv` and `mixr`, both faults; [results/subs.txt](results/subs.txt)):

| Part dropped | Breaks (shortest trace) | So the part is |
|---|---|---|
| W1.pw | `txn` ATOMIC 15, `txnb` OTHERS.txn 8, `txn1` OTHERS.txn 10, at `recv` and `mixr`, with a power loss and with a process crash | needed |
| W1.cm | `txn`, `txn1` OTHERS.txn 19, at `recv`, both faults. At `mixr` the caller's own commit answer is durable, which already holds the secondaries back | needed |
| W1.chk | `txn`, `txn1` OTHERS.txn 18, at `recv` and `mixr`, both faults | needed |
| W1.claim | `lockAA` OTHERS.lock 8, `lockAB` OTHERS.lock 6, at `recv` and `mixr`, both faults | needed |
| O.seq | `pipe` ORDER 7, `pipe-t` ORDER 6, both maps, both faults | needed |
| Y | `ryw` RYW 5, both maps, both faults | needed |

**E-17's greedy ablation** (drop each rule in turn, keep it if a break comes back, then check each one left is needed; on `recv` and `mixr`, every bound, both faults; [results/greedy.txt](results/greedy.txt)). R3 is E-47's epoch after a power loss, offered as a candidate to see whether it can stand in for W1.

| Order | Ends at | Final check |
|---|---|---|
| R3, W1, O.seq, Y | {W1, O.seq, Y} | W1 needed (`txn` ATOMIC 13), O.seq needed (`pipe` ORDER 7), Y needed (`ryw` RYW 5) |
| Y, O.seq, W1, R3 | {W1, O.seq, Y} | the same |
| R3's four parts, then W1's four parts, O.seq, Y | {W1.pw, W1.cm, W1.chk, W1.claim, O.seq, Y} | every part needed: W1.pw (`txn` ATOMIC 15), W1.cm (`txn` OTHERS.txn 19), W1.chk (`txn` OTHERS.txn 18), W1.claim (`lockAA` OTHERS.lock 8), O.seq (`pipe` ORDER 7), Y (`ryw` RYW 5) |

- R3 is dropped in every order, part by part.
- **R3 cannot stand in for W1.** R3+O.seq+Y breaks on `txn` (ATOMIC 13), `txnb` (OTHERS.txn 8), `lockAB` (OTHERS.lock 6), and on the process-crash bounds, where no epoch is ever taken. The ATOMIC break needs no fault, so no recovery rule can reach it.
- A fourth order (W1's parts before R3's) was left out to save CPU. Its end is fixed by step `subs`: every W1 part also breaks on a process-crash bound, where R3 never fires (reasoned from those runs).

So **S1 needs no rule on the servers' Raft or recovery, and none from E-47.** It needs W1's four guards in the client library, O.seq for any writer that sends a write before the one before is durable, and Y if a caller expects to read its own early-answered write. O.seq is needed by `persisted` too once a client pipelines (section 2, S0 rows); it is A-10's issue order, owed by every row ([E-45] F4). W1 and Y are new with S1.

### 6. S2, S3 and S4 with rules (step `s2`)

[results/s2.txt](results/s2.txt), on stage maps `mem`, `disk` (S4) and `e1` (S3), both faults:

| Rule set | Holds? (shortest break, over `mem`, `disk`, `e1`, 20 bounds each) |
|---|---|
| W1 (the library waits for the disk: (e1)'s rule for transactions, claims and fenced writes) | no: `txn` ATOMIC 21, `txn1` ATOMIC 22, `dedup` OTHERS.read 11, `pipe` OTHERS.read 5, `pipe-t` ORDER 5 |
| W1+O.seq+Y | no: the same reader breaks |
| W1+RD.txn+O.seq+Y (also: readers of transaction keys read the disk prefix) | no: only plain reads break (`pipe`, `pipe-t` OTHERS.read 5) |
| **W1+RD+O.seq+Y** (every reader reads the disk prefix) | **yes**: 60 runs, up to 106,745 states, nothing stuck |
| R2+O.seq+Y (E-47's refusal applied to every write: no transaction, claim or fenced write at all) | no: plain reads (OTHERS.read 5) |
| R1s+R3+R2.claim+O.seq+Y (E-47's rich set) | no: `dedup` OTHERS.read 10, `txn1` OTHERS.read 17, plain reads 5 |
| R1s+R3+R2.claim+RD.plain+O.seq+Y | no: `dedup` OTHERS.read 10, `txn1` OTHERS.read 17 |

Each part of W1+RD+O.seq+Y dropped, on `mem`, where every part acts:

| Part dropped | Breaks | So the part is |
|---|---|---|
| W1.pw | `txn` ATOMIC 16, `txnb` OTHERS.txn 9, `txn1` OTHERS.txn 10; with a process crash only, `txnb-c` ATOMIC 11 | needed |
| W1.cm | `txn`, `txn1` OTHERS.txn 19 | needed |
| W1.chk | `txn` OTHERS.txn 17, `txn1` OTHERS.txn 18 | needed |
| W1.claim | `lockAA` OTHERS.lock 8, `lockAB` OTHERS.lock 7 | needed |
| RD.txn | `txn` ATOMIC 21, `txn1` ATOMIC 22, `dedup` OTHERS.read 11 | needed |
| RD.plain | `pipe`, `pipe-t` OTHERS.read 5 | needed |
| O.seq | `pipe` ORDER 7, `pipe-t` ORDER 5 | needed |
| Y | `ryw` RYW 4: once reads come from the disk prefix, a write answered from memory is not yet visible to its own writer | needed |

- **E-47's epoch cannot close S2's gap.** R3.read restarts a snapshot that straddles a power loss, but a reader that finished its snapshot before the loss has still seen a commit that is then lost (OTHERS.read 10 on `dedup`: T's commit of x is committed in memory, the reader reads it, two copies lose power). Under form A that read is in the `memory` rung's contract (E-47's READBACK and LOST, allowed); under S2 every resource would carry that contract.
- **So S2 holds only once every reader reads the disk prefix, which is S1's visibility.** What is left of S2 is its commit in memory, which needs the `memory` rung's Raft rules on every group (section 1E) and buys nothing a reader can see. S2 with its rules is S1 plus those Raft rules (reasoned from the two rule sets).
- **MEMORY's (e1) (S3) needs RD.txn**: a reader of a transaction's keys must read only what is on disk. That is the reader rule MEMORY 6.1 item 8 asked for, now model-checked. Its plain writes then stay visible from memory, under the `memory` rung's contract for every resource.

### 7. Larger bounds (step `verify`)

[results/verify.txt](results/verify.txt), state limit 6 million:

| Rule set | Config | `txn1-2r` | `dedup-v` | `lockAA-v` | `lockAB-v` | `pipe3` |
|---|---|---|---|---|---|---|
| O.seq | S0 | ok (405,372) | ok (743,220) | ok (14,930) | ok (5,838) | ok (3,402) |
| W1+O.seq+Y | S1 `recv` | ok (454,446) | ok (864,634) | ok (28,412) | ok (6,146) | ok (13,671) |
| W1+O.seq+Y | S1 `mixr` | ok (405,372) | ok (743,220) | ok (15,382) | ok (6,146) | ok (13,671) |
| no rules | S1 `recv` | OTHERS.txn 10 | ok (1,279,361) | OTHERS.lock 8 | OTHERS.lock 6 | ORDER 7 |

`pipe3` has three writes and a read, with both a power loss and a process crash in one run. Every run is complete. With W1 the `mixr` runs explore exactly as many states as S0 on the transaction bounds (405,372 and 743,220): with the library waiting for the disk, a transaction under `mixr` is S0.

## What each form costs and buys (reasoned unless marked)

### S1 against `persisted` alone

**What S1 adds.**
- **Nothing in Raft's rules** (checked by brute force, section 1). Commit, elections and recovery stay `persisted`'s: no operator step after a power loss, no "come back as new", no epoch, no refusal on any resource. Its messages and the leader's marks do change (the next bullets), and the leader counts its own copy toward `replicated` only once it has handed the entry to the operating system: the model's process crash keeps the leader's whole log, which assumes this (reasoned).
- **A memory report from each follower**, so the leader knows when two copies hold an entry. It feeds answers only. In etcd's Raft a follower answers an append once it is persisted (from memory, not checked), so this is a second, earlier report: a new message or a new field.
- **W1, four guards in the client library and no server state.** The coordinator's commit waits for durable prewrites; the secondaries wait for a durable primary commit; a reader's resolve waits for a durable check; a protected write waits for a durable claim. With W1 a transaction, a lock or a fenced write runs exactly as under `persisted`; only the caller's last answer may come early.
- **O.seq**, a per-writer sequence that each range checks. TiKV's shape has no such state today: its exactly-once comes from transaction ids (E-47's README); COMP2's client sessions (D `sess`) carry one (API.md; reasoned). Every row owes it anyway as AMENDMENTS A-10's issue order ([E-45] F4), so it is not S1's own cost.
- **Y**, a read with a floor: the early answer carries the write's log index, and the read waits until the commit point passes it, as Raft's ReadIndex waits for the applied index.
- **Judging over the leader's not-yet-committed log ("spec")**, if early answers are to carry results, or if a stream of writes to one key is to go faster. TiKV lets one command per key run at a time (latches); if a latch is held until the command is applied, the next write to that key waits for the disk whatever stage the caller picked (from memory, not checked). Spec judging is sound for every counted property here (with W1, model-checked), but its results are tentative (section 4).
- **A contract for each early stage**, which callers must learn:
  - `received`: lost on any leader change, with no power loss (section 1: 23,774 outcomes at 4 entries).
  - `replicated`: survives a process crash, not one power loss (26,536 outcomes). "All three copies hold it" survives one power loss, at the slowest copy's speed.
  - A result in an early answer may change: an "aborted" may become a commit; a grant's token may change. Under blind, early answers carry no result at all.
  - Read-your-writes holds only with Y; a pipelined next write is refused `gap` if an earlier one was lost (O.seq).
  - A resent copy is judged again, so on fero's API (not in this model) it can be refused after an early answer; and the write is lost for good if its client stops or its session lapses first (reasoned; MEMORY 9.4).

**What S1 buys.**
- **The caller's own wait, and only that.** `replicated` resolves where E-02's `memory` rung acks: p50 0.24 ms and p99 0.57 ms in TypeScript, 0.16 and 0.33 in Rust, against `persisted`'s 0.85 / 4.33 and 0.62 / 1.58 with the three copies on one shared disk, and 0.56 / 2.40 and 0.38 / 0.67 with emulated disks, one per copy, at 50,000 writes a second (measured in E-02; that the two points match is reasoned). So at p99 the gain is about 7.6 and 4.8 times on one shared disk, but 4.2 and 2.0 times with a disk per copy. `received` resolves sooner still, after one hop to the leader (not measured).
  - A caveat from E-02's design: its journal holds a write that arrives during an fsync until the next round. So `replicated` reaches the `memory` rung's speed only if each copy writes new batches to the operating system while a sync is running (reasoned).
- **Nothing for anyone else.** Readers, subscribers, other ranges and the next write to the same key still wait for the disk. The servers do the same work: the same fsyncs, so none of the third less CPU per write E-02 measured for the `memory` rung, and the same top speed as `persisted`. A disk stall (E-01: 22-52 ms every 30-60 s, 0.25-0.9 s behind a bulk writer; measured) no longer holds up an early answer, but it still holds up what everyone else sees and every durable answer.
- **A transaction saves only its last wait.** With W1 its prewrites wait for the disk; only its outcome may be answered early.
- **Per call.** One resource can take "fast, may vanish" writes and durable writes side by side; transactions, locks and fenced writes work on every resource.

### S1 against A (MEMORY's `memory` per resource)

| | A: `memory` per resource, {R2} and MEMORY's rules 4 to 15 | S1: a stage per call, W1 + O.seq + Y |
|---|---|---|
| Who may be told something that later vanishes | the caller, and every reader and subscriber of the resource | the caller only (model-checked: no OTHERS break with the rules) |
| Raft and recovery | commit in memory; come back as new; the operator's recovery after a majority power loss (rule 15); incarnation and generation raises (rules 11, 12); split and merge entries wait for disk (13) | unchanged from `persisted` (checked by brute force) |
| Transactions, locks, fenced writes | refused on the resource (`needs-persisted`) | allowed; they run at `persisted` inside (W1) |
| Exactly once for plain writes | lost unless the write carries an id (MEMORY 3.3) | as `persisted`: transaction ids (D `txn`) or caller keys make a resend apply once; order needs O.seq, A-10's issue order, under S0 as well (section 2) |
| The caller's wait | the `memory` rung's ack (E-02: 3.5 to 7.6 times lower than `persisted`, TypeScript, measured) | the same at `replicated` (reasoned); lower at `received` |
| What others see | the write, at once, before any disk has it | the write once it is on disk at two copies |
| CPU per write, top speed | about a third less CPU, a higher ceiling on growing files (E-02, measured) | as `persisted` |
| One power loss | loses nothing (come back as new; section 1E) | can lose a `replicated` answer (section 1C), or nothing with "all three copies" |
| A majority power loss | the operator restarts the group; up to about 1 s of answered writes lost | nothing committed is lost; early answers may be |
| Interacting pairs (rule 3) | 253 to 267 against 233 (MEMORY, computed) | 233 to 241 against 233 (MEMORY 9.2, computed) |

**The benchmark lines** (MEMORY 2.2's seven lines; reasoned).
- JetStream (lines 5 and 6) acks once a majority holds a write in the page cache. That matches `replicated`, which answers at the same point as the `memory` rung. But a JetStream ack carries the message's stream sequence, which E-45's gateway makes from the committed version, and an early answer has none. So S1 stands where A stands (one client likely lost in TypeScript and open native; 16 clients likely won) only if an answer stage counts as a rung and an early ack may carry a sequence number that a lost write would change. Otherwise S1 scores as `persisted` there (reasoned; MEMORY 9.3).
- Kafka's top speed (line 7) is the servers' throughput, which S1 leaves at `persisted`'s: likely lost in TypeScript, open and thin native. A does better there.
- Redis (lines 1 to 4) answers once one server holds a write in memory, which matches `received`. They are closed-loop lines, open under every form until the shape is timed.

### S2, S3 and S4

- S2 commits in memory, so it needs the `memory` rung's Raft rules (section 1E) and its recovery, on every group, not only on chosen resources.
- Even when every caller waits for the disk (S4), readers act on writes that are not on disk yet (section 2). MEMORY's (e1) (S3) has the same gap, now model-checked.
- With W1+RD+O.seq+Y it holds (section 6). But RD puts every read on the disk prefix, so S2 with its rules shows readers exactly what S1 shows them. Only its in-memory commit is left, and that buys no reader anything while it costs the `memory` rung's Raft rules on every group. S1 dominates S2 and S4.
- S3, MEMORY's (e1), needs RD.txn for its transactions (model-checked). Its plain writes stay visible from memory, so every resource carries the `memory` rung's contract for plain writes.

### Where the study's ruling stands

- **What was ruled out was a commit level per write**, not an answer stage per call. AMENDMENTS footnote 13's reason is that G `pslot` puts many resources' slots in one Raft group, and one group has one commit point. S1 never moves any group's commit point: every group still commits on disk. So the footnote's reason does not reach S1, on TiKV's shape or on COMP2's (reasoned).
- **RR-11's per-write closer** ("commit a saga unit's steps on a `memory` resource at `persisted`") is S2-shaped. Section 2 shows that shape still breaks through readers.
- **API.md's `@ts-expect-error` case** (`{ durability: 'memory' }` on one write) stays right for a commit level. A stage per call would be a different thing; API.md has none. MEMORY 9.6 proposes a handle whose stages you await, not an option key such as `{ ack: 'replicated' }`.
- **Precedents** (from memory here; MEMORY 9.5 cites the sources it read):
  - Kafka's producer `acks` (0, 1 or `all`), with consumers reading only up to the committed offset, is S1's shape.
  - MongoDB's write concern (`w: 1`, `majority`, `j: true`) is S1's shape with read concern `majority` and S2's with `local`.
  - PostgreSQL's per-transaction `synchronous_commit`: with a synchronous standby, `on`, `remote_write` and `remote_apply` keep the commit invisible on the primary until the standby confirms (S1-like), except when the wait is cancelled and the commit stands locally; `off` (shown before its own flush) and `local` (shown before the standby has it) are S2-like (cited: xact.c's `RecordTransactionCommit`, syncrep.c, config.sgml; links in MEMORY 9.8).
  - v4's `confirm` ladder (`replicated`, `persisted`, from the watermark ladder) answered per write (cited: kernel/confirm.ts).

## What the model leaves out

- **One fault per run, on group A only.** A process crash and then a power loss, or two power losses, are not modelled. raftcheck48 covers every single fault and every power loss of two or three copies.
- **Elections are any Raft allows.** Pre-vote and check-quorum would remove some (section 1C).
- **TiKV's real scheduler.** "spec" is judging in log order at the leader; TiKV's latches, async commit, one-phase commit and pessimistic locks are left out.
- **Change feeds and subscribers.** OTHERS.read stands in for them: a subscriber that folds a record is a reader that keeps it.
- **Leader leases for reads, follower reads, splits, merges, range moves.**
- **Answers arrive at once** when they are in at their stage; a lost answer is covered only by resends.
- **Plain writes** are one writer, one key, two or three writes, with no conditions or `incr`, and they can never be refused. Their results (RESULT) were shown on claims and transaction outcomes; that a condition's "ok" or an `incr`'s value behaves the same is reasoned. A plain write that is refused on resend (a field write whose row was removed, a `rules.write` that reads the row) is not modelled.
- **How a plain write rides TiKV's shape.** Here it is one blind append with no id. On TiKV-persisted it would carry a transaction id (D `txn`): one kernel command, in effect a one-key transaction committed in one phase, or a full prewrite and commit. That choice decides where `received` is taken and whether W1.pw covers plain writes; it is stated in MEMORY 9.4 and not modelled.
- **Small bounds; one agent.** No DEV-10 guard-by-guard count and no mutants.
- **No timing.** Every latency above is E-02's or E-01's, reasoned onto the stages. The pair count for S1 (rule 3) is computed in MEMORY 9.2, not here.

## How to rerun

```sh
./run.sh                 # everything, in order (about 80 minutes of CPU on one core)
./run.sh raft            # the brute-force check of the Raft step (about 10 s)
./run.sh base crash info # no rules; a process crash only; what early answers allow
./run.sh rules subs greedy s2 verify
HEAVY= ./run.sh base     # without the study's lock wrapper (run.sh also falls back by itself when it is missing)
python3 ../E16-controller-loop/engine/cli.py models/ackstage.py S1-recv --bound txnb        # one run, with its trace
python3 ../E16-controller-loop/engine/cli.py models/ackstage.py S1-recv-W1 --bound txn1 --drop W1.chk
```

The cache, [results/runs.json](results/runs.json), keys each run by a hash of `models/ackstage.py` and the bound's settings, so a changed model runs afresh. Steps may run side by side: each save merges into the cache under a lock. If a step fails for any reason other than its 28-minute limit, `run.sh` prints the exit status and stops without rebuilding `results/summary.md`.

## Files

- [models/ackstage.py](models/ackstage.py): the model (world, Percolator state machine, programs, stages, rules, properties, bounds). Copied from E-47's `memrung.py` and changed.
- [run48.py](run48.py): every run, cached in [results/runs.json](results/runs.json), text with traces in `results/<step>.txt`. [report48.py](report48.py): [results/summary.md](results/summary.md) from the cache.
- [tools/raftcheck48.py](tools/raftcheck48.py): the brute-force check of the Raft step with memory and disk reports. [run.sh](run.sh): every step. [fetch.sh](fetch.sh): checks the engine is there (nothing is downloaded).

**Q-48.** Answers per operation over a fixed `persisted` commit (S1: received, replicated or committed, picked per call) were never ruled out. AMENDMENTS footnote 13 ruled out a commit level per write, and its reason, one commit point per shared group, does not reach S1.
- On TiKV's shape S1 changes nothing in Raft (checked by brute force).
- It needs three rules in the client library, each needed (model-checked): W1 (the library's own protocol steps wait for durable answers; without it a snapshot misses half a transaction even with no fault), O.seq (a writer's sequence: A-10's issue order, which `persisted` needs too once a client pipelines) and Y (read-your-writes).
- An early answer can vanish: `received` on any leader change, `replicated` on one power loss (unless it means all three copies). If it carries a result, the result can change: an early "aborted" became a commit. On fero's API a resent plain write is judged again and can be refused (reasoned).
- S1 buys only the caller's own wait. What readers see, CPU per write, top speed and disk stalls stay as `persisted` (reasoned).
- S2 (commit in memory, a level per write), S3 (MEMORY's (e1)) and S4 (await disk on a memory resource) break through readers even when the writer waits for disk. S2 holds only once every reader reads the disk prefix, and then it is S1 plus the `memory` rung's Raft rules.

Moves: S1 joins MEMORY's forms, and MEMORY's revised section 0 ranks it above (a): second after `persisted`, with (a) third, only for a need S1 cannot meet. It needs no change to Raft's commit, election or recovery rules and no refusal of any kind of write, costs 233 to 241 pairs against (a)'s 253 to 267 (MEMORY 9.2, computed), and rests on W1 + O.seq + Y (model-checked at these bounds, one agent), with an early answer that only its own caller can be misled by. It matches (a) on the JetStream lines only under two rulings (an answer stage counts as a rung, and an early ack may carry a provisional sequence), and not on CPU, top speed or what readers see (reasoned). Footnote 13, API.md Q-A9 and VERDICT's P-15 row rule out commit levels per write only, so S1 is open to COMP2 too (reasoned). (e1)'s hand-replayed gap is confirmed by model (ATOMIC 21 and 22), and RD.txn closes it. S2 and S4 are dominated by S1. A `replicated` stage must be specified as surviving process crashes, not one power loss, or defined as all three copies. E-47's epoch (R3) is not needed for S1 and cannot replace W1.

[E-01]: ../E01-floors/README.md
[E-02]: ../E02-pipeline/README.md
[E-45]: ../E45-drivers/README.md
[E-47]: ../E47-memory-rung/README.md
