# Simplicity: the study's rows re-ranked by every rule

2026-11-12. The owner set the study's rule 3 aside and asked for a re-rank by **simplicity**: every rule a builder must get right, borrowed or not ([DECISIONS V5-1 and V5-6](../DECISIONS.md); [VERDICT 11.7](VERDICT.md#117-the-owners-design-decisions-2026-11-12)). This page is that re-rank. Its data is [judging/simplicity.json](judging/simplicity.json) and its tool is [tools/simplicity.py](tools/simplicity.py). It changes no other study file. Updated 2026-11-14 with the models of the per-resource pieces ([E-51], [E-52]), the hand-back's pace measured on real code ([E-53]) and V5-9's three path changes, and then with a check of that update: section 8 says what they changed, and every number on the page is the new one. Words follow VERDICT's [key of terms](VERDICT.md#key-of-terms).

**How each claim is marked.**
- **Model-checked**: an experiment's model counted the rules by ablation. Drop one rule, and the checker finds a counterexample. The experiment is named.
- **Measured**: an experiment ran the design on real code with and without the rule, and without it a stated property broke in the runs. Runs, not every state. The experiment is named.
- **Counted from a spec**: rules read off a published spec, paper or design note in this pass, named.
- **Counted from code**: rules read off source code in this pass, named.
- **Reasoned**: counted from the mechanism's own text and the design records. Nothing ran it. "From memory" means a fact about an outside system nobody checked here.
- **Computed**: `tools/simplicity.py`, `tools/closure.py`, or the `repro` script of [candidates/README.md](candidates/README.md#reproduce-a-computed-claim).

## 0. The answer

1. **Where the base lands.** The owner's base has **416 rules** (computed): 413 that fero writes, and 3 credential rules that move to the operator. On the owner's frame, 24 judged rows fail no MUST. The base would be **23rd** of them. Only DRAFT (419) and SPLIT (426) have more. With dormant groups the base has 420 (24th). **DRAFT, the study's draft design, now has 3 rules more than the base, but the count cannot say which of the two is smaller.** Record by record, DRAFT runs from 25 rules fewer than the base to 24 more. With every count at its low DRAFT has fewer (314 against 318), and with every count at its high it has more (527 against 524) (computed).
2. **Answer stages are a large part of the gap. V5-9's path changes are a small one.** Answer stages are 12 rules (V5-5), and no study row priced them. Without them the base has **404** and would be **16th**, level with PD+fix, TiKV-TS and SIDE (404) (computed). Two of V5-9's three path changes are the base's alone: direct routing (1 rule) and one checksum per batch (1). Without them the base has 414 (23rd, computed). The third, a byte-rate cap on bulk work, is owed by every row (SC-08), so every row with bulk work now carries it. Without answer stages and the two, the base would have 402 (15th) (arithmetic).
3. **The rows that are in sit close together.** All 24 lie between 389 and 426 rules. Each count has a low and a high bound, and the base's own run from 318 to 524. Counted on the mechanisms that differ only, the base has **more rules than 10 of the 24 rows in at every bound**: MIN-P, MIN, MIN-TS, RUST, both SRV rows, LEAN and the three MIN-P+par rows (computed). Against the other 14 rows in, DRAFT among them, the order can go either way. BUY, V4, OBJ, ISR and LANE have fewer rules than the base at every bound, and all five fail MUSTs.
4. **Counting borrowed machinery does not push TiKV's shape down.** TiKV-persisted has 390 rules, 2nd of the rows in and 1 behind MIN-P (computed). That count includes two-phase commit (29), the timestamp oracle (10), the multi-version store (10), the LSM (23, 20 of them a library's), closed timestamps (9) and split and merge (23). Those are 104 rules that rule 3 scored as 0 novel. But the row also does without the saga's intents (30), client sessions (14), the journal (16), the dir lease (18) and slot moves with their table, numbers and policy (21): 99 rules. It also founds its cluster with one `fero init` (3), where MIN-P's family pays 6 for a conditional create (section 8). So this count does not back V5-1's rejection of TiKV's shape on its own. V5-1's other ground still stands. The uses a log gives for free show up in TiKV's shape only as open MUSTs: 121, against 97 predicted for the base. Neither rule 3 nor this count prices an open MUST.
5. **Among the rows V5-1 keeps, MIN-P (389) and MIN, MIN-TS and RUST (391) have the fewest rules.** The base without answer stages has 15 more than MIN-P. Each of the 15 comes from one of the owner's choices (computed, `diff BASE-ack MIN-P`):
   - `par` repair, +6. It meets F-22 ([E-37]).
   - The soft directory, +12 (V5-3).
   - V5-9's direct routing and checksum, +2.
   - Healing by each group's own leader, with the platform's hints kept at the leaders, 0 against `#meta`'s central loop with its own hint path (26 rules against 26). Before the per-resource models it was −2.
   - The settings, group records, version and credentials kept in each resource's own log instead of `#meta`, −5 (V5-2).
6. **What it means for V5-6.** The measure neither overturns the base nor picks it. At this grain the rows that keep the log as the truth sit within about 37 rules of each other. The count is sure that the base has more rules than 10 of the 24 rows in at every bound, MIN-P's plain family among them, and that each rule of the gap to MIN-P comes from a choice the owner made. It is not sure of the order between the base and the rows nearest it, DRAFT among them. So the choice among these rows rests on what their rules buy, as V5-1 to V5-5 argue, not on the count. The base's reasoned rules fell from 148 to 128 of its 416 (section 8).
7. **Against rule 3** (section 4). The plain MIN rows rise: MIN-P goes from 10th to 1st. The rows with the `memory` rung fall: COMP2 from 7th to 20th, TiKV-TS from 2nd to 16th. Rule 3 had counted the rung's 14 rules as one mechanism that is not novel.
8. **A skeptic checked this page** (section 6). It found three errors that each hit a whole family of rows: the controller rows got the platform's hints for free, the borrowed LSM was counted more coarsely than fero's own journal, and the base left out 3 credential rules it moved to the operator. All three are fixed here, with the skeptic's other eleven findings.
9. **The per-resource models, and a check of them** (section 8, 2026-11-14). [E-51] and [E-52] model-checked the base's seven per-resource records. At the records' grain they go from 51 rules to 53. They also found the hand-back after `settle.ms`, which no record counted: 6 rules, now in every row with leaders, the base included ([E-53] measured the one rule its cap adds). V5-9 adds 3 rules to the base, 2 of them its alone. A second skeptic then checked that update. It found that three of the models' findings hold in the study's rows too (the stored placement, the reach check and the seed mark), and that the byte-rate cap is owed by every row. All twelve of its findings are applied. So the base went from 405 to 416 and from 22nd to 23rd. MIN-P went from 381 to 389, still 1st. DRAFT went from 410 to 419: it was 5 rules above the base, and it is now 3 above.

## 1. The question and the measure

### 1.1 Why a new measure

- **Rule 3** ranks the rows still in: the fewest novel mechanisms first, then the most SHOULDs met, then the fewest interacting pairs ([VERDICT 1](VERDICT.md#1-the-question-and-the-rule)).
- **What it misses.** A borrowed mechanism counts 0 novel, and one item among the pairs, whatever its size. Two-phase commit, a timestamp oracle, and split and merge each count 0 (V5-1).
- **The owner's measure** (V5-6): every rule a builder must get right, borrowed or not. A rule fero takes from a library still has to be right, and fero still has to drive it right.

### 1.2 The grain

- **A rule counts** when a builder must write it, and dropping it or getting it wrong breaks a stated property: safety, or a stated liveness or speed bar. One guard, one state update, or one comparison that carries correctness. This is REQUIREMENTS DEV-10 (c), the test the study's models used: "a rule counts when dropping it lets TLC find a counterexample" ([REQUIREMENTS.md](REQUIREMENTS.md)).
- **Not counted:** logging, metrics, config plumbing, and choices that only change speed and cannot break a property.
- **One grain everywhere.** Each record without a model was matched to the model counts below, rule by rule ([simplicity.json](judging/simplicity.json) `about`).
- **Numbered rules, not parts.** A model may write one rule as several guards. [E-51] and [E-52] did. Their records then count one numbered rule as one rule, as the study's other records do, and give the model's finer count (DEV-10's) in their notes (section 8.1).

### 1.3 The anchors: the counts models made

These are the counts experiments made by ablation: model-checked, except E-21's, which ablated on seeded simulations, and E-53's, measured on real code. They set the grain. Where a model counted rules that belong to another record's state, the rules sit in that record (section 1.4), so the last column can be smaller than the model's count.

| Model | What it counted | Model's count | Held here |
|---|---|---|---|
| [E-14b] and [E-14c] | Raft membership on commit | 16 | `raft-config` 15. "Grow first" is written by the healer, so it sits there. |
| [E-16] | healing by each group's leader | 14 | `healing-self` 16, with [E-52]'s strong `promote.live` and its stored placement; the base's per-resource form 17 ([E-52], section 8) |
| [E-16] | the central loop on `#meta`'s leader | 18 | `controller-commands` 18 |
| [E-16] | the writer epoch on log members (RLOG) | 9 | `writer-epoch-rlog` 6, and 3 in the records that own their state |
| [E-17c] | slot moves (crash-only, no give-up), with fixN's 13 base rules | 28 | `slot-table` 3, `slot-sequence` 2, `slot-move` 13; 10 in their homes |
| [E-17c] | pslot moves | 28 | the same records |
| [E-17c] | lanes with no range move (fixN) | 13 | `lanes` 4; 9 in their homes |
| [E-17c] | re-key | 36 (35 as written, plus one) | `rekey` 24; 12 in their homes |
| [E-17c] | split and merge on a real log | 37 | `range-table` 3, `split-record` 8, `merge-record` 11, `lineage` 4; 11 in their homes |
| [E-20] | dedup window / client sessions / producer state, under forwarding | 19 / 14 / 17 | the same |
| [E-20] | caller keys as the whole dedup option | 12 | `caller-keys` 8, the call-key layer's own rules (reasoned: no row uses keys alone; the lease's lapse is `writer-time`'s) |
| [E-30] | the cursor mark beside the outputs | 5 | `srchi-marks` 5 |
| [E-21] | writer time (simulated, not model-checked) | 7 | `writer-time` 6; its fence check is `fence-tokens`' |
| [E-24] | the saga with fenced locks | 38 | `saga-intents` 30, `lock-rows` 6, `fence-tokens` 2 |
| [E-33] | the restore mark; founding by a conditional create; founding by one `fero init` | 8; 4; 3 | `restore-mark` 5 (3 in their homes); 6, with [E-51]'s two (section 8); 3 |
| [E-31] | subscribe | 26 (27 with a move's segment names) | `subscribe` 26 |
| [E-37] | disk incarnation; `par` repair | 2; 7 | 1 (its ghost rule is `raft-config`'s); 6 (its checksum check is `disk-incarnation`'s) |
| [E-51] | founding and finding a resource: genesis, settings, group records, members, the soft directory | 50 | 30 at the records' grain: `genesis-conditional-create@per-resource` 6, `meta-catalog@per-resource` 4, `meta-directory@per-resource` 6, `meta-members@per-resource` 2, `soft-directory` 12 |
| [E-52] | healing per resource, with hints, leaves, the hand-back and the re-pick | 44 of 87 written | `healing-self@per-resource` 17, `planner-hints@per-resource` 6, `meta-members@per-resource` 2, `handback` 4 of its 6; `promote.caught` in `learners`, Raft's transfer checks in `raft-leader-transfer` |
| [E-53] (measured) | the rule the hand-back's cap adds, on real Raft code | 1 in either form | `handback` rule 4 (the giver's form); the taker's form in its high |

[E-15]'s slot move with unclean recovery, cancel and abort is 31. The base moves slots crash-only with no give-up, so 28 is the anchor. `slot-move`'s high bound (21) prices a give-up path.

### 1.4 Bundles: one model, several records

- **The problem.** A model often counts rules that guard another record's state. E-17c's slot move counts the dedup guard, the fence check and five read rules. Those are also the dedup option's, `fence-tokens`' and `subscribe`'s rules. Counted in both places, a row would pay them twice.
- **The rule used.** Each rule is counted once, in the record that owns the state it guards or writes. Each bundle's record names where every one of its model's rules went. Example: the slot move's 28 are `slot-table` 3 + `slot-sequence` 2 + `slot-move` 13, plus `write.dedup` and `refuse.dedup` (the dedup option), `write.fence` (`fence-tokens`), `refuse.stale` (`writer-judging`), and the five read rules (`subscribe`).
- **One exception: the five read rules land on four.** E-17's `read.after` and `read.next` are both E-31's `gotrec.is`, so `subscribe` holds them as one rule. In a row, the slot, lanes, re-key and split bundles therefore each sum to one less than their model's count: the slot move gives 27, not 28.
- **`row_minus`.** A few records hold a rule some rows do not need. An example is a carry rule in a row whose partitions never move. The record names those rows, and the row's sum subtracts it ([simplicity.json](judging/simplicity.json), `row_minus`). Where the rules a row does not need have another basis than the record's label, the record names that basis too (`row_minus_basis`), and the tool takes them off it.

### 1.5 Records without a model

- **Counted from a spec.** The Raft core, 65 rules across eight records, from etcd's TLA+ spec and `raft.go` (etcd raft v3.7.0-rc) and the Raft paper's Figure 2. The Kafka in-sync records, from Kafka's replication TLA+ spec. The loglet records (BookKeeper's shape), from a BookKeeper TLA+ spec. Closed timestamps (9), from CockroachDB's follower-reads RFC.
- **Counted from code.** v4's kernel, 160 rules across 14 records, from [kernel/](../../kernel), `shell/runtime.ts` and `api/index.ts`. The dir lease (18: 12 from v4's lock of V4-59, 6 reasoned). The soft directory was counted here (9 from v4's [api/directory.ts](../../api/directory.ts), 3 reasoned from V5-3) until [E-51] model-checked all 12. Two-phase commit (29, as [E-47]'s model writes TiKV's steps; Percolator from memory). The timestamp oracle (10, PD's `tso.go`). Queue claims and consumer groups.
- **Reasoned.** The journal (16), the object-store tier (10), the `memory` rung (14), answer stages (12: 5 model-checked in [E-48], 7 reasoned), the version and credentials records per resource (17), the controller's hint path (3), V5-9's three path changes (3 in the base, from [PATHS 7.1](PATHS.md#71-changes-for-the-owner-to-decide)), the cap on hand-back transfers in flight (1, V5-7), and the platform records. The base's other per-resource records are model-checked now ([E-51], [E-52]). Where a study record takes a model's finding by transfer (section 8.3), the moved rules are marked reasoned. The LSM (23) and the multi-version store (10) are reasoned from memory: no experiment ran an LSM.
- **Measured.** One rule: a group with a hand-back transfer in flight does not go quiet, on real Raft code ([E-53]). Runs, not every state. The cap itself is the design's (V5-7), so it is reasoned: no run went without a cap.
- **The bought log.** `outside-log` is 110 rules: 14 of fero's glue (from [E-44]'s code) and 96 of JetStream's own. JetStream's Raft part is mapped from nats-server's `raft.go` (read in this pass). Its stream, consumer, meta and store rules are from memory.
- **Mixed records.** A record whose rules come from more than one basis splits its count by rule (`basis_split`). Its label is the larger part. The basis totals on this page are by rule.
- **Bounds.** Every record has a low and a high count beside its count, wherever the grain or the source is uncertain. An LSM, for example, runs from 10 to 30.

### 1.6 Who owns the code

- **fero**: fero writes it, ported or not.
- **library**: a library fero imports and does not write. The Raft core, `raft-config` and the hand-back's voter check (Raft's "transfer only to a voter") in the eight rows on raft-rs or Go's etcd raft (RUST, SRV, PD, EMB-V8, SIDE, SRV V=full Y=fwd, PD+fix, TiKV-persisted). 20 of the LSM's 23 rules in the four PD rows (its disk reserve is TiKV's own code, so fero's).
- **outside**: another system. JetStream's 96 rules, and the `none` rung, in BUY. In the base, the 3 credential rules that move to the operator or fero deploy's platform.
- Borrowed rules count the same as fero's own. The owner column shows who must get them right, not whether they count.

### 1.7 How a row is summed

- **The rows.** A row's mechanisms come from `tools/closure.py`: each of the 31 judged rows carries a mechanism when closure's `carries()` says so. That rule reproduces the settled lists with 0 mismatches (computed: `python3 tools/closure.py check-mech`). One record rides on another: `controller-hints` (DEP-17's hint path at a controller) is carried wherever `controller-commands` is, since closure's catalogue folds it into the controller's loop (RM-05). Two more are carried by a rule of the tool's own (`CARRIES`): `handback`, in every row with a leader or writer per group that a failover moves, and `bulk-rate-cap`, in every row with bulk work that fero writes (section 8.3).
- **The sum.** A row's rules are its mechanisms' counts, less each one's `row_minus` for that row. Low and high are summed the same way.
- **The base.** It is added in four lines. BASE is the list in [simplicity.json](judging/simplicity.json) `base`. BASE+dormant adds dormant groups. BASE-ack drops answer stages, which no study row priced. BASE-paths drops the two of V5-9's path changes that only the base carries, so the reader can see what they cost. The tool checks that the list is MIN's vector with `Z par` and `C self`, with exactly the swaps and additions section 3 lists.
- **Calibration.** Each record was counted once, in one of five counting passes; the base's new records came from a sixth. A calibration pass then took out rules counted twice across records. For the base that moved 426 to 402. Its notes are in [simplicity.json](judging/simplicity.json) `calibration`.
- **The skeptic check.** A last pass recounted the largest records from their sources and tried to break the result. Its 14 findings are all applied (section 6). For the base that moved 402 to 405. Each changed record says so in a `CHECKED:` note.
- **The per-resource models.** [E-51], [E-52] and [E-53], with V5-9's path changes and a check of that update, moved the base 405 to 416 (section 8). Each changed record says so in a `CHECKED:` note too.
- **Pairs.** A `@per-resource` record holds the same rules as its study record, give or take the ones its note names. So does `slow-leader-self` with `slow-leader-controller`. When the tool compares two rows (`diff` and the footer), such a pair cancels to the fixed difference of its counts, instead of letting each side err on its own.

## 2. The ranked table

Computed: `python3 tools/simplicity.py` (run from `docs/v5-space`).

```
Simplicity: every rule a builder must get right, borrowed or not (judging/simplicity.json). Ranked by rules (the mid
  count). # = place among all 35 lines. in = place among the 24 judged rows that fail no MUST on the frame (for a
  base line, where it would fall among them).
Rule 3 beside it, as closure.py scores it, on the frame: restated, DATA-01 loose, JetStream's default test line
  accepted as a loss. novel = novel mechanisms, S = SHOULDs met, pairs = interacting pairs, open = MUSTs left open
  (neither measure counts them), r3 = rule 3's place among the same 24 rows.

  #  in  row                      rules   low  high   fero   lib outside  mechs | novel   S pairs  open  r3
  1   -  BUY                        177   142   288     77     0     100     10 |     0   2    12    96  out: 27 MUSTs
  2   -  V4                         230   166   280    230     0       0     25 |     8   2    52    64  out: 50 MUSTs
  3   -  OBJ                        275   211   357    275     0       0     40 |     2   1   144   111  out: 7 MUSTs
  4   -  ISR                        363   267   452    363     0       0     48 |     2   1   214   117  out: 3 MUSTs
  5   -  LANE                       376   283   466    376     0       0     49 |     3   5   232    96  out: 3 MUSTs
  6   -  PD                         379   264   483    278   101       0     50 |     0   4   218   118  out: 2 MUSTs
  7   1  MIN-P                      389   297   490    389     0       0     51 |     3   5   252    97  10
  8   2  TiKV-persisted             390   274   498    289   101       0     51 |     0   5   233   121  1
  9   3  MIN                        391   299   491    391     0       0     51 |     4   5   253    97  11
  9   3  MIN-TS                     391   299   491    391     0       0     51 |     4   5   253    95  11
  9   3  RUST                       391   299   491    310    81       0     51 |     4   5   253    98  11
 12   6  SRV V=full Y=fwd           392   298   493    311    81       0     52 |     4   5   259   103  15
 13   7  SRV                        394   299   497    313    81       0     53 |     4   5   267   103  17
 14   8  LEAN                       395   301   495    395     0       0     51 |     4   5   255    97  14
 14   8  MIN-P+par                  395   303   498    395     0       0     52 |     3   6   264    96  4
 14   8  MIN-P+par V=full           395   303   498    395     0       0     52 |     3   6   264    96  4
 17  11  EMB-V8                     396   299   500    315    81       0     54 |     4   5   269   100  19
 17  11  RLOG                       396   301   498    396     0       0     53 |     4   5   268    97  18
 19  13  MIN-P+par C=cent V=full    399   305   503    399     0       0     53 |     3   6   269    97  6
 20  14  SLOG                       400   306   497    400     0       0     52 |     5   2   272   118  24
 21  15  MIN-P+m                    403   305   507    403     0       0     52 |     3   5   264    99  16
 22  16  PD+fix                     404   279   516    303   101       0     53 |     0   3   247   122  3
 22  16  TiKV-TS                    404   282   515    384    20       0     52 |     0   4   244   122  2
 22  16  SIDE                       404   305   508    323    81       0     54 |     4   5   277   100  20
 22 ~16  BASE-ack                   404   310   511    401     0       3     54 |    ~4  ~6  ~285   ~97  ~10
 26  19  COMP                       405   305   512    405     0       0     52 |     3   5   283   100  21
 27  20  COMP2                      409   311   515    409     0       0     53 |     3   6   277    99  7
 27  20  COMP2 V=full               409   311   515    409     0       0     53 |     3   6   277    99  7
 29  22  COMP+par C=cent V=full     413   313   520    413     0       0     54 |     3   6   282   100  9
 30 ~23  BASE-paths                 414   317   519    411     0       3     53 |    ~4  ~6  ~285   ~97  ~10
 31   -  CELL                       415   311   511    415     0       0     51 |     4   5   277   100  out: 5 MUSTs
 32 ~23  BASE                       416   318   524    413     0       3     55 |    ~4  ~6  ~285   ~97  ~10
 33  23  DRAFT                      419   314   527    419     0       0     54 |     5   5   309   100  23
 34 ~24  BASE+dormant               420   321   529    417     0       3     56 |    ~4  ~6  ~285   ~97  ~10
 35  24  SPLIT                      426   319   531    426     0       0     55 |     4   5   295   102  22

~ The base is no judged row. Its rule-3 numbers are those of its option vector (MIN with Z par and C self),
  predicted by closure.py with 3 guessed cells (SC-03 M, SC-10 M, F-12 M). The per-resource records, the soft
  directory, ack stages and V5-9's path changes are not among the mechanisms closure.py gives that vector. Its "in"
  and r3 are where it would fall among the judged rows in.

At the bounds, place among the rows in, with every record at its low count / mid / every record at its high count:
  BASE 24 / 23 / 23; BASE+dormant 25 / 24 / 24; BASE-ack 20 / 16 / 17; BASE-paths 24 / 23 / 22.
  Judged rows in whose place moves by more than 5 between low, mid and high: TiKV-persisted 1 / 2 / 9;
    EMB-V8 6 / 11 / 13; SLOG 19 / 14 / 7; PD+fix 2 / 16 / 21; TiKV-TS 3 / 16 / 18.

Each line less BASE, on the mechanisms that differ (shared records cancel; each record free between its own low and
  high), mid [low..high]:
  fewer rules at every bound (15): BUY -239 [-355..-57]; V4 -186 [-323..-73]; OBJ -141 [-197..-80];
    ISR -53 [-123..-2]; LANE -40 [-76..-17]; MIN-P -27 [-45..-13]; MIN -25 [-43..-12]; MIN-TS -25 [-43..-12];
    RUST -25 [-43..-12]; SRV V=full Y=fwd -24 [-49..-4]; SRV -22 [-45..-3]; LEAN -21 [-44..-5];
    MIN-P+par -21 [-37..-7]; MIN-P+par V=full -21 [-37..-7]; MIN-P+par C=cent V=full -17 [-35..-2]
  more rules at every bound (0): none
  could go either way (16): PD -37 [-135..+38]; TiKV-persisted -26 [-117..+45]; EMB-V8 -20 [-45..+0];
    RLOG -20 [-46..+1]; SLOG -16 [-58..+16]; MIN-P+m -13 [-37..+4]; PD+fix -12 [-111..+62]; TiKV-TS -12 [-109..+62];
    SIDE -12 [-40..+8]; COMP -11 [-26..+0]; COMP2 -7 [-29..+10]; COMP2 V=full -7 [-29..+10];
    COMP+par C=cent V=full -3 [-27..+15]; CELL -1 [-45..+25]; DRAFT +3 [-25..+24]; SPLIT +10 [-40..+48]

Against rule 3, among the judged rows in (r3 -> in), moving 5 or more places:
  up: SLOG 24 -> 14; SRV 17 -> 7; MIN-P 10 -> 1; SRV V=full Y=fwd 15 -> 6; EMB-V8 19 -> 11; MIN 11 -> 3;
    MIN-TS 11 -> 3; RUST 11 -> 3; RLOG 18 -> 11; LEAN 14 -> 8.
  down: TiKV-TS 2 -> 16; COMP+par C=cent V=full 9 -> 22; COMP2 7 -> 20; COMP2 V=full 7 -> 20; PD+fix 3 -> 16;
    MIN-P+par C=cent V=full 6 -> 13.

In no line: issue-order (3), timeline-merge (2). Added as A-10 and V5-4 say (issue-order on every line;
  timeline-merge on every line without a timestamp oracle (T tso)), they flip 3 pairs of lines and make or break 4
  ties; BASE then has 421 rules.
```

**How to read it.**
- **#** ranks all 35 lines by rules. **in** ranks only the 24 judged rows that fail no MUST on the owner's frame. For a base line it says where the line would fall among them.
- **low** and **high** add every record's low and high count. **fero**, **lib** and **outside** split the rules by who writes the code. **mechs** is the number of mechanisms.
- **The owner's frame** is VERDICT 11.6's: the clauses restated, DATA-01's loose reading, and JetStream's default test line accepted as a loss. With `--strict` (DATA-01's strict reading), PD+fix, TiKV-TS, TiKV-persisted and both SRV rows go out too. 19 rows are left, MIN-P is first by rules, and the base would be 18th, with only DRAFT and SPLIT above it (BASE-ack 13th) (computed).
- **Rule 3's numbers** sit right of the bar, as closure.py scores them: novel mechanisms, SHOULDs met, interacting pairs, open MUSTs, and **r3**, rule 3's place among the same 24 rows. These r3 places are `repro rank --loss`'s. A base line's numbers carry `~`. They are its option vector's, predicted by closure.py with 3 guessed cells. Closure's catalogue has no per-resource records, soft directory, answer stages or path changes, and no hand-back for any row.
- **The footer** has four parts. The base's place at the bounds. The base against every other line, with each record free between its bounds. The rows that move most against rule 3. And what the two records in no line would do (sections 4 and 6).

## 3. The base row in full

<a id="31-its-51-mechanisms"></a>
### 3.1 Its 55 mechanisms

Computed: `python3 tools/simplicity.py row BASE`. The areas are the tool's own grouping, so a row can be read by what its rules do. "Basis" is the record's label, the larger part where its rules mix bases: `handback` is 4 model-checked rules, 1 measured and 1 reasoned. The totals under the table are by rule.

| Mechanism | Rules | Low to high | Basis | What it is |
|---|---|---|---|---|
| **Raft** | **80** | **63 to 91** | | |
| `raft-term-vote` | 17 | 14 to 18 | spec | each copy's term and vote: one vote a term, and who may lead |
| `raft-config` | 15 | 14 to 16 | model-checked | membership changes, applied on commit (joint consensus) |
| `raft-log` | 10 | 8 to 12 | spec | the ordered entries, and how a follower matches the leader |
| `raft-snapshot` | 10 | 7 to 11 | spec | snapshots, and catching up from one |
| `raft-commit` | 8 | 6 to 10 | spec | the commit index |
| `raft-prevote-checkquorum` | 7 | 5 to 9 | spec | PreVote and CheckQuorum |
| `raft-leader-transfer` | 6 | 4 to 6 | spec | handing the lead to a named copy |
| `raft-readindex` | 4 | 3 to 6 | spec | reads served without a log write (ReadIndex) |
| `learners` | 3 | 2 to 3 | spec | copies that follow but do not vote (rule 3 model-checked by [E-52]) |
| **many groups** | **20** | **13 to 28** | | |
| `quiet-groups` | 7 | 5 to 8 | reasoned | an idle group stops its heartbeats |
| `handback` | 6 | 3 to 10 | model-checked | leadership goes back to each group's preferred member after `settle.ms`, a few at a time ([E-52], [E-53]); in every row with leaders |
| `link-pings` | 4 | 3 to 5 | reasoned | one ping per pair of machines, not per group |
| `slow-leader-self` | 3 | 2 to 5 | reasoned | a leader that lags hands the lead on by itself |
| **control** | **70** | **53 to 87** | | |
| `healing-self@per-resource` | 17 | 15 to 21 | model-checked | each group's leader replaces lost copies: E-16's healing with a stored placement, a check that it reached a machine, a dial and "answers now" ([E-52]) |
| `cluster-credentials@per-resource` | 12 | 6 to 12 | reasoned | the handshake's checks (9); the CA, tokens and revocations (3) move to the operator |
| `soft-directory` | 12 | 11 to 14 | model-checked | v4's `#directory` across machines: servers announce, a client looks up, then learns from the resource ([E-51]) |
| `genesis-conditional-create@per-resource` | 6 | 6 to 11 | model-checked | a resource's first open founds it: a candidate id on disk, a create-if-absent, a compare ([E-51]) |
| `meta-directory@per-resource` | 6 | 4 to 7 | model-checked | each group's record in the resource's home log, written again whenever it differs ([E-51]) |
| `planner-hints@per-resource` | 6 | 4 to 8 | model-checked | the platform's drains and hints, sent to the leaders ([E-52]) |
| `cluster-version@per-resource` | 5 | 3 to 6 | reasoned | the protocol version, in the home log |
| `meta-catalog@per-resource` | 4 | 3 to 5 | model-checked | the settings record, in the home log ([E-51]) |
| `meta-members@per-resource` | 2 | 1 to 3 | model-checked | a leaving machine says "retiring" first, and gets no new copies ([E-51], [E-52]) |
| **partitions** | **21** | **16 to 36** | | |
| `slot-move` | 13 | 11 to 21 | model-checked | export, import, fence, copy and open a slot |
| `move-policy` | 3 | 0 to 5 | reasoned | when to move a slot, and when to shrink |
| `slot-table` | 3 | 3 to 7 | model-checked | which group holds which slot |
| `slot-sequence` | 2 | 2 to 3 | model-checked | the last sequence number per slot |
| **writes** | **51** | **36 to 68** | | |
| `client-sessions` | 14 | 13 to 16 | model-checked | a retried write applies once |
| `ack-stages` | 12 | 8 to 13 | reasoned | answers at `received` or `replicated` (V5-5) |
| `caller-keys` | 8 | 7 to 12 | reasoned | idempotency keys for calls |
| `writer-judging` | 6 | 2 to 9 | reasoned | conditions, ops, claims and batches judged at the one writer |
| `srchi-marks` | 5 | 5 to 6 | model-checked | a derived output keeps the source position it read to |
| `admission-credits` | 3 | 0 to 5 | reasoned | a credit window on the client link |
| `route-forward` | 2 | 1 to 4 | reasoned | any server forwards a write to the leader |
| `route-smart` | 1 | 0 to 3 | reasoned | a linked client sends straight to its slot's leader (V5-9, PA-4); 1 less here, since the soft directory already relearns leaders |
| **time** | **6** | **6 to 8** | | |
| `writer-time` | 6 | 6 to 8 | model-checked | the leader's clock, held to the members' median |
| **transactions** | **38** | **38 to 42** | | |
| `saga-intents` | 30 | 30 to 31 | model-checked | an intent row per saga, carried on or undone |
| `lock-rows` | 6 | 6 to 8 | model-checked | locks with leases |
| `fence-tokens` | 2 | 2 to 3 | model-checked | a lock's token, checked where it writes |
| **storage** | **62** | **44 to 81** | | |
| `dir-lease` | 18 | 12 to 22 | code | one process per data folder: a lock with a lease |
| `journal` | 16 | 10 to 18 | reasoned | one journal per process, with group commit |
| `tier` | 10 | 6 to 13 | reasoned | old segments and snapshots in the object store |
| `par-repair` | 6 | 6 to 8 | model-checked | a damaged entry is fetched again from a peer |
| `restore-mark` | 5 | 5 to 6 | model-checked | epochs and sessions never go back after a restore |
| `none-rung` | 4 | 2 to 6 | reasoned | best-effort pub/sub, never written to the log |
| `disk-incarnation` | 1 | 1 to 3 | model-checked | a checksum on every entry finds damage |
| `batch-checksum` | 1 | 1 to 2 | reasoned | one native checksum per batch, with its header under it (V5-9, PA-1a) |
| `bulk-rate-cap` | 1 | 1 to 3 | reasoned | a byte-rate cap on bulk work, on the link and the disk (V5-9, PA-6); owed by every row with bulk work (SC-08) |
| **reads** | **37** | **29 to 44** | | |
| `subscribe` | 26 | 22 to 29 | model-checked | cursors; a snapshot, then the changes |
| `fold-version` | 7 | 4 to 9 | reasoned | the fold's version, as an entry in the log |
| `fold-all` | 4 | 3 to 6 | reasoned | `data` folds on every full copy |
| **platform** | **31** | **20 to 39** | | |
| `queue-claims` | 8 | 5 to 10 | code | leases and delivery counts on queue rows |
| `forks` | 7 | 4 to 9 | reasoned | a new resource from a parent's snapshot |
| `consumer-groups` | 6 | 4 to 8 | code | members, a generation and fenced cursors |
| `presence-rows` | 6 | 4 to 7 | reasoned | rows that live while a session lives |
| `input-recorder` | 4 | 3 to 5 | reasoned | records the kernel's inputs, for replay |
| **Total** | **416** | **318 to 524** | | 55 mechanisms; 413 rules written by fero, 3 by the operator |

By basis, by rule: model-checked 197, reasoned 128, spec 64, code 26, measured 1 (computed). One record's basis is looser than its label: `writer-time` says model-checked, but E-21 ablated it on seeded simulations, not on every state.

### 3.2 What the owner's decisions changed

The base starts from the closure tool's MIN row with `Z par` and `C self`. The decisions then change these records (reasoned in [simplicity.json](judging/simplicity.json) `base.decisions`; since 2026-11-14 the per-resource records are model-checked by [E-51] and [E-52], section 8; each count is in its record).

| Record | In the study's form | In the base | Why |
|---|---|---|---|
| members | `meta-members` 5 | 2 | V5-2, V5-3, [E-51], [E-52]. The joiner's record becomes the soft directory's announcement. The cluster-wide gone mark goes: each leader's own links decide gone. "Retiring first" and "no new copy on a retiring machine" stay. Leaving the directory is not needed. |
| catalogue | `meta-catalog` 6 | 4 | V5-2 (2), [E-51]. The same rules on the settings record in the resource's home log. "Create only if none exists" moves to genesis. The seed mark goes: the seed rides the home group's founding entry, beside the settings record, and a joining copy never applies one. In `#meta` the record and the seed are in two logs, so the study's form keeps its mark. |
| group records | `meta-directory` 6 | 6 | V5-2 (2), [E-51]. They move to each resource's home log, written again whenever the record differs. The soft directory cannot hold them: it keeps no log and decides nothing. |
| healing | `healing-self` 16 | 17 | V5-2 (3), [E-52]. Both forms store a placement in the group's log and follow it (1 rule here, 4 at the model's grain), because the platform's place hints need a stored target that healing follows ([E-52] section 4). The base adds a check that a pick or an add takes only a machine its own link reached (in the study's form a hint rule does that job) and a dial of a spare the directory lists. With every placement stored, it drops E-16's `promote.need`, which the study keeps for groups the ring places. |
| planner hints | `planner-hints` 7 | 6 | DEP-17 is a MUST: the platform's drains, retirements and hints land at the leaders, as in the study's `self` rows ([E-52]). The study's form keeps "add a hinted member only while the leader's links reach it"; in the base, healing's own check does that. In a controller row the same path is `controller-hints` (3). |
| founding | `genesis-conditional-create` 6 | 6 | V5-2 (5), [E-51]. Each resource's first open is its genesis: a candidate id on disk, a create-if-absent in the object store, then a compare. |
| version | `cluster-version` 5 | 5 | In each resource's home log. |
| credentials | `cluster-credentials` 12 | 12 (9 fero, 3 outside) | An open choice. The CA, join tokens and revocations move to the operator or fero deploy, and fero keeps the handshake checks. The moved rules still count. Keeping the PKI in fero is the same 12, all fero's. |
| dormant groups | `dormant-groups` 4 | 0, or 4 in BASE+dormant | Only for SC-13's 100,000 resources ([E-36]). The owner set no number yet (V5-2). |
| soft directory | none | 12 | New (V5-3). Ported from v4's `#directory`, with seeds across machines and the machine announcement healing needs. A client learns members and leaders from the resource itself, and asks the directory again when it must ([E-51]). |
| answer stages | none | 12 | New (V5-5, [E-48]). W1's four parts and Y are model-checked; the other 7 come from MEMORY 9.4. |
| path changes | none | 2 | New (V5-9, [PATHS 7.1](PATHS.md#71-changes-for-the-owner-to-decide)): direct routing as the catalogue's `route-smart` (1 here: its other rule is the soft directory's relearning), and one checksum per batch (1). The third, a byte-rate cap on bulk work (1), is owed by every row with bulk work (SC-08), so it is in both forms. |

Net: −3, −2, 0, +1, −1, 0, 0, 0, −4, +12, +12 and +2, so the decisions add 17 rules to the 399 of the same options with the study's records (arithmetic on this table). The hand-back (`handback`, 6) and the byte-rate cap (`bulk-rate-cap`, 1) are in both: every row with leaders carries the first, and every row with bulk work the second (section 8.3).

- **Kept as they were.** Only their home moves, from `#meta` to the resource's home log: the slot table, slot moves, the move policy, forwarding, the restore mark and forks. The home leader is the one mover, so the move policy needs no lease.
- **Gone with no replacement:** the central loop (`controller-commands` 18) with its hint path (`controller-hints` 3) and its slow-leader rule (3), and project groups (2). The base's vector never carried them, since its `C` is `self` and its `G` is `shard`. They are what MIN-P+par carries in their place.
- **Every write commits at `persisted`** (V5-5). The `memory` rung (14) is not in the base. It comes third, only for a timed need.
- **Presence** shares the one session registry with client sessions, so `presence-rows` counts 6, not 7, in the base and in every `sess` row.

### 3.3 Against MIN-P+par, the row the decisions start from

Computed: `python3 tools/simplicity.py diff BASE MIN-P+par`.

```
BASE: 416 rules (55 mechanisms). MIN-P+par: 395 rules (52 mechanisms).
BASE less MIN-P+par: +21, and +7 to +37 at the low and high counts of the mechanisms that differ.

Only in BASE (6 mechanisms, 49 rules, low 39, high 61):
    17  model-checked  fero                   healing-self@per-resource
    12  reasoned       fero                   ack-stages
    12  model-checked  fero                   soft-directory
     6  model-checked  fero                   planner-hints@per-resource
     1  reasoned       fero                   batch-checksum
     1  reasoned       fero                   route-smart

Only in MIN-P+par (3 mechanisms, 23 rules, low 19, high 27):
    18  model-checked  fero                   controller-commands
     3  reasoned       fero                   controller-hints
     2  reasoned       fero                   project-groups

In both, counted, owned or keyed differently (7; a pair under two keys holds the same rules):
  BASE cluster-credentials@per-resource 12 (fero 9/outside 3); MIN-P+par cluster-credentials 12 (fero)
  BASE cluster-version@per-resource 5 (fero); MIN-P+par cluster-version 5 (fero)
  BASE genesis-conditional-create@per-resource 6 (fero); MIN-P+par genesis-conditional-create 6 (fero)
  BASE meta-catalog@per-resource 4 (fero); MIN-P+par meta-catalog 6 (fero)
  BASE meta-directory@per-resource 6 (fero); MIN-P+par meta-directory 6 (fero)
  BASE meta-members@per-resource 2 (fero); MIN-P+par meta-members 5 (fero)
  BASE slow-leader-self 3 (fero); MIN-P+par slow-leader-controller 3 (fero)
```

- Answer stages +12, the soft directory +12, and V5-9's direct routing and checksum +2 are new.
- Healing by each leader comes with its hints and its slow-leader rule: 17 + 6 + 3 = 26. The central loop comes with its own hint path, its own slow-leader rule and project groups: 18 + 3 + 3 + 2 = 26. So 0. E-16 found healing by each leader smaller than the loop (14 against 18). Per resource, [E-52] finds healing 18 at the records' grain (22 at DEV-10's). It is 17 here, since `promote.caught` is counted in `learners`. With the platform's hints priced on both sides (DEP-17), the two come out level.
- The records in each resource's own log come to 2 + 4 + 6 + 6 + 5 + 12 = 35. `#meta`'s come to 5 + 6 + 6 + 6 + 5 + 12 = 40. So −5.
- The hand-back (6) and the byte-rate cap (1) are in both rows, so they cancel.
- Net +21. Without answer stages, +9. Without V5-9's direct routing and checksum, +19. Without both, +7. Counted with each pair cancelling, the base has more rules than MIN-P+par at every low and high count (+7 to +37).

### 3.4 With and without the variants

| Line | Rules | Low to high | Place among the 24 rows in |
|---|---|---|---|
| BASE | 416 | 318 to 524 | would be 23rd |
| BASE+dormant | 420 | 321 to 529 | would be 24th |
| BASE-ack | 404 | 310 to 511 | would be 16th |
| BASE-paths | 414 | 317 to 519 | would be 23rd |
| BASE with issue-order and timeline-merge | 421 | | |

All computed. `issue-order` (3: each writer numbers its writes, AMENDMENTS A-10) is owed by every row, and the base needs it for answer stages too. `timeline-merge` (2, V5-4's viewer) is owed by every row without a timestamp oracle. Neither is in any line. Added as owed, they flip 3 pairs of lines (MIN-P against TiKV-persisted, and MIN-P+m against PD+fix and TiKV-TS: TiKV's rows have an oracle and so owe no viewer rules) and break 4 ties (SIDE's and BASE-ack's, each with PD+fix and with TiKV-TS). No line moves past the base.

## 4. What changes against rule 3

Among the 24 judged rows in on the owner's frame. "r3" is rule 3's place and "rules" the place by rules (computed: the table in section 2).

| Row | r3 | Rules | By rules | Why it moves |
|---|---|---|---|---|
| MIN-P | 10 | 389 | 1 | nothing large; rule 3 held its 3 novel and 5 SHOULDs against it |
| TiKV-persisted | 1 | 390 | 2 | stays near the top: its 104 rules of TiKV machinery replace 99 of the log-first rows', and it founds by `fero init` (3), not by a conditional create (6) |
| MIN, MIN-TS, RUST | 11 | 391 | 3 | the same as MIN-P; their 4th novel mechanism is dormant groups, 4 rules (for project groups, 2) |
| SRV V=full Y=fwd | 15 | 392 | 6 | MIN plus a worker map 4, with `fero init` (3) for the conditional create (6); its Raft is a library's, which still counts |
| SRV | 17 | 394 | 7 | SRV V=full Y=fwd plus smart clients, 2 |
| LEAN | 14 | 395 | 8 | MIN with a standby fold (8 for 4) |
| MIN-P+par, MIN-P+par V=full | 4 | 395 | 8 | MIN-P plus `par`, 6. Under rule 3 that bought a SHOULD (F-22); simplicity counts no SHOULDs |
| RLOG | 18 | 396 | 11 | MIN plus the writer epoch on log members 6 and a tenant budget 2, with `fero init` for the conditional create |
| EMB-V8 | 19 | 396 | 11 | MIN plus a worker map, smart clients and a tenant budget (8), with `fero init` for the conditional create |
| MIN-P+par C=cent V=full | 6 | 399 | 13 | MIN-P+par plus controller sessions 6, less 2 of the member records |
| SLOG | 24 | 400 | 14 | rule 3 sank it on 2 SHOULDs and 5 novel; by rules it is middling |
| MIN-P+m | 16 | 403 | 15 | MIN-P plus the `memory` rung, 14 |
| PD+fix | 3 | 404 | 16 | TiKV-persisted plus the `memory` rung 14, a worker map 4 and smart clients 2, less `par` 6 |
| TiKV-TS | 2 | 404 | 16 | TiKV-persisted plus the `memory` rung, 14 |
| SIDE | 20 | 404 | 16 | MIN with a leader fold (8 for 4), a worker map 4, the local seam 3 and leader calls 2 |
| COMP | 21 | 405 | 19 | MIN-P plus the `memory` rung 14, with healing by each leader and its hints (23) for the loop and its hint path (21) |
| COMP2, COMP2 V=full | 7 | 409 | 20 | MIN-P+par plus the `memory` rung, 14 |
| COMP+par C=cent V=full | 9 | 413 | 22 | COMP2 plus controller sessions 6, less 2 of the member records |
| DRAFT | 23 | 419 | 23 | COMP with a dedup window (19) for client sessions (14), log replicas 7, dormant groups 4 and a tenant budget 2; `fero init` (3) for the conditional create (6), no project groups (−2) and presence +1 |
| SPLIT | 22 | 426 | 24 | DRAFT with split, merge, lineage and the split policy (29) for slot moves with their table, numbers and policy (21); `subscribe` is 1 less, with no slot moves to carry |
| BASE (predicted) | ~10 | 416 | ~23 | answer stages 12, the soft directory 12 and V5-9's direct routing and checksum 2 |

**Why.**
- **Rule 3 counted a mechanism as one item.** The `memory` rung is 14 rules (reasoned). Rule 3 counted it 0 novel and a few pairs. So the rows that carry it and sat high under rule 3 fall 13 or 14 places: TiKV-TS, PD+fix, COMP2, COMP2 V=full and COMP+par C=cent V=full.
- **Novel and small, or borrowed and big.** Rule 3 weighed dormant groups (4 rules) the same as the dir lease (18), and gave two-phase commit (29) nothing. By rules the plain MIN rows rise, because their novel mechanisms are small.
- **The big borrowed mechanisms.** The Raft core and membership, 80 rules in every Raft row (a library's in 8 rows). TiKV's machinery: two-phase commit 29, the oracle 10, the multi-version store 10, the LSM 23, closed timestamps 9, split and merge 23. The `memory` rung 14. The central loop 18. JetStream's 96 in BUY. All count now.
- **TiKV's shape stays near the top anyway** (section 0 item 4): 2nd, 1 rule behind MIN-P. What it adds is matched by what it drops: no sagas, no sessions, no journal, no dir lease, no slot moves.
- **SHOULDs no longer count.** Rule 3's second step is gone from this measure. `par` costs 6 rules and wins one SHOULD (F-22). Simplicity sees only the cost.

## 5. The largest mechanisms and where most rules go

### 5.1 The largest records

Computed from [simplicity.json](judging/simplicity.json) and the tool's row lists.

| Mechanism | Rules | Low to high | Basis | Carried by |
|---|---|---|---|---|
| `outside-log` (JetStream, bought) | 110 | 85 to 204 | reasoned (its Raft part mapped from nats-server's code) | BUY only; 96 of the rules are JetStream's |
| `v4-views` (v4's membership by ballot) | 38 | 30 to 44 | code | V4 only |
| `saga-intents` | 30 | 30 to 31 | model-checked ([E-24]) | 25 judged rows and the base |
| `two-phase-commit` | 29 | 18 to 35 | code | the four PD rows |
| `subscribe` | 26 | 22 to 29 | model-checked ([E-31]) | 29 judged rows and the base |
| `rekey` | 24 | 19 to 26 | model-checked ([E-17c]) | CELL |
| `lsm-store` | 23 | 10 to 30 | reasoned, from memory | the four PD rows (20 rules a library's, the disk reserve's 3 fero's) |
| `dedup-window` | 19 | 17 to 20 | model-checked ([E-20]) | DRAFT, LANE, SPLIT, SLOG, V4 |
| `controller-commands` (the central loop) | 18 | 16 to 18 | model-checked ([E-16]) | 24 judged rows; not the base |
| `dir-lease` | 18 | 12 to 22 | 12 code (V4-59), 6 reasoned | 24 judged rows and the base |
| `raft-term-vote` | 17 | 14 to 18 | spec | 28 judged rows and the base |
| `producer-state` | 17 | 16 to 18 | model-checked ([E-20]) | ISR |
| `healing-self@per-resource` | 17 | 15 to 21 | model-checked ([E-52]) | the base |
| `journal` | 16 | 10 to 18 | reasoned | 22 judged rows and the base |
| `healing-self` | 16 | 14 to 19 | 14 model-checked ([E-16]), 2 reasoned (from [E-52]) | the 5 `self` rows |
| `raft-config` | 15 | 14 to 16 | model-checked ([E-14b], [E-14c]) | 28 judged rows and the base |
| `memory-rung` | 14 | 8 to 17 | reasoned | 10 judged rows |
| `client-sessions` | 14 | 13 to 16 | model-checked ([E-20]) | 20 judged rows and the base |

### 5.2 Where the rules go, by area

Computed: `python3 tools/simplicity.py row NAME`, its "By area" line.

| Area | BASE | MIN-P+par | COMP2 | TiKV-persisted |
|---|---|---|---|---|
| Raft (core and membership) | 80 | 80 | 80 | 80 (a library's) |
| many groups (pings, quiet groups, the hand-back, the slow-leader rule) | 20 | 22 | 22 | 20 |
| control (healing, metadata, directory, founding, credentials) | 70 | 61 | 61 | 62 |
| partitions (slots and moves, or ranges with split and merge) | 21 | 21 | 21 | 23 |
| writes (judging, retries, routing, answers) | 51 | 38 | 38 | 24 |
| time (writer time, or the oracle) | 6 | 6 | 6 | 10 |
| transactions (the saga, or two-phase commit and versions) | 38 | 38 | 38 | 45 |
| storage (journal, tier, rungs, the dir lease, repair, checksums, the cap) | 62 | 61 | 75 | 45 |
| reads (folds, subscribe, closed timestamps) | 37 | 37 | 37 | 49 |
| platform (groups, presence, queues, forks, the recorder) | 31 | 31 | 31 | 32 |
| **Total** | **416** | **395** | **409** | **390** |

- **Raft is about a fifth of every Raft row:** 65 rules from etcd's spec and the Raft paper, plus the 15 model-checked membership rules. Whether fero ports it (the base) or imports it (RUST, TiKV-persisted), the 80 count.
- **The saga with fenced locks is the largest model-checked piece:** 38 rules ([E-24]). Two-phase commit in TiKV's shape is 29, plus the multi-version store's 10. They come out close.
- **The slot move is 18 rules here** (21 with the move policy), and 28 with the 10 rules it shares with dedup, fences and reads ([E-17c]). Split and merge with lineage are 26 here, and 37 in all. Re-key is 24.
- **Where the base and TiKV's shape differ.** The base pays more in writes: client sessions 14, answer stages 12 and direct routing 1, where TiKV's transactions carry their own ids. It pays more in storage: a journal 16, a dir lease 18, the restore mark 5 and V5-9's checksum 1, against an LSM 23. TiKV's shape pays more in reads (closed timestamps 9, lease reads 4) and in transactions (two-phase commit and versions with lock rows, 45, against the saga's 38). It also pays more in time (the oracle 10, against writer time's 6).
- **v4's kernel is 160 rules over 14 records** (code). Its membership by ballot alone is 38, more than Raft's election and membership on etcd (17 + 15). V4 has 230 rules, the fewest of any home-made row, but it fails 50 MUSTs.

## 6. How sure

**Where the counts come from** (by rule, where a record mixes bases).
- **The base:** 197 rules model-checked (47%), 64 counted from a spec (15%), 26 counted from code (6%), 1 measured (under 1%), and 128 reasoned (31%) (computed, `row BASE`). Before the per-resource models: 157 model-checked and 148 reasoned of 405.
- **The whole catalogue:** 1,135 rules in 126 records. 332 are model-checked, 126 counted from a spec, 243 counted from code, 1 measured, and 433 reasoned. By label the records are 35 model-checked, 16 spec, 21 code and 54 reasoned.
- **Who counted.** One counter per record, then one calibration pass, then one skeptic who recounted the largest records from their sources. DEV-10 (e) asks for two counters on their own, as [MECHANISMS.md](MECHANISMS.md)'s catalogue had. This count had no second blind counter. Since 2026-11-14 the base's per-resource records rest on two models, each checked by a skeptic of its own ([E-51], [E-52]); moving their findings to the study's records (section 8.3) is one counter's reasoning, checked by one more skeptic (section 8.5).

**What the skeptic found.** The errors it found ran by family of rows, not at random, and those are the ones that move places. All are fixed on this page:
- **The controller rows got the platform's hints for free.** DEP-17 is a MUST, and RM-05 puts a controller row's hints in the controller's loop, but no record held those rules. They are now `controller-hints` (2 then, 3 since [E-52]), in all 24 controller rows. The admin-key rule was also counted twice, in the hints and in the credentials, and `#meta`'s planner lease is no rule (two planners only waste moves). Alone, this fix moved the base from 22nd to 20th (the skeptic's arithmetic).
- **The borrowed LSM was counted more coarsely than fero's own journal.** AMENDMENTS A-09 puts the disk reserve and "a short write means ask again" on every row. The journal counted them; the LSM left them in its high. It now counts them, with RocksDB's directory fsync and its store lock: 17 became 23. Alone, this put MIN-P first, one rule ahead of TiKV-persisted (the skeptic's arithmetic).
- **The base dropped the 3 credential rules it moves to the operator.** The measure counts borrowed and outside rules (JetStream's 96 in BUY). They now count as outside rules. Alone, this moved the base from 22nd to 23rd (the skeptic's arithmetic).
- **Smaller ones:** two v4 directory rules the soft directory left out (+2); a call key's lease lapse that is `writer-time`'s (−1 in every row); a rollback record two-phase commit left out (+1 in the PD rows); stale bounds in some notes; and the basis split by rule.
- **What it did not find:** a count off by more than its own low or high. It recounted the Raft core, the slot bundle, the saga, two-phase commit, the oracle, the versions, subscribe, v4's lanes, answer stages and the dir lease from their sources.

**The bounds.**
- **If every count errs the same way,** the base stays near the bottom. With every record at its low, then mid, then high count, the base would be 24th, 23rd and 23rd; BASE-ack 20th, 16th and 17th (computed).
- **TiKV's shape has the widest bounds.** TiKV-persisted goes 1st, 2nd, 9th; PD+fix 2nd, 16th, 21st; TiKV-TS 3rd, 16th, 18th. Its LSM (10 to 30), two-phase commit (18 to 35) and multi-version store (6 to 13) are reasoned or from memory. SLOG goes 19th, 14th, 7th, and EMB-V8 6th, 11th, 13th.
- **If each record may err its own way,** with each `@per-resource` record moving with its study record, one order holds against 10 of the 24 rows in: the base has more rules than MIN-P's plain family, both SRV rows, LEAN and the three MIN-P+par rows at every bound (computed, the footer of section 2). Against the other 14 rows in, the order can go either way. EMB-V8, RLOG and COMP come within a rule at their high counts, and DRAFT runs from 25 rules fewer than the base to 24 more. The rows in are at most 37 rules apart. The spread on what differs from the base is 26 to 173 rules among the rows in (computed with the tool's `interval`).
- **So:** the order holds for big gaps, when all counts err together, and between the base and those 10 rows. It does not hold between other neighbours, the base and DRAFT among them.

**What the count leaves out.**
- **Open MUSTs.** A row is priced only for the mechanisms it carries. A MUST it leaves open may need a mechanism nobody has written yet. TiKV-persisted leaves 121 open, the base (predicted) 97, MIN-P+par 96. That is V5-1's ground against TiKV's shape, and this count does not see it.
- **Flags from calibration**, left as they are because they come from the closure tool's carries rule:
  - V4 carries no `dir-lease`, though v4 has the dir lock (V4-59, 12 of the lease's rules). V4 would have about 242.
  - SLOG carries neither `journal` nor `wal-per-group`, though its log nodes keep disks. It would have about 412 to 416.
  - `raft-config`'s ghost rule is fero's even on the library rows. One rule would move from library to fero there.
  - The one-box founding path (about 5 rules) sits in every row's high, not its count. It is the same in every row, so no place changes.
  - ISR, SLOG and OBJ carry the hand-back (less its quiet-group rule) by reasoning: their design text has none, but their controller must spread leaders or writers back after a failover, as the Raft rows do (section 8.3). Without it SLOG would have 395 and be 8th.
  - The byte-rate cap on bulk work is carried by reasoning in every row but the base and BUY: only the base's design text names it (V5-9), but SC-08 (c) and (f) are MUSTs for every row (section 8.3). It adds 1 to 30 judged rows alike, so it moves no place among them.
  - A hand-back cap counted at the taker in the push form needs about 3 to 4 rules more (E-53, reasoned). It sits in `handback`'s high in every row, not its count.
- **The base's rule-3 numbers** are predicted from its option vector, with 3 guessed cells (SC-03 M, SC-10 M, F-12 M).

**In short.**
- **High** that answer stages, the soft directory and V5-9's direct routing and checksum are why the base has more rules than MIN-P+par. Together they add 26, more than the whole gap of 21; the rest nets −5. At their low counts they still add 20.
- **High** that the base has more rules than MIN-P, MIN, MIN-TS and RUST: by 25 to 27 at the mid count, and by at least 12 at every bound. Every rule of that gap comes from an owner's choice (section 0 item 5).
- **Medium** that the base sits near the bottom of the rows in: 23rd of 24 at the mid count, with DRAFT and SPLIT above it, and 23rd or 24th when the counts err together. Record by record it has more rules than 10 of the 24 rows in; against the other 14 the order can go either way.
- **Low** on the order between the base and DRAFT. DRAFT has 3 more rules at the mid count, fewer at every low count and more at every high count, and record by record it runs from 25 fewer to 24 more (computed).
- **Low** on any other order between neighbours. The count is not sure to the gaps between them.
- **Low** on TiKV-persisted's place. It is 2nd by its count and runs from 1st to 9th across the bounds. That rests on two-phase commit (never ablated), and on the LSM and the multi-version store, both from memory.

## 7. How to check

Run from `docs/v5-space`. Standard library only, no network. The tool is deterministic.

```sh
python3 tools/simplicity.py                       # section 2's table
python3 tools/simplicity.py --strict              # the same on DATA-01's strict reading
python3 tools/simplicity.py row BASE              # section 3.1
python3 tools/simplicity.py row MIN-P+par         # any row, largest record first
python3 tools/simplicity.py diff BASE MIN-P+par   # section 3.3
python3 tools/simplicity.py diff BASE-ack MIN-P   # section 0 item 5
python3 tools/simplicity.py diff BASE MIN-P       # section 8.4
python3 tools/simplicity.py diff BASE DRAFT       # section 0 item 1
python3 tools/simplicity.py diff BASE TiKV-persisted
python3 tools/closure.py check-mech               # the carries rule still gives the settled lists
```

To compare the r3 column with rule 3's own ranking, define `repro` as [candidates/README.md](candidates/README.md#reproduce-a-computed-claim) shows, then run `repro rank --loss`. The base's predicted numbers come from `repro row 'Z=par,C=self' MIN --loss`.

| Claim | Command | What it prints |
|---|---|---|
| the base has 416 rules, 23rd of 24 | `python3 tools/simplicity.py` | the BASE line: 416, in ~23 |
| 404 without answer stages, 16th | the same | the BASE-ack line: 404, in ~16 |
| 414 without V5-9's two base-only path changes, 23rd | the same | the BASE-paths line: 414, in ~23 |
| MIN-P first by rules, TiKV-persisted 2nd | the same | 389, in 1; 390, in 2 |
| DRAFT 3 rules above the base, either way at the bounds | the same, footer | "DRAFT +3 [-25..+24]" |
| the base has more rules than 10 of the rows in at every bound | the same, footer | "fewer rules at every bound (15)": MIN-P, MIN, MIN-TS, RUST among them |
| 15 rules over MIN-P without answer stages | `diff BASE-ack MIN-P` | +15 |
| 21 rules over MIN-P+par | `diff BASE MIN-P+par` | +21 |
| 27 rules over MIN-P | `diff BASE MIN-P` | +27 |
| the hand-back and the byte-rate cap in every row with leaders and bulk work | `row MIN-P` | `handback` 6, `bulk-rate-cap` 1 |
| TiKV's machinery and what it drops | `diff BASE TiKV-persisted` | the two "Only in" lists |
| the base by basis and by area | `row BASE` | its first three lines |

## 8. After the per-resource models (2026-11-14)

The base's per-resource records were first counted by reasoning (section 3). Three experiments then modelled or measured them: [E-51], founding and finding a resource; [E-52], healing per resource; and [E-53], the hand-back's pace on real code. [DECISIONS V5-9](../DECISIONS.md) also took three of [PATHS 7.1](PATHS.md#71-changes-for-the-owner-to-decide)'s path changes into the base. A second skeptic then checked the update this section describes (section 8.5). This section says what each changed, what moved, and how sure. Every number in sections 0 to 7 is already the new one.

### 8.1 The grain

- **The records' grain.** A base record counts one numbered rule as one rule, as the study's reasoned records and E-33's genesis do. So the base stays like for like with the other rows.
- **DEV-10's grain.** The models count each guard and each update. A numbered rule with several parts counts several times there. Each record's notes give that count. It runs higher: [E-51]'s five records are 50 at DEV-10's grain and 30 at the records' grain; [E-52]'s three are 35 and 25.
- **Two high bounds use it.** `healing-self@per-resource` takes its DEV-10 count less `promote.caught` (21) as its high, because its study twins, `healing-self` and `controller-commands`, are E-16's DEV-10 counts. For the same reason `healing-self` counts the stored placement at DEV-10's grain (4 rules) in its high (19). The other records' twins are reasoned at the records' grain, so their highs stay there.
- **One rule stays where it was counted.** [E-52] kept `promote.caught` (promote only a learner that has caught up). It is `learners`' rule 3, which the base already carries, so it stays there (section 1.4). That is why the healing record is 17 here, where [E-52]'s own mapping says 18.

### 8.2 What each experiment changed in the base

| Record | Before (reasoned) | Now, records' grain | DEV-10 | Basis now | What changed |
|---|---|---|---|---|---|
| `genesis-conditional-create@per-resource` | 4 | 6 | 14 | model-checked ([E-51]) | The opener writes a candidate id to disk before the create, and founds only if the stored id is its candidate. Without that, a plain crash between the create and the first entry strands the name for good (6 steps). |
| `meta-catalog@per-resource` | 5 | 4 | 7, and 1 high | model-checked ([E-51]) | The seed mark goes: the seed rides the home group's founding entry, beside the settings record, and a joining copy never applies a seed. |
| `meta-directory@per-resource` | 8 | 6 (7 with the old rule 2) | 10 | model-checked ([E-51]) | A record write can be lost, and nothing wrote it again (5 steps). Rule 1 now writes whenever the home log's record differs. That also covers the old rules 2 and 8. |
| `meta-members@per-resource` | 2 | 2 | 2 ([E-51]); 4, two checks ([E-52]) | model-checked | Reworded. "Leave the directory" is not needed. "Never pick, add or promote a retiring machine" is three guards of one check. |
| `soft-directory` | 12 | 12 | 17, and 1 high | model-checked ([E-51]); was code 9, reasoned 3 | "A client asks the directory only for a first address" strands a client whose members all died (5 steps). That half goes; "learn from the resource" stays. |
| `healing-self@per-resource` | 15 | 17 | 22 (21 decided) | model-checked ([E-52]) | Promote only a learner that answers now (one crash, 13 steps). The stored placement is 4 rules at DEV-10's grain, 1 here, and does `promote.need`'s job. A pick or an add takes only a machine the leader's own link reached. A spare must be dialed (2 steps). |
| `planner-hints@per-resource` | 5 | 6 | 9 (11 with its transfers) | model-checked ([E-52]) | The stale-plan check and "add a hinted machine only while reached" have no counterexample here (healing's own check does the second). The gone hint's effect, the place hint's write and the lead hint's own transfer are needed. |
| `handback` (new, in every row with leaders) | none | 6 | 4 ([E-52]), and 1 measured ([E-53]) | 4 model-checked, 1 measured, 1 reasoned | The hand-back after `settle.ms` with its transfer; only to a voter; at most K transfers in flight (the design's, V5-7); no quiet group while a transfer is in flight (measured); and the re-pick of the preferred member when it leaves, its guard and its update. |
| `route-smart`, `batch-checksum`, `bulk-rate-cap` (new, the base) | none | 1, 1, 1 | not modelled | reasoned ([PATHS 7.1](PATHS.md#71-changes-for-the-owner-to-decide)) | V5-9: direct routing; one native checksum per batch, with its header under it; a byte-rate cap on bulk work, on the link and the disk. The cap is owed by every row with bulk work (8.3). |

- **The seven per-resource records** go from 51 rules to 53 (+2).
- **The hand-back** adds 6, in the base and in every row with leaders (section 8.3).
- **V5-9's three** add 3 to the base. Direct routing is the catalogue's `route-smart`, 2 rules in the smart rows. In the base, the soft directory's rule 9 already learns the slot table and leaders from the resource, and learns them again when they change. That is `route-smart`'s cache update, so the base pays 1: a retry answer that is never final. PATHS 7.1 priced direct routing at 0 to +1, and V5-9 priced the three at 2 to 3. The checksum is 1. The byte-rate cap is 1, and every row with bulk work owes it too (SC-08), so only 2 of the 3 are the base's alone.
- **So the base** went from 405 to 416: +2, +6 and +3.

**[E-51]'s five fixes to the design text.** The candidate on disk before the create (+2 rules, with the compare). A client asks the directory again once every member it learned has failed, or simply never stops asking (half a rule goes). A group's record is written whenever the home log's record differs (a rule reworded, two covered). The home group's own recovery leaves a window the text must state (no rule). The seed needs no mark (a rule goes).

**[E-52]'s four rules that no record had.** Promote only a learner that answers the leader now. Re-pick the preferred member when it leaves the stored placement. Dial a spare the directory lists before using it. A lead hint moves leadership itself, never to a draining or leaving machine.

**[E-53]'s +1.** V5-7 said its cap adds no rule. It adds one in either form (measured on real Raft code). Counted at the taker, a transfer not won within `election.ms` plus jitter must free its slot: without that, groups were never handed back in 20 of 20 runs where a giver died. Counted at the giver, as the design pushes, a group with a transfer in flight must not go quiet: without that, a dead taker's transfers stayed set on quiet groups in 22 of 22 runs, and none did with it in 6 of 6. The count takes the giver's form, as a measured rule. The cap itself is the design's (V5-7): no run went without one, so it is reasoned. The taker's rule, and a cap per taker in the push form (about 3 to 4 rules, reasoned), are in the high. [E-53] recommends a cap of 8, busiest first, or 4 where F-05 must hold.

### 8.3 The same rules in the other rows

- **The rule.** A model's finding goes to every row whose record holds the same rule for the same reason, needed or not needed. So no row gets a rule for free, and none pays for a rule a model found not needed. A `@per-resource` record and its study record keep their difference, so `diff` still cancels them fairly.
- **The experiments' own answer differs.** [E-52] and [E-53] each say that no study row moves: they answer for the base. This page moves the study's records by its own rule above, so that like is counted with like. Each such move is reasoned, not run, and each record says so in its `CHECKED:` note.

| Record | Before | Now | Judged rows | Why it carries over, or not |
|---|---|---|---|---|
| `handback` (new) | none | 6 (5 in ISR, SLOG, OBJ) | 29 | every row with a leader or writer per group must spread them back after a failover, and stores a preferred member that a lead hint sets |
| `bulk-rate-cap` (new) | the base only | 1 | 30 | SC-08 (c) and (f) are MUSTs for every row, and every row but BUY moves bulk data beside live writes: catch-up, snapshot installs, a slot move's copy |
| `genesis-conditional-create` | 4 | 6 | 16 | [E-51] finds the gap in E-33's own step, which founding `#meta` by create-if-absent shares |
| `meta-catalog` | 6 | 6 | 29 | not carried over: [E-51]'s seed rides the founding entry beside the record, but in the `#meta` rows the record and the seed are in two logs, so the seed mark stays |
| `meta-directory` | 8 | 6 | 29 | a record write to `#meta` can be lost as one to a home log can |
| `healing-self` | 14 | 16 | 5 | [E-52]'s trace for "answers now" runs on E-16's own healing; and the self rows store place hints in the group's log, so they need the stored placement too ([E-52] section 4) |
| `controller-commands` | 18 | 18 | 24 | `exec.live` reworded to "answers now"; E-16 already kept it as a rule |
| `planner-hints` | 5 | 7 | 5 | the same hint path as the base's, with the same findings, except that the reach check stays: the study's healing has no candidate check of its own |
| `controller-hints` | 2 | 3 | 24 | a lead hint must move leadership itself at a controller too |
| `learners` | 3 | 3 | 27 | rule 3 is model-checked now ([E-52]); its high drops "never a transfer target", which is `handback`'s rule 2 |
| `raft-leader-transfer` | 6 | 6 | 28 | its high drops "transfer only to a voter", counted once as `handback`'s rule 2 (the library's in the 8 rows on raft-rs or etcd raft) |

- **Which rows carry the hand-back.** DESIGN-V5 4.2 ("Leaders spread") hands leadership back to each group's preferred member after a failover. In the `self` rows each group's leader does it; MECHANISMS.md lists it under `healing-self`. A central-loop row balances leaders from its controller (`controller-hints`' rule 2 names that balancing), with the same rules; the command's epoch check and timeout are `controller-commands`'. The four PD rows do it with PD's own leader balancing (from memory), counted at the same grain. ISR, SLOG and OBJ name their leaders or writers by the controller's own change, so they owe the same rules but one: they have no quiet groups and no Raft transfer, so "no quiet group while a transfer is in flight" does not apply. Their design text does not say so, so that is reasoned. Only V4 (no leaders) and BUY (JetStream's own) carry none. The tool carries it by a rule of its own (`CARRIES`), since closure's catalogue has no record for it.
- **Which rows carry the byte-rate cap.** It carries SC-08 (c), live writes' p99 at most twice the steady state during any scale change, and (f), data moved per added server paced. Both are MUSTs for every row. Every row whose bulk work fero writes moves data beside live writes when a server is added or a slot moves: a Raft snapshot install and catch-up, a log member's or a folding learner's catch-up (RLOG, SLOG), an ISR follower's fetch, a slot move's copy (OBJ), v4's teacher (V4). So all of them carry it (reasoned: only the base's text names it). BUY's catch-up is JetStream's own. The tool carries it by `CARRIES` too.
- **The re-pick in rows with a ring.** [E-52] notes that a ring over `#meta` names the next preferred member by itself. But every row also stores a preferred member that a lead hint sets (DEP-17), and that one must be re-picked when its member leaves: the guard and the update stay. The record's low merges them.
- **The base's alone:** in healing, only the dial. Links run only between the machines a resource's groups share, so a spare is found only through the soft directory ([E-52]). The stored placement is not the base's alone: [E-52] section 4 shows it is needed because the platform's place hints need a stored target that healing follows, not for want of a shared member list, and the study's self rows take place hints too. Nor is the candidate check: in the study's self rows the hint path's reach check does its job. The soft directory, answer stages, and V5-9's direct routing and checksum are the base's alone too.
- **One reading to say plainly.** The candidate on disk could be read as the base's alone, since [E-51] modelled founding per resource. It is not: the gap is in E-33's merged step, which the study's founding of `#meta` by create-if-absent shares. Kept to the base alone, the base would have 29 rules more than MIN-P, not 27, and the rows that found by `fero init` would lose their 2-rule edge on MIN-P's family (arithmetic).

### 8.4 What moved

Computed: `python3 tools/simplicity.py diff BASE MIN-P`.

```
BASE: 416 rules (55 mechanisms). MIN-P: 389 rules (51 mechanisms).
BASE less MIN-P: +27, and +13 to +45 at the low and high counts of the mechanisms that differ.

Only in BASE (7 mechanisms, 55 rules, low 45, high 69):
    17  model-checked  fero                   healing-self@per-resource
    12  reasoned       fero                   ack-stages
    12  model-checked  fero                   soft-directory
     6  model-checked  fero                   par-repair
     6  model-checked  fero                   planner-hints@per-resource
     1  reasoned       fero                   batch-checksum
     1  reasoned       fero                   route-smart

Only in MIN-P (3 mechanisms, 23 rules, low 19, high 27):
    18  model-checked  fero                   controller-commands
     3  reasoned       fero                   controller-hints
     2  reasoned       fero                   project-groups

In both, counted, owned or keyed differently (7; a pair under two keys holds the same rules):
  BASE cluster-credentials@per-resource 12 (fero 9/outside 3); MIN-P cluster-credentials 12 (fero)
  BASE cluster-version@per-resource 5 (fero); MIN-P cluster-version 5 (fero)
  BASE genesis-conditional-create@per-resource 6 (fero); MIN-P genesis-conditional-create 6 (fero)
  BASE meta-catalog@per-resource 4 (fero); MIN-P meta-catalog 6 (fero)
  BASE meta-directory@per-resource 6 (fero); MIN-P meta-directory 6 (fero)
  BASE meta-members@per-resource 2 (fero); MIN-P meta-members 5 (fero)
  BASE slow-leader-self 3 (fero); MIN-P slow-leader-controller 3 (fero)
```

- **The base.** 405 → 416 rules; 22nd → 23rd of the 24 rows in, with DRAFT (419) and SPLIT (426) above it. BASE-ack 393 → 404, 14th → 16th. BASE-paths, the line without V5-9's two base-only changes, has 414 (23rd). With every record at its low count the base would be 24th, and at its high 23rd (computed).
- **DRAFT against the base.** DRAFT went from 410 to 419. It was 5 rules above the base and is now 3 above. It gained 9: the hand-back 6, the cap 1, healing 2 and hints 2, less 2 for the group records. The base gained 11. **The count cannot order the two.** Record by record, DRAFT runs from 25 rules fewer than the base to 24 more (before: 20 fewer to 31 more). With every count at its low, DRAFT has fewer; with every count at its high, more (computed). What differs: the base pays client sessions 14, answer stages 12, the soft directory 12, a conditional create 6, `par` 6 and V5-9's two 2; DRAFT pays a dedup window 19, the `memory` rung 14, log replicas 7, dormant groups 4, `fero init` 3 and a tenant budget 2, and 7 more in its `#meta` records, hints and presence, less 1 in healing (`diff BASE DRAFT`).
- **MIN-P's family.** MIN-P 381 → 389, still 1st. MIN, MIN-TS and RUST 383 → 391, 2nd → 3rd. MIN-P+par 387 → 395, 7th → 8th.
- **The gaps.** BASE over MIN-P 24 → 27; over MIN-P+par 18 → 21; BASE-ack over MIN-P 12 → 15 (computed, `diff`). The 3 more are V5-9's direct routing and checksum (+2), and healing with its hints (+2: the base gained "answers now", the candidate check, the dial and three hint rules, less `promote.need`, stale-plan and the reach check; the loop gained only the lead hint's own transfer), less the seed mark (−1), which the base no longer needs and `#meta` keeps. The hand-back, the cap, the genesis rules and the group records move both sides alike.
- **Healing against the loop.** With hints and slow-leader rules on both sides, healing by each leader was 2 rules smaller than `#meta`'s loop. Now they are level, 26 and 26. Against the study's own healing by each leader (the self rows), the base's healing and hints are level too, 23 and 23: the base has the dial, and the self rows keep E-16's `promote.need` for groups the ring places.
- **Sure at every bound.** Record by record, the base now has more rules than 10 of the 24 rows in at every bound, against 4 before (MIN-P's plain family). The 6 added are both SRV rows, LEAN and the three MIN-P+par rows.
- **The other rows.** Every row in gained 6 to 11 rules: the hand-back's 6 (5 in SLOG) and the cap's 1, less 2 for the group records; plus 2 for the genesis rules where a row founds by a conditional create, 1 for the hint path at a controller, or 4 for healing and hints in the self rows. So the rows that found by `fero init` gain 2 on MIN's family. TiKV-persisted rises from 5th to 2nd, 1 rule behind MIN-P; SRV from 10th to 7th. COMP falls from 15th to 19th. SLOG stays 14th.
- **Against rule 3.** The shape is the same: MIN-P rises from 10th to 1st, and the `memory` rows fall 13 or 14 places.

### 8.5 What a check of this update changed

The first version of this update put the base at 417, 24th of the 24 rows in, with DRAFT (415) below it. A second skeptic checked it and found twelve problems. All are applied:

- **The stored placement is not the base's alone** (F1). The first version kept it to the base "because the base has no shared member list". [E-52] section 4 shows otherwise: the platform's place hints need a stored target that healing follows, and then the leader must write its own picks there too. The study's self rows store place hints as well, so their `healing-self` now holds the same rule (15 → 16). The base: 0; the 5 self rows: +1.
- **The study keeps its reach check** (F2). [E-52] found "add a hinted machine only while reached" not needed only because the base's healing checks its own candidates. The study's healing has no such check, so `planner-hints` keeps it (6 → 7). The 5 self rows: +1.
- **The study keeps its seed mark** (F3). In the `#meta` rows the resource's record and its seed are in two logs, so [E-51]'s reason does not carry over (`meta-catalog` stays 6). 29 rows: +1.
- **The cap is the design's, not measured** (F4). [E-53] calls the cap docs, and no run went without one. `handback` is now 4 model-checked rules, 1 measured and 1 reasoned.
- **"Only to a voter" is counted once** (F5). It is `handback`'s rule 2, so it leaves `raft-leader-transfer`'s high (7 → 6) and `learners`' (4 → 3). In the 8 rows on raft-rs or etcd raft it is the library's.
- **Direct routing is 1 in the base** (F6), since the soft directory already relearns leaders and the slot table. The base: −1.
- **The byte-rate cap is owed by every row with bulk work** (F7), since it carries SC-08 (c) and (f). 30 judged rows: +1.
- **Smaller ones.** Section 8.3 now says that [E-52] and [E-53] move no study row themselves (F8). This section is now 8, so the page has no gap in its numbers (F9). Old decision lines in [simplicity.json](judging/simplicity.json) are marked superseded, and two notes give the new rule numbers (F10). Section 3.3 gives [E-52]'s own numbers (F11). The tool now takes a `row_minus` off the basis the record names, so ISR, SLOG and OBJ lose the hand-back's measured rule, not a model-checked one (F12).

The effect: the base 417 → 416, DRAFT 415 → 419, MIN-P 387 → 389. The base moves from 24th to 23rd, and DRAFT from just below it to 3 rules above it. The rows the base exceeds at every bound go from 13 to 10: EMB-V8, RLOG and COMP now come within a rule at their high counts.

### 8.6 How sure

- **High** that the base's per-resource records hold their counts at the models' bounds: every reachable state, [E-51] up to 4,050,927 states with 57 of 58 non-equivalent mutants caught, [E-52] up to 3,704,723 states with 46 of 48 caught and 2 undecided (model-checked).
- **Medium** for the mapping from the models' rules to the records' numbered rules. It is each experiment's judgement, and the greedy order decides which of two covering rules is kept ([E-51]'s rule 1 over the old rules 2 and 8; [E-52]'s `add.cand` and `dropl.append`). The worlds are small (3 or 4 machines), and the pieces were checked apart.
- **Medium** for the hand-back's measured rule: real Raft code at one fault, not every state ([E-53]). Which cap V5-7 means is not settled: a cap per taker in the push form would need about 3 to 4 rules, not 1 (reasoned). That sits in the high.
- **Medium-low** for the transfers to the study's records: reasoned from the models' own reasons, not run in `#meta`'s world. Two move places most. The hand-back in ISR, SLOG and OBJ: without it SLOG would have 395 and be 8th, not 14th. And the stored placement and the reach check in the self rows: without them DRAFT would have 417, 1 rule above the base, not 3.
- **Low** for V5-9's three, and for the cap in every row: reasoned from PATHS 7.1 and SC-08. No model ran; PATHS 7.1 names the one each needs.
- **What it changes in the answer.** Before, the count was sure only that the base has more rules than MIN-P's plain family. Now it is sure of that by at least 12 rules at every bound, and sure that the base has more rules than 10 of the 24 rows in. When the counts err together, the base is 23rd or 24th. It is not sure of the order between the base and DRAFT: 3 rules apart at the mid count, and either way at the bounds. The choice among the rows still rests on what their rules buy (section 0 item 6).

## 9. Sources

**Files used.**
- [judging/simplicity.json](judging/simplicity.json): the counts (126 records), the base and its decisions, and the calibration notes.
- [tools/simplicity.py](tools/simplicity.py): this page's tool. It imports [tools/closure.py](tools/closure.py) for the rows' options, the carries rule and rule 3's numbers.
- [judging/closure/axes.json](judging/closure/axes.json), [judging/closure/hybrids/cards.json](judging/closure/hybrids/cards.json), [judging/closure/mechanisms.json](judging/closure/mechanisms.json), [judging/mechanisms.json](judging/mechanisms.json): the 31 judged rows, their options and their mechanisms.
- [DECISIONS V5-1 to V5-9](../DECISIONS.md), [VERDICT 11.6 and 11.7](VERDICT.md#116-the-owners-answers-2026-11-12), [MECHANISMS.md](MECHANISMS.md), [REQUIREMENTS.md](REQUIREMENTS.md) DEV-10, [SPACE.md](SPACE.md), [MEMORY.md](MEMORY.md) 9.4, [AMENDMENTS.md](AMENDMENTS.md) A-10, [DESIGN-V5.md](../DESIGN-V5.md) 4.2, [PATHS.md](PATHS.md) 7.1, [REQUIREMENTS.md](REQUIREMENTS.md) SC-08.

**The models.** [E-14b], [E-14c], [E-15], [E-16], [E-17c], [E-20], [E-21], [E-24], [E-30], [E-31], [E-33], [E-36], [E-37], [E-44], [E-47], [E-48], [E-51], [E-52]; and [E-53], measured on real code.

**Read in this pass, outside the study.** Each record's `source` names its own. They are:
- etcd raft v3.7.0-rc: `tla/etcdraft.tla` and `raft.go`; the Raft paper (Ongaro and Ousterhout, 2014), Figure 2.
- Kafka's replication TLA+ spec, and Kafka 3.9.0's `PartitionChangeBuilder.java`. A BookKeeper TLA+ spec.
- CockroachDB's follower-reads RFC. PD's `pkg/tso/tso.go`. nats-server v2.10.22's `server/raft.go`.
- v4's own [kernel/](../../kernel), `shell/runtime.ts`, [api/directory.ts](../../api/directory.ts) and [kernel/door.ts](../../kernel/door.ts).

**From memory, not checked here:** Percolator's paper, RocksDB's write path and compaction, TiKV's multi-version store, and JetStream's stream, consumer, meta and store rules.

[E-14b]: experiments/E14b-membership-liveness/README.md
[E-14c]: experiments/E14c-membership-completion/README.md
[E-15]: experiments/E15-slot-move-tla/README.md
[E-16]: experiments/E16-controller-loop/README.md
[E-17c]: experiments/E17c-partitioning-rerun/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-44]: experiments/E44-outside-log/README.md
[E-47]: experiments/E47-memory-rung/README.md
[E-48]: experiments/E48-ack-stages/README.md
[E-51]: experiments/E51-resource-founding/README.md
[E-52]: experiments/E52-resource-healing/README.md
[E-53]: experiments/E53-handback-pace/README.md
