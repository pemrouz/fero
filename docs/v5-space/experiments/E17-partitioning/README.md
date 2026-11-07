# E-17: how many rules each way of mapping partitions onto groups needs

**Question (Q-17).** Measured, not guessed: how complex is each way of mapping partitions onto groups? The options ([QUESTIONS.md](../../QUESTIONS.md) E-17; SPACE axis P): a fixed group count (`fixN`); `fixN` + re-key (CELL); slot moves (MIN, DRAFT and every slot row); `pslot`, slot moves in groups shared by a project's resources (MIN-P); split + merge (SPLIT); lanes + range moves (LANE).

**Threshold** (QUESTIONS Q-17). Among the options that meet SC-03 (writes scale up), SC-04 (scale down) and SC-08 (no worry during a change), the fewest necessary rules wins axis P. If `fixN` + re-key is smaller than slot moves, the verdict states the trade in numbers.

**Three parts, one harness.**
- [Part 1](PART1.md) built the shared harness ([HARNESS.md](HARNESS.md)) and checked `fixN`, re-key and slot moves.
- [Part 2](../E17b-partitioning-part2/README.md) added `pslot`, split + merge and lanes + range moves on the same harness.
- [Part 3](../E17c-partitioning-rerun/README.md), a second agent, re-ran every ablation from scratch and hunted for rules the harness misses or counts wrongly. This file is the E-17 verdict, written by part 3.

**Words.** A *rule* is one guard conjunct or one state update in a model action. It counts only if removing it lets the checker find a counterexample (REQUIREMENTS DEV-10). *Ablation* removes rules one by one to find a *smallest set*, where removing any one rule breaks a property (1-minimal). A *give-up path* is how a change is abandoned half-way (an abort). *Lineage* is the chain a reader follows from a partition's old group to its new one. *Dedup transfer* and *fence transfer* carry the "already applied" table and the highest lock token to the new group.

TBD
