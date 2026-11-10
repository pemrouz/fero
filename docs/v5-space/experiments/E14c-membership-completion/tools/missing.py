#!/usr/bin/env python3
"""missing.py: the judged states a full run's part-graph has and the
terms-up-to-2 run of the same scenario lacks, with their key fields.

  python3 tools/missing.py SMALL_RUNDIR BIG_RUNDIR JUDGE LABEL_DIR

Such states exist only where a disk can be lost: a server that alone holds a
higher term loses its disk, its term is wiped, and the highest term among
the servers goes back down. LABEL_DIR holds BIG's label files (seg*.l.gz or
seg*.l.xz). Both runs must come from the same module files (tools/partial.py).
"""
import glob
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import partial as P  # noqa: E402
from classify import openlab, unescape, field  # noqa: E402


def main():
    small, big, judge, labdir = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    A = P.graph(P.segs(small))
    B = P.graph(P.segs(big))
    miss = np.setdiff1d(B['sid'][B['mterm'] <= judge], A['sid'])
    p = np.searchsorted(B['sid'], miss)
    print('judged states (highest term <= %d) in %s and not in %s: %d; of which with a live majority: %d' % (
        judge, os.path.basename(big.rstrip('/')), os.path.basename(small.rstrip('/')), len(miss), int(B['live'][p].sum())))
    eb = P.edges(B)
    src = eb['s'][np.isin(eb['d'], miss)]
    ps = np.searchsorted(B['sid'], src)
    print('steps into them: %d, from states of highest term %s' % (
        len(src), dict(zip(*[x.tolist() for x in np.unique(B['mterm'][ps], return_counts=True)]))))
    want = set(int(x) for x in miss)
    for lp in sorted(glob.glob(os.path.join(labdir, 'seg*.l.gz')) + glob.glob(os.path.join(labdir, 'seg*.l.xz'))):
        if not want:
            break
        with openlab(lp) as f:
            for line in f:
                k, _, v = line.partition('\t')
                if k.lstrip('-').isdigit() and int(k) in want:
                    want.discard(int(k))
                    lab = unescape(v.rstrip('\n'))
                    conf = re.sub(r'jointConfig \|-> <<(\{[^}]*\}), \{\}>>, learners \|-> ', r'V\1 L', field(lab, 'config'))
                    ctl = re.findall(r'newconf \|-> (\{[^}]*\})', field(lab, 'ctl'))
                    print('%s: up %s | lost disk %s | terms %s | livev %s\n    applied config %s\n    committed configurations, in order: %s' % (
                        k, field(lab, 'up'), field(lab, 'dead'), field(lab, 'currentTerm'), field(lab, 'livev'), conf,
                        ', '.join(ctl)))
                    if not want:
                        break


if __name__ == '__main__':
    main()
