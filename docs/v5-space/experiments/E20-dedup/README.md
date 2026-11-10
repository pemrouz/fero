# E-20: which dedup option holds exactly once with the fewest rules?

**Question (Q-20).** Which dedup option holds exactly once with the fewest rules, across failover and slot moves? And does routing a write through any server (Y `fwd`) need a rule that sending it straight to the leader (Y `smart`) does not?

**Threshold.** The option with the fewest rules that holds F-02 and TEST-03 in every scenario wins. If `sess` holds them only with session state copied per slot, its memory at 1e6 clients is priced. If `sess` under `fwd` needs any hop rule that `smart` does not, that rule is counted for every `fwd` row; if not, Y is decided on latency alone.

**In short** (model-checked here, every reachable state at small bounds; [results/summary.md](results/summary.md), [results/design.txt](results/design.txt), [results/memory.txt](results/memory.txt)):
- **Every option holds exactly once (F-02) in every scenario as designed**, under `smart` and `fwd`: lost answers, failover mid-retry, a slot move mid-retry, a refusal then a stale copy, a client restart with old copies in flight, and expiry by the writer's time. `pid` did so only after two fixes found here (below).
- **Rules needed (DEV-10), sent straight to the writer (`smart`):** `keys` 12, `sess` 13, `pid` 16, `win` (the draft) 17.
- **`sess` needs no time rule at all.** The client's lowest unacknowledged id, sent with every copy, does the work of `win`'s window, per-copy budgets and stop-retry horizon: a late copy falls below it and is answered `stale`.
- **Memory decides between the two smallest.** `keys` keeps one entry per write for its TTL (221 B each: 13 GB at 1e5 writes a second for a 10-minute TTL); `sess` keeps one per active client (309 B: 295 MB at 1e6 clients), plus one floor per client carried with a moving slot (16 MB a move at 1e6 clients).
- **`fwd` costs hop rules in every option** (model-checked): `win` and `keys` 2 (`forward.age`: a relay subtracts the time it held a copy from the copy's budget; `forward.once`: a relay forwards a copy only once), `pid` 1 (`forward.age`), `sess` 1 (`forward.once`). Appending every refusal to the log removes `forward.once` (and two answer rules) for one log entry per refused first send.
- **`pid` as first written (Kafka's KIP-98 rules) could stall a partition for ever**: after a give-up, the next sequence leaves a gap the writer never fills. Kafka's fix (KIP-360, an epoch bump that restarts the sequence) cures it; so does dropping the "unknown producer starts at 0" check, because fero's per-copy budget already stops a late copy, which is what the smallest model found.

## Words used here

- **Dedup**: making sure a write that is sent more than once (a retry, a duplicate) takes effect at most once. An **attempt** is one write with an id that all its copies keep. A **copy** is one sending of it.
- **Writer**: the leader of the group that owns the slot. It judges each copy: apply it, refuse it, or answer from what it already holds.
- **Outcome**: what the writer recorded for an attempt (applied, or a refusal it wrote into the log). **Floor**: the id at or below which the writer has dropped outcomes; a copy there is a late duplicate of an attempt the client already has an answer for.
- **Horizon**: how long the writer keeps an issuer's (or a session's, a producer's, a key's) dedup state after it falls silent. After that it forgets.
- **Budget**: a time limit each copy carries; every hop subtracts how long it held the copy, and a copy whose budget is spent is not applied (DESIGN-V5 4.3, "No late arrivals").
- **DEV-10**: a rule is one guard conjunct or one state update; it counts only if removing it lets the checker find a counterexample.
- The options are SPACE.md axis D: `win` (the draft), `sess` (client sessions, Raft thesis 6.3), `pid` (Kafka's producer id, epoch and sequence, KIP-98), `keys` (idempotency keys). Routing is axis Y: `fwd` (any server takes the write and forwards it) and `smart` (the client sends it straight to the writer).

## Method

One exhaustive model in plain Python, [models/dedup.py](models/dedup.py), on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's shared rule language (`harness/dsl.py`) unchanged and E-17's ablation and mutant procedure (pass 1, greedy drops, a final pass that proves the set left 1-minimal, a verify bound, then mutants made by script). Like E-16 and E-33 it brings its own world: E-17's world lets any copy reach any group any number of times, which no design that leans on TCP survives by itself.

**The world** (shared by every option, not counted):
- Three abstract Raft groups as in E-17: data groups g0 and g1, and `#s` (a registry for sessions or producer ids). A crash deposes a leader; the new leader keeps a prefix of the uncommitted tail, and a lost tail may come back until the next commit.
- Two slots: s1 always in g0; s2 starts in g0 and may move to g1. The move protocol itself is E-15's and E-17's: g0 appends a fence (it stops writing s2 at once) and g1 appends `open` once the fence has committed. Which dedup state the fence carries is the option's rule.
- One client with a plan of attempts. Each attempt may be refused by a condition (the writer decides freely). Copies are messages delivered at most once (TCP does not duplicate), after any delay, or lost (a fault). Under `fwd` a copy goes to a relay, which forwards it; under `smart` it goes straight to a writer.
- Answers: an answer from the writer's committed state (the reply to the waiting request, or a later dedup hit) is `learn`; an answer not in the log (a first send's refusal, `stale-attempt`, `unknown` for an expired session) is a message that may be lost. The client accepts only the answer to its latest copy (DESIGN-V5 4.3).
- A global clock (writer time = the clock; E-21 owns clock faults). A client restart (a fault) kills the process; its copies stay in flight.

**Properties.** ONCE: no attempt has two committed writes (F-02). REFUSED: an attempt the client was told `refused` never has a committed write, before or after (F-02). TRUE: an attempt told `applied` has a committed write of its own (a wire id reused by a new life is caught here). L7: from every state where the client still has copies left, calm steps (delivery, commit, timers) end every attempt.

**The options**, each with `smart` and `fwd`:

| Option | What the model writes (each line a guard or an update) | Source |
|---|---|---|
| `win` | attempt id (issuer, call id), issuer = process + life; per issuer the highest id and the outcomes above the floor (W = 1); the issuer's window (span below W); a resend's refusal appended, a first send's not; forget after H silent; a copy's budget; stop retrying R after the first send; the fence carries outcomes and highest ids, merged by max | DESIGN-V5 4.3 |
| `sess` | a session registered in `#s` and renewed by the client; per session the outcomes at or above the client's lowest unacknowledged id L (sent with each copy); expiry in `#s` by `#s`'s writer time; an expired session is answered `unknown`, never judged afresh; the fence carries outcomes and floors | Raft thesis 6.3; LogCabin |
| `pid` | a producer id from `#s`; per (producer, partition) a gapless sequence; accept the next, absorb duplicates, refuse out of order; an unknown producer only at sequence 0; one attempt in flight per partition; every refusal appended (else the sequence would gap); forget after P; budgets and stop-retry as `win`; added here after the first runs failed: after an attempt ends `unknown`, bump the epoch and restart the sequence (KIP-360), and answer "unknown producer" only once the forget has committed | KIP-98, KIP-360, KIP-854 |
| `keys` | a unique key per write; the writer keeps each key's outcome for TTL; budgets and stop-retry as `win`; no window, no floor | Stripe, SQS dedup ids |

Time constants are the smallest that leave no slack (R = B = H = S = 1 tick), so a comparison flipped by one (`<` to `<=`) can show.

**Pinned** (written as rules, never dropped or mutated, not counted): the world's bookkeeping (the client's statuses, a copy taken off the wire, the append of the write itself), each design's memory bound (win's forgetting, sess's expiry and its floor L, pid's and keys' forgetting), and each design's answers at once (a first send's refusal not appended, `stale-attempt`, `unknown`). Without the pins, ablation would find a slower or unbounded design (for example "keep every outcome forever"); with them, it finds the safety rules each design as written needs.

**Bounds** ([models/dedup.py](models/dedup.py), `BOUNDS`): `lost` (two attempts on s1, three copies each, one crash, one lost message: lost answers, failover mid-retry, a refusal then a stale copy); `move` (an attempt on s2 and one on s1, the move mid-retry, one crash on either side); `restart` (a restart with the old life's copies in flight, the new life runs the plan again); `expire` (time passes: forgetting by writer time with late copies); `exprst` (expiry after a restart, the old life's copies landing late); and the verify bound `mvexp` (a move and expiry together).

## Results

Machine: 4 vCPU, 15 GB, shared with other agents (every run under the heavy lock); Python 3.13, standard library; Node 22.22.0 for the memory probe. Every model run is complete (every reachable state) unless a table says otherwise. Raw output: [results/summary.md](results/summary.md) (generated), `results/*-ablation.json` (each option's ablation and mutants, with traces), [results/design.txt](results/design.txt), [results/memory.txt](results/memory.txt). All model-checked here unless marked.

### 1. Rules each option needs (DEV-10)

| option | rules needed | of written | by role | mutants caught / that change behaviour | memory the writer keeps (Node 22, at 1e6) |
|---|---|---|---|---|---|
| `keys-smart` | **12** | 15 | answer 1, carry 2, dedup 4, hop 2, time 3 | 16 / 18 (two comparison flips survive) | 221 B per key, for its TTL: write rate x TTL keys |
| `keys-fwd` | **14** | 18 | as smart, + hop 2 (`forward.age`, `forward.once`) | 3 / 3 (the relay's) | as smart |
| `sess-smart` | **13** | 24 | answer 1, carry 4, dedup 8 | 14 / 16 (two comparison flips survive; the two swaps are equivalent) | 309 B per active client (1,237 B if kept per slot) |
| `sess-fwd` | **14** | 25 | as smart, + hop 1 (`forward.once`) | 1 / 1 (`forward.once` dropped on the full design) | as smart |
| `pid-smart` | **16** | 26 | carry 2, dedup 9, hop 2, time 3 | 22 / 23 (one flip survives) | 2,133 B per producer (4 partitions, Kafka's 5 cached batches) |
| `pid-fwd` | **17** | 29 | as smart, + hop 1 (`forward.age`) | 1 / 1 (the relay's) | as smart |
| `win-smart` | **17** | 23 | answer 1, carry 4, dedup 7, hop 2, time 3 | 22 / 25 (three comparison flips survive) | 349 B per active issuer |
| `win-fwd` | **19** | 26 | as smart, + hop 2 (`forward.age`, `forward.once`) | 3 / 3 (the relay's) | as smart |
| `win-fwd-all` | **16** | 21 | carry 4, dedup 6, hop 3, time 3 | 1 / 1 | as smart, + one log entry per refused first send |

Every option holds as designed on every bound (`results/design.txt`; the largest design space is `sess-fwd`'s `lost`, 462,506 states). No rule of any option is a Raft guard. The `fwd` rows of `win`, `pid` and `keys` start from the `smart` option's smallest model and add the relay (E-17's procedure); `sess` under `fwd` could not be run that way: `sess-smart`'s smallest model already needs 2,298,773 states on `lost`, and with the relay it would need well over the 2.5 million limit. So its one relay rule (`forward.once`; `sess` has no budgets, so it has no `forward.age`) was dropped alone on the full `sess-fwd` and `sess-fwd-all` designs ([results/sess-fwd-relay.txt](results/sess-fwd-relay.txt)), and its count is `sess-smart`'s 13 plus what that shows. That the relay keeps every `smart` rule needed is reasoned for `sess`, and model-checked for `win`, `pid` and `keys`.

`sess-smart`'s own ablation ran at a 2.5 million state limit, because its smallest model needs 2,298,773 states on `lost`. Ten of its mutants first stopped at the default 1.5 million limit on `lost`; [resolve20.py](resolve20.py) settled them by trying the small bounds first (`restart`, `move`, `expire`, `exprst`, `mvexp`) and `lost` at 2.5 million only where none of those caught the mutant. Each of the 13 kept rules breaks a property when dropped from the smallest model (6 of them on `restart` or `move` this way). The two swaps of updates (the fence's and the open's `outs` and `floor`) change nothing: each reaches the same states as the smallest model on every bound, `lost` at 2.5 million included (the open's swap was run last, on a quiet box, 208 s).

What the counts are made of:
- **`sess` (13):** one answer rule (`recv.latest`: take only the answer to the latest copy), eight dedup rules (apply only when not among the session's outcomes, above its floor, and while the session lives; a resend's refusal only when not among the outcomes; a first send only may be refused outside the log; a copy at or below the floor is answered `stale`; answer `unknown` only once the expiry has committed in `#s`; a restarted process takes a new session), and four carry rules (the fence and the open each carry the outcomes and the floors). No time rule and no budget: the floor does that work. The design does expire a session only after S silent ticks (`expire.silent`), and the ablation dropped that rule: a session expired early is still safe, because its copies are answered `unknown` and never judged afresh (`apply.live`). Under `win` the matching rule (`forget.silent`) is needed, because a forgotten issuer's late copy is judged afresh. So `expire.silent` is a rule for usefulness, not for exactly once; a build keeps it (14 with it).
- **`win` (17):** the same shape, plus the issuer's window (`send.window`), a budget on each judged copy (2), stop retrying after R and give up after it (2), forget an issuer silent for H (1); it has no session to expire, so no `live` or `dead` rule.
- **`keys` (12):** no floor and no window, so fewer dedup and carry rules (the fence carries outcomes only), but the same budgets and horizons as `win`.
- **`pid` (16):** Kafka's checks that survive (state known and sequence above the last, for the next write; no state, for a new producer), each in both the apply and the refuse paths (6), one attempt in flight per partition, answer "unknown producer" only once the forget has committed (new, below), a new producer id per life, budgets (2), the stop-retry horizon (2), forgetting (1), and carry (2).

### 2. What the rules are for

The rules fall into six jobs. Each row names the rules that do the job in each option and what breaks without them (the shortest counterexample, from the ablation files).

| job | `win` | `sess` | `pid` | `keys` | without it |
|---|---|---|---|---|---|
| spot a duplicate | `apply.notin`, `refuse_r.notin`, `apply.floor`, `stale.floor` | the same four | `known`, `after`, `unknown` (x apply, refuse) | `apply.notin`, `refuse_r.notin` | REFUSED on `lost`: a copy refused, then applied by a later copy |
| stop a late copy | budgets (2), `resend.horizon`, `giveup.late` | the floor (above), `apply.live` | budgets (2), `resend.horizon`, `giveup.late` | budgets (2), `resend.horizon`, `giveup.late` | ONCE on `expire`: a copy lands after the writer forgot its attempt |
| answer honestly | `recv.latest`, `refuse_f.first` | the same two | (every refusal is appended) | the same two | REFUSED on `lost`: the client takes an old copy's refusal for a later copy that applied |
| forget safely | `forget.silent` | `expired.dead` | `forget.silent`, `unknownpid.forgotten` | `forget.ttl` | REFUSED on `lost`, or L7: `unknown` before the design allows it |
| a new life is a new issuer | `restart.life` | `restart.life` | `restart.life` | `restart.life` | TRUE on `restart`: a new life's id matches an old life's outcome |
| carry state on a move | outcomes and highest ids, out and in (4) | outcomes and floors (4) | producer state, out and in (2) | outcomes, out and in (2) | ONCE on `move`: the new group applies a copy the old one already applied |

Two fixes were found in `pid` as first written (KIP-98's rules, as `models/dedup.py` had them):
- **A partition could stall for ever.** If an attempt's copies never landed and the client gave up (after R), the next attempt carried sequence 1 to a writer that never saw 0, and every later write there was refused as "unknown producer". The design run failed L7 on `expire` in 5 steps. Kafka hit the same and fixed it with KIP-360 (bump the epoch, restart the sequence at 0); the model now has that bump (`giveup.bump`, `recv.bump`).
- **`unknown` from an uncommitted forget.** The writer answered "unknown producer" from a forget still in its uncommitted tail, so the client heard `unknown` for an attempt the design still covered (L7 on `expire`, 11 steps). The guard `unknownpid.forgotten` (answer only once the forget has committed) is `sess`'s `expired.dead` for producers.

The ablation then dropped the bump, and Kafka's "an unknown producer starts at 0" and "no gap" checks with it: fero's per-copy budget already stops a late copy before the writer can forget its producer, so a gap is harmless. Kafka has no writer-side budget, so it needs them. A different drop order could keep the bump and the zero check instead of dropping both (18 rules); 16 is a 1-minimal set, not the only one.

### 3. Does `fwd` need a rule that `smart` does not?

Yes, in every option, but how much depends on whether any answer comes from outside the log:

| option | rules only `fwd` needs | why |
|---|---|---|
| `win` | `forward.age`, `forward.once` | `forward.age`: a relay subtracts the time it held a copy from its budget; without it a copy lands after the writer forgot its attempt (ONCE on `expire`, 11 steps). `forward.once`: a relay forwards a copy once; without it one copy reaches the writer twice, is refused the first time with an answer that is not in the log, and applied the second time (REFUSED on `lost`, 7 steps) |
| `keys` | `forward.age`, `forward.once` | the same two, the same traces |
| `pid` | `forward.age` | the same budget rule as `win` (ONCE on `expire`, 10 steps). `forward.once` is not needed: `pid` appends every refusal (else its sequence would gap), so no answer comes from outside the log, and a copy delivered twice is a plain duplicate |
| `sess` | `forward.once` | `sess` has no budgets, so no `forward.age`. Without `forward.once` a relay forwards one copy twice: the first delivery is refused (a first send's refusal, which is not in the log), the client takes that answer, and the second delivery applies (REFUSED in 9 steps, on every bound). With every refusal appended (`sess-fwd-all`), dropping it breaks nothing (every bound; `expire` and `mvexp` to the 1.5 million limit) |
| `win-fwd-all` (every refusal appended) | `forward.age` only | with no answer outside the log, a second delivery of a copy is a plain duplicate; `recv.latest` and `refuse_f.first` go too (16 rules, against `win-fwd`'s 19), for one log entry per refused first send |

So the threshold's rule applies: `fwd` needs one or two hop rules in every option, `sess` included (`forward.once`), so they are counted in every `fwd` row, and Y is not decided on latency alone: `smart` saves one rule under `sess` and two under `win` and `keys`. Browsers stay `fwd` (SPACE.md, axis Y), so these rules are written and tested in any case; `smart` only takes them off the path of server clients.

### 4. Memory per client (measured here)

The writer's dedup state in Node 22, one shard, after a full GC ([mem.mjs](mem.mjs), [results/memory.txt](results/memory.txt)):

| State | Bytes per client at 1e4 | at 1e6 | Total at 1e6 |
|---|---|---|---|
| `win`: per issuer, the highest id and one outcome (W bounds them) | 366 | 349 | 332 MB |
| `sess`: per session, the floor and one outcome | 327 | 309 | 295 MB |
| `sess` split per slot (each client writes 4 slots), so a move carries its part | 1,305 | 1,237 | 1.18 GB |
| `pid`: per (producer, partition), 4 partitions per producer, Kafka's 5 cached batches | 2,201 | 2,133 | 2.0 GB |
| `keys`: per key (not per client) | 240 | 221 | 211 MB per million keys |

`keys` holds one entry per write for its TTL, so its size is the write rate times the TTL: at 1e5 writes a second, 6e7 keys (13 GB) for a 10-minute TTL, 8.6e9 keys (1.9 TB) for Stripe's 24 hours. `win` and `sess` hold one entry per active client; `pid` one per (client, partition).

Both `win` and `sess` must carry each issuer's (session's) floor when a slot moves (the `fence.hi` and `fence.floor` rules above). Carried whole, that is one entry per active client per move (about 16 bytes each on the wire: 16 MB a move at 1e6 clients); kept per slot instead, it is the third row (1.18 GB at 1e6 clients writing 4 slots each).

## What the model leaves out

- **Unclean recovery** (a committed log cut back): the groups are crash-only, as in E-17 (slot_move.py shows a move needs five more rules under it).
- **Real elections, leases and clocks**: a group is abstract Raft (E-14 checks Raft); writer time is one global clock (E-21 owns skew and jumps).
- **The follow lag of `#s`**: `sess`'s writers read `#s`'s committed log directly. Reasoned: a writer that has not yet seen an expiry still holds the session's outcomes (it drops them only when it sees the expiry), so lag delays forgetting and never causes a fresh judgement.
- **Keyed calls (TEST-03) are not modelled apart.** A call's re-run issues the same attempt ids as the first run (DESIGN-V5 4.5), so to the writer it is a late resend from the same issuer, which bounds `lost`, `expire` and `exprst` already cover. Reasoned: under `sess` the call needs a session of its own (registered with its `#calls` claim, renewed by whoever runs it), one rule; under `win` the issuer is the call key, one rule; under both, a re-run after the session or issuer is gone ends `unknown`.
- **Transport duplication.** A copy is delivered at most once (TCP). Under `fwd` a relay may forward a copy again only if the rule `forward.once` is dropped; an answer reaches the client from any delivery (the model does not tie an answer to the link it came back on), see section 3.
- **Small bounds**: two attempts, two or three copies each, one or two faults, W = 1, time up to 2 ticks, one slot move. A count is a count at these bounds.
- **One agent, one drop order.** DEV-10 (e) asks two agents to count; this is one agent's count. A second order of greedy drops (`./run.sh rev`) was not run (CPU budget: the ablations already cost about three times the estimate). How much the order could matter, from the ablation files: in `keys-smart` and `win-smart` the rules kept (12 and 17) are exactly the rules that break a property when dropped alone from the full design, and the others all drop together, so another order has nothing else to choose (reasoned, not run). In `sess-smart` and `pid-smart` one rule each was first kept and then dropped by the final pass (`expire.silent`, whose lone drop ran to the state limit; `giveup.bump`), so another order could end one rule up or down there, as section 2 says for `pid`.

## Verdict

Every option holds exactly once in every scenario modelled, so the count and the memory decide. By the count alone `keys` (12) is one rule ahead of `sess` (13), and both are well ahead of the draft's `win` (17) and `pid` (16). `keys` keeps one entry per write for its TTL, so its memory grows with the write rate: 13 GB for one busy writer (1e5 writes a second) at a 10-minute TTL, measured at 221 B a key. `sess` keeps one entry per active client, whatever the rate (295 MB at 1e6 clients), and needs no time rule at all, because the client's floor stops late copies. So `sess` is the default for fero's own retries, and `keys` is right where the user brings a key and its TTL is short (TEST-03's keyed calls, Stripe-style idempotency). `sess` does not need its state copied per slot: the fence carries the moving slot's outcomes and every session's floor, about 16 bytes per active client per move (16 MB at 1e6 clients); kept per slot it would be 1.18 GB at 1e6 clients writing 4 slots, which is not needed. Under `fwd`, `sess` needs one more rule (`forward.once`, 14), or none if every refusal is appended to the log (one log entry per refused first send); `smart` takes it off the path of server clients, and browsers keep `fwd`.

Q-20: `sess` (client sessions, Raft thesis 6.3): 13 rules, no time rule, 309 B per active client, against the draft's `win` at 17; `keys` has 12 but memory per write (13 GB per busy writer at a 10-minute TTL), so it serves user keys only; under `fwd` `sess` adds `forward.once` (14 rules), or none if every refusal is appended. Moves: `sess` rows (MIN and its family, CELL, OBJ) up on F-02, DEV-01 and DEV-10; Y `smart` up by one hop rule over `fwd` (two under `win` and `keys`), counted in every `fwd` row; `win` rows (DRAFT, LANE, SPLIT, SLOG) down on DEV-10 (4 more rules) unless they switch D to `sess`; ISR's `pid` down on DEV-10 and memory (16 rules, 2.1 KB per producer); `keys` up on TEST-03 only.

