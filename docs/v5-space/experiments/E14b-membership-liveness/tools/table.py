#!/usr/bin/env python3
"""table.py: the README's tables, built from results/runs.json.

  python3 tools/table.py            # writes results/tables.md and prints it
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import live as L  # noqa: E402

RED = ('EagerReady', 'BatchVote', 'DeadView', 'EagerNet')
TAG = {'EagerReady': 'R1', 'BatchVote': 'R2', 'DeadView': 'R3', 'EagerNet': 'R4'}


def reds(kw):
    k = dict(L.BASE)
    k.update(kw)
    on = [TAG[r] for r in RED if k[r]]
    return '+'.join(on) if on else 'none'


def rule(kw):
    k = dict(L.BASE)
    k.update(kw)
    if k['OnAppend']:
        return 'on append'
    if not k['R6']:
        return 'on commit, learners refuse votes'
    if k.get('GhostReturn'):
        return 'on commit, lost disk returns under its old id'
    return 'on commit'


def bounds(r, kw):
    k = dict(L.BASE)
    k.update(kw)
    v, l, j = L.SCEN[r['scen']]
    faults = []
    if k['FaultLimit']:
        kinds = ['crash'] + (['lost disk'] if k['AllowLoseDisk'] else [])
        faults.append('%d fault (%s)' % (k['FaultLimit'], ' or '.join(kinds)))
    else:
        faults.append('no fault')
    start = 'R2-1 state' if k['InitR21'] else 'leader in place'
    return '%dV+%dL%s, plan %s, %d change%s, %s, terms <= %d, %s' % (
        len(v), len(l), '+%d spare' % len(j) if j else '', k['Plan'], k['ReconfigurationLimit'],
        '' if k['ReconfigurationLimit'] == 1 else 's', faults[0], k['MaxTermLimit'], start)


def verdict(x):
    if x.get('violated'):
        return 'invariant **%s** broken' % x['violated']
    if x.get('error'):
        return 'TLC error'
    if not x.get('complete'):
        return 'not finished'
    a = x.get('agef')
    if not a:
        return 'complete, every invariant holds'
    s = 'stuck states with a live majority: %d (%s)' % (a['stuck_live'], a['result'])
    if 'plan_result' in a:
        s += '; plan cannot finish: %d (%s)' % (a['plan_stuck'], a['plan_result'])
    return s


def row(name, x):
    r = L.RUNS.get(name, {})
    kw = x.get('kw', {})
    a = x.get('agef', {})
    return '| %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
        name, rule(kw), bounds(r, kw) if r else '', reds(kw),
        '{:,}'.format(x['distinct']) if x.get('distinct') is not None else '',
        x.get('depth') or '', '{:,}'.format(a['judged']) if a else '', verdict(x),
        '%s (%s seg)' % (x.get('secs'), x.get('segments')))


HEAD = ['| run | rule | scenario and bounds | reductions | distinct states | depth | judged states | result | wall s |',
        '|---|---|---|---|---|---|---|---|---|']


def main():
    db = json.load(open(os.path.join(C.RESULTS, 'runs.json')))
    calib = ['r21-append-none', 'r21-append-rb', 'r21-append', 'r21-rb', 'r21', 'r21f-rb', 'r21f',
             'three-1c-rbd', 'three-1c', 'three-1c1f-rbd', 'three-1c1f', 'two-1c1f-rbd', 'two-1c1f',
             'two-1c1f-append', 'two-1c1f-novote']
    out = ['## Calibration', ''] + HEAD + [row(n, db[n]) for n in calib if n in db]
    rest = [n for n in L.RUNS if n in db and n not in calib]
    out += ['', '## Sweep', ''] + HEAD + [row(n, db[n]) for n in rest]
    txt = '\n'.join(out) + '\n'
    open(os.path.join(C.RESULTS, 'tables.md'), 'w').write(txt)
    print(txt)


if __name__ == '__main__':
    main()
