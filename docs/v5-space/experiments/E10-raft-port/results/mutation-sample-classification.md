# Hand classification of 40 surviving mutants

After run 2 (the 41 datadriven files, the 1,000-script fuzz of seed 2, and the 1,000-script read-index fuzz of seed 5), 365 of 1,147 mutants survived: 127 swaps and 238 others. (Run 3 later killed 10 of the 238; see the tally.) The swaps were classified by script ([diff/classify_swaps.py](../diff/classify_swaps.py)): 122 swap two updates that neither reads the other's target, so they cannot change anything (equivalent). The 238 others were sampled: `random.seed(10); random.sample(survivors, 40)` over the non-swap survivor lines of [mutation-run2-survivors-vs-readindex-fuzz.txt](mutation-run2-survivors-vs-readindex-fuzz.txt). Each was read by hand (reasoned).

Classes:
- **E, equivalent:** the mutant cannot change behaviour in any state the code can reach (a field default that the constructor overwrites, a panic message's text, a check that is already implied, a function nothing calls).
- **U, unexercised feature:** the change matters only under a setting or API the oracle never uses: the uncommitted-size limit, byte limits on in-flight messages and message size, `Bootstrap`, `CreateSnapshot`, a restart from a saved HardState.
- **G, gap:** a real change in a feature the oracle does exercise, which it fails to notice.

| # | Mutant | Class | Why |
|---|---|---|---|
| 1 | log.ts:21 drop `applyingEntsPaused = false` (field default) | E | undefined is falsy; every reader treats it as false |
| 2 | log.ts:223 guard: drop `at.term !== 0` in maybeCommit | E | a leader's term is never 0 |
| 3 | log.ts:266 `>` to `>=` (size check when one unstable entry) | U | only with a finite size limit at exact equality |
| 4 | log.ts:280 `if (!err)` to `if (true)` in zeroTermOnOutOfBounds | E | on the two expected errors t is already 0 |
| 5 | log_unstable.ts:10 drop `offset = 0` (field default) | E | the constructor sets it |
| 6 | log_unstable.ts:34 guard: drop the snapshot-index check in maybeTerm | G | an index below a pending unstable snapshot would get the snapshot's term |
| 7 | log_unstable.ts:97 drop `snapshotInProgress = false` in restore | G | a snapshot restored while another is in flight keeps the flag |
| 8 | log_unstable.ts:123 flip inside a panic message string | E | text of a panic that never fires |
| 9 | quorum.ts:110 `size > 0` to `size >= 0` in jointString | E | an empty, non-null outgoing config never occurs |
| 10 | raft.ts:56 drop `ID = 0` (Config default) | E | always set |
| 11 | raft.ts:61 drop `AsyncStorageWrites = false` (Config default) | E | undefined is falsy |
| 12 | raft.ts:85 always set MaxUncommittedEntriesSize to no limit | U | the limit is never configured |
| 13 | raft.ts:117 drop `uncommittedSize = 0` (field default) | E | reset() sets it before use |
| 14 | raft.ts:141 drop `this.maxMsgSize = c.MaxSizePerMsg` | U | the harness never limits message size |
| 15 | raft.ts:159 `Applied > 0` to `>= 0` | E | appliedTo(0) is a no-op on an empty log |
| 16 | raft.ts:166 invert hasLeader() | E | nothing calls it (node.go did) |
| 17 | raft.ts:311 drop `uncommittedSize = 0` in reset | U | uncommitted-size limit |
| 18 | raft.ts:383 drop setting tick in becomePreCandidate | E | the previous state already ticks elections |
| 19 | raft.ts:536 `length > 0` to `>= 0` for MsgStorageApplyResp | E | those messages always carry entries |
| 20 | raft.ts:691 drop `leadTransferee !== 0` | E | aborting sets it to 0 anyway |
| 21 | raft.ts:696 `<` to `<=` in loadState's range check | G | a restart whose saved commit equals the snapshot index; run 3's restart fuzz restarts nodes but never hits this edge (it was U before restarts were added) |
| 22 | raft.ts:734 `> 0` to `>= 0` in increaseUncommittedSize | U | uncommitted-size limit |
| 23 | raft.ts:734 guard dropped in increaseUncommittedSize | U | uncommitted-size limit |
| 24 | raft.ts:740 guard in reduceUncommittedSize | U | uncommitted-size limit |
| 25 | raft.ts:748 `<` to `<=` in bytesEqual's loop | E | both reads past the end are undefined |
| 26 | rawnode.ts:100 always queue an apply response | E | an empty apply response is a no-op |
| 27 | rawnode.ts:118 drop IsEmptyHardState in HasReady | E | the hard state never returns to empty |
| 28 | rawnode.ts:171 Bootstrap always refuses | U | Bootstrap is not used by the oracle |
| 29 | read_only.ts:50 `< 8` to `<= 8` | E | the ninth write to an 8-byte array is ignored |
| 30 | storage.ts:88 drop EnsureSnapshot in ApplySnapshot | E | every snapshot passed in is already complete |
| 31 | storage.ts:100 `>` to `>=` in CreateSnapshot | U | CreateSnapshot is not used by the oracle |
| 32 | storage.ts:103 drop setting the term in CreateSnapshot | U | same |
| 33 | storage.ts:111 `<=` to `<` in Compact | G | compacting at exactly the first index is not refused |
| 34 | tracker.ts:16 drop `count = 0` (Inflights default) | E | reset() runs before the first Add |
| 35 | tracker.ts:63 drop `this.bytes -= bytes` in FreeLE | U | byte limits on in-flight messages |
| 36 | tracker.ts:94 drop `PendingSnapshot = 0` (Progress default) | E | every reader treats undefined as 0 |
| 37 | tracker.ts:173 drop the sentCommit update in MaybeDecrTo (probe path) | G | commit-index re-sending after a rejected probe |
| 38 | tracker.ts:213 drop `AutoLeave = false` (Config default) | E | undefined is falsy |
| 39 | tracker.ts:257 drop `this.MaxInflightBytes = maxBytes` | U | byte limits on in-flight messages |
| 40 | tracker.ts:266 drop `p.Votes = this.Votes` in shallow() | E | confchange never reads Votes |

**Tally after run 3:** E 23, U 12, G 5 (of 40). Run 3 (the restart fuzz) then killed 10 more non-swap survivors, none of them in this sample, leaving 228. Scaled to those 228: about 131 equivalent, 68 unexercised, 29 real gaps (the 95% interval for 5 of 40 is about 5% to 26%, so roughly 12 to 60 gaps).
