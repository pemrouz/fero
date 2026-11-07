# slot: fixed slots, groups that own slot sets, one move protocol

**What it is.** Each resource has a fixed number of slots (1,024 in the draft). A partition sits in one slot for ever. Groups own sets of slots and come and go with load. One protocol moves a slot from group A to group B: fence, copy, open (SPACE P `slot`; DESIGN-V5 §4.2 "Moving a slot"; V5-UNITS option 4; Redis Cluster's IMPORTING, Couchbase's vBuckets). A position is `(slot, sequence)` (SPACE O `slot`), so a cursor means the same thing wherever the slot lives.

**The model:** [model.py](model.py). In the harness, p is in slot `s` and q in slot `t`. A bound's layouts become moves of p's slot: `grow` moves s from G0 to G1, `shrink` from G1 to G0, `twice` there and back.

It models the protocol of DESIGN-V5 §4.2 as revised after the slot-move spike, with its crash-only part only:
- **step 0:** A commits `exporting(s, to B)`; the move is named by that entry's position in A's log; one move of a slot at a time;
- **step 1:** B commits `importing`, copies s once while A takes writes, and commits the copy (its ready report);
- **step 2:** on B's ready report, A commits `fenced(s, N)`, N being s's last sequence in A's log (its end, not its commit); from the moment the fence is in A's log, A takes no write to s;
- **after the fence commits:** B takes the delta, `END(N)` and the carried state (rows and records, dedup outcomes, the highest lock token, the sequence) and commits them;
- **step 3:** B commits `open(s, N)` and serves s once it commits;
- **cancelling:** before its fence, A may cancel and B drops its copy. After the fence, only B may give up (`abort`, only while its log has no `open`), and A reopens with `unfenced` on B's committed abort. If B aborts before A fences, A cancels;
- **the two kinds of rule:** a step that waits for an entry reads committed entries; a guard that forbids reads the whole log.

**Left out, on purpose:**
- **The slot table in `#meta`.** In this harness a client's copy may reach any group (a stale route), so routing needs no table. No E-17 property depends on it. slot_move.py shows the table matters after an unclean recovery (its fixes 2 and 3).
- **Incarnations and epochs.** They exist for unclean recovery, which this harness does not have (HARNESS.md, "Why there is no message set"). slot_move.py checks them, and found five rules needed there.
- **The ready position and the delta.** B's copy after the fence is a full copy of the slot, not the delta since its ready position. This is the same state at the end. The ready position only makes the unwritable window short.

**Results** (model-checked; [../../results/slot-ablation.json](../../results/slot-ablation.json); every rule with its trace in [../../results/summary.md](../../results/summary.md)):
- **26 of the 69 rules are necessary**: fixN's 13-rule client path, plus 13 for the move.
- **The 13, by what breaks without them:**
  - one writer: A takes no write once its fence is in its log; B takes `END(N)` only from a committed fence;
  - rows: carry the rows and records; take `END(N)` once; export only a slot you hold;
  - dedup transfer: carry the outcomes;
  - fence transfer: carry the highest token;
  - positions: carry the sequence;
  - progress: the five appends of `exporting`, the fence, the final copy, its `END(N)` marker and `open`.
- **Not needed by any property** under crash-only faults:
  - B's `importing` entry, the bulk copy and the ready report: they only shorten the unwritable window;
  - N in the fence: the carried sequence does that job;
  - every guard of the give-up path, because nothing has to give up when a group always gets a new leader.
- **Mutants:** 35 of 46 are caught. The other 11 are equivalent: each swaps two field updates of one entry. None survived.
- **The give-up path, priced** (`+giveup`): GU_SLOT_DETAIL
