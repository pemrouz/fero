"""
saga.py: the saga library of DESIGN-V5 5.3 (locks with fences, an intent row,
steps, a later holder that finishes or undoes), with paused holders and a
crash at every step. E-24 (QUESTIONS Q-24).

THE WORLD (not counted). Data partitions p, q (and r in one bound), each in a
group of its own, so a unit's steps land in up to three groups. `#locks` and
`#sagas` share one more group, M. Every group is an abstract Raft group with
one writer: a write is judged and applied at once, and the writer's answer
reaches the caller in the same step (E-14 and E-15 check Raft and moves). A
unit is a list of steps in key order; step i appends the unit's id to the
list held at partition parts[i] (Elle's list-append, as E-22's P-15 workload
writes units). An append is "push if absent", so it is idempotent: a later
holder may re-run a step that was applied. Its undo removes the id.

Processes. Each unit has an original holder (`a`, never restarts) and may
have a later holder (`b`: the app calling saga(steps, { id }) again; it
restarts after a crash, as the app's retry loop would). A process runs the
saga program: claim the unit's locks in key order, read `#sagas`, then begin,
continue (adopt) or skip; run steps or undo them; record the end.

Faults (budgets): a crash (the process stops for good, or a `b` restarts
later); a lease that lapses while its holder is alive (a paused holder: it
does not know, and acts later with its old tokens); a step whose app
condition fails (the saga must undo); a top-up of a refused step's data (the
step may then pass on a later attempt). A crashed or finished holder's lease
lapses with time (calm). Writers may follow `#locks` with any lag (options
that use it).

WHAT IS COUNTED (DEV-10). The saga program's guards and updates: lock claims,
the intent row's writes and their fences, step and undo writes and their
fences, the order of the program, and each option's extra rules. Budgets and
world steps are not rules (`fails.count` is pinned).

PROPERTIES
  A1  all or nothing: a unit recorded `done` has its id in every list of its
      steps; one recorded `undone` has it in none. Every state, so a late
      write by a paused holder after the end is caught.
  A2  no write cycle between units (Elle's G0): two units in the same two
      lists appear in the same order in both.
  L1  AG EF: every unit can end `done` or `undone` once faults stop
      (holders act, dead holders' leases lapse, `b` restarts). A step's
      condition is judged on the data when the write arrives: a refused step
      is refused again until its data changes (`topup`, a fault with a
      budget), and may then pass for any holder, a paused one included. Once
      faults stop a refused step stays refused, so its unit must be undone.

OPTIONS
  draft     5.3 as written: steps fenced by their partition's lock; each
            group keeps the highest token per lock; writers follow `#locks`
            (with lag) and refuse a token below the version they have seen; a
            later holder that finds an intent continues it (forward if `run`,
            backward if `undo`). A failed step undoes the steps before it.
  owned     draft plus E-22's F3: a holder that finds another unit's
            unfinished intent on its partitions resolves it first, and a
            holder begins its own unit only when none is unfinished there.
  bump      owned, with no following of `#locks`: a later holder raises the
            fence at every partition of a unit it adopts before it acts on it
            (Kafka KIP-98's epoch bump on every registered partition).
  fullundo  owned, with no following and no bump: a failed run undoes every
            step, the failed one and the ones after it too (each undo is a
            write that raises the fence there).
  raise     owned, with no following: a step refused by its condition still
            raises the fence (a kernel change: the refusal commits a record).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

FIELDS = ('locks', 'intents', 'lists', 'fence', 'follow', 'procs', 'faults', 'lapses', 'fails', 'bad', 'tops')
IX = {f: i for i, f in enumerate(FIELDS)}
UNFIN = ('run', 'undo')
END = ('end',)


class Saga:
    CALM = ('deliver', 'time', 'restart')
    INFO = ()
    FOLLOW = True       # writers follow #locks and refuse below the version they saw
    OWN = False         # resolve another's unfinished unit first (E-22 F3)
    BUMP = False        # a later holder raises every partition's fence before acting
    FULLUNDO = False    # a failed run undoes every step
    RAISE = False       # a step refused by its condition still raises the fence

    def __init__(self, bound):
        self.b = bound
        self.units = bound['units']                  # {u: (part, ...)} in key order
        self.uids = tuple(sorted(self.units))
        self.parts = tuple(sorted({x for ps in self.units.values() for x in ps}))
        self.px = {x: i for i, x in enumerate(self.parts)}
        self.procs = bound['procs']                  # ((name, unit, kind), ...)
        self.P = len(self.procs)

    # ------------------------------------------------------------ state
    def init(self):
        locks = tuple((0, -1, False) for _ in self.parts)     # (token, holder, lapsed)
        intents = tuple('' for _ in self.uids)
        lists = tuple(() for _ in self.parts)
        zeros = tuple(0 for _ in self.parts)
        procs = tuple((('lock', 0), tuple(0 for _ in self.units[u]), 0, True, None)
                      for _, u, _ in self.procs)
        return (locks, intents, lists, zeros, zeros, procs, 0, 0, 0, frozenset(), 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    # ------------------------------------------------------------ helpers
    def unit(self, h):
        return self.procs[h][1]

    def ui(self, u):
        return self.uids.index(u)

    def tok(self, st, h, x):
        """h's token for the lock of partition x (0 if its unit has no such lock)."""
        ps = self.units[self.unit(h)]
        return st[IX['procs']][h][1][ps.index(x)] if x in ps else 0

    def cur(self, st, h):
        """The partition h's current step or undo or bump is at."""
        pc, _, tgt, _, _ = st[IX['procs']][h]
        return self.units[self.unit(h) if pc[0] == 'bump' else tgt][pc[1]]

    def lockrow(self, st, x):
        return st[IX['locks']][self.px[x]]

    @staticmethod
    def setp(d, h, **kw):
        procs = list(d.f['procs'])
        pc, toks, tgt, up, res = procs[h]
        v = dict(pc=pc, toks=toks, tgt=tgt, up=up, res=res)
        v.update(kw)
        procs[h] = (v['pc'], v['toks'], v['tgt'], v['up'], v['res'])
        d.f['procs'] = tuple(procs)

    @staticmethod
    def setat(d, field, i, v):
        t = list(d.f[field])
        t[i] = v
        d.f[field] = tuple(t)

    def resume(self, st, u):
        """Where a holder continues a unit it adopts: the recorded direction."""
        if st[IX['intents']][self.ui(u)] == 'undo':
            return ('undo', len(self.units[u]) - 1)
        return ('step', 0)

    # ------------------------------------------------------------ world
    def world(self, st):
        out = []
        locks, intents, lists, fence, follow, procs, faults, lapses, fails, bad, tops = st
        for h, (name, u, kind) in enumerate(self.procs):
            pc, toks, tgt, up, res = procs[h]
            if up and pc != END and faults < self.b['crashes']:
                d = self._d(st)
                self.setp(d, h, up=False)
                d.f['faults'] = faults + 1
                out.append((('crash', name), 'fault', self.freeze(d)))
            held = [i for i, (t, who, lap) in enumerate(locks) if who == h and not lap]
            if held:
                dead = (not up) or pc == END
                if dead or lapses < self.b['lapses']:
                    d = self._d(st)
                    lk = list(locks)
                    for i in held:
                        lk[i] = (lk[i][0], h, True)
                    d.f['locks'] = tuple(lk)
                    if not dead:
                        d.f['lapses'] = lapses + 1
                    out.append((('lapse', name), 'time' if dead else 'fault', self.freeze(d)))
            if kind == 'b' and not up and not held:
                d = self._d(st)
                self.setp(d, h, pc=('lock', 0), toks=tuple(0 for _ in self.units[u]), tgt=0, up=True, res=None)
                out.append((('restart', name), 'restart', self.freeze(d)))
        # the data a refused step's condition reads changes (a budget is topped
        # up), so that step may pass on a later attempt: a fault with a budget,
        # so liveness must hold when a refused step stays refused for good
        if tops < self.b['topups']:
            for (u, i) in sorted(bad):
                d = self._d(st)
                d.f['bad'] = bad - {(u, i)}
                d.f['tops'] = tops + 1
                out.append((('topup', u, i), 'fault', self.freeze(d)))
        if self.FOLLOW:
            for i, x in enumerate(self.parts):
                if follow[i] != locks[i][0]:
                    d = self._d(st)
                    self.setat(d, 'follow', i, locks[i][0])
                    out.append((('follow', x), 'deliver', self.freeze(d)))
        return out

    def _d(self, st):
        class D:
            pass
        d = D()
        d.f = self.to_draft(st)
        return d

    # ------------------------------------------------------------ properties
    def check(self, st):
        bad = []
        intents, lists = st[IX['intents']], st[IX['lists']]
        for u in self.uids:
            s = intents[self.ui(u)]
            ins = [u in lists[self.px[x]] for x in self.units[u]]
            if (s == 'done' and not all(ins)) or (s == 'undone' and any(ins)):
                bad.append('A1')
                break
        for i in range(len(self.parts)):
            for j in range(i + 1, len(self.parts)):
                a, b = lists[i], lists[j]
                common = [u for u in a if u in b]
                if [u for u in b if u in common] != common:
                    bad.append('A2')
                    break
            if 'A2' in bad:
                break
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        # every unit ends (not only those begun: a model that never begins a
        # unit must not pass)
        return {'L1': all(s in ('done', 'undone') for s in st[IX['intents']])}

    def judged(self, st):
        return {'L1': True}

    # ------------------------------------------------------------ the program
    def actions(self):
        O = self

        def ups(w, st):
            for h in range(O.P):
                pc, toks, tgt, up, res = st[IX['procs']][h]
                if up and pc != END:
                    yield {'h': h}

        def others(w, st):
            # topology, not a rule: a holder can resolve a unit whose partitions
            # are among its own (it holds their locks)
            for h in range(O.P):
                pc, toks, tgt, up, res = st[IX['procs']][h]
                if up and pc != END:
                    u = O.unit(h)
                    for v in O.uids:
                        if v != u and set(O.units[v]) <= set(O.units[u]):
                            yield {'h': h, 'v': v}

        def fails_left(w, st):
            # world semantics, not rules: a step's condition is judged against
            # the partition's data when the write arrives. A step refused once
            # is refused again (free) until its data changes (`topup`, a
            # fault in world()), and may then pass; a first refusal takes the
            # budget; and a re-run of a step that is applied answers its first
            # outcome, "applied" (dedup by attempt id, which is the saga id and
            # the step), so only a step not applied is refused
            for b in ups(w, st):
                pc_, _, tgt, _, _ = st[IX['procs']][b['h']]
                if tgt not in O.units:
                    yield b                        # a mutant left no target: let the rules fail (ERR)
                elif pc_[0] == 'step' and tgt not in st[IX['lists']][O.px[O.units[tgt][pc_[1]]]]:
                    if (tgt, pc_[1]) in st[IX['bad']] or st[IX['fails']] < O.b['fails']:
                        yield b

        def can_step(w, st):
            # world semantics: a step refused, whose data has not changed since
            # (`bad`), is refused again; it cannot pass
            for b in ups(w, st):
                pc_, _, tgt, _, _ = st[IX['procs']][b['h']]
                if not (pc_[0] == 'step' and (tgt, pc_[1]) in st[IX['bad']]):
                    yield b

        P_ = lambda st, b: st[IX['procs']][b['h']]
        pc = lambda st, b: P_(st, b)[0]
        U = lambda b: O.unit(b['h'])
        intent = lambda st, u: st[IX['intents']][O.ui(u)]

        # --- fences at M (#locks and #sagas share M, so the writer checks the lock row itself)
        def holds0(name):
            return Cmp(name, lambda w, st, b: O.tok(st, b['h'], O.units[U(b)][0]), '>=',
                       lambda w, st, b: O.lockrow(st, O.units[U(b)][0])[0], role='fence',
                       note="an intent write carries the first lock's token; M refuses one below the lock's version")

        def holdsN(name):
            return Guard(name, lambda w, st, b: all(O.tok(st, b['h'], x) >= O.lockrow(st, x)[0]
                                                    for x in O.units[U(b)][1:]), role='fence',
                         note="... and the other locks' tokens")

        def noother(name):
            return Guard(name, lambda w, st, b: not any(
                v != U(b) and intent(st, v) in UNFIN and set(O.units[v]) & set(O.units[U(b)])
                for v in O.uids), role='own',
                note='F3: no other unit is unfinished on my partitions')

        # --- fences at a partition's writer
        def pfence(name):
            return Cmp(name, lambda w, st, b: O.tok(st, b['h'], O.cur(st, b['h'])), '>=',
                       lambda w, st, b: st[IX['fence']][O.px[O.cur(st, b['h'])]], role='fence',
                       note="the writer refuses a token below the highest it has seen for the partition's lock")

        def pfollow(name):
            return Cmp(name, lambda w, st, b: O.tok(st, b['h'], O.cur(st, b['h'])), '>=',
                       lambda w, st, b: st[IX['follow']][O.px[O.cur(st, b['h'])]], role='follow',
                       note="... and below the lock's version it has seen by following #locks")

        def raise_(name):
            def f(w, st, b, d):
                x = O.cur(st, b['h'])
                O.setat(d, 'fence', O.px[x], max(st[IX['fence']][O.px[x]], O.tok(st, b['h'], x)))
            return Update(name, f, role='fence', note='the write raises the partition\'s fence to its token')

        # --- updates
        def claim_lock(w, st, b, d):
            h = b['h']
            x = O.units[U(b)][pc(st, b)[1]]
            t = O.lockrow(st, x)[0]
            O.setat(d, 'locks', O.px[x], (t + 1, h, False))

        def claim_tok(w, st, b, d):
            h = b['h']
            k = pc(st, b)[1]
            x = O.units[U(b)][k]
            toks = list(d.f['procs'][h][1])
            toks[k] = O.lockrow(st, x)[0] + 1
            O.setp(d, h, toks=tuple(toks))

        def claim_pc(w, st, b, d):
            k = pc(st, b)[1]
            nxt = ('bump', 0) if O.BUMP else ('read',)
            O.setp(d, b['h'], pc=('lock', k + 1) if k + 1 < len(O.units[U(b)]) else nxt)

        def begin_intent(w, st, b, d):
            O.setat(d, 'intents', O.ui(U(b)), 'run')

        def set_tgt_own(w, st, b, d):
            O.setp(d, b['h'], tgt=U(b))

        def begin_pc(w, st, b, d):
            O.setp(d, b['h'], pc=('step', 0))

        def adopt_pc(u_of):
            def f(w, st, b, d):
                O.setp(d, b['h'], pc=O.resume(st, u_of(b)))
            return f

        def step_data(w, st, b, d):
            x = O.cur(st, b['h'])
            tgt = P_(st, b)[2]
            lst = st[IX['lists']][O.px[x]]
            if tgt not in lst:
                O.setat(d, 'lists', O.px[x], lst + (tgt,))

        def step_pc(w, st, b, d):
            i = pc(st, b)[1]
            n = len(O.units[P_(st, b)[2]])
            O.setp(d, b['h'], pc=('step', i + 1) if i + 1 < n else ('close', 'done'))

        def bump_pc(w, st, b, d):
            i = pc(st, b)[1]
            n = len(O.units[U(b)])
            O.setp(d, b['h'], pc=('bump', i + 1) if i + 1 < n else ('read',))

        def fail_count(w, st, b, d):
            pc_, _, tgt, _, _ = st[IX['procs']][b['h']]
            if (tgt, pc_[1]) not in st[IX['bad']]:
                d.f['fails'] = st[IX['fails']] + 1
                d.f['bad'] = st[IX['bad']] | {(tgt, pc_[1])}

        def fail_pc(w, st, b, d):
            O.setp(d, b['h'], pc=('failed', pc(st, b)[1]))

        def decide_intent(w, st, b, d):
            O.setat(d, 'intents', O.ui(P_(st, b)[2]), 'undo')

        def decide_pc(w, st, b, d):
            i = pc(st, b)[1]
            n = len(O.units[P_(st, b)[2]])
            j = n - 1 if O.FULLUNDO else i - 1
            O.setp(d, b['h'], pc=('undo', j) if j >= 0 else ('close', 'undone'))

        def undo_data(w, st, b, d):
            x = O.cur(st, b['h'])
            tgt = P_(st, b)[2]
            lst = st[IX['lists']][O.px[x]]
            O.setat(d, 'lists', O.px[x], tuple(v for v in lst if v != tgt))

        def undo_pc(w, st, b, d):
            i = pc(st, b)[1]
            O.setp(d, b['h'], pc=('undo', i - 1) if i > 0 else ('close', 'undone'))

        def close_intent(w, st, b, d):
            O.setat(d, 'intents', O.ui(P_(st, b)[2]), pc(st, b)[1])

        def close_pc(w, st, b, d):
            O.setp(d, b['h'], pc=END if P_(st, b)[2] == U(b) else ('read',))

        def skip_pc(w, st, b, d):
            O.setp(d, b['h'], pc=END)

        is_ = lambda kind: (lambda w, st, b: pc(st, b)[0] == kind)

        acts = []
        acts.append(Action('claim', 'deliver', ups, [
            Guard('seq', is_('lock'), role='seq', note='claim the locks in key order, one at a time'),
            Guard('free', lambda w, st, b: (lambda r: r[1] == -1 or r[2])(
                O.lockrow(st, O.units[U(b)][pc(st, b)[1]])), role='lock',
                note="a claim succeeds only if the lock is absent or its lease lapsed"),
        ], [
            Update('lock', claim_lock, role='lock', note='the lock row: a new version (the token), this holder'),
            Update('tok', claim_tok, role='lock', note='the holder keeps the token'),
            Update('pc', claim_pc, role='seq'),
        ]))
        g_begin = [Guard('seq', is_('read'), role='seq'),
                   Guard('absent', lambda w, st, b: intent(st, U(b)) == '', role='intent',
                         note='write the intent only if none exists (if: absent)')]
        if O.OWN:
            g_begin.append(noother('noother'))
        g_begin += [holds0('holds0'), holdsN('holdsN')]
        acts.append(Action('begin', 'deliver', ups, g_begin, [
            Update('intent', begin_intent, role='intent', note='the intent row: run'),
            Update('tgt', set_tgt_own, role='seq'),
            Update('pc', begin_pc, role='seq'),
        ]))
        g_adopt = [Guard('seq', is_('read'), role='seq'),
                   Guard('unfin', lambda w, st, b: intent(st, U(b)) in UNFIN, role='intent',
                         note='a later holder that finds the intent continues it')]
        if O.OWN:
            g_adopt.append(noother('noother'))
        acts.append(Action('adopt', 'deliver', ups, g_adopt, [
            Update('tgt', set_tgt_own, role='seq'),
            Update('pc', adopt_pc(lambda b: O.unit(b['h'])), role='recover',
                   note='continue in the recorded direction'),
        ]))
        if O.OWN:
            acts.append(Action('other', 'deliver', others, [
                Guard('seq', is_('read'), role='seq'),
                Guard('unfin', lambda w, st, b: intent(st, b['v']) in UNFIN, role='own',
                      note="F3: another unit's unfinished intent on my partitions"),
            ], [
                Update('tgt', lambda w, st, b, d: O.setp(d, b['h'], tgt=b['v']), role='own',
                       note='F3: resolve it first, with my tokens'),
                Update('pc', adopt_pc(lambda b: b['v']), role='recover'),
            ]))
        if O.OWN:
            def release(w, st, b, d):
                h = b['h']
                for x in O.units[U(b)]:
                    t, who, lap = O.lockrow(st, x)
                    if who == h:
                        O.setat(d, 'locks', O.px[x], (t, h, True))

            acts.append(Action('backoff', 'deliver', ups, [
                Guard('seq', is_('read'), role='seq'),
                Guard('blocked', lambda w, st, b: any(
                    v != U(b) and intent(st, v) in UNFIN and set(O.units[v]) & set(O.units[U(b)])
                    and not set(O.units[v]) <= set(O.units[U(b)]) for v in O.uids), role='own',
                      note='F3: an unfinished unit on my partitions that needs locks I do not hold'),
                holds0('holds0'), holdsN('holdsN'),
            ], [
                Update('release', release, role='own', note='release my locks (only rows I still hold) so its holder can finish it'),
                Update('pc', lambda w, st, b, d: O.setp(d, b['h'], pc=('wait',),
                                                         toks=tuple(0 for _ in O.units[U(b)])), role='seq'),
            ]))
            acts.append(Action('retry', 'deliver', ups, [
                Guard('seq', is_('wait'), role='seq'),
                noother('noother'),
            ], [
                Update('pc', lambda w, st, b, d: O.setp(d, b['h'], pc=('lock', 0)), role='seq'),
            ]))
        acts.append(Action('skip', 'deliver', ups, [
            Guard('seq', is_('read'), role='seq'),
            Guard('ended', lambda w, st, b: intent(st, U(b)) in ('done', 'undone'), role='intent',
                  note='a unit already ended runs once only'),
        ], [Update('pc', skip_pc, role='seq')]))
        if O.BUMP:
            acts.append(Action('bump', 'deliver', ups, [
                Guard('seq', is_('bump'), role='seq'),
                pfence('fence'),
            ], [
                raise_('raise'),
                Update('pc', bump_pc, role='seq'),
            ]))
        g_step = [Guard('seq', is_('step'), role='seq'), pfence('fence')]
        if O.FOLLOW:
            g_step.append(pfollow('follow'))
        acts.append(Action('step', 'deliver', can_step, g_step, [
            Update('data', step_data, role='data', note='push the unit id if absent'),
            raise_('raise'),
            Update('pc', step_pc, role='seq'),
        ]))
        g_fail = [Guard('seq', is_('step'), role='seq'), pfence('fence')]
        if O.FOLLOW:
            g_fail.append(pfollow('follow'))
        u_fail = [Update('count', fail_count, role='world'), Update('pc', fail_pc, role='seq')]
        if O.RAISE:
            u_fail.insert(1, raise_('raise'))
        acts.append(Action('fail', 'deliver', fails_left, g_fail, u_fail))
        acts.append(Action('decide', 'deliver', ups, [
            Guard('seq', is_('failed'), role='seq'),
            holds0('holds0'), holdsN('holdsN'),
        ], [
            Update('intent', decide_intent, role='intent', note='record undo before compensating'),
            Update('pc', decide_pc, role='seq'),
        ]))
        g_undo = [Guard('seq', is_('undo'), role='seq'), pfence('fence')]
        if O.FOLLOW:
            g_undo.append(pfollow('follow'))
        acts.append(Action('undo', 'deliver', ups, g_undo, [
            Update('data', undo_data, role='data', note='remove the unit id'),
            raise_('raise'),
            Update('pc', undo_pc, role='seq'),
        ]))
        def release_mine(w, st, b, d):
            h = b['h']
            for x in O.units[U(b)]:
                t, who, lap = O.lockrow(st, x)
                if who == h and t == O.tok(st, h, x):
                    O.setat(d, 'locks', O.px[x], (t, h, True))

        acts.append(Action('giveup', 'deliver', ups, [
            Guard('lost', lambda w, st, b: any(0 < O.tok(st, b['h'], x) < O.lockrow(st, x)[0]
                                               for x in O.units[U(b)]), role='lock',
                  note='a holder whose lock has a newer version (it was refused fenced) stops'),
        ], [
            Update('release', release_mine, role='lock', note='and releases the rows it still holds'),
            Update('pc', lambda w, st, b, d: O.setp(d, b['h'], pc=('lock', 0), tgt=0,
                                                     toks=tuple(0 for _ in O.units[U(b)])), role='seq',
                   note='the app calls saga(steps, { id }) again until it gets an answer'),
        ]))
        acts.append(Action('close', 'deliver', ups, [
            Guard('seq', is_('close'), role='seq'),
            holds0('holds0'), holdsN('holdsN'),
        ], [
            Update('intent', close_intent, role='intent', note='record done or undone (kept, so a retry runs once)'),
            Update('pc', close_pc, role='seq'),
        ]))
        return acts


