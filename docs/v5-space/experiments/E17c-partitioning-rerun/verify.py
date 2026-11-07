#!/usr/bin/env python3
"""
verify.py: the cheaper independent check, for results this re-run could not
re-derive from scratch within its budget. It takes the ORIGINAL result's
smallest set (../E17-partitioning/results/<name>-ablation.json) and checks,
fresh, on the work copy of the harness:
  1. the smallest model holds every sweep bound and twice1, with the same
     state counts and state-set digests as the original reported;
  2. it is 1-minimal: dropping any one kept rule (pinned give-up steps
     excepted) breaks a property, and the first failure (bound, property,
     steps) is the one the original reported; a rule the original kept as
     undecided (LIMIT) must stop at the state limit again.
What it does not check: that greedy, from the full model, would reach this
set (only a full re-run does that), and the mutants.

    python3 verify.py --work $SP/e17c/work --name slot+abort [--budget 1200]

Exit code 3: out of time for this piece, run again (as cli.py).
Writes WORK/results/<name>-verify.json (checkpoint: <name>-verify-checkpoint.json).
"""

import argparse
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
ORIG = os.path.join(os.path.dirname(HERE), 'E17-partitioning', 'results')

ap = argparse.ArgumentParser()
ap.add_argument('--work', required=True)
ap.add_argument('--name', required=True)
ap.add_argument('--jobs', type=int, default=2)
ap.add_argument('--budget', type=float, default=None)
A = ap.parse_args()
sys.path.insert(0, os.path.join(A.work, 'harness'))

import runner                                      # noqa: E402
from dsl import Mutation                           # noqa: E402
from bounds import SWEEP, VERIFY                   # noqa: E402


def option_of(name):
    base = name.split('+')[0]
    for suf in ('-rev', '-alt'):
        if base.endswith(suf):
            base = base[:-len(suf)]
    return base


def main():
    o = json.load(open(os.path.join(ORIG, f'{A.name}-ablation.json')))
    opt = option_of(A.name)
    rem = list(o['removed'])
    pinned = set(o.get('pinned', []))
    kept = [r['id'] for r in o['rules'] if r['kept'] and r['id'] not in pinned]
    out = os.path.join(A.work, 'results')
    ck = os.path.join(out, f'{A.name}-verify-checkpoint.json')
    wk = runner.Work(opt, ck, A.jobs, A.budget)
    try:
        tasks = [(Mutation(drop=rem).key(), (b,), True) for b in list(SWEEP) + list(VERIFY)]
        tasks += [(Mutation(drop=rem + [i]).key(), tuple(SWEEP), False) for i in kept]
        res = wk.run(tasks)
    except runner.OutOfTime:
        print(f'  {A.name} verify: out of time for this piece; run again to continue')
        sys.exit(3)
    finally:
        wk.close()
    nb = len(SWEEP) + len(VERIFY)
    minimal = {}
    for r in res[:nb]:
        minimal.update(r)
    rows = []
    same_digest = all(minimal[b]['digest'] == o['minimal'][b]['digest'] for b in SWEEP)
    vo = o.get('verify', {}).get('twice1')
    same_verify = vo is None or minimal['twice1']['digest'] == vo['digest']
    holds = all(not minimal[b]['fail'] and minimal[b]['complete'] for b in SWEEP)
    ro = {r['id']: r for r in o['rules']}
    agree = 0
    for i, per in zip(kept, res[nb:]):
        ff = runner.first_fail(per)
        orig = ro[i].get('final')
        same = (ff is None and orig is None) or (ff is not None and orig is not None and list(ff[:3]) == list(orig[:3]))
        agree += same
        rows.append({'id': i, 'rerun': ff, 'orig': orig, 'same': same})
    summary = {'name': A.name, 'option': opt, 'kept': len(kept) + len(pinned), 'pinned': sorted(pinned),
               'minimal_holds': holds, 'minimal_states': {b: minimal[b]['states'] for b in minimal},
               'same_digests': same_digest, 'same_verify': same_verify,
               'necessary_rerun': sum(1 for r in rows if r['rerun'] and r['rerun'][1] != 'LIMIT'),
               'undecided_rerun': sum(1 for r in rows if r['rerun'] and r['rerun'][1] == 'LIMIT'),
               'not_needed_rerun': [r['id'] for r in rows if r['rerun'] is None],
               'agree_with_orig': agree, 'of': len(rows), 'rows': rows}
    runner.save(os.path.join(out, f'{A.name}-verify.json'), summary)
    print(f'  {A.name}: smallest holds {holds}, same digests {same_digest}, verify same {same_verify}; '
          f'{summary["necessary_rerun"]} necessary, {summary["undecided_rerun"]} undecided, '
          f'{len(summary["not_needed_rerun"])} not needed; {agree} of {len(rows)} agree with the original')


if __name__ == '__main__':
    main()
