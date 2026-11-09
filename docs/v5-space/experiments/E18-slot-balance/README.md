# E-18: do 1,024 slots spread load well enough, with hot keys, as groups grow?

**Question (Q-18).** Every slot row (MIN and its variants, DRAFT, RUST, SRV, LEAN, SLOG, OBJ) gives each resource a fixed number of slots, forever: 1,024 in the draft. A partition hashes to one slot; groups (one writer each) own sets of slots and move them to follow load. Do 1,024 slots spread a resource's load evenly enough, with hot keys, as groups grow? Would 256, 4,096 or 16,384 be better? And how many writers does one resource really get (SC-10's **effective writers**: the largest group count at which max/mean group load stays ≤ 1.25 under Zipf 0.99), against the floor F_w = 64?

**Q-18's threshold** (QUESTIONS.md): 1,024 keeps max/mean ≤ 1.25 up to 64 groups on every distribution, except where one partition alone exceeds 1/G → keep 1,024. If 4,096 passes where 1,024 fails → change it now. Effective writers below 64 with 1,024 slots → the slot count changes now, or SC-03's ceiling fails for every slot row.

**Short answer.**
- **As SC-10 words it, every design fails, slots or not.** Under Zipf 0.99 the hottest partition carries 5.5 % to 9.8 % of a resource's load, so no design can keep max/mean ≤ 1.25 beyond 12 to 22 groups. Every slot count from 1,024 up, and the key-level ideal, reach exactly 12 to 22. This is the workload, not the slots: SC-10 needs the clause "with partitions above half a writer's share split by the app", which DESIGN-V5 §2 already asks of apps.
- **With that split, 1,024 slots meet F_w, but only just.** Effective writers: 72 in the worst draw (Zipf 1.2), 79 under Zipf 0.99, and 180 to 240 in the median Zipf 0.99 draw. 4,096 slots give 135 or more in every draw (212 under Zipf 0.99), 16,384 give 476 or more, and 256 slots fail (32 to 44 under Zipf).
- **1,024 slots keep max/mean ≤ 1.25 up to 64 groups on seven of eight distributions in every draw, but not on heavy-tailed room sizes.** Under Pareto 1.16 (the 80/20 rule) two big rooms, each under a fair share, sometimes hash into the same slot, and nothing can split a slot: max/mean 1.386 at G = 64 in one of part A's 10 draws, and a slot failure in 0.2 % to 1.0 % of 2,200 more draws (part E). 4,096 slots pass that very draw (1.002) and fail 0 % to 0.5 % of the time; 16,384 slots 0 % to 0.1 %. The rule does not excuse these points: no single partition passes 1/G.
- **More slots copy less data per move; the number of moves hardly changes.** A moving hotspot costs about 30 to 50 moves at 64 groups at every slot count, copying 3 to 4 % of the resource at 1,024 slots, 0.8 to 1.6 % at 4,096, and 0.6 % for an ideal per-key design. Adding or removing a group copies its fair share (1/G) at every slot count.
- **Placement must follow load, one move at a time.** Equal slot ranges with no load data fail at G = 2 to 24 under skew. The draft's grow rule as written (the busiest group hands half its slots to a new group) leaves max/mean 1.5 at G = 3, 6, 12, ... and up to nearly 2 below each power of two; a one-move controller fixes it. A fresh greedy repack after a shift would copy 70 to 97 % of the rows. Fixed counts with no moves (CELL's 16 cells, LANE's 64 lanes) give one resource only 7 to 15 and 23 to 53 writers' worth of throughput under skew.
- **So, by the threshold's own words, 4,096 passes where 1,024 fails: change the default to 4,096 now,** while it is a free choice (DESIGN-V5 §2 already makes `slots` a per-resource power of two fixed at define time). Its price, four times the per-slot state and whole-resource cursors of up to 4,096 entries, is E-19's and E-36's to confirm; 1,024 stays a valid fallback (it meets F_w at 72) if that price is too high.

Evidence labels: **measured here** (files in `results/`), **reasoned** (said where used), **cited** (linked where used). Nothing here is a timing: every number is a count or a ratio from a simulation.

## Words

