#!/usr/bin/env python3
"""
maxchg.py: the longest run of changes the design makes after one outside
event, per bound: config changes and placement writes (`chg`, P9) and
leadership transfers (`lc`, P9L). The caps of P9 and P9L in resheal.py
(MAXCHG) are set from these numbers. Breadth first over every reachable
state, with both caps lifted (safety and liveness are not checked here).

    python3 models/maxchg.py models/resheal.py BOUND [BOUND ...]
    OPT=free python3 models/maxchg.py ...     (another option)
    LIMIT=5000000 python3 models/maxchg.py ...  (stop after that many states)
"""
import os, sys, importlib.util
if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'; os.execv(sys.executable, [sys.executable] + sys.argv)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402
spec = importlib.util.spec_from_file_location('m', sys.argv[1]); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod.CHURN = mod.LCHURN = 10 ** 6
LIMIT = int(os.environ.get('LIMIT', '5000000'))
for b in sys.argv[2:]:
    bd = {k: v for k, v in mod.BOUNDS[b].items() if k not in ('churn', 'lchurn')}
    md = mod.OPTIONS[os.environ.get('OPT', 'res')](bd); c = engine.Compiled(md, engine.Mutation())
    init = md.init(); seen = {init: None}; q = [init]; mx = 0; arg = None; mxl = 0; argl = None
    i = 0
    while i < len(q):
        s = q[i]; i += 1
        for lab, kind, t in c.succ(s):
            if t not in seen:
                seen[t] = (s, lab); q.append(t)
                ch = t[mod.IX['chg']]
                if ch > mx: mx, arg = ch, t
                lc = t[mod.REP][mod.XI['lc']]
                if lc > mxl: mxl, argl = lc, t
        if len(q) > LIMIT: break
    print(b, 'states', len(q), 'complete', i == len(q), 'max chg (config and placement)', mx, 'max lc (transfers)', mxl,
          flush=True)
    for name, a in (('chg', arg), ('lc', argl)):
        tr = []; t = a
        while t is not None and seen[t] is not None:
            s, lab = seen[t]; tr.append(lab); t = s
        print('  longest', name, 'run, trace:')
        for lab in reversed(tr): print('   ', lab)
    del seen, q
