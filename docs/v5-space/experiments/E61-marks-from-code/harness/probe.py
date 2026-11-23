#!/usr/bin/env python3
"""
probe.py: two questions the ablation and the build-bug mutants left open, each on a bound made for it.

    python3 harness/probe.py > results/probe.txt

1. `fence.oseq` (a slot move carries the slot's issue numbers). The ablation keeps it only because, without it,
   the design on `d-move` passes its state limit (1,300,000 states) with no break: undecided, not shown needed.
   Here the same move on a smaller bound, `move-small` (x0 and x1 both write R, R moves from b1 to b0, one
   restart), runs to the end with and without the rule, from the design and from the ablation's 1-minimal set.
2. K14 (on `expired`, the marks are read again with the uncommitted tail) survives all 42 bounds. With output
   marks a record is read again, so the jump must pass a record whose output sits in a tail that is then lost:
   that takes four records, a share move, a lost tail and a cut (`share-cut-tail4`). The design runs there to
   the end, then K14 runs there until its first break.
"""
import importlib.util
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

spec = importlib.util.spec_from_file_location('e61marks', os.path.join(HERE, '..', 'models', 'marks.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
spec2 = importlib.util.spec_from_file_location('e61mutants', os.path.join(HERE, 'mutants.py'))
K = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(K)

SMALL = {'mode': 'derive', 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'R', False), ('d', 'a1', 1, 'R', False)),
         'owners': ('d',), 'slots': {'R': M.B1}, 'move': ('R', M.B1, M.B0), 'line': 2, 'faults': 1, 'restarts': 1}
TAIL4 = {'mode': 'derive', 'src': {'a1': 4}, 'outs': tuple(('d', 'a1', q, 'P', False) for q in range(4)),
         'owners': ('d', 'd'), 'share': True, 'slots': {'P': M.B0}, 'line': 2, 'faults': 2, 'restarts': 0,
         'takes': 1, 'cuts': 2, 'crashes': 1}


def show(name, r):
    print(f'{name}: {r.summary()}', flush=True)
    for nm, (nj, stuck) in sorted(r.judged.items()):
        print(f'    {nm}: {nj:,} judged states, {stuck:,} cannot reach the goal')
    for p, (d, tr) in sorted(r.fail.items()):
        print(f'  {p}: shortest trace, {d} steps')
        engine.show_trace(tr)


def main():
    ab = os.path.join(HERE, '..', 'results', 'design-ablation.json')
    removed = json.load(open(ab))['removed'] if os.path.exists(ab) else None
    print('# 1. move-small:', json.dumps({k: v for k, v in SMALL.items() if k != 'outs'}), flush=True)
    runs = [('design', []), ('design without fence.oseq', ['fence.oseq'])]
    if removed is not None:
        runs += [('1-minimal set', list(removed)), ('1-minimal set without fence.oseq', list(removed) + ['fence.oseq'])]
    for name, drop in runs:
        show(name, engine.explore(M.Design(SMALL), engine.Mutation(drop=drop), stop_first=False, limit=1_300_000))
    print('\n# 2. share-cut-tail4:', json.dumps({k: v for k, v in TAIL4.items() if k != 'outs'}), flush=True)
    show('design', engine.explore(M.Design(TAIL4), engine.Mutation(), stop_first=False, limit=1_300_000))
    show('K14-resync-tail', engine.explore(K.ResyncTail(TAIL4), engine.Mutation(), stop_first=True, limit=1_300_000))


if __name__ == '__main__':
    main()
