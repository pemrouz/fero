# The E-17 harness: how to add an option

This is the shared Python harness of E-17 ([QUESTIONS.md](../../QUESTIONS.md) Q-17). It checks every way of mapping partitions onto groups against the same world, the same faults and the same properties, and counts rules the way [REQUIREMENTS.md](../../REQUIREMENTS.md) DEV-10 says. Four options are built on it already: `fixN`, `rekey`, `rekey-carry` and `slot` ([options/](options)). This file tells the next agent exactly how to add one (`pslot`, `split` + merge, lanes + range moves), and how to re-run an ablation.

Plain Python 3 (3.13 here), standard library only, no outside tools.

## The files

| File | What it holds |
|---|---|
| [harness/dsl.py](harness/dsl.py) | The rule language: `Action`, `Guard`, `Cmp`, `Update`, `Mutation`. |
| [harness/world.py](harness/world.py) | The shared world: groups as abstract Raft logs, commit, crash, the ghost history, the properties (`PROPS`), the `Option` base class. |
| [harness/explore.py](harness/explore.py) | Breadth-first search, the safety checks, the liveness check. |
| [harness/bounds.py](harness/bounds.py) | The shared bounds (`SWEEP`, `VERIFY`). |
| [harness/runner.py](harness/runner.py) | Loading options, ablation, mutants, the resumable checkpoint. |
| [harness/cli.py](harness/cli.py) | The command line. |
| [harness/report.py](harness/report.py) | `results/summary.md` from the ablation results. |
| `options/<folder>/model.py` | One option. Its README explains it. |

## Commands

```sh
python3 harness/cli.py --list                                  # options, bounds, properties
python3 harness/cli.py --option slot                           # every bound, with traces
python3 harness/cli.py --option slot --bound grow --drop final.outs    # one rule switched off
python3 harness/cli.py --option slot --bound read --flip read.after    # one comparison flipped
python3 harness/cli.py --option slot --rules                   # the rule list
./run.sh slot                                                  # ablation + mutants, in 20-minute pieces under the heavy lock
FRESH=1 ./run.sh slot                                          # the same, ignoring the checkpoint (a second agent's re-run)
python3 harness/cli.py --option slot --ablate --giveup         # the same with the give-up path pinned -> results/slot+giveup-ablation.json
python3 harness/cli.py --option rekey-carry --ablate --warm-from rekey   # start from rekey's dropped rules
python3 harness/cli.py --option rekey --ablate --warm-from rekey \
    --warm-keep freeze.rkcom --warm-drop freeze.cutcom --warm-drop cut.append --tag rekey-alt   # another greedy order
python3 harness/report.py > results/summary.md
```

- `--giveup` pins (never drops) the rules listed in the model's `GIVEUP` tuple: the appends that start a give-up (cancel, abort, abandon). The ablation then finds what else a give-up needs to hand the partition back (property L5g). The result is saved as `<option>+giveup`.
- `--warm-from X` starts from the rules `results/X-ablation.json` dropped. It is used only if every bound holds with them dropped; then pass 1, greedy and the final pass run as usual, so the result is still 1-minimal. `--warm-keep` and `--warm-drop` edit that list. Use it to try another greedy order (finding 5 in the README) or a sibling variant.
- `--tag NAME` saves the result as `results/NAME-ablation.json` (the checkpoint stays `results/<option>-checkpoint.json`, shared by every run of that option, so run them one after the other, not at once).
- `--no-mutants` skips the mutants (used for `rekey+giveup`, whose core mutants are already counted).
- `--pin RULE` (repeatable, with `--tag`) pins these rules in place of the model's `GIVEUP` tuple. `slot+abort` uses it to price a give-up path with one decider: `--pin abort.append --pin import.append`.
- `--reverse` runs the greedy drops in reverse model-text order (`slot-rev`, `rekey-rev`). Run it, with `--tag <name>-rev`, for every new option: the order can change which of two twin rules is kept (README finding 5).
- `--seed-from X` copies `results/X-checkpoint.json`'s cache into a new tagged checkpoint, if that one does not exist yet. The cache holds runs keyed by the rules dropped, so it only saves time; it never changes a result. It must be a checkpoint of the same option (the runner checks).

The command line re-runs itself with `PYTHONHASHSEED=0`, so state digests are the same from run to run (they decide whether a mutant is equivalent).