- **Partition:** the unit of order a user writes to (a room, a row). By default one key. One partition is never split by fero: it has one writer (DESIGN-V5 §2).
- **Slot:** a fixed hash bucket of partitions. A partition's slot is `hash(partition) mod S`, for good. S is the slot count: 256, 1,024 (the draft), 4,096 or 16,384 here.
- **Group:** one Raft group, so one writer. It holds a set of slots. G is the number of groups a resource has.
- **Load:** writes a second. A slot's load is the sum of its partitions' loads; a group's load is the sum of its slots'.
- **max/mean:** the busiest group's load over the average group load. 1.00 is perfect. 1.25 is the bar Q-18 sets. When the busiest group is full, the resource does G / (max/mean) writers' worth of work: its **writer-equivalents**.
- **Key-level ideal:** what a design that could place every partition on its own would reach: max(mean, hottest partition). No design does better, because nothing splits a partition.
- **Exempt:** a point where the hottest partition alone carries more than 1/G of the load. There, max/mean > 1 for every design, so Q-18's threshold excuses it ("a ceiling for any design").
- **The controller:** one loop that moves one slot at a time (MIN's `cent-co`, DESIGN-V5's healer). Each move takes the busiest group's slot that is nearest half the gap to the least loaded group, and only moves that lower the busiest of the two. It acts when the busiest group passes 1.25 times its floor (or the least loaded falls under 0.75 times the even share) and stops at 1.10 (and 0.90). A slot too big to move usefully (a lone hot slot) is left where it is, and the controller balances the rest. A move must win by a margin (1e-9 of the floor), or two equal pieces can swap back and forth for ever (see "What the model leaves out").
- **App split:** the app splits a hot partition into named pieces, `room42-0` ... `room42-7`, each hashing on its own, as DESIGN-V5 §2 says ("The app splits it ... if it must"). Here: every partition above c/G of the load is split into the smallest power of two of equal pieces that brings each to c/G or below, with c = 0.5 (half a writer's fair share) unless stated.

## Method

A Python simulation (`src/`), with the inner loops in a small C file (`src/kern.c`, our own code, loaded through ctypes). Every C function has a plain-Python twin. `src/selftest.py` checks that greedy packing (400 cases) and the controller (1,200 cases) give exactly the same loads, moves and assignment as their twins; checks the contiguous cut against an exact dynamic program (202 cases) and greedy packing against brute force (315 cases; worst 1.115 of the optimum, inside Graham's 4/3 bound); and runs a regression for a bug found on the way (300 cases, below). Output: `results/selftest.txt`, `results/selftest-regression.txt`.

**Workloads** (`src/gen.py`). N = 1e4, 1e5, 1e6 and 1e7 partitions. Each partition gets a random 32-bit hash (numpy's PCG64 stands in for a good hash; part D checks real hashes) and a load:
- `uniform`: all equal;
- `zipf-0.8`, `zipf-0.99`, `zipf-1.2`: the partition of rank r gets r^-s; the ranks are independent of the hashes. The hottest partition carries 3.7 % to 0.8 % (s = 0.8), 9.8 % to 5.5 % (s = 0.99) and 21 % to 19 % (s = 1.2) of the load, from N = 1e4 to 1e7;
- `pareto-1.16` and `pareto-2`: room sizes drawn from a Pareto law (shape 1.16 is the 80/20 rule), load in proportion to size;
- `hot-0.01` and `hot-0.1`: uniform, plus one partition with 1 % or 10 % of all load;
- a moving hotspot is part C.
Seeds: 10 at N = 1e4 and 1e5, 5 at 1e6, 3 at 1e7 (part A); fewer in part B (10, 5, 3, 2 for Zipf 0.99; 3, 2, 2, 1 for the rest). Slot at S = 1,024 is slot at 4,096 mod 1,024, so a partition keeps "its" slot across slot counts and the comparison is paired.

**Part A, placements on a grid** (`src/static.py`), G = 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256:
- `fixN`: no slots; partitions hash straight onto G groups (CELL's 16 cells, LANE's 64 lanes, Kafka partitions);
- `ranges-equal`: G contiguous runs of slots with equal slot counts, as a hash-range split without load data;
- `ranges-best`: G contiguous runs of slots cut to the least max load (bisection; exact to 1e-12);
- `lpt`: greedy packing from scratch (largest slot first, each to the least loaded group);
- `inc`: the controller, growing one group at a time from 1 (after each new group it moves slots until it stops); also counts the moves and rows copied on the way;
- `halving`: the draft's grow rule as written in DESIGN-V5 §4.2: the busiest group hands "the half of its slots that splits its measured load evenly" to a new group (here the most even split greedy packing finds), and nothing else moves;
- the key-level references, with no slots: `key-lb` (the ideal), `key-lpt` (greedy packing of partitions: the pruned per-key directory) and `key-contig` (the best contiguous cut of partitions in hash order: SPLIT's and PD's shape).

**Part B, effective writers** (`src/eff.py`): max/mean at **every** G from 1 to min(S, 1,024), for greedy packing and for the controller, on the load as drawn ("pure") and with the app split ("split", c = 0.5; also c = 0.25 and c = 1 for Zipf 0.99). Read off E, the largest G such that max/mean ≤ 1.25 at every G' ≤ G (SC-10's definition), E07 for SC-03's 0.7 × n (max/mean ≤ 1/0.7), and the most writer-equivalents. Also fixN at 16 and 64 groups.

**Part C, moves after a load shift** (`src/dyn.py`): N = 1e4 and 1e6, G = 16, 64, 256, 3 seeds. A resource starts packed by greedy packing (slots with no partition are dealt out evenly by count), then its load shifts and the controller acts as described. Scenarios: the 100 hottest Zipf 0.8 partitions move to new random partitions every epoch (30 epochs); the same at Zipf 0.99 with the app split; Zipf 0.99 drifting (1 % of ranks reshuffled per epoch); a 1 % hot partition that jumps every epoch; one total reshuffle; a switch from uniform to Zipf 0.99; a group added; a group removed. Per epoch: the busiest group over the floor just after the shift, moves, rows copied (as a share of the resource's rows), and the rows a fresh greedy packing would copy instead (its groups matched greedily to the current ones). At N = 1e4 the same controller also runs over partitions instead of slots (a per-key directory) as the reference for data moved.

**Part D, real hashes** (`src/hashcheck.py`): keys `room0` ... `room999999` hashed with CRC-32, FNV-1a, BLAKE2b and MD5 (first 4 bytes), slot = hash mod S; slot fill and max/mean at G = 64 and 256, against the random stand-in's spread over 5 seeds.

**Part E, how often slots collide** (`src/tail.py`): part A's one failure was a chance collision, so part E draws 1,000 fresh resources at N = 1e4 and 1e5 and 200 at 1e6, for six loads, as drawn and with the app split, and counts the draws where greedy packing passes 1.25 at some G ≤ 64 that Q-18 does not excuse. Seeds start at 100, apart from parts A and B.

Run: `./run.sh` (all parts; each heavy part is one hold of the heavy lock, two processes at a time). Raw output goes to the scratchpad; `results/` holds `summary.md` (every table, generated by `src/report.py`), `static-agg.csv.gz`, `eff-raw.csv`, `fixN-raw.csv`, `dyn-raw.csv.gz`, `hash.csv`, `tail-agg.csv`, `selftest.txt`, `selftest-regression.txt`, `machine.txt` and `walltime.txt`. `fetch.sh` downloads nothing: the study box already has everything used. Nothing is timed: the results are counts and ratios, so the timing lock is not needed. Machine: `results/machine.txt` (4 vCPU, Python 3.13.17, numpy 2.5.3, pandas 3.0.5, gcc 13.3).

## Results

All numbers are **measured here** by simulation (`results/summary.md` has every table; the raw aggregates are the CSV files). Where a line is arithmetic or a design reading, it says **reasoned**.

### A. Balance on a grid of group counts (part A)

**A1. Q-18's first test: max/mean up to 64 groups.** The worst value over every distribution's non-exempt points with G ≤ 64, over all N (1e4 to 1e7) and all seeds (`summary.md` A1):

| Placement | 256 slots | 1,024 slots | 4,096 slots | 16,384 slots |
|---|---|---|---|---|
| greedy packing, all distributions but Pareto 1.16 | 1.234 (hot 1 %) | 1.051 (hot 1 %) | 1.013 | 1.005 |
| the controller, same | 1.228 | 1.100 (its own target) | 1.100 | 1.100 |
| either, Pareto 1.16 | **1.485** | **1.386** | 1.004 (lpt), 1.100 (controller) | 1.001, 1.100 |
| first non-exempt fail on the grid (any distribution, greedy packing) | G = 64 (Pareto 1.16); 96 (Pareto 2, hot 1 %); 192 (uniform) | G = 64 (Pareto 1.16); 256 (Pareto 2) | none to 256 | none to 256 |

- **1,024 slots pass on seven of the eight distributions**, at every N and every seed: greedy packing stays at or under 1.051, and the controller at its own stop line, 1.10.
- **The one failure is real and is not excused by Q-18's rule.** Pareto 1.16, N = 1e5, seed 0, G = 64: max/mean 1.386. The two rooms carrying 1.198 % and 0.881 % of the load both hash into slot 340 of 1,024. Each is under 1/64 (1.5625 %), so no single partition passes a fair share; the slot holding both carries 2.166 %, and it cannot be split. At 4,096 slots the same two rooms land in slots 340 and 3,412, and the same draw gives 1.002. So, read literally, **"4,096 passes where 1,024 fails"**. Part E measures how often this happens.
- **256 slots are too few.** Even uniform load fails at G = 192 (about 1.3 slots per group), and hot 1 % reaches 1.234 at G = 64.
- **Placement must use load data.** Equal slot ranges with no load data (`ranges-equal`) fail at G = 2 to 24 on the skewed loads and at G = 48 to 96 on uniform load. Contiguous ranges cut by load (`ranges-best`, the range-split shape) are close to greedy packing, but not always: at 16,384 slots they reach 1.257 (Zipf 1.2) and 1.288 (Pareto 1.16, G = 2).
- **The draft's grow rule alone does not balance.** "The busiest group hands half its slots to a new group" gives max/mean 1.50 at G = 3, 6, 12, 24, 48, 96 and 192 on uniform load, at every slot count, and 1.0 only at powers of two. Arithmetic says it reaches (2^(k+1) - 1)/2^k, nearly 2, just below each power of two (reasoned: G = 63 leaves one group with 1/32 of the load, against a mean of 1/63). The draft grows by a threshold (`shard.rate`), not to a group count, so in its own terms this means groups sit between half and full load and a load can take up to twice the groups it needs (reasoned). The one-move controller has no such gaps.

**A2. Placements side by side at G = 64** (worst seed over every N, `summary.md` A2; slot rows at 1,024):

| Distribution | fixN (hash onto G) | equal ranges | best ranges | halving | greedy | controller | key-level contiguous | key-level greedy | key-level ideal |
|---|---|---|---|---|---|---|---|---|---|
| uniform | 1.216 | 1.267 | 1.037 | 1.011 | 1.005 | 1.056 | 1.005 | 1.005 | 1.000 |
| hot 1 % | 1.743 | 1.774 | 1.050 | 1.051 | 1.051 | 1.047 | 1.010 | 1.001 | 1.000 |
| Pareto 2 | 2.86 | 2.87 | 1.985 | 1.985 | 1.985 | 1.985 | 1.887 | 1.887 | 1.887 |
| Zipf 0.99 | 9.94 | 9.79 | 6.55 | 6.55 | 6.55 | 6.55 | 6.26 | 6.26 | 6.26 |

Where the hottest partition passes a fair share (Zipf 0.99 here: 6.26 for every design), slots add the hot partition's slot-mates on top of it: 6.55 against 6.26, 5 % more. Where it does not, slots with greedy packing or the controller are within 5 % of the key-level ideal, except for the collision above. The key-level designs (SPLIT's contiguous ranges, a per-key directory) gain at most that 5 % over slots at G ≤ 64.

**A3. The point where one slot alone passes a fair share** (median over seeds, `summary.md` A4): on every skewed load the hottest slot passes 1/G at, or a little before, the G where the hottest partition does (Zipf: 5 to 122; Pareto 1.16: 16 to 50; hot 10 %: 10 to 11; hot 1 %: 92 at 1,024 slots against 100; Zipf 0.8 at N = 1e7: 110 against 122). With no hot partition it comes much later: uniform load at 1,024 slots passes it at G = 501 (N = 1e4) to 995 (N = 1e7); at 256 slots at G = 172 to 253.

**A4. What growing costs.** Growing one group at a time from 1 to 64 with the controller copies 3.4 to 3.8 times the resource's rows on uniform load (about the sum of 1/G over the groups added, reasoned), and 1.5 to 3.0 times on Zipf 0.99. The number of moves grows with S: about 970 at 256 slots, 3,400 at 1,024, 13,200 at 4,096 and 50,000 at 16,384 (N = 1e6, uniform; `summary.md` A5). Rows copied hardly depend on S; moves grow in proportion to it.

### B. Effective writers per resource (part B)

**B1. Read literally, SC-10's definition fails every design.** Under Zipf 0.99 as drawn, the hottest partition carries 5.5 % (N = 1e7) to 9.8 % (N = 1e4) of the load. No design can then keep max/mean ≤ 1.25 past 1.25 / 0.098 = 12 to 1.25 / 0.055 = 22 groups. Every slot count from 1,024 up reaches exactly that ceiling (E = 12 to 22, the same as the key-level ideal; 256 slots fall one short at N = 1e6 and 1e7), and so would CELL, LANE, SPLIT and a per-key directory. The number of partitions does not rescue it: the hottest share falls as 1/H(N), and getting it under 1.25/64 would take about 6e17 partitions (reasoned from H(N, 0.99) ≈ (N^0.01 - 1)/0.01 + 0.58). So **SC-10's effective number, as written, is 12 to 22 for every candidate, below F_w = 64.** This is a property of the workload, not of slots: DESIGN-V5 §2 already says one partition is one writer and the app splits a hot one.

**B2. With the app splitting hot partitions** (each above half a fair share, c = 0.5), the slot count decides. E, worst over N = 1e4 to 1e7 and all seeds (median in brackets), Zipf 0.99:

| Slots | greedy packing | the controller | most writer-equivalents (median, N = 1e6) |
|---|---|---|---|
| 256 | **44** (75 to 115) | 44 | 115 |
| 1,024 | **79** (178 to 236) | 79 | 355 |
| 4,096 | **212** (353 to 823) | 212 | 742 |
| 16,384 | **476** (862 to 1,024) | 476 | 1,016 |

On every distribution with the app split, 1,024 slots give E ≥ 64 in every draw: the worst is 72 (Zipf 1.2, N = 1e5), then 79 (Zipf 0.99), 155 (Pareto 1.16), 189 (Zipf 0.8), 285 (hot 10 %), 322 (Pareto 2) and 324 (hot 1 %); uniform needs no split and gives 321 to 568. Medians are 1.5 to 3 times the worst. 256 slots fall below 64 (44 for Zipf 0.99, 32 for Zipf 1.2). 4,096 slots give 135 or more on every distribution.

**B3. The app must split finely enough.** If the app splits only what passes a whole fair share (c = 1), 1,024 slots give E = 80 to 90 (median) and 30 (worst, N = 1e4) under Zipf 0.99; the worst is 30 at every slot count, since pieces just under a fair share then pack two to a group (reasoned from the equal worst across S). Splitting to a quarter (c = 0.25) gives 242 to 397. So the stated ceiling needs the rule "split a partition above half a writer's share", not "above a writer's share" (`summary.md` B3).

**B4. Without slots, hashing straight onto a fixed count balances badly under skew.** With the app split (c = 0.5), worst max/mean at 64 groups (LANE's lanes) is 1.21 on uniform load and 1.35 to 2.72 on the skewed loads, so 64 lanes give 23 to 53 writer-equivalents for one resource; 16 groups (CELL's cells) give 7 to 15 (`summary.md` B2). They have no move to fix it.

### C. Moves after a load shift (part C)

Means per epoch over 30 epochs and 3 seeds, at G = 64 (`summary.md` part C has G = 16 and 256 too). "Rows %" is the share of the resource's rows copied; "before" is the busiest group over its floor just after the shift, before any move.

| Scenario (N = 1e6 unless said) | 256 slots: moves, rows % | 1,024 | 4,096 | 16,384 | key-level, N = 1e4: rows % | before (1,024) |
|---|---|---|---|---|---|---|
| 100 hottest move, Zipf 0.8 (N = 1e4) | 34.7, 13.5 | 39.1, 4.29 | 44.9, 1.59 | 50.7, 0.83 | 0.57 | 1.43 (max 2.12) |
| 100 hottest move, Zipf 0.99 split | 33.3, 13.0 | 33.3, 3.26 | 32.5, 0.80 | 31.5, 0.19 | (not run) | 1.97 (max 3.26) |
| Zipf 0.99 split, 1 % of ranks drift | 1.2, 0.46 | 0.6, 0.06 | 0.6, 0.02 | 0.5, 0.00 | (not run) | 1.15 (max 1.60) |
| a 1 % partition jumps | 2.1, 0.83 | 1.9, 0.19 | 1.8, 0.04 | 1.1, 0.01 | 0.02 | 1.64 (max 1.69) |
| one total reshuffle, Zipf 0.99 split | 33.7, 13.1 | 33.0, 3.23 | 32.7, 0.80 | 32.0, 0.20 | (not run) | 1.80 (max 1.90) |
| uniform becomes Zipf 0.99 split | 29.3, 11.5 | 29.7, 2.90 | 32.0, 0.79 | 35.3, 0.22 | (not run) | 1.70 (max 1.82) |
| a group joins (63 to 64) | 4.0, 1.57 | 14.0, 1.46 | 50.0, 1.42 | 171, 1.41 | 1.41 | 1.06 |
| a group leaves (64 to 63) | 4 forced, 1.56 | 16 forced, 1.56 | 64 forced, 1.56 | 256 forced, 1.56 | (not run) | 1.05 |

- **The number of moves hardly depends on the slot count; the data copied does.** A moving hotspot costs about 30 to 50 moves an epoch at 64 groups whatever S is, so 1,024 slots copy 3 to 4 % of the resource per shift, 4,096 slots 0.8 to 1.6 %, and 16,384 slots 0.2 to 0.8 %. A per-key controller copies 0.6 % for the same shift (Zipf 0.8, N = 1e4, the one case run both ways). So 1,024 slots copy about 7 times what the ideal copies; 4,096 about 2 to 3 times.
- **Adding or removing a group copies its fair share** (1/G of the rows: 1.4 to 1.6 % at G = 64) at every slot count, as SC-08(f) asks. Only the number of moves changes, about S/G.
- **A fresh greedy packing would copy 70 to 97 % of the rows** after the same shifts (column "repack" in `summary.md`), so moving one slot at a time is the only sane way to follow load.
- **A shift overloads one group 1.4 to 3.3 times its floor until the controller moves slots.** How long that lasts is the move time (SC-08(b): 10 ms per move, E-13) times the moves, about 33 here; this model has no time.
- **The controller reached its band in every epoch with 16 or more slots per group.** With 4 slots per group (256 slots at G = 64, 1,024 at G = 256) it sometimes stopped short (92 to 94 % of epochs reached its band; one add-group case never did), and with one slot per group (G = S) nothing can move. No run hit the move cap.

### D. Real hashes (part D)

The other parts give each partition a random hash. Here the keys are real names, `room0` to `room999999`, hashed four ways (`summary.md` part D):
- **FNV-1a, BLAKE2b and MD5 behave like the random stand-in:** chi-square per degree of freedom 0.91 to 1.11 (random: 0.92 to 1.09), and max/mean at G = 64 and 256 inside or next to the random spread.
- **CRC-32 is more even than random on sequential names** (chi-square per degree of freedom 0.23 to 0.82): its linearity spreads `room0, room1, ...` very evenly over the low bits. That does not hurt balance here. A linear hash does let someone choose keys that collide (reasoned; not tested).
- Under Zipf 0.99 at G = 256 with 1,024 slots, the result depends on where the few hot partitions land: 1.39 to 1.68 across the four hashes, against 1.33 to 1.60 across 5 random seeds. The same spread.
So the random stand-in is fair to any good hash.

### E. How often the slots alone break the bar (part E)

Part A's one failure was a chance collision, so part E counts it over 2,200 fresh draws per distribution (1,000 at N = 1e4 and 1e5, 200 at 1e6). A draw fails when greedy packing passes 1.25 at some G ≤ 64 where Q-18 does not excuse it. Rates in %, worst over N (`summary.md` part E, with 95 % intervals; `tail-agg.csv`):

| Load | 256 slots | 1,024 | 4,096 | 16,384 | median first failing G at 1,024 |
|---|---|---|---|---|---|
| Pareto 1.16, as drawn | 4.9 | **1.0** | 0.5 | 0.1 | 34 to 39 |
| Zipf 0.8, as drawn | 6.9 | 0.3 | 0 | 0 | 27 to 44 |
| Zipf 0.99, as drawn | 4.0 | 0 | 0 | 0 | - |
| Pareto 2, uniform, hot 1 %, as drawn | 1.8 | 0 | 0 | 0 | - |
| Zipf 0.99, app split | 34.5 | **1.1** | 0.1 | 0 | 47 to 55 |
| Pareto 1.16, app split | 21.7 | **1.5** | 0.5 | 0.5 | 15 to 51 |
| Zipf 0.8, app split | 4.9 | 0.1 | 0.1 | 0.1 | 60 |

- **At 1,024 slots about 1 resource in 100 with heavy-tailed load hits a slot that cannot be balanced before 64 groups;** at 4,096 slots about 1 in 200 to 1 in 1,000; at 256 slots up to 1 in 3.
- The Pareto 1.16 rate with the app split is the same at 4,096 and 16,384 slots (0.1 to 0.5 %, failing first at G = 15 to 31), so that residue is not the slots: it is the app's pieces, up to half a fair share each, packing badly at small G (reasoned from the equal rates).
- When it happens, the fix is the app's: split one of the two colliding rooms, and its pieces hash elsewhere. fero can see it (one slot above 1.25/G) and can say so in the health line (reasoned).

### What more slots cost (reasoned; E-19 and E-36 price these)

| Per resource | 256 | 1,024 | 4,096 | 16,384 |
|---|---|---|---|---|
| whole-resource cursor, entries (DESIGN-V5 §2: about 8 KB at 1,024) | 256 | 1,024 | 4,096 | 16,384 |
| slot table rows in `#meta`; last-sequence, dedup and fence state per slot | ×0.25 | ×1 | ×4 | ×16 |
| moves to add or drain one group at G = 64 (measured, part C) | 4 | 14 to 16 | 50 to 64 | 171 to 256 |
| data copied per hotspot shift at G = 64 (measured, part C) | 13 % | 3 to 4 % | 0.8 to 1.6 % | 0.2 to 0.8 % |
| effective writers, Zipf 0.99 split, worst (measured, part B) | 44 | 79 | 212 | 476 |

At the draft's own 8 bytes an entry, a whole-resource cursor at 4,096 slots is about 32 KB, past Q-19's "worst ≤ 8 KB" bar unless E-19 finds a denser coding (about 2 bytes an entry) or a server-side cursor token (reasoned from DESIGN-V5 §2's figure). Most readers follow a few partitions and hold one entry each, whatever S is. 16,384 slots cut the remaining collisions further (0 to 0.1 %) and copy four times less again per move, at four times the cost again; to 64 groups their balance is otherwise the same as 4,096's.

## What the model leaves out

- **Time.** Loads change in steps and the controller acts at once. How long a group stays overloaded after a shift is the moves (about 33 at G = 64) times the move time (SC-08(b), E-13).
- **Measurement.** The controller sees each slot's exact load. A real one sees a noisy, late estimate, which costs some extra moves (reasoned).
- **Only write load.** Rows, bytes and memory per group, and read load, are not balanced here. Data copied is counted in rows of equal size.
- **One resource at a time, groups as writers.** Several groups per server, and placing groups on servers, are not modelled (E-11, E-36). G groups are G writers.
- **The fixed cost per slot × resources** (E-36) and **cursor sizes** (E-19) are not measured here; the table above only reasons about them.
- **Hashes:** random 32-bit values in parts A to C and E; part D checks four real hashes on sequential names only, with no chosen (adversarial) keys.
- **The app split** is perfect and instant: equal pieces, each hashing on its own. Real apps split late and unevenly.
- **One controller policy:** one move at a time, busiest group to least loaded, no swaps. Redis Cluster's and Couchbase's rebalancers differ in detail (cited only as the precedent for slot moves in SPACE.md; not compared).
- **DEV-10 does not apply:** this is a load simulation with no safety rules, so it counts no rules and makes no mutants. Its code is checked instead by plain-Python twins, brute force, an exact dynamic program and a regression case (`results/selftest.txt`, `results/selftest-regression.txt`). That regression is a real trap for MIN's controller: with no margin on "this move helps", the one-move loop swapped two equal pieces back and forth for ever in 48 of 300 test cases (found in part B at 16,384 slots, G = 611); every part was re-run with the fix, and part A's numbers did not change.
- **This box:** nothing here depends on its speed. CPU used: about 1.5 CPU-hours in all (QUESTIONS estimated 1.5), including the runs discarded before the fix (`results/walltime.txt`; wall times include waits for the shared lock).

## Verdict

- **The literal threshold is met for a change:** 4,096 slots pass the Pareto 1.16 draw where 1,024 slots fail, and over 2,200 more draws they fail 2 to 10 or more times less often. The other two tests do not force a change: 1,024 slots meet F_w with the app split (72 in the worst draw), and as SC-10 is worded no slot count can meet it. So the default changes to 4,096 now because it is cheap now and a format change later, not because 1,024 fails the floor.
- **What each slot row should state as its ceiling:** with 4,096 slots, 135 writers per resource in the worst draw (212 under Zipf 0.99; 350 to 820 in the median draw); with 1,024, 72 (180 to 240 in the median draw under Zipf 0.99).
- **SC-10 must be restated for every candidate:** "the largest group count at which max/mean ≤ 1.25 under Zipf 0.99, with every partition above half a writer's share split by the app". Splitting only at a whole writer's share gives 30 at every slot count.
- **The controller is part of the answer.** Load-blind ranges, the draft's halving rule and a fresh repack all fail; one slot at a time, with a strict-improvement margin, works at every slot count.

Q-18: Change the default to 4,096 slots now: 1,024 slots keep max/mean ≤ 1.25 to 64 groups on seven of eight loads but not on Pareto 1.16 room sizes, where two big rooms share a slot in about 1 % of draws (max/mean 1.386 in part A; 4,096 slots pass that draw and fail 0 to 0.5 % of the time), and they meet F_w only narrowly (72 effective writers in the worst draw, against 135 at 4,096 and 32 at 256), while SC-10's definition, read literally, caps every design at 12 to 22 under Zipf 0.99 and must add "with partitions above half a writer's share split by the app"; 4,096 slots also copy 4 times less data per hotspot move, at 4 times the per-slot state and cursor entries, which E-19 and E-36 must confirm (1,024 is the fallback). Moves: MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, RLOG, EMB-V8, SIDE, DRAFT, SLOG and OBJ up on SC-03 and SC-10 (a stated ceiling of 135 writers per resource at 4,096 slots, above F_w) and on DEV-09 (the slot count is fixed now); DRAFT down on SC-03 (its halving grow rule alone leaves groups between half and full load, max/mean 1.5 to nearly 2 between powers of two, so it needs up to twice the groups for a load unless it adds MIN's one-move balancer); CELL and LANE down on SC-03 and SC-10 (16 cells give 7 to 15, and 64 lanes 23 to 53, writers' worth of one resource under skew, with no move to fix it); SPLIT and PD unchanged (key-level splits balance at most 5 % better to 64 groups and meet the same hot-partition ceiling, though they copy less per hotspot move); every candidate equally down on SC-10 until it is restated.
