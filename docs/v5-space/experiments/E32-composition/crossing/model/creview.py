#!/usr/bin/env python3
"""
creview.py: the review's own checks of E-32 (b) (README, "Review").

    python3 model/creview.py plant [--work DIR]   four planted bugs, each in a copy of the model
    python3 model/creview.py stale [BOUND ...]     does any election ever see a voter behind the log?

PLANT. The mutant script (cmut.py) mutates only rules written in the rule
language. These four bugs sit in the helper code it never touches, where the
log drop meets the move, the reader or Raft. Each is one edit, made by exact
string replacement in a copy of model/ (under --work, default $SP/e32b/plant),
and each copy is run on the smallest bound first, then on the smallest bound
that reaches the bug:
  b1 (a guard)   final_cp() loses its END check: a bulk copy counts as the final
                 copy. It is read by final.once (the move) and by snap.nomove
                 (the log drop).
  b2 (an update) strip() keeps a copy fact in a snapshot without its END(N).
  b3 (a guard)   the reader's no-skip check ignores records kept only in a
                 snapshot.
  b4 (a guard)   elections lose Raft's log check (cworld.py).

STALE. Raft's log check in elections decides something only in a state where a
group has no leader and a live voter of its committed config does not hold
every committed entry while another live voter does. This explores a bound with
that predicate as an extra safety check, so the first such state is reported
with its trace.
"""

import os
import subprocess
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
EXPS = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')

BUGS = {
    'b1': ('a guard: a bulk copy counts as the final copy (final_cp loses its END check)', 'crossing.py',
           "return any(e[0] == 'cp' and e[1] == name and e[8] >= 0 for _, e in F)",
           "return any(e[0] == 'cp' and e[1] == name for _, e in F)",
           ('src',)),
    'b2': ('an update: a snapshot keeps a copy fact without its END(N)', 'crossing.py',
           "return ('cp', e[1], e[2], 0, (), E0, 0, 0, e[8], 0, 0)",
           "return ('cp', e[1], e[2], 0, (), E0, 0, 0, -1, 0, 0)",
           ('src', 'dst')),
    'b3': ("a guard: the reader's no-skip check ignores records kept only in a snapshot", 'crossing.py',
           "                if e[0] == 'snap' and any(cur < q < pos for a, q in e[4][SI['s']]):\n"
           "                    return False\n",
           "",
           ('src', 'read-src', 'read-dst', 'read2-src', 'read2-dst')),
    'b4': ("a guard: elections lose Raft's log check", 'cworld.py',
           "grants = sum(1 for v in vot if self.alive(st, v) and (v not in held or c in held))",
           "grants = sum(1 for v in vot if self.alive(st, v))",
           ('src', 'crash-src', 'crash2-src')),
}


def plant(work):
    for name, (what, fname, old, new, bounds) in BUGS.items():
        root = os.path.join(work, name)
        mdir = os.path.join(root, 'E32-composition', 'crossing', 'model')
        os.makedirs(mdir, exist_ok=True)
        for f in sorted(os.listdir(HERE)):
            if f.endswith('.py'):
                with open(os.path.join(HERE, f)) as src, open(os.path.join(mdir, f), 'w') as dst:
                    dst.write(src.read())
        for d in ('E17-partitioning', 'E16-controller-loop'):
            link = os.path.join(root, d)
            if not os.path.islink(link):
                os.symlink(os.path.join(EXPS, d), link)
        p = os.path.join(mdir, fname)
        s = open(p).read()
        assert s.count(old) == 1, (name, 'the text to change is not in the model exactly once')
        open(p, 'w').write(s.replace(old, new))
        print(f'{name} ({what}), in {fname}', flush=True)
        for b in bounds:
            out = subprocess.run([sys.executable, os.path.join(mdir, 'crun.py'), '--bound', b],
                                 capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            lines = out.stdout.splitlines() or [out.stderr.strip()]
            for ln in lines[:40]:
                print('   ' + ln, flush=True)
            if len(lines) > 1:
                break                       # caught: the larger bounds are not needed


def stale(bounds, limit):
    sys.path.insert(0, HERE)
    from cworld import CWorld
    from cexplore import explore
    from cbounds import BOUNDS
    from crossing import Crossing

    class Stale(CWorld):
        def check(self, st):
            bad = super().check(st)
            for g in range(self.K):
                ldr, held = st[0][g][4], st[0][g][5]
                if ldr is not None:
                    continue
                live = [v for v in self.cfg(st, g)[0] if self.alive(st, v)]
                if any(v not in held for v in live) and any(v in held for v in live):
                    bad.append('STALE')
                    break
            return bad

    for b in bounds:
        r = explore(Stale(Crossing, BOUNDS[b]), stop_first=True, liveness=False, limit=limit)
        hit = 'STALE' in r.fail
        print(f'{b:11} {r.states:,} states{"" if r.complete else " (partial)"}: '
              + (f'a voter behind the log at an election after {r.fail["STALE"][0]} steps' if hit
                 else 'no election ever sees a voter behind the log'), flush=True)
        if hit:
            for k, lab in enumerate(r.fail['STALE'][1], 1):
                print(f'      {k:2}. {" ".join(map(str, lab))}')


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(2)
    if a[0] == 'plant':
        work = a[a.index('--work') + 1] if '--work' in a else os.path.join(SP, 'e32b', 'plant')
        plant(work)
    elif a[0] == 'stale':
        limit = 1_000_000
        if '--limit' in a:
            i = a.index('--limit')
            limit = int(a[i + 1])
            a = a[:i] + a[i + 2:]
        stale(a[1:] or ['src', 'dst', 'crash-src', 'crash-dst', 'giveup-dst', 'crash2-src'], limit)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main()
