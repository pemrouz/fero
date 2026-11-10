#!/usr/bin/env python3
"""
segs_check.py: is `bopen.segs` needed? A targeted check beside the ablation.

The ablation drops `bopen.segs` (the move carries the names of A's segments
below N, so B can serve log readers from before N). The reason is the way P7
is written: an `expired` counts as false only when a live, loaded replica
THAT HOLDS THE SLOT has the reader's next record. After a move only B holds
the slot, so a B that was given no segments says `expired` for every cursor
below N, and P7 calls that true. P-07 does not: the records are inside
retention and a live replica of the old group still has them.

So this script checks a stronger reading, P7s: the client is told `expired`
only when NO live, loaded replica, in either group, has its next record.

    python3 segs_check.py            the design, then the design without bopen.segs

It changes no rule and no state: P7s is one more edge check on the same
model, so the ablation's runs (results/fixed-ablation.json.cache) stay valid.
"""
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
sys.path.insert(0, os.path.join(HERE, 'models'))
import engine      # noqa: E402
import subscribe   # noqa: E402
from subscribe import IX, LA, FA, LB   # noqa: E402


class FixedS(subscribe.Fixed):
    def check_edge(self, s, lab, kind, t):
        bad = super().check_edge(s, lab, kind, t)
        if lab[0] == 'gotexp':
            cur = s[IX['cl']][3]
            for x in (LA, FA, LB):
                a, ld, f, base = self.src_state(s, x)
                # any live, loaded replica that still has the record after the
                # cursor (A's replicas keep their segments after the move)
                if a and ld and base <= cur < f:
                    bad.append('P7s')
                    break
        return bad


def main():
    for drop in ([], ['bopen.segs']):
        for b in ('mv-log', 'fo2-log'):
            r = engine.explore(FixedS(subscribe.BOUNDS[b]), engine.Mutation(drop=drop), limit=3_000_000)
            what = 'the design' if not drop else 'without ' + ', '.join(drop)
            print(f'fixed + P7s, {what}, {b}: {r.summary()}')
            for p, (d, tr) in sorted(r.fail.items()):
                print(f'  {p}: shortest trace, {d} steps')
                engine.show_trace(tr)


if __name__ == '__main__':
    main()
