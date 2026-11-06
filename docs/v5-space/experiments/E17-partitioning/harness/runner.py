"""
runner.py: load an option, run it on a bound, ablate it, mutate it.

Ablation (DEV-10 (c)): a rule counts only if removing it lets the checker
find a counterexample. The procedure:
  1. the model as designed must hold every property on every bound;
  2. pass 1: drop each rule alone; it is NECESSARY if some bound then fails;
  3. greedy: drop the rules that pass 1 found unnecessary, one at a time in
     model-text order, keeping each drop only if every bound still holds;
  4. final pass: with those dropped, drop each remaining rule once more; each
     must now fail (if one does not, it is dropped too and the pass repeats).
The rules left are the option's smallest rule set (1-minimal: removing any
one of them breaks a property).

Mutants (DEV-10 (d)) are made from the smallest rule set: drop each guard
conjunct, drop each update, flip each comparison (< <=, > >=), swap each
pair of updates inside one action. A mutant that no bound catches is
EQUIVALENT if every bound's reachable state set (count, steps and digest)
equals the unmutated model's; otherwise it SURVIVED.
"""

import importlib.util
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from dsl import Mutation, rules                    # noqa: E402
from world import World                            # noqa: E402
from explore import explore                        # noqa: E402
from bounds import BOUNDS, SWEEP, VERIFY           # noqa: E402

_cache = {}


def load(name):
    """'slot' -> options/slot/model.py OPTION; 'rekey-carry' ->
    options/rekey/model.py OPTIONS['rekey-carry']."""
    if name in _cache:
        return _cache[name]
    folder = name.split('-')[0]
    path = os.path.join(ROOT, 'options', folder, 'model.py')
    spec = importlib.util.spec_from_file_location(f'opt_{folder}', path)
    mod = sys.modules.get(spec.name)
    if mod is None:
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
    cls = getattr(mod, 'OPTIONS', {}).get(name) or mod.OPTION
    _cache[name] = (cls, path)
    _giveup[name] = tuple(getattr(mod, 'GIVEUP', ()))
    return cls, path


_giveup = {}


def giveup(name):
    """The option's give-up rules (pinned in the '+giveup' ablation)."""
    load(name)
    return _giveup[name]


def rule_list(name):
    cls, _ = load(name)
    return rules(cls(BOUNDS['grow']).actions())


CAP = 10            # entries per group log; the designed models need about 8
LIMIT = 1_500_000   # states per run, to bound memory (about 3 GB a worker)


def run(name, bound, mutation=None, stop_first=True, liveness=True, cap=CAP, limit=LIMIT):
    cls, _ = load(name)
    w = World(cls, BOUNDS[bound], mutation, cap=cap)
    return explore(w, stop_first=stop_first, liveness=liveness, limit=limit)


def _job(args):
    """One mutant on a list of bounds: stop at the first bound that fails."""
    name, mkey, bounds, full = args
    drop, flip, swap = mkey
    m = Mutation(drop, flip, dict(swap))
    per = {}
    for b in bounds:
        r = run(name, b, m, stop_first=not full)
        per[b] = {'states': r.states, 'edges': r.edges, 'secs': round(r.secs, 2),
                  'fail': {p: [d, [list(map(str, x)) for x in tr][:60]] for p, (d, tr) in r.fail.items()},
                  'digest': list(r.digest), 'capped': r.capped, 'complete': r.complete}
        if (r.fail or not r.complete) and not full:
            break
    return mkey, per


def first_fail(per):
    """The first bound that fails, its nearest property, the steps, all
    properties. A run stopped by the state limit with no counterexample is
    undecided: reported as LIMIT, and treated as a failure (the rule stays)."""
    for b, x in per.items():
        if x['fail']:
            p = min(x['fail'], key=lambda k: x['fail'][k][0])
            return b, p, x['fail'][p][0], sorted(x['fail'])
        if not x['complete']:
            return b, 'LIMIT', x['states'], ['LIMIT']
    return None


class OutOfTime(Exception):
    pass


