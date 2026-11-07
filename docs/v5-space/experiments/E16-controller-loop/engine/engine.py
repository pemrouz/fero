"""
engine.py: a small exhaustive checker for E-16 and E-33, built on E-17's
shared rule language.

WHAT IS SHARED WITH E-17. The rule language is E-17's own file,
../../E17-partitioning/harness/dsl.py, imported unchanged: Action, Guard,
Cmp, Update, Mutation and rules(). So a rule here is what it is there: one
guard conjunct or one state update, and the mutants are made the same way
(drop each guard, drop each update, flip each <, <=, >, >=, swap each pair of
updates in one action). The ablation below is E-17's procedure (runner.py):
pass 1, greedy drops in model-text order, a final pass that proves the set
left is 1-minimal, then the mutants of the smallest model, with equivalence
judged by the digest of the reachable state set.

WHAT IS NOT. E-17's world (harness/world.py) is a world of partitions moved
between groups; healing and genesis are about members, disks, links and a
controller. So each model here brings its own world: its state, its world
steps (faults, recoveries, time) and its properties. The event alphabet is
E-17's (crash, restart, partition, deliver, tick), plus `time` (a timer that
always fires eventually, such as evict.after or connect.wait) and `control`
(an outside decision, such as starting a process or an operator's restore).

A MODEL implements:
  init()                      the initial state (a tuple)
  actions()                   its list of dsl.Action
  world(st)                   [(label, kind, next state)]: the world's own steps
  check(st)                   [property ids] broken in st (safety)
  check_edge(s, lab, kind, t) [property ids] broken by the step s -> t
  goals(st)                   {name: bool}: liveness goals reached in st
  judged(st)                  {name: bool}: st is one the goal is asked from
  CALM                        the step kinds that count once faults stop
A draft (Draft below) is a dict copy of the state's fields that updates
change; the model says how to make one (to_draft) and freeze it (freeze).

LIVENESS is AG EF over calm steps, as in E-14 and E-17: from every reachable
state where a goal is asked (judged), calm steps alone can reach a state
where it holds.
"""

import importlib.util
import json
import os
import sys
import time
from array import array
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
E17 = os.path.normpath(os.path.join(HERE, '..', '..', 'E17-partitioning', 'harness'))
_spec = importlib.util.spec_from_file_location('e17dsl', os.path.join(E17, 'dsl.py'))
dsl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dsl)
Action, Guard, Cmp, Update, Mutation, rules = dsl.Action, dsl.Guard, dsl.Cmp, dsl.Update, dsl.Mutation, dsl.rules
FLIP, OPS = dsl.FLIP, dsl.OPS


class Draft:
    """A mutable copy of a state: fields by name. Updates write d.f[name]."""
    __slots__ = ('f',)

    def __init__(self, fields):
        self.f = fields


class Compiled:
    """A model's actions with one mutation applied (as E-17's World does)."""

    def __init__(self, model, mutation=None):
        self.model = model
        self.err = None
        m = mutation
        self.acts = []
        for a in model.actions():
            gs = []
            for g in a.guards:
                if m and g.id in m.drop:
                    continue
                if g.op is None:
                    gs.append(g.fn)
                else:
                    op = FLIP[g.op] if (m and g.id in m.flip) else g.op
                    f = OPS[op]
                    gs.append(lambda w, st, b, lhs=g.lhs, rhs=g.rhs, f=f: f(lhs(w, st, b), rhs(w, st, b)))
            us = list(a.updates)
            if m and a.name in m.swap:
                i, j = m.swap[a.name]
                us[i], us[j] = us[j], us[i]
            us = [u for u in us if not (m and u.id in m.drop)]
            self.acts.append((a, gs, us))

    def succ(self, st):
        md = self.model
        out = list(md.world(st))
        for a, gs, us in self.acts:
            for b in a.params(md, st):
                try:
                    ok = all(g(md, st, b) for g in gs)
                except (TypeError, IndexError, KeyError, ValueError):
                    # a guard that cannot be evaluated once another guard is
                    # dropped: reported as ERR, as TLC reports it
                    self.err = (a.name, a.label(b))
                    continue
                if ok:
                    d = Draft(md.to_draft(st))
                    try:
                        for u in us:
                            u.fn(md, st, b, d)
                    except (TypeError, IndexError, KeyError, ValueError):
                        # an update that cannot be evaluated (a mutant
                        # dropped the guard that made it defined): reported
                        # as property ERR, as TLC reports an evaluation error
                        self.err = (a.name, a.label(b))
                        continue
                    t = md.freeze(d)
                    if t != st:
                        out.append(((a.name, a.label(b)), a.kind, t))
        return out


