# E-59: growth from one voter, and a clean stop

**Question.** LAYERS section 11 owes two models on every founding's path. (1) E-52's world with groups that start at **one voter**: growth to three voters by learners first and two promotions back to back, a crash between the two promotions, the step back from two voters to one, and a gone learner dropped (LAYERS 2.3 and section 10 item 20). (2) **A clean stop** (LAYERS 8.9 and item 25): a leave with no spare, "a retiring voter is left to its own leave until `leave.ms`", a retire that stays pending, and the leave of an only voter. LAYERS also leaves a decision open: **when a voter leaves with no spare, does it stay in the config as an absent voter, or does the group shrink to two voters and step back to one?** Do the designs hold, which rules do they need, and which answer holds the properties with fewer rules?

**Threshold.** Both answers run on the same model, with the same properties and the same bounds. A design holds when no safety property breaks in any reachable state and no liveness goal is out of reach (complete runs). The answer that holds more properties wins; if both hold the same, the one with fewer rules wins (DEV-10, and by sentence as LAYERS counts).

**In short.**

- **Growth from one voter holds in both options**, with one rule changed from LAYERS 2.3: growth writes a placement of three whenever the stored placement names fewer than three machines, not only "with one voter". "Back to back" is now checked as a property (B2B). *(checked: 19 complete bounds per option, up to 1,832,195 states; 5,900 seeded walks, none failing)*
- **A clean stop holds in both options once the design has four rules no page has**: (1) a leaver exits only once the voters left have applied the latest config and can commit without it; (2) and only once they hold every committed entry; (3) **at `leave.ms`, a leaver that nothing can carry the group without stops anyway**, as a crash would, and the group waits for its restart; (4) a leader that has appended its own removal takes no new write. *(checked)*
- **This is a change to the pages, not their rule made safe.** LAYERS 8.9 and DESIGN-V5 4.2 say "exit at `leave.ms`" whatever happens. That leaves an only voter's group with no voter (LX in 3 steps). The first version of this record waited past `leave.ms` for ever instead, and the review showed that a one-machine server then never stops. Now: exit at once when it is safe; at `leave.ms`, stop if no live machine could stand in for the leaver or the group has no live majority; otherwise keep waiting while a live machine can still carry the group. *(checked: SF now holds on every state with a leaver up, crashed machines or not)*
- **The leave of an only voter** needs DESIGN-V5's path in both options: promote a caught-up learner, hand over, be removed from two voters, exit (12 steps). **A retire with no spare stays pending** and harms nothing. *(checked)*
- **"A retiring voter is left to its own leave until `leave.ms`" cannot be tested here**: time is order only, so no property can tell "before `leave.ms`" from "after". Its rule breaks nothing when dropped. *(checked; the reading is reasoned)*
- **Decision input ("leave with no spare"): the threshold does not decide it; the reported measures favour absent.** Both options hold every property on every bound, and both need the same rules (17 of 21 sentences, 9 of 12 LAYERS rules). The first version's gap (SFF) is gone: with the bounded exit, a stop finishes in both. What is left is reported, not a property: through a stop with one crash, absent stays writable and shrink is stuck in 16,324 of 25,624 states on `s1f` (9,938 of 15,166 on `s1f4`), because shrink passes through two voters; after a stop with no crash, absent keeps each commit on two disks and shrink on one (DUR). The walks do not show the gap, and after the stop one more crash stops writes in both. *(checked)*
- **Rules.** At LAYERS' grain both options need 9 of its 12 rules: growth's 4, 8.9 B1 and B4, the only voter's leave, V4-60, and the new `write.stay`; 8.9 B2 (the hand-over), the leaving learner's drop and `meta-members`' high rule break nothing when dropped whole. Each rule dropped alone in `absent`: 68 of 114 needed, 2 undecided. Hand-written mutants: 19 of 24 caught in `absent`, 20 of 24 in `shrink` (2 undecided), under the 90 % bar; every survivor is a rule this model shows is not needed, a timing rule, or a harmless change. *(checked)*
- **How sure.** High that both designs are safe and live on these bounds. Medium for the rule counts. Low for anything with cuts, slow links or lost disks: the model has none, and the exit check reads facts a real leaver must learn from messages (section "What the model leaves out").

## What changed after the review

A review of the first version ran the quick mode, sampled the full runs, wrote its own properties, bounds and 20 mutants, and found 12 problems. Each was checked; all 12 hold. What changed:

