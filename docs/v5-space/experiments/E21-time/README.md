# E-21: which time rule gives correct TTLs and safe leases?

**Question (Q-21).** Which time rule gives correct TTLs and safe leases under clock skew, clock jumps, GC pauses and leader changes?

**Threshold.** The option that passes every check with the fewest rules wins. Reasoned expectation, to confirm or refute: fencing makes lock safety independent of clocks, and TTLs need a wall-time order (`clamp` or `hlc`).

**In short** (simulated here, 30 seeds in each of seven families, 3 or 5 nodes; [results/design.jsonl](results/design.jsonl), [results/summary.md](results/summary.md)):
- **Fencing makes lock safety independent of the clock rule.** With the fence, no protected write committed under a token below one the writer had seen, under every option, even `wall`, whose clock fails every TTL check; 28 to 127 writes per option were sent by clients that had lost the lock (pauses between check and send of up to 15 s, Kleppmann's case), and the fence refused them all. Dropping the fence (`pwrite.fence`) breaks `stale` in the calmest family (`drift`, seed 17) under every option, so no clock rule can stand in for it.
- **The draft's `clamp` misses P-02's bounds when the leader's own clock jumps.** Rows expired up to 600 ms early (a jump forward) and up to 600 ms late (a jump back), against `skew.max` (250 ms) and one tick + `skew.max` (350 ms): 314 early and 290 late rows in 210 runs. The window lets writer time sit `skew.max` off the median, which itself sits up to half of `skew.max` off real time.
- **`clamp` with a window of 0 (`median`) passes every check** in every family where at most one clock is wrong: writer time = max(last t, the median of the members' clocks, own clock included, each reading carried forward by the receiver's monotonic clock). Worst early 100 ms, worst late 300 ms.
- **`hlc` with CockroachDB's guards passes every check too**, and, besides `tt` (whose premise covers jumps), the only option that stays safe when two of three clocks jump (it stops electing instead); it pays in leaderless time (221 s against 77 s over the 210 runs; 1,323 s in the two-bad-clocks family). Its ablation keeps 6 of its 14 rules, and none of them is the hybrid clock: what keeps it safe is CockroachDB's guard (a leader whose clock is more than max-offset from most of its peers steps down), on top of the leader's own clock.
- **`mono` (etcd's lessor) fails P-02's late bound:** a new leader restarts every TTL, so rows lived up to 30 s too long after a failover (583 rows); with a checkpoint every second (`mono+ck`), up to 1.1 s (341 rows). etcd's default checkpoint is 5 minutes.
- **`tt` passes every check, under its premise**: clock infrastructure that bounds the error (TrueTime, ClockBound). A laptop, a plain VM or `node app.ts` does not have it.
- **Rules (DEV-10):** `tt` 4 (with its premise), `hlc` 6, `median` 7. `wall`, `clamp`, `mono` and `mono+ck` fail as designed. The rule "writer time never goes back" was never shown needed, because an election here takes 2 s, longer than `skew.max`; with a fast planned handover (E-13) it would be (reasoned), one more rule in every option.

## Words used here

- **Writer time**: the time the group's leader stamps on each entry. TTLs, leases and `ctx.now()` are judged by it (DESIGN-V5 4.3). It must never go back along the log.
- **Skew**: how far apart two clocks are. `skew.max` is the most the design allows (250 ms here, API.md's proposed default). **Drift**: how fast a clock gains or loses (here up to 200 parts per million). A **jump**: a clock that steps by 1 s to 1 h at once (an NTP step, a VM resumed after a pause).
- **Monotonic clock**: a clock that only counts elapsed time on one machine and never jumps; it cannot be compared across machines.
- **Lease**: a lock held for a time; the holder renews it. **Fencing token**: a number that rises with each new holder; a protected write carries it and the writer refuses a token below the highest it has seen (Kleppmann 2016).
- The options are SPACE.md axis T: `clamp` (the draft), `hlc` (hybrid logical clocks), `mono` (etcd's lessor: durations on the leader's monotonic clock), `tt` (TrueTime-like bounded clocks); `wall` (the leader's raw clock, never back) is the baseline.

## Method

A seeded simulation in plain Python, [sim/timesim.py](sim/timesim.py). Real time moves in 100 ms steps (the writer's tick); clock jumps of 1 s to 1 h, pauses of 1 to 5 s and drift of 200 ppm cannot be explored exhaustively, so each option runs on seeded random schedules. Each option's time rules are written in E-17's rule language (`harness/dsl.py`, read unchanged): a rule is one guard conjunct or one update, and mutants are made by script. [sim/ablate.py](sim/ablate.py) runs DEV-10's procedure on the seeds: a rule is needed if dropping it makes some seed break a check.

**The world** (shared, not counted):
- 3 or 5 nodes (even seeds 3, odd seeds 5). Node i's wall clock is real time plus an offset (spread over `skew.max`), plus drift, plus any jumps; its monotonic clock is real time times (1 + drift). Every node pings every 500 ms with its wall clock (and its HLC value).
- One Raft group, abstract: a leader appends entries that commit at once. A leader that crashes or pauses is replaced `election.ms` (2 s) after it stopped, by an up, unpaused node allowed to stand; a paused leader that wakes before that carries on.
- Workload: a TTL row every second (ttl 5 s or 30 s), expired on the leader's tick; one lock (lease 10 s) wanted by two clients, each with its own drifting monotonic clock and GC pauses (1 to 5 s, sometimes 5 to 15 s). A holder renews every lease/3 and believes it holds until its own clock passes its last acknowledgement plus the lease minus a margin (a round trip plus `skew.max`, DESIGN-V5 5.3). While it believes it holds, it sends a protected write every 500 ms, and sometimes pauses between the check and the send (Kleppmann's example).
- Seven scenario families, each seed drawing its own times and sizes: `drift` (skew and drift only), `jumpL+` and `jumpL-` (the leader's clock jumps forward or back by 1 s to 1 h), `jumpF` (a follower's clock jumps either way), `pause` (1 to 3 pauses of 1 to 5 s on any node, the leader included), `crash` (1 or 2 nodes down for 30 s), `mix` (1 to 4 of these). An eighth family, `jump2`, has two of three clocks jump (a majority of clocks wrong). It is beyond the premise of every option but `tt`, so it is reported in the design runs and left out of the ablation.

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

`overlap` (reported, not a check) counts protected writes sent by a client that no longer held the latest token: the writes fencing has to stop.

**Options** (each line is a rule in the model):

| Option | Rules written | Source |
|---|---|---|
| `wall` | writer time = the leader's clock, never below the last t in the log; a row ends when writer time passes its ttl; a lease lapses when writer time passes its end | the baseline |
| `clamp` | peers' clocks ride the pings; a reading is carried forward by the receiver's monotonic time since it arrived; clamp to the median (own clock included) + `skew.max`; clamp to the median − `skew.max`; never back; a member off by more than `skew.max` waits longer to stand (and still stands when it alone can win); expiry and lapse by writer time | DESIGN-V5 4.2, "The writer's time" |
| `hlc` | l = max(l, clock) when stamping and when sending; l = max(l, received l); a reading more than max-offset (500 ms) ahead is refused; l = max(l, an applied entry's t); a leader whose clock is more than max-offset from its peers' median steps down, and such a node does not stand; expiry and lapse by the HLC | Kulkarni et al. 2014; CockroachDB's `--max-offset` |
| `median` | `clamp` with a window of 0: writer time = max(last t, the median of the members' clocks, own clock included, each reading carried forward by the receiver's monotonic time). Added here after `clamp` failed | this experiment |
| `mono` | deadlines on the leader's monotonic clock; a new leader restarts every TTL and lease at its full length (etcd's `Promote`) | etcd `lease/lessor.go` |
| `mono+ck` | `mono` plus a checkpoint of every remaining duration each second (etcd's default is 5 minutes), resumed by a new leader | etcd 3.4 lease checkpoints |
| `tt` | writer time = `latest`; a row ends, and a lease lapses, when `earliest` passes it; the premise: every node reads an interval [earliest, latest] that holds real time (error 125 ms), jumps included | Spanner TrueTime; AWS ClockBound |

Common to every option, and counted in each: expiry is a record in the log (`expire.log`), and a protected write is refused below the highest token seen (`pwrite.fence`).

## Results

Machine: 4 vCPU, 15 GB, shared with other agents (every run under the heavy lock, 2 worker processes); Python 3.13, standard library. Not timing. All results are simulated here, on seeded schedules: a seed that passes shows nothing broke on that schedule, not that nothing can. Raw output: [results/design.jsonl](results/design.jsonl) (the design runs, 30 seeds in each of the 8 families), `results/<option>-ablation.json` and `.log` (each option's ablation and mutants), [results/summary.md](results/summary.md) (generated from the ablations, 7 families).

### 1. Which checks each option breaks, by family (30 seeds each)

Counts of broken rows or grants over the 30 seeds; `ok` is no break. `early_wt`, `back`, `agree` and `stale` were never broken by any option as designed, and are left out.

| option | drift | jumpL+ | jumpL- | jumpF | pause | crash | mix | jump2 (beyond the premise) |
|---|---|---|---|---|---|---|---|---|
| `wall` | ok | early 499, lease 20 | late 1,793, stuck 9 | ok | ok | ok | early 117, late 398, lease 6, stuck 2 | early 120, late 857, lease 5, stuck 2 |
| `clamp` | ok | early 279 | late 238 | ok | ok | ok | early 35, late 52 | early 131, late 439, lease 2 |
| `median` | ok | ok | ok | ok | ok | ok | ok | early 104, late 370, lease 2 |
| `hlc` | ok | ok | ok | ok | ok | ok | ok | ok |
| `mono` | ok | ok | ok | ok | late 280, stuck 1 | late 163, stuck 1 | late 140, stuck 1 | ok |
| `mono+ck` | ok | ok | ok | ok | late 141 | late 67 | late 133 | ok |
| `tt` | ok | ok | ok | ok | ok | ok | ok | ok |

| option | worst early, 7 families (ms; bound 250) | worst late (ms; bound 350 + leaderless time) | time with no working leader, 7 families (s) | in `jump2` (s) |
|---|---|---|---|---|
| `wall` | 29,900 | 158,000 | 77.4 | 0 |
| `clamp` | 600 | 600 | 77.4 | 0 |
| `median` | 100 | 300 | 77.4 | 0 |
| `hlc` | 200 | 300 | 221.4 | 1,323 |
| `mono` | 0 | 30,000 | 77.4 | 0 |
| `mono+ck` | 0 | 1,100 | 77.4 | 0 |
| `tt` | 0 | 300 | 77.4 | 0 |

What the table says:
- `clamp` fails only when the **leader's own** clock jumps (`jumpL+`, `jumpL-`, `mix`). The clamp keeps writer time within `skew.max` of the median, but the median itself already sits up to half of `skew.max` from real time, so a leader that jumped can stamp up to about 1.5 x `skew.max` off. A window of 0 (`median`) closes it.
- `hlc` pays for its safety in leader time: every leader jump costs an election (60 s over 30 seeds in each of `jumpL+` and `jumpL-`), and when two of three clocks are wrong (`jump2`), no node may stand and the group has no leader for 1,323 s over 30 seeds. `median` keeps a leader there, and expires rows early and late instead.
- `mono` is never early, but a new leader restarts every TTL at its full length, so a row can live a whole TTL too long (30 s here); a checkpoint every second (`mono+ck`) cuts that to 1.1 s, still past the bound. Raising the check rate further only narrows the gap: a leader that pauses holds deadlines it cannot hand on.
- The fence works under every option. `overlap` (protected writes sent by a client that had already lost the lock, mostly a GC pause between its check and its send) was 28 to 127 per option, and every one was refused.

### 2. Rules each option needs (DEV-10)

| option | holds as designed | rules needed | of written | by role | mutants caught / that change behaviour |
|---|---|---|---|---|---|
| `wall` | no (`jumpL+`: early, lease) | 5 | 5 | fence 1, log 1, time 3 | - |
| `clamp` | no (`jumpL+`: early) | 10 | 10 | elect 1, fence 1, log 1, time 7 | - |
| `median` | yes | **7** | 10 | fence 1, log 1, time 5 | 11 / 11 |
| `hlc` | yes | **6** | 14 | elect 2, fence 1, log 1, time 2 | 6 / 6 |
| `mono` | no (`pause`: late) | 6 | 6 | fence 1, log 1, time 4 | - |
| `mono+ck` | no (`pause`: late) | 8 | 8 | fence 1, log 1, time 6 | - |
| `tt` | yes, under its premise | **4** | 5 | fence 1, log 1, time 2 | 4 / 4 |

For an option that fails as designed, "rules needed" counts the rules whose drop alone breaks a check on some seed (pass 1); greedy drops and mutants are run only on options that hold. Per-rule detail: [results/summary.md](results/summary.md).

- **`median`'s 7:** carry each peer reading forward by the receiver's monotonic time (`stamp.extrap`; without it a reading ages and writer time falls behind), the upper clamp and the lower clamp to the median, expiry and lapse by writer time (`expire.due`, `grant.lapsed`), expiry as a log record (`expire.log`), and the fence. Dropped: `stamp.peers` (with the extrapolation in place, the median of the carried readings is enough), `stamp.never_back` and `stand.near` (see below).
- **`hlc`'s 6:** the step-down guard and its update (`selffence.far`, `selffence.stepdown`), expiry and lapse by the leader's clock, `expire.log`, the fence. Every hybrid-clock rule (`hlc_max`, `set_l`, `send_max`, `recv.adopt`, `recv.near`, `apply`) and `stand.near` were dropped. So what the ablation keeps is "the leader's wall clock, and a leader whose clock is more than max-offset from most of its peers steps down", which is CockroachDB's guard without the HLC. The HLC itself serves causality across groups (a read that follows a write in another group), which this single-group model does not ask about.
- **`tt`'s 4:** expiry and lapse by the bounded clock, `expire.log`, the fence. Fewest rules, but its premise (a clock error bound that covers jumps) is clock infrastructure: TrueTime, or AWS ClockBound on EC2. A laptop, a plain VM or `node app.ts` cannot give it, so `tt` cannot be the default (DEP-01's one-command start).
- **Never shown needed, in every option:** `never_back`, because an election here takes 2 s, longer than `skew.max` (250 ms), so a new leader's clock is always past the last stamp. A planned handover (E-13) takes milliseconds; a new leader 250 ms behind would then stamp backwards. Reasoned: keep `never_back`, one more rule in each option; the order does not change.
- **The mutants** of each smallest model that change behaviour were all caught. The ones that change nothing: the three comparison flips (`>=` to `>` on `expire.due`, `grant.lapsed`, `pwrite.fence`; time moves in 100 ms steps, so an off-by-one tick is never seen at these sizes) and some swaps of the stamp updates.

## What the model leaves out

- **One group.** No causality across groups, which is what an HLC is for beyond these checks (a write in group B stamped after a write in group A it has seen). If fero needs cross-group time order (P-14 snapshots, X `ramp`), `hlc`'s stamping rules come back; this experiment cannot price them.
- **Abstract Raft.** Entries commit at once; an election takes a fixed 2 s; no partitions (a partitioned leader is modelled as paused). A real leader lease (E-14, E-38) is not modelled.
- **Seeds, not proof.** 30 seeds per family. A rule judged "not needed" was not needed on these schedules; a fast handover is one schedule the sim does not have (see `never_back`).
- **Client clocks.** Each lock client has a drifting monotonic clock and a margin of one round trip plus `skew.max`. A client with no margin (or a broken monotonic clock) is not modelled; the fence covers it, by the results above.
- **`tso`** (SPACE.md's central timestamp oracle, PD's choice) is not modelled: it needs a central role on the write path, which DEV-02 and E-16 judge separately.
- **One agent.** The ablation drops rules in model-text order only; a second order or a second agent's count (DEV-10 (e)) was not run.

## Verdict

The reasoned expectation is confirmed in its first half and corrected in its second. Fencing makes lock safety independent of the clock rule: under every option, even the raw clock, no protected write committed under an old token. TTLs do need a wall-time order, but the draft's `clamp` with a window of `skew.max` is not enough: a leader whose own clock jumps expires rows up to 600 ms early or late, past P-02's bounds. Two fixes pass every check without clock infrastructure: a window of 0 (`median`, 7 rules), or the leader's clock with CockroachDB's step-down guard (`hlc` as ablated, 6 rules). `median` keeps the group writing when a majority of clocks is wrong and misses P-02 there; the step-down guard keeps P-02 and stops writing instead (1,323 s with no leader over 30 runs). P-02 says "never before its ttl", and F-06 says a skewed clock cannot end a TTL early, so the guard wins on the requirements as written, and it has fewer rules. `tt` has the fewest rules (4) but needs clock hardware; it can be an option where that exists. `mono` (etcd) fails P-02's late bound by a whole TTL after a failover.

Q-21: the leader's own clock, never going back, with a step-down when it is more than max-offset from most of its peers (CockroachDB's guard; 6 rules + `never_back`), plus the fence for locks; the draft's `clamp` window of `skew.max` misses P-02 by up to 600 ms when the leader's clock jumps, and `mono` by a whole TTL. Moves: every `clamp` row (DRAFT, MIN and its family, CELL, LANE, SPLIT, ISR, SLOG, OBJ) keeps T but swaps the clamp window for the step-down guard (or a window of 0), down on P-02 and F-06 until it does; `hlc`-guard up on P-02, P-10, F-06, TEST-02; `mono` down on P-02; `tt` up on P-02 only where clocks are bounded (not a default, DEP-01).

