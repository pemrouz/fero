#!/usr/bin/env python3
"""
pass1.py: pass 1 of the ablation (each design rule dropped alone), read from
ablate.py's run cache, for an ablation that has not finished.

    python3 models/pass1.py OPTION CACHE

Prints, per design rule and per Raft-core rule, the first property that breaks
on the sweep bounds, then the verify bounds (E59_SWEEP and E59_VERIFY, as
ablate.py reads them), or "not run yet" when the cache has no answer.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ablate  # noqa: E402  (re-execs with PYTHONHASHSEED=0)


def main():
    option, path = sys.argv[1], sys.argv[2]
    mod = ablate.load()
    cls = mod.OPTIONS[option]
    bounds = os.environ.get('E59_SWEEP', ' '.join(mod.SWEEP)).split()
    vb = os.environ.get('E59_VERIFY', ' '.join(getattr(mod, 'VERIFY', ()))).split()
    rl = ablate.engine.rules(cls(mod.BOUNDS[bounds[0]]).actions())
    pinned = set(mod.PINNED[option])
    cache = ablate.Cache(path, option)
    cache.f.close()
    rows, need, free, open_ = [], 0, 0, 0
    for r in rl:
        if r.id in pinned and r.role != 'raft':
            continue
        k = ablate.mkey(ablate.engine.Mutation(drop=[r.id]))
        per = {b: cache.get(k, b) for b in bounds + vb}
        f = ablate.first_fail({b: x for b, x in per.items() if x}, bounds + vb)
        done = f is not None or all(per[b] is not None for b in bounds + vb)
        core = r.id in pinned
        if f and f[1] != 'LIMIT':
            what = f'{f[1]} on {f[0]} ({f[2]} steps)'
            need += not core
        elif f:
            what = f'undecided ({f[0]}: state limit)'
        elif done:
            what = 'nothing breaks'
            free += not core
        else:
            what = 'not run yet'
            open_ += not core
        rows.append((r.id, 'raft core' if core else r.role, what))
    print(f'# {option}: pass 1 from the run cache\n')
    print(f'Design rules: {need} necessary alone, {free} not, {open_} not run yet.\n')
    print('| Rule | Role | Dropped alone breaks |\n|---|---|---|')
    for i, role, what in rows:
        print(f'| `{i}` | {role} | {what} |')


if __name__ == '__main__':
    main()
