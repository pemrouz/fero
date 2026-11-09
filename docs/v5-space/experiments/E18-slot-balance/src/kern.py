"""E-18: the placement kernels, through ctypes, plus slow pure-Python twins.

The C file kern.c does the work. Each function here has a twin named py_*
written plainly in Python; selftest.py checks that both agree on random inputs.
The shared library is built by run.sh into $E18_BUILD (default: the scratchpad).
"""
import ctypes
import os
import numpy as np

_here = os.path.dirname(os.path.abspath(__file__))
_build = os.environ.get('E18_BUILD', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/e18')
_lib = ctypes.CDLL(os.path.join(_build, 'kern.so'))

_dp = np.ctypeslib.ndpointer(dtype=np.float64, flags='C_CONTIGUOUS')
_ip = np.ctypeslib.ndpointer(dtype=np.int32, flags='C_CONTIGUOUS')

_lib.lpt.restype = ctypes.c_double
_lib.lpt.argtypes = [_dp, ctypes.c_long, ctypes.c_int, _dp, ctypes.c_void_p]
_lib.best_contig.restype = ctypes.c_double
_lib.best_contig.argtypes = [_dp, ctypes.c_long, ctypes.c_int]
_lib.rebalance.restype = None
_lib.rebalance.argtypes = [_dp, _dp, ctypes.c_long, ctypes.c_int, _ip,
                           ctypes.c_double, ctypes.c_long, _dp]


def lpt(w_sorted_desc, G, want_assign=False):
    """Greedy packing. Returns (largest load, group loads, assign or None)."""
    w = np.ascontiguousarray(w_sorted_desc, dtype=np.float64)
    loads = np.zeros(G, dtype=np.float64)
    if want_assign:
        a = np.zeros(len(w), dtype=np.int32)
        mx = _lib.lpt(w, len(w), G, loads, a.ctypes.data_as(ctypes.c_void_p))
        return mx, loads, a
    mx = _lib.lpt(w, len(w), G, loads, None)
    return mx, loads, None


def lpt_assign(w, G):
    """Greedy packing of items in any order; returns each item's group (int32).
    Items with zero load (empty slots) do not change any load, so greedy
    packing would pile them all on one group; they are dealt out evenly by
    count instead, so a later hotspot in a cold slot lands on a random group."""
    order = np.argsort(-w, kind='stable')
    _, _, a_sorted = lpt(w[order], G, want_assign=True)
    a = np.empty(len(w), dtype=np.int32)
    a[order] = a_sorted
    zero = np.nonzero(w <= 0)[0]
    if len(zero):
        cnt = np.bincount(a[w > 0], minlength=G)
        # fill the groups with the fewest items first, then round robin
        for i in zero:
            g = int(np.argmin(cnt)); a[i] = g; cnt[g] += 1
    return a


def best_contig(w, G):
    w = np.ascontiguousarray(w, dtype=np.float64)
    return _lib.best_contig(w, len(w), G)


def rebalance(w, rows, G, assign, tau, maxmoves=None):
    """One move at a time. assign (int32) is changed in place.
    Returns dict(moves, rows, max, reached, level, floor, min, pinned).
    maxmoves defaults to 100 moves per item plus 10,000: a run that hits it
    reports reached = -1 (the tables count these; there were none)."""
    if maxmoves is None:
        maxmoves = 100 * len(w) + 10000
    w = np.ascontiguousarray(w, dtype=np.float64)
    rows = np.ascontiguousarray(rows, dtype=np.float64)
    assert assign.dtype == np.int32 and assign.flags['C_CONTIGUOUS']
    out = np.zeros(8, dtype=np.float64)
    _lib.rebalance(w, rows, len(w), G, assign, tau, maxmoves, out)
    return dict(moves=int(out[0]), rows=out[1], max=out[2], reached=int(out[3]),
                level=out[4], floor=out[5], min=out[6], pinned=int(out[7]))


def water_level(w, G):
    """The same water level as kern.c, in numpy (used for the trigger)."""
    total = float(w.sum())
    level = total / G
    for _ in range(64):
        big = w[w > level]
        if len(big) >= G:
            return level
        nl = (total - float(big.sum())) / (G - len(big))
        if nl == level:
            return level
        level = nl
    return level


# ---------------------------------------------------------------- twins --

EPS = 1e-9  # as in kern.c

def py_lpt(w_sorted_desc, G):
    import heapq
    h = [(0.0, g) for g in range(G)]
    heapq.heapify(h)
    assign = []
    for x in w_sorted_desc:
        load, g = heapq.heappop(h)
        assign.append(g)
        heapq.heappush(h, (load + x, g))
    loads = [0.0] * G
    for load, g in h:
        loads[g] = load
    return max(loads), loads, assign


def py_best_contig_exact(w, G):
    """Exact optimum by dynamic programming (small inputs only)."""
    n = len(w)
    pre = [0.0]
    for x in w:
        pre.append(pre[-1] + x)
    INF = float('inf')
    # best[k][i]: least max over cuts of the first i items into k runs
    best = [[INF] * (n + 1) for _ in range(G + 1)]
    best[0][0] = 0.0
    for k in range(1, G + 1):
        for i in range(0, n + 1):
            b = best[k - 1][i]  # an empty run is allowed
            for j in range(0, i):
                c = max(best[k - 1][j], pre[i] - pre[j])
                if c < b:
                    b = c
            best[k][i] = b
    return best[G][n]


def py_water_level(w, G):
    total = sum(w)
    level = total / G
    for _ in range(64):
        big = [x for x in w if x > level]
        if len(big) >= G:
            return level
        nl = (total - sum(big)) / (G - len(big))
        if nl == level:
            return level
        level = nl
    return level


def py_rebalance(w, rows, G, assign, tau, maxmoves=10**9):
    assign = list(assign)
    load = [0.0] * G
    for i, g in enumerate(assign):
        load[g] += w[i]
    level = py_water_level(w, G)
    floor = max(level, max(w))
    pinned = [False] * G
    moves, rmoved, reached = 0, 0.0, 0
    while True:
        free = [g for g in range(G) if not pinned[g]]
        if not free:
            reached = 0
            break
        a = max(free, key=lambda g: (load[g], -g))
        b = min(free, key=lambda g: (load[g], g))
        if load[a] <= tau * floor and load[b] >= (2 - tau) * level:
            reached = 1
            break
        if moves >= maxmoves:
            reached = -1
            break
        if a == b:
            reached = 0
            break
        gap = load[a] - load[b]
        half = gap / 2
        lim = gap - EPS * floor
        best, bd = -1, 0.0
        for i in range(len(w)):
            if assign[i] == a and 0 < w[i] < lim:
                d = abs(w[i] - half)
                if best < 0 or d < bd:
                    best, bd = i, d
        if best < 0:
            pinned[a] = True
            continue
        assign[best] = b
        load[a] -= w[best]
        load[b] += w[best]
        moves += 1
        rmoved += rows[best]
    return dict(moves=moves, rows=rmoved, max=max(load), reached=reached,
                level=level, floor=floor, min=min(load), pinned=sum(pinned)), assign
