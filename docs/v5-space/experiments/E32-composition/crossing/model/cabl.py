#!/usr/bin/env python3
"""
cabl.py: DEV-10 (c)'s ablation on the composed model. A rule counts only if
removing it lets the checker find a counterexample. E-17's procedure
(runner.py): pass 1 (drop each rule alone), greedy drops in model-text
order (a drop is kept only if every bound still holds), and a final pass
that proves the set left is 1-minimal (each rule left breaks a property
when dropped). Resumable: every run is cached in a JSON checkpoint.

Two stages.

  added   Only the rules added at the crossing are candidates (crossing.py,
          ADDED: the log drop's guards, what a snapshot carries, and the
          floor and mark rules E-20 and E-30 each checked alone). Every
          other rule stays. The answer: which added rules are needed.

  union   Start from the smallest sets the single experiments ended on:
          E-17's one-decider slot move (`slot+abort`, its 34 rules) with
          E-17c's two once guards, E-16's `self` (14 rules), and the added
          rules stage `added` kept. Everything else is dropped at once. If
          a bound then fails, the crossing needs a rule that was spare
          alone: rules are put back one at a time (the one that removes the
          current counterexample; latest dropped first) until every bound
          holds. Then the final pass.

    python3 model/cabl.py --out CK.json --stage added [--budget 1500] [--jobs 2]
    python3 model/cabl.py --out CK.json --stage union --added-from CK-added.json
"""

import argparse
import json
import multiprocessing as mp
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cworld                                        # noqa: E402
from cworld import CWorld                            # noqa: E402
from cexplore import explore                         # noqa: E402
from cbounds import BOUNDS, SWEEP                    # noqa: E402
from crossing import Crossing, ADDED                 # noqa: E402
from dsl import Mutation, rules                      # noqa: E402

LIMIT = 1_500_000
ERRS = (TypeError, IndexError, KeyError, ValueError, AttributeError)
EXP = os.path.normpath(os.path.join(HERE, '..', '..', '..'))


def rule_ids():
    return [r.id for r in rules(Crossing(BOUNDS[SWEEP[0]]).actions())]


def single_smallest():
    """The rules the single experiments' own ablations dropped, read from
    their result files (not re-derived here)."""
    ids = set(rule_ids())
    e17 = json.load(open(os.path.join(EXP, 'E17-partitioning', 'results', 'slot+abort-ablation.json')))
    drop17 = [r['id'] for r in e17['rules'] if not r['kept'] and r['id'] in ids]
    # E-17c: in a real log a slot move needs two once guards
    drop17 = [x for x in drop17 if x not in ('fence.once', 'open.once')]
    e16 = json.load(open(os.path.join(EXP, 'E16-controller-loop', 'results', 'self-ablation.json')))
    drop16 = [r['id'] for r in e16['rules'] if not r['kept'] and r['id'] in ids]
    return drop17, drop16


def _run(args):
    drop, bounds, stop = args
    m = Mutation(drop=drop)
    per = {}
    for b in bounds:
        t0 = time.time()
        try:
            r = explore(CWorld(Crossing, BOUNDS[b], m), stop_first=True, liveness=True, limit=LIMIT)
        except ERRS as e:
            per[b] = {'fail': ['ERR', 0, ['ERR']], 'error': f'{type(e).__name__}: {e}'[:200],
                      'secs': round(time.time() - t0, 1), 'complete': False, 'states': 0}
            if stop:
                break
            continue
        x = {'states': r.states, 'secs': round(r.secs, 1), 'complete': r.complete}
        if r.fail:
            p = min(r.fail, key=lambda k: r.fail[k][0])
            x['fail'] = [p, r.fail[p][0], sorted(r.fail)]
            x['trace'] = [' '.join(map(str, lab)) for lab in r.fail[p][1]][:60]
        elif not r.complete:
            x['fail'] = ['LIMIT', r.states, ['LIMIT']]
        per[b] = x
        if 'fail' in x and stop:
            break
    return drop, bounds, per


class OutOfTime(Exception):
    pass


class Work:
    def __init__(self, path, jobs, budget, sweep):
        self.path, self.jobs, self.budget, self.sweep = path, jobs, budget, tuple(sweep)
        self.t0 = time.time()
        self.cache = {}
        self.extra = {}
        if os.path.exists(path):
            old = json.load(open(path))
            self.cache = old.get('cache', {})
            self.extra = {k: v for k, v in old.items() if k != 'cache'}
        self.pool = mp.Pool(jobs)

    def save(self, extra=None):
        if extra is None:
            extra = self.extra
        self.extra = extra
        obj = dict(extra)
        obj['cache'] = self.cache
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(obj, f)
        os.replace(tmp, self.path)

    @staticmethod
    def key(drop, b):
        return json.dumps([sorted(drop), b])

    def _need(self, tasks):
        if not tasks:
            return

        def gen():
            for t in tasks:
                if time.time() - self.t0 > self.budget:
                    return
                yield t
        done = 0
        for drop, bounds, per in self.pool.imap_unordered(_run, gen()):
            for b, x in per.items():
                self.cache[self.key(drop, b)] = x
            done += 1
            self.save()
        if done < len(tasks):
            raise OutOfTime()

    def seq_many(self, drops):
        """For each drop set: the bounds in order, stopping at the first that
        fails. Returns {tuple(sorted(drop)): first failure or None}."""
        out = {}
        while True:
            tasks = []
            for d in drops:
                k = tuple(sorted(d))
                if k in out:
                    continue
                ff, missing = self._first(d)
                if ff is not None or not missing:
                    out[k] = ff
                else:
                    tasks.append((list(d), missing, True))
            if not tasks:
                return out
            self._need(tasks)

    def _first(self, d):
        """(first failure in bound order, bounds not yet run before it)."""
        for i, b in enumerate(self.sweep):
            x = self.cache.get(self.key(d, b))
            if x is None:
                return None, list(self.sweep[i:])
            if 'fail' in x:
                return [b] + x['fail'][:2] + [x.get('trace')], []
        return None, []

    def par(self, d):
        """Every bound for one drop set, one job per bound."""
        missing = [b for b in self.sweep if self.key(d, b) not in self.cache]
        self._need([(list(d), [b], True) for b in missing])
        return self._first(d)[0]


