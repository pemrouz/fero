# E-21: which time rule gives correct TTLs and safe leases?

**Question (Q-21).** Which time rule gives correct TTLs and safe leases under clock skew, clock jumps, GC pauses and leader changes?

**Threshold.** The option that passes every check with the fewest rules wins. Reasoned expectation, to confirm or refute: fencing makes lock safety independent of clocks, and TTLs need a wall-time order (`clamp` or `hlc`).

**In short** (simulated here, 30 seeds in each of nine scenario families, 3 or 5 nodes; [results/design.jsonl](results/design.jsonl), [results/summary.md](results/summary.md), [results/handover.md](results/handover.md), [results/summary9.md](results/summary9.md)):
- **Fencing makes lock safety independent of the clock rule.** With the fence, no protected write committed under a token below one the writer had seen, under every option, even `wall`, whose clock fails every TTL check; 28 to 127 writes per option were sent by clients that had lost the lock (pauses between check and send of up to 15 s, Kleppmann's case), and the fence refused them all. Dropping the fence (`pwrite.fence`) breaks `stale` in the calmest family (`drift`, seed 17) under every option, so no clock rule can stand in for it.
- **The draft's `clamp` misses P-02's bounds when the leader's own clock jumps.** Rows expired up to 600 ms early (a jump forward) and up to 600 ms late (a jump back), against `skew.max` (250 ms) and one tick + `skew.max` (350 ms): 314 early and 290 late rows in 210 runs. The window lets writer time sit `skew.max` off the median, which itself sits up to half of `skew.max` off real time.
- **`clamp` with a window of 0 (`median`) passes every check** in every family where at most one clock is wrong: writer time = max(last t, the median of the members' clocks, own clock included, each reading carried forward by the receiver's monotonic clock). Worst early 100 ms, worst late 300 ms. A leader's clock jump costs no failover. Written as one assignment it needs **7 rules**.
- **`hlc` with CockroachDB's guards passes every check too, also with 7 rules**, and none of the 7 is the hybrid clock: what is left is the leader's own clock, never going back, and CockroachDB's guard (a leader whose clock is more than max-offset from most of its peers steps down). It stays safe when two of three clocks jump (it stops electing). But **every jump of the leader's clock costs a failover**: one 2 s election in each of the 60 runs where only the leader's clock jumped (and 24 s more without a leader in `mix`), which F-06 ("a clock jump never causes a failover") forbids as written.
- **Both can be had together (`median+g`, added here):** the median, plus a guard that steps down only when fewer than a majority of the known clocks lie within max-offset of their median. It passes every check in all nine families: no failover when one clock jumps, and it stops instead of expiring rows by a wrong time when most clocks are wrong. **9 rules.**
- **"Writer time never goes back" is needed once leaders hand over fast.** The first seven families change leaders only through a 2 s election, longer than `skew.max`, so they never showed the rule needed. With planned handovers (the new leader stamping in the same tick) the smallest models stamp backwards: the guard's by up to 249 ms (66 times in 30 runs), the median's by up to 0.1 ms (48 times). One rule fixes both; it is in the counts above.
- **`mono` (etcd's lessor) fails P-02's late bound:** a new leader restarts every TTL, so rows lived up to 30 s too long after a failover (583 rows), and up to 93 s with several handovers; with a checkpoint every second (`mono+ck`), up to 1.1 s (341 rows). etcd's default checkpoint is 5 minutes.
- **`tt` passes every check with 4 rules, under its premise**: clock infrastructure that bounds the error (TrueTime, ClockBound). A laptop, a plain VM or `node app.ts` does not have it.

## Words used here

- **Writer time**: the time the group's leader stamps on each entry. TTLs, leases and `ctx.now()` are judged by it (DESIGN-V5 4.3). It must never go back along the log.
- **Skew**: how far apart two clocks are. `skew.max` is the most the design allows (250 ms here, API.md's proposed default). **Drift**: how fast a clock gains or loses (here up to 200 parts per million). A **jump**: a clock that steps by 1 s to 1 h at once (an NTP step, a VM resumed after a pause).
- **Monotonic clock**: a clock that only counts elapsed time on one machine and never jumps; it cannot be compared across machines.
- **Lease**: a lock held for a time; the holder renews it. **Fencing token**: a number that rises with each new holder; a protected write carries it and the writer refuses a token below the highest it has seen (Kleppmann 2016).
- **Handover**: a leader gives leadership to another member on purpose (Raft's leader transfer); a roll uses it. **Failover**: the group elects a new leader because the old one stopped.
- The options are SPACE.md axis T: `clamp` (the draft), `hlc` (hybrid logical clocks), `mono` (etcd's lessor: durations on the leader's monotonic clock), `tt` (TrueTime-like bounded clocks); `wall` (the leader's raw clock, never back) is the baseline. `median`, `median1` and `median+g` were added here.

## Method

A seeded simulation in plain Python, [sim/timesim.py](sim/timesim.py). Real time moves in 100 ms steps (the writer's tick); clock jumps of 1 s to 1 h, pauses of 1 to 5 s and drift of 200 ppm cannot be explored exhaustively, so each option runs on seeded random schedules. Each option's time rules are written in E-17's rule language (`harness/dsl.py`, read unchanged): a rule is one guard conjunct or one update, and mutants are made by script. [sim/ablate.py](sim/ablate.py) runs DEV-10's procedure on the seeds: a rule is needed if dropping it makes some seed break a check.

**The world** (shared, not counted):
- 3 or 5 nodes (even seeds 3, odd seeds 5). Node i's wall clock is real time plus an offset (spread over `skew.max`), plus drift, plus any jumps; its monotonic clock is real time times (1 + drift). Every node pings every 500 ms with its wall clock (and its HLC value).
- One Raft group, abstract: a leader appends entries that commit at once. A leader that crashes or pauses is replaced `election.ms` (2 s) after it stopped, by an up, unpaused node allowed to stand; a paused leader that wakes before that carries on.
- Workload: a TTL row every second (ttl 5 s or 30 s), expired on the leader's tick; one lock (lease 10 s) wanted by two clients, each with its own drifting monotonic clock and GC pauses (1 to 5 s, sometimes 5 to 15 s). A holder renews every lease/3 and believes it holds until its own clock passes its last acknowledgement plus the lease minus a margin (a round trip plus `skew.max`, DESIGN-V5 5.3). While it believes it holds, it sends a protected write every 500 ms, and sometimes pauses between the check and the send (Kleppmann's example).

**Nine scenario families**, each seed drawing its own times and sizes:
- **The seven** every ablation runs on: `drift` (skew and drift only), `jumpL+` and `jumpL-` (the leader's clock jumps forward or back by 1 s to 1 h), `jumpF` (a follower's clock jumps either way), `pause` (1 to 3 pauses of 1 to 5 s on any node, the leader included), `crash` (1 or 2 nodes down for 30 s), `mix` (1 to 4 of these, at most one node's clock jumping).
- **`handover`, the verify family** ([sim/verify.py](sim/verify.py); E-17's "verify bound"): `drift` plus 2 to 6 planned handovers a run. The leader stamps its last entry, another member takes over and stamps its first entry in the same tick, so two leaders' clocks meet with no election between them (E-13 measured about 10 ms for etcd's `move-leader`, far below one tick). Each option's smallest model from the seven families is run on it; if it breaks a check, the latest dropped rule whose return fixes it is put back, and every mutant of the new smallest model is run on all eight families.
- **`jump2`, beyond the premise:** two clocks jump, each at its own time and by its own amount, so in a 3-node group a majority of clocks is wrong. Every option but `tt` assumes most clocks are sound, so `jump2` is reported in the design runs and left out of the first ablations. A second ablation (`sim/ablate.py --nine`, [results/summary9.md](results/summary9.md)) makes it a check family too, for the options that hold on all nine.

**Checks** (each seed):

| Check | Broken when | Requirement |
|---|---|---|
| `early_wt` | a row expired before its ttl by writer time | P-02 ("never before its ttl by the writer's clock") |
| `early` | a row expired more than `skew.max` early in real time | P-02, F-06 (a skewed clock cannot end a TTL early) |
| `late` | a row expired later than ttl + one tick + `skew.max` + the time the group had no working leader during its life, or never | P-02 ("within one tick plus skew.max") |
| `lease` | the writer granted the lock while the previous holder still believed, by its own clock, that it held it | P-10, F-06 (two holders because of a clock, with no pause) |
| `stuck` | the lock was not granted again within lease + tick + `skew.max` + leaderless time after its holder stopped renewing | P-10 (a lapsed lease ends) |
| `back` | writer time went back between two entries | versions and leases need an order |
| `agree` | replicas removed a row at different log positions | P-02 ("every copy agrees") |
| `stale` | a protected write committed with a token below one the writer had seen | P-10, TEST-13's fencing checker |
| `avail` | the group stayed without a leader for `election.ms` + 2 s while a majority was up and every live clock was sound (the rule itself kept it from electing) | F-05 (a liveness check) |

Reported beside the checks: `overlap` (protected writes sent by a client that no longer held the latest token: the writes fencing has to stop), and the time with no working leader per family. Leaderless time above the baseline's in the jump families is failovers that a clock jump caused, which F-06's first clause forbids ("a clock jump never causes a failover or a flap").

**Options** (each line is a rule in the model):

| Option | Rules written | Source |
|---|---|---|
| `wall` | writer time = the leader's clock, never below the last t in the log; a row ends when writer time passes its ttl; a lease lapses when writer time passes its end | the baseline |
| `clamp` | peers' clocks ride the pings; a reading is carried forward by the receiver's monotonic time since it arrived; clamp to the median (own clock included) + `skew.max`; clamp to the median − `skew.max`; never back; a member off by more than `skew.max` waits longer to stand (and still stands when it alone can win); expiry and lapse by writer time | DESIGN-V5 4.2, "The writer's time" |
| `median` | `clamp` with a window of 0: writer time = max(last t, the median of the members' clocks, own clock included, each reading carried forward by the receiver's monotonic time). Added here after `clamp` failed | this experiment; the same rule for a log's time is CometBFT's BFT time (the median of the validators' vote times, never back) |
| `median1` | `median` written as one assignment (t = the median) instead of two clamps that meet at a window of 0. The same behaviour on every seed; it is here so the count does not hang on how the clamp is written | this experiment |
| `median+g` | `median1` plus an agreement guard: a leader steps down, and a member does not stand, when fewer than a majority of the clocks it knows (its own, and each peer reading carried forward) lie within max-offset (500 ms) of their median | this experiment; CockroachDB's majority test (`VerifyClockOffset`) measured from the median instead of from the node's own clock |
| `hlc` | l = max(l, clock) when stamping and when sending; l = max(l, received l); a reading more than max-offset (500 ms) ahead is refused; l = max(l, an applied entry's t); a leader whose clock is more than max-offset from most of its peers steps down, and such a node does not stand; expiry and lapse by the HLC | Kulkarni et al. 2014; CockroachDB's `--max-offset` and `pkg/rpc/clock_offset.go` |
| `mono` | deadlines on the leader's monotonic clock; a new leader restarts every TTL and lease at its full length (etcd's `Promote`) | etcd `lease/lessor.go` |
| `mono+ck` | `mono` plus a checkpoint of every remaining duration each second (etcd's default is 5 minutes), resumed by a new leader | etcd 3.4 lease checkpoints |
| `tt` | writer time = `latest`; a row ends, and a lease lapses, when `earliest` passes it; the premise: every node reads an interval [earliest, latest] that holds real time (error 125 ms), jumps included | Spanner TrueTime; AWS ClockBound |

Common to every option, and counted in each: expiry is a record in the log (`expire.log`), and a protected write is refused below the highest token seen (`pwrite.fence`).

## Results

Machine: 4 vCPU, 15 GB, shared with other agents (every run under the heavy lock, 2 worker processes); Python 3.13, standard library. Not timing. All results are simulated here, on seeded schedules: a seed that passes shows nothing broke on that schedule, not that nothing can. Raw output:
- [results/design.jsonl](results/design.jsonl): the design runs, 30 seeds in each of eight families (the seven and `jump2`);
- `results/<option>-ablation.json` and `.log`, with [results/summary.md](results/summary.md): each option's ablation and mutants on the seven families;
- [results/handover.md](results/handover.md) with `handover.json` and `.log`: the verify family, and every mutant of the final models on eight families;
- `results/<option>-ablation9.json` and `.log`, with [results/summary9.md](results/summary9.md): the ablation on all nine families for `median+g`, `hlc` and `tt`.

The first runs (2026-11-09) covered the seven families and `jump2`. The `handover` family, `median1`, `median+g` and the nine-family ablations were added on 2026-11-10; after each change to the sim the design runs of the older options were run again and were identical to `design.jsonl`.

### 1. Which checks each option breaks, by family (30 seeds each)

Counts of broken rows or grants over the 30 seeds; `ok` is no break. `early_wt`, `back`, `agree`, `stale` and `avail` were never broken by any option as designed, and are left out.

| option | drift | jumpL+ | jumpL- | jumpF | pause | crash | mix | handover | jump2 (beyond the premise) |
|---|---|---|---|---|---|---|---|---|---|
| `wall` | ok | early 499, lease 20 | late 1,793, stuck 9 | ok | ok | ok | early 117, late 398, lease 6, stuck 2 | ok | early 120, late 857, lease 5, stuck 2 |
| `clamp` | ok | early 279 | late 238 | ok | ok | ok | early 35, late 52 | ok | early 131, late 439, lease 2 |
| `median`, `median1` | ok | ok | ok | ok | ok | ok | ok | ok | early 104, late 370, lease 2 |
| `median+g` | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `hlc` | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `mono` | ok | ok | ok | ok | late 280, stuck 1 | late 163, stuck 1 | late 140, stuck 1 | late 1,468, stuck 3 | ok |
| `mono+ck` | ok | ok | ok | ok | late 141 | late 67 | late 133 | late 1,324, lease 2 | ok |
| `tt` | ok | ok | ok | ok | ok | ok | ok | ok | ok |

| option | worst early, 7 families (ms; bound 250) | worst late (ms; bound 350 + leaderless time) | time with no working leader, 7 families (s) | of it, caused by a clock jump (s) | in `jump2` (s, of 5,400) |
|---|---|---|---|---|---|
| `wall` | 29,900 | 158,000 | 77.4 | 0 | 0 |
| `clamp` | 600 | 600 | 77.4 | 0 | 0 |
| `median`, `median1` | 100 | 300 | 77.4 | 0 | 0 |
| `median+g` | 100 | 300 | 77.4 | 0 | 1,299 |
| `hlc` | 200 | 300 | 221.4 | 144 | 1,323 |
| `mono` | 0 | 30,000 | 77.4 | 0 | 0 |
| `mono+ck` | 0 | 1,100 | 77.4 | 0 | 0 |
| `tt` | 0 | 300 | 77.4 | 0 | 0 |

What the tables say:
- `clamp` fails only when the **leader's own** clock jumps (`jumpL+`, `jumpL-`, `mix`). The clamp keeps writer time within `skew.max` of the median, but the median itself already sits up to half of `skew.max` from real time, so a leader that jumped can stamp up to about 1.5 x `skew.max` off. A window of 0 (`median`) closes it.
- **`hlc` turns every leader clock jump into a failover.** The 77.4 s every option shows is the pauses and crashes themselves. `hlc` adds 60 s in `jumpL+` and 60 s in `jumpL-` (30 runs each, so one 2 s election in every run: each time the leader's clock jumped, the leader was removed), and 24 s in `mix`. The guard works by removing the leader, so this is by design, and it is what F-06's first clause rules out. Under `median` and `median+g` the same jumps cost nothing: the median ignores one wrong clock.
- **When most clocks are wrong (`jump2`)**, `median` keeps a leader and expires rows by a wrong time (104 early, worst 28.5 s; 370 late, worst 118 s; 2 early lock grants). `hlc` and `median+g` stop electing instead (about a quarter of the run time with no leader) and break nothing.
- `mono` is never early, but a new leader restarts every TTL at its full length, so a row can live a whole TTL too long (30 s here); a checkpoint every second (`mono+ck`) cuts that to 1.1 s, still past the bound. Raising the check rate further only narrows the gap: a leader that pauses holds deadlines it cannot hand on.
- The fence works under every option. `overlap` (protected writes sent by a client that had already lost the lock, mostly a GC pause between its check and its send) was 28 to 127 per option, and every one was refused.

### 2. Rules each option needs (DEV-10)

| option | holds as designed on the seven | rules needed: seven families | + `handover` (eight) | + `jump2` (all nine) | of written | mutants caught / that change a number |
|---|---|---|---|---|---|---|
| `wall` | no (`jumpL+`: early, lease) | 5 | - | - | 5 | - |
| `clamp` | no (`jumpL+`: early) | 10 | - | - | 10 | - |
| `median` | yes | 7 | 8 | fails `jump2` | 10 | 15 / 15 (eight families) |
| `median1` | yes | 6 | **7** | fails `jump2` | 9 | 12 / 12 (eight) |
| `median+g` | yes | not run (6, reasoned) | not run (7, reasoned) | **9** | 11 | 14 / 14 (nine) |
| `hlc` | yes | 6 | **7** | **7** | 14 | 8 / 8 (eight, and nine) |
| `mono` | no (`pause`: late) | 6 | - | - | 6 | - |
| `mono+ck` | no (`pause`: late) | 8 | - | - | 8 | - |
| `tt` | yes, under its premise | 4 | **4** | **4** | 5 | 4 / 4 (eight, and nine) |

For an option that fails as designed, "rules needed" counts the rules whose drop alone breaks a check on some seed (pass 1); greedy drops and mutants are run only on options that hold. Per-rule detail: [results/summary.md](results/summary.md) (seven families), [results/handover.md](results/handover.md) (eight), [results/summary9.md](results/summary9.md) (nine).

- **`median1`'s 7:** carry each peer reading forward by the receiver's monotonic time (`stamp.extrap`; without it a reading ages and writer time falls behind), writer time = the median (`stamp.median`), never back (`stamp.never_back`, shown needed by `handover`), expiry and lapse by writer time (`expire.due`, `grant.lapsed`), expiry as a log record (`expire.log`), and the fence. Dropped: `stamp.peers` (with the extrapolation in place, the carried readings are enough) and `stand.near`. `median` is the same model with the median written as two clamps, so it counts one more (8).
- **`hlc`'s 7:** the step-down guard and its update (`selffence.far`, `selffence.stepdown`), never back, expiry and lapse by the leader's clock, `expire.log`, the fence. Every hybrid-clock rule (`hlc_max`, `set_l`, `send_max`, `recv.adopt`, `recv.near`, `apply`) and `stand.near` were dropped, on seven, eight and nine families alike. So what the ablation keeps is "the leader's wall clock, never back, and a leader whose clock is more than max-offset from most of its peers steps down", which is CockroachDB's guard without the HLC. The HLC itself serves causality across groups (a read that follows a write in another group), which this single-group model does not ask about.
- **`median+g`'s 9:** `median1`'s 7 plus the guard and its update (`selffence.scattered`, `selffence.stepdown`). The update is needed only by `jump2` (without it rows expire late there), so on the eight families where at most one clock is wrong the two guard rules add nothing (reasoned from the nine-family run: 6 on the seven and 7 on the eight, as `median1`). `stand.agree` (a member that sees the clocks scattered does not stand) was dropped: here such a member steps down again before it stamps anything. A build keeps it, or the group would hold an election every 2 s while the clocks are wrong.
- **`tt`'s 4:** expiry and lapse by the bounded clock, `expire.log`, the fence. Fewest rules, but its premise (a clock error bound that covers jumps) is clock infrastructure: TrueTime, or AWS ClockBound on EC2. A laptop, a plain VM or `node app.ts` cannot give it, so `tt` cannot be the default (DEP-01's one-command start).
- **The mutants** of each final model that change a number on some seed were all caught. Six of them were caught because the mutant cannot run: a swap moved a clamp or `never_back` ahead of the clock reading it needs, an evaluation error, as E-16's engine and TLC report one (three of `median`'s 15, one each of `median1`'s, `hlc`'s and `median+g`'s). The ones that change nothing: the three comparison flips in every option (`>=` to `>` on `expire.due`, `grant.lapsed`, `pwrite.fence`; time moves in 100 ms steps, so an off-by-one tick is never seen at these sizes) and, in the median options, one to three swaps of stamp updates. A flip that changes nothing here is a boundary this sim cannot see, not a proof the boundary is free.

### 3. The verify family: a planned handover

The seven families never showed "writer time never goes back" needed in `median`, `hlc` or `tt`: a new leader arrives 2 s after the old one stopped, and its clock, at most `skew.max` (250 ms) behind, is already past the last stamp. A planned handover takes milliseconds, so the verify family adds it ([results/handover.md](results/handover.md), 30 seeds, 2 to 6 handovers each).

| option | as designed, on `handover` | smallest model of the seven families, on `handover` | rule put back | rules needed |
|---|---|---|---|---|
| `median` | holds (worst early 0 ms, late 100 ms) | `back` 48 times, worst step back 0.1 ms | `stamp.never_back` | 8 |
| `median1` | holds (the same) | `back` 48 times, worst step back 0.1 ms | `stamp.never_back` | **7** |
| `hlc` | holds (worst early 0 ms, late 300 ms) | `back` 66 times, worst step back 249 ms | `stamp.never_back` | **7** |
| `tt` | holds (worst early 0 ms, late 300 ms) | holds | none | **4** |
| `wall`, `clamp` | hold (worst early 200 ms, late 300 ms) | (fail as designed on the seven) | - | - |
| `mono` | `late` 1,468 rows (worst 93 s), `stuck` 3 | (fails as designed) | - | - |
| `mono+ck` | `late` 1,324 rows (worst 2.9 s), `lease` 2 | (fails as designed) | - | - |

- **`hlc`:** the new leader's own clock can be up to `skew.max` behind the old leader's, so without the rule its first stamp is up to 249 ms before the last one. Putting back any single hybrid-clock rule (`hlc_max`, `set_l`, `apply`, `recv.adopt`, `send_max`) does not fix it; `never_back` alone does.
- **`median`:** two members compute the median from readings carried forward by their own monotonic clocks, which drift apart by up to 0.1 ms between pings. That is enough to step back. One rule fixes it.
- **`tt`:** in this model every node reads the same interval, so `latest` never goes back. Real bounded clocks give each node its own interval, so two leaders' `latest` can differ by the error bound. Reasoned: `tt` needs `never_back` too (or Spanner's rule that leader leases do not overlap), 5 with it; the sim cannot show it.
- **`mono` and `mono+ck` get worse with handovers.** Each handover restarts every TTL (`mono`: rows up to 93 s late after several). `mono+ck` resumes from a checkpoint up to 1 s old, and a lock renewed after that checkpoint falls back to its shorter remaining time, so the new leader granted the lock twice while the holder still believed it held it (`lease` 2). etcd clears a lease's checkpoint through Raft when the lease is renewed (`lessor.Renew`, cited from its source, not run here); the rule as modelled does not, so this is a fault of the modelled rule, and one more rule in real etcd.
- With `never_back` back, each of the other rules still breaks a check when dropped (1-minimal on eight families), and the new smallest models hold on all eight.

### 4. One wrong clock, and most clocks wrong

Three rule sets pass every check without clock infrastructure. They differ in two places the nine checks do not weigh.

| | `median1` (7 rules) | `hlc` as ablated: own clock + CockroachDB's guard (7 rules) | `median+g` (9 rules) |
|---|---|---|---|
| the leader's clock jumps (one wrong clock) | nothing happens: 0 failovers | a failover every time: one 2 s election in each of the 60 `jumpL+` and `jumpL-` runs, 24 s more in `mix` | nothing happens: 0 failovers |
| F-06, "a clock jump never causes a failover" | kept | broken, by design | kept |
| most clocks wrong (`jump2`, 30 runs) | keeps writing by a wrong time: 104 rows early (worst 28.5 s), 370 late (worst 118 s), 2 early lock grants | stops: no check broken, no leader for 1,323 s of 5,400 | stops: no check broken, no leader for 1,299 s of 5,400 |
| holds on all nine families | no | yes | yes |
| precedent | CometBFT's BFT time (cited: `spec/consensus/bft-time.md`) | CockroachDB (cited: `pkg/rpc/clock_offset.go`, `VerifyClockOffset`) | both, with the guard measured from the median |

- The guard in `hlc` asks "is **my** clock far from most of the others?", so a leader whose own clock jumps must go. The guard in `median+g` asks "do most clocks still agree **with each other**?", so one wrong clock, the leader's included, changes nothing, and only a real loss of agreement stops the group.
- A planned handover instead of a plain step-down would cut the guard's cost from one election (2 s here) to about 10 ms (E-13). Reasoned, not simulated; F-06 as written still counts it as a failover caused by a clock jump.
- No rule here can see two clocks that jump together by the same amount (one bad time source feeding two members): they agree with each other, so they outvote the sound one. In `jump2` the two jumps differ in time and size. Only `tt`'s premise covers that case.

## What the model leaves out

- **One group.** No causality across groups, which is what an HLC is for beyond these checks (a write in group B stamped after a write in group A it has seen). If fero needs cross-group time order (P-14 snapshots, X `ramp`), `hlc`'s stamping rules come back; this experiment cannot price them.
- **Abstract Raft.** Entries commit at once; an election takes a fixed 2 s; no partitions (a partitioned leader is modelled as paused). A real leader lease (E-14, E-38) is not modelled, nor how a step-down guard meets Raft's own election rules.
- **Seeds, not proof.** 30 seeds per family. A rule judged "not needed" was not needed on these schedules. The fast handover was one schedule the seven families did not have; adding it changed two counts by one, so another missing schedule could do the same.
- **Readings of silent members are kept.** A node keeps each peer's last reading and carries it forward by its own monotonic clock, also while that peer is down. A design that drops a silent member's reading can be left with two clocks, and the median of two is their mean: one jump then moves writer time by half the jump. Reasoned: keep the reading (200 ppm of drift costs 0.7 s an hour), and treat fewer than three known clocks as "cannot outvote a jump". `median+g`'s guard does not catch that case with two clocks 500 ms or less apart.
- **Skew past `skew.max`.** Offsets are spread over `skew.max` and drift adds up to 72 ms more between two nodes by the end of a run. No check broke because of it on these seeds; a real deployment must count drift between clock syncs inside `skew.max`.
- **Client clocks.** Each lock client has a drifting monotonic clock and a margin of one round trip plus `skew.max`. A client with no margin (or a broken monotonic clock) is not modelled; the fence covers it, by the results above.
- **`tso`** (SPACE.md's central timestamp oracle, PD's choice) is not modelled: it needs a central role on the write path, which DEV-02 and E-16 judge separately.
- **One agent, one drop order.** The ablations drop rules in model-text order only; a second order or a second agent's count (DEV-10 (e)) was not run. `median+g` was ablated on nine families only.

## Verdict

The reasoned expectation is confirmed in its first half and corrected in its second. Fencing makes lock safety independent of the clock rule: under every option, even the raw clock, no protected write committed under an old token. TTLs do need a wall-time order, but the draft's `clamp` with a window of `skew.max` is not enough: a leader whose own clock jumps expires rows up to 600 ms early or late, past P-02's bounds. `mono` (etcd) fails P-02's late bound by a whole TTL after a failover. `tt` has the fewest rules (4) but needs clock hardware, so it is an option where that exists, not the default.

Without clock hardware, two rule sets pass every check with 7 rules each, "writer time never goes back" included: the median of the members' clocks (the draft's clamp with its window set to 0), and the leader's own clock with CockroachDB's step-down guard. The count does not separate them, so the requirements do. F-06 says a clock jump never causes a failover: the median keeps that (no failover in the 60 runs where the leader's clock jumped), the guard breaks it every time (60 elections in those 60 runs). So by the requirements as written the median wins. Its weak spot is outside its premise: when most clocks are wrong it keeps writing by a wrong time. Two more rules close that too (`median+g`: step down when the known clocks no longer agree with each other), and that rule set is the only one without clock hardware that passes every check in all nine families and keeps F-06.

An earlier form of this verdict chose the guard (6 rules against 7, counted before the handover family and before the median was written as one assignment). The tie at 7 and F-06's first clause changed it. If the user would rather take one failover per leader clock jump than carry the median, F-06 has to say so, and then the guard is the smaller design by precedent (CockroachDB runs the same test in production; there a node that fails it stops itself).

Q-21: writer time = the median of the members' clocks (the draft's clamp with a window of 0), never going back, plus the fence for locks: 7 rules, every check passes and a clock jump causes no failover (F-06); two more rules (step down when fewer than a majority of the known clocks agree) make the group stop instead of expiring rows by a wrong time when most clocks are wrong (9 rules, the only set without clock hardware that holds on all nine families and keeps F-06). The draft's window of `skew.max` misses P-02 by up to 600 ms when the leader's clock jumps; CockroachDB's guard on the leader's own clock also needs 7 rules but turns every leader clock jump into a failover (60 of 60 runs), against F-06 as written; `mono` misses by a whole TTL. Moves: every `clamp` row (DRAFT, MIN and its family, CELL, LANE, SPLIT, ISR, SLOG, OBJ) keeps T `clamp` with its window set to 0 (7 rules; 9 with the agreement guard, for groups that must not expire rows wrongly when most clocks are wrong), down on P-02 and F-06 until it does, up on P-02, P-10, F-06 and TEST-02 once it does; `hlc` up on P-02 and P-10, down on F-06 (a failover per leader clock jump) unless F-06 is amended; `mono` down on P-02; `tt` up on P-02 only where clocks are bounded (not a default, DEP-01).
