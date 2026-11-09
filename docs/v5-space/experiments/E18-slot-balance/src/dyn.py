"""E-18 part C: moves needed after a load shift.

A resource sits on G groups, placed by greedy packing for its starting load.
Then its load shifts, epoch after epoch. After each shift the controller
(one move at a time, kern.rebalance) acts if the busiest group is above
1.25 x floor or the least loaded below 0.75 x level, and moves slots until
max <= 1.10 x floor and min >= 0.90 x level, or no single move helps.
floor = max(level, hottest slot); level = the even share once every slot
larger than it sits alone (kern.water_level).

Scenarios (s = Zipf exponent; "split": the app splits partitions above 1/(2G)):
  zipf0.8-churn    s = 0.8; each epoch the 100 hottest ranks move to 100
                   random partitions (a moving hotspot)
  zipf0.99-churn   s = 0.99, split; the same churn
  zipf0.99-drift   s = 0.99, split; each epoch 1 % of all ranks shuffle
  hot-jump         uniform, plus one partition with 1 % of the load that
                   jumps to a random partition each epoch
  reshuffle        s = 0.99, split; one epoch, every rank re-drawn
  uniform-to-zipf  starts uniform; one epoch, becomes s = 0.99, split
  add-group        uniform; one epoch: a new empty group joins (G-1 -> G)
  remove-group     uniform; one epoch: group 0 leaves; its slots must move

Per epoch it records: max/floor right after the shift, whether the controller
acted, its moves, the rows it moved (as a share of the resource's rows), the
end state, and, for comparison, how many rows a fresh greedy packing would
move (its groups matched greedily to the current ones by shared rows).
With --key, the same controller also runs over partitions instead of slots
(a per-key directory: the reference for data moved), for pure scenarios.
"""
import argparse
import json
import sys
import time

import numpy as np

import gen
import kern

EPOCHS = 30
TRIG_HI, TRIG_LO, TAU = 1.25, 0.75, 1.10
CHURN = 100


def zipf_w(N, s):
    return np.arange(1, N + 1, dtype=np.float64) ** -s


class Load:
    """Partition loads under a rank -> partition map, with the app split."""

    def __init__(self, N, seed, h):
        self.N, self.seed, self.h = N, seed, h
        self._ph = {}

    def piece_h(self, pid, k):
        x = self._ph.get(pid)
        if x is None or len(x) < k:
            x = gen.piece_hashes(self.N, self.seed, pid, max(k, 64))
            self._ph[pid] = x
        return x[:k]

    def slot_view(self, w_part, S, G, split):
        total = float(w_part.sum())
        if not split:
            return gen.slot_loads(w_part, self.h, S), total
        cap = total / (2 * G)
        hot = np.nonzero(w_part > cap)[0]
        base = w_part.copy(); base[hot] = 0
        sl = gen.slot_loads(base, self.h, S)
        for pid in hot:
            k = 1
            while w_part[pid] / k > cap:
                k *= 2
            ph = self.piece_h(int(pid), k)
            np.add.at(sl, ph & np.uint32(S - 1), w_part[pid] / k)
        return sl, total


def repack_rows(sl, rows, assign, G):
    """Rows a fresh greedy packing would move, its groups matched greedily."""
    new = kern.lpt_assign(sl, G)
    ov = np.bincount(assign.astype(np.int64) * G + new, weights=rows, minlength=G * G)
    order = np.argsort(-ov, kind='stable')
    used_a = np.zeros(G, bool); used_b = np.zeros(G, bool)
    kept = 0.0
    for k in order:
        if ov[k] <= 0:
            break
        a, b = divmod(int(k), G)
        if not used_a[a] and not used_b[b]:
            used_a[a] = used_b[b] = True
            kept += ov[k]
    return float(rows.sum()) - kept


def act(sl, rows, G, assign, total_rows, force=False):
    level = kern.water_level(sl, G)
    floor = max(level, float(sl.max()))
    loads = np.bincount(assign, weights=sl, minlength=G)
    before = float(loads.max()) / floor
    low = float(loads.min()) / level
    trig = force or before > TRIG_HI or low < TRIG_LO
    rec = dict(r_before=before, low_before=low, acted=int(trig), moves=0, rows=0.0,
               reached=1, pinned=0)
    if trig:
        x = kern.rebalance(sl, rows, G, assign, TAU)
        rec.update(moves=x['moves'], rows=x['rows'] / total_rows, reached=x['reached'],
                   pinned=x['pinned'])
    loads = np.bincount(assign, weights=sl, minlength=G)
    rec['r_after'] = float(loads.max()) / floor
    rec['r_after_mean'] = float(loads.max()) * G / float(sl.sum())
    return rec


