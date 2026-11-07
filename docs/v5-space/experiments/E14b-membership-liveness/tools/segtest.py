#!/usr/bin/env python3
"""segtest.py: checks the segment machinery of live.py.

One run (default three-1c-full) is checked twice: in one piece, and cut into
segments of about 90 seconds (TLC checkpoints every minute, stops itself at
90 s, and the next segment resumes from the last checkpoint). The two state
graphs must be the same: the same node ids, the same edges, the same
distinct-state count from TLC, and the same AG EF result.

  python3 tools/segtest.py [RUN]
Writes results/segtest.txt.
"""
import gzip
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ['E14B_KEEP'] = '1'
import common as C  # noqa: E402
import live as L  # noqa: E402


def graph(name):
    nodes, edges = set(), set()
    for p in glob.glob(os.path.join(C.WORK, name, 'seg*.g.gz')):
        with gzip.open(p, 'rt') as f:
            for line in f:
                x = line.split()
                if x[0] == 'N':
                    nodes.add(int(x[1]))
                elif x[0] == 'E':
                    edges.add((int(x[1]), int(x[2])))
    return nodes, edges


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else 'three-1c-full'
    r = L.RUNS[run]
    one = L.go('segtest-one', seg_secs=1500, max_seg=1, r=r, result_name='segtest-one')
    cut = L.go('segtest-cut', seg_secs=90, max_seg=40, ckpt_min=1, r=r, result_name='segtest-cut')
    n1, e1 = graph('segtest-one')
    n2, e2 = graph('segtest-cut')
    rows = {
        'run': run,
        'one piece': dict(segments=one['segments'], distinct=one['distinct'], nodes=len(n1), edges=len(e1),
                          agef=one.get('agef', {}).get('result'), stuck_live=one.get('agef', {}).get('stuck_live')),
        'segments': dict(segments=cut['segments'], distinct=cut['distinct'], nodes=len(n2), edges=len(e2),
                         agef=cut.get('agef', {}).get('result'), stuck_live=cut.get('agef', {}).get('stuck_live')),
        'same nodes': n1 == n2, 'same edges': e1 == e2,
        'nodes only in one': len(n1 ^ n2), 'edges only in one': len(e1 ^ e2),
    }
    txt = json.dumps(rows, indent=1)
    open(os.path.join(C.RESULTS, 'segtest.txt'), 'w').write(txt + '\n')
    print(txt)
    for n in ('segtest-one', 'segtest-cut'):
        for p in glob.glob(os.path.join(C.WORK, n, 'seg*.gz')):
            os.remove(p)


if __name__ == '__main__':
    main()
