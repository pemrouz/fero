#!/usr/bin/env python3
"""
cli.py: run a model of E-16 or E-33 on the engine.

    python3 engine/cli.py MODELFILE OPTION                 every SWEEP and VERIFY bound, with traces
    python3 engine/cli.py MODELFILE OPTION --bound B       one bound
    python3 engine/cli.py MODELFILE OPTION --drop RULE     one rule switched off (repeatable)
    python3 engine/cli.py MODELFILE OPTION --flip RULE     one comparison flipped
    python3 engine/cli.py MODELFILE OPTION --rules         the rule list
    python3 engine/cli.py MODELFILE OPTION --ablate OUT.json   ablation + mutants (DEV-10)

MODELFILE is a path to a model module exporting OPTIONS, BOUNDS, SWEEP and
VERIFY. Runs set PYTHONHASHSEED=0 (the process re-executes itself), so state
digests are stable and decide mutant equivalence the same way every time.
"""
import argparse
import importlib.util
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine   # noqa: E402


def load(path):
    spec = importlib.util.spec_from_file_location('model_' + os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('option')
    ap.add_argument('--bound', action='append', default=[])
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--flip', action='append', default=[])
    ap.add_argument('--rules', action='store_true')
    ap.add_argument('--ablate')
    ap.add_argument('--no-mutants', action='store_true')
    ap.add_argument('--limit', type=int, default=1_500_000)
    ap.add_argument('--all-fails', action='store_true', help='explore everything, list every property broken')
    a = ap.parse_args()
    mod = load(a.model)
    cls = mod.OPTIONS[a.option]
    if a.rules:
        for r in engine.rules(cls(mod.BOUNDS[mod.SWEEP[0]]).actions()):
            kind = 'guard' if isinstance(r, engine.Guard) else 'update'
            print(f'{r.id:28} {kind:6} {r.role:8} {getattr(r, "op", "") or "":3} {r.note}')
        return
    if a.ablate:
        t0 = time.time()
        ab = engine.Ablation(cls, [(b, mod.BOUNDS[b]) for b in mod.SWEEP],
                             verify=[(b, mod.BOUNDS[b]) for b in mod.VERIFY], limit=a.limit,
                             cache_path=a.ablate + '.cache')
        out = ab.run(mutate=not a.no_mutants, pinned=tuple(getattr(mod, 'PINNED', {}).get(a.option, ())))
        out['option'] = a.option
        out['secs'] = round(time.time() - t0)
        with open(a.ablate, 'w') as f:
            json.dump(out, f, indent=1, default=str)
        kept = [r['id'] for r in out.get('rules', []) if r['kept']]
        print(f'{a.option}: {len(kept)} rules kept of {len(out.get("rules", []))}; error: {out.get("error")}')
        return
    m = engine.Mutation(drop=a.drop, flip=a.flip)
    for b in (a.bound or list(mod.SWEEP) + list(mod.VERIFY)):
        model = cls(mod.BOUNDS[b])
        r = engine.explore(model, m, stop_first=not a.all_fails, limit=a.limit)
        print(f'{a.option} {b}: {r.summary()}')
        for name, (nj, stuck) in sorted(r.judged.items()):
            print(f'    {name}: {nj:,} judged states, {stuck:,} cannot reach the goal')
        for p, (d, tr) in sorted(r.fail.items()):
            print(f'  {p}: shortest trace, {d} steps')
            engine.show_trace(tr)


if __name__ == '__main__':
    main()
