# Question 1. The rule budget

**Blocks:** slice 0, ground. Until it is answered, work goes on only on these pages: the open questions in [NOTES.md](../NOTES.md) and the draft shapes.

## Background

A **rule** is one thing a builder must get right, written as one sentence: one record in the [ledger](../ledger.json). A **layer** is one of fero's six levels, L0 to L5; **D** is `data` 5, the sibling engine that holds the rows. A **slice** is one step of the build, 0 to 8, each ending on something that runs. A **budget** is the most records a layer, a slice or the whole may hold. A tool, the ledger gate, fails any change that passes a budget, and that change then comes to the owner as a card.

Each record also has a **low** and a **high** count. Low is 0 where a named other record may already hold the rule. High is over 1 where the one sentence may hide more than one rule. This card replaces two older guesses of the size with one table, cut from the ledger.

## The picture

The grid as `node tools/grid.mjs` prints it *(counted)*. Rows are layers, columns are slices, a cell is a count of records. The right edge and the "budget" line are the proposed budget. Only those margins are budgeted, never a single cell.

```
fero v5                  S0     S1     S2     S3     S4     S5     S6     S7     S8  | rules  low to high   budget
                     ground    one groups   slot   read served librar   door   past  |
------------------------------------------------------------------------------------------------------------------
L5 libraries              .     11      .      .      8     13     72      4      2  | 110   108 to 126      110
L4 the surface            .     31      2      .     68      4      .      .      2  | 107   106 to 146      107
L3 flow                   .     29      4      3     25     37      .      3     45  | 146   144 to 177      146
L2 fold and ops           .     50      7     11     25      .     12      1      .  | 106   106 to 124      106
========== the line: JavaScript above, Rust below ================================================================
L1 the log                .     87     96     35      .      .      .      .      .  | 218   214 to 256      218
L0 storage and I/O        .     45     22      2      3      .      .     14      .  |  86    86 to 105       86
------------------------------------------------------------------------------------------------------------------
data 5 (sibling)          .      4      1      3     16     24      .      .      5  |  53     53 to 78       53
------------------------------------------------------------------------------------------------------------------
all, records              .    257    132     54    145     78     84     22     54  | 826  817 to 1012      826
all, low                  .    254    130     54    144     77     82     22     54  |
all, high                 .    285    171     64    196    110     94     28     64  |
budget                    0    257    132     54    145     78     84     22     54  | proposed by card 0001; not yet accepted
------------------------------------------------------------------------------------------------------------------
a cell: rule records the slice turns on in the layer.  budget: on the record count, with 5 % of headroom on any line.
fero alone (L0 to L5): 773 records, 764 to 934.   data 5: 53 records, 53 to 78.
known by: model 227 (33 of them on a smaller or older model), seeds 132, spec 63, code 57, measured 25, reasoned only 322 of 826.
unsure grain: 9 records may fold into a named other record (low 0); 168 may hide more than one rule (high over 1).
S0 builds no rule: it proves the Raft port, which carries 77 of the 80 Raft records; S1 turns those on.
proven: 0 of 826.   kept for after the first build: 37 records (spec/later.json).
bars: none judged yet; nothing is built.
```

**Against the two older guesses** *(checked against LAYERS 0.2 and BUILD 3.4, 3.5; neither counts `data` 5, so D is left out of this table)*.

| Layer | Records | Low to high | LAYERS 0.2 | Over its top | | Slice | Records without D | BUILD's spend |
|---|---|---|---|---|---|---|---|---|
| L0 | 86 | 86 to 105 | 78 | +8 | | 0 | 0 | 0 |
| L1 | 218 | 214 to 256 | 193 to 195 | +23 | | 1 | 253 | 160 to 185 |
| L2 | 106 | 106 to 124 | 76 to 81 | +25 | | 2 | 131 | 100 to 120 |
| L3 | 146 | 144 to 177 | 82 to 133 | +13 | | 3 | 51 | 25 to 40 |
| L4 | 107 | 106 to 146 | 12 to 36 | +71 | | 4 | 129 | 90 to 110 |
| L5 | 110 | 108 to 126 | 59 to 69 | +41 | | 5 | 54 | 30 to 50 |
| | | | | | | 6 | 84 | 45 to 55 |
| | | | | | | 7 | 22 | 20 to 25 |
| | | | | | | 8 | 49 | 31 to 55 |
| **L0 to L5** | **773** | **764 to 934** | **500 to 592** | **+181** | | **0 to 8** | **773** | **501 to 640** |
| D | 53 | 53 to 78 | not counted | | | | | |

