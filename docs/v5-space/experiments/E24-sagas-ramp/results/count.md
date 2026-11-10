## fullundo: 41 rules kept, by mechanism

Kept without a counterexample (their removal stops at the state limit): `claim.free`, `backoff.blocked`, `giveup.lost`. Needed with a counterexample: 38.

| mechanism | rules kept | precedent |
|---|---|---|
| lock with lease and fencing token | 5: `claim.seq`, `claim.free`, `claim.lock`, `claim.tok`, `claim.pc` | Chubby sequencers (Burrows, OSDI 2006); etcd lease + revision; Kleppmann 2016 "fencing tokens" |
| saga log: intent row, forward and backward recovery, program order | 19: `begin.absent`, `begin.intent`, `adopt.seq`, `adopt.unfin`, `adopt.tgt`, `adopt.pc`, `step.seq`, `step.data`, `step.pc`, `fail.seq`, `fail.pc`, `decide.seq`, `decide.intent`, `undo.seq`, `undo.data`, `undo.pc`, `close.seq`, `close.intent`, `close.pc` | Garcia-Molina and Salem, SIGMOD 1987 (the saga log; backward recovery by compensation; forward recovery) |
| locks owned by the unit; resolve an unfinished unit first | 7: `begin.noother`, `other.seq`, `other.unfin`, `other.tgt`, `other.pc`, `backoff.blocked`, `backoff.release` | Percolator (Peng and Dabek, OSDI 2010): a transaction that meets a dead one's lock rolls it forward or back first |
| per-partition fence table | 2: `step.fence`, `undo.raise` | Chubby: the resource server checks the sequencer |
| fenced writes to the intent row | 4: `decide.holds0`, `decide.holdsN`, `close.holds0`, `close.holdsN` | Chubby sequencer checked by the resource (here #sagas in M) |
| the ender writes every partition (undo every step) | 1: `decide.pc` | NOVEL (strict count): no published saga undoes steps that never ran. Nearest precedent: Kafka KIP-98 (end markers go to every partition of the transaction) with KIP-890 (the epoch rises at every end) |
| a holder refused by a fence stops and retries | 3: `giveup.lost`, `giveup.release`, `giveup.pc` | Kleppmann 2016 (a client whose token is refused must stop); the app retry of saga(steps, { id }) |

Novel by this count: 1 mechanisms, 1 rules.

## ramp: 19 rules kept, by mechanism

| mechanism | rules kept | precedent |
|---|---|---|
| RAMP-Fast: prepare, commit markers after all prepares, lastCommit max, two-round reads | 14: `prepare.vers`, `prepare.ack`, `commit.allprep`, `commit.newer`, `commit.last`, `r1.unread`, `r1.get`, `plan.all`, `plan.plan`, `r2.stage`, `r2.get`, `finish.stage`, `finish.complete`, `finish.next` | RAMP-Fast (Bailis et al., SIGMOD 2014) |
| monotonic reads (fero's read rule, API.md "Reads") | 2: `r1.mono`, `finish.seen` | existing fero rule, not RAMP's |
| commit on fetch | 1: `r2.last` | NOVEL here |
| a slot move carries the slot's fold | 2: `move.pending`, `move.last` | E-15 and DESIGN-V5 4.2's carried state (one more field) |

Novel by this count: 1 mechanisms, 1 rules.

