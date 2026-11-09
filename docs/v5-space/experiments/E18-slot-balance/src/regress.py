"""E-18: the float-tie ping-pong regression, run against whichever kern.so
E18_BUILD points at. run.sh builds kern.c twice, with the margin (EPS = 1e-9,
the fix) and without it (EPS = 0, the kernel before the fix), and runs this on
both. The cases are those of selftest.py's regression block."""
import random
import sys

import numpy as np

import kern


def main():
    rnd = random.Random(18)
    never = 0
    for trial in range(300):
        G = rnd.randint(2, 40); k = rnd.choice([3, 5, 6, 7, 10, 12, 24, 48, 96])
        piece = rnd.choice([0.1, 1 / 3, 1 / 7, 0.3, 1 / 64, 1 / 96]) * rnd.random()
        w = [piece] * k + [rnd.random() * piece * 0.01 for _ in range(rnd.randint(0, 5))]
        n = len(w)
        start = np.array([rnd.randrange(G) for _ in range(n)], dtype=np.int32)
        r = kern.rebalance(np.array(w, float), np.ones(n), G, start.copy(), 1.0, maxmoves=100000)
        never += r['reached'] == -1
    print(f'{sys.argv[1] if len(sys.argv) > 1 else "kernel"}: cases that never end: {never} of 300')


if __name__ == '__main__':
    main()
