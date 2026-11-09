"""E-18 part A: how evenly do S slots spread a resource's load over G groups?

For every distribution, partition count N, seed and slot count S, and for G on
a grid from 1 to 256, it computes the largest group load over the mean
(max/mean) for each placement:

  fixN          no slots: partitions hash straight onto G groups (CELL, LANE, Kafka)
  ranges-equal  G contiguous slot ranges with equal slot counts (no load data)
  ranges-best   G contiguous slot ranges cut to the best max load
  lpt           greedy packing of slots, largest first, from scratch
  inc           one move at a time (the controller): groups added one by one,
                after each the controller moves slots until max <= 1.10 x floor
                and min >= 0.90 x level, or no single move helps
  halving       the draft's grow rule (DESIGN-V5 §4.2): the busiest group hands
                the half of its slots that splits its load best to a new group
  key-lb        the key-level ideal: max(total/G, hottest partition); no design
                can do better
  key-lpt       greedy packing of partitions (the pruned per-key directory)
  key-contig    the best contiguous cut of partitions in hash order (SPLIT, PD)

One JSON line per (dist, N, seed, S, placement, G). Usage:
  python3 static.py --N 10000 100000 --out raw.jsonl
"""
import argparse
import json
import sys
import time

import numpy as np

import gen
import kern

GRID = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]
TAU = 1.10


def halving_curve(sl, Gmax):
    """max load at each G = 1..Gmax under the draft's halving rule."""
    groups = [np.arange(len(sl))]
    loads = [float(sl.sum())]
    out = {1: max(loads)}
    for G in range(2, Gmax + 1):
        a = int(np.argmax(loads))
        idx = groups[a]
        # split the busiest group's slots in two by greedy packing (by load,
        # ties by slot number): the second half goes to the new group
        order = idx[np.lexsort((idx, -sl[idx]))]
        _, l2, asg = kern.lpt(sl[order], 2, want_assign=True)
        keep, give = order[asg == 0], order[asg == 1]
        if len(give) == 0:          # a single slot: nothing to hand over
            groups.append(np.zeros(0, dtype=idx.dtype)); loads.append(0.0)
        else:
            groups[a] = np.sort(keep); loads[a] = float(sl[keep].sum())
            groups.append(np.sort(give)); loads.append(float(sl[give].sum()))
        out[G] = max(loads)
    return out


def inc_curve(sl, rows, Gmax):
    """Grow from 1 group to Gmax with the one-move controller."""
    assign = np.zeros(len(sl), dtype=np.int32)
    out = {1: (float(sl.sum()), 0, 0.0, 1)}
    moves = 0; rmoved = 0.0
    for G in range(2, Gmax + 1):
        r = kern.rebalance(sl, rows, G, assign, TAU)
        moves += r['moves']; rmoved += r['rows']
        out[G] = (r['max'], moves, rmoved, r['reached'])
    return out


def run_one(dist, N, seed, h, h_order, emit, key_contig_max_n):
    w = gen.loads(dist, N, seed)
    total = float(w.sum())
    pmax = float(w.max()) / total
    base = dict(dist=dist, N=N, seed=seed)
    emit(dict(base, kind='part', pmax=pmax, G_part=int(np.floor(1 / pmax)) + 1))
    lb = {G: max(total / G, float(w.max())) for G in GRID}
    # key-level references and fixN
    ws = np.sort(w)[::-1].copy()
    wh = w[h_order].copy() if N <= key_contig_max_n else None
    for G in GRID:
        emit(dict(base, S=0, place='key-lb', G=G, r=lb[G] * G / total, rlb=1.0))
        mx, _, _ = kern.lpt(ws, G)
        emit(dict(base, S=0, place='key-lpt', G=G, r=mx * G / total, rlb=mx / lb[G]))
        if wh is not None:
            mx = kern.best_contig(wh, G)
            emit(dict(base, S=0, place='key-contig', G=G, r=mx * G / total, rlb=mx / lb[G]))
        mx = float(np.bincount(h % np.uint32(G), weights=w, minlength=G).max())
        emit(dict(base, S=0, place='fixN', G=G, r=mx * G / total, rlb=mx / lb[G]))
    for S in gen.SS:
        sl = gen.slot_loads(w, h, S)
        rows = gen.slot_rows(h, S)
        ms = float(sl.max())
        emit(dict(base, kind='slot', S=S, smax=ms / total, G_slot=int(np.floor(total / ms)) + 1,
                  empty=int((rows == 0).sum())))
        sls = np.sort(sl)[::-1].copy()
        Gmax = min(S, GRID[-1])
        inc = inc_curve(sl, rows, Gmax)
        hal = halving_curve(sl, Gmax)
        for G in GRID:
            if G > S:
                continue
            b = (np.arange(G + 1) * S) // G
            mx = float(np.add.reduceat(sl, b[:-1]).max())
            emit(dict(base, S=S, place='ranges-equal', G=G, r=mx * G / total, rlb=mx / lb[G]))
            mx = kern.best_contig(sl, G)
            emit(dict(base, S=S, place='ranges-best', G=G, r=mx * G / total, rlb=mx / lb[G]))
            mx, _, _ = kern.lpt(sls, G)
            emit(dict(base, S=S, place='lpt', G=G, r=mx * G / total, rlb=mx / lb[G]))
            mx, mv, rm, reached = inc[G]
            emit(dict(base, S=S, place='inc', G=G, r=mx * G / total, rlb=mx / lb[G],
                      moves=mv, rows_moved=rm / N, reached=reached))
            mx = hal[G]
            emit(dict(base, S=S, place='halving', G=G, r=mx * G / total, rlb=mx / lb[G]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--N', type=int, nargs='+', default=gen.NS)
    ap.add_argument('--dists', nargs='+', default=gen.DISTS)
    ap.add_argument('--seeds', type=int, default=0, help='override the seed count')
    ap.add_argument('--key-contig-max-n', type=int, default=10**7)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    with open(a.out, 'a') as f:
        def emit(d):
            f.write(json.dumps(d) + '\n')
        for N in a.N:
            for seed in range(a.seeds or gen.seeds_for(N)):
                t0 = time.time()
                h = gen.hashes(N, seed)
                h_order = np.argsort(h, kind='stable') if N <= a.key_contig_max_n else None
                for dist in a.dists:
                    run_one(dist, N, seed, h, h_order, emit, a.key_contig_max_n)
                f.flush()
                print(f'N={N} seed={seed} {time.time() - t0:.1f}s', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