def scenario(name, N, S, G, seed, emit, key):
    rng = np.random.default_rng([1821, seed, N, S, G, SCEN.index(name)])
    h = gen.hashes(N, seed)
    L = Load(N, seed, h)
    rows = gen.slot_rows(h, S)
    split = name in ('zipf0.99-churn', 'zipf0.99-drift', 'reshuffle', 'uniform-to-zipf')
    s = 0.8 if name == 'zipf0.8-churn' else 0.99
    perm = rng.permutation(N)                      # rank r lives on partition perm[r]
    hot_pid = int(rng.integers(N))

    def part_w():
        if name in ('hot-jump',):
            w = np.ones(N); w[hot_pid] = 0.01 / 0.99 * (N - 1); return w
        if name in ('add-group', 'remove-group') or (name == 'uniform-to-zipf' and epoch == 0):
            return np.ones(N)
        w = np.empty(N); w[perm] = zipf_w(N, s); return w

    epoch = 0
    G0 = G - 1 if name == 'add-group' else G
    sl, _ = L.slot_view(part_w(), S, G0, split)
    assign = kern.lpt_assign(sl, G0)
    kassign = None
    if key and name in ('zipf0.8-churn', 'hot-jump', 'add-group'):
        kassign = kern.lpt_assign(part_w(), G0)
    n_epochs = EPOCHS if name in ('zipf0.8-churn', 'zipf0.99-churn', 'zipf0.99-drift', 'hot-jump') else 1
    base = dict(scen=name, N=N, S=S, G=G, seed=seed)
    for epoch in range(1, n_epochs + 1):
        force = False
        if name in ('zipf0.8-churn', 'zipf0.99-churn'):
            src = np.arange(CHURN); dst = rng.choice(N, CHURN, replace=False)
            for a, b in zip(src, dst):
                perm[a], perm[b] = perm[b], perm[a]
        elif name == 'zipf0.99-drift':
            idx = rng.choice(N, N // 100, replace=False)
            perm[idx] = perm[rng.permutation(idx)]
        elif name == 'hot-jump':
            hot_pid = int(rng.integers(N))
        elif name == 'reshuffle':
            perm = rng.permutation(N)
        elif name == 'add-group':
            force = True
        elif name == 'remove-group':
            # group 0 leaves: its slots go to the least loaded others first
            gone = assign == 0
            assign[assign == G - 1] = 0          # relabel: the last group takes id 0
            G = G - 1
            sl_now, _ = L.slot_view(part_w(), S, G, split)
            loads = np.bincount(assign[~gone], weights=sl_now[~gone], minlength=G)
            moved_rows = float(rows[gone].sum())
            for i in np.nonzero(gone)[0][np.argsort(-sl_now[gone], kind='stable')]:
                g = int(np.argmin(loads)); assign[i] = g; loads[g] += sl_now[i]
            forced_moves = int(gone.sum())
        w = part_w()
        sl, _ = L.slot_view(w, S, G, split)
        rec = act(sl, rows, G, assign, N, force=force)
        if name == 'remove-group':
            rec['forced_moves'] = forced_moves; rec['forced_rows'] = moved_rows / N
        rec['repack_rows'] = repack_rows(sl, rows, assign, G) / N if name != 'remove-group' else None
        if kassign is not None:
            kr = act(w, np.ones(N), G, kassign, N, force=force)
            rec.update({'key_' + k: v for k, v in kr.items() if k in ('moves', 'rows', 'r_after', 'acted', 'reached')})
        emit(dict(base, epoch=epoch, **rec))


SCEN = ['zipf0.8-churn', 'zipf0.99-churn', 'zipf0.99-drift', 'hot-jump', 'reshuffle',
        'uniform-to-zipf', 'add-group', 'remove-group']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--N', type=int, nargs='+', default=[10**4, 10**6])
    ap.add_argument('--G', type=int, nargs='+', default=[16, 64, 256])
    ap.add_argument('--scen', nargs='+', default=SCEN)
    ap.add_argument('--seeds', type=int, default=3)
    ap.add_argument('--key-max-n', type=int, default=10**4)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    with open(a.out, 'a') as f:
        def emit(d):
            f.write(json.dumps(d) + '\n')
        for N in a.N:
            for name in a.scen:
                for S in gen.SS:
                    for G in a.G:
                        if G > S:
                            continue
                        for seed in range(a.seeds):
                            t0 = time.time()
                            scenario(name, N, S, G, seed, emit, key=N <= a.key_max_n)
                            f.flush()
                            print(f'{name} N={N} S={S} G={G} seed={seed} {time.time() - t0:.1f}s',
                                  file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
