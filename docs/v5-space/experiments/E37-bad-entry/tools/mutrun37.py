#!/usr/bin/env python3
"""mutrun37.py: DEV-10's mutants of the E-37 fix (tools/mutants.py makes
them from the tagged lines of tla/MCbadentry.tla), each run by TLC on the
same runs as the design, cheapest first, until one catches it.

A mutant is CAUGHT when a run breaks a safety invariant, or has stuck states
with a live majority where the design's same run has none. A TLC error (the
mutant does not evaluate) is reported as such, not as caught.

  python3 tools/mutrun37.py [--runs par1,par2] [--only NAME ...] [--timeout S]
Writes results/mutants.json and results/mutants.md.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, 'tools'))
import run37   # noqa: E402

WORK = os.path.join(run37.SP, 'e37', 'mutants')


def main():
    args = sys.argv[1:]
    runs = (args[args.index('--runs') + 1] if '--runs' in args else 'par1,par2').split(',')
    # cheapest first, and the big one-damage run with two client entries last
    # (it is only needed for a damaged server that could lead)
    runs = sorted(runs, key=lambda r: {'par1': 0, 'par2d': 1}.get(r, 2))
    timeout = int(args[args.index('--timeout') + 1]) if '--timeout' in args else 900
    only = [args[i + 1] for i, a in enumerate(args) if a == '--only']
    heavy = '--inhold' not in args       # inside one hold of the heavy lock already
    budget = float(args[args.index('--budget') + 1]) if '--budget' in args else None
    import time
    t0 = time.time()
    subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'mutants.py'), '--write', WORK], check=True,
                   capture_output=True)
    resp = os.path.join(HERE, 'results', 'mutants.json')
    res = json.load(open(resp)) if os.path.exists(resp) else {}
    design = json.load(open(os.path.join(HERE, 'results', 'runs.json')))
    for name in sorted(os.listdir(WORK)):
        mut = open(os.path.join(WORK, name, 'MUTANT')).read().split('\n')[0]
        if only and mut not in only and name not in only:
            continue
        if mut in res and res[mut].get('verdict') in ('caught', 'not caught', 'error', 'undecided'):
            continue
        if budget and time.time() - t0 > budget:
            print('budget used; run again to continue', flush=True)
            break
        row = {'runs': {}}
        verdict = 'not caught'
        for r in runs:
            s = run37.do(r, timeout, mutant=os.path.join(WORK, name), tag='mut-' + name[:40] + '-' + r, save=False,
                         heavy=heavy)
            row['runs'][r] = {k: s.get(k) for k in ('distinct', 'violated', 'complete', 'stuck_live', 'error', 'secs')}
            d = design.get(r, {})
            if s.get('error'):
                verdict = 'error'
                break
            if s.get('violated'):
                verdict = 'caught'
                row['by'] = '%s on %s (%s states in the trace)' % (s['violated'], r, s.get('trace_states'))
                break
            if s.get('complete') and (s.get('stuck_live') or 0) > (d.get('stuck_live') or 0):
                verdict = 'caught'
                row['by'] = 'stuck with a live majority on %s: %d states (design: %d)' % (
                    r, s['stuck_live'], d.get('stuck_live') or 0)
                break
            if not s.get('complete'):
                verdict = 'undecided'
                row['by'] = 'did not finish on %s within %d s' % (r, timeout)
                break
        row['verdict'] = verdict
        res[mut] = row
        json.dump(res, open(resp, 'w'), indent=1, sort_keys=True)
        print('%-40s %s %s' % (mut, verdict, row.get('by', '')), flush=True)
    lines = ['| mutant | verdict | by |', '|---|---|---|']
    for k in sorted(res):
        lines.append('| `%s` | %s | %s |' % (k, res[k]['verdict'], res[k].get('by', '')))
    open(os.path.join(HERE, 'results', 'mutants.md'), 'w').write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
