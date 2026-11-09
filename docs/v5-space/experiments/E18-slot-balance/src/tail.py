"""E-18 part E: how often do the slots alone break the 1.25 bar?

Part A found one failure at 1,024 slots in 10 seeds (Pareto 1.16, N = 1e5,
G = 64): two heavy rooms, each under 1/G of the load, hashed into one slot.
That is a chance event, so this part counts it over many draws.

For each draw (seed), distribution, N and slot count S, greedy packing gives
max/mean r(G) at every G = 1..64 (the threshold's range). A draw is a
**slot failure** when at some G <= 64 the slots miss the bar where Q-18's
threshold does not excuse it: r_slots(G) > 1.25 while the hottest partition
alone carries at most 1/G of the load. With "split" the app has split every
partition above 0.5/G first, so no point is excused. Also recorded: the smallest such G, and the largest G
with r <= 1.25 at every G' <= G (E64, capped at 64).

One JSON line per (dist, N, seed, S, variant).
"""
import argparse
import json
import sys
import time

import numpy as np

import gen
import kern

GMAX = 64


def scan(sl, total, pmax_by_g):
    """Returns (first slot failure G or 0, E64)."""
    sls = np.sort(sl)[::-1].copy()
    first, E = 0, None
    for G in range(1, GMAX + 1):
        r = kern.lpt(sls, G)[0] * G / total
        if r > 1.25 + 1e-12:
            if E is None:
                E = G - 1
            if pmax_by_g(G) * G <= 1 + 1e-12 and not first:
                first = G
    return first, (GMAX if E is None else E)


def scan_split(split, S, base_sl, total):
    first, E = 0, None
    last_ks, sls = None, None
    for G in range(1, GMAX + 1):
        ks = split.ks(0.5 / G)
        if ks != last_ks:      # the pieces change only when some k doubles
            sl = split.slot_loads(S, 0.5 / G, base=base_sl)
            sls = np.sort(sl)[::-1].copy()
            last_ks = ks
        r = kern.lpt(sls, G)[0] * G / total
        if r > 1.25 + 1e-12:
            if E is None:
                E = G - 1
            if not first:
                first = G
    return first, (GMAX if E is None else E)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--N', type=int, nargs='+', default=[10**4, 10**5, 10**6])
    ap.add_argument('--dists', nargs='+', default=['uniform', 'zipf-0.8', 'zipf-0.99', 'pareto-1.16', 'pareto-2', 'hot-0.01'])
    ap.add_argument('--seeds', type=int, nargs='+', default=[1000, 1000, 200])
    ap.add_argument('--seed0', type=int, default=100, help='first seed (parts A and B use 0..9)')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    with open(a.out, 'a') as f:
        for N, ns in zip(a.N, a.seeds):
            t0 = time.time()
            for seed in range(a.seed0, a.seed0 + ns):
                h = gen.hashes(N, seed)
                for dist in a.dists:
                    w = gen.loads(dist, N, seed)
                    total = float(w.sum())
                    pmax = float(w.max()) / total
                    split = gen.AppSplit(w, h, N, seed, min_cap=0.5 / GMAX)
                    for S in gen.SS:
                        first, E = scan(gen.slot_loads(w, h, S), total, lambda G: pmax)
                        f.write(json.dumps(dict(dist=dist, N=N, seed=seed, S=S, variant='pure',
                                                pmax=pmax, first=first, E64=E)) + '\n')
                        base = gen.slot_loads(split.base_w, h, S)
                        first, E = scan_split(split, S, base, total)
                        f.write(json.dumps(dict(dist=dist, N=N, seed=seed, S=S, variant='split',
                                                pmax=pmax, first=first, E64=E)) + '\n')
                if (seed - a.seed0) % 50 == 49:
                    f.flush()
                    print(f'N={N} seeds to {seed} {time.time() - t0:.0f}s', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
