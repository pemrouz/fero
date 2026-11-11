# The candidate reports

One report per judged row of the v5 study ([BRIEF.md](../BRIEF.md)): 28 reports for the 31 judged rows. Words follow VERDICT's [key of terms](../VERDICT.md#key-of-terms).

- **The answer they serve.** [VERDICT.md](../VERDICT.md#0-the-answer) says: aim for COMP2, and build MIN-P+par's shape first, in TypeScript. MIN-P+par is COMP2 without the `memory` rung (a commit held in memory at a majority).
- **VERDICT's frame.** Each verdict first reads the rows as VERDICT does ([VERDICT 8](../VERDICT.md#8-what-the-user-must-confirm)). That is the strict DATA-01 reading, the clauses restated, and no competitor test line accepted as a loss. Each verdict then says what the other readings change.
- **Counts.** "3 / 6 / 277" reads novel mechanisms / SHOULDs met / interacting pairs. These are rule 3's three counts ([VERDICT 1](../VERDICT.md#1-the-question-and-the-rule)).
- **Three rows share a report.** COMP2 V=full is a twin in [COMP2's report](COMP2.md). MIN-P+par V=full and MIN-P+par C=cent V=full are in [MIN-P+par's](MIN-P+par.md).

## The reports

### The winner and its family

- [COMP2](COMP2.md): the design to aim for. On VERDICT's frame it fails no MUST, and no judged row beats it (3 / 6 / 277).
- [MIN-P+par](MIN-P+par.md): the shape to build first, COMP2 without the `memory` rung. It is out on PERF-04, and it wins if that loss is accepted.
- [MIN-P+m](MIN-P+m.md): COMP2 with wipe-and-rejoin in place of peer repair. It is in, but COMP2 beats it by one SHOULD, F-22 (S).
- [COMP+par C=cent V=full](COMP+par-cent.md): COMP2 with a separate controller process. It is in, but COMP2 beats it on pairs, 277 against 282.
- [COMP](COMP.md): the study's composite, where each leader heals its own group. It ranks first of the 20 study rows, but four closure rows beat it, COMP2 among them.
- [MIN-P](MIN-P.md): the base the winner is built on. It is out on PERF-04, and let back in, MIN-P+par and COMP2 beat it by one SHOULD.

### MIN's variants and the separate servers

- [MIN](MIN.md): the study's simplest stack. It is out on PERF-04, and let back in, MIN-P beats it by one pair, 253 against 252.
- [RUST](RUST.md): MIN with a Rust core from the first build. It is out on PERF-04, and let back in, COMP2 and MIN-P+par still beat it.
- [LEAN](LEAN.md): MIN where only the leader and one standby fold. It is out on PERF-04, and it loses even to MIN: the same cells, 2 more pairs.
- [MIN-TS](MIN-TS.md): MIN in TypeScript for good. It is out on PERF-04, and let back in, COMP2 and MIN-P+par still beat it.
- [SIDE](SIDE.md): MIN with a native daemon on each host. It is out on PERF-04, and it has the most pairs of MIN's family, 277.
- [EMB-V8](EMB-V8.md): a Rust server that runs `data` and user code in embedded V8. It is out on PERF-04, and let back in, COMP2 and MIN-P+par still beat it.
- [SRV](SRV.md): MIN as a Rust or Go server binary. It is out on PERF-04, and on the strict reading on DATA-01 too.
- [SRV V=full Y=fwd](SRV-full-fwd.md): SRV with every replica a voter and writes forwarded. It is out as SRV is, with 8 fewer pairs.

### TiKV's shape and the split rows

- [SPLIT](SPLIT.md): groups that split and merge, with no controller. It is in, but COMP2 beats it on SHOULDs; items 5, 11 or 17 would make it the winner.
- [PD](PD.md): TiKV's shape as published. It is out on F-22, SC-05 and PERF-04, and on the strict reading on DATA-01 too.
- [PD+fix](PD+fix.md): TiKV's shape with three fixes. It is out on DATA-01 on the strict reading, and on the loose one TiKV-TS beats it by one SHOULD.
- [TiKV-TS](TiKV-TS.md): the winner on the loose DATA-01 reading, with 0 novel mechanisms. On the strict one it is out on DATA-01, and it leaves 122 MUSTs open.
- [TiKV-persisted](TiKV-persisted.md): TiKV's shape with only the `persisted` rung. It is out on PERF-04 and strict DATA-01, and it wins on the loose reading if the loss is accepted.

### The other study rows

- [DRAFT](DRAFT.md): the design draft of 2026-11-05. It is in, but COMP2 beats it at rule 3's first step, 5 novel mechanisms against 3.
- [ISR](ISR.md): Kafka's shape. It is out on SC-03, SC-04 and SC-10, since a partition count is fixed and nothing merges a group.
- [CELL](CELL.md): 16 fixed cells per resource, re-keyed to grow. It is out on five MUSTs: OPS-01, P-07, SC-03, SC-08 and SC-10.
- [LANE](LANE.md): 64 lanes per project, shared by every resource. It is out on four MUSTs: PERF-04, SC-03, SC-04 and SC-10.
- [SLOG](SLOG.md): the earlier log-first draft. It is out on PERF-04, and let back in, COMP2 beats it on novel mechanisms, 5 against 3.
- [RLOG](RLOG.md): Raft on log members, with servers that write by a writer epoch. It is out on PERF-04, and let back in, COMP2 beats it on SHOULDs.
- [OBJ](OBJ.md): the object store is the log. It is out on 7 MUSTs, since every commit is a conditional PUT.
- [V4](V4.md): fero v4 as built. It is out on 50 MUSTs, since no single writer judges a condition.
- [BUY](BUY.md): fero's upper layers on NATS JetStream, a reference row. It is out on 27 MUSTs, most of them by structure.

## How the reports were made and checked

- **One shape.** Every report has the same ten parts, in the same order:
  - the verdict, then "In short" and "Its line" (its option on each axis);
  - its score, what fails and the proof, and what it does well;
  - what would change its verdict, its twins and neighbours, the evidence, and links.
- **Sources.** The cells and counts come from the judging files:
  - [outcome.json](../judging/outcome.json) and [OUTCOME.md](../judging/OUTCOME.md) for the 20 study rows, with each scorecard in [judging/rows/](../judging/rows);
  - [cards.json](../judging/closure/hybrids/cards.json) for the closure rows;
  - [matrix.md](../judging/closure/results/matrix.md) for the winner under each set of choices.
  - Every other number links to the experiment or file it comes from.
- **Written.** Several writers drafted the reports, each a share of the rows. Their scratch scripts lived in a session folder that nobody can open later.
- **Checked.** A reviewer then checked each report against the files, and reran every computed claim with `tools/closure.py`. Every computed number held. The review still found 17 issues, F1 to F17:
  - wrong figures, and rank wording that did not name its reading;
  - missing items, and long sentences;
  - computed claims with no command.
- **Fixed.** This pass checked each issue against the files again and fixed it. F17 is about [MECHANISMS.md](../MECHANISMS.md) section 2, whose counts predate the re-rulings RM-01 to RM-08. That file is outside the reports, so the two reports that link it now say so.
- **Reproducible.** Every claim marked "computed" now names a command. The commands run the short script below, which only calls the study's own code: `tools/closure.py`'s cell model, tally, pair rule and search.

## Reproduce a computed claim

Run from `docs/v5-space`. First define `repro`:

```sh
repro() { python3 -c "$(awk '/^```python repro$/{f=1;next} /^```$/{f=0} f' candidates/README.md)" "$@"; }
repro rank --strict      # rule 3 among the rows that are in, on VERDICT's frame
```

What each command prints:
- `rank`: every judged row. Restated, it lists the rows that are in, and which rows beat each one by rule 3, pair by pair. With `--worded`, it ranks by rule 2 (MUSTs failed, then the gap sum).
- `tally ROW...`: a row's failed MUSTs, open and met counts, SHOULDs met, and its three rule-3 counts.
- `diff ROW OTHER...`: the cells met for ROW and not met for every OTHER named.
- `differ ROW OTHER`: every cell where two rows differ, and which side each favours.
- `near ROW`: the judged rows with the fewest options different from ROW.
- `one ROW`: every one-option change of ROW that breaks no constraint, and the MUSTs they all fail.
- `row CHANGES BASE`: a judged row changed on some axes, as `tools/closure.py row` does, but from any of the 31 rows. It lists the guessed cells too.
- Flags:
  - `--worded`: the requirements as worded (the default is restated);
  - `--strict`: the strict DATA-01 reading;
  - `--loss`: JetStream's default test line accepted as a loss;
  - `--twenty`: the 20 study rows only;
  - `--shoulds-first`: rule 3 with SHOULDs first (VERDICT 8, item 3);
  - `--choice NAME`: another user choice, such as `'shared tier'` or `other`.
- Quote a row name with spaces: `repro diff 'COMP+par C=cent V=full' TiKV-TS`.

```python repro
# The reports' computed claims, reproduced. Run from docs/v5-space; it only calls tools/closure.py.
import sys
sys.path.insert(0, 'tools')
import closure as C

M = C.Model()
ROWS = C.all_rows()                      # the 31 judged rows: the 20 study rows, then the 11 closure rows
STUDY = list(C.axes()['rows'])           # the 20 study rows
AX = M.ax['axes']
a = sys.argv[1:]
cmd = a.pop(0) if a else 'help'
flag = lambda f: f in a and not a.remove(f)
def opt(f):
    out = []
    while f in a:
        i = a.index(f); out.append(a[i + 1]); del a[i:i + 2]
    return out
worded, strict, loss, twenty, sfirst = flag('--worded'), flag('--strict'), flag('--loss'), flag('--twenty'), flag('--shoulds-first')
choice = tuple(opt('--choice')) + (('DATA-01 reading',) if strict else ()) + (('PERF-01 losses',) if loss else ())
scen = 'worded' if worded else 'restated'

def cells(nm):                           # a judged row's settled cells (its overrides applied)
    return M.cells(ROWS[nm], row=nm, with_support=False)
def tally(nm):
    t = C.tally1(cells(nm), scen, choice)
    s = M.score(ROWS[nm], nm)
    return t, (s['novel'], len(t['s_met']), s['pairs'])
def beats(x, y):                         # rule 3, one pair: does x beat y? (novel, SHOULDs, pairs)
    if sfirst and x[1] != y[1]: return x[1] > y[1]   # item 3 the other way: SHOULDs first
    if y[0] - x[0] >= 2: return True
    if x[0] - y[0] >= 2: return False
    return x[1] > y[1] or (x[1] == y[1] and x[2] < y[2])
def verdicts(nm):                        # (req, part) -> the cell's verdict in this frame
    out = {}
    for c in cells(nm):
        v = c['v']
        if scen == 'restated' and c.get('depends_on') == 'restated': v = c['alt']
        if c.get('depends_on') in choice: v = c['alt']
        out[(c['req'], c['part'])] = v
    return out

if cmd == 'rank':                        # rule 2 as worded; rule 3 pair by pair restated
    rows = STUDY if twenty else list(ROWS)
    T = {nm: tally(nm) for nm in rows}
    if worded:
        key = lambda nm: (len(T[nm][0]['fails']), round(T[nm][0]['gap'], 2))
        for nm in sorted(rows, key=key):
            better = sum(key(o) < key(nm) for o in rows)
            print('%-26s place %2d of %d  fails %d, gap %.2f: %s' % (nm, better + 1, len(rows), *key(nm), ', '.join(T[nm][0]['fails'])))
    else:
        inn = [nm for nm in rows if not T[nm][0]['fails']]
        print('%d of %d rows in' % (len(inn), len(rows)))
        BY = {nm: sorted(o for o in inn if o != nm and beats(T[o][1], T[nm][1])) for nm in inn}
        for nm in sorted(inn, key=lambda n: (len(BY[n]), T[n][1][0], -T[n][1][1], T[n][1][2])):
            by = BY[nm]
            print('%-26s place %2d  %d / %d / %d, %d open MUSTs; beaten by %d: %s' % (nm, len(by) + 1, *T[nm][1], T[nm][0]['open'], len(by), ', '.join(by)))
        for nm in rows:
            if nm not in inn: print('%-26s out: %s' % (nm, ', '.join(T[nm][0]['fails'])))
elif cmd == 'tally':
    for nm in a:
        t, s = tally(nm)
        print('%s, %s: fails %s; open %d, met %d MUSTs; SHOULDs met %s; %d / %d / %d' % (nm, scen, t['fails'], t['open'], t['met'], t['s_met'], *s))
elif cmd == 'diff':                      # cells met for the first row and not met for every other row named
    one, others = a[0], a[1:]
    V = {nm: verdicts(nm) for nm in [one] + others}
    got = [k for k, v in V[one].items() if v == 'met' and all(V[o][k] != 'met' for o in others)]
    print('%d cells (%d MUST, %d SHOULD) met for %s and not met for %s' % (len(got), sum(k[1] == 'M' for k in got), sum(k[1] == 'S' for k in got), one, ', '.join(others)))
    for k in got: print('  %s %s: %s' % (k[0], k[1], ', '.join('%s %s' % (o, V[o][k]) for o in others)))
elif cmd == 'differ':                    # every cell where two rows differ
    x, y = verdicts(a[0]), verdicts(a[1])
    got = [k for k in x if x[k] != y[k]]
    rk = {'fails': 0, 'not': 1, 'open': 2, 'met': 3}
    print('%d cells differ between %s and %s: %d better for %s, %d better for %s' % (len(got), a[0], a[1],
          sum(rk[x[k]] > rk[y[k]] for k in got), a[0], sum(rk[y[k]] > rk[x[k]] for k in got), a[1]))
    for k in got: print('  %s %s: %s %s, %s %s' % (k[0], k[1], a[0], x[k], a[1], y[k]))
elif cmd == 'near':                      # the judged rows closest in options
    nm = a[0]
    d = sorted((sum(ROWS[nm][x] != ROWS[o][x] for x in AX), o) for o in ROWS if o != nm)
    print('%s: nearest judged rows by options that differ: %s' % (nm, '; '.join('%s %d' % (o, n) for n, o in d[:6])))
elif cmd == 'one':                       # every one-option change that breaks no constraint
    nm = a[0]
    S = C.Search(scen, choice)
    res = [r for r in (S.evaluate(v, '') for v in S.neighbours(ROWS[nm], 1) if v != ROWS[nm]) if r]
    print('%d one-option changes of %s; fewest MUSTs failed: %d; changes that fail none: %d' % (len(res), nm,
          min(len(r['fails'] + r['unsupported_fails']) for r in res), sum(not r['fails'] and not r['unsupported_fails'] for r in res)))
    always = set.intersection(*(set(r['fails'] + r['unsupported_fails']) for r in res))
    print('failed by every one of them: %s' % ', '.join(sorted(always)))
elif cmd == 'row':                       # a judged row changed on some axes; cells predicted from the judged rows
    vec = dict(ROWS[a[1]])
    for kv in filter(None, a[0].split(',')):
        k, v = kv.split('='); vec[k.strip()] = v.strip()
    cs = M.cells(vec)
    t = C.tally1(cs, scen, choice)
    s = M.score(vec)
    print('%s: fails %s; open %d MUSTs; %d / %d / %d; guessed cells: %s' % (scen, t['fails'], t['open'], s['novel'], len(t['s_met']), s['pairs'],
          [c['req'] + ' ' + c['part'] for c in cs if not c['support']]))
else:
    print('rank | tally ROW... | diff ROW OTHER... | differ ROW OTHER | near ROW | one ROW | row CHANGES BASE')
    print('flags: --worded --strict --loss --twenty --shoulds-first --choice NAME')
```