class Work:
    """A cache of finished jobs, kept in a JSON checkpoint, and a time budget.
    The stage code below is deterministic given the cache, so a run that
    stops for time picks up where it left off when started again."""

    def __init__(self, name, path, jobs=2, budget=None, log=print):
        self.name, self.path, self.jobs, self.log = name, path, jobs, log
        self.t0 = time.time()
        self.budget = budget
        self.cache = {}
        if os.path.exists(path):
            with open(path) as f:
                old = json.load(f)
            for k, v in old.get('cache', []):
                self.cache[self._k(k)] = v
        self.ex = ProcessPoolExecutor(max_workers=jobs)

    @staticmethod
    def _k(task):
        (drop, flip, swap), bounds, full = task
        return json.dumps([[sorted(drop), sorted(flip), sorted(map(list, swap))], list(bounds), bool(full)])

    def save(self, extra=None):
        obj = {'option': self.name, 'cache': [[json.loads(k), v] for k, v in self.cache.items()]}
        if extra:
            obj.update(extra)
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(obj, f, default=str)
        os.replace(tmp, self.path)

    def run(self, tasks):
        """tasks: list of (mkey, bounds, full). Returns their results, in order."""
        todo = [t for t in tasks if self._k(t) not in self.cache]
        seen = set()
        uniq = []
        for t in todo:
            k = self._k(t)
            if k not in seen:
                seen.add(k)
                uniq.append(t)
        pending = {}
        it = iter(uniq)
        done_any = False
        while True:
            while len(pending) < self.jobs:
                if self.budget and time.time() - self.t0 > self.budget:
                    break
                t = next(it, None)
                if t is None:
                    break
                fut = self.ex.submit(_job, (self.name, t[0], list(t[1]), t[2]))
                pending[fut] = t
            if not pending:
                break
            from concurrent.futures import wait, FIRST_COMPLETED
            fin, _ = wait(list(pending), return_when=FIRST_COMPLETED)
            for fut in fin:
                t = pending.pop(fut)
                self.cache[self._k(t)] = fut.result()[1]
                done_any = True
            if done_any:
                self.save()
        missing = [t for t in tasks if self._k(t) not in self.cache]
        if missing:
            raise OutOfTime()
        return [self.cache[self._k(t)] for t in tasks]

    def close(self):
        self.ex.shutdown(wait=True)


def ablate(name, path, jobs=2, bounds=SWEEP, budget=None, mutate=True, log=print, pinned=(), warm=()):
    """The whole procedure (see the module docstring). Raises OutOfTime when
    the budget runs out; call again to continue. Pinned rules are never
    dropped (the '+giveup' run pins the give-up path)."""
    wk = Work(name, path, jobs, budget, log)
    try:
        return _ablate(wk, name, bounds, mutate, log, tuple(pinned), tuple(warm))
    finally:
        wk.close()


def _split(bounds):
    return [[b] for b in bounds]


def _all(wk, mkey, bounds, full=False):
    """Every bound for one mutation, one job per bound (in parallel)."""
    per = {}
    for r in wk.run([(mkey, tuple(b), full) for b in _split(bounds)]):
        per.update(r)
    return per