| # | Finding | Holds? | What changed here |
|---|---|---|---|
| 1 | The exit check waits past `leave.ms` for as long as the voters left need the leaver. A one-machine server never stops; an only voter whose learner is down waits for it. SF was judged only with no crashed machine, which hid it; LX called the solo exit a bug | yes (2 of 2 states stuck on `solo`; 12 on `o1d`) | New rule `exitalone`: at `leave.ms`, a leaver stops as a crash would when the group has no live majority or no live machine could stand in for it. SF is now judged on every state with a leaver up. LX now forbids an exit that takes the last live majority only while a live machine could stand in. Bounds `solo` and `o1d` added |
| 2 | The decision rested on one reported property (SFF) on one bound; "a tie, 19 of 20 sentences" counted a sentence as needed when only a guard misfires; "absent keeps each commit on two disks" was false at the exit | yes | With the bounded exit SFF no longer separates the options (both finish the stop). The gap is now reported as SWF (writable through a stop with one crash), on `s1f` and on a second complete bound `s1f4`, and in the walks (mid-walk). Sentences are now counted by dropping each whole sentence (`sentences.py`). DUR (two copies) is checked as a property in variants |
| 3 | "Back to back" was not checked: a first promotion while the second learner is behind survived every bound | yes | New step property B2B. The mutant is caught (B2B on `g0`, 8 steps) |
| 4 | A leaver could exit while a write it committed sat on one disk (6 steps on `s1`) | yes | New guard `held` on both exits, and step property DX. Dropping `held` breaks DX on `s1` in 6 steps |
| 5 | 11 of 20 hand-written mutants caught; a down or behind learner promoted by the only voter, and a "retiring" mark kept over a restart, survived | yes | New step property OL (a config entry never takes away the live majority); SF now counts any up machine that says it is leaving. The 20 mutants and 6 new ones run in `mutants.py` on every bound: 19 of 24 non-equivalent caught in `absent`, 20 of 24 in `shrink` (section 6) |
| 6 | No partitions, no stale messages; the new rules read global truth | yes | Not modelled. Marked *(reasoned)* and left open (section "What the model leaves out") |
| 7 | The 20 sentences are this record's own grain, not LAYERS' | yes | Rules are also counted by LAYERS' own rules (2.3 rules 1 to 4, 8.9 B1 to B4, and the unnumbered ones it lists) |
| 8 | Bounds with a spare that starts later (`r1sd`) and a third machine that starts later (`g0d`) hold; no bound has a retire and a crash together | yes | `r1sd`, `g0d` and `r1f` (a retire and a crash) added. A leave, a retire and a crash together (`rlf`) passes 3,000,000 states in `shrink` and is left out |
| 9 | `commit.own` (Raft's Figure 8) is caught only by a liveness property | yes | Said in section 6 |
| 10 | Between the two promotions, a learner drop or an add can come first, after a crash or a retire | yes | Said in section 2; B2B allows it only after a crash, a leave or a retire hint |
| 11 | SN covers leadership only; no reads | yes | Said in the limits |
| 12 | `run.sh` overwrites `results/` | yes | `OUT` sets the output folder |

Numbers from the first version that no longer hold: the state counts of `s1`, `rl`, `s1s`, `s2`, `gl`, `s1f` and `o1f` (the bounded exit and the `held` guard change them), "SFF: absent 0 stuck, shrink 16,828", "61 and 60 rules needed alone", "19 of 20 sentences", and the smallest model of `absent` (44 rules, 45 mutants). The smallest model was not rebuilt on the changed model (section 5).

## Words used here

- A **voter** counts toward commits and elections. A **learner** copies the log and does not count. A group's **config** is its voters and learners; it is an entry in the group's log and takes effect when the entry commits (etcd's rule).
- **Growth**: a group founded by one machine becomes three voters. LAYERS 2.3 reads it as four steps: write a stored **placement** of three, add the other two machines as learners, promote both **back to back**, and step back from two voters to one if growth is cut short.
- A **clean stop** (LAYERS 8.9 B): Ctrl-C with no supervisor. The machine says **retiring** in its pings, hands over what it leads, its seats move off, and it **exits**. `leave.ms` (4 s) bounds the wait.
- **No spare**: no live machine outside the group could take the leaver's seat.
- **Carry the group**: keep it going without the leaver. Here: the group's latest committed config has a live majority, and some live machine that is not leaving could stand in (a member, or a machine that says nothing).
- The two answers to "a voter leaves with no spare":
  - **absent**: the leaver stays in the config as a voter, exits, and is absent. The group commits on two of three. (A second leave removes the absent voter as dead first: V4-60.)
  - **shrink**: the leaver is removed while the live voters left are a majority (three voters to two), and growth's step back takes the group to one voter.
- A **retire** hint (DESIGN-V5 4.2): the platform asks a machine's seats to move off; the machine stays up. With no replacement it **stays pending**.
- **Gone**: a machine down for longer than `evict.after`.
- **Working leader**: a leader of its own config's voters, with a live majority, that has committed an entry of its own term.
- **Model-checked**: every reachable state of the bound was explored, breadth first, so every trace given is a shortest one. **AG EF**: from every state where a goal is asked, calm steps (no fault, no outside event) can still reach it.
- **DEV-10**: a rule is one guard conjunct or one state update; it counts only if removing it lets the checker find a counterexample.
- **Marks**: *(checked)* a model or a seeded run ran it and its line is in `results/`; *(reasoned)* an argument, not run; *(cited)* another record's result; *(a guess)* nobody ran it. Nothing here is timed, so nothing is *(measured)*.

## Method

### What is reused

- **E-17's rule language and E-16's engine**, unchanged ([../E17-partitioning/harness/dsl.py](../E17-partitioning/harness/dsl.py), [../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)). A rule is one guard conjunct or one state update; drops are mechanical; liveness is AG EF over calm steps; every run pins `PYTHONHASHSEED`, so counts repeat.
- **E-52's healing rules**, with E-52's names and its fixes as LAYERS 2.3 states them after V5-10: add, promote ("answers the leader now", `promote.caught`), remove, surplus, rule 15's pick into a stored placement, and retiring (P7, LD). E-52's directory, dial, hints, drains, hand-back and preferred member are not repeated here.
- **E-14c's safety invariants** in place of E-16's abstract checks: `CommittedQuorumInv` (NL) and `VoteQuorumInv` (VQ), with election safety, log matching and leader completeness.

### What is new: a Raft core with terms and logs

E-52's world makes elections, commits and catch-up atomic steps of one abstract group, so it cannot show two leaders in one term or a lost commit. This model has a log per member instead ([models/grow.py](models/grow.py)):

- each member has a term, a vote, a log of entries, a commit index and a role. Payloads: the founding entry (config and placement), a config, a placement, a no-op, a write;
- a config takes effect when its entry commits: a member's config is the last config entry at or below its own commit index. A leader counts acks with its applied config, only for an entry of its own term, and steps down when its applied config drops it. Only a voter of its own applied config stands; learners grant votes; a new leader appends a no-op;
- replication copies the leader's whole log to a follower that has not seen a higher term;
- **reductions** (stated, pinned): PreVote, one candidate at a time and no candidate while an up leader holds that term (E-14's LeaderLease), a candidate gives up only when it cannot win, any member that meets a higher term takes it, a leader with a transfer in flight proposes nothing, CheckQuorum;
- **faults**: a crash keeps the disk; recovery is free and starts a fresh process (it no longer says it is leaving). No cuts and no lost disks;
- **time is order only**: `evict.after` and `leave.ms` are steps that always fire in the end;
- **outside steps**, within a budget: crashes, leaves (Ctrl-C, no supervisor), retire hints, client writes.

The Raft core's own rules are written as rules too, so pass 1 shows the properties catch their removal; they are pinned in the design's count, since E-10, E-14b and E-14c checked them on etcd's code and spec.

### The design (counted)

`python3 ../E16-controller-loop/engine/cli.py models/grow.py shrink --rules` lists every rule (114 design rules). In short:

**Growth** (LAYERS 2.3 "Growing from one voter"):
- `grow`: a group whose stored placement names fewer than three machines writes a placement of three, once three live machines say nothing (LAYERS says "a group with one voter"; finding 2 of section 3).
- `standby`: while the group has one voter, every live machine that says nothing is added as a learner.
- `promote.pair`: from one voter, promote only once two placed learners hold the commit offset and answer now. With "never past four voters", the second promotion follows the first: **back to back**.
- `stepback`: two voters step back to one when fewer than three live machines say nothing and neither voter is retiring.
- `dropl`: a learner gone to the leader is dropped.

**Healing** (`healing-self`, E-52's rules): `add`, `promote`, `remove`, `surplus`, `pick`.

**A clean stop** (LAYERS 8.9 B, DESIGN-V5 4.2's leave row):
- `leave.mark`: the leaver says retiring first; every add, promotion and pick skips a machine that says so.
- `handover`: a retiring leader hands over, never to a retiring machine, only to a voter of the config in flight too.
- `opromote`: an only voter that says retiring first promotes a caught-up learner.
- `lrem`: a voter that says retiring is removed while the live voters left are a majority, no spare exists, and a voter that is not leaving stays. **The two options differ only here**: `absent` removes it only from two voters (the only voter's leave); `shrink` removes it from three too, but only for a leave, never for a retire hint.
- `ldead`: a dead voter is removed first when a leave that reached `leave.ms` needs it (V4-60).
- `ldrop`: a leaving learner is dropped.
- `exit`, `exitms`: the leaver exits once no config names it and it leads nothing, or at `leave.ms`; either way only once the voters left have applied the latest config, can commit without it (`safe`), and hold every committed entry (`held`).
- `exitalone`: at `leave.ms`, a leaver that nothing can carry the group without (no live majority, or no live machine that could stand in) stops as a crash would; the group waits for its restart.
- `write.stay`: a leader that has appended its own removal takes no new write.
- `pick.wait`: "a retiring voter is left to its own leave until `leave.ms`".

### Properties

Safety, every state: **ES** at most one leader per term; **LM** log matching; **SM** no committed entry changes; **LC** a leader holds every entry committed in an earlier term; **NL** every committed entry sits on voters of the latest committed config that meet every majority (E-14c); **VQ** no member that lacks a committed entry and could stand can collect a majority of votes (E-14c); **DJ** never two disjoint majorities at work; **SN** a stopped or removed member leads nothing: every up leader is a voter of its own applied config, and no exited member leads; **P3** 1 to 4 voters; **P9W** no log longer than twice the design's longest on the bound.

Safety, every step: **OV** every config entry keeps a majority overlap with the leader's applied config and its last config; **CK** the voter count goes from three or more to fewer than three only while a leave is in progress; **P7** no add or promotion targets a retiring machine; **LD** no hand-over targets a retiring machine; **LX** an exit never takes away the last live majority while a live machine could stand in for the leaver; **DX** an exit never leaves a committed entry on fewer than a majority of the voters that have not exited; **OL** a config entry never takes away the live majority; **B2B** a promotion from one voter happens only while another learner that answers and says nothing holds the commit offset, and right after it the next config entry is the second promotion, unless a crash, a leave or a retire hint has happened; **P9** no more config or placement entries without an outside event than twice the design's longest run ([results/maxchg.txt](results/maxchg.txt)).

Liveness, AG EF over calm steps, judged only where one more election fits under the term bound (`room`, as E-14b judged): **P5** a working leader, from every state with a live majority of the latest committed config, applied by its live voters, and no change in flight; **HF** healing finishes (a working leader, an odd voter count, three voters once three live machines say nothing, every live machine in the config while there is one voter, no gone learner); **GF** growth finishes; **DL** a gone learner is dropped; **SF** a clean stop finishes: from every state where a machine that says it is leaving is up (crashed machines or not), calm steps reach no such machine up; **LW** leaves keep the group writable (no crashed machine); **RC** a retire completes once a spare exists.

Reported, not properties: **WIN** E-14b's two-voter window; **SWAP** a fault while a change is in flight; **SWF** while a leaver is up and one machine is down, calm steps reach a working leader; **POST** after a stop (a machine exited, no leaver up), with one machine down, calm steps reach a working leader; **DUR** (a safety property in the variants `absent-dur` and `shrink-dur`, on the bounds that start at three voters) once a machine has exited, every committed entry is on two machines that have not exited, while the config names two.

### Bounds

| Bound | Start | Outside events |
|---|---|---|
| `solo` | 0 alone, nothing else | 1 leave |
| `g0`, `g1`, `gr`, `gl` | 0 alone, 1 and 2 up and empty | 1 write; 1 crash; 1 retire hint; 1 leave (any machine) |
| `g0d` | the same, 2 down at the start | none |
| `o1`, `o1f` | 0 the only voter, 1 a learner (example 01) | 1 leave and 1 write; 1 leave and 1 crash |
| `o1d` | the same, 1 down at the start | 1 leave |
| `s1`, `s2`, `s1f`, `s1f4` | three voters, no spare | 1 leave and 1 write; 2 leaves; 1 leave and 1 crash (terms to 5); the same, terms to 4 |
| `rl`, `r1`, `r1f` | three voters, no spare | a leave and a retire hint; a retire hint; a retire hint and a crash |
| `r1s`, `s1s`, `r1sd` | three voters and a spare | a retire hint; a leave; a retire hint with the spare down at the start |
| big: `g1w`, `g2`, `gs`, `gl2`, `s2f`, `s1sf` | growth with a crash and a write, two crashes, a spare, two leaves; three voters with two leaves and a crash; a spare with a leave and a crash | the design only, to 1,000,000 states |

The walks ([models/walk.py](models/walk.py)) run 1,000 seeds of up to 90 random steps on bounds too big to explore whole: `w5g` (five machines, founded by one), `w5s` (three voters and two spares), `w3` (three voters, no spare), `w2` (example 01), each with two crashes, two leaves, a retire hint and two writes. Every step is checked against every safety property. At a walk's end every judged liveness goal must be reachable by calm steps. Since a leave is usually over by the end, SF is also judged mid-walk: at the first state with a leaver up and no machine down, and at the first with a machine down; SWF and POST are searched at the first state where each is judged, and counted.

## Results

### 1. Both designs hold on every bound

[results/design.txt](results/design.txt): every property, both options, 19 bounds, every run complete. *(checked)*

| Bound | absent: states | shrink: states | Reported (judged states, stuck) |
|---|---|---|---|
| `solo` | 9 | 9 | none stuck; SF 2 judged |
| `r1` | 110 | 110 | none |
| `o1` | 3,111 | 3,111 | none |
| `o1d` | 1,565 | 1,565 | none |
| `g0` | 9,316 | 9,316 | none |
| `g0d` | 1,544 | 1,544 | none |
| `o1f` | 16,844 | 16,844 | both: SWF 504 of 546, POST 132 of 132, WIN 110 of 2,012, SWAP 30 |
| `s1` | 5,503 | 62,839 | none |
| `rl` | 12,594 | 179,111 | none |
| `r1f` | 20,190 | 20,190 | none |
| `r1s` | 41,853 | 41,853 | none |
| `r1sd` | 46,963 | 46,963 | none |
| `g1` | 75,051 | 75,051 | both: WIN 72 of 14,304 |
| `s1s` | 99,611 | 99,611 | none |
| `gr` | 140,114 | 140,114 | none |
| `s2` | 35,625 | 457,050 | none |
| `gl` | 347,854 | 804,996 | none |
| `s1f4` | 184,189 | 1,095,195 | absent: POST 1,072 of 1,360; shrink: SWF 9,938 of 15,166, POST 11,136 of 14,124, SWAP 1,174 |
| `s1f` | 300,523 | 1,832,195 | absent: POST 1,072 of 1,502; shrink: SWF 16,324 of 25,624, POST 11,136 of 14,372, SWAP 2,156 |

The growth bounds and the bounds with a spare are the same model in both options: they differ only once a voter leaves, or is retire-hinted, with no spare. SF is now judged on every state with a leaver up: 198,912 states on `shrink`'s `s1f`, 44,980 on `absent`'s, none stuck.

**Big bounds** ([results/design-big.txt](results/design-big.txt)): growth with a crash and a write (`g1w`) is complete, 748,954 states, every property (WIN 768 of 164,016, reported). Two crashes in growth (`g2`), growth with a spare (`gs`), two leaves in growth (`gl2`), three voters with two leaves and a crash (`s2f`), and a spare with a leave and a crash (`s1sf`) stop at 1,000,000 states with no safety property broken, in both options; liveness is not judged on a run that stops early. `g1w`, `g2` and `gs` have no leave and no retire hint, so they are one model for both options and ran once. *(checked)*

**The caps of P9** ([results/maxchg.txt](results/maxchg.txt)): on the 16 bounds up to `s2` and the new ones, every cap is at least twice the design's longest run (config entries, log length, transfers). `gl`, `s1f` and `s1f4` keep generous caps that were not measured again with the caps lifted (memory). *(checked)*

**Walks** ([results/walks.txt](results/walks.txt)): 5,900 walks, 195,642 steps (1,000 seeds on `w2`, `w3` and, for `absent`, `w5s`; 300 on the others). No safety property broke at any step. Every liveness goal judged at a walk's end was reachable. SF was judged mid-walk in 5,489 walks with no machine down and 4,522 with a machine down, and was reached every time. Some calm searches on `w5s` and `w5g` hit their limit of 60,000 states (up to 150 of 1,000 walks): those are undecided, not passes. *(checked)*

### 2. Per scenario

Shortest traces: [results/probes-traces.txt](results/probes-traces.txt). "Pass 1" is the ablation's first pass for `absent`: one rule dropped alone, the first property that breaks (section 5).

| Scenario | Bounds | What held | What breaks without the rules |
|---|---|---|---|
| **Growth from one voter**: a placement of three, two learners, two promotions back to back | `g0`, `g0d`, `g1`, `gr`, `gl`; walk `w5g` | every property; GF from 8,152 judged states on `g0` and 50,995 on `g1`, none stuck; shortest growth 16 steps | without `promote.pair` the first promotion goes ahead of the second learner (B2B on `o1`, 6 steps); growth's placement written only "with one voter": a dead voter is never replaced (HF in 24 of 300 seeds, walk `w5g`) |
| **A crash between the two promotions** | `g1`, `o1f` | every property; the group steps back to one voter and commits (12 and 14 steps) | E-14b's window: the second promotion commits on {0, 1}, the leader crashes before 1 applies it, nobody can stand until 0 returns (WIN 72 of 14,304 on `g1`; reported, not closed). After a crash or a retire hint, a learner drop or an add can come before the second promotion (13 and 9 steps); B2B allows it only then |
| **The step back from two voters to one** | `g1`, `o1f`, `gl`, `s1` | every property | without "two voters": CK on `g1` (16 steps); without "fewer than three live": B2B on `g0` (11); without "neither voter retiring": P9 on `o1` (22); without its append: HF on `o1f` (6) |
| **A gone learner dropped** | `o1`, `o1d`, `o1f`, `g1`, `gl` | DL from 20, 27, 95, 3,614 and 4,658 judged states, none stuck; shortest 5 steps | without the append: DL on `o1d` (1 step) |
| **A leave with no spare** | `s1`, `s2`, `s1f`, `s1f4`, `rl`, `gl` | every property in both options; SF from 3,120 (`absent`) and 30,241 (`shrink`) judged states on `s1` | a removed leader that takes a write leaves the voter left unable to win (LW on `o1`, 8 steps; `write.stay`) |
| **`leave.ms`, and the exit** | `solo`, `o1`, `o1d`, `s1`, `s2`, `gl` | with the three exit rules, every property; a one-machine server stops at `leave.ms` (3 steps), and so does an only voter whose learner is down (3 steps; the group waits for its restart) | the pages' "exit at `leave.ms` whatever": LX and DX in 3 steps on `o1` and `gl`, 6 on `s2`, both options ([results/probes-as-written.txt](results/probes-as-written.txt)). No bounded exit: SF on `solo` (1 step). Exit without `held`: DX on `s1` (6 steps). The bounded exit without its check: LX on `o1` (3 steps) |
| **A retire that stays pending** | `r1`, `rl`, `r1f`; `r1s`, `r1sd` | `r1`: the hinted machine never leaves the voters; with a spare it completes (RC), also when the spare starts later ([results/probes-pending.txt](results/probes-pending.txt)) | none: "a retire with no spare stays pending" holds as written |
| **The leave of an only voter** | `o1`, `o1d`, `o1f`, `gl` | every property in both options; shortest 12 steps: promote the learner, remove itself, hand over, the learner wins, exit | LAYERS 8.9's reading (no removal with no spare; exit at `leave.ms`) leaves the group with no voter (LX on `o1`) |
| **"A retiring voter is left to its own leave until `leave.ms`"** | every bound | every property without it | not testable here: with time as order only, no property can tell "before `leave.ms`" from "after" (the same holds for mutant m8 and for `exitalone.lms`) |

### 3. What the model found

Each finding is a rule the pages do not have, or a gap.

1. **The exit needs three checks and a bound, and this is a change to the pages.** LAYERS 8.9 B4 and DESIGN-V5 4.2 say "exit once no config names it, or at `leave.ms`". As written, an only voter that has promoted its learner but is not yet removed exits and leaves a two-voter config that cannot commit (LX on `o1`, 3 steps). The fix has four parts: the leaver exits only once the voters left have applied the latest config and can commit without it (`safe`), and hold every committed entry (`held`; without it a write committed on the leaver and one other is left on one disk: DX on `s1`, 6 steps); at `leave.ms`, if the group has no live majority or no live machine could stand in for the leaver, it stops anyway, as a crash would, and the group waits for its restart (`exitalone`; without it a one-machine server never stops: SF on `solo`); otherwise it waits past `leave.ms` while a live machine can still carry the group. In real time the wait past `leave.ms` lasts as long as the voters left take to commit one or two config changes *(reasoned)*. *(checked)*
2. **Growth writes a placement of three whenever the stored placement names fewer than three machines**, not only "with one voter" (LAYERS 2.3 rule 1). The only voter's leave picks into a placement of one, and growth then promotes past it, so a group can have three voters and a placement of one; with the "one voter" guard nothing writes three again and a dead voter is never replaced (variant `shrink-onevoter` on `w5g`: HF fails in 24 of 300 seeds; [results/walks-planted.txt](results/walks-planted.txt)). *(checked)*
3. **A leader that has appended its own removal takes no new write** (`write.stay`). Otherwise the removed leader's log holds writes the voter left lacks, the voter left cannot win, and the group is stuck with no fault (LW on `o1`, 8 steps). etcd takes proposals until the leader applies its removal; fero must not. *(checked)*
4. **"Back to back" needs its own guard, and is now checked.** B2B catches a first promotion while the second learner is behind (mutant m6, 8 steps on `g0`) and a step back while three machines say nothing (m15, 11 steps). *(checked)*
5. **A promotion of a learner that does not answer is now caught** (OL): `promote.live` on `g1` (10 steps) and `opromote.live` on `o1d` (2 steps). "Holds the commit offset" (`promote.caught`, `opromote.caught`) still breaks nothing here: E-52's fix 6 is about a window this model does not reach. *(checked)*
6. **The Raft reductions mask one Raft rule.** "No vote for an older term" breaks nothing (one candidate at a time and PreVote); "a vote goes only to a candidate" is undecided (`r1s` reaches 2,000,000 states). `commit.own` (Raft's Figure 8) is caught only by a liveness property (LW on `o1f`, 12 steps): the reductions keep the safety properties from seeing it. *(checked: pass 1)*
7. **A leader may remove itself** when every other voter is retiring (no hand-over to a retiring machine). Raft allows it, and every stop finishes. *(reasoned)*
8. **E-14b's two-voter window shows in growth** (WIN 72 of 14,304 on `g1`, 110 of 2,012 on `o1f`). No rule here closes it; E-14c bounds it. *(checked, reported)*

### 4. The decision: a voter leaves with no spare

Both options run on the same model; the only difference is one guard on `lrem` (from how many voters a leaving voter is removed).

| | absent | shrink | Mark |
|---|---|---|---|
| Safety and liveness properties, 19 bounds | all hold | all hold | checked |
| A clean stop finishes (SF), crashed machines or not | holds | holds | checked |
| **Writable through a stop with one crash (SWF, reported)** | `s1f`: 0 of 5,494 stuck; `s1f4`: 0 of 3,016 | `s1f`: 16,324 of 25,624 stuck; `s1f4`: 9,938 of 15,166; shortest 5 steps (leave, removal, it commits, a voter that stays crashes) | checked |
| SWF in the walks (first state with a leaver up and a machine down) | `w3`: 20 of 828 stuck | `w3`: 23 of 828 stuck | checked: the walks do not show the gap |
| **Two copies of each commit after the stop (DUR, a property in the variants)** | holds on `s1`, `s2`, `rl`; breaks on `s1f` and `s1f4` (13 steps: a crash during the stop, V4-60, the group ends at one voter and a learner) | breaks on all five (10 steps on `s1`: after the step back a write commits on one disk) | checked ([results/design-dur.txt](results/design-dur.txt)) |
| Writable after the stop with one crash (POST, reported) | `s1f`: 1,072 of 1,502 stuck | `s1f`: 11,136 of 14,372 stuck | checked: both mostly stuck |
| Where the stop ends (`s1`) | three voters, two up: each commit waits for both disks left; a crash of either stops writes | 8,552 of 9,404 end states at one voter and one learner: each commit waits for one disk; a crash of that voter stops writes | checked ([results/probes-outcomes.txt](results/probes-outcomes.txt)) |
| A second leave (`s2`) | the absent voter is removed as dead first (V4-60), then the group goes to one voter (12 steps) | to one voter | checked |
| Shortest stop with no spare | 3 steps (leave, `leave.ms`, exit) | 8 steps (removal, step back, exit) | checked |
| States on the stop bounds (`s1`, `rl`, `s2`, `gl`, `s1f`) | 5,503; 12,594; 35,625; 347,854; 300,523 | 62,839; 179,111; 457,050; 804,996; 1,832,195 | checked |
| Sentences needed, whole sentence dropped (of 21) | 17 | 17 | checked ([results/sentences.md](results/sentences.md)) |
| LAYERS rules needed, whole rule dropped (of 12) | 9 | 9 | checked |

**Reading.** Both options hold every property, and they need the same rules at both grains (17 of 21 sentences, 9 of 12 LAYERS rules; each needs V4-60). So **the threshold does not pick a winner**. The first version's "absent wins" rested on SFF, and the bounded exit took that gap away: a stop now finishes in both. What still separates them is reported, not a property. On the complete stop bounds with a crash, absent keeps the group writable through the stop (SWF: no stuck state on `s1f` or `s1f4`), and shrink does not: once the leaver's removal has committed, the group is at two voters, and one crash of a voter that stays stops it until that machine returns (16,324 of 25,624 states on `s1f`). After a stop with no crash, absent keeps each commit on two disks and shrink on one (DUR). The walks do not show the SWF gap (they judge it at the first crash, mostly before any removal), and after a stop with one more crash both options are mostly stuck (POST). Absent is also the shorter path (3 steps against 8), with 2 to 14 times fewer states on the stop bounds. **Input for the decision: absent is the better reading, on reported measures only. Keep LAYERS 8.9's "the leaver stays in the config, absent", add V4-60 for the second leave, and add the only voter's path and the exit rules, which both options need.** The call stays the owner's; this record cannot make it by its threshold.

### 5. Rules by ablation, and the rule count

Results: [results/sentences.md](results/sentences.md) (whole sentences and whole LAYERS rules dropped, both options), [results/pass1-absent.md](results/pass1-absent.md) and [results/ablation-absent.log](results/ablation-absent.log) (each rule dropped alone, `absent`).

**At LAYERS' grain**: a LAYERS rule counts as needed only if dropping every sentence that writes it breaks a property. *(checked)*

| LAYERS rule | absent | shrink |
|---|---|---|
| 2.3 rule 1: learners first (G1, G2) | HF on `o1d` (4 steps) | the same |
| 2.3 rule 2: back to back (G3) | B2B on `o1` (6) | the same |
| 2.3 rule 3: step back (G4) | HF on `o1f` (6) | the same |
| 2.3 rule 4: drop a gone learner (G5) | DL on `o1d` (1) | the same |
| 8.9 B1: say retiring first; no pick, add or promotion of it (S1, S2) | SF on `o1` (1) | the same |
| 8.9 B2: hand over, never to a retiring machine (S3) | nothing breaks | nothing breaks |
| 8.9 B4: the exit, with its checks and the bound (S7, S11) | DX on `solo` (2) | the same |
| The only voter's leave: promote a learner, be removed from two (S4, S5) | HF on `o1` (1) | the same |
| V4-60: dead voters removed first (S6) | SF on `s2` (2) | SF on `s1f` (2) |
| A leaving learner is dropped (S10) | nothing breaks | nothing breaks |
| `meta-members`' high rule: left to its own leave until `leave.ms` (S9) | nothing breaks (not testable here) | the same |
| New: `write.stay` (S8) | LW on `o1` (8) | the same |
| **Needed** | **9 of 12** | **9 of 12** |

**By whole sentence** (this record's 21 sentences: growth 5, healing 5, stop 11): **17 of 21 in both options**. The four that can go whole in both: the hand-over (S3; a leaving leader removes itself and Raft elects a new one), a leaving learner's drop (S10; it just exits), `pick.wait` (S9), and the healing removal from four (H-rem; the surplus removal takes the voter the placement leaves out). They can go only on these bounds: E-52's world (a directory, dial, hints) needs the add and the hand-over, and E-52 counted them. The first version said "19 of 20" because it counted a sentence as needed when one of its guards, dropped alone, makes its action misfire; counted that way the record now has 20 of 21 for `absent`.

**Each rule dropped alone, `absent`** (pass 1, DEV-10 grain; sweep `solo r1 o1 o1d g0 o1f s1 rl r1s g1`, then `gr s1s s2 s1f` for a rule the sweep does not need) *(checked)*: **68 of 114 design rules needed alone, 2 undecided** (`handover.self` reaches 2,000,000 states on `s1`; `pick.new` on `s1f`), **44 not needed**. Of the Raft core's 19 rules, 17 are caught alone, 1 is undecided and 1 is not (finding 6). Rules that break nothing alone include `promote.caught` and `opromote.caught` (finding 5), `lrem.maj` (absent removes only from two), `exit.unnamed`, `exit.nolead` and `exit.held` (the `exitms` path covers them), and the timing guards `exitms.lms`, `exitalone.lms` and `pick.wait`.

**What was not run.** `shrink`'s pass 1 was started and stopped after 670 runs, for cost: one rule there costs up to 10 CPU-minutes and 3.5 GB on `s1f`. The two options are compared at whole-sentence and LAYERS grain instead, which ran in full on all 19 bounds. The greedy pass, the smallest model and its mechanical mutants were not rebuilt on the changed model (hours more); the first version's "44 rules, 45 mutants" belongs to the old model.

### 6. Mutants and planted bugs

**Hand-written mutants** ([results/mutants.txt](results/mutants.txt); m1 to m20 from the review, m21 to m26 for the rules added since; each runs on every bound) *(checked)*:

| Mutant | What it breaks in the design | absent | shrink |
|---|---|---|---|
| m1 | the exit check ignores configs in flight | LW on `gl` (13 steps) | LW on `s2` (6) |
| m2 | the exit check does not ask the voters left to have applied the latest config | LW on `o1` (8) | the same |
| m3 | the exit check counts the leaver among the voters left | LW on `gl` (13) | LW on `s2` (6) |
| m4 | the exit check waived while a machine is down | LW on `s1f` (11) | the same |
| m5 | one promotion from one voter | B2B on `o1` (6) | the same |
| m6 | the first promotion while the second learner is behind | B2B on `g0` (8) | the same |
| m7 | `lrem`'s majority over the old set size | HF on `o1` (1) | the same |
| m8 | V4-60 before `leave.ms` | survives (timing: not testable) | undecided (`s1f`: state limit) |
| m9 | V4-60 with no majority check | LW on `s1f` (7) | the same |
| m10 | the learner drop drops a gone voter too | CK on `g1` (17) | the same |
| m11 | standby adds learners at two voters | survives (harmless: never placed, never promoted) | the same |
| m12 | `write.stay` looks only at the last entry | survives (equivalent) | the same |
| m13 | hand-over to a learner | SN on `o1` (4) | the same |
| m14 | the exit's "unnamed" reads only the committed config | survives (equivalent while P7 holds) | the same |
| m15 | step back with three live machines that say nothing | B2B on `g0` (11) | the same |
| m16 | the "retiring" mark survives a restart | SF on `solo` (4) | the same |
| m17 | the only voter promotes a learner that is down or behind | OL on `o1d` (2) | the same |
| m18 | growth's placement may name a retiring machine | survives (pass 1: `grow.cand` not needed) | undecided (`gl`: state limit) |
| m19 | `lrem.keep` accepts a leaving voter as the one that stays | survives (pass 1: not needed) | survives |
| m20 | `lrem` without the option's guard | CK on `r1` (2) | the same |
| m21 | the bounded exit at `leave.ms` whatever | LX on `o1` (3) | the same |
| m22 | the bounded exit looks only at the live majority | SF on `solo` (1) | the same |
| m23 | the bounded exit looks only at who could stand in | survives | SF on `s1f` (3) |
| m24 | the bounded exit leaves for good (no restart) | LW on `o1d` (4) | the same |
| m25 | `held` counts the leaver's own disk | DX on `s1` (6) | the same |
| m26 | healing adds a machine that says it is leaving | P7 on `o1` (4) | the same |

Two of the 26 are equivalent (m12, m14). **`absent`: 19 of 24 caught (79 %); `shrink`: 20 of 24 caught (83 %), 2 undecided.** That is under the 90 % bar. Every survivor points at a rule this model shows is not needed (m18, m19, and m23 in `absent`), a rule it cannot test (m8, timing), or a harmless change (m11). m23 is the one place where the options differ below the sentence: `shrink` needs the live-majority half of the bounded exit, `absent` does not.

**Planted bugs** (a mistake a builder could make; each must break a property) *(checked)*:

| Planted bug | Bound | Breaks |
|---|---|---|
| exit at `leave.ms` without `safe` (`exitms.safe` dropped) | `o1` | LW in 9 steps |
| the bounded exit without its check (`exitalone.alone`) | `o1` | LX in 3 |
| no bounded exit (`exitalone.stop`) | `solo` | SF in 1 |
| exit without `held` (`exitms.held`) | `s1` | DX in 6 |
| a removed leader takes writes (`write.stay`) | `o1` | LW, SF in 8 |
| no "retiring" mark (`leave.mark`) | `o1` | SF in 1 |
| growth adds a retiring machine (`standby.notret`) | `o1` | P7 in 4 |
| a gone learner is never dropped (`dropl.append`) | `o1f` | DL, HF in 2 |
| one promotion from one voter (`promote.pair`) | `o1f` | B2B in 6 |
| count acks of an older term (`commit.own`) | `o1f` | LW in 12, SF in 13 (liveness only: finding 6) |
| win without a majority (`win.maj`) | `r1` | DJ in 3 |
| no V4-60 (`ldead.append`) | `s2` | SF in 2 |
| step back from three (`stepback.two`) | `g1` | CK, OL in 16 |
| the pages' reading: exit at `leave.ms` with no checks, no only-voter path, no V4-60 | `o1`, `s2`, `gl` | LX and DX in 3, 6 and 3 (both options) |
| growth's placement written only "with one voter" | walk `w5g`, 300 seeds | HF in 24 seeds |
| `exitalone.alone` dropped | walks `w3`, `w5g`, 200 seeds each | LX in 86 and 64 seeds |
| `exitms.safe` dropped | walks `w3`, `w5g` | LW in 8 and 18 seeds |
| `promote.pair` dropped | walks `w3`, `w5g` | B2B in 9 and 82 seeds |
| `stepback.noret` dropped | walk `w3` | SF in 24 seeds |
| `write.stay` dropped | walk `w3` | LW in 1 seed |

The first 13 are `run.sh quick`'s ([results/quick-planted.txt](results/quick-planted.txt)); the rest are in [results/probes-as-written.txt](results/probes-as-written.txt) and [results/walks-planted.txt](results/walks-planted.txt). Walks are samples: in 200 seeds they did not catch `grow.small` (the model checker does: P9W on `r1`, 10 steps), `lrem.keep` or `handover.voter` (not needed in pass 1 either), nor `write.stay` and `stepback.noret` on `w5g`.

## What the model leaves out

- **No cuts, no stale or doubled messages, no slow disks, no lost disks.** A crash keeps the disk; a message is never lost or late; the lease reduction forbids a second leader while an old one is up. E-14c and E-52 have cuts and lost disks; their rules are not repeated here. *(reasoned)*
- **The new rules read facts a real leaver must learn from messages.** `safe` and `held` read every log and every applied config; `exitalone` reads which machines are truly up. A real leader knows its followers' match offsets, so a leaving leader can check `held` and `safe` from its own acks; a leaving follower must ask the leader. Behind a partition a leaver cannot learn that a live machine could carry the group, so it would wait. A partition-and-heal step (old leader still up) on `o1` and `s1` was not run: **open**. *(reasoned)*
- **Time is order only.** `leave.ms` and `evict.after` are steps that fire in the end. So no rule that is only about timing can be tested: "a retiring voter is left to its own leave until `leave.ms`" (`pick.wait`), "V4-60 waits for `leave.ms`" (mutant m8), and "the bounded exit waits for `leave.ms`" (`exitalone.lms`) all break nothing when dropped. That they are not needed is not shown; they are **not testable here**.
- **A stopped machine that the group still needs** comes back only by a restart, which is not a calm step. So after the bounded exit the group is stuck by design until a restart, and SWF and POST count such states as stuck.
- **Small worlds.** Three or four machines, one or two outside events per complete bound; five machines only in the walks, which sample and do not prove. Two bounds stop before they are complete: growth with a retire hint and a crash, and a leave with a write and a crash (both pass 2,000,000 states with no safety property broken, liveness not judged; the review's runs, on the first version's model). A leave, a retire hint and a crash together (`rlf`) passes 3,000,000 states in `shrink`.
- **One group.** No directory, no dial, no hints but retire, no drain, no hand-back, no preferred member (E-52 has them); no slot moves.
- **SN covers leadership only.** No reads are modelled, so "a stopped member serves nothing" is checked for leading and committing only.
- **Raft is reduced**: whole-log replication, PreVote, one candidate at a time, CheckQuorum, no proposals during a transfer. These are pinned, not counted.

## Against the threshold

**Growth from one voter: holds**, in both options, on every complete bound, with LAYERS 2.3 rule 1 changed (growth writes three whenever the placement names fewer than three) and "back to back" now a checked property. E-14b's window shows and is reported, not closed.

**A clean stop: holds**, in both options, once the exit has its checks (`safe`, `held`) and its bound (`exitalone`), the only voter promotes its learner first, and a removed leader takes no write. "Exit at `leave.ms`" as the pages write it breaks LX and DX in 3 steps. The bounded exit is a change to LAYERS 8.9 B4 and DESIGN-V5 4.2, not their rule made safe: a leaver that nothing can carry the group without stops at `leave.ms` and the group waits for its restart; otherwise it may wait past `leave.ms` while a live machine can still carry the group.

**The decision: no winner by the threshold.** Both options hold the same properties and need the same rules. The reported measures favour `absent` (writable through a stop with one crash on the complete bounds; two copies after a stop; a shorter path). That is input for the owner, not a verdict.

**The counts**: whole sentences and LAYERS rules ran in full for both options; pass 1 for `absent` only; no smallest model on the changed model. **Mutants**: 79 % and 83 % of the non-equivalent hand-written mutants caught, under the 90 % bar, with every survivor explained; 20 planted bugs, each caught.

**What changes in the records**: LAYERS 2.3 rule 1 (growth writes three whenever the placement names fewer than three); LAYERS 8.9 B4 and DESIGN-V5 4.2 (the exit checks and the bounded exit, as above; a leaving leader takes no new write); the leave of an only voter promotes its learner first in both readings; V4-60 for a second leave. 8.9 B2's hand-over, the leaving learner's drop and "a retiring voter is left to its own leave until `leave.ms`" are not needed on these bounds; the last is not testable here.

**Still open**: partitions and stale messages (the exit rules read global facts here); a bound with a leave, a retire hint and a crash together; `shrink`'s pass 1; the smallest model on the changed model.

## How to rerun

```sh
./run.sh quick   # about 10 CPU-minutes: both options on the small bounds, 100 seeds per walk, planted bugs, DUR on s1, the probes
./run.sh         # everything: every bound, the big bounds, DUR, the walks, the probes, the caps of P9, mutants, whole sentences, pass 1 of absent
```

Needs Python 3 (standard library). It imports E-16's engine and E-17's `dsl.py` unchanged. `OUT` sets the output folder (default `results`), `HEAVY` wraps long runs (for example a lock), `CACHE` sets the ablation's run cache (default `./cache`, not part of the results), `JOBS` the worker processes. Every model run pins `PYTHONHASHSEED=0` and caps its memory at 4 GB (`MEMCAP_MB`); `shrink`'s `s1f` peaks at 3.5 GB. Model and tool hashes are in [results/versions.txt](results/versions.txt).
