#!/usr/bin/env python3
"""
batch.py: run the plan's TLC and slot_move.py jobs in batches, each batch
under ONE hold of the study's heavy lock of at most about --budget seconds
(the brief: hold it for at most about 30 minutes). Two lanes run side by
side inside a batch: TLC (one worker; two for `three`) and slot_move.py.

    $SP/bin/heavy python3 tools/batch.py --budget 1500     # one batch
    tools/batch.py --loop                                  # batches until done

A job is skipped when its result file exists. A lane starts a job only if
its estimated time fits what is left of the budget, except the first job of
a lane, which always runs (so a long run gets a batch to itself).
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import tlcrun  # noqa: E402
sm = tlcrun.sm

# rough sizes (states) from slot_move.md, to plan the batches only
WORKERS = int(os.environ.get('E15_WORKERS', '2'))
SIZE = {'quick': 2e4, 'move': 6e4, 'moves': 1e6, 'write': 1.5e6, 'dedup': 3.6e5,
        'deep': 4e5, 'three': 8e6}
CAPPED = {('table-after-open', 'write'), ('a-unfences-alone', 'write'), ('no-exporting', 'moves'),
          ('no-exporting', 'three'), ('stream-before-fence-commits', 'write'),
          ('b-serves-before-open', 'write'), ('fence-N-from-committed', 'write'),
          ('no-carried-outcomes', 'write'), ('unfence-on-appended-abort', 'write'),
          ('b-aborts-after-open', 'write'), ('guards-on-committed', 'write')}


def size(v, b):
    f = os.path.join(ROOT, 'results', 'py', f'{v}-{b}.json')
    if os.path.exists(f):
        return json.load(open(f))['states']
    return SIZE[b] * (3 if (v, b) in CAPPED else 1)


def est(lane, v, b):
    n = size(v, b)
    if lane == 'tlc':
        return n / (6000 if WORKERS == 2 else 3500) + 6
    return n / 12000 + 2


def done(lane, v, b):
    d = 'tlc' if lane == 'tlc' else 'py'
    return os.path.exists(os.path.join(ROOT, 'results', d, f'{v}-{b}.json'))


def lane_run(lane, budget, t0, log):
    first = True
    while True:
        left = budget - (time.time() - t0)
        todo = [(v, b) for v, b in sm.plan() if not done(lane, v, b)]
        if not todo:
            return
        fit = [j for j in todo if first or est(lane, *j) < left]
        if not fit:
            return
        v, b = fit[0]
        first = False
        t = time.time()
        if lane == 'tlc':
            r = tlcrun.run(v, b, workers=WORKERS, heavy=False)
            line = json.dumps({k: r[k] for k in ('variant', 'bound', 'states', 'calm_states',
                                                 'failed', 'steps', 'complete')})
        else:
            p = subprocess.run([sys.executable, os.path.join(HERE, 'pyrun.py'), v, b],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            line = p.stdout.strip().splitlines()[-1] if p.stdout.strip() else f'error {p.returncode}'
        with log:
            print(f'{lane} {v} {b} {time.time() - t:.0f}s (est {est(lane, v, b):.0f}s) {line[:300]}',
                  flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--budget', type=float, default=1500)
    ap.add_argument('--lanes', default='tlc,py')
    ap.add_argument('--loop', action='store_true')
    a = ap.parse_args()
    if a.loop:
        while any(not done(l, v, b) for l in a.lanes.split(',') for v, b in sm.plan()):
            subprocess.run([tlcrun.HEAVY, sys.executable, os.path.abspath(__file__),
                            '--budget', str(a.budget), '--lanes', a.lanes])
        return
    t0 = time.time()
    lock = threading.Lock()
    ths = [threading.Thread(target=lane_run, args=(l, a.budget, t0, lock)) for l in a.lanes.split(',')]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    print(f'batch done in {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
