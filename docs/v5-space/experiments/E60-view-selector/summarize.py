#!/usr/bin/env python3
"""
summarize.py: E-60's tables beside E-16's report.py.

    python3 summarize.py ablation results/view-ablation.json results/resume-ablation.json
    python3 summarize.py sim results/resume-sim.jsonl      (or - for stdin)

`ablation`: each rule dropped alone from the full design (sweep, then verify
bounds), where each rule is already counted (the model's KIN), the rules the
smallest model keeps by that count, and the planted bugs.
`sim`: the resume harness's lines as tables.
"""
import importlib.util
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))


def kin_of(model):
    path = os.path.join(HERE, 'models', model + '.py')
    sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
    spec = importlib.util.spec_from_file_location('k_' + model, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.KIN


def ff(x):
    if not x:
        return 'holds'
    b, p, d, _ = x
    return 'undecided (state limit)' if p == 'LIMIT' else f'{p} on {b} ({d} steps)'


def ablation(paths):
    for path in paths:
        o = json.load(open(path))
        model = os.path.basename(path).split('-')[0]
        kin = kin_of(model)
        rows = [r for r in o['rules'] if not r.get('pinned')]
        print(f'## {model}: each rule alone, and where it is already counted\n')
        alone = [r for r in rows if r.get('alone_all')]
        print(f'Rules written: {len(rows)} (and {len(o["rules"]) - len(rows)} pinned). '
              f'Needed alone in the full design (dropping it alone breaks a property on a sweep '
              f'bound, or stops at the state limit there): **{len(alone)}**. Kept in the smallest model (DEV-10): '
              f'**{sum(1 for r in rows if r["kept"])}**.\n')
        for title, sel in (('kept in the smallest model', lambda r: r['kept']),
                           ('needed alone in the full design', lambda r: r.get('alone_all'))):
            c = Counter(kin[r['id']] for r in rows if sel(r))
            print(f'- {title}, by where each is already counted: ' +
                  ', '.join(f'{k} {c[k]}' for k in ('e31', 'read', 'tf', 'new') if c[k]) + '.')
        print('\n| rule | counted in | in the smallest model | dropped alone from the full design |')
        print('|---|---|---|---|')
        for r in rows:
            print(f'| `{r["id"]}` | {kin[r["id"]]} | {"kept" if r["kept"] else "dropped"} | {ff(r.get("alone_all"))} |')
        pl = o.get('planted') or []
        if pl:
            print(f'\n**Planted bugs:** {sum(1 for p in pl if p["caught"])} of {len(pl)} caught.\n')
            print('| planted bug | result |')
            print('|---|---|')
            for p in pl:
                print(f'| `{p["option"]}` | {ff(p["caught"]) if p["caught"] else "SURVIVED"} |')
        print()


def sim(path):
    lines = [json.loads(x) for x in (sys.stdin if path == '-' else open(path)) if x.strip()]
    print('| planted bug | seeds | resumes | wrong resumes | seeds with a wrong resume | new pictures |')
    print('|---|---|---|---|---|---|')
    for s in lines:
        print(f'| {s["plant"] or "none (the design)"} | {s["seeds"]:,} | {s["resumes"]:,} | {s["wrong"]:,} | '
              f'{s["seeds_wrong"]:,} | {s["pictures"]:,} |')
    base = [s for s in lines if not s['plant']]
    if not base:
        return
    print('\nThe design: bytes sent by a resume against a new picture (median over the resumes in each '
          'cell; 100 B rows, 24 B tombstones). "window" is how many positions of tombstones a copy keeps.\n')
    print('| rows | window | writes missed | resumes | past the window (a picture) | folded bigger than a picture | '
          'median bytes | median picture bytes | median share | largest share | median share, the smaller sent |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for c in base[0]['cells']:
        w = 'for ever' if c['window'] is None else f'{c["window"]:,}'
        print(f'| {c["rows"]:,} | {w} | {c["gap"] if c["gap"] == "near" else format(c["gap"], ",")} | {c["n"]:,} | {c["pictures"]:,} | {c["bigger"]:,} | '
              f'{c["median_bytes"]:,.0f} | {c["median_pic_bytes"]:,.0f} | {100 * c["median_share"]:.2f} % | '
              f'{100 * c["max_share"]:.1f} % | {100 * c["median_share_min"]:.2f} % |')


if __name__ == '__main__':
    if sys.argv[1] == 'ablation':
        ablation(sys.argv[2:])
    else:
        sim(sys.argv[2])
