#!/usr/bin/env python3
"""
report.py: E-61's summary from its result files.

    python3 harness/report.py > results/summary.md

Reads results/design.txt (the design on every bound), results/design-ablation.json (DEV-10 on the
design), results/variants.jsonl (each structural removal on every bound), results/walks.jsonl (the
seeded runs) and results/b5-ablation.json (E-57 B5's full ablation), whichever exist.
"""
import importlib.util
import json
import os
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, '..', 'results')
_spec = importlib.util.spec_from_file_location('e16report', os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine',
                                                                         'report.py'))
e16 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(e16)

WHAT = OrderedDict([
    ('mark-apart', 'the mark in its own entry, after the output'),
    ('mark-first', 'the mark in its own entry, before the output'),
    ('key-slot', 'marks per source slot only (no reader name)'),
    ('key-name', 'marks per reader name only (no source slot)'),
    ('no-wnum', 'the mark without the write\'s number'),
    ('nondet', 'app code: another call order on a re-run'),
    ('unpaced', 'a marked write refused `backpressure`, the loop goes on'),
    ('marks-tail', 'the loop reads marks() (or the cursor) with the uncommitted tail'),
    ('marks-marked', 'marks(): the lowest mark over only the slots that hold one'),
    ('judge-com', 'the leader checks the mark against committed entries only'),
    ('skip-ahead', 'on `expired`, jump to the earliest kept record'),
    ('no-bare', 'derive() sends no bare marks'),
    ('fenced-mark', 'a `fenced` refusal raises the mark too (the first design)'),
    ('stop-refuse', 'the loop ends on a refusal and is restarted (an alternative)'),
    ('start-fresh', 'run(): E-22\'s fresh cursor read (an alternative)'),
    ('resend-any', 'the first model\'s path: any order on the wire, a gap eaten, resends in the session'),
])


def path(n):
    return os.path.join(R, n)


def jsonl(n):
    p = path(n)
    return [json.loads(x) for x in open(p)] if os.path.exists(p) else []


def variants():
    rows = jsonl('variants.jsonl')
    if not rows:
        return
    print('## Each structural rule removed (results/variants.jsonl)\n')
    print('Breadth first on every bound, so each trace is a shortest one. A cell lists the bounds that break, '
          'with the property and the steps of its shortest trace.\n')
    print('| removal | what changes | breaks |')
    print('|---|---|---|')
    by = OrderedDict()
    for r in rows:
        k = (r['option'], tuple(r['drop']))
        by.setdefault(k, [])
        if 'broke' in r:
            by[k].append(f"{r['bound']} {r['broke']} {r['steps']}")
        elif not r['complete']:
            by[k].append(f"{r['bound']} stopped at the state limit")
    for (o, drop), cells in by.items():
        name = f'`{o}`' + (' with ' + ', '.join(f'`{d}` dropped' for d in drop) if drop else '')
        print(f"| {name} | {WHAT.get(o, '')} | {'; '.join(cells) or 'holds on every bound'} |")
    print()


def walks():
    rows = jsonl('walks.jsonl')
    if not rows:
        return
    print('## Seeded runs (results/walks.jsonl)\n')
    print('Each world has every fault at once (models/marks.py WALKS). A cell: seeds with a break, of the '
          'seeds run, and the properties broken (seeds each).\n')
    worlds = []
    for r in rows:
        if r['bound'] not in worlds:
            worlds.append(r['bound'])
    keys = []
    for r in rows:
        k = r['option'] + ''.join(f' -{d}' for d in r['drop'])
        if k not in keys:
            keys.append(k)
    cell = {}
    for r in rows:
        k = r['option'] + ''.join(f' -{d}' for d in r['drop'])
        br = ', '.join(f'{p} {n}' for p, n in sorted(r['broke'].items()))
        cell[(k, r['bound'])] = f"{r['seeds_with_a_break']} of {r['seeds']}" + (f' ({br})' if br else '')
    print('| option or rule dropped | ' + ' | '.join(worlds) + ' |')
    print('|---|' + '---|' * len(worlds))
    for k in keys:
        print(f'| `{k}` | ' + ' | '.join(cell.get((k, w), '') for w in worlds) + ' |')
    print()
    d = [r for r in rows if r['option'] == 'design' and not r['drop']]
    if d:
        print('What the design\'s runs went through (sums over the seeds):\n')
        cols = [('finished', lambda r: r['ends'].get('finished', 0)),
                ('stopped `expired`', lambda r: r['ends'].get('stopped-expired', 0)),
                ('DONE not asked', lambda r: r['ends'].get('not-asked', 0)),
                ('loop starts', lambda r: r['events'].get('start', 0)),
                ('loops ended by a failed write', lambda r: r['events'].get('loop-ended', 0)),
                ('lost tails (with an output)', lambda r: f"{r['lost_tails']} ({r['events'].get('lost-tail-with-an-output', 0)})"),
                ('takeovers (old owner running)', lambda r: f"{r['events'].get('takeover', 0)} ({r['events'].get('takeover-old-running', 0)})"),
                ('slot moves opened', lambda r: r['events'].get('open', 0)),
                ('refused on the row', lambda r: r['events'].get('refuse', 0)),
                ('refused `fenced`', lambda r: r['events'].get('fenced', 0)),
                ('writes held in fn', lambda r: r['events'].get('emit', 0)),
                ('cuts', lambda r: r['events'].get('cut', 0)),
                ('skips at the mark', lambda r: r['events'].get('skip', 0))]
        print('| world | seeds | ' + ' | '.join(c for c, _ in cols) + ' |')
        print('|---|---|' + '---|' * len(cols))
        for r in d:
            print(f"| {r['bound']} | {r['seeds']} | " + ' | '.join(str(f(r)) for _, f in cols) + ' |')
        print()


