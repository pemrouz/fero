"""E-18 part D: is the random stand-in for the hash fair to real hashes?

The other parts give each partition a random 32-bit hash. Here the hashes are
real ones of real key names ('room0', 'room1', ...), and slot = hash mod S.
For each hash it reports, at S = 1,024 and 16,384: the busiest slot's
partition count over the mean, the chi-square statistic over its degrees of
freedom (about 1 for a fair hash), and max/mean of greedy packing at G = 64
and 256 for uniform load and for Zipf 0.99 with the app split.
Hashes: CRC-32 (zlib), FNV-1a 32-bit, the first 4 bytes of BLAKE2b and of MD5
(hashlib), and the random stand-in (5 seeds, for the spread).
"""
import hashlib
import json
import sys
import zlib

import numpy as np

import gen
import kern


def fnv1a32(b):
    h = 0x811C9DC5
    for c in b:
        h ^= c
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


HASHES = {
    'crc32': lambda b: zlib.crc32(b),
    'fnv1a32': fnv1a32,
    'blake2b': lambda b: int.from_bytes(hashlib.blake2b(b, digest_size=8).digest()[:4], 'little'),
    'md5': lambda b: int.from_bytes(hashlib.md5(b).digest()[:4], 'little'),
}


def measure(h, N, seed, out, label):
    for S in (1024, 16384):
        c = gen.slot_rows(h, S)
        m = N / S
        chi = float(((c - m) ** 2 / m).sum()) / (S - 1)
        rec = dict(hash=label, N=N, S=S, seed=seed, rows_max_over_mean=float(c.max() / m), chi2_per_dof=chi)
        for dist in ('uniform', 'zipf-0.99'):
            w = gen.loads(dist, N, 0)
            total = float(w.sum())
            for G in (64, 256):
                if dist == 'uniform':
                    sl = gen.slot_loads(w, h, S)
                else:
                    sp = gen.AppSplit(w, h, N, 0, min_cap=1 / (2 * G))
                    sl = sp.slot_loads(S, 1 / (2 * G))
                mx = kern.lpt(np.sort(sl)[::-1].copy(), G)[0]
                rec[f'{dist}_G{G}'] = mx * G / total
        out.write(json.dumps(rec) + '\n')
        print(rec, file=sys.stderr, flush=True)


def main():
    out = open(sys.argv[1], 'a')
    for N in (10**4, 10**6):
        keys = [f'room{i}'.encode() for i in range(N)]
        for name, fn in HASHES.items():
            h = np.fromiter((fn(k) for k in keys), dtype=np.uint32, count=N)
            measure(h, N, 0, out, name)
        for seed in range(5):
            measure(gen.hashes(N, seed), N, seed, out, 'random')


if __name__ == '__main__':
    main()