## The world

**Groups.** Each group is an abstract Raft group: `(com, tail, lost, crashes)`.
- `com` is the committed log. It only grows.
- `tail` is the current leader's uncommitted entries. Option actions append here.
- `commit` (a harness step) moves the first tail entry into `com`.
- `crash` (a harness step) is a leader crash and a new leader at once (a deposition). The new tail is any prefix of the old tail, or of a tail lost by an earlier leader. That earlier tail can come back until the next commit, as in Raft (an entry on a minority can return if no newer entry committed). Then `lost` is cleared. There is no volatile leader state: everything an option knows is in its logs.
- Budgets: `crashes` per group, `faults` per run.

**Partitions.** Two: `p` and `q`. Hash: p → 1, q → 0.

**The client.** Attempts are `(id, partition, lock token)`, from the bound. A copy of any attempt may reach any group at any time, any number of times. That covers stale routes, retries, duplicates and delay with no client state. Two answers exist: applied (it commits) and refused for good (`d.refuse(aid)`, a ghost). "Retry" and "moved" are not answers: the copy just goes elsewhere.

**The reader.** If the bound says so, one reader follows `p`. Its state is `(cursor, seen)`. The cursor is yours to define. `seen` is the attempt ids it has taken, in order.

**The ghosts.**
- `hist[part]` is every original application of a write: `(aid, pos, tok)`, appended by the harness when an entry `('w', aid, part, pos, tok)` commits. **A write must be exactly that tuple.** Copies of rows into another group are not writes: give them your own entry kind.
- `refused` is the set of attempts told "refused" for good.

**Why there is no message set.** Group-to-group messages are not part of the state. A report is a fact in the sender's log, and the receiver acts on it by reading that log. With crash-only faults this loses nothing. A committed entry never goes away, so a report of it delivered late is the same as reading the log late. A lost message is a log nobody reads. A duplicate is a log read twice. Reports from uncommitted entries are also possible: the receiver's action enumerates facts from the sender's whole log, and a guard (`...com`) says "committed only". Dropping that guard is the mutant "acts on an uncommitted report". This keeps the state small, and it stays sound as long as no fault can un-commit an entry. **With unclean recovery (a committed log cut back), this argument fails, and an option would need real messages, as `slot_move.py` has.**

**The event alphabet** (QUESTIONS "How to read this"):

| Event | Here |
|---|---|
| crash | the harness `crash` step: a leader dies, a new one takes over with a prefix of the tail |
| restart | the same step: the new leader rebuilds from its log; nothing volatile exists to lose |
| partition | a fact never read and a copy never delivered; liveness is checked from every state with no fault after it |
| deliver | an option action of kind `deliver`: a process acts on a fact or a client's copy |
| tick | an option action of kind `tick`: a timer fires (a free choice such as cancel or abort) |
| (control) | an option action of kind `control`: a scale change starts (grow, shrink) |
| (read) | an option action of kind `read`: the reader asks a group for the next record |

## The properties

All live in `world.py` (`PROPS`, `World.check`, `World.check_edge`, `World.goals`).

| Id | Property |
|---|---|
| P1 | No acknowledged write lost or extra: every group that holds a partition open (by its committed log) has exactly the partition's history as rows. |
| P2 | A position never changes meaning: no position names two writes, and positions rise along each partition's history. |
| P3 | Dedup and fence state survive: no attempt applied twice; lock tokens never fall along a partition's history; an attempt told "refused" never commits. |
| P4 | A cursor resumes with no gap or overlap: what the reader took is always a prefix of the history, and only ever grows (a snapshot that replaces it must extend it). |
| P6 | One writer per partition: at most one group holds it open. |
| L4 | The reader can always catch up. |
| L5 | Every change under way can end once faults and timers stop. |
| L5b | Grow and shrink finish: from every state reached with no give-up timer (cancel, abort, abandon), every planned change can still complete (`done_all`). Without it, a model that never starts a change passes L5. |
| L5g | A give-up gives the partition back: once a change is given up (its cancel, abort or abandon committed), the source group can hold the partition again, alone (`given_up`). |
| L7 | Every attempt can get an answer once faults and timers stop. |