class Result:
    def __init__(self):
        self.states = 0
        self.edges = 0
        self.secs = 0.0
        self.fail = {}
        self.complete = False
        self.digest = None
        self.judged = {}

    def summary(self):
        f = ', '.join(f'{p} ({self.fail[p][0]} steps)' for p in sorted(self.fail)) or 'all hold'
        lim = '' if self.complete else ' (STOPPED AT THE STATE LIMIT)'
        return f'{self.states:,} states, {self.secs:.1f}s: {f}{lim}'


def _trace(parent, i):
    labs = []
    while parent[i] is not None:
        j, lab = parent[i]
        labs.append(lab)
        i = j
    labs.reverse()
    return labs


def explore(model, mutation=None, stop_first=True, liveness=True, limit=1_500_000):
    """Breadth first, so the first failure found has a shortest trace."""
    c = Compiled(model, mutation)
    r = Result()
    t0 = time.time()
    init = model.init()
    index = {init: 0}
    states = [init]
    parent = [None]
    calm = array('i')
    calm_at = array('l', [0])
    for p in model.check(init):
        r.fail[p] = (0, [])
    CALM = model.CALM
    i = 0
    while i < len(states):
        s = states[i]
        succ = c.succ(s)
        if c.err is not None and 'ERR' not in r.fail:
            r.fail['ERR'] = (('edge', i, c.err, i), None)
            c.err = None
        for lab, kind, t in succ:
            r.edges += 1
            j = index.get(t)
            if j is None:
                j = len(states)
                index[t] = j
                states.append(t)
                parent.append((i, lab))
                for p in model.check(t):
                    if p not in r.fail:
                        r.fail[p] = (j, None)
            for p in model.check_edge(s, lab, kind, t):
                if p not in r.fail:
                    r.fail[p] = (('edge', i, lab, j), None)
            if kind in CALM:
                calm.append(j)
        calm_at.append(len(calm))
        i += 1
        if r.fail and stop_first:
            break
        if limit and len(states) > limit:
            break
    r.states = len(states)
    r.complete = i == len(states)
    for p, (j, _) in list(r.fail.items()):
        if isinstance(j, tuple):
            _, a, lab, b = j
            tr = _trace(parent, a) + [lab]
        else:
            tr = _trace(parent, j)
        r.fail[p] = (len(tr), tr)
    if liveness and r.complete and not (r.fail and stop_first):
        _liveness(model, r, states, parent, calm, calm_at)
    h = 0
    for s in states:
        h = (h + hash(s)) & 0xFFFFFFFFFFFFFFFF
    r.digest = (r.states, r.edges, h)
    r.secs = time.time() - t0
    return r


def _liveness(model, r, states, parent, calm, calm_at):
    n = len(states)
    deg = array('l', bytes(8 * (n + 1)))
    for b in calm:
        deg[b + 1] += 1
    for x in range(n):
        deg[x + 1] += deg[x]
    rev = array('i', bytes(4 * len(calm)))
    fill = array('l', deg)
    for a in range(n):
        for k in range(calm_at[a], calm_at[a + 1]):
            b = calm[k]
            rev[fill[b]] = a
            fill[b] += 1
    del fill
    goals = [model.goals(s) for s in states]
    judged = [model.judged(s) for s in states]
    names = sorted(goals[0]) if goals else []
    for name in names:
        reach = bytearray(n)
        q = deque()
        for x in range(n):
            if goals[x][name]:
                reach[x] = 1
                q.append(x)
        while q:
            b = q.popleft()
            for m in range(deg[b], deg[b + 1]):
                a = rev[m]
                if not reach[a]:
                    reach[a] = 1
                    q.append(a)
        nj = 0
        stuck = 0
        first = None
        for x in range(n):
            if judged[x].get(name, True):
                nj += 1
                if not reach[x]:
                    stuck += 1
                    if first is None:
                        first = x
        r.judged[name] = (nj, stuck)
        if name in getattr(model, 'INFO', ()):
            continue
        if first is not None and name not in r.fail:
            tr = _trace(parent, first)
            r.fail[name] = (len(tr), tr)


