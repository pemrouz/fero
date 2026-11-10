# Critic: the options no judged row holds

Written 2026-11-10 for the closure pass ([../README.md](../README.md)). The completeness critic's question: could a row that takes one or two options that no judged row holds rank above the frontier under rule 3, without failing a MUST, on evidence the study has or could cheaply get?

## 0. The answer in short

- **Nothing unheld can pass TiKV's shape on the novel count.** TiKV's shape with fixes (the far frontier, 0 novel / 4 SHOULDs / 225 pairs) beats every row with 2 or more novel mechanisms, whatever their SHOULDs. A slot row's three novel units (slot-move, restore-mark, dir-lease) come off only through held options (P `split`, T `tso` with D `txn`, S `lsm`). No unheld option removes one without failing a MUST (section 1.2).
- **One unheld option can pass TiKV's shape, on pairs only:** Y `proxy` takes it from 225 to 222 pairs. The margin is 3 pairs, inside the noise of an unchecked reads-and-writes list (VERDICT 3-S6).
- **Three unheld options can reorder the Raft rows (COMP2's tier).** This matters if TiKV's shape goes out in its own judging pass, or if the user answers VERDICT's choice 2 "better-tested first":
  1. **D `keys`** (one key table for fero's own retries; client sessions go): COMP2 3 / 6 / 274 becomes 3 / 6 / 264 to 266, or 4 / 6 / 271 if the counters call the key table a new novel unit. Either way rule 3 puts it above COMP2.
  2. **X `ramp` in E-24's `rampv` form** (the saga kept, RAMP reads with a version vector): the only unheld option that adds a SHOULD (P-15 S). COMP2 becomes 4 / 7 / 289 and beats every 3-novel row on SHOULDs, if the counters find only one new novel unit.
  3. **R `vsr`** (unknown): owed a costing by Q-37's own threshold and never costed. Best case 3 / 6 / 267, if PAR sits inside VSR's log unit and a port of TigerBeetle's core meets DEV-04 S. Worst case 3 / 5, below MIN-P+m.
- **Everything else is out.** It fails a MUST on proof the study already holds, or adds a novel unit, or changes nothing rule 3 looks at. Section 2 gives each option one line.
- **The tool cannot price unheld tags.** `mechrow` and `card` give wrong mechanism counts for them, because closure/mechanisms.json lists only held tags in its conditions (section 5). Every price below was made by hand with closure.py's own pair rule.

Ranked threats, and the one experiment each needs:

| Rank | Option | Changes | Experiment that settles it |
|---|---|---|---|
| 1 | D `keys` | COMP2's tier: about 10 fewer pairs (3 if the key table is a new novel unit) | Run E-32's dedup-and-fence crossing (the RR-05 case) with E-20's `keys-fwd` rules in place of `sess`, and pin the key table's bytes at DEP-21's three loads against DEP-13 |
| 2 | X `ramp` as `rampv` | COMP2's tier: +1 SHOULD (P-15 S), +1 novel, +15 pairs | Extend E-24's exhaustive RAMP model to versions that carry earlier units' effects (`push`, `incr`), with `rampv`'s vector and repeated round 2; check read atomicity and a bound on rounds, and ablate by DEV-10 |
| 3 | Y `proxy` | TiKV's shape: 3 fewer pairs | Price DEP-21 for TiKV's shape with the proxy inside its existing machines (E-41's floors, RR-06's machine count) |
| 4 | R `vsr` | COMP2's tier: up to 7 fewer pairs, or one SHOULD lost | Cost it as Q-37 says: two counters list a VSR row's units with reads and writes; the referee rules DEV-04 S for a port of TigerBeetle's core |

## 1. How an unheld option was priced

### 1.1 What rule 3 compares

Rule 3 ([REQUIREMENTS](../../../REQUIREMENTS.md), "Judging rule"): if two rows' novel counts differ by 2 or more, the lower wins. Otherwise more SHOULDs wins. Otherwise fewer interacting pairs wins. Open MUSTs are not counted.

The frontier in the restated reading ([ladder-restated.md](ladder-restated.md), [frontier.json](frontier.json)):

| Row | Novel / SHOULDs / pairs | Unjudged cells | SHOULDs met |
|---|---|---|---|
| MIN-P+m | 3 / 5 / 264 | 0 | P-22, SC-12, DEV-04, DEV-05, OPS-11 |
| COMP2 | 3 / 6 / 274 | 2 (F-22 M, S) | the five above, and F-22 |
| COMP2 V=full | 3 / 6 / 266 | 4 | as COMP2 |
| COMP+par C=cent V=full | 3 / 6 / 262 | 6 | as COMP2 |
| TiKV-TS (TiKV's shape with fixes) | 0 / 4 / 225 | 15 | P-15, SC-12, F-22, DEV-04 |

Two consequences:
- Rule 3 alone, with every predicted cell taken as given, puts TiKV-TS first. To pass it, a row needs 0 or 1 novel mechanism.
- VERDICT names COMP2, the best row whose cells judges have scored. An unheld option leaves the cells its axis decides unjudged: D `keys` 11 cells, X `ramp` 15, R `vsr` 72, Y `proxy` none (Y decides no cell in any [attribution](../attrib/)). So no unheld option can be named before a judging pass. The threats below are what that pass should look at.

### 1.2 Where the novel mechanisms come from

MIN-P+m's three novel units ([judging/mechanisms.json](../../mechanisms.json)) and what removes each:

| Unit | Carried by | What removes it | Held? |
|---|---|---|---|
| slot-move | P `slot` | P `split` or `split + merge` (no novel unit; SPLIT, PD) | held |
| restore-mark | a metadata group, with slot epochs or sessions | no slot epochs **and** no sessions: PD's T `tso` with O `hlc` and D `txn` (the referee's reason) | held |
| dir-lease | members that keep their own dirs | S `lsm` (RocksDB's own lock) or S `obj` | held |

E-33 says why restore-mark follows slot epochs: a restore is honest "only if its new epoch is above every epoch ever used", and a slot move raises the epoch ([E-33](../../../experiments/E33-genesis-restore/README.md), "In short"). So in a P `slot` row no T or D option removes the mark. The only unheld options that touch these units are P `one`, P `dir`, G `clus` and G `key`, and each fails a MUST (section 2). That is why nothing unheld reaches 0 or 1 novel.

Can an unheld option add a SHOULD to TiKV-TS instead? Its twelve unmet SHOULDs are P-22 S (open: five PD-family triggers, K `kern`, X `2pc`, T `tso`, S `lsm`, O `hlc`), DEV-05 S (open: X `2pc`), OPS-11 S (open: S `lsm`), DEP-15 S (not: V `full`, N `proc`), SC-06 S (open: a held-tag gap, section 5), DEV-02 S (not, for every row), and six decided by R alone or by no axis (P-20, PERF-09, DEP-10, DEP-14, DEP-19, TEST-11). No single unheld option clears any of them. X `ramp` would clear DEV-05 S's trigger but needs D off `txn` (constraint D-txn-X), loses P-15 S's 2PC route, and brings restore-mark back with D `sess`.

### 1.3 Pricing by hand

closure/mechanisms.json writes each unit's condition with held tags only. So for an unheld tag, `mechrow` silently drops every unit whose condition names that axis (section 5). The prices in this file come from [price.py](/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/critic/price.py) in the scratchpad. It imports closure.py, takes a frontier row's units, drops or adds named units, and counts pairs with closure.py's own rule. Each added unit is written out in the threat's section with its reads and writes. It reproduces MIN-P+m (3 / 264), COMP2 (3 / 274) and TiKV-TS (0 / 225) before any change.

## 2. Every unheld option

Verdicts: **threat** (a row with it can rank above a frontier row under rule 3 with no MUST failed on present evidence), **not**, **unknown**.

| Axis | Option | Verdict | Why |
|---|---|---|---|
| R | `vsr` | unknown | Q-37's threshold says R `vsr` is costed when Raft needs more than 2 rules for one bad entry; `par` took 7 ([E-37](../../../experiments/E37-bad-entry/README.md), lines 5, 11, 155), and no one costed it. Best case 3 / 6 / 267, worst 3 / 5. Section 3.4 |
| R | `chain` | not | SPACE 4.3: fail-stop, one slow node stalls its chain (F-18 at risk), and a master reconfigures, so a controller stays. SPACE prices it 1 to 2 novel. Nothing rule 3 counts gets better |
| R | `calvin` | not | +2 novel (SPACE 2 R) and it forces X `det`. A write waits for its epoch, up to 10 ms (SPACE 4.3), against P-01's C + 5 ms = 5.73 ms. Methods must declare read and write sets first |
| R | `epax` | not | High novelty: recovery bugs found after publication (SPACE 2 R). No latency gain while voters sit in one region (SC-14 as proposed). Depends on region scope: AMENDMENTS 2 R reopens it only for multi-region writes, and it still adds novel units |
| R | `crdt+c` | not | Two replication paths (SPACE 4.3). Its LWW half is V4's, whose F-02 cell fails (settled, V4) |
| R | `async` | not | An acked write can vanish on failover and a fence token can repeat (SPACE 4.3): F-01, F-04 and P-10 fail by structure |
| R | `solo` | not | One copy: F-11 (two machines) and DEP-16 (a lost host loses nothing acked) cannot hold |
| G | `clus` | not | One leader for the whole project: 1 effective writer against F_w = 64. The settled SC-03 cells fail LANE and CELL restated on the same structural reason. It would drop the slot units (2 novel), but it is out unless F_w ≤ 1 |
| G | `key` | not | A live TS Raft group costs 16 to 26 KB (E-11, cited in [E-36](../../../experiments/E36-many-resources/README.md) line 78) against DEP-13's 2 KB a small row. It needs P `dir`, and views fan in over every key (SPACE 4.3) |
| P | `one` | not | Needs G `clus` or `res`. `clus` as above; G `res` fails SC-13 by the settled structural cell |
| P | `dir` | not | A partition moves by the same fence, copy, open and carried set as a slot ([slot-move's rules](../../mechanisms.json)), so the novel move unit stays under another name. The directory grows with partitions (SPACE 4.3) |
| C | `none` | not | An operator acts (SPACE 2 C), so SC-08 (e) "no human step" fails by structure and SC-04's shrink has no decider. `mechrow`'s 227 pairs is an artefact (section 5) |
| C | `out` | not | Self-hosters get no healing or moves (SPACE 2 C): SC-04 and SC-08 (e) at risk. Hosted, the platform's commands still need A-20's epoch check (DEP-17), and quiet groups still need link pings (A-12), so the units the tool drops stay |
| Q | `maj-m` alone | not | No `persisted` rung, which P-01, P-06's default and F-01 name. No unit drops: the memory rung stays |
| Q | `ldr` | not | Failover loses acked writes (SPACE 2 Q, 4.3): F-01 and F-04 fail by structure |
| D | `keys` | **threat** | Pairs only: about 10 fewer than COMP2 (3 if counted novel). Section 3.1 |
| D | `srcpos` | not | Covers derived outputs only, which every row already covers with srchi marks (A-05). As the only dedup: about 5 TB at 1e5 outputs a second for a week (AMENDMENTS 2 D) |
| O | `part` | not | P `slot` forces O `slot` or `hlc` (SPACE 5; constraint P-slot-O). slot-sequence is not novel, so there is nothing to gain, and a counter per partition outlives its rows (SPACE 2 O) |
| T | `hlc` | not | [E-21](../../../experiments/E21-time/README.md): a failover on every leader clock jump (60 of 60 runs), against F-06, in a model of its own rule. Same 7 rules as `clamp`; no novel or SHOULD change. Depends on F-06's wording (AMENDMENTS 2 T), and even then rule 3 sees nothing better. `mechrow`'s "2 novel" with D `keys` is an artefact (section 5) |
| T | `mono` | not | E-21: rows lived up to 30 s past their ttl after a failover (583 rows; 93 s with several handovers), against P-02's one tick + `skew.max` |
| T | `tt` | not | E-21: 4 rules, but only with clock hardware (TrueTime, ClockBound) that "a laptop, a plain VM or `node app.ts` does not have" |
| X | `grp` | not | One slot only (SPACE 2 X). A unit across resources or slots cannot be written, the structural reason the settled cells fail V4's X `none` on P-15 M |
| X | `det` | not | Needs R `calvin` (SPACE 5) |
| X | `ramp` | **threat**, as `rampv` only | RAMP-Fast as SPACE defines it does not meet P-15 S: real Elle found a fractured read on list-append histories, which is P-15 S's own acceptance test, and it adds 13 pairs (E-24). The vector fix could add P-15 S. Section 3.2 |
| F | `lazy` | not | The leader must fold to judge conditions (K `lib`), so the form is OBJ's `ldr + lazy`, which is held and in the search. `mechrow`'s 254 pairs drops every fold unit (artefact). No experiment ran it (AMENDMENTS 2 F) |
| U | `both` | not | Adds leader-calls (not novel: Orleans, Durable Objects) and its pairs. F-02 goes open as SIDE's did (calls in flight across a handover). E-22: nothing is safe only at the writer, so it buys no cell |
| Y | `proxy` | **threat**, TiKV's shape only | Pairs only: 3 fewer on TiKV-TS. On rows with U `any` it costs 6 more. Section 3.3 |
| M | `tpc` | not | Native only, so it is not a TS-first row's first phase. It adds a core map like `kwN`'s worker-map. SC-12 S, the only SHOULD that M decides, is already met |
| L | `wasm` | not | No unit and no SHOULD changes. E-04: a Rust kernel in WASM serves as the sim's kernel, slower than native |
| I | `own` | not | Loses DEV-04 S (not reused or ported). E-14: etcd's TLA+ spec alone misses the campaign guard etcd's code has. (The DEV-04 attribution reads only R, so the tool would still say met: section 5) |
| I | `openraft` | not | DEV-04 S stays met (DEV-04 names it), and nothing else moves. Its async I/O traits need a custom runtime for DEV-07 (SPACE 2 I). "Not examined" (AMENDMENTS 2 I) |
| I | `jslib` | not | None is production-grade (SPACE 2 I; AMENDMENTS 2 I: "out"), so DEV-04 S is lost |

The other axes (K, V, W, S, H, N) have no unheld option: every SPACE tag on them is held by a judged row, or priced (S `lsm +tier`, Z `par`).

## 3. The threats

### 3.1 D `keys`: one key table for every retry (rank 1)

**What it is.** E-20's `keys`: a unique key per write; the writer keeps each key's outcome for its ttl; per-copy time budgets and a stop-retry horizon as in `win`; no window and no floor ([E-20](../../../experiments/E20-dedup/README.md), options table). Every row already keeps a caller-key table beside its dedup (A-10). With `keys`, that table does the work of client sessions too.

**Which frontier row it changes.** COMP2's tier: every Raft row takes off about 10 pairs. It cannot pass TiKV-TS: TiKV dedups by transaction ids inside 2PC, so `keys` drops nothing there.

**Mechanisms.** client-sessions goes (not novel; Raft thesis 6.3, LogCabin, RIFL). Two ways to count what replaces it:
- caller-keys grows: under Y `fwd` it takes E-20's two hop rules (`forward.once`, `forward.age`), so it reads the relay's in-flight state. Not novel if the counters accept Stripe's keys plus a bounded lateness as precedent. The dedup window's own record cites Liskov, Shrira and Wroclawski (1991) for forgetting by bounding how late a message arrives ([mechanisms.json](../../mechanisms.json), dedup-window, "why").
- Or a separate key-dedup unit, novel: the counters ruled the window novel for its set, which includes "per-hop time budgets, forward-once", and `keys` keeps both (E-20: "budgets and stop-retry as `win`").

presence-rows writes the session registry itself, so presence (P-13) keeps its sessions without client-sessions.

| Row | Novel / SHOULDs / pairs |
|---|---|
| COMP2 | 3 / 6 / 274 |
| COMP2, D `keys`, caller-keys grown | 3 / 6 / 266 (264 by the tool's own drop) |
| COMP2, D `keys`, a new novel unit | 4 / 6 / 271 |
| COMP2 V=full, D `keys` (the tool's drop) | 3 / 6 / 256 |
| COMP+par C=cent V=full, D `keys` (the tool's drop) | 3 / 6 / 252 |

In both counts the row beats COMP2. At 4 novel the counts differ by 1, the SHOULDs tie at 6, and the pairs decide. It also beats MIN-P+m (3 / 5 / 264) on SHOULDs.

**SHOULDs.** None met or lost. P-22 S is decided partly by D, and `keys` falls to its "met" fallback (E-22's queue), unjudged.

**MUSTs at risk.**
- F-02 (M), open. E-20 holds exactly-once for `keys` in every scenario (12 rules sent straight, 14 under `fwd`). But E-32's crossing found a write both applied and told "refused" where a dedup state that forgets meets the lock-token refusal, and its fix was checked only with sessions. That is why RR-05 holds the `win` rows' F-02 open ([rerulings.cells.json](../rerulings.cells.json); [E-32 crossing](../../../experiments/E32-composition/crossing/README.md), "What broke"). `keys` forgets at its ttl, so it owes the same check. The budgets may close it: a copy past its budget is never judged.
- DEP-13 (M), open. A key costs 221 B for its ttl: 13 GB at 1e5 writes a second for a 10-minute ttl (E-20, memory table). An empty copy must stay under 100 MB, which a 10-minute ttl passes at about 750 writes a second. A ttl as short as the copies' budget shrinks this, but no one measured it.
- The other cells D decides go unjudged: P-04, P-07, P-09, P-10, P-13, P-14, P-15 (M) and P-22 (S), with F-02 (11 with COMP2's two F-22 cells). The tool predicts them as COMP2's, and none fails.

**The experiment.** Run E-32's crossing model with E-20's `keys-fwd` rules in place of `sess`, on the `floor-*` and `lock-*` bounds. It shows whether `keys` keeps F-02 beside fence tokens. In the same run, pin the key table's bytes at DEP-21's three loads (asleep, 10 writes a second, 5,000 a second) against DEP-13. Then two counters rule whether the key table is caller-keys grown or a new novel unit.

### 3.2 X `ramp` in its `rampv` form: atomic reads over the saga (rank 2)

**What it is.** E-24 runs RAMP under the saga's locks, so the saga stays for P-15's MUST and RAMP adds read atomicity. RAMP-Fast: a unit's writes carry its id and siblings, go in two rounds (prepare, then commit markers), and a reader fetches a missing sibling version in a second round. `rampv` adds a small vector to each version (the newest unit it includes per co-written sibling) and repeats round 2 until nothing more is needed ([E-24](../../../experiments/E24-sagas-ramp/README.md), "In short" and section 3).

**Why plain RAMP-Fast is not a threat.** P-15 S's acceptance test checks Elle list-append histories for fractured reads. Real Elle found one G-single in 200 RAMP-Fast histories, and a direct count found 10 in 36,000 reads, because a `push` or `incr` version carries earlier units' effects that its metadata does not name (E-24, section 3). That is a counterexample on the requirement's own test, so P-15 S stays "not", as the tool and the settled cells say ("RAMP would give it for units of plain sets only", [P.settled.json](../../P.settled.json), P-15 S for COMP and MIN-P). And RAMP-Fast adds 13 pairs.

**Which frontier row `rampv` changes.** COMP2's tier. It cannot pass TiKV-TS: TiKV-TS already meets P-15 S by 2PC, and `rampv` adds novel units.

**Mechanisms.** Two new units, carried by the slot move: RAMP's versions and markers (pending versions, the last commit per partition), and `rampv`'s vector.
- RAMP-Fast's unit: 19 rules, one of them new ("serve": a round-2 fetch of a pending version commits it; E-24 found it needed for fero's read rule). Precedent: Bailis et al., SIGMOD 2014, Algorithm 1. Novel only if the counters weigh the one new rule as they did not for the saga's one new rule (saga-intents was ruled not novel on Seata's precedent).
- The vector: novel. E-24: "at least 2 more rules ... one more novel mechanism, and no fixed bound on rounds".

| Row | Novel / SHOULDs / pairs |
|---|---|
| COMP2 | 3 / 6 / 274 |
| COMP2, `rampv`, vector novel | 4 / 7 / 289 |
| COMP2, `rampv`, both units novel | 5 / 7 / 289 |
| COMP2, D `keys` and `rampv` | 4 / 7 / 281 |
| COMP+par C=cent V=full, D `keys` and `rampv` | 4 / 7 / 269 |

At 4 novel it beats COMP2, MIN-P+m and SPLIT2 (3 / 6 / 266, VERDICT section 10, 3-S2) on SHOULDs. At 5 novel the counts differ by 2 and it loses to every 3-novel row.

**SHOULDs.** Gains P-15 S, if judged met. E-24's evidence for `rampv` is a simulation: none fractured in 36,000 reads and in 200 Elle-checked histories, "reasoned from the simulation, not model-checked". DEV-05 S (small code) is decided partly by X and falls to "met" unjudged; RAMP adds code but E-44's estimate leaves room under 2 times.

**MUSTs at risk.**
- P-15 (M): kept by the saga beneath (E-24, `fullundo`, seven bounds). Unjudged for the new tag.
- P-01 (M) and P-03 (M): a client holds and reads rows synchronously. A unit whose siblings sit in partitions the client does not hold cannot be read atomically without a remote round, so the client must show the older version or throw `shortfall`. No experiment looked at RAMP on a near cache.
- PERF-11 (M), DATA-03 (M), TEST-13 (M): decided partly by X, unjudged. E-24 measured 8 to 12 % of reads needing round 2, and `rampv` has no bound on rounds.
- 15 cells go unjudged in all (listed by `card`).

**The experiment.** Extend E-24's exhaustive RAMP model ([models/ramp.py](../../../experiments/E24-sagas-ramp/models/ramp.py)) to versions that carry earlier units' effects (`push`, `incr`), add `rampv`'s vector and repeated round 2, and run E-24's bounds (`two`, `fol`, `gc`, `move`). Check read atomicity and whether rounds stay bounded. Ablate by DEV-10 to count rules and new rules, so two counters can say whether it is one novel unit or two.

### 3.3 Y `proxy`: routing proxies at the public address (rank 3)

**What it is.** Stateless proxies at the project's one public TLS address route each write to its slot's leader; servers never relay (SPACE 2 Y; precedent: Envoy's Redis proxy, Kafka proxies, Vitess vtgate). The proxy keeps route-smart's state: a cached slot table, following MOVED and ASK.

**Which frontier row it changes.** TiKV-TS only. TiKV-TS has U `cli`: servers run no user code, so no server needs to send writes of its own. route-forward goes and one proxy routing unit comes in, not novel. Y decides no requirement cell, so every cell stays TiKV-TS's.

| Row | Novel / SHOULDs / pairs |
|---|---|
| TiKV-TS | 0 / 4 / 225 |
| TiKV-TS, Y `proxy` | 0 / 4 / 222 |
| COMP2, Y `proxy`, server-side route kept for methods (U `any`) | 3 / 6 / 280 |

On COMP2 and MIN-P+m it is not a threat. With U `any`, methods run on the server the caller reached, and their writes still go to the leader, so a server-side route stays: 6 more pairs, not fewer.

**SHOULDs.** None change.

**MUSTs at risk.**
- DEP-21 (M), open. TiKV's shape already sits at the bar: $9.58 to $10.11 against $10 with one app machine (RR-06, [rerulings.cells.json](../rerulings.cells.json)). A proxy in its own machine costs at least the $2.19 free-tier machine (E-41) and puts it over. A proxy inside the existing machines costs memory only.
- DEP-04 (M) and DEP-13 (M): one more process kind must wake within 1.5 s and fit the copy's memory. Reasoned, not measured.
- P-19 (M) and F-17's client clause: the hop count equals `fwd`'s, and the proxy routes like `smart`, which E-38c credits with F-17's client-level clause.

**Why rank 3.** It is the only unheld option that moves the overall top, but by 3 pairs. VERDICT 3-S6 already calls 19 and 8 pairs thin margins, since no second agent checked the reads-and-writes list.

**The experiment.** Price DEP-21 for TiKV's shape with the proxy inside its existing store machines (E-41's floors, RR-06's machine count). If it stays under $10, a second agent checks the two routing units' reads and writes.

### 3.4 R `vsr`: VR Revisited with protocol-aware recovery (rank 4, unknown)

**Why it is owed.** E-37's threshold (from QUESTIONS Q-37): "a fix of 2 rules or fewer keeps Raft; more → R `vsr` ... is costed as a candidate row". `par` needs 7 rules, so E-37 itself says "`vsr` is costed as a candidate row against Raft + `par`" ([E-37](../../../experiments/E37-bad-entry/README.md), lines 11 and 155). SPACE's "Considered and not added" also waits on Q-37. No file costs it. AMENDMENTS 2 R: "`vsr`: no experiment built it."

**Which frontier row it changes.** COMP2's tier. It changes none of the three novel slot units, so it cannot pass TiKV-TS.

**Mechanisms.** VSR's units (log, view change, commit, reconfiguration, state transfer) replace Raft's eight. Its PAR repair is part of TigerBeetle's replica protocol, so the counters may fold `par-repair` into the log unit. Precedent: Liskov and Cowling 2012; Alagappan et al., FAST 2018; TigerBeetle in production. One risk of a new novel unit: quiet groups. Their precedent (CockroachDB, TiKV hibernation) is Raft; TigerBeetle runs one cluster, not thousands of groups.

| Row | Novel / SHOULDs / pairs |
|---|---|
| COMP2 | 3 / 6 / 274 |
| COMP2, R `vsr`, PAR in the log unit, DEV-04 S met | 3 / 6 / 267 |
| the same, DEV-04 S not met | 3 / 5 / 267 (below MIN-P+m's 264) |
| COMP2, D `keys` and R `vsr` | 3 / 6 / 259 |

The 267 assumes VSR's units mirror etcd's raft units one for one. It is the best case, not a count.

**SHOULDs.** F-22 S: met by design (PAR), but E-37 modelled PAR on etcd's Raft spec, not on VSR. DEV-04 S: at risk. DEV-04 asks for a core "reused or ported from a production library"; SPACE says "no production library outside TigerBeetle (Zig)", and TigerBeetle's replica is tied to its own storage.

**MUSTs at risk.** 72 cells lose their judged support, because every R-decided cell rests on Raft evidence: E-10 (41 of 41 etcd files), E-46 (26 of 26 Maelstrom runs linearizable, which P-14 cites), E-14 to E-14c (membership), E-38 (gray failures). None fails on present evidence; all go open.

**The experiment.** Cost it, as Q-37 asks. Two counters list a COMP2 R=`vsr` row's units with reads and writes, from VR Revisited, PAR and TigerBeetle's `src/vsr`, so closure.py's pair rule prices it. The referee rules DEV-04 S for a port of TigerBeetle's replica. This desk step decides its rank. Safety evidence (E-37's bad-entry model on VSR) comes after, and only if it ranks.

## 4. Outside designs and pruned families

From VERDICT section 10 (3-S9, recorded and not checked) and SPACE 4.3. Each maps to an option above or to a held option.

| Design | Maps to | Verdict | Why |
|---|---|---|---|
| FoundationDB | PD's family | not | Five roles; a recovery restarts the whole transaction system (F-05 at risk); watches are not streams, so P-03 and P-07 need a stream layer (SPACE 4.3). At best 0 novel like TiKV-TS, but with no Raft core to reuse it loses DEV-04 S: below TiKV-TS on SHOULDs |
| Calvin, Fauna | R `calvin` | not | As R `calvin` above |
| Delos, LogDevice, Restate's Bifrost | R `slog` | not unheld | SLOG is judged; the closure search holds its options |
| Restate | R `slog`, F `ldr`, U `ldr` | not unheld | All held options |
| WarpStream, Bufstream | R `obj` | not | Produce p99 under 150 ms (about 50 ms with Lightning Topics) against C + 5 ms (VERDICT 3-S9) |
| AutoMQ | none in SPACE | not | Replication by a cloud disk. On Fly (J's deploy target) a volume is a local disk with no replica, so F-11 and DEP-16 have nothing to stand on (reasoned) |
| CRDT-first | V4, R `crdt+c` | not | As R `crdt+c` above |
| Async primary, Litestream | R `async`, Q `ldr` | not | As above |
| Chain replication, CRAQ | R `chain` | not | As above |
| Ring-computed views + VR | V4's shape, R `vsr` | not | "I would not choose (c) under any condition I can name" (SPACE 4.3); VSR on its own is section 3.4 |
| Leaderless consensus (EPaxos, Accord) | R `epax` | not | As above |
| A Durable Object per key | G `key`, P `dir` | not | As above |
| One group per project | G `clus` | not | As above |
| Virtual synchrony (Isis, Derecho), Hermes | none | not | Delivery tied to membership, v4's failure mode (SPACE 4.3) |
| Aurora-style quorum storage | R `slog` | not unheld | SLOG is its fero form (SPACE 4.3) |

## 5. Notes for the closure tool

These do not change any result above. They matter to anyone who runs the tool on a tag no judged row holds.

- **`mechrow` on unheld tags.** Each condition in closure/mechanisms.json lists held tags only, so an unheld tag drops every unit that names its axis. Seen here: R=`vsr` keeps 19 of 50 units (1 novel, 31 pairs). C=`none` or `out` drops controller-commands, link-pings and slow-leader-controller (227 pairs). F=`lazy` drops every fold unit (254). T=`hlc` with D=`keys` drops restore-mark (2 novel), though E-33 ties the mark to slot epochs. X=`ramp` drops saga-intents and fence-tokens (255), though E-24 runs RAMP under the saga. The search never used these tags, so its results are not affected.
- **`card` on unheld tags** falls to each part's fallback, and some fallbacks ignore the unheld axis. DEV-04 S reads only R, so I `own` and I `jslib` would still show "met".
- **A held-tag gap seen on the way.** SC-06 S's met rule names S `lsm` but not `lsm +tier`, so TiKV-TS's SC-06 S falls to "open". The rule's own basis ("a cold read is a local disk read, under one object-store get") fits `lsm +tier` too. If a judge agrees, TiKV-TS is 0 / 5 / 225, which widens its lead and changes no order.

## 6. Files

- This file.
- The pricing script, in the scratchpad: `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/critic/price.py`. It reads the study's files and writes nothing. Run it from `docs/v5-space`.
- The `card` outputs it was checked against, in the same folder: `card-keys.txt`, `card-ramp.txt`, `card-vsr.txt`.