Liveness is AG EF goal over the **calm** steps: commit, `deliver` and `read`. No crash, no `tick`, no `control`. From every reachable state, calm steps alone must be able to reach the goal. A state where the log-length cap (10 entries a group) stopped an append counts as able to reach it, and the run reports it (`cap hit`). The designed models built so far never hit the cap; a model without an idempotence guard often does. A run also stops at 1.5 million states, to bound memory: if it found no counterexample by then, the result is `LIMIT` (undecided). The ablation keeps such a rule and the report marks it `undecided`, so a count with undecided rules is an upper bound. A `LIMIT` on the verify bound puts nothing back (the result says `verify_undecided`), and a mutant stopped at the limit is `undecided`, never counted as caught. A model with a give-up path pinned can be ten times bigger than its core (slot's `deep` bound: 5,036 states core, 1.1 million with the give-up path), so expect undecided rules there.

## Adding an option, step by step

1. **Make `options/<folder>/model.py`.** The option's name is the folder (or `folder-variant`, see `rekey-carry`). Export `OPTION = YourClass`, or `OPTIONS = {'name': Class, ...}` for variants.
2. **Subclass `world.Option`** and set or define:
   - `names`: the group names (a tuple). Group 0 can be a catalog or `#meta` (see `rekey`).
   - `ZERO`: the position a dropped `pos` update leaves. Use your position type (a tuple).
   - `genesis()`: the first committed entries per group, if any (usually none: say who holds what in `owners` from the bound's first layout).
   - `cursor0()`: the reader's cursor before any record.
   - `owners(w, st, part)`: the groups whose **committed** log holds the partition open for writes.
   - `rows(w, st, g, part)`: the partition's rows at g by its committed log, as a tuple of attempt ids in order.
   - `settled(w, st)`: no change under way, and every tail empty.
   - `actions()`: your list of `Action`s.
   - `done_all(w, st)`: every change the bound plans has completed (L5b). Without it, L5b is trivially true.
   - `given_up(w, st)`: `[(partition, source group)]` for the latest change if it was given up (L5g). Return `[]` if your option has no give-up path.
   - `show(entry)`: optional, for traces.
   - At module level, `GIVEUP = (...)`: the rule ids that start a give-up (the appends of cancel, abort, abandon), pinned by `--giveup`. Leave it out if the option has none.
3. **Read the bound's layouts your way.** `bounds.py` gives a list of layouts: partition → group number, at the start and after each change. Numbers are units of load, not your groups. `fixN` uses the first layout's count. `rekey` reads each layout's count as a generation's cell count. `slot` reads layout changes as slot moves. For `split`: grow = G0 splits and p's half goes to the new group; shrink = the merge back. For lanes: map p and q to two resources sharing lanes. For `pslot`: let p and q be two resources' partitions that start in one shared group; the grow splits p's resource out.
4. **Write the client's actions**: a `write` action (`deliver`, params: every attempt × every group), a `refuse` action, and the reader's `read` action (and anything your cursor needs). Copy them from `fixN` and change only what your option changes. `fixN`'s 13 necessary rules are the floor every option pays.
5. **Write your move or change protocol** as further actions.
6. **Run it**: `python3 harness/cli.py --option <name>`. The model as designed must hold every property on every bound. If it does not, the trace shows why: fix the model (or report a real bug in the design you are modelling).
7. **Ablate**: add the name to `OPTIONS` in `cli.py`, a line for it in `run.sh` (copy `slot`'s: the core, then `--giveup` if it has a give-up path), and the name and `name+giveup` to `ORDER` in `report.py` (`pslot`, `split` and `lanes` are there already). Then `./run.sh <name>`, and `python3 harness/report.py > results/summary.md`.
8. **Write `options/<folder>/README.md`** in the style of `options/slot/README.md`: what it is, the model, what it leaves out, the results. Compare with fixN's 13: the count that matters is "beyond fixN".

## Rules for writing rules (or the counts are not comparable)

- **One guard conjunct per `Guard`, one changed field or log per `Update`.** A guard that tests two things is two guards. An entry built from several fields is one `Update` per field (`d.e['outs'] = ...`) and one `Update` that appends it, reading the fields with defaults (`d.e.get('outs', frozenset())`). That is what lets ablation say "dedup transfer is needed" separately from "fence transfer is needed".
- **A comparison is a `Cmp`**, so the flip mutants exist.
- **Never filter in `params`.** Parameters enumerate broad candidates: every attempt × every group, every fact in any log. Any filter that is a design decision is a `Guard`. A filter hidden in `params` is a rule nobody counts. Filters that only name the topology are fine, for example "the cells of the generation this re-key copies from".
- **Enumerate what the acting process owns, and make the trigger a guard.** If A fences "on B's ready report", enumerate A's own moves and write "B's committed log holds a copy" as a guard. Do not enumerate B's copies as the parameters: then the report is built into the action, and ablation can never ask whether A needed it. (The first slot model did exactly that, and the bulk copy looked necessary when it is not.) The same holds for re-key's freeze: enumerate the re-keys, and make "the catalog committed the cut-over" a guard. A trigger that is the action's very input is fine as a parameter, for example the fence entry that `END(N)` comes from.
- **Check names against the log.** A move named by a log position is checked by reading the log at that position, as the design says ("a late message from an ended move is ignored"). Checking only that the position is committed lets stale names act.
- **The two kinds of rule** (DESIGN-V5 §4.2). A step that **waits for** an entry reads committed entries (`w.com(st, g)`, or the fact's index `< len(w.com(...))` as its own guard). A guard that **forbids** a step reads the whole log (`w.log(st, g)`), since a tail entry may yet commit.
- **A log never holds the same entry twice.** The harness ignores an append of an entry already in the log (committed or in the tail). So a guard that only stops an exact repeat (B appending the same `abort` twice) is not needed, and ablation drops it. Without this, a timer could repeat such an entry until the cap, and the run would blow up with no property broken. An idempotence guard that stops a *different* entry (a second fence of the same move with a new N) can still be necessary. Give such guards `role='idem'`.
- **No state outside the logs.** If your design keeps something in a leader's memory, model it as a log entry or explain why not. The harness has no volatile state, so a crash loses nothing but tail entries.
- **Roles** (`dsl.ROLES`) group the rules in the report: route, dedup, fence, stamp, cursor, move, carry, decide, perf, idem, answer.

## How the ablation and the mutants work

`runner.py`, as DEV-10 (c) and (d) say:
1. The model as designed runs every `SWEEP` bound in full. Everything must hold.
2. **Pass 1**: drop each rule alone; it is necessary if some bound then fails (bounds cheapest first, stop at the first failure).
3. **Greedy**: drop the rules pass 1 found unnecessary, one at a time in model-text order. Keep each drop only if every bound still holds.
4. **Final pass**: with those dropped, drop each remaining rule again. Each must now fail. The ones that do not are dropped greedily (each kept dropped only if everything still holds), and the pass repeats until every rule left fails. What is left is 1-minimal.
5. **Verify**: run the smallest model on the `VERIFY` bound (`twice1`: two changes with one crash). It is too big to sweep for `rekey` (about 1.3 million states). If it fails, dropped rules go back, the latest dropped first, until it holds.
6. **Mutants** of the smallest model: drop each guard, drop each update, flip each `<`, `<=`, `>`, `>=`, and swap each pair of updates in one action. A mutant no bound catches is run in full. It is **equivalent** if every bound's state set (count, steps and digest) equals the smallest model's. Otherwise it **survived**.

The work is cached in `results/<name>-checkpoint.json`. A piece stops after `--budget` seconds (run.sh gives 1,200), and the next piece carries on. The result is `results/<name>-ablation.json`. A second agent re-runs with `FRESH=1 ./run.sh <name>` and compares its `removed` list and mutant table with the first.

The order of the greedy drops can matter when two rules each cover for the other. The result lists the order (`greedy`) so a second agent can see it, and the final pass proves the set left is 1-minimal. It need not be the smallest possible set: two different 1-minimal sets can differ in size. Say so if you find one.

## What the harness leaves out (true for every option)

- **Unclean recovery** (a committed log cut back). See "Why there is no message set": an option checked here is checked under crash-only faults. `slot_move.py` shows slot moves need five more rules under it.
- **Membership, elections and leases.** A group is an abstract Raft group; E-14 checks Raft itself.
- **Time.** No clocks; timers are free choices (`tick`), and liveness forbids them.
- **More than two partitions, two or three writes, one reader,** and the bounds in `bounds.py`.
- **Throughput and latency.** The unwritable window (SC-08(b)) is not modelled: rules whose only job is to shorten it get `role='perf'`, and the ablation shows they are not needed for any property.
