"""E-18: the workloads. Each partition gets a load (writes a second, any unit)
and a 32-bit hash. A partition's slot is hash mod S, so one partition sits in
the "same" slot at every slot count (slot at 1,024 = slot at 4,096 mod 1,024).

Distributions (the load of each partition):
  uniform     every partition the same
  zipf-s      partition of rank r gets r^-s (s = 0.8, 0.99, 1.2); ranks are
              independent of hashes, so hot partitions land in random slots
  pareto-a    room sizes from a Pareto law with shape a (x_m = 1); load is
              proportional to size (a = 1.16 is the 80/20 rule; a = 2 lighter)
  hot-h       uniform, plus partition 0 carries a share h of the whole load
The hashes come from numpy's PCG64 generator (a stand-in for a good hash;
hashcheck.py compares it with real hashes of real key names).
"""
import numpy as np

DISTS = ['uniform', 'zipf-0.8', 'zipf-0.99', 'zipf-1.2', 'pareto-1.16',
         'pareto-2', 'hot-0.01', 'hot-0.1']
DIST_CODE = {d: i for i, d in enumerate(DISTS)}
NS = [10**4, 10**5, 10**6, 10**7]
SS = [256, 1024, 4096, 16384]


def seeds_for(N):
    return {10**4: 10, 10**5: 10, 10**6: 5, 10**7: 3}[N]


def hashes(N, seed):
    rng = np.random.default_rng([1818, seed, N])
    return rng.integers(0, 2**32, N, dtype=np.uint32)


def loads(dist, N, seed):
    rng = np.random.default_rng([1819, seed, N, DIST_CODE.get(dist, 99)])
    if dist == 'uniform':
        return np.ones(N)
    if dist.startswith('zipf-'):
        s = float(dist[5:])
        return np.arange(1, N + 1, dtype=np.float64) ** -s
    if dist.startswith('pareto-'):
        a = float(dist[7:])
        return rng.pareto(a, N) + 1.0
    if dist.startswith('hot-'):
        h = float(dist[4:])
        w = np.ones(N)
        w[0] = h / (1 - h) * (N - 1)
        return w
    raise ValueError(dist)


def piece_hashes(N, seed, idx, k):
    """The hashes of pieces 0..k-1 of partition idx when the app splits it
    (room42-0, room42-1, ...): piece j keeps its hash whatever k is."""
    rng = np.random.default_rng([1820, seed, N, int(idx)])
    return rng.integers(0, 2**32, k, dtype=np.uint32)


def slot_loads(w, h, S):
    return np.bincount(h & np.uint32(S - 1), weights=w, minlength=S)


def slot_rows(h, S):
    return np.bincount(h & np.uint32(S - 1), minlength=S).astype(np.float64)


class AppSplit:
    """The app splits a partition whose share of the load is above cap into
    the smallest power of two of equal pieces that brings each piece to cap or
    below (DESIGN-V5 §2: "The app splits it (room42-0 ... room42-3)").
    Pieces hash on their own. Only partitions above min_cap are ever split."""

    def __init__(self, w, h, N, seed, min_cap, kmax=4096):
        total = float(w.sum())
        self.total = total
        share = w / total
        self.hot = np.nonzero(share > min_cap)[0]
        self.hot_share = share[self.hot]
        self.base_w = w.copy()
        self.base_w[self.hot] = 0.0
        self.h = h
        self.kmax = kmax
        self.ph = [piece_hashes(N, seed, i, kmax) for i in self.hot]

    def pieces(self, cap):
        """Partition-level view at this cap: (weights, hashes) of the pieces."""
        ws, hs = [], []
        for s, ph in zip(self.hot_share, self.ph):
            k = 1
            while s / k > cap:
                k *= 2
            if k > self.kmax:
                raise ValueError('kmax too small')
            ws.append(np.full(k, s * self.total / k))
            hs.append(ph[:k])
        if not ws:
            return np.zeros(0), np.zeros(0, dtype=np.uint32)
        return np.concatenate(ws), np.concatenate(hs)

    def ks(self, cap):
        """How many pieces each hot partition is split into at this cap."""
        out = []
        for s in self.hot_share:
            k = 1
            while s / k > cap:
                k *= 2
            out.append(k)
        return tuple(out)

    def slot_loads(self, S, cap, base=None):
        if base is None:
            base = slot_loads(self.base_w, self.h, S)
        pw, ph = self.pieces(cap)
        return base + np.bincount(ph & np.uint32(S - 1), weights=pw, minlength=S)

    def max_piece_share(self, cap):
        pw, _ = self.pieces(cap)
        rest = float(self.base_w.max()) if len(self.base_w) else 0.0
        return max(float(pw.max()) if len(pw) else 0.0, rest) / self.total
