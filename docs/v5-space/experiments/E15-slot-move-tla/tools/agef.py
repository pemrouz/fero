#!/usr/bin/env python3
"""
agef.py: AG EF Done on the calm graph TLC printed (property 7).

TLC prints one line per calm state, <<"N", fingerprint, Done>>, and one per
calm step, <<"E", from, to>>. Fingerprints are two 32-bit halves of TLC's
own fingerprint of the state (TLCFP), so a 64-bit key. A state is stuck when
no path from it reaches a Done state. AG EF Done holds when no state is stuck.
This is the same check slot_move.py's liveness() makes, on TLC's graph.
"""
from collections import deque


def check(nodes, edges):
    """nodes: {key: done}; edges: [(from, to)]. Returns stuck count and keys."""
    rev = {k: [] for k in nodes}
    missing = 0
    for a, b in edges:
        if a not in nodes or b not in nodes:
            missing += 1
            continue
        rev[b].append(a)
    reach = {k: d for k, d in nodes.items()}
    q = deque(k for k, d in nodes.items() if d)
    while q:
        b = q.popleft()
        for a in rev[b]:
            if not reach[a]:
                reach[a] = True
                q.append(a)
    stuck = [k for k, r in reach.items() if not r]
    return {'stuck': len(stuck), 'stuck_nodes': stuck[:100000], 'missing_edges': missing,
            'nodes': len(nodes), 'edges': len(edges)}
