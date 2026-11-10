#!/usr/bin/env python3
"""table.py: results/tables.md from results/runs.json (steps 1 and 3),
results/bugs.json (step 2) and results/r19.json (step 4)."""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(HERE, 'results')


def load(n):
    p = os.path.join(R, n)
    return json.load(open(p)) if os.path.exists(p) else {}


def fmt(x):
    return '{:,}'.format(x) if isinstance(x, int) else ('' if x is None else str(x))


def main():
    out = ['# E-14c tables (made by tools/table.py)', '']
    runs = load('runs.json')
    out += ['## Runs (steps 1 and 3)', '',
            '| run | scenario | settings | invariants | segments | wall s | distinct | depth | finished | violated | '
            'AG EF | stuck with a live majority (judged) | plan |',
            '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for n in sorted(runs):
        r = runs[n]
        a = r.get('agef') or {}
        kw = ', '.join('%s=%s' % (k, v) for k, v in sorted(r['kw'].items())
                       if k not in ('AllowDrop', 'AllowStepDown', 'LeaderLease'))
        inv = 'new' if 'VoteQuorumInv' in r.get('invs', []) else 'shipped'
        out.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, r['scen'], kw, inv, r.get('segments'), fmt(r.get('secs')), fmt(r.get('distinct')), fmt(r.get('depth')),
            'yes' if r.get('complete') else 'no', r.get('violated') or '', a.get('result', ''),
            ('%s (%s)' % (fmt(a.get('stuck_live')), fmt(a.get('judged')))) if a else '', a.get('plan_result', '')))
    r19 = load('r19.json')
    if r19:
        out += ['', '## r19 (step 4)', '', 'rule: `%s`; mutant: `%s`' % (r19.get('rule'), r19.get('mutant_line')), '',
                '| run | distinct | finished | violated | judged at term | AG EF | stuck with a live majority (judged) | plan |',
                '|---|---|---|---|---|---|---|---|']
        for n in sorted(k for k in r19 if isinstance(r19[k], dict)):
            r = r19[n]
            out.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (
                n, fmt(r.get('distinct')), 'yes' if r.get('complete') else 'no', r.get('violated') or '',
                r.get('agef_judge'), r.get('agef_result'),
                '%s (%s)' % (fmt(r.get('agef_stuck_live')), fmt(r.get('agef_judged'))), r.get('agef_plan_result')))
    b = os.path.join(R, 'bugs.md')
    if os.path.exists(b):
        out += ['', '## Bugs (step 2)', ''] + open(b).read().splitlines()[2:]
    open(os.path.join(R, 'tables.md'), 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
