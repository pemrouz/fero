# The closure pass

**The question.** Is any row built from the judged rows' own options better, by the judging rule, than the answer VERDICT.md names?

**Why it is asked.** The 20 judged rows are 20 points in a space of 22 axes ([SPACE.md](../../SPACE.md) section 2). The VERDICT review (2026-11-10, [VERDICT.review.json](../VERDICT.review.json)) priced six rows between those points by hand: COMP2, COMP+par, MIN-P+m, MIN-P+par, SPLIT2 and PD+fix. Two of them ranked above the named answer. So a hand search is not enough: the next reader can always try one more mix. This pass lets code search every mix near the judged rows, so every reader gets the same answer from the same files.

**The method, in four steps.**
1. **Rows as options.** [axes.json](axes.json) writes each judged row as one option per axis, as AMENDMENTS sections 3 and 4 amend them. Where a SPACE footnote changes what a tag means for one row, the tag carries the footnote in brackets, so two rows share a tag only when they share the option.
2. **Cells as options.** For every requirement part, [attrib/](attrib) names the axes that decide its cell and gives the verdict for each option, read from the judges' own reasons. A part's rules must reproduce all 20 settled cells (verdict, the alternative verdict, what it depends on, and the gap of a failure). Where a cell follows something no axis tag expresses, it is an **override**: that judged row keeps its own cell, and no other row may borrow it.
3. **Mechanisms and constraints as options.** [mechanisms.json](mechanisms.json) gives each mechanism of [../mechanisms.json](../mechanisms.json) the options that carry it, and must reproduce which rows carry it. [constraints.json](constraints.json) lists the options that force or forbid others (SPACE section 5), and every judged row must satisfy them.
4. **Search.** `python3 tools/closure.py search` builds every row within a few axis changes of a judged row, drops those that break a constraint, predicts each one's cells, mechanisms and pairs, and ranks the rows that are in by rule 3. Each predicted cell says which judged rows **support** it: those that share its tags on every deciding axis. A cell no judged row supports is an extrapolation, and a row that wins on extrapolated cells goes to blind judges before it can be named.

**What the code does not do.** It never edits a settled file. Re-rulings are separate files ([rerulings.cells.json](rerulings.cells.json), [rerulings.mech.json](rerulings.mech.json)) that a referee writes and the code applies on top. The attribution is a search aid, not a judgement: the winner it finds is judged by two blind judges and a referee like every other row.

## File formats

`attrib/<GROUP>.json`:

```json
{"group": "SC", "by": "...", "parts": [
  {"req": "SC-03", "part": "M",
   "rules": [
     {"when": {"P": ["slot", "slot+rule"], "G": ["shard", "pslot"]},
      "v": "fails", "depends_on": "restated", "alt": "open", "gap": 0.66,
      "basis": "E-18: slot rows stop at ... (the judges' reason, short)"}
   ],
   "else": {"v": "open", "basis": "..."},
   "overrides": {"ISR": {"v": "fails", "gap": 1.2, "basis": "why no axis tag expresses this"}},
   "why": "optional: how the axes were chosen"}
]}
```

Rules are tried in order; the first whose `when` matches gives the cell (every named axis must hold one of the listed tags). `else` is the fallback. `v` is `met`, `open` or `fails` for a MUST, `met`, `not` or `open` for a SHOULD. `depends_on` and `alt` are copied from the settled cell; `gap` is given when `v` or `alt` is `fails`.

`mechanisms.json`: `{"mechanisms": [{"key": "raft-log", "when": [{"R": ["raft", "rlog"]}, {"R": ["isr", "slog"]}], "basis": "..."}]}`. `when` is a list of alternatives; a row carries the mechanism when any alternative matches.

`constraints.json`: `{"constraints": [{"id": "Q-isr", "if": {"Q": ["isr"]}, "then": {"R": ["isr"]}, "source": "SPACE 2 Q: needs R isr"}]}`. A row that matches `if` must match `then`.

## Commands

```sh
python3 tools/closure.py check SC        # one group's attribution against its 300 settled cells
python3 tools/closure.py check-all       # every group, the mechanisms and the constraints
python3 tools/closure.py row 'C=cent-co,Z=par'   # one row: unnamed axes are COMP's
python3 tools/closure.py search --depth 2        # every row within 2 axis changes of a judged row
```
