# E-30: derived outputs exactly once, with the cursor in another group and a long restart

**Question (Q-30).** Do consumer groups and derived resources stay exactly once when the outputs and the cursor sit in different groups, across a restart longer than the dedup horizon?

**Threshold.** If only `srcpos` holds, or only putting the cursor in one partition with its outputs, D carries a retention-length key table: priced in DEV-01 with its memory per consumer, and P-08 and P-17 name the rule. If nothing holds without X `2pc` or `ktxn`, X moves.

**In short** (model-checked here, every reachable state at small bounds unless marked; [results/design.txt](results/design.txt), [results/summary.md](results/summary.md), [results/elle.md](results/elle.md), [results/memory.txt](results/memory.txt)):
- **No dedup option with a horizon survives a restart longer than its horizon.** `win`, `sess` and `keys` apply an output twice in bound `long` (12 to 13 steps): the consumer comes back after the writer forgot, re-reads its cursor (written after the outputs), and sends again. `pid` (a new producer id per life, Kafka's idempotent producer without transactions) applies twice after a short restart too (9 steps).
- **Two options hold in every bound, with no two-phase commit and no Kafka-style transaction:** `srcpos` (the output's id is its source position and its order in the record, kept for the source's retention) and `srchi-slot` (the cursor beside the outputs: per consumer, source slot and B slot, the highest source sequence applied, written in the output's own entry and carried with the B slot when it moves).
- **Rules (DEV-10):** `srchi-slot` 5, all needed, 6 of 6 mutants caught; `srcpos` 4, all needed, 4 of 4 mutants caught.
- **Memory decides.** `srcpos` keeps a key per output for the source's retention (85 B each in Node: at 1e5 outputs a second and 7 days, 6e10 keys, about 5 TB); `srchi-slot` keeps one number per (consumer, source slot, B slot) (29 B each), whatever the rate and the retention.
- **Both are easy to get subtly wrong**: the mark kept per group instead of per B slot (`srchi`), or the id without the output's order (`srcpos-nok`), loses an output when a B slot moves (LOST, 12 steps).
- **Real Elle** (0.2.8, TEST-13) agrees with the model in all 2,800 histories (7 options, bounds `short` and `long`, 200 seeded walks each): it finds duplicate outputs in exactly the 396 histories where the model's ONCE check broke (`win`, `sess` and `keys` in `long`, `pid` in both), and none for `srcpos`, `srchi` or `srchi-slot`.

## Words used here

- **Source A** and **output B**: a derived resource reads A's log and writes B (P-17, `derive`); a consumer group member does the same with `group(...).run()` (P-08). Each record of A gives some outputs in B, here `incr`s, which are not idempotent (P-17's hard case on purpose).
- **Cursor**: where the consumer is in A, one position per source slot. Here it is a row in a third group (`#groups`), not in B's groups.
- **Dedup horizon**: how long a writer keeps what it needs to spot a repeated write (E-20). A consumer that crashes and restarts **later** than that cannot count on dedup state from before.
- **srcpos**: the attempt id of an output is its source position (slot, sequence) and its order k among the record's outputs; a writer keeps those ids for as long as the source keeps the record (its retention), because a restarted consumer can only re-read what the source still holds.
- **srchi** (named here): the cursor beside the outputs. Each B writer keeps, per (consumer, source slot), the highest source sequence it has applied, written in the same entry as the output, so the output and "how far this group got" commit together. It is `srcpos` compacted to one number per (consumer, source slot, B group).

## Method

One exhaustive model in plain Python, [models/derived.py](models/derived.py), on E-16's engine with E-17's rule language, extending E-20's world ([../E20-dedup/models/dedup.py](../E20-dedup/models/dedup.py): abstract Raft groups with crashes and lost tails, copies delivered at most once or lost, a global clock). Then real Elle 0.2.8 on the outputs ([elle_hist.py](elle_hist.py), [clj/elle_e30.clj](clj/elle_e30.clj)).

**The world** (not counted):
- Source A, two slots, already committed: a1 holds x1 (and x2 in bound `deep`), a2 holds y1. f sends x1 to one row in group b0 and one in group b1 (a record whose outputs span two groups), y1 to b1, x2 to b0.
- Output B: groups b0 and b1. The cursor: one row per source slot in a third group, gc (`#groups`). gc also holds `sess`'s sessions.
- One consumer that owns both source slots. When it starts, it reads the committed cursor. For each source slot, in order, it sends every output of the record at its position, waits until each is answered, then appends the cursor (position + 1) to gc and moves on, re-sending the cursor if gc lost it. A crash (a fault) loses everything it holds; its copies stay in flight; it restarts later and reads the cursor again. In bound `long`, time passes while it is down, longer than the horizon H.

**Properties.** ONCE: no output applied twice. LOST: the committed cursor never passes a record whose outputs are not all in B. Together they are "B = f(A) exactly" as a safety property. DONE: from every state where the consumer has copies left, calm steps reach B = f(A) with every cursor at the end.

**The options** (D, as E-20, applied to the outputs, plus `srcpos` and `srchi`):

| Option | The outputs' ids and what each B writer keeps |
|---|---|
| `win` | issuer (consumer, source slot), call id = the source sequence (API.md: "attempt ids made from the entry's position"); per issuer the highest id and the outcomes above the floor (W = 1); an issuer silent for H is forgotten |
| `sess` | a consumer session in gc, reused by the next life while it lives, renewed while the consumer runs, expiring S = H after its last renewal; outcomes kept until it expires; an expired session is answered `unknown`, and the consumer, unable to tell whether the output landed, opens a new session and sends it again |
| `pid` | Kafka's idempotent producer without transactions: a new producer id per life, a sequence per (producer, B group) from 0; the writer keeps the last sequence |
| `keys` | an idempotency key per output, (source slot, sequence, group), kept for TTL = H |
| `srcpos` | the id is the source position and the output's order k among the record's outputs, (source slot, sequence, k); kept for the source's retention (here the source keeps everything, so the key is never dropped) |
| `srchi` | the id is the source position; the writer keeps one number per (consumer, source slot): the highest source sequence applied in this group, written in the output's own entry; an output at or below it is a duplicate |
| `srchi-slot` | `srchi` kept per (consumer, source slot, B slot) instead, so a B slot move carries exactly that slot's numbers (added after `srchi` failed the move bounds) |
| `srcpos-nok` | `srcpos` with the id (source slot, sequence) only, without the output's order k within the record's outputs (a check on why k is needed) |

**Bounds**: `short` (one consumer restart, no time passes), `gcrash` (a restart and one leader crash in b0, b1 or gc), `drop` (a restart and one lost message), `long` (a restart while time passes beyond H), `deep` (x1 then x2 on one source slot, two restarts), `bmove` and `bmove2` (a B slot move: x1's outputs sit in B slots P in b0 and R in b1, R moves from b1 to b0 by E-15's fence and open while the consumer may restart; `bmove2` adds x2 in P). In the move bounds, `win`, `sess`, `pid` and `keys` carry nothing with the moved slot: what each must carry is E-20's question, so only `srcpos` and `srchi` carry their state here.

**Memory** ([mem.mjs](mem.mjs)): the same method as E-20's probe (build the map in Node 22, full GC, heap delta per entry) for the two options that hold: `srcpos`'s key per output and `srchi-slot`'s number per (consumer, source slot, B slot).

## Results

Machine: 4 vCPU, 15 GB, shared with other agents (every run under the heavy lock); Python 3.13, standard library; Node 22.22.0; Elle 0.2.8 on OpenJDK (version in [results/elle.md](results/elle.md)). Raw output: [results/design.txt](results/design.txt), `results/<option>-ablation.json` and `.log`, [results/summary.md](results/summary.md) (generated), [results/memory.txt](results/memory.txt), [results/elle.md](results/elle.md) with `elle-index.jsonl` and `elle-verdicts.jsonl`.

### 1. Which options hold (design runs)

Each cell: `holds`, or the properties broken and the shortest counterexample's length in steps. "(limit)" marks a run stopped at 1.5 million states: a failure there is real, a "holds" there covers only the states explored.

| option | short | gcrash | drop | long | deep | bmove | bmove2 |
|---|---|---|---|---|---|---|---|
| `srchi-slot` | holds | holds | holds | holds | holds | holds | holds |
| `srcpos` | holds | holds | holds | holds | holds | holds | holds |
| `srchi` | holds | holds | holds | holds | holds | DONE 1, LOST 12 | DONE 1, LOST 12 |
| `srcpos-nok` | holds | holds | holds | holds | holds | DONE 1, LOST 12 | DONE 1, LOST 12 |
| `win` | holds | holds (limit) | holds | ONCE 12 (limit) | holds | (no carry here) | (no carry here) |
| `sess` | holds | holds (limit) | holds | ONCE 13 (limit) | holds | (no carry here) | (no carry here) |
| `pid` | DONE 4, ONCE 9 | ONCE 9 (limit) | DONE 4, ONCE 9 | ONCE 9 (limit) | ONCE 9 (limit) | (no carry here) | (no carry here) |
| `keys` | holds | holds | holds | ONCE 12 (limit) | holds | (no carry here) | (no carry here) |

State counts: `srchi-slot` and `srcpos` 64,897 (`short`), 337,773 (`gcrash`), 136,078 (`drop`), 194,691 (`long`), 12,019 (`deep`), 7,029 (`bmove`), 42,877 (`bmove2`). The move bounds break `win`, `sess`, `pid` and `keys` here only because this model gives them nothing to carry (E-20 shows what each must carry); their verdict rests on `long`.

How each one fails:
- **`win`, `long`** (12 steps): x1's output to b0 applies; the consumer crashes before its cursor commits; time passes beyond H; b0 forgets the issuer (`fg`); the restarted consumer reads the old cursor and sends x1's output again; b0 applies it as new.
- **`sess`, `long`** (13 steps): the same, with the session expired; the writer answers `unknown`, the consumer cannot tell whether the output landed, opens a new session and sends again (`newsess`), and it applies twice. Answering `unknown` is honest; the consumer has no way to act on it safely.
- **`keys`, `long`** (12 steps): the key's TTL ends before the restart.
- **`pid`, `short`** (9 steps): the restarted consumer is a new producer, so the writer has no sequence to compare against. This is why Kafka needs transactions (KIP-98's transactional producer, KIP-447) for exactly once from a consumer, not just idempotence.
- **`srchi` and `srcpos-nok`, `bmove`** (12 steps): x1 has outputs in B slots P (in b0) and R (in b1). R moves into b0. Under `srchi`, b0 already holds "a1 applied up to 0" from P's output, so once R opens in b0 the writer reports R's output as applied though it never was; the consumer learns "done", and its cursor passes x1 with R's output missing (LOST). Under `srcpos-nok`, both outputs have the id (a1, 0), so in one group the second is taken for the first. The mark must be per B slot, and an id must name the output, not just the source record.

### 2. Rules each holding option needs (DEV-10)

| option | rules needed | of written | by role | mutants caught |
|---|---|---|---|---|
| `srchi-slot` | **5** | 5 | cursor 1, dedup 2, carry 2 | 6 / 6 |
| `srcpos` | **4** | 4 | cursor 1, dedup 1, carry 2 | 4 / 4 |

`srchi-slot`'s five ([results/summary.md](results/summary.md)): commit the cursor only after every output of the record is answered (`commit.acked`; without it LOST on `short`, 3 steps), apply only above the mark (`apply.above`; ONCE on `bmove`, 11 steps), write the source sequence into the output's entry (`apply.mark`; without it nothing ever counts as applied, DONE on `short`), and carry the slot's marks out with the fence and in with the open (`fence.carry`, `open.carry`; ONCE on `bmove`). `srcpos`'s four are the same cursor rule, "apply only if the source position is not in the table" (`apply.notin`), and the same two carry rules (the moved slot's keys out with the fence and in with the open). Its id must include the output's order k in the record: without it (`srcpos-nok`) the design itself loses an output on a move (table above), so k is part of the id, not a rule.

### 3. Memory (measured here, Node 22, after a full GC)

| What a B writer keeps | bytes per entry at 1e4 | at 1e6 | grows with |
|---|---|---|---|
| `srcpos`: a key (source slot, sequence, k) per output applied, for the source's retention | 103 | 85 | output rate x retention |
| `srchi-slot`: one number per (consumer, source slot, B slot) | 46 | 29 | consumers x source slots x B slots served, not traffic |

Raw: [results/memory.txt](results/memory.txt). Keys are packed numbers (the cheapest honest form); string keys would cost more.

`srcpos` holds one key per output for as long as the source keeps the record, because a consumer that restarts may re-read anything the source still has. Its size is the output rate times the retention: about 5 TB at 1e5 outputs a second for 7 days, 734 GB for one day. It works only with a short retention, or once compacted, and compacted per (consumer, source slot, B slot) it becomes `srchi-slot`. `srchi-slot` grows with consumers x source slots x B slots that one writer serves, not with traffic: a consumer group whose members cover 1,024 source slots, writing into a group that owns 64 B slots, is at most 65,536 marks (1.9 MB) for that group, and usually far fewer, since a mark exists only where outputs land.

### 4. Real Elle on the outputs (TEST-13)

[elle_hist.py](elle_hist.py) takes 200 seeded random walks of the model per option and bound (`short` and `long`; faults allowed for 40 steps, then calm steps only), and writes each as a list-append history: one append per output (invoked when the consumer first sends it, `:ok` when that consumer learns it applied, `:info` if it crashes first; one Jepsen process per output and life), and one final read of each B row from the committed logs. [clj/elle_e30.clj](clj/elle_e30.clj) checks each with Elle's list-append checker ([results/elle.md](results/elle.md)).

| option | `short`: model ONCE broken / Elle duplicates | `long`: model ONCE broken / Elle duplicates | Elle agrees with the model |
|---|---|---|---|
| `win` | 0 / 0 | 43 / 43 | 400 of 400 |
| `sess` | 0 / 0 | 40 / 40 | 400 of 400 |
| `pid` | 135 / 135 | 139 / 139 | 400 of 400 |
| `keys` | 0 / 0 | 39 / 39 | 400 of 400 |
| `srcpos` | 0 / 0 | 0 / 0 | 400 of 400 |
| `srchi` | 0 / 0 | 0 / 0 | 400 of 400 |
| `srchi-slot` | 0 / 0 | 0 / 0 | 400 of 400 |

The only anomaly Elle reported is `:duplicate-elements` (396 histories), the outside view of the model's ONCE. Lost outputs (the model's LOST, which only the B slot move bounds break) are not visible to list-append without real-time order, and the walks do not cover the move bounds, so Elle confirms ONCE only. The first run of this step was not usable: the exporter gave a consumer's parallel outputs one process number, and Elle rejected 2,727 of 2,800 histories as a double invoke; fixed and rerun (the numbers above).

## What the model leaves out

- **One output per (record, B group).** In every bound f sends at most one output of a record to each B group, so two outputs of one record in the same B slot are not modelled. Under `srchi-slot` they would share one mark, and the second would be taken for a duplicate. Reasoned rule: a record's outputs to one B slot go in one entry (one write per record and B slot), which the slot's single writer applies atomically. With that rule `srchi-slot` needs no per-output order.
- **One consumer, in order.** The mark works because a consumer handles each source slot's records in order. A consumer that processes one source slot in parallel (out of order) needs `srcpos` for that slot, or must commit its outputs in order. Two members owning the same source slot at once is P-08's generation fencing, outside this model.
- **The cursor's own home.** The cursor sits in a third group (`#groups`). With `srchi-slot`, the cursor in `#groups` is only a hint for where to start reading: the true "how far" is the marks in B, so a cursor that lags only costs re-sends that the marks absorb.
- **Abstract Raft, crash-only groups, small bounds** (two source slots, two B groups, two records on a slot at most, one or two restarts, one B slot move), as in E-20 and E-17.
- **The source's retention** is unbounded here (the source keeps everything), so `srcpos` is never tested with an expired key. With a finite retention `srcpos` holds by its definition (a record past retention cannot be re-read).
- **One agent.** The ablation drops in model-text order only; DEV-10 (e)'s second count was not run.

## Verdict

The threshold's first branch is met, in its better form. No dedup option with a horizon (`win`, `sess`, `pid`, `keys`) keeps derived outputs exactly once across a restart longer than its horizon, and `pid` not even across a short one. Two options hold everywhere: a retention-length key table (`srcpos`), or the cursor kept beside the outputs (`srchi-slot`). Neither needs two-phase commit or Kafka-style transactions, so X does not move. `srcpos`'s memory grows with traffic times retention (terabytes at a week); `srchi-slot` costs one number per (consumer, source slot, B slot) and 5 rules, so it is the rule P-08 and P-17 name. It must be keyed per B slot and carried with the slot on a move: the per-group shortcut loses outputs.

Q-30: no `win`, `sess`, `pid` or `keys` option keeps consumer-group and derived outputs exactly once across a restart past the horizon; the cursor kept beside the outputs (per consumer, source slot and B slot, the highest source sequence applied, written in the output's entry and carried on a B slot move; 5 rules, 29 B a mark) does, and so does a retention-length key table (`srcpos`, 85 B per output for the whole retention); no 2pc is needed. Moves: every row's D gains `srchi-slot` for derived resources and consumer groups (P-08, P-17, F-02 up; DEV-01 +1 mechanism, precedent: storing consumer offsets in the same store as the outputs, the "Storing Offsets Outside Kafka" section of the KafkaConsumer javadoc, https://kafka.apache.org/36/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html); X `2pc` and `ktxn` do not move; `srcpos` alone is down on memory (DEV-01's price: terabytes at a week's retention); ISR's `pid` down on P-08 and P-17 unless it adds transactions.
