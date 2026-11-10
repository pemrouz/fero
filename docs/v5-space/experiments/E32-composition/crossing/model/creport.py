#!/usr/bin/env python3
"""
creport.py: the tables in results/, from the checkpoints only.

    python3 model/creport.py design DESIGN.json            > results/design.md
    python3 model/creport.py ablation ADDED.json UNION.json > results/ablation.md
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('PYTHONHASHSEED', '0')

from cbounds import BOUNDS                           # noqa: E402
from crossing import Crossing, ADDED                 # noqa: E402
from dsl import rules                                # noqa: E402

G = {0: 'A', 1: 'B'}


def what(b):
    parts = []
    parts.append(', '.join(a[0] for a in b['attempts']) or 'no write')
    kinds = ' or '.join({'lose': 'loses its disk', 'crash': 'crashes'}[k] for k in b['kinds'])
    parts.append(f"member {' or '.join(map(str, b['fail']))} {kinds}"
                 + (' (never back)' if b.get('never') else ' (may come back)'))
    parts.append('heals: ' + (', '.join(G[g] for g in sorted(b['heal'])) or 'nobody'))
    parts.append(f"{b['drops']} drop at " + ' or '.join(G[g] for g in b['dropg']))
    extra = []
    if len(b['layouts']) > 2:
        extra.append('moves to B and back')
    if b.get('reader'):
        extra.append('a reader')
    if b.get('giveup'):
        extra.append('B may give up')
    if b.get('serial'):
        extra.append('one write at a time')
    if b.get('derived'):
        extra.append('derived outputs')
    if extra:
        parts.append(', '.join(extra))
    return '; '.join(parts)


def design(path):
    d = json.load(open(path))
    print('| Bound | What it holds | States | Steps | Judged for liveness | Seconds | Explored | Result |')
    print('|---|---|---|---|---|---|---|---|')
    for n, x in d.items():
        res = 'every property holds' if not x['fail'] else 'FAILS ' + ', '.join(
            f'{p} ({v[0]} steps)' for p, v in sorted(x['fail'].items()))
        if not x['complete']:
            res = 'no counterexample (safety only; liveness not judged)' if not x['fail'] else res
        full = 'in full' if x['complete'] else 'PARTIAL: stopped at the state limit'
        cap = f"; log cap hit in {x['capped']:,} states" if x.get('capped') else ''
        print(f"| `{n}` | {what(BOUNDS[n])} | {x['states']:,} | {x['edges']:,} | "
              f"{x['judged']:,} | {x['secs']:.0f} | {full} | {res}{cap} |")


def ff(x):
    if not x:
        return ''
    return f'{x[1]} on `{x[0]}` in {x[2]} steps'


def ablation(added_path, union_path):
    rl = {r.id: r for r in rules(Crossing(BOUNDS['src']).actions())}
    a = json.load(open(added_path))['result']
    print('## The rules added at the crossing (every other rule kept)\n')
    print(f"Bounds: {', '.join('`' + b + '`' for b in a['sweep'])}.\n")
    print('| Rule | What it says | Dropped alone | In the smallest set | Kept because |')
    print('|---|---|---|---|---|')
    for r in a['rules']:
        note = rl[r['id']].note
        alone = ff(r['alone']) or 'nothing breaks'
        kept = '**needed**' if r['kept'] else 'dropped'
        print(f"| `{r['id']}` | {note} | {alone} | {kept} | {ff(r.get('final'))} |")
    print(f"\nNeeded: {sum(1 for r in a['rules'] if r['kept'])} of {len(a['rules'])}. "
          f"Greedy order (model text): " + '; '.join(f'`{i}` {w}' for i, w in a['greedy']) + '\n')
    if not union_path or not os.path.exists(union_path):
        return
    u = json.load(open(union_path)).get('result')
    if not u:
        return
    print('## The smallest composed model\n')
    print(f"Start: the smallest sets of the single experiments. E-17's one-decider move dropped "
          f"{len(u['e17_dropped'])} of its rules that this model has, E-16's `self` dropped {len(u['e16_dropped'])}, "
          f"and the stage above dropped {len(u['added_dropped'])} added rules: {u['start_kept']} rules kept.\n")
    if u.get('put_back'):
        print('Rules the crossing made necessary (spare in their own experiment, put back here):\n')
        print('| Rule | From | Without it | Steps | Other single rules that also remove this counterexample |')
        print('|---|---|---|---|---|')
        for p in u['put_back']:
            src = 'E-17' if p['rule'] in u['e17_dropped'] else 'E-16' if p['rule'] in u['e16_dropped'] else 'added'
            print(f"| `{p['rule']}` | {src} | {p['breaks']} on `{p['bound']}` | {p['steps']} | "
                  f"{', '.join('`' + x + '`' for x in p['also_fix']) or 'none'} |")
        print()
    else:
        print('No bound fails: no rule that was spare alone is needed at the crossing.\n')
    if u.get('error'):
        print('ERROR: ' + u['error'] + '\n')
        return
    if u.get('final_dropped'):
        print('Dropped in the final pass (a rule its own experiment kept, not needed here): '
              + ', '.join(f'`{i}`' for i, _ in u['final_dropped']) + '\n')
    kept = [r for r in u['rules'] if r['kept']]
    print(f"**{len(kept)} rules** in the smallest composed model ({len(u['rules'])} written). Each breaks a "
          f"property when dropped:\n")
    print('| Rule | Role | New at the crossing | Dropped from the smallest model |')
    print('|---|---|---|---|')
    for r in kept:
        x = rl[r['id']]
        print(f"| `{r['id']}` | {x.role} | {'yes' if r['id'] in ADDED else ''} | {ff(r.get('final'))} |")


if __name__ == '__main__':
    if sys.argv[1] == 'design':
        design(sys.argv[2])
    else:
        ablation(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
