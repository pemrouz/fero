#!/usr/bin/env python3
"""traces.py: re-run one liveness run with its state graph kept, and write a
trace to each of up to N stuck states with a live majority (live.py keeps
only the shortest one).

  python3 tools/traces.py RUN [N]      # writes $SP/e14b/traces/RUN.txt

Used for two-1c1f-novote (results/two-1c1f-novote-traces.txt is its trimmed
summary).
"""
import glob
import os
import sys

os.environ['E14B_KEEP'] = '1'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agef2  # noqa: E402
import common as C  # noqa: E402
import live as L  # noqa: E402


def main():
    run = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 16
    raw = os.path.join(C.SP, 'e14b', 'traces')
    r = L.RUNS[run]
    name = 'tr-' + run
    L.go(name, r=r, result_name=run, results_dir=raw, record=False, redo=True, heap='3g')
    wd = os.path.join(C.WORK, name)
    kw = dict(L.BASE)
    kw.update(r['kw'])
    a, txt = agef2.check(sorted(glob.glob(wd + '/seg*.g.gz')), kw['MaxTermLimit'] - 2, n,
                         sorted(glob.glob(wd + '/seg*.l.gz')))
    open(os.path.join(raw, run + '-traces.txt'), 'w').write(txt)
    print(a['result'], a['stuck_live'], a['states'])


if __name__ == '__main__':
    main()