The ledger's 773 records for fero alone are 133 over BUILD's top guess of 640, and 181 over LAYERS' top of 592.

**Why the ledger is larger** *(the counts are checked; the reading of each cause is reasoned)*.

1. **The surface was never listed: L4, +71.** LAYERS prices L4 as the difference between two study pages, 12 to 36. The ledger writes each promise the API makes as a record.
2. **The libraries' promises: L5, +41.** The lock, queue, saga and `derive` rules that the API page states beyond the base's count are now records.
3. **Items the older sums left out: L0 to L3, +69.** The changes for many groups, V5-15's unpriced items, the links, the WebSocket listener, client tokens, and rules that lived only in prose.
4. **`data` 5 is new in the count:** 53 records. Neither older page counts it.
5. **Going the other way:** 37 base rules wait in [later.json](../later.json), though LAYERS counts them: answer stages, the `none` rung, the tier's uploads, restore, forks and the slow-leader rule.
6. **Unsure grain, on top of the record count.** 168 records have a high over 1. If every one splits, the ledger grows by 186, to 1,012.

**Three things the owner should know before picking.**

- **The low count is no longer a second size.** After a recount, low is 0 on only 9 records, each naming the record it may fold into. Read the record count.
- **One reading sits inside the slice numbers.** A rule the Raft port's code carries is counted in slice 1, with the port. Counted by first use instead, 32 records move from slice 1 to slice 2 (225 and 164). The whole does not change.
- **33 of the 227 model-checked records rest on a smaller or older model**, the slot move's among them. Their full models are owed before their slices.

## Recommended

**A. Budget on the record count, with 5 % of headroom on any line.** Layers: L0 86, L1 218, L2 106, L3 146, L4 107, L5 110, D 53. Slices: 0, 257, 132, 54, 145, 78, 84, 22, 54. The whole: 826, so at most 867.

- **How it binds:** a new record, or a record that splits because its sentence hid two rules, is a counted change. It shows in the weekly digest. Once a layer, a slice or the whole is more than 5 % over its number, the gate fails and a card is written.
- **Why the record count:** it is the one number nobody has to judge, and BUILD 2.4 has the gate count records. The gate also refuses a record whose text is more than one sentence, so the budget cannot be met by packing rules together.
- **Costs:** 0 rules, 0 bars, 0 days. It accepts a first build 21 % larger than BUILD's top guess (773 against 640, without `data`), and up to 46 % larger if every unsure sentence splits. BUILD's sizes in weeks were guessed from the smaller count, so they are likely low too *(reasoned)*.

## Other ways

**B. Budget on the high count, with no headroom: 1,012 for the whole.** It already holds room for every unsure sentence to split: 186 over today's records, 23 %. Costs: 0 rules, 0 bars, 0 days now; the budget does not bind until late, so growth of up to 186 rules reaches no card.

**C. Hold BUILD's 640 for L0 to L5.** At least 133 records must go before slice 0. That needs one round of making the design simpler across layers (BUILD 2.7), and most likely moves whole features to after the first build: slice 8 (49 records) and parts of slices 5 and 6. Costs: at least 133 rules out, some bars restated, 1 to 2 weeks *(a guess)*.

**D. Leave it.** Costs: 0 days; no number is accepted, so every later card that costs rules has nothing fixed to be measured against.

## If no answer

The builder takes A's reversible part only: `budget.json` stays marked "proposed", and the gate holds the ledger to it, so nothing grows unseen. Slice 0 does not start. The builder never takes silence as a yes.

The budget as one line. The gate compares it with `budget.json`, so neither can change alone:

```
budget 0001: layers L0 86 L1 218 L2 106 L3 146 L4 107 L5 110 D 53 | slices S0 0 S1 257 S2 132 S3 54 S4 145 S5 78 S6 84 S7 22 S8 54 | whole 826 | headroom 5 %
```
