#!/usr/bin/env python3
"""
settle.py: settle the hunt's undecided re-key results with a larger state
limit. hunt.py's R and C stop at 300,000 states; for re-key three answers
stopped there (results/hunt.txt):
  - rekey-carry, C: are freeze.once and flip.once needed? (LIMIT on twice1)
  - rekey, C: does the set with its three once guards hold readback1, and
    which of the three does it need?
This runs the C set of rekey and rekey-carry (the smallest set with the
three once guards put back) on every bound C uses, with a step taken twice
(as hunt.py's R), up to 1,500,000 states a run (the harness's own limit),
and then the same with each once guard dropped again, one at a time.

    python3 settle.py --work $SP/e17c/work > results/settle.txt
    python3 settle.py --work $SP/e17c/work --head --name rekey-carry   # one hold
    python3 settle.py --work $SP/e17c/work --name rekey                # the next
"""

import argparse
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

ap = argparse.ArgumentParser()
ap.add_argument('--work', required=True)
ap.add_argument('--limit', type=int, default=1_500_000)
ap.add_argument('--name', action='append', help='rekey-carry and/or rekey (default both; one per heavy hold)')
ap.add_argument('--head', action='store_true', help='print the header')
A = ap.parse_args()
sys.path.insert(0, os.path.join(A.work, 'harness'))

import runner                                      # noqa: E402
import world                                       # noqa: E402
from bounds import BOUNDS, GROW, TWICE, SWEEP, VERIFY  # noqa: E402
from dsl import Mutation                           # noqa: E402
from world import World                            # noqa: E402
from explore import explore                        # noqa: E402

EXTRA = {
    # hunt.py's bigger bounds that C uses for re-key
    'readback': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w2', 'p', 1)], crashes=0, faults=0, reader=True),
    'readback1': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w2', 'p', 1)], crashes=1, faults=1, reader=True),
    'bothread': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w3', 'q', 1)], crashes=1, faults=2, reader=True),
}
CB = list(SWEEP) + list(VERIFY) + list(EXTRA)     # the bounds C runs re-key on


def repeat_append(self, g, entry):
    """As hunt.py: an entry already in the log may be appended once more."""
    if self.groups is None:
        self.groups = list(self.st[0])
    com, tail, lost, cr = self.groups[g]
    if (com + tail).count(entry) >= 2:
        return
    if len(com) + len(tail) >= self.w.cap:
        self.capped = True
        return
    self.groups[g] = (com, tail + (entry,), lost, cr)


world.Draft.append = repeat_append
ONCE = ['freeze.once', 'final.once', 'flip.once']


def removed(name):
    return json.load(open(os.path.join(A.work, 'results', f'{name}-ablation.json')))['removed']


def one(opt, drop, b):
    """One bound with a step taken twice: (verdict, text)."""
    t0 = time.time()
    r = explore(World(runner.load(opt)[0], EXTRA.get(b) or BOUNDS[b], Mutation(drop=drop), cap=runner.CAP),
                stop_first=True, limit=A.limit)
    if r.fail:
        p = min(r.fail, key=lambda k: r.fail[k][0])
        v, what = 'FAIL', f'{p} in {r.fail[p][0]} steps'
    elif not r.complete:
        v, what = 'LIMIT', 'LIMIT (undecided)'
    else:
        v, what = 'ok', 'holds'
    return v, f'{b} {r.states:,} states {time.time() - t0:.0f}s: {what}'


def sweep(opt, drop, label):
    """Every C bound; stops at the first real failure, goes on past a LIMIT."""
    out = []
    for b in CB:
        v, t = one(opt, drop, b)
        out.append(t)
        if v == 'FAIL':
            break
    print(f'{label}:\n    ' + '\n    '.join(out))
    sys.stdout.flush()


if A.head or not A.name:
    print(f'# settle.py: re-key with a step taken twice, on the bounds hunt.py C uses, up to {A.limit:,} states a run\n')
    print('Each line is one bound. A run stops at the first property that fails; a LIMIT (undecided) does not stop it.\n')
for name in (A.name or ['rekey-carry', 'rekey']):
    cur = [x for x in removed(name) if x not in ONCE]
    sweep(name, cur, f'{name}: the C set (its smallest set with the 3 once guards put back)')
    for x in ONCE:
        sweep(name, cur + [x], f'{name}: the C set without {x}')
