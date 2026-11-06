# E-22b: E-22's histories re-checked with real Elle and real Knossos

**Question (Q-22, real-Elle addendum; [QUESTIONS.md](../../QUESTIONS.md) §10).** E-22 checked its client histories with two Go tools: Porcupine, and a Go port of Elle taken from PingCAP's tipocket, because the real Elle (Jepsen's checker, written in Clojure) could not be downloaded then. Do the real tools give the same verdict on the same saved histories? The histories are E-22's own, in `$SP/e22v`: the 1,200 saga histories (list-append), the 26 self-test histories, and the per-partition register histories. Threshold: the same verdict on every history; any disagreement is traced to a checker bug or a history-export bug.

**Words.**
- A *history* is the record of what clients asked and what they were told.
- *Elle* reads a history of transactions and looks for cycles between them. *List-append* is its workload: each transaction appends numbers to lists or reads whole lists, so every read shows the order of the appends before it.
- The anomalies, in plain words: *G0*, two units wrote two rows in opposite orders; *G1a*, a reader saw a write of a unit that failed; *G-single*, a reader saw half of a unit (a fractured read); *incompatible order*, two reads of one list cannot both be true, so an element was lost; *duplicate*, an element appears twice.
- *Read committed* forbids G0, G1 (G1a, G1b, G1c) and lost or doubled elements: P-15's MUST. *Serializable* also forbids G-single and the other G2 cycles: P-15's SHOULD.
- *Linearizable* means every operation seems to happen at one instant between its call and its answer. *Porcupine* (Go) and *Knossos* (Jepsen's checker, Clojure) both check that, against a *model*: here, E-22's model of one fero partition (rows, versions, conditions, ops).
- *The port* is tipocket v1.0.0's Go copy of Elle, which E-22 used. *Real Elle* is jepsen-io/elle 0.2.8.
- A *mutant* is a planted kernel bug; its histories are known to be bad.

DRAFT: results below are filled in as the runs finish.
