#!/usr/bin/env python3
"""
variants.py: E-61's structural removals, each run on every bound of the model.

    python3 harness/variants.py OUT.jsonl [OPTION ...] [--drop RULE] [--all]

For each option (default: every option but `design`) and each bound in SWEEP (with --all, also the two
verify bounds, the biggest: 874,075 and 1,092,334 states for the design): explore breadth first
until the first property breaks (so its trace is a shortest one), or to the end. One JSON line per
(option, bound): states, whether the run finished, the property broken and its shortest trace. A rule
drop (--drop) applies to every option named, as the engine's own drops do.
"""
import argparse
import importlib.util
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

spec = importlib.util.spec_from_file_location('e61marks', os.path.join(HERE, '..', 'models', 'marks.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('options', nargs='*')
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--limit', type=int, default=1_500_000)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--bound', action='append', default=[], help='only these bounds')
    a = ap.parse_args()
    opts = a.options or [o for o in M.OPTIONS if o != 'design']
    with open(a.out, 'a') as f:
        for o in opts:
            for b in a.bound or (list(M.SWEEP) + (list(M.VERIFY) if a.all else [])):
                t0 = time.time()
                r = engine.explore(M.OPTIONS[o](M.BOUNDS[b]), engine.Mutation(drop=a.drop), stop_first=True,
                                   limit=a.limit)
                row = {'option': o, 'drop': a.drop, 'bound': b, 'states': r.states, 'complete': r.complete,
                       'secs': round(time.time() - t0, 2)}
                if r.fail:
                    p = min(r.fail, key=lambda k: r.fail[k][0])
                    row['broke'] = p
                    row['steps'] = r.fail[p][0]
                    row['trace'] = [' '.join(str(x) for x in lab) for lab in r.fail[p][1]]
                f.write(json.dumps(row) + '\n')
                f.flush()
            print(o, a.drop or '', 'done', flush=True)


if __name__ == '__main__':
    main()
