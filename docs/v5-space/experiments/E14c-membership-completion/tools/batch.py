#!/usr/bin/env python3
"""batch.py: several E-14c steps in ONE hold of the study's heavy lock.

  $SP/bin/heavy python3 tools/batch.py --budget 1500 'python3 tools/jarcheck.py' 'python3 tools/live.py r21'

Each argument after the options is one command, run in order from the
experiment folder. Inside, TLC is not wrapped in the lock again
(E14C_INHOLD=1), and every TLC run stops by the hold's deadline
(E14C_DEADLINE): a liveness run then resumes from its checkpoint in the
next hold, and a step not reached is printed as skipped. So one hold lasts
at most --budget seconds plus a minute or two of wrapping up.
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    a = sys.argv[1:]
    budget = 1500
    if a and a[0] == '--budget':
        budget = int(a[1])
        a = a[2:]
    t0 = time.time()
    env = dict(os.environ, E14C_INHOLD='1', E14C_DEADLINE=str(t0 + budget))
    print('batch: hold taken at %s, budget %d s, load %s' % (time.strftime('%H:%M:%S'), budget,
                                                           open('/proc/loadavg').read().strip()), flush=True)
    for cmd in a:
        left = t0 + budget - time.time()
        if left < 240:
            print('batch: skipped (no time left): %s' % cmd, flush=True)
            continue
        t1 = time.time()
        print('batch: start %s' % cmd, flush=True)
        subprocess.run(cmd, shell=True, cwd=HERE, env=env)
        print('batch: done in %.0f s: %s' % (time.time() - t1, cmd), flush=True)
    print('batch: hold released after %.0f s' % (time.time() - t0), flush=True)


if __name__ == '__main__':
    main()
