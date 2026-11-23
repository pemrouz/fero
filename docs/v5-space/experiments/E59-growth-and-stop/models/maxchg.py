#!/usr/bin/env python3
"""
maxchg.py: the longest run of config and placement entries the design
appends after one outside event, per bound (`chg`, P9), and the longest log
(P9W), and the longest run of leadership transfers (P9L). The caps in
grow.py's BOUNDS are set from these numbers: twice the longest run (at least
8), twice the longest log, and twice the longest run of transfers (at least 4). Breadth first over every
reachable state, with the caps lifted; nothing else is checked here.

    python3 models/maxchg.py OPTION BOUND [BOUND ...]
"""
import os
import sys
import importlib.util
if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402
spec = importlib.util.spec_from_file_location('grow', os.path.join(HERE, 'grow.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
opt = sys.argv[1]
for b in sys.argv[2:]:
    bd = dict(mod.BOUNDS[b], churn=10 ** 6, maxlog=10 ** 6, lchurn=10 ** 6)
    md = mod.OPTIONS[opt](bd)
    c = engine.Compiled(md, engine.Mutation())
    init = md.init()
    seen = {init: None}
    q = [init]
    mx, arg = 0, None
    ml = 0
    mlc = 0
    i = 0
    while i < len(q):
        s = q[i]
        i += 1
        for lab, kind, t in c.succ(s):
            if t not in seen:
                seen[t] = (s, lab)
                q.append(t)
                if t[mod.CHG] > mx:
                    mx, arg = t[mod.CHG], t
                ml = max(ml, max(len(x) for x in t[mod.LG]))
                mlc = max(mlc, t[mod.LC])
    tr = []
    t = arg
    while t is not None and seen[t] is not None:
        s, lab = seen[t]
        tr.append(lab)
        t = s
    print(f'{opt} {b}: {len(q):,} states; longest run of config and placement entries: {mx}; cap {max(8, 2 * mx)}; '
          f'longest log: {ml}; cap {2 * ml}; longest run of transfers: {mlc}; cap {max(4, 2 * mlc)}')
    for lab in reversed(tr):
        print('   ', lab[0], lab[1])
    sys.stdout.flush()
