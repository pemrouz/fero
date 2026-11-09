# E-20: which dedup option holds exactly once with the fewest rules?

**Question (Q-20).** Which dedup option holds exactly once with the fewest rules, across failover and slot moves? And does routing a write through any server (Y `fwd`) need a rule that sending it straight to the leader (Y `smart`) does not?

**Threshold.** The option with the fewest rules that holds F-02 and TEST-03 in every scenario wins. If `sess` holds them only with session state copied per slot, its memory at 1e6 clients is priced. If `sess` under `fwd` needs any hop rule that `smart` does not, that rule is counted for every `fwd` row; if not, Y is decided on latency alone.

__RESULTS_SHORT__

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
| `pid` | a producer id from `#s`; per (producer, partition) a gapless sequence; accept the next, absorb duplicates, refuse out of order; an unknown producer only at sequence 0; one attempt in flight per partition; every refusal appended (else the sequence would gap); forget after P; budgets and stop-retry as `win` | KIP-98, KIP-360, KIP-854 |
| `keys` | a unique key per write; the writer keeps each key's outcome for TTL; budgets and stop-retry as `win`; no window, no floor | Stripe, SQS dedup ids |

Time constants are the smallest that leave no slack (R = B = H = S = 1 tick), so a comparison flipped by one (`<` to `<=`) can show.

**Pinned** (written as rules, never dropped or mutated, not counted): the world's bookkeeping (the client's statuses, a copy taken off the wire, the append of the write itself), each design's memory bound (win's forgetting, sess's expiry and its floor L, pid's and keys' forgetting), and each design's answers at once (a first send's refusal not appended, `stale-attempt`, `unknown`). Without the pins, ablation would find a slower or unbounded design (for example "keep every outcome forever"); with them, it finds the safety rules each design as written needs.

**Bounds** ([models/dedup.py](models/dedup.py), `BOUNDS`): `lost` (two attempts on s1, three copies each, one crash, one lost message: lost answers, failover mid-retry, a refusal then a stale copy); `move` (an attempt on s2 and one on s1, the move mid-retry, one crash on either side); `restart` (a restart with the old life's copies in flight, the new life runs the plan again); `expire` (time passes: forgetting by writer time with late copies); `exprst` (expiry after a restart, the old life's copies landing late); and the verify bound `mvexp` (a move and expiry together).

__RESULTS_LONG__