def short(ff):
    return None if ff is None else ff[:3]


def stage_added(wk, log, reverse=False):
    ids = [i for i in rule_ids() if i in ADDED]
    out = {'stage': 'added', 'candidates': ids, 'order': 'reverse' if reverse else 'text'}
    assert wk.par([]) is None, 'the model as designed fails'
    res1 = wk.seq_many([[i] for i in ids])
    alone = {i: res1[(i,)] for i in ids}
    log(f'  pass 1: {sum(1 for i in ids if alone[i])} of {len(ids)} added rules necessary alone')
    removed, greedy = [], []
    for i in (list(reversed(ids)) if reverse else ids):
        if alone[i]:
            continue
        ff = wk.par(removed + [i])
        if ff is None:
            removed.append(i)
            greedy.append([i, 'dropped'])
        else:
            greedy.append([i, f'kept: with the others dropped it breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
        log(f'  greedy {i}: {greedy[-1][1]}')
    removed, fin = final_pass(wk, ids, removed, greedy, log)
    out.update(removed=removed, greedy=greedy,
               rules=[{'id': i, 'alone': alone[i], 'kept': i not in removed, 'final': fin.get(i)} for i in ids])
    return out


def final_pass(wk, ids, removed, greedy, log):
    while True:
        remaining = [i for i in ids if i not in removed]
        res = wk.seq_many([removed + [i] for i in remaining])
        fin = {i: res[tuple(sorted(removed + [i]))] for i in remaining}
        extra = [i for i in remaining if fin[i] is None]
        if not extra:
            return removed, fin
        for i in extra:
            if wk.par(removed + [i]) is None:
                removed.append(i)
                greedy.append([i, 'dropped in the final pass'])
                log(f'  final pass: {i} dropped')


def stage_union(wk, log, added_removed):
    ids = rule_ids()
    drop17, drop16 = single_smallest()
    removed = list(drop17) + list(drop16) + [i for i in added_removed if i not in drop17 + drop16]
    out = {'stage': 'union', 'e17_dropped': drop17, 'e16_dropped': drop16, 'added_dropped': list(added_removed),
           'start_kept': len(ids) - len(removed)}
    log(f'  start: {len(ids)} rules written, {len(removed)} dropped at once, {len(ids) - len(removed)} kept')
    back = []
    while True:
        ff = wk.par(removed)
        if ff is None:
            break
        log(f'  the union of the smallest sets breaks {ff[1]} on {ff[0]} in {ff[2]} steps')
        b0 = ff[0]
        fixed = None
        # one rule put back that removes this counterexample (latest dropped first)
        saved = wk.sweep
        wk.sweep = (b0,)
        try:
            res = wk.seq_many([[x for x in removed if x != r] for r in reversed(removed)])
        finally:
            wk.sweep = saved
        cands = [r for r in reversed(removed) if res[tuple(sorted(x for x in removed if x != r))] is None]
        if not cands:
            out['error'] = f'no single rule put back removes {ff[1]} on {b0}'
            out['stuck_on'] = ff
            break
        fixed = cands[0]
        removed = [x for x in removed if x != fixed]
        back.append({'rule': fixed, 'breaks': ff[1], 'bound': b0, 'steps': ff[2], 'trace': ff[3],
                     'also_fix': cands[1:]})
        log(f'  put back {fixed} (also fixing it alone: {cands[1:] or "none"})')
    out['put_back'] = back
    greedy = []
    if 'error' not in out:
        removed, fin = final_pass(wk, ids, removed, greedy, log)
        out['rules'] = [{'id': i, 'kept': i not in removed, 'final': fin.get(i)} for i in ids]
    out['removed'] = removed
    out['final_dropped'] = greedy
    out['kept'] = [i for i in ids if i not in removed]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--stage', required=True, choices=('added', 'union'))
    ap.add_argument('--added-from')
    ap.add_argument('--reverse', action='store_true', help='greedy drops in reverse model-text order')
    ap.add_argument('--tag', default='result', help='the key the result is saved under')
    ap.add_argument('--budget', type=float, default=1500)
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--sweep', default='')
    a = ap.parse_args()
    sweep = tuple(a.sweep.split(',')) if a.sweep else SWEEP
    wk = Work(a.out, a.jobs, a.budget, sweep)
    log = lambda s: print(s, flush=True)     # noqa: E731
    try:
        if a.stage == 'added':
            res = stage_added(wk, log, a.reverse)
        else:
            added_removed = json.load(open(a.added_from))['result']['removed'] if a.added_from else []
            res = stage_union(wk, log, added_removed)
    except OutOfTime:
        wk.save()
        print('out of time for this piece; run again to continue')
        wk.pool.terminate()
        sys.exit(3)
    res['sweep'] = list(sweep)
    extra = {}
    if os.path.exists(a.out):
        extra = {k: v for k, v in json.load(open(a.out)).items() if k != 'cache'}
    extra[a.tag] = res
    wk.save(extra)
    wk.pool.close()
    print(f'{a.stage}: kept {len([r for r in res.get("rules", []) if r["kept"]])}, dropped {len(res["removed"])}')


if __name__ == '__main__':
    main()