def _ablate(wk, name, bounds, mutate, log, pinned=(), warm=()):
    """warm: rules to drop before pass 1 (a warm start from a sibling option's
    result). Used only if the model holds every bound with them dropped; the
    final pass still proves the set left is 1-minimal."""
    rl = rule_list(name)
    ids = [r.id for r in rl]
    assert all(p in ids for p in pinned), pinned
    warm = [i for i in warm if i in ids and i not in pinned]
    out = {'option': name, 'bounds': list(bounds), 'pinned': list(pinned)}
    meta = {r.id: {'kind': 'guard' if hasattr(r, 'op') else 'update', 'role': r.role,
                   'note': r.note, 'cmp': getattr(r, 'op', None)} for r in rl}
    base = _all(wk, Mutation().key(), bounds, True)
    out['base'] = base
    if any(base[b]['fail'] for b in bounds):
        out['error'] = 'the model as designed fails: ' + str({b: sorted(base[b]['fail']) for b in bounds})
        return out
    removed = []
    greedy = []
    if warm:
        wr = _all(wk, Mutation(drop=warm).key(), bounds)
        if first_fail(wr) is None:
            removed = list(warm)
            greedy = [[i, 'dropped by the warm start'] for i in warm]
            out['warm'] = list(warm)
            log(f'  warm start: {len(warm)} rules dropped at once; every bound holds')
        else:
            out['warm_refused'] = first_fail(wr)
            log(f'  warm start refused: {first_fail(wr)}')
    # pass 1: each rule alone (on top of a warm start), bounds in order,
    # stop at the first that fails
    ids1 = [i for i in ids if i not in removed]
    res1 = wk.run([(Mutation(drop=removed + [i]).key(), tuple(bounds), False) for i in ids1])
    res1 = dict(zip(ids1, res1))
    nec1 = {i: first_fail(res1[i]) for i in ids1}
    for i in removed:
        res1[i], nec1[i] = {}, None
    log(f'  pass 1: {sum(1 for i in ids1 if nec1[i])} of {len(ids1)} rules necessary alone')
    for i in ids:
        if nec1[i] or i in pinned or i in removed:
            continue
        per = _all(wk, Mutation(drop=removed + [i]).key(), bounds)
        ff = first_fail(per)
        if ff is None:
            removed.append(i)
            greedy.append([i, 'dropped'])
        else:
            greedy.append([i, f'kept: with the others dropped it breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
    while True:
        remaining = [i for i in ids if i not in removed]
        fin = wk.run([(Mutation(drop=removed + [i]).key(), tuple(bounds), False) for i in remaining])
        fin = dict(zip(remaining, fin))
        extra = [i for i in remaining if first_fail(fin[i]) is None and i not in pinned]
        if not extra:
            break
        removed.append(extra[0])
        greedy.append([extra[0], 'dropped in the final pass'])
    # VERIFY: the smallest model on the big bound(s); a failure puts dropped
    # rules back, latest dropped first, until it holds everywhere
    verify = list(VERIFY)
    back = []
    while True:
        vr = _all(wk, Mutation(drop=removed).key(), verify, True)
        if not first_fail(vr):
            break
        ff = first_fail(vr)
        fixed = None
        for r in reversed(removed):
            trial = [x for x in removed if x != r]
            v2 = _all(wk, Mutation(drop=trial).key(), verify, True)
            s2 = _all(wk, Mutation(drop=trial).key(), bounds)
            if not first_fail(v2) and not first_fail(s2):
                fixed = r
                break
        if fixed is None:
            out['error'] = f'the smallest model fails {ff[1]} on {ff[0]} and no single rule put back fixes it'
            out['removed'] = removed
            return out
        removed = [x for x in removed if x != fixed]
        back.append([fixed, f'put back: without it the smallest model breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
        greedy.append(back[-1])
    out['greedy'] = greedy
    out['removed'] = removed
    out['verify'] = vr
    out['put_back'] = back
    minimal = _all(wk, Mutation(drop=removed).key(), bounds, True)
    out['minimal'] = minimal
    if back:
        remaining = [i for i in ids if i not in removed]
        fin = dict(zip(remaining, wk.run([(Mutation(drop=removed + [i]).key(), tuple(bounds), False)
                                          for i in remaining])))
        for i in remaining:
            if first_fail(fin[i]) is None:
                fin[i] = _all(wk, Mutation(drop=removed + [i]).key(), verify, True)
    rows = []
    for r in rl:
        i = r.id
        row = dict(meta[i], id=i)
        row['alone'] = nec1[i]
        row['alone_trace'] = _trace_of(res1[i], nec1[i])
        row['kept'] = i not in removed
        row['pinned'] = i in pinned
        if row['kept']:
            row['final'] = first_fail(fin[i])
            row['final_trace'] = _trace_of(fin[i], row['final'])
        rows.append(row)
    out['rules'] = rows
    if mutate:
        out['mutants'] = _mutants(wk, name, removed, minimal, bounds, log)
    return out


def _trace_of(per, ff):
    if not ff or ff[1] == 'LIMIT':
        return None
    b, p, d, _ = ff
    return per[b]['fail'][p][1]


def _mutants(wk, name, removed, base_minimal, bounds, log):
    """DEV-10 (d) on the smallest model: drop, flip, swap."""
    rl = [r for r in rule_list(name) if r.id not in removed]
    cls, _ = load(name)
    acts = cls(BOUNDS['grow']).actions()
    muts = []
    for r in rl:
        muts.append(('drop', r.id, Mutation(drop=list(removed) + [r.id])))
    for r in rl:
        if hasattr(r, 'op') and r.is_cmp():
            muts.append(('flip', r.id, Mutation(drop=removed, flip=[r.id])))
    for a in acts:
        live = [k for k, u in enumerate(a.updates) if u.id not in removed]
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                i, j = live[x], live[y]
                muts.append(('swap', f'{a.name}: {a.updates[i].name} <-> {a.updates[j].name}',
                             Mutation(drop=removed, swap={a.name: (i, j)})))
    res = wk.run([(m.key(), tuple(bounds), False) for _, _, m in muts])
    rows = []
    for (kind, what, m), per in zip(muts, res):
        ff = first_fail(per)
        row = {'kind': kind, 'rule': what}
        if ff:
            row['caught'] = ff
            row['trace'] = _trace_of(per, ff)
        else:
            vp = _all(wk, m.key(), list(VERIFY), True)
            vf = first_fail(vp)
            if vf:
                row['caught'] = vf
                row['trace'] = _trace_of(vp, vf)
                rows.append(row)
                continue
            fp = _all(wk, m.key(), bounds, True)
            same = all(fp[b]['digest'] == base_minimal[b]['digest'] for b in bounds)
            row['caught'] = None
            row['equivalent'] = same
            row['states'] = {b: fp[b]['states'] for b in bounds}
        rows.append(row)
    caught = sum(1 for r in rows if r['caught'])
    eq = sum(1 for r in rows if not r['caught'] and r.get('equivalent'))
    log(f'  mutants: {len(rows)}; caught {caught}; equivalent {eq}; survived {len(rows) - caught - eq}')
    return rows


def save(path, obj):
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1, default=str)
