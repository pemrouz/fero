#!/usr/bin/env python3
"""report.py: E-21's summary from results/<option>-ablation.json.

    python3 sim/report.py results/*-ablation.json > results/summary.md
"""
import json
import os
import sys
from collections import Counter

ORDER = ['wall', 'clamp', 'median', 'median1', 'median+g', 'hlc', 'mono', 'mono+ck', 'tt']
CHECKS = ('early_wt', 'early', 'late', 'lease', 'stuck', 'back', 'agree', 'stale', 'avail')


def main():
    res = {}
    for p in sys.argv[1:]:
        o = json.load(open(p))
        res[o['option']] = o
    tags = [t for t in ORDER if t in res]
    print('# E-21 summary\n')
    any_o = res[tags[0]]
    print(f'Seeded runs: {any_o["seeds_per_family"]} seeds in each of {len(any_o["families"])} families '
          f'({", ".join(any_o["families"])}), 3 or 5 nodes, three minutes of real time each. A rule is needed '
          '(DEV-10) when dropping it makes some seed break a check. `stamp.read` (the clock reading) is the world.\n')
    print('## The design runs (counts over every seed)\n')
    print('| option | ' + ' | '.join(CHECKS) + ' | overlap (sent by a non-holder) | worst late (ms) | worst early (ms) |')
    print('|---|' + '---|' * (len(CHECKS) + 3))
    for t in tags:
        b = res[t]['base']
        print(f'| {t} | ' + ' | '.join(str(b[c]) for c in CHECKS) +
              f' | {b["overlap"]} | {b["late_max"]:.0f} | {b["early_max"]:.0f} |')
    print('\n## Rules (DEV-10)\n')
    print('| option | holds as designed | rules needed | of written | by role | mutants caught / not "no change" |')
    print('|---|---|---|---|---|---|')
    for t in tags:
        o = res[t]
        kept = o.get('kept', {})
        roles = Counter(r['role'] for r in o['rules'] if r['id'] in kept and (kept[r['id']] or o.get('fails_as_designed')))
        need = [i for i, v in kept.items() if v]
        ms = o.get('mutants', [])
        c = sum(1 for m in ms if m['caught'])
        nc = sum(1 for m in ms if not m['caught'] and m.get('no_change'))
        holds = 'yes' if not o.get('fails_as_designed') else f'no: {o["fails_as_designed"]}'
        print(f'| {t} | {holds} | **{len(need)}** | {len(o["rules"])} | ' +
              ', '.join(f'{k} {v}' for k, v in sorted(roles.items())) + f' | {c} / {len(ms) - nc} |')
    for t in tags:
        o = res[t]
        print(f'\n### {t}\n')
        if o.get('fails_as_designed'):
            print(f'Fails as designed: first failure {o["fails_as_designed"]} (family, seed, checks).\n')
        print('| rule | role | dropped alone breaks (family, seed, checks) | needed in the smallest set |')
        print('|---|---|---|---|')
        for r in o['rules']:
            k = o.get('kept', {})
            need = (r['id'] in k and k[r['id']]) if not o.get('fails_as_designed') else '-'
            print(f'| `{r["id"]}` | {r["role"]} | {o["pass1"].get(r["id"]) or "nothing"} | '
                  f'{need if need != "-" else "-"} |')
        if o.get('removed'):
            print('\nDropped by the ablation: ' + ', '.join(f'`{x}`' for x in o['removed']) + '.')
        ms = o.get('mutants', [])
        if ms:
            print('\n| mutant | kind | result |')
            print('|---|---|---|')
            for m in ms:
                res_ = m['caught'] if m['caught'] else ('no change' if m.get('no_change') else 'SURVIVED')
                print(f'| `{m["rule"]}` | {m["kind"]} | {res_} |')


if __name__ == '__main__':
    main()
