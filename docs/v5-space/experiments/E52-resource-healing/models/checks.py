#!/usr/bin/env python3
"""
checks.py: targeted runs on the smallest model an ablation left, for what
the ablation itself does not show.

    python3 models/checks.py models/resheal.py results/res-ablation.json GROUP [LIMIT]

GROUP
  twohints   the smallest model on the two-hint bounds (hh0, lhh, hpl0, hd2):
             do "stale-plan" and the reach check stay unneeded with two
             hints (DEP-17: stale, duplicated or reordered hints)?
  cover      covering pairs, on the sweep and h1: handback.settle dropped
             from the smallest model with the hand-back's Raft guards
             (leader, live, caught, notme) put back; handback.voter dropped
             with handback.caught put back; handback.settle dropped with
             handback.notme put back
  putback B  each rule the smallest model dropped, put back alone, on bound B
             (E-17's put-back step, for a bound outside the ablation)
  big B...   the smallest model on bounds B (f2, ll2f) to LIMIT states
Each line: what was dropped or put back, the bound, the result, and the
shortest trace when a property breaks. PYTHONHASHSEED is pinned to 0.
"""
import json
import os
import sys
import time
import importlib.util

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402


def load(path):
    spec = importlib.util.spec_from_file_location('model_' + os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def run(mod, label, drop, bounds, limit, opt='res'):
    for b in bounds:
        t0 = time.time()
        r = engine.explore(mod.OPTIONS[opt](mod.BOUNDS[b]), engine.Mutation(drop=sorted(set(drop))),
                           stop_first=True, limit=limit)
        print(f'{label} | {b}: {r.summary()} ({time.time() - t0:.0f}s)', flush=True)
        for name, (nj, stuck) in sorted(r.judged.items()):
            if stuck:
                print(f'    {name}: {nj:,} judged, {stuck:,} cannot reach the goal')
        for p, (d, tr) in sorted(r.fail.items()):
            print(f'    {p}: {d} steps')
            engine.show_trace(tr, indent='      ')
        if r.fail:
            return


def main():
    path, abl, group = sys.argv[1:4]
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 2_000_000
    mod = load(path)
    removed = json.load(open(abl))['removed']
    sweep, verify = list(mod.SWEEP), list(mod.VERIFY)
    if group == 'twohints':
        for b in ('hh0', 'lhh', 'hpl0', 'hd2'):
            run(mod, 'the design', [], [b], limit)
            run(mod, 'the smallest model', removed, [b], limit)
    elif group == 'cover':
        raft = ['handback.leader', 'handback.live', 'handback.caught', 'handback.notme']
        bounds = sweep + verify[:1]
        run(mod, 'smallest, hand-back Raft guards back, without handback.settle',
            [x for x in removed if x not in raft] + ['handback.settle'], bounds, limit)
        run(mod, 'smallest, handback.caught back, without handback.voter',
            [x for x in removed if x != 'handback.caught'] + ['handback.voter'], bounds, limit)
        run(mod, 'smallest, handback.notme back, without handback.settle',
            [x for x in removed if x != 'handback.notme'] + ['handback.settle'], bounds, limit)
    elif group == 'putback':
        for b in sys.argv[5:]:
            for r in removed:
                run(mod, f'{r} put back', [x for x in removed if x != r], [b], limit)
    elif group == 'big':
        for b in sys.argv[5:] or ['f2', 'll2f']:
            run(mod, 'the smallest model', removed, [b], limit)
    else:
        raise SystemExit('unknown group ' + group)


if __name__ == '__main__':
    main()
