# E-30: derived outputs exactly once, with the cursor in another group and a long restart

**Question (Q-30).** Do consumer groups and derived resources stay exactly once when the outputs and the cursor sit in different groups, across a restart longer than the dedup horizon?

**Threshold.** If only `srcpos` holds, or only putting the cursor in one partition with its outputs, D carries a retention-length key table: priced in DEV-01 with its memory per consumer, and P-08 and P-17 name the rule. If nothing holds without X `2pc` or `ktxn`, X moves.

__RESULTS_SHORT__

## Words used here

- **Source A** and **output B**: a derived resource reads A's log and writes B (P-17, `derive`); a consumer group member does the same with `group(...).run()` (P-08). Each record of A gives some outputs in B, here `incr`s, which are not idempotent (P-17's hard case on purpose).
- **Cursor**: where the consumer is in A, one position per source slot. Here it is a row in a third group (`#groups`), not in B's groups.
- **Dedup horizon**: how long a writer keeps what it needs to spot a repeated write (E-20). A consumer that crashes and restarts **later** than that cannot count on dedup state from before.
- **srcpos**: the attempt id of an output is its source position (slot, sequence); a writer keeps those ids for as long as the source keeps the record (its retention), because a restarted consumer can only re-read what the source still holds.
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
| `srcpos` | the id is the source position; kept for the source's retention (here the source keeps everything, so the key is never dropped) |
| `srchi` | the id is the source position; the writer keeps one number per (consumer, source slot): the highest source sequence applied in this group, written in the output's own entry; an output at or below it is a duplicate |
| `srchi-slot` | `srchi` kept per (consumer, source slot, B slot) instead, so a B slot move carries exactly that slot's numbers (added after `srchi` failed the move bounds) |
| `srcpos-nok` | `srcpos` with the id (source slot, sequence) only, without the output's order k within the record's outputs (a check on why k is needed) |

**Bounds**: `short` (one consumer restart, no time passes), `gcrash` (a restart and one leader crash in b0, b1 or gc), `drop` (a restart and one lost message), `long` (a restart while time passes beyond H), `deep` (x1 then x2 on one source slot, two restarts), `bmove` and `bmove2` (a B slot move: x1's outputs sit in B slots P in b0 and R in b1, R moves from b1 to b0 by E-15's fence and open while the consumer may restart; `bmove2` adds x2 in P). In the move bounds, `win`, `sess`, `pid` and `keys` carry nothing with the moved slot: what each must carry is E-20's question, so only `srcpos` and `srchi` carry their state here.

**Memory** ([mem.mjs](mem.mjs)): the same method as E-20's probe (build the map in Node 22, full GC, heap delta per entry) for the two options that hold: `srcpos`'s key per output and `srchi-slot`'s number per (consumer, source slot, B slot).

__RESULTS_LONG__
