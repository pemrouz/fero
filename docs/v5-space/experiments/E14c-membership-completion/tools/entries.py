#!/usr/bin/env python3
"""entries.py: where a full run's states above the judged term come from.

  python3 tools/entries.py RUNDIR

Reads a run's graph files (a part-graph is fine) and prints: the states by
highest term; how many term-2 states have a step into term 3 and how many
term-3 states those steps enter; and how many states above term 2 come
after a working leader (what stopping at the goal would save).
"""
import sys, os, glob
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import partial as P, agef2
wd = sys.argv[1]
g = P.graph(P.segs(wd))
sid, n = g['sid'], len(g['sid'])
p = np.searchsorted(sid, g['es']); p[p>=n]=0; oks = sid[p]==g['es']
q = np.searchsorted(sid, g['ed']); q[q>=n]=0; okd = sid[q]==g['ed']
k = oks&okd; s, d = p[k], q[k]
mt, goal, faults, nup = g['mterm'], g['goal'], g['faults'], g['nup']
print('nodes', n, 'by term', {int(t): int((mt==t).sum()) for t in np.unique(mt)})
# start states: term-3 targets of edges from term-2 sources
st = np.unique(d[(mt[s]<=2)&(mt[d]>2)])
print('term-2 states with a step into term 3:', len(np.unique(s[(mt[s]<=2)&(mt[d]>2)])), ' distinct term-3 states they enter:', len(st))
# forward closure from goal states above term 2 (any edges)
o = np.argsort(s, kind='stable'); fdst = d[o]; fptr = np.searchsorted(s[o], np.arange(n+1))
def fwd(start_mask, edge_ok=None):
    seen = start_mask.copy(); fr = np.nonzero(seen)[0]
    while fr.size:
        r = agef2.ranges(fptr, fr); nx = np.unique(fdst[r]); nx = nx[~seen[nx]]; seen[nx] = True; fr = nx
    return seen
above = mt > 2
g3 = above & goal & (faults > 0)
post = fwd(g3)
strict_post = post & ~g3
print('above term 2:', int(above.sum()), ' goal (faulted) above term 2:', int(g3.sum()),
      ' strictly after such a goal state:', int((strict_post & above).sum()))
# states above term 2 NOT after a goal (what a stop-at-goal run would keep, plus the goal states themselves)
pre = above & ~strict_post
print('above term 2 and not after a faulted goal state:', int(pre.sum()), ' of which faults=0:', int((pre & (faults==0)).sum()))
