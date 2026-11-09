"""E-18 self-test: the C kernels against their plain-Python twins and against
brute force, on random small inputs. Integer loads keep float sums exact, so
tie-breaks match bit for bit. Prints one line per check and 'selftest ok'."""
import itertools
import random
import sys

import numpy as np

import kern
import gen


def brute_opt(w, G):
    best = float('inf')
    for a in itertools.product(range(G), repeat=len(w)):
        loads = [0] * G
        for x, g in zip(w, a):
            loads[g] += x
        best = min(best, max(loads))
    return best


def main():
    rnd = random.Random(18)
    n_lpt = n_contig = n_reb = n_opt = n_pin = n_stuck = n_tie = 0
    worst_lpt_ratio = 0.0
    for trial in range(400):
        n = rnd.randint(1, 60)
        G = rnd.randint(1, 12)
        kind = rnd.choice(['small', 'skew', 'ties'])
        if kind == 'small':
            w = [rnd.randint(0, 20) for _ in range(n)]
        elif kind == 'skew':
            w = [int(1000 / (r + 1) ** 1.1) for r in range(n)]
            rnd.shuffle(w)
        else:
            w = [rnd.choice([0, 5, 5, 10]) for _ in range(n)]
        ws = sorted(w, reverse=True)
        # LPT: same loads and same assignment as the twin
        mx, loads, a = kern.lpt(np.array(ws, float), G, want_assign=True)
        pmx, ploads, pa = kern.py_lpt(ws, G)
        assert mx == pmx and list(loads) == ploads and list(a) == pa, ('lpt', trial)
        assert abs(sum(loads) - sum(w)) < 1e-9
        lb = max(sum(w) / G, max(w))
        assert mx >= lb - 1e-9
        n_lpt += 1
        # best contiguous: bisection against the exact DP
        if n <= 30:
            c = kern.best_contig(np.array(w, float), G)
            e = kern.py_best_contig_exact(w, G)
            assert e - 1e-9 <= c <= e * (1 + 1e-9) + 1e-12, ('contig', trial, c, e)
            n_contig += 1
        # LPT within 4/3 of the true optimum (Graham 1969), on tiny inputs
        if n <= 8 and G <= 3:
            opt = brute_opt(w, G)
            if opt > 0:
                worst_lpt_ratio = max(worst_lpt_ratio, mx / opt)
                assert mx <= 4 / 3 * opt + 1e-9, ('graham', trial)
            n_opt += 1
        # rebalance: same moves and same end as the twin, from a random start
        start = [rnd.randrange(G) for _ in range(n)]
        rows = [rnd.randint(1, 5) for _ in range(n)]
        for tau in (1.0, 1.1, 1.25):
            ac = np.array(start, dtype=np.int32)
            r = kern.rebalance(np.array(w, float), np.array(rows, float), G, ac, tau)
            pr, pa2 = kern.py_rebalance(w, rows, G, start, tau)
            assert list(ac) == pa2, ('rebalance assign', trial, tau)
            for k in ('moves', 'rows', 'max', 'reached', 'min', 'pinned'):
                assert r[k] == pr[k], ('rebalance', k, trial, tau, r[k], pr[k])
            assert abs(r['level'] - pr['level']) < 1e-9
            loads = [0.0] * G
            for x, g in zip(w, pa2):
                loads[g] += x
            if r['reached'] == 1:
                assert min(loads) >= (2 - tau) * r['level'] - 1e-9
            # every group with load above the band holds no item that one move
            # to the least loaded group could take without passing it
            b_ = min(range(G), key=lambda g: (loads[g], g))
            for a_ in range(G):
                if loads[a_] > tau * r['floor'] + 1e-9 and r['reached'] != -1:
                    gap = loads[a_] - loads[b_]
                    assert not any(pa2[i] == a_ and 0 < w[i] < gap for i in range(n)), ('stuck', trial)
            n_reb += 1
            n_pin += r['pinned'] > 0
            n_stuck += r['reached'] == 0
    # regression: equal pieces whose float sums round so that w == gap looks
    # smaller than gap made the controller swap one piece back and forth for
    # ever (found in part B at S = 16,384, G = 611). It must stop quickly.
    for trial in range(300):
        G = rnd.randint(2, 40); k = rnd.choice([3, 5, 6, 7, 10, 12, 24, 48, 96])
        piece = rnd.choice([0.1, 1 / 3, 1 / 7, 0.3, 1 / 64, 1 / 96]) * rnd.random()
        w = [piece] * k + [rnd.random() * piece * 0.01 for _ in range(rnd.randint(0, 5))]
        n = len(w)
        start = np.array([rnd.randrange(G) for _ in range(n)], dtype=np.int32)
        r = kern.rebalance(np.array(w, float), np.ones(n), G, start.copy(), 1.0, maxmoves=100000)
        assert r['reached'] != -1, ('ping-pong', trial, r)
        pr, _ = kern.py_rebalance(w, [1.0] * n, G, list(start), 1.0, maxmoves=100000)
        assert pr['reached'] != -1, ('ping-pong twin', trial)
        n_tie += 1
    # more tiny cases for the brute-force optimum
    for trial in range(300):
        n = rnd.randint(3, 9); G = rnd.randint(2, 3)
        w = [rnd.choice([1, 2, 3, 5, 8, 13, 40]) for _ in range(n)]
        mx, _, _ = kern.lpt(np.array(sorted(w, reverse=True), float), G)
        opt = brute_opt(w, G)
        worst_lpt_ratio = max(worst_lpt_ratio, mx / opt)
        assert mx <= 4 / 3 * opt + 1e-9, ('graham', trial)
        n_opt += 1
    # water level in numpy equals the C one
    for trial in range(200):
        n = rnd.randint(1, 80); G = rnd.randint(1, 20)
        w = np.array([rnd.choice([1, 1, 2, 50, 300]) for _ in range(n)], float)
        assert abs(kern.water_level(w, G) - kern.py_water_level(list(w), G)) < 1e-9
    # generators: shares and nesting of slots
    h = gen.hashes(10**4, 0)
    for S in gen.SS[1:]:
        assert np.array_equal(h & np.uint32(S // 4 - 1), (h & np.uint32(S - 1)) & np.uint32(S // 4 - 1))
    w = gen.loads('hot-0.1', 10**4, 0)
    assert abs(w[0] / w.sum() - 0.1) < 1e-12
    print(f'lpt vs twin: {n_lpt} cases equal; contiguous vs exact DP: {n_contig} cases within 1e-9')
    print(f'lpt vs brute-force optimum: {n_opt} cases, worst ratio {worst_lpt_ratio:.4f} (bound 4/3)')
    print(f'rebalance vs twin: {n_reb} cases equal (moves, rows, max, min, reached, pinned, assignment); '
          f'{n_pin} with a pinned group, {n_stuck} stuck')
    print(f'equal pieces (the float-tie ping-pong regression): {n_tie} cases end, in C and in the twin')
    print('water level numpy vs twin: 200 cases equal; slot nesting and hot share: ok')
    print('selftest ok')


if __name__ == '__main__':
    sys.exit(main())
