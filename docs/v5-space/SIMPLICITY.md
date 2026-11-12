# Simplicity: the study's rows re-ranked by every rule

2026-11-12. The owner set the study's rule 3 aside and asked for a re-rank by **simplicity**: every rule a builder must get right, borrowed or not ([DECISIONS V5-1 and V5-6](../DECISIONS.md); [VERDICT 11.7](VERDICT.md#117-the-owners-design-decisions-2026-11-12)). This page is that re-rank. Its data is [judging/simplicity.json](judging/simplicity.json) and its tool is [tools/simplicity.py](tools/simplicity.py). It changes no other study file. Words follow VERDICT's [key of terms](VERDICT.md#key-of-terms).

**How each claim is marked.**
- **Model-checked**: an experiment's model counted the rules by ablation. Drop one rule, and the checker finds a counterexample. The experiment is named.
- **Counted from a spec**: rules read off a published spec, paper or design note in this pass, named.
- **Counted from code**: rules read off source code in this pass, named.
- **Reasoned**: counted from the mechanism's own text and the design records. Nothing ran it. "From memory" means a fact about an outside system nobody checked here.
- **Computed**: `tools/simplicity.py`, `tools/closure.py`, or the `repro` script of [candidates/README.md](candidates/README.md#reproduce-a-computed-claim).

## 0. The answer

1. **Where the base lands.** The owner's base has **405 rules** (computed): 402 that fero writes, and 3 credential rules that move to the operator. On the owner's frame, 24 judged rows fail no MUST. The base would be **22nd** of them, level with COMP+par C=cent V=full (405). Only DRAFT (410) and SPLIT (417) have more. With dormant groups the base has 409 (23rd).
2. **Answer stages are most of the gap.** They are 12 rules (V5-5), and no study row priced them. Without them the base has **393** and would be **14th**, level with SLOG (computed).
3. **The rows that are in sit close together, closer than the count is sure.** All 24 lie between 381 and 417 rules. Each count has a low and a high bound, and the base's own run from 304 to 502. Counted on the mechanisms that differ only, the base has **more rules than MIN-P, MIN, MIN-TS and RUST at every bound** (computed). Against the other 20 rows in, the order can go either way. BUY, V4, OBJ and LANE have fewer rules than the base at every bound, and all four fail MUSTs.
4. **Counting borrowed machinery does not push TiKV's shape down.** TiKV-persisted has 384 rules, 5th of the rows in and 3 behind MIN-P (computed). That count includes two-phase commit (29), the timestamp oracle (10), the multi-version store (10), the LSM (23, 20 of them a library's), closed timestamps (9) and split and merge (23). Those are 104 rules that rule 3 scored as 0 novel. But the row also does without the saga's intents (30), client sessions (14), the journal (16), the dir lease (18) and slot moves with their table, numbers and policy (21): 99 rules. So this count does not back V5-1's rejection of TiKV's shape on its own. V5-1's other ground still stands. The uses a log gives for free show up in TiKV's shape only as open MUSTs: 121, against 97 predicted for the base. Neither rule 3 nor this count prices an open MUST.
5. **Among the rows V5-1 keeps, MIN-P (381) and MIN, MIN-TS and RUST (383) have the fewest rules.** The base without answer stages has 12 more than MIN-P. Each of the 12 comes from one of the owner's choices (computed, `diff BASE-ack MIN-P`):
   - `par` repair, +6. It meets F-22 ([E-37]).
   - The soft directory, +12 (V5-3).
   - Healing by each group's own leader, with the platform's hints kept at the leaders, −2 against `#meta`'s central loop with its own hint path (23 rules against 25).
   - The settings, group records, version and credentials kept in each resource's own log instead of `#meta`, −4 (V5-2).
6. **What it means for V5-6.** The measure neither overturns the base nor picks it. At this grain the rows that keep the log as the truth sit within about 36 rules of each other, and the count is not sure to that. It is sure of one thing: the base has more rules than MIN-P's plain family, and each rule of that gap comes from a choice the owner made. So the choice among these rows rests on what their rules buy, as V5-1 to V5-5 argue, not on the count. For the count to decide, the reasoned rules need models: they are 148 of the base's 405.
7. **Against rule 3** (section 4). The plain MIN rows rise: MIN-P goes from 10th to 1st. The rows with the `memory` rung fall: COMP2 from 7th to 20th, TiKV-TS from 2nd to 18th. Rule 3 had counted the rung's 14 rules as one mechanism that is not novel.
8. **A skeptic checked this page** (section 6). It found three errors that each hit a whole family of rows: the controller rows got the platform's hints for free, the borrowed LSM was counted more coarsely than fero's own journal, and the base left out 3 credential rules it moved to the operator. All three are fixed here, with the skeptic's other eleven findings.

## 1. The question and the measure

### 1.1 Why a new measure

- **Rule 3** ranks the rows still in: the fewest novel mechanisms first, then the most SHOULDs met, then the fewest interacting pairs ([VERDICT 1](VERDICT.md#1-the-question-and-the-rule)).
- **What it misses.** A borrowed mechanism counts 0 novel, and one item among the pairs, whatever its size. Two-phase commit, a timestamp oracle, and split and merge each count 0 (V5-1).
- **The owner's measure** (V5-6): every rule a builder must get right, borrowed or not. A rule fero takes from a library still has to be right, and fero still has to drive it right.

### 1.2 The grain

- **A rule counts** when a builder must write it, and dropping it or getting it wrong breaks a stated property: safety, or a stated liveness or speed bar. One guard, one state update, or one comparison that carries correctness. This is REQUIREMENTS DEV-10 (c), the test the study's models used: "a rule counts when dropping it lets TLC find a counterexample" ([REQUIREMENTS.md](REQUIREMENTS.md)).
- **Not counted:** logging, metrics, config plumbing, and choices that only change speed and cannot break a property.
- **One grain everywhere.** Each record without a model was matched to the model counts below, rule by rule ([simplicity.json](judging/simplicity.json) `about`).

### 1.3 The anchors: the counts models made

These are the counts experiments made by ablation: model-checked, except E-21's, which ablated on seeded simulations. They set the grain. Where a model counted rules that belong to another record's state, the rules sit in that record (section 1.4), so the last column can be smaller than the model's count.

| Model | What it counted | Model's count | Held here |
|---|---|---|---|
| [E-14b] and [E-14c] | Raft membership on commit | 16 | `raft-config` 15. "Grow first" is written by the healer, so it sits there. |
| [E-16] | healing by each group's leader | 14 | `healing-self` 14; the base's per-resource form 15 (one reasoned rule added, section 3) |
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
| [E-33] | the restore mark; founding by a conditional create; founding by one `fero init` | 8; 4; 3 | `restore-mark` 5 (3 in their homes); 4; 3 |
| [E-31] | subscribe | 26 (27 with a move's segment names) | `subscribe` 26 |
| [E-37] | disk incarnation; `par` repair | 2; 7 | 1 (its ghost rule is `raft-config`'s); 6 (its checksum check is `disk-incarnation`'s) |

[E-15]'s slot move with unclean recovery, cancel and abort is 31. The base moves slots crash-only with no give-up, so 28 is the anchor. `slot-move`'s high bound (21) prices a give-up path.

### 1.4 Bundles: one model, several records

- **The problem.** A model often counts rules that guard another record's state. E-17c's slot move counts the dedup guard, the fence check and five read rules. Those are also the dedup option's, `fence-tokens`' and `subscribe`'s rules. Counted in both places, a row would pay them twice.
- **The rule used.** Each rule is counted once, in the record that owns the state it guards or writes. Each bundle's record names where every one of its model's rules went. Example: the slot move's 28 are `slot-table` 3 + `slot-sequence` 2 + `slot-move` 13, plus `write.dedup` and `refuse.dedup` (the dedup option), `write.fence` (`fence-tokens`), `refuse.stale` (`writer-judging`), and the five read rules (`subscribe`).
- **One exception: the five read rules land on four.** E-17's `read.after` and `read.next` are both E-31's `gotrec.is`, so `subscribe` holds them as one rule. In a row, the slot, lanes, re-key and split bundles therefore each sum to one less than their model's count: the slot move gives 27, not 28.
- **`row_minus`.** A few records hold a rule some rows do not need. An example is a carry rule in a row whose partitions never move. The record names those rows, and the row's sum subtracts it ([simplicity.json](judging/simplicity.json), `row_minus`).

### 1.5 Records without a model

- **Counted from a spec.** The Raft core, 65 rules across eight records, from etcd's TLA+ spec and `raft.go` (etcd raft v3.7.0-rc) and the Raft paper's Figure 2. The Kafka in-sync records, from Kafka's replication TLA+ spec. The loglet records (BookKeeper's shape), from a BookKeeper TLA+ spec. Closed timestamps (9), from CockroachDB's follower-reads RFC.
- **Counted from code.** v4's kernel, 160 rules across 14 records, from [kernel/](../../kernel), `shell/runtime.ts` and `api/index.ts`. The dir lease (18: 12 from v4's lock of V4-59, 6 reasoned). The soft directory (12: 9 from v4's [api/directory.ts](../../api/directory.ts), 3 reasoned from V5-3). Two-phase commit (29, as [E-47]'s model writes TiKV's steps; Percolator from memory). The timestamp oracle (10, PD's `tso.go`). Queue claims and consumer groups.
- **Reasoned.** The journal (16), the object-store tier (10), the `memory` rung (14), answer stages (12: 5 model-checked in [E-48], 7 reasoned), the per-resource records, the controller's hint path (2), and the platform records. The LSM (23) and the multi-version store (10) are reasoned from memory: no experiment ran an LSM.
- **The bought log.** `outside-log` is 110 rules: 14 of fero's glue (from [E-44]'s code) and 96 of JetStream's own. JetStream's Raft part is mapped from nats-server's `raft.go` (read in this pass). Its stream, consumer, meta and store rules are from memory.
- **Mixed records.** A record whose rules come from more than one basis splits its count by rule (`basis_split`). Its label is the larger part. The basis totals on this page are by rule.
- **Bounds.** Every record has a low and a high count beside its count, wherever the grain or the source is uncertain. An LSM, for example, runs from 10 to 30.

### 1.6 Who owns the code

- **fero**: fero writes it, ported or not.
- **library**: a library fero imports and does not write. The Raft core and `raft-config` in the eight rows on raft-rs or Go's etcd raft (RUST, SRV, PD, EMB-V8, SIDE, SRV V=full Y=fwd, PD+fix, TiKV-persisted). 20 of the LSM's 23 rules in the four PD rows (its disk reserve is TiKV's own code, so fero's).
- **outside**: another system. JetStream's 96 rules, and the `none` rung, in BUY. In the base, the 3 credential rules that move to the operator or fero deploy's platform.
- Borrowed rules count the same as fero's own. The owner column shows who must get them right, not whether they count.

### 1.7 How a row is summed

- **The rows.** A row's mechanisms come from `tools/closure.py`: each of the 31 judged rows carries a mechanism when closure's `carries()` says so. That rule reproduces the settled lists with 0 mismatches (computed: `python3 tools/closure.py check-mech`). One record rides on another: `controller-hints` (DEP-17's hint path at a controller) is carried wherever `controller-commands` is, since closure's catalogue folds it into the controller's loop (RM-05).
- **The sum.** A row's rules are its mechanisms' counts, less each one's `row_minus` for that row. Low and high are summed the same way.
- **The base.** It is added in three lines. BASE is the list in [simplicity.json](judging/simplicity.json) `base`. BASE+dormant adds dormant groups. BASE-ack drops answer stages, which no study row priced. The tool checks that the list is MIN's vector with `Z par` and `C self`, with exactly the swaps section 3 lists.
- **Calibration.** Each record was counted once, in one of five counting passes; the base's new records came from a sixth. A calibration pass then took out rules counted twice across records. For the base that moved 426 to 402. Its notes are in [simplicity.json](judging/simplicity.json) `calibration`.
- **The skeptic check.** A last pass recounted the largest records from their sources and tried to break the result. Its 14 findings are all applied (section 6). For the base that moved 402 to 405. Each changed record says so in a `CHECKED:` note.
- **Pairs.** A `@per-resource` record holds the same rules as its study record, give or take the ones its note names. So does `slow-leader-self` with `slow-leader-controller`. When the tool compares two rows (`diff` and the footer), such a pair cancels to the fixed difference of its counts, instead of letting each side err on its own.

## 2. The ranked table

Computed: `python3 tools/simplicity.py` (run from `docs/v5-space`).

```
Simplicity: every rule a builder must get right, borrowed or not (judging/simplicity.json). Ranked by rules (the mid
  count). # = place among all 34 lines. in = place among the 24 judged rows that fail no MUST on the frame (for a
  base line, where it would fall among them).
Rule 3 beside it, as closure.py scores it, on the frame: restated, DATA-01 loose, JetStream's default test line
  accepted as a loss. novel = novel mechanisms, S = SHOULDs met, pairs = interacting pairs, open = MUSTs left open
  (neither measure counts them), r3 = rule 3's place among the same 24 rows.

  #  in  row                      rules   low  high   fero   lib outside  mechs | novel   S pairs  open  r3
  1   -  BUY                        177   142   288     77     0     100     10 |     0   2    12    96  out: 27 MUSTs
  2   -  V4                         229   165   277    229     0       0     24 |     8   2    52    64  out: 50 MUSTs
  3   -  OBJ                        268   206   343    268     0       0     38 |     2   1   144   111  out: 7 MUSTs
  4   -  ISR                        358   264   441    358     0       0     46 |     2   1   214   117  out: 3 MUSTs
  5   -  LANE                       367   279   449    367     0       0     47 |     3   5   232    96  out: 3 MUSTs
  6   -  PD                         373   260   472    273   100       0     48 |     0   4   218   118  out: 2 MUSTs
  7   1  MIN-P                      381   291   477    381     0       0     49 |     3   5   252    97  10
  8   2  MIN                        383   293   478    383     0       0     49 |     4   5   253    97  11
  8   2  MIN-TS                     383   293   478    383     0       0     49 |     4   5   253    95  11
  8   2  RUST                       383   293   478    303    80       0     49 |     4   5   253    98  11
 11   5  TiKV-persisted             384   270   487    284   100       0     49 |     0   5   233   121  1
 12   6  SRV V=full Y=fwd           386   294   482    306    80       0     50 |     4   5   259   103  15
 13   7  LEAN                       387   295   482    387     0       0     49 |     4   5   255    97  14
 13   7  MIN-P+par                  387   297   485    387     0       0     50 |     3   6   264    96  4
 13   7  MIN-P+par V=full           387   297   485    387     0       0     50 |     3   6   264    96  4
 16  10  SRV                        388   295   486    308    80       0     51 |     4   5   267   103  17
 17  11  EMB-V8                     390   295   489    310    80       0     52 |     4   5   269   100  19
 17  11  RLOG                       390   297   487    390     0       0     51 |     4   5   268    97  18
 19  13  MIN-P+par C=cent V=full    391   299   490    391     0       0     51 |     3   6   269    97  6
 20 ~14  BASE-ack                   393   296   489    390     0       3     50 |    ~4  ~6  ~285   ~97  ~10
 20  14  SLOG                       393   301   485    393     0       0     50 |     5   2   272   118  24
 22  15  COMP                       394   299   493    394     0       0     50 |     3   5   283   100  21
 23  16  MIN-P+m                    395   299   494    395     0       0     50 |     3   5   264    99  16
 24  17  SIDE                       396   299   495    316    80       0     52 |     4   5   277   100  20
 25  18  PD+fix                     398   275   505    298   100       0     51 |     0   3   247   122  3
 25  18  TiKV-TS                    398   278   504    378    20       0     50 |     0   4   244   122  2
 27  20  COMP2                      401   305   502    401     0       0     51 |     3   6   277    99  7
 27  20  COMP2 V=full               401   305   502    401     0       0     51 |     3   6   277    99  7
 29 ~22  BASE                       405   304   502    402     0       3     51 |    ~4  ~6  ~285   ~97  ~10
 29  22  COMP+par C=cent V=full     405   307   507    405     0       0     52 |     3   6   282   100  9
 31   -  CELL                       406   307   494    406     0       0     49 |     4   5   277   100  out: 5 MUSTs
 32 ~23  BASE+dormant               409   307   507    406     0       3     52 |    ~4  ~6  ~285   ~97  ~10
 33  23  DRAFT                      410   310   510    410     0       0     52 |     5   5   309   100  23
 34  24  SPLIT                      417   315   514    417     0       0     53 |     4   5   295   102  22

~ The base is no judged row. Its rule-3 numbers are those of its option vector (MIN with Z par and C self),
  predicted by closure.py with 3 guessed cells (SC-03 M, SC-10 M, F-12 M). The per-resource records, the soft
  directory and ack stages are not in its catalogue. Its "in" and r3 are where it would fall among the judged rows
  in.

At the bounds, place among the rows in, with every record at its low count / mid / every record at its high count:
  BASE 20 / 22 / 18; BASE+dormant 22 / 23 / 22; BASE-ack 12 / 14 / 13.
  Judged rows in whose place moves by more than 5 between low, mid and high: TiKV-persisted 1 / 5 / 11;
    SLOG 19 / 14 / 7; PD+fix 2 / 18 / 21; TiKV-TS 3 / 18 / 20.

Each line less BASE, on the mechanisms that differ (shared records cancel; each record free between its own low and
  high), mid [low..high]:
  fewer rules at every bound (8): BUY -228 [-333..-43]; V4 -176 [-304..-60]; OBJ -137 [-189..-72];
    LANE -38 [-71..-10]; MIN-P -24 [-36..-6]; MIN -22 [-34..-5]; MIN-TS -22 [-34..-5]; RUST -22 [-34..-5]
  more rules at every bound (0): none
  could go either way (23): ISR -47 [-115..+11]; PD -32 [-127..+50]; TiKV-persisted -21 [-106..+54];
    SRV V=full Y=fwd -19 [-38..+5]; LEAN -18 [-35..+2]; MIN-P+par -18 [-28..+0]; MIN-P+par V=full -18 [-28..+0];
    SRV -17 [-37..+9]; EMB-V8 -15 [-37..+12]; RLOG -15 [-35..+10]; MIN-P+par C=cent V=full -14 [-26..+5];
    SLOG -12 [-48..+24]; COMP -11 [-23..+5]; MIN-P+m -10 [-28..+11]; SIDE -9 [-31..+15]; PD+fix -7 [-103..+74];
    TiKV-TS -7 [-98..+71]; COMP2 -4 [-20..+17]; COMP2 V=full -4 [-20..+17]; COMP+par C=cent V=full +0 [-18..+22];
    CELL +1 [-40..+32]; DRAFT +5 [-20..+31]; SPLIT +12 [-35..+55]

Against rule 3, among the judged rows in (r3 -> in), moving 5 or more places:
  up: SLOG 24 -> 14; MIN 11 -> 2; MIN-P 10 -> 1; MIN-TS 11 -> 2; RUST 11 -> 2; SRV V=full Y=fwd 15 -> 6;
    EMB-V8 19 -> 11; LEAN 14 -> 7; RLOG 18 -> 11; SRV 17 -> 10; COMP 21 -> 15.
  down: TiKV-TS 2 -> 18; PD+fix 3 -> 18; COMP+par C=cent V=full 9 -> 22; COMP2 7 -> 20; COMP2 V=full 7 -> 20;
    MIN-P+par C=cent V=full 6 -> 13.

In no line: issue-order (3), timeline-merge (2). Added as A-10 and V5-4 say (issue-order on every line;
  timeline-merge on every line without a timestamp oracle (T tso)), they flip 3 pairs of lines and make or break 2
  ties; BASE then has 410 rules.
```

**How to read it.**
- **#** ranks all 34 lines by rules. **in** ranks only the 24 judged rows that fail no MUST on the owner's frame. For a base line it says where the line would fall among them.
- **low** and **high** add every record's low and high count. **fero**, **lib** and **outside** split the rules by who writes the code. **mechs** is the number of mechanisms.
- **The owner's frame** is VERDICT 11.6's: the clauses restated, DATA-01's loose reading, and JetStream's default test line accepted as a loss. With `--strict` (DATA-01's strict reading), PD+fix, TiKV-TS, TiKV-persisted and both SRV rows go out too. 19 rows are left, MIN-P is first by rules, and the base would be 17th (BASE-ack 11th) (computed).
- **Rule 3's numbers** sit right of the bar, as closure.py scores them: novel mechanisms, SHOULDs met, interacting pairs, open MUSTs, and **r3**, rule 3's place among the same 24 rows. These r3 places are `repro rank --loss`'s. A base line's numbers carry `~`. They are its option vector's, predicted by closure.py with 3 guessed cells. Closure's catalogue has no per-resource records, soft directory or answer stages.
- **The footer** has four parts. The base's place at the bounds. The base against every other line, with each record free between its bounds. The rows that move most against rule 3. And what the two records in no line would do (sections 4 and 6).

## 3. The base row in full

### 3.1 Its 51 mechanisms

Computed: `python3 tools/simplicity.py row BASE`. The areas are the tool's own grouping, so a row can be read by what its rules do. "Basis" is the record's label, the larger part where its rules mix bases: `healing-self@per-resource` is E-16's 14 model-checked rules plus one reasoned. The totals under the table are by rule.

| Mechanism | Rules | Low to high | Basis | What it is |
|---|---|---|---|---|
| **Raft** | **80** | **63 to 93** | | |
| `raft-term-vote` | 17 | 14 to 18 | spec | each copy's term and vote: one vote a term, and who may lead |
| `raft-config` | 15 | 14 to 16 | model-checked | membership changes, applied on commit (joint consensus) |
| `raft-log` | 10 | 8 to 12 | spec | the ordered entries, and how a follower matches the leader |
| `raft-snapshot` | 10 | 7 to 11 | spec | snapshots, and catching up from one |
| `raft-commit` | 8 | 6 to 10 | spec | the commit index |
| `raft-prevote-checkquorum` | 7 | 5 to 9 | spec | PreVote and CheckQuorum |
| `raft-leader-transfer` | 6 | 4 to 7 | spec | handing the lead to a named copy |
| `raft-readindex` | 4 | 3 to 6 | spec | reads served without a log write (ReadIndex) |
| `learners` | 3 | 2 to 4 | spec | copies that follow but do not vote |
| **many groups** | **14** | **10 to 18** | | |
| `quiet-groups` | 7 | 5 to 8 | reasoned | an idle group stops its heartbeats |
| `link-pings` | 4 | 3 to 5 | reasoned | one ping per pair of machines, not per group |
| `slow-leader-self` | 3 | 2 to 5 | reasoned | a leader that lags hands the lead on by itself |
| **control** | **68** | **44 to 81** | | |
| `healing-self@per-resource` | 15 | 14 to 16 | model-checked | each group's leader replaces lost copies (E-16's 14, plus a stored placement) |
| `cluster-credentials@per-resource` | 12 | 6 to 12 | reasoned | the handshake's checks (9); the CA, tokens and revocations (3) move to the operator |
| `soft-directory` | 12 | 5 to 14 | code | v4's `#directory` across machines: servers announce, a client looks up once |
| `meta-directory@per-resource` | 8 | 5 to 8 | reasoned | each group's record, in the resource's home log |
| `planner-hints@per-resource` | 5 | 3 to 7 | reasoned | the platform's drains and hints, sent to the leaders |
| `cluster-version@per-resource` | 5 | 3 to 6 | reasoned | the protocol version, in the home log |
| `meta-catalog@per-resource` | 5 | 3 to 6 | reasoned | the settings record, in the home log |
| `genesis-conditional-create@per-resource` | 4 | 4 to 9 | model-checked | a resource's first open founds it, by create-if-absent |
| `meta-members@per-resource` | 2 | 1 to 3 | reasoned | a leaving machine says "retiring" first, and gets no new copies |
| **partitions** | **21** | **16 to 36** | | |
| `slot-move` | 13 | 11 to 21 | model-checked | export, import, fence, copy and open a slot |
| `move-policy` | 3 | 0 to 5 | reasoned | when to move a slot, and when to shrink |
| `slot-table` | 3 | 3 to 7 | model-checked | which group holds which slot |
| `slot-sequence` | 2 | 2 to 3 | model-checked | the last sequence number per slot |
| **writes** | **50** | **36 to 65** | | |
| `client-sessions` | 14 | 13 to 16 | model-checked | a retried write applies once |
| `ack-stages` | 12 | 8 to 13 | reasoned | answers at `received` or `replicated` (V5-5) |
| `caller-keys` | 8 | 7 to 12 | reasoned | idempotency keys for calls |
| `writer-judging` | 6 | 2 to 9 | reasoned | conditions, ops, claims and batches judged at the one writer |
| `srchi-marks` | 5 | 5 to 6 | model-checked | a derived output keeps the source position it read to |
| `admission-credits` | 3 | 0 to 5 | reasoned | a credit window on the client link |
| `route-forward` | 2 | 1 to 4 | reasoned | any server forwards a write to the leader |
| **time** | **6** | **6 to 8** | | |
| `writer-time` | 6 | 6 to 8 | model-checked | the leader's clock, held to the members' median |
| **transactions** | **38** | **38 to 42** | | |
| `saga-intents` | 30 | 30 to 31 | model-checked | an intent row per saga, carried on or undone |
| `lock-rows` | 6 | 6 to 8 | model-checked | locks with leases |
| `fence-tokens` | 2 | 2 to 3 | model-checked | a lock's token, checked where it writes |
| **storage** | **60** | **42 to 76** | | |
| `dir-lease` | 18 | 12 to 22 | code | one process per data folder: a lock with a lease |
| `journal` | 16 | 10 to 18 | reasoned | one journal per process, with group commit |
| `tier` | 10 | 6 to 13 | reasoned | old segments and snapshots in the object store |
| `par-repair` | 6 | 6 to 8 | model-checked | a damaged entry is fetched again from a peer |
| `restore-mark` | 5 | 5 to 6 | model-checked | epochs and sessions never go back after a restore |
| `none-rung` | 4 | 2 to 6 | reasoned | best-effort pub/sub, never written to the log |
| `disk-incarnation` | 1 | 1 to 3 | model-checked | a checksum on every entry finds damage |
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
| **Total** | **405** | **304 to 502** | | 51 mechanisms; 402 rules written by fero, 3 by the operator |

By basis, by rule: model-checked 157, reasoned 148, spec 65, code 35 (computed). One record's basis is looser than its label: `writer-time` says model-checked, but E-21 ablated it on seeded simulations, not on every state.

### 3.2 What the owner's decisions changed

The base starts from the closure tool's MIN row with `Z par` and `C self`. The decisions then change these records (reasoned in [simplicity.json](judging/simplicity.json) `base.decisions`; each count is in its record).

| Record | In the study's form | In the base | Why |
|---|---|---|---|
| members | `meta-members` 5 | 2 | V5-2, V5-3. The joiner's record becomes the soft directory's announcement. The cluster-wide gone mark goes: each leader's own links decide gone. "Retiring first" stays, held by the leaver. |
| catalogue | `meta-catalog` 6 | 5 | V5-2 (2). The same rules on the settings record in the resource's home log. "Create only if none exists" moves to genesis. |
| group records | `meta-directory` 8 | 8 | V5-2 (2). They move to each resource's home log. The soft directory cannot hold them: it keeps no log and decides nothing. |
| healing | `healing-self` 14 | 15 | V5-2 (3), [E-16]. One reasoned rule: write the chosen machine into the group's log before the add. With no shared member list, two leaders can rank machines differently. |
| planner hints | `planner-hints` 5 | 5 | DEP-17 is a MUST: the platform's drains, retirements and hints land at the leaders, as in the study's `self` rows. In a controller row the same path is `controller-hints` (2). |
| founding | `genesis-conditional-create` 4 | 4 | V5-2 (5). Each resource's first open is its genesis, by a create-if-absent in the object store. |
| version | `cluster-version` 5 | 5 | In each resource's home log. |
| credentials | `cluster-credentials` 12 | 12 (9 fero, 3 outside) | An open choice. The CA, join tokens and revocations move to the operator or fero deploy, and fero keeps the handshake checks. The moved rules still count. Keeping the PKI in fero is the same 12, all fero's. |
| dormant groups | `dormant-groups` 4 | 0, or 4 in BASE+dormant | Only for SC-13's 100,000 resources ([E-36]). The owner set no number yet (V5-2). |
| soft directory | none | 12 | New (V5-3). Ported from v4's `#directory` (9 rules it has today), with seeds across machines, the machine announcement healing needs, and a client that asks it only once (3 reasoned). |
| answer stages | none | 12 | New (V5-5, [E-48]). W1's four parts and Y are model-checked; the other 7 come from MEMORY 9.4. |

Net: −3, −1, 0, +1, 0, 0, 0, 0, −4, +12 and +12, so the decisions add 17 rules to the 388 of the same options with the study's records (arithmetic on this table).

- **Kept as they were.** Only their home moves, from `#meta` to the resource's home log: the slot table, slot moves, the move policy, forwarding, the restore mark and forks. The home leader is the one mover, so the move policy needs no lease.
- **Gone with no replacement:** the central loop (`controller-commands` 18) with its hint path (`controller-hints` 2) and its slow-leader rule (3), and project groups (2). The base's vector never carried them, since its `C` is `self` and its `G` is `shard`. They are what MIN-P+par carries in their place.
- **Every write commits at `persisted`** (V5-5). The `memory` rung (14) is not in the base. It comes third, only for a timed need.
- **Presence** shares the one session registry with client sessions, so `presence-rows` counts 6, not 7, in the base and in every `sess` row.

### 3.3 Against MIN-P+par, the row the decisions start from

Computed: `python3 tools/simplicity.py diff BASE MIN-P+par`.

```
BASE: 405 rules (51 mechanisms). MIN-P+par: 387 rules (50 mechanisms).
BASE less MIN-P+par: +18, and +0 to +28 at the low and high counts of the mechanisms that differ.

Only in BASE (4 mechanisms, 44 rules, low 30, high 50):
    15  model-checked  fero                   healing-self@per-resource
    12  reasoned       fero                   ack-stages
    12  code           fero                   soft-directory
     5  reasoned       fero                   planner-hints@per-resource

Only in MIN-P+par (3 mechanisms, 22 rules, low 18, high 26):
    18  model-checked  fero                   controller-commands
     2  reasoned       fero                   controller-hints
     2  reasoned       fero                   project-groups

In both, counted, owned or keyed differently (7; a pair under two keys holds the same rules):
  BASE cluster-credentials@per-resource 12 (fero 9/outside 3); MIN-P+par cluster-credentials 12 (fero)
  BASE cluster-version@per-resource 5 (fero); MIN-P+par cluster-version 5 (fero)
  BASE genesis-conditional-create@per-resource 4 (fero); MIN-P+par genesis-conditional-create 4 (fero)
  BASE meta-catalog@per-resource 5 (fero); MIN-P+par meta-catalog 6 (fero)
  BASE meta-directory@per-resource 8 (fero); MIN-P+par meta-directory 8 (fero)
  BASE meta-members@per-resource 2 (fero); MIN-P+par meta-members 5 (fero)
  BASE slow-leader-self 3 (fero); MIN-P+par slow-leader-controller 3 (fero)
```

- Answer stages +12 and the soft directory +12 are new.
- Healing by each leader comes with its hints and its slow-leader rule: 15 + 5 + 3 = 23. The central loop comes with its own hint path, its own slow-leader rule and project groups: 18 + 2 + 3 + 2 = 25. So −2. E-16 found healing by each leader smaller than the loop (14 against 18). With the platform's hints priced on both sides (DEP-17), it stays smaller, by 2.
- The records in each resource's own log come to 2 + 5 + 8 + 4 + 5 + 12 = 36. `#meta`'s come to 5 + 6 + 8 + 4 + 5 + 12 = 40. So −4.
- Net +18. Without answer stages, +6. Counted with each pair cancelling, the base has at least as many rules as MIN-P+par at every low and high count (+0 to +28).

### 3.4 With and without the variants

| Line | Rules | Low to high | Place among the 24 rows in |
|---|---|---|---|
| BASE | 405 | 304 to 502 | would be 22nd |
| BASE+dormant | 409 | 307 to 507 | would be 23rd |
| BASE-ack | 393 | 296 to 489 | would be 14th |
| BASE with issue-order and timeline-merge | 410 | | |

All computed. `issue-order` (3: each writer numbers its writes, AMENDMENTS A-10) is owed by every row, and the base needs it for answer stages too. `timeline-merge` (2, V5-4's viewer) is owed by every row without a timestamp oracle. Neither is in any line. Added as owed, they flip 3 pairs of lines (MIN, MIN-TS and RUST against TiKV-persisted, which has an oracle and so owes no viewer rules) and make 2 ties (SIDE with PD+fix and with TiKV-TS). No line moves past the base.

## 4. What changes against rule 3

Among the 24 judged rows in on the owner's frame. "r3" is rule 3's place and "rules" the place by rules (computed: the table in section 2).

| Row | r3 | Rules | By rules | Why it moves |
|---|---|---|---|---|
| MIN-P | 10 | 381 | 1 | nothing large; rule 3 held its 3 novel and 5 SHOULDs against it |
| MIN, MIN-TS, RUST | 11 | 383 | 2 | the same; their 4th novel mechanism is dormant groups, 4 rules (for project groups, 2) |
| TiKV-persisted | 1 | 384 | 5 | stays near the top: its 104 rules of TiKV machinery replace 99 of the log-first rows' |
| SRV V=full Y=fwd | 15 | 386 | 6 | MIN plus a worker map 4, with `fero init` (3) for the conditional create (4); its Raft is a library's, which still counts |
| LEAN | 14 | 387 | 7 | MIN with a standby fold (8 for 4) |
| MIN-P+par, MIN-P+par V=full | 4 | 387 | 7 | MIN-P plus `par`, 6. Under rule 3 that bought a SHOULD (F-22); simplicity counts no SHOULDs |
| SRV | 17 | 388 | 10 | SRV V=full Y=fwd plus smart clients, 2 |
| RLOG | 18 | 390 | 11 | MIN plus the writer epoch on log members 6 and a tenant budget 2, with `fero init` for the conditional create |
| EMB-V8 | 19 | 390 | 11 | MIN plus a worker map, smart clients and a tenant budget (8), with `fero init` for the conditional create |
| MIN-P+par C=cent V=full | 6 | 391 | 13 | MIN-P+par plus controller sessions 6, less 2 of the member records |
| SLOG | 24 | 393 | 14 | rule 3 sank it on 2 SHOULDs and 5 novel; by rules it is middling |
| COMP | 21 | 394 | 15 | MIN-P plus the `memory` rung 14, with healing by each leader and its hints (19) for the loop and its hint path (20) |
| MIN-P+m | 16 | 395 | 16 | MIN-P plus the `memory` rung, 14 |
| SIDE | 20 | 396 | 17 | MIN with a leader fold (8 for 4), a worker map 4, the local seam 3 and leader calls 2 |
| TiKV-TS | 2 | 398 | 18 | TiKV-persisted plus the `memory` rung, 14 |
| PD+fix | 3 | 398 | 18 | TiKV-persisted plus the `memory` rung 14, a worker map 4 and smart clients 2, less `par` 6 |
| COMP2, COMP2 V=full | 7 | 401 | 20 | MIN-P+par plus the `memory` rung, 14 |
| COMP+par C=cent V=full | 9 | 405 | 22 | COMP2 plus controller sessions 6, less 2 of the member records |
| DRAFT | 23 | 410 | 23 | COMP with a dedup window (19) for client sessions (14), log replicas 7, dormant groups 4 and a tenant budget 2; `fero init` (3) for the conditional create (4), no project groups (−2) and presence +1 |
| SPLIT | 22 | 417 | 24 | DRAFT with split, merge, lineage and the split policy (29) for slot moves with their table, numbers and policy (21); `subscribe` is 1 less, with no slot moves to carry |
| BASE (predicted) | ~10 | 405 | ~22 | answer stages 12 and the soft directory 12 |

**Why.**
- **Rule 3 counted a mechanism as one item.** The `memory` rung is 14 rules (reasoned). Rule 3 counted it 0 novel and a few pairs. So the rows that carry it and sat high under rule 3 fall 13 to 16 places: TiKV-TS, PD+fix, COMP2, COMP2 V=full and COMP+par C=cent V=full.
- **Novel and small, or borrowed and big.** Rule 3 weighed dormant groups (4 rules) the same as the dir lease (18), and gave two-phase commit (28) nothing. By rules the plain MIN rows rise, because their novel mechanisms are small.
- **The big borrowed mechanisms.** The Raft core and membership, 80 rules in every Raft row (a library's in 8 rows). TiKV's machinery: two-phase commit 29, the oracle 10, the multi-version store 10, the LSM 23, closed timestamps 9, split and merge 23. The `memory` rung 14. The central loop 18. JetStream's 96 in BUY. All count now.
- **TiKV's shape stays near the top anyway** (section 0 item 4): 5th, 3 rules behind MIN-P. What it adds is matched by what it drops: no sagas, no sessions, no journal, no dir lease, no slot moves.
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
| `journal` | 16 | 10 to 18 | reasoned | 22 judged rows and the base |
| `raft-config` | 15 | 14 to 16 | model-checked ([E-14b], [E-14c]) | 28 judged rows and the base |
| `healing-self@per-resource` | 15 | 14 to 16 | 14 model-checked ([E-16]), 1 reasoned | the base |
| `memory-rung` | 14 | 8 to 17 | reasoned | 10 judged rows |
| `client-sessions` | 14 | 13 to 16 | model-checked ([E-20]) | 20 judged rows and the base |

### 5.2 Where the rules go, by area

Computed: `python3 tools/simplicity.py row NAME`, its "By area" line.

| Area | BASE | MIN-P+par | COMP2 | TiKV-persisted |
|---|---|---|---|---|
| Raft (core and membership) | 80 | 80 | 80 | 80 (a library's) |
| many groups (pings, quiet groups, the slow-leader rule) | 14 | 16 | 16 | 14 |
| control (healing, metadata, directory, founding, credentials) | 68 | 60 | 60 | 63 |
| partitions (slots and moves, or ranges with split and merge) | 21 | 21 | 21 | 23 |
| writes (judging, retries, routing, answers) | 50 | 38 | 38 | 24 |
| time (writer time, or the oracle) | 6 | 6 | 6 | 10 |
| transactions (the saga, or two-phase commit and versions) | 38 | 38 | 38 | 45 |
| storage (journal, tier, rungs, the dir lease, repair) | 60 | 60 | 74 | 44 |
| reads (folds, subscribe, closed timestamps) | 37 | 37 | 37 | 49 |
| platform (groups, presence, queues, forks, the recorder) | 31 | 31 | 31 | 32 |
| **Total** | **405** | **387** | **401** | **384** |

- **Raft is about a fifth of every Raft row:** 65 rules from etcd's spec and the Raft paper, plus the 15 model-checked membership rules. Whether fero ports it (the base) or imports it (RUST, TiKV-persisted), the 80 count.
- **The saga with fenced locks is the largest model-checked piece:** 38 rules ([E-24]). Two-phase commit in TiKV's shape is 29, plus the multi-version store's 10. They come out close.
- **The slot move is 18 rules here** (21 with the move policy), and 28 with the 10 rules it shares with dedup, fences and reads ([E-17c]). Split and merge with lineage are 26 here, and 37 in all. Re-key is 24.
- **Where the base and TiKV's shape differ.** The base pays more in writes: client sessions 14 and answer stages 12, where TiKV's transactions carry their own ids. It pays more in storage: a journal 16, a dir lease 18 and the restore mark 5, against an LSM 23. TiKV's shape pays more in reads (closed timestamps 9, lease reads 4) and in transactions (two-phase commit and versions with lock rows, 45, against the saga's 38). It also pays more in time (the oracle 10, against writer time's 6).
- **v4's kernel is 160 rules over 14 records** (code). Its membership by ballot alone is 38, more than Raft's election and membership on etcd (17 + 15). V4 has 229 rules, the fewest of any home-made row, but it fails 50 MUSTs.

## 6. How sure

**Where the counts come from** (by rule, where a record mixes bases).
- **The base:** 157 rules model-checked (39%), 65 counted from a spec (16%), 35 counted from code (9%), and 148 reasoned (37%) (computed, `row BASE`).
- **The whole catalogue:** 1,120 rules in 123 records. 292 are model-checked, 127 counted from a spec, 252 counted from code, and 449 reasoned. By label the records are 29 model-checked, 16 spec, 22 code and 56 reasoned.
- **Who counted.** One counter per record, then one calibration pass, then one skeptic who recounted the largest records from their sources. DEV-10 (e) asks for two counters on their own, as [MECHANISMS.md](MECHANISMS.md)'s catalogue had. This count had no second blind counter.

**What the skeptic found.** The errors it found ran by family of rows, not at random, and those are the ones that move places. All are fixed on this page:
- **The controller rows got the platform's hints for free.** DEP-17 is a MUST, and RM-05 puts a controller row's hints in the controller's loop, but no record held those rules. They are now `controller-hints` (2), in all 24 controller rows. The admin-key rule was also counted twice, in the hints and in the credentials, and `#meta`'s planner lease is no rule (two planners only waste moves). Alone, this fix moved the base from 22nd to 20th (the skeptic's arithmetic).
- **The borrowed LSM was counted more coarsely than fero's own journal.** AMENDMENTS A-09 puts the disk reserve and "a short write means ask again" on every row. The journal counted them; the LSM left them in its high. It now counts them, with RocksDB's directory fsync and its store lock: 17 became 23. Alone, this put MIN-P first, one rule ahead of TiKV-persisted (the skeptic's arithmetic).
- **The base dropped the 3 credential rules it moves to the operator.** The measure counts borrowed and outside rules (JetStream's 96 in BUY). They now count as outside rules. Alone, this moved the base from 22nd to 23rd (the skeptic's arithmetic).
- **Smaller ones:** two v4 directory rules the soft directory left out (+2); a call key's lease lapse that is `writer-time`'s (−1 in every row); a rollback record two-phase commit left out (+1 in the PD rows); stale bounds in some notes; and the basis split by rule.
- **What it did not find:** a count off by more than its own low or high. It recounted the Raft core, the slot bundle, the saga, two-phase commit, the oracle, the versions, subscribe, v4's lanes, answer stages and the dir lease from their sources.

**The bounds.**
- **If every count errs the same way,** the base stays near the bottom. With every record at its low, then mid, then high count, the base is 20th, 22nd and 18th; BASE-ack 12th, 14th and 13th (computed).
- **TiKV's shape has the widest bounds.** TiKV-persisted goes 1st, 5th, 11th; PD+fix 2nd, 18th, 21st; TiKV-TS 3rd, 18th, 20th. Its LSM (10 to 30), two-phase commit (18 to 35) and multi-version store (6 to 13) are reasoned or from memory. SLOG goes 19th, 14th, 7th.
- **If each record may err its own way,** with each `@per-resource` record moving with its study record, one order still holds: the base has more rules than MIN-P, MIN, MIN-TS and RUST at every bound (computed, the footer of section 2). Against the other 20 rows in, the order can go either way. The rows in are at most 36 rules apart. The spread on what differs from the base is 28 to 177 rules (computed with the tool's `interval`).
- **So:** the order holds for big gaps, when all counts err together, and between the base and MIN-P's plain family. It does not hold between other neighbours.

**What the count leaves out.**
- **Open MUSTs.** A row is priced only for the mechanisms it carries. A MUST it leaves open may need a mechanism nobody has written yet. TiKV-persisted leaves 121 open, the base (predicted) 97, MIN-P+par 96. That is V5-1's ground against TiKV's shape, and this count does not see it.
- **Flags from calibration**, left as they are because they come from the closure tool's carries rule:
  - V4 carries no `dir-lease`, though v4 has the dir lock (V4-59, 12 of the lease's rules). V4 would have about 241.
  - SLOG carries neither `journal` nor `wal-per-group`, though its log nodes keep disks. It would have about 405 to 409.
  - `raft-config`'s ghost rule is fero's even on the library rows. One rule would move from library to fero there.
  - The one-box founding path (about 5 rules) sits in every row's high, not its count. It is the same in every row, so no place changes.
- **The base's rule-3 numbers** are predicted from its option vector, with 3 guessed cells (SC-03 M, SC-10 M, F-12 M).

**In short.**
- **High** that answer stages and the soft directory are why the base has more rules than MIN-P+par. Together they add 24, more than the whole gap of 18; the rest nets −6. At their low counts they still add 13.
- **High** that the base has more rules than MIN-P, MIN, MIN-TS and RUST: by 22 to 24 at the mid count, and by at least 5 at every bound. Every rule of that gap comes from an owner's choice (section 0 item 5).
- **Medium** that the base sits near the bottom of the rows in. It holds when the counts err together (18th to 22nd). Against the 20 rows other than MIN-P's family, it does not hold when each record errs its own way.
- **Low** on any other order between neighbours. The count is not sure to the gaps between them.
- **Low** on TiKV-persisted's place. It is 5th by its count and runs from 1st to 11th across the bounds. That rests on two-phase commit (never ablated), and on the LSM and the multi-version store, both from memory.

## 7. How to check

Run from `docs/v5-space`. Standard library only, no network. The tool is deterministic.

```sh
python3 tools/simplicity.py                       # section 2's table
python3 tools/simplicity.py --strict              # the same on DATA-01's strict reading
python3 tools/simplicity.py row BASE              # section 3.1
python3 tools/simplicity.py row MIN-P+par         # any row, largest record first
python3 tools/simplicity.py diff BASE MIN-P+par   # section 3.3
python3 tools/simplicity.py diff BASE-ack MIN-P   # section 0 item 5
python3 tools/simplicity.py diff BASE TiKV-persisted
python3 tools/closure.py check-mech               # the carries rule still gives the settled lists
```

To compare the r3 column with rule 3's own ranking, define `repro` as [candidates/README.md](candidates/README.md#reproduce-a-computed-claim) shows, then run `repro rank --loss`. The base's predicted numbers come from `repro row 'Z=par,C=self' MIN --loss`.

| Claim | Command | What it prints |
|---|---|---|
| the base has 405 rules, 22nd of 24 | `python3 tools/simplicity.py` | the BASE line: 405, in ~22 |
| 393 without answer stages, 14th | the same | the BASE-ack line: 393, in ~14 |
| MIN-P first by rules, TiKV-persisted 5th | the same | 381, in 1; 384, in 5 |
| the base has more rules than MIN-P's plain family at every bound | the same, footer | "fewer rules at every bound (8)": MIN-P, MIN, MIN-TS, RUST among them |
| 12 rules over MIN-P without answer stages | `diff BASE-ack MIN-P` | +12 |
| 18 rules over MIN-P+par | `diff BASE MIN-P+par` | +18 |
| TiKV's machinery and what it drops | `diff BASE TiKV-persisted` | the two "Only in" lists |
| the base by basis and by area | `row BASE` | its first three lines |

## 8. Sources

**Files used.**
- [judging/simplicity.json](judging/simplicity.json): the counts (123 records), the base and its decisions, and the calibration notes.
- [tools/simplicity.py](tools/simplicity.py): this page's tool. It imports [tools/closure.py](tools/closure.py) for the rows' options, the carries rule and rule 3's numbers.
- [judging/closure/axes.json](judging/closure/axes.json), [judging/closure/hybrids/cards.json](judging/closure/hybrids/cards.json), [judging/closure/mechanisms.json](judging/closure/mechanisms.json), [judging/mechanisms.json](judging/mechanisms.json): the 31 judged rows, their options and their mechanisms.
- [DECISIONS V5-1 to V5-6](../DECISIONS.md), [VERDICT 11.6 and 11.7](VERDICT.md#116-the-owners-answers-2026-11-12), [MECHANISMS.md](MECHANISMS.md), [REQUIREMENTS.md](REQUIREMENTS.md) DEV-10, [SPACE.md](SPACE.md), [MEMORY.md](MEMORY.md) 9.4, [AMENDMENTS.md](AMENDMENTS.md) A-10, [DESIGN-V5.md](../DESIGN-V5.md) 4.2.

**The models.** [E-14b], [E-14c], [E-15], [E-16], [E-17c], [E-20], [E-21], [E-24], [E-30], [E-31], [E-33], [E-36], [E-37], [E-44], [E-47], [E-48].

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