def mutants():
    rows = jsonl('mutants.jsonl')
    if not rows:
        return
    print('## Build-bug mutants (results/mutants.jsonl)\n')
    print('Each runs on the bounds in order, cheap first, until one breaks (breadth first, so a shortest trace).\n')
    print('| mutant | the bug | first caught |')
    print('|---|---|---|')
    by = OrderedDict()
    for r in rows:
        by.setdefault(r['mutant'], []).append(r)
    caught = 0
    for n, rs in by.items():
        hit = next((r for r in rs if 'broke' in r), None)
        caught += 1 if hit else 0
        stopped = [r['bound'] for r in rs if not r['complete'] and 'broke' not in r]
        cell = f"{hit['first']} on {hit['bound']}, {hit['steps']} steps" if hit else \
            'survives every bound' + (f" (stopped at the state limit on {', '.join(stopped)})" if stopped else '')
        print(f"| {n} | {rs[0]['what']} | {cell} |")
    print(f'\n**{caught} of {len(by)} caught.**\n')


def reach():
    rows = jsonl('reach.jsonl')
    if not rows:
        return
    print('## What each bound reaches (results/reach.jsonl)\n')
    keys = [k for k in rows[0] if k not in ('bound',)]
    print('| bound | ' + ' | '.join(k.replace('_', ' ') for k in keys) + ' |')
    print('|---|' + '---|' * len(keys))
    for r in rows:
        print(f"| {r['bound']} | " + ' | '.join(str(r[k]) for k in keys) + ' |')
    print()


def main():
    print('# E-61 summary\n')
    print('Generated by `harness/report.py` from `results/`. The design table is in results/design.txt; the '
          'README reads these files.\n')
    p = path('design-ablation.json')
    if os.path.exists(p):
        o = json.load(open(p))
        kept = [r for r in o.get('rules', []) if r['kept'] and not r.get('pinned')]
        ms = o.get('mutants', [])
        c = sum(1 for m in ms if m['caught'])
        eq = sum(1 for m in ms if not m['caught'] and m.get('equivalent'))
        dr = [m for m in ms if m['kind'] == 'drop']
        ot = [m for m in ms if m['kind'] != 'drop']
        oeq = sum(1 for m in ot if not m['caught'] and m.get('equivalent'))
        print(f"**DEV-10 on the design:** {len(kept)} rules needed of "
              f"{len([r for r in o['rules'] if not r.get('pinned')])} written; by role: " +
              ', '.join(f'{k} {v}' for k, v in sorted(Counter(r['role'] for r in kept).items())) +
              f"; engine mutants caught {c} of {len(ms) - eq} non-equivalent ({eq} equivalent). Of them, "
              f"{len(dr)} drop a rule the final pass kept (caught by construction: {sum(1 for m in dr if m['caught'])}); "
              f"the {len(ot)} flips and swaps: caught {sum(1 for m in ot if m['caught'])} of {len(ot) - oeq} "
              f"non-equivalent ({oeq} equivalent).\n")
    reach()
    variants()
    mutants()
    walks()
    if os.path.exists(p):
        e16.one(p)
    p = path('b5-ablation.json')
    if os.path.exists(p):
        print('# E-57 B5\'s full ablation (owed by E-57; its model run as it is, read only)\n')
        e16.one(p)


if __name__ == '__main__':
    main()
