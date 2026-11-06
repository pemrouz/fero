# fixN: a fixed number of groups, nothing moves

**What it is.** A resource has N groups, fixed when it is defined. A partition goes to group `hash mod N` for ever. This is Kafka's partitions, and V5-PRIMITIVE's 16 cells without the re-key (SPACE P `fixN`). Positions are an offset per group (SPACE O `off`): `(group, log index)`.

**Why it is here.** It is the floor. Every option on this harness pays for the same client path: a write, a final refusal and a reader. fixN pays for that path and nothing else, so "rules beyond fixN" is what an option's moves cost.

**The model:** [model.py](model.py), three actions (`write`, `refuse`, `read`) and 14 rules. Run it with `python3 harness/cli.py --option fixN` from the E-17 folder.

**What a bound means here.** fixN reads only a bound's first layout, as its group count: `grow`, `read`, `both`, `deep` and `twice` run one group, and `shrink` runs two (p on G1, q on G0). No scale change ever happens, so L5 (grow and shrink finish) holds trivially, and the move rules other options need do not exist.

**Results** (from [../../results/fixN-ablation.json](../../results/fixN-ablation.json), summarised in the E-17 [README](../../README.md)):
- 13 of the 14 rules are necessary. The one that is not, `refuse.route`, is covered by the token check: a group that never held the partition has no token to refuse on.
- The 13 are the client path every option needs: route (1), dedup (2), lock tokens (2), stamping (1), the answers (2), and the reader (5).

**What it cannot do** (reasoned, from the definition; not a model result):
- SC-03: the writer count is N, chosen up front. The ceiling is N, and "no count to choose up front" fails by definition.
- SC-04: groups never go away. A quiet resource keeps N groups (they can quiesce, but they exist).
- SC-08 holds only in the trivial sense: partitions never move. Adding a server changes group membership (E-14, E-16), not this.
