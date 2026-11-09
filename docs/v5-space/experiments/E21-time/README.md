# E-21: which time rule gives correct TTLs and safe leases?

**Question (Q-21).** Which time rule gives correct TTLs and safe leases under clock skew, clock jumps, GC pauses and leader changes?

**Threshold.** The option that passes every check with the fewest rules wins. Reasoned expectation, to confirm or refute: fencing makes lock safety independent of clocks, and TTLs need a wall-time order (`clamp` or `hlc`).

__RESULTS_SHORT__

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
- Seven scenario families, each seed drawing its own times and sizes: `drift` (skew and drift only), `jumpL+` and `jumpL-` (the leader's clock jumps forward or back by 1 s to 1 h), `jumpF` (a follower's clock jumps either way), `pause` (1 to 3 pauses of 1 to 5 s on any node, the leader included), `crash` (1 or 2 nodes down for 30 s), `mix` (1 to 4 of these).

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
| `mono` | deadlines on the leader's monotonic clock; a new leader restarts every TTL and lease at its full length (etcd's `Promote`) | etcd `lease/lessor.go` |
| `mono+ck` | `mono` plus a checkpoint of every remaining duration each second (etcd's default is 5 minutes), resumed by a new leader | etcd 3.4 lease checkpoints |
| `tt` | writer time = `latest`; a row ends, and a lease lapses, when `earliest` passes it; the premise: every node reads an interval [earliest, latest] that holds real time (error 125 ms), jumps included | Spanner TrueTime; AWS ClockBound |

Common to every option, and counted in each: expiry is a record in the log (`expire.log`), and a protected write is refused below the highest token seen (`pwrite.fence`).

__RESULTS_LONG__