# ---------------------------------------------------------------- ablation
# E-17's runner.py procedure, for one model class and a list of bounds. A
# bound is a dict passed to the model's constructor.

def first_fail(per):
    for b, x in per.items():
        if x['fail']:
            p = min(x['fail'], key=lambda k: x['fail'][k][0])
            return b, p, x['fail'][p][0], sorted(x['fail'])
        if not x['complete']:
            return b, 'LIMIT', x['states'], ['LIMIT']
    return None


class Ablation:
    def __init__(self, cls, bounds, verify=(), limit=1_500_000, log=print, cache_path=None):
        self.cls, self.bounds, self.verify, self.limit, self.log = cls, bounds, list(verify), limit, log
        self.cache = {}
        self.cache_path = cache_path
        if cache_path and os.path.exists(cache_path):
            with open(cache_path) as f:
                for k, v in json.load(f):
                    self.cache[k] = v

    def save(self):
        if self.cache_path:
            tmp = self.cache_path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(list(self.cache.items()), f)
            os.replace(tmp, self.cache_path)

    def run1(self, m, bname, full):
        key = json.dumps([list(m.key()[0]), list(m.key()[1]), [list(x) for x in m.key()[2]], bname, full])
        if key in self.cache:
            return self.cache[key]
        model = self.cls(self.bounds_all()[bname])
        r = explore(model, m, stop_first=not full, limit=self.limit)
        out = {'states': r.states, 'secs': round(r.secs, 2), 'complete': r.complete,
               'fail': {p: [d, [list(map(str, x)) if isinstance(x, tuple) else [str(x)] for x in tr][:60]]
                        for p, (d, tr) in r.fail.items()},
               'digest': list(r.digest), 'judged': r.judged}
        self.cache[key] = out
        self.save()
        return out

    def bounds_all(self):
        d = dict(self.bounds)
        d.update(self.verify_map)
        return d

    @property
    def verify_map(self):
        return dict(self.verify)

    def per(self, m, bnames, full=False):
        res = {}
        for b in bnames:
            x = self.run1(m, b, full)
            res[b] = x
            if (x['fail'] or not x['complete']) and not full:
                break
        return res

    def run(self, mutate=True, pinned=()):
        rl = rules(self.cls(list(self.bounds)[0][1]).actions())
        ids = [r.id for r in rl]
        bn = [b for b, _ in self.bounds]
        vn = [b for b, _ in self.verify]
        out = {'bounds': bn, 'verify': vn, 'pinned': list(pinned)}
        base = self.per(Mutation(), bn, True)
        out['base'] = base
        if any(base[b]['fail'] for b in bn) or not all(base[b]['complete'] for b in bn):
            out['error'] = 'the model as designed fails or does not finish: ' + str(
                {b: (sorted(base[b]['fail']), base[b]['complete']) for b in bn})
            return out
        removed = []
        nec1 = {}
        res1 = {}
        for i in ids:
            res1[i] = self.per(Mutation(drop=[i]), bn)
            nec1[i] = first_fail(res1[i])
        self.log(f'  pass 1: {sum(1 for i in ids if nec1[i])} of {len(ids)} rules necessary alone')
        greedy = []
        for i in ids:
            if nec1[i] or i in pinned:
                continue
            ff = first_fail(self.per(Mutation(drop=removed + [i]), bn))
            if ff is None:
                removed.append(i)
                greedy.append([i, 'dropped'])
            else:
                greedy.append([i, f'kept: with the others dropped it breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
        while True:
            remaining = [i for i in ids if i not in removed]
            fin = {i: self.per(Mutation(drop=removed + [i]), bn) for i in remaining}
            extra = [i for i in remaining if first_fail(fin[i]) is None and i not in pinned]
            if not extra:
                break
            for i in extra:
                if first_fail(self.per(Mutation(drop=removed + [i]), bn)) is None:
                    removed.append(i)
                    greedy.append([i, 'dropped in the final pass'])
        back = []
        while vn:
            vr = self.per(Mutation(drop=removed), vn, True)
            ff = first_fail(vr)
            if not ff:
                break
            if ff[1] == 'LIMIT':
                out['verify_undecided'] = ff
                break
            fixed = None
            for r in reversed(removed):
                trial = [x for x in removed if x != r]
                if not first_fail(self.per(Mutation(drop=trial), vn, True)) and \
                        not first_fail(self.per(Mutation(drop=trial), bn)):
                    fixed = r
                    break
            if fixed is None:
                out['error'] = f'the smallest model fails {ff[1]} on {ff[0]} and no single rule put back fixes it'
                break
            removed = [x for x in removed if x != fixed]
            back.append([fixed, f'put back: without it the smallest model breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
            greedy.append(back[-1])
        out['greedy'] = greedy
        out['removed'] = removed
        out['put_back'] = back
        minimal = self.per(Mutation(drop=removed), bn, True)
        out['minimal'] = minimal
        if vn:
            out['verify_result'] = self.per(Mutation(drop=removed), vn, True)
        remaining = [i for i in ids if i not in removed]
        fin = {i: self.per(Mutation(drop=removed + [i]), bn) for i in remaining}
        rows = []
        for r in rl:
            i = r.id
            row = {'id': i, 'kind': 'guard' if isinstance(r, Guard) else 'update', 'role': r.role,
                   'note': r.note, 'cmp': getattr(r, 'op', None)}
            row['alone'] = nec1[i]
            row['kept'] = i not in removed
            row['pinned'] = i in pinned
            if row['kept']:
                per = fin[i]
                ff = first_fail(per)
                if ff is None and vn:
                    per = self.per(Mutation(drop=removed + [i]), vn, True)
                    ff = first_fail(per)
                row['final'] = ff
                row['final_trace'] = _trace_of(per, ff)
            rows.append(row)
        out['rules'] = rows
        if mutate:
            out['mutants'] = self.mutants(removed, minimal, bn, vn, pinned)
        return out

    def mutants(self, removed, minimal, bn, vn, pinned):
        acts = self.cls(list(self.bounds)[0][1]).actions()
        rl = [r for r in rules(acts) if r.id not in removed]
        muts = []
        for r in rl:
            if r.id in pinned:
                continue
            muts.append(('drop', r.id, Mutation(drop=list(removed) + [r.id])))
        for r in rl:
            if isinstance(r, Guard) and r.is_cmp() and r.id not in pinned:
                muts.append(('flip', r.id, Mutation(drop=removed, flip=[r.id])))
        for a in acts:
            live = [k for k, u in enumerate(a.updates) if u.id not in removed and u.id not in pinned]
            for x in range(len(live)):
                for y in range(x + 1, len(live)):
                    i, j = live[x], live[y]
                    muts.append(('swap', f'{a.name}: {a.updates[i].name} <-> {a.updates[j].name}',
                                 Mutation(drop=removed, swap={a.name: (i, j)})))
        rows = []
        for kind, what, m in muts:
            per = self.per(m, bn)
            ff = first_fail(per)
            row = {'kind': kind, 'rule': what}
            if ff and ff[1] == 'LIMIT':
                row['caught'] = None
                row['undecided'] = ff
            elif ff:
                row['caught'] = ff
                row['trace'] = _trace_of(per, ff)
            else:
                vf = first_fail(self.per(m, vn, True)) if vn else None
                if vf and vf[1] != 'LIMIT':
                    row['caught'] = vf
                else:
                    fp = self.per(m, bn, True)
                    same = all(fp[b]['digest'] == minimal[b]['digest'] for b in bn)
                    row['caught'] = None
                    row['equivalent'] = same
            rows.append(row)
        caught = sum(1 for r in rows if r['caught'])
        eq = sum(1 for r in rows if not r['caught'] and r.get('equivalent'))
        und = sum(1 for r in rows if r.get('undecided'))
        self.log(f'  mutants: {len(rows)}; caught {caught}; equivalent {eq}; undecided {und}; '
                 f'survived {len(rows) - caught - eq - und}')
        return rows


def _trace_of(per, ff):
    if not ff or ff[1] == 'LIMIT':
        return None
    b, p, d, _ = ff
    return per[b]['fail'][p][1]


def show_trace(tr, out=sys.stdout, indent='    '):
    for k, lab in enumerate(tr, 1):
        if isinstance(lab, (list, tuple)):
            lab = ' '.join(str(x) for x in lab)
        print(f'{indent}{k:2}. {lab}', file=out)
