"""E-18 part B: the effective writers per resource (SC-10).

For each distribution, N, seed and slot count S, it computes max/mean at every
group count G = 1 .. min(S, 1024), for two placements (lpt: greedy packing from
scratch; inc: one move at a time, groups added one by one) and two workloads:

  pure    the distribution as drawn: a partition may carry several percent of
          the load (Zipf 0.99's hottest partition carries 5.5 to 9.8 %)
  split   the app splits every partition whose share is above half a fair
          share, c/G with c = 0.5 (--split-c), into 2^k equal pieces that hash
          on their own (DESIGN-V5 §2: "The app splits it (room42-0 ... room42-3)")

From each curve r(G) = max/mean:
  E      the largest G such that r(G') <= 1.25 for every G' <= G (SC-10's
         effective writers, searched to 1,024)
  Eany   the largest G with r(G) <= 1.25
  E07    the largest G such that G'/r(G') >= 0.7 G' for every G' <= G
         (SC-03's 0.7 x n, i.e. r <= 1/0.7)
  Wmax   the most writer-equivalents, max over G of G / r(G): the throughput
         of the resource in units of one writer when its busiest group is full
Key-level ideal: Ekey = the largest G with max(1, pmax G) <= 1.25.
Also fixN (hash straight onto G groups) at G = 16 (CELL) and 64 (LANE).

One JSON line per (dist, N, seed, S, variant, place); with --curves, the full
r(G) curves go to a second file.
"""
import argparse
import json
import sys
import time

import numpy as np

import gen
import kern

GMAX = 1024
TAU = 1.10


def summarize(r):
    """r[G-1] = max/mean at G groups."""
    G = np.arange(1, len(r) + 1)
    ok = r <= 1.25 + 1e-12
    E = int(np.argmin(ok)) if not ok.all() else len(r)
    Eany = int(G[ok].max()) if ok.any() else 0
    ok7 = r <= 1 / 0.7 + 1e-12
    E07 = int(np.argmin(ok7)) if not ok7.all() else len(r)
    W = G / r
    i = int(np.argmax(W))
    return dict(E=E, Eany=Eany, E07=E07, Wmax=float(W[i]), G_Wmax=int(G[i]),
                r16=float(r[15]) if len(r) >= 16 else None,
                r64=float(r[63]) if len(r) >= 64 else None,
                r256=float(r[255]) if len(r) >= 256 else None,
                r1024=float(r[1023]) if len(r) >= 1024 else None)


def run_one(dist, N, seed, h, emit, curves, c=0.5):
    w = gen.loads(dist, N, seed)
    total = float(w.sum())
    pmax = float(w.max()) / total
    base = dict(dist=dist, N=N, seed=seed, c=c)
    Ekey = min(GMAX, int(np.floor(1.25 / pmax + 1e-12)))
    emit(dict(base, kind='key', pmax=pmax, Ekey=Ekey, Wkey=min(GMAX, 1 / pmax)))
    split = gen.AppSplit(w, h, N, seed, min_cap=c / GMAX)
    # fixN for CELL (16) and LANE (64), pure and split
    for G in (16, 64):
        mx = float(np.bincount(h % np.uint32(G), weights=w, minlength=G).max())
        pw, ph = split.pieces(c / G)
        sl = np.bincount(h % np.uint32(G), weights=split.base_w, minlength=G)
        if len(pw):
            sl += np.bincount(ph % np.uint32(G), weights=pw, minlength=G)
        emit(dict(base, kind='fixN', G=G, r_pure=mx * G / total, r_split=float(sl.max()) * G / total))
    caps = [c / G for G in range(1, GMAX + 1)]
    pieces = [split.pieces(c) for c in caps]
    for S in gen.SS:
        Gm = min(S, GMAX)
        rows = gen.slot_rows(h, S)
        sl = gen.slot_loads(w, h, S)
        base_sl = gen.slot_loads(split.base_w, h, S)
        # pure
        sls = np.sort(sl)[::-1].copy()
        r_lpt = np.array([kern.lpt(sls, G)[0] * G / total for G in range(1, Gm + 1)])
        assign = np.zeros(S, dtype=np.int32)
        r_inc = np.empty(Gm); mv = np.zeros(Gm); rm = np.zeros(Gm)
        r_inc[0] = 1.0; moves = 0; rmoved = 0.0; capped = 0
        for G in range(2, Gm + 1):
            x = kern.rebalance(sl, rows, G, assign, TAU)
            moves += x['moves']; rmoved += x['rows']; capped += x['reached'] == -1
            r_inc[G - 1] = x['max'] * G / total; mv[G - 1] = moves; rm[G - 1] = rmoved / N
        # split: the app re-splits as G grows; the controller keeps its slots
        r_slpt = np.empty(Gm); r_sinc = np.empty(Gm)
        assign = np.zeros(S, dtype=np.int32)
        smoves = 0; scapped = 0
        for G in range(1, Gm + 1):
            pw, ph = pieces[G - 1]
            slG = base_sl + (np.bincount(ph & np.uint32(S - 1), weights=pw, minlength=S) if len(pw) else 0)
            r_slpt[G - 1] = kern.lpt(np.sort(slG)[::-1].copy(), G)[0] * G / total
            if G == 1:
                r_sinc[0] = 1.0
            else:
                x = kern.rebalance(slG, rows, G, assign, TAU)
                smoves += x['moves']; scapped += x['reached'] == -1
                r_sinc[G - 1] = x['max'] * G / total
        for variant, place, r, extra in (
                ('pure', 'lpt', r_lpt, {}),
                ('pure', 'inc', r_inc, dict(moves64=float(mv[63]) if Gm >= 64 else None,
                                            rows64=float(rm[63]) if Gm >= 64 else None,
                                            moves_end=float(mv[-1]), rows_end=float(rm[-1]), capped=capped)),
                ('split', 'lpt', r_slpt, {}),
                ('split', 'inc', r_sinc, dict(moves_end=smoves, capped=scapped))):
            emit(dict(base, kind='eff', S=S, variant=variant, place=place, **summarize(r), **extra))
            if curves is not None:
                curves(dict(base, S=S, variant=variant, place=place, r=[round(float(v), 5) for v in r]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--N', type=int, nargs='+', default=gen.NS)
    ap.add_argument('--dists', nargs='+', default=gen.DISTS)
    ap.add_argument('--seeds', type=int, nargs='+', default=None,
                    help='seed counts per N (default: 10 5 3 2 for zipf-0.99, 3 2 2 1 for others)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--curves', default=None)
    ap.add_argument('--split-c', type=float, default=0.5,
                    help='the app splits partitions above c/G of the load (default 0.5)')
    a = ap.parse_args()
    fc = open(a.curves, 'a') if a.curves else None
    with open(a.out, 'a') as f:
        def emit(d):
            f.write(json.dumps(d) + '\n')
        def curve(d):
            fc.write(json.dumps(d) + '\n')
        for N in a.N:
            ni = gen.NS.index(N)
            for dist in a.dists:
                if a.seeds:
                    ns = a.seeds[ni]
                else:
                    ns = [10, 5, 3, 2][ni] if dist == 'zipf-0.99' else [3, 2, 2, 1][ni]
                for seed in range(ns):
                    t0 = time.time()
                    h = gen.hashes(N, seed)
                    run_one(dist, N, seed, h, emit, curve if fc else None, a.split_c)
                    f.flush()
                    if fc:
                        fc.flush()
                    print(f'{dist} N={N} seed={seed} {time.time() - t0:.1f}s', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