class Owned(Saga):
    OWN = True


class Bump(Saga):
    OWN, FOLLOW, BUMP = True, False, True


class FullUndo(Saga):
    OWN, FOLLOW, FULLUNDO = True, False, True


class Raise(Saga):
    OWN, FOLLOW, RAISE = True, False, True


class Draft(Saga):
    pass


OPTIONS = {'draft': Draft, 'owned': Owned, 'bump': Bump, 'fullundo': FullUndo, 'raise': Raise}
PINNED = {k: ('fail.count',) for k in OPTIONS}

A1, A2, B1, B2 = ('a1', 1, 'a'), ('a2', 2, 'a'), ('b1', 1, 'b'), ('b2', 2, 'b')
BOUNDS = {
    # one unit over two groups: a paused holder, a crash, a failing step
    'one': dict(units={1: ('p', 'q')}, procs=(A1, B1), crashes=1, lapses=1, fails=1, topups=1),
    # two units on the same two partitions: write cycles (G0)
    'two': dict(units={1: ('p', 'q'), 2: ('p', 'q')}, procs=(A1, A2, B1), crashes=0, lapses=1, fails=0, topups=0),
    # a unit inside another's partitions, with failures
    'sub': dict(units={1: ('p', 'q'), 2: ('q',)}, procs=(A1, A2, B1), crashes=0, lapses=1, fails=1, topups=1),
    # one unit over three groups, two paused leases
    'three': dict(units={1: ('p', 'q', 'r')}, procs=(A1, B1), crashes=1, lapses=2, fails=1, topups=1),
    # verify: two units, failures and two faults of each kind
    'two-f': dict(units={1: ('p', 'q'), 2: ('p', 'q')}, procs=(A1, A2, B1, B2), crashes=1, lapses=1, fails=1, topups=1),
    'one2': dict(units={1: ('p', 'q')}, procs=(A1, B1), crashes=2, lapses=2, fails=1, topups=1),
    'sub-f': dict(units={1: ('p', 'q'), 2: ('q',)}, procs=(A1, A2, B1, B2), crashes=1, lapses=1, fails=1, topups=1),
}
SWEEP = ('one', 'two', 'sub', 'three')
VERIFY = ('one2', 'two-f', 'sub-f')
