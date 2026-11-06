#!/usr/bin/env python3
"""mutate_run.py: run every DEV-10 mutant of E-14's membership rules.

Each mutant (tools/mutants.py) runs on the scenarios below with TLC's
random simulation (-simulate: random behaviors to a fixed depth, every state
checked against the safety invariants), for a fixed time each. The design
runs the same way first and must break nothing. A mutant is "caught" when
some run breaks an invariant. Simulation cannot show that a mutant is safe:
"not caught" means no violation was found in that time, not that none
exists. The exhaustive runs of run.py are too large to repeat per mutant on
this box, so this is the honest bound on what was tried.

Usage: mutate_run.py [--only SUBSTR] [--secs S] [--slice K/N] [--no-design]
  --slice K/N runs the K-th of N equal slices of the mutant list (so each
  slice can hold the heavy lock for under 30 minutes); --table only writes
  results/mutants.txt from the per-mutant files.
Writes results/mutants/<mutant>.txt and results/mutants.txt (a table).
"""
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run as R  # noqa: E402
import mutants as M  # noqa: E402

# Scenarios: every membership action, a crash, a lost disk with a spare id;
# no lease and no reductions beyond run.py's defaults, so elections may race.
MUT_SCEN = [
    ('two', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=1, AllowDrop=False, AllowStepDown=True,
                 LeaderLease=False, MaxTermLimit=5)),
    ('three+spare', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=1, AllowLoseDisk=True, AllowDrop=False,
                         AllowStepDown=True, LeaderLease=False, MaxTermLimit=5)),
]
DEPTH = 80


def run_one(tag, tla_dir, scen, kw, secs):
    r = dict(scen=scen, kw=kw, dot=False, sym=False, invs=R.SAFETY)
    name = 'mut-%s-%s' % (tag, scen.replace('+', '_'))
    wd = R.prepare(name, r, tla_dir=tla_dir)
    os.remove(os.path.join(R.HERE, 'cfg', name + '.cfg'))   # keep cfg/ for the design runs only
    out, wall = R.tlc(wd, name + '.cfg', 'MCferoraft.tla', timeout=secs,
                      extra=['-simulate', '-depth', str(DEPTH), '-seed', '1'])
    m = re.search(r'Error: Invariant (\w+) is violated', out)
    traces = re.search(r'([\d,]+) states generated', out)
    shutil.rmtree(wd, ignore_errors=True)
    err = None
    if 'Error' in out and not m and 'TLC threw' in out:
        err = 'TLC error'
    return dict(violated=m.group(1) if m else None, log=R.trim(out), wall=wall,
                states=traces.group(1) if traces else '?', err=err)


def main():
    args = sys.argv[1:]
    only = args[args.index('--only') + 1] if '--only' in args else None
    secs = int(args[args.index('--secs') + 1]) if '--secs' in args else 150
    outdir = os.path.join(R.HERE, 'results', 'mutants')
    os.makedirs(outdir, exist_ok=True)
    mdir = os.path.join(R.WORK, 'mutants-src')
    shutil.rmtree(mdir, ignore_errors=True)
    lines, muts = M.mutants()
    sys.argv = ['mutants.py', '--write', mdir]
    M.main()
    if '--slice' in args:
        k, n = [int(x) for x in args[args.index('--slice') + 1].split('/')]
        muts = [m for i, m in enumerate(muts) if i % n == k - 1]
    rows = []
    base = {}
    if '--table' in args:
        return table(muts, outdir)
    for scen, kw in ([] if '--no-design' in args else MUT_SCEN):
        base[scen] = run_one('design', os.path.join(R.HERE, 'tla'), scen, kw, secs)
        print('design %-12s violated %s, %s states, %.0f s' % (scen, base[scen]['violated'], base[scen]['states'],
                                                              base[scen]['wall']), flush=True)
    for name, k, new, old in muts:
        if only and only not in name:
            continue
        safe = re.sub(r'[^A-Za-z0-9_.-]', '_', name)
        tla_dir = os.path.join(R.WORK, 'mut-tla', safe)
        shutil.rmtree(tla_dir, ignore_errors=True)
        shutil.copytree(os.path.join(R.HERE, 'tla'), tla_dir)
        shutil.copy(os.path.join(mdir, safe, 'MCferoraft.tla'), os.path.join(tla_dir, 'MCferoraft.tla'))
        how, detail = [], []
        for scen, kw in MUT_SCEN:
            s = run_one(safe[:40], tla_dir, scen, kw, secs)
            detail.append('== %s: violated %s, %s states, %.0f s\n%s' % (scen, s['violated'], s['states'], s['wall'],
                                                                         s['log'][-20000:]))
            if s['violated']:
                how.append('%s: %s' % (scen, s['violated']))
            if s['err']:
                how.append('%s: TLC error' % scen)
        verdict = 'caught' if any('TLC error' not in h for h in how) else 'not caught'
        rows.append((name, old, verdict, '; '.join(how)))
        with open(os.path.join(outdir, safe + '.txt'), 'w') as f:
            f.write('%s\n%s\n-> %s\n\n' % (name, old, new.strip()))
            f.write('\n'.join(detail))
        print('%-60s %-11s %s' % (name, verdict, '; '.join(how)), flush=True)
        shutil.rmtree(tla_dir, ignore_errors=True)
    if base:
        with open(os.path.join(outdir, '_design.txt'), 'w') as f:
            for scen, kw in MUT_SCEN:
                f.write('%s %s: violated %s, %s states, %.0f s\n%s\n' % (
                    scen, kw, base[scen]['violated'], base[scen]['states'], base[scen]['wall'], base[scen]['log'][-3000:]))


def table(muts, outdir):
    rows = []
    for name, k, new, old in muts:
        safe = re.sub(r'[^A-Za-z0-9_.-]', '_', name)
        p = os.path.join(outdir, safe + '.txt')
        if not os.path.exists(p):
            rows.append((name, old, 'not run', ''))
            continue
        t = open(p).read()
        how = ['%s: %s' % (sc, v) for sc, v in re.findall(r'^== (\S+): violated (\w+)', t, re.M) if v != 'None']
        rows.append((name, old, 'caught' if how else 'not caught', '; '.join(how)))
    with open(os.path.join(R.HERE, 'results', 'mutants.txt'), 'w') as f:
        f.write('# DEV-10 mutants of the membership rules (tools/mutants.py): TLC -simulate -depth %d, one run per scenario:\n' % DEPTH)
        for scen, kw in MUT_SCEN:
            f.write('#   %s %s\n' % (scen, kw))
        dp = os.path.join(outdir, '_design.txt')
        if os.path.exists(dp):
            for line in open(dp):
                if ': violated' in line:
                    f.write('# design ' + line)
        f.write('| mutant | rule | verdict | how |\n|---|---|---|---|\n')
        for name, old, verdict, how in rows:
            f.write('| %s | `%s` | %s | %s |\n' % (name, old.split('\\*')[0].strip().replace('|', '\\|'), verdict, how))
        caught = sum(1 for r in rows if r[2] == 'caught')
        f.write('\n%d mutants: %d caught by a safety invariant in simulation, %d not caught, %d not run\n' % (
            len(rows), caught, sum(1 for r in rows if r[2] == 'not caught'), sum(1 for r in rows if r[2] == 'not run')))


if __name__ == '__main__':
    main()
