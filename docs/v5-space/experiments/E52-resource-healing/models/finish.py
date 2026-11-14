#!/usr/bin/env python3
"""
finish.py: E-16's ablation (engine.Ablation.run, E-17's procedure with E-16's
verify pass 1), with four small changes (two to E-17's put-back loop, two to
how pinned steps are run), applied as
text edits to E-16's own source at load time, so everything else runs as
written there.

    python3 models/finish.py MODEL OPTION OUT.json [--no-mutants]
                            [--limit 900000] [--vlimit 2000000]

Why. When the smallest model breaks a verify bound, E-17's loop tries each
dropped rule, last dropped first, and keeps the first whose return makes
every verify bound and every sweep bound pass. As written it (1) runs every
verify bound to its end for each trial, even after the first has failed, and
(2) treats a run that stops at the state limit with no counterexample as a
failure. Here the smallest models of `f2` pass 2,000,000 states, so every
trial would run `f2` to the limit (about 10 minutes each, 43 trials) and no
rule could ever be put back.

The changes:
  (1) a trial reads the verify bounds in order and stops at the first that
      fails, as the rest of the ablation does (Ablation.per without full):
      the decision reads only whether a run fails, so it is the same;
  (2) a trial whose only verify result is a stop at the state limit, with no
      counterexample, may be the put-back; it is recorded in the result as
      undecided on that bound (out['putback_undecided']), as E-16 records a
      verify bound that stops at the limit (out['verify_undecided']).

(3) A pinned step's row (the world's bookkeeping, never dropped or mutated,
and never reported) is not run on the verify bounds.

(4) Nor is a pinned step dropped on top of the smallest model in the final
passes and the rows: it is never a candidate to drop, and with a hint budget
lifted one such run outlasts a 25-minute piece.

Also, before it runs, each cached verify-bound result stored without `full`
is copied to the same key with `full` (and back): on a verify bound run1
stops at the first failure whatever `full` says (engine.py: `stop = (not
full) or bname in self.verify_map`), so the two results are the same run.
"""
import argparse
import importlib.util
import inspect
import json
import os
import sys
import textwrap
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402

OLD = """                if not first_fail(self.per(Mutation(drop=trial), vn, True)) and \\
                        not first_fail(self.per(Mutation(drop=trial), bn)):"""
NEW = """                if self._fixes(trial, vn, bn, out):"""


def _fixes(self, trial, vn, bn, out):
    v = engine.first_fail(self.per(engine.Mutation(drop=trial), vn))      # change (1)
    if v and v[1] != 'LIMIT':
        return False
    if engine.first_fail(self.per(engine.Mutation(drop=trial), bn)):
        return False
    if v:                                                                  # change (2)
        out.setdefault('putback_undecided', []).append([sorted(set(self._removed_now) - set(trial)), v])
    return True


src = textwrap.dedent(inspect.getsource(engine.Ablation.run))
# match on the dedented source: the method body is indented 4 spaces less
old_m = '\n'.join(l[4:] if l.startswith('    ') else l for l in OLD.split('\n'))
new_m = '\n'.join(l[4:] if l.startswith('    ') else l for l in NEW.split('\n'))
assert src.count(old_m) == 1, 'E-16 engine changed: put-back loop not found'
src = src.replace(old_m, new_m)
# remember the dropped set the loop is working from (for the record above)
hook_old = '        fixed = None\n'
assert src.count(hook_old) == 1
src = src.replace(hook_old, '        fixed = None\n        self._removed_now = list(removed)\n')
# change (3): a pinned step's row is not run on the verify bounds. Pinned
# steps are the world's bookkeeping, never dropped or mutated, and the report
# prints no verdict for them; their verify runs (budgets lifted) only pass
# the state limit.
row_old = '            if ff is None and vn:\n'
assert src.count(row_old) == 1
src = src.replace(row_old, '            if ff is None and vn and i not in pinned:\n')
# change (4): the final passes and the rows do not run a pinned step dropped
# on top of the smallest model. A pinned step is never dropped (`extra`
# excludes it) and its row is never reported; with a hint budget lifted, one
# such run outlasts a 25-minute piece here, so the ablation could not finish.
fin_old = 'fin = {i: self.per(Mutation(drop=removed + [i]), bn) for i in remaining}'
assert src.count(fin_old) == 2
src = src.replace(fin_old, 'fin = {i: self.per(Mutation(drop=removed + [i]), bn) for i in remaining if i not in pinned}')
ext_old = 'extra = [i for i in remaining if first_fail(fin[i]) is None and i not in pinned]'
assert src.count(ext_old) == 1
src = src.replace(ext_old, 'extra = [i for i in remaining if i not in pinned and first_fail(fin[i]) is None]')
kept_old = "        if row['kept']:\n"
assert src.count(kept_old) == 1
src = src.replace(kept_old, "        if row['kept'] and i not in pinned:\n")
ns = dict(vars(engine))
exec(compile(src, engine.__file__ + ' (run, with finish.py changes)', 'exec'), ns)


class Ablation52(engine.Ablation):
    run = ns['run']
    _fixes = _fixes

    def mirror_verify_keys(self):
        n = 0
        vn = set(self.verify_map)
        for k, v in list(self.cache.items()):
            kk = json.loads(k)
            if kk[3] in vn:
                kk2 = kk[:4] + [not kk[4]]
                k2 = json.dumps(kk2)
                if k2 not in self.cache:
                    self.cache[k2] = v
                    n += 1
        self.save()
        return n


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
    ap.add_argument('out')
    ap.add_argument('--no-mutants', action='store_true')
    ap.add_argument('--limit', type=int, default=900000)
    ap.add_argument('--vlimit', type=int, default=2000000)
    a = ap.parse_args()
    mod = load(a.model)
    cls = mod.OPTIONS[a.option]
    t0 = time.time()
    ab = Ablation52(cls, [(b, mod.BOUNDS[b]) for b in mod.SWEEP],
                    verify=[(b, mod.BOUNDS[b]) for b in mod.VERIFY], limit=a.limit,
                    cache_path=a.out + '.cache', vlimit=a.vlimit,
                    verify_pass1=getattr(mod, 'VERIFY_PASS1', False))
    print(f'mirrored {ab.mirror_verify_keys()} verify results', flush=True)
    out = ab.run(mutate=not a.no_mutants, pinned=tuple(getattr(mod, 'PINNED', {}).get(a.option, ())))
    out['option'] = a.option
    out['secs'] = round(time.time() - t0)
    out['driver'] = 'models/finish.py (E-16 engine.Ablation.run with four small changes)'
    with open(a.out, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    kept = [r['id'] for r in out.get('rules', []) if r['kept']]
    print(f'{a.option}: {len(kept)} rules kept of {len(out.get("rules", []))}; error: {out.get("error")}')


if __name__ == '__main__':
    main()
