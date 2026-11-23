#!/usr/bin/env python3
"""
cover.py: does the design's state space reach the scenarios the review asked about?
Each scenario is written as a marker that the checker reports like a broken property,
so its shortest trace is the proof that the scenario is reached (and the count of
edges says how often). The design itself is unchanged.

    python3 cover.py BOUND [BOUND ...]

Markers:
  LEADPIC   a leader sends a picture (it is the only ready copy of its group, V5-17)
  HANDBACK  a leader that served the link hands it back: END moved once another copy is ready
  LATE      the client takes a message that the copy sent for a SUB the client gave up
            on this connection (a late message)
  TRIM      the client drops frames of a ring resume that it already applied
  BFAIL     group B's follower fails after the move while the client follows the view
  ENDTAKEN  the client takes END view-too-big
"""
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'models'))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine     # noqa: E402
import view       # noqa: E402
from view import View, IX, CI, FB   # noqa: E402

COUNT = {}


class Cover(View):
    def check_edge(self, s, lab, kind, t):
        bad = super().check_edge(s, lab, kind, t)
        a = lab[0]
        sc, tc = s[IX['cl']], t[IX['cl']]
        m = []
        if a in ('pic', 'moved'):
            x = dict(lab[1])['x']
            if self.leads(s, x) and a == 'pic':
                m.append('LEADPIC')
            if self.leads(s, x) and a == 'moved' and sc[CI['link']] == 'on':
                m.append('HANDBACK')    # it had served this link, and now hands it on
        if a.startswith('got') or a == 'skip':
            # a message taken while the client has no SUB, or has sent a new one that the
            # copy has not answered yet, was sent for a SUB it gave up
            if sc[CI['link']] is None or (sc[CI['link']] == 'req' and sc[CI['q']]):
                m.append('LATE')
        if a == 'skip':
            m.append('TRIM')
        if lab[0] == 'crash' and lab[1] == 'FB' or lab[0] == 'reload' and lab[1] == 'FB':
            if sc[CI['inst']] is not None:
                m.append('BFAIL')
        if a == 'gotbig':
            m.append('ENDTAKEN')
        for k in m:
            COUNT[k] = COUNT.get(k, 0) + 1
        return bad + m


for b in sys.argv[1:]:
    COUNT.clear()
    r = engine.explore(Cover(view.BOUNDS[b]), stop_first=False, limit=3_500_000)
    real = sorted(p for p in r.fail if p not in ('LEADPIC', 'HANDBACK', 'LATE', 'TRIM', 'BFAIL', 'ENDTAKEN'))
    print(f'{b}: {r.states:,} states; properties broken: {", ".join(real) or "none"}', flush=True)
    for k in ('LEADPIC', 'HANDBACK', 'LATE', 'TRIM', 'BFAIL', 'ENDTAKEN'):
        if k in r.fail:
            d, tr = r.fail[k]
            print(f'  {k}: reached, {COUNT.get(k, 0):,} edges; shortest trace {d} steps:')
            engine.show_trace(tr)
        else:
            print(f'  {k}: not reached')
    sys.stdout.flush()
