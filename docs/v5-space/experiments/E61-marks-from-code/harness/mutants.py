#!/usr/bin/env python3
"""
mutants.py: build-bug mutants of E-61's design, each one a plausible mistake in a build of the library or the
leader (K01 to K15 came from this study's review; K16 and K17 were added with the fixes). Each runs on every
bound of the model, breadth first, until the first bound where a property breaks (so its trace is a shortest
one), or on all of them.

    python3 harness/mutants.py OUT.jsonl [NAME ...]

One JSON line per (mutant, bound) run, then one summary line per mutant on stdout. The engine's own mutants
(drop each rule, flip each comparison, swap each pair of updates) are in the DEV-10 ablation.
"""
import importlib.util
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

spec = importlib.util.spec_from_file_location('e61marks', os.path.join(HERE, '..', 'models', 'marks.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
D = M.Design
LIMIT = int(os.environ.get('LIMIT', '1500000'))


def act(A, name):
    return next(a for a in A if a.name == name)


def set_update(a, uname, fn):
    for u in a.updates:
        if u.name == uname:
            u.fn = fn
            return
    raise KeyError(uname)


def set_guard(a, gname, fn):
    for g in a.guards:
        if g.name == gname:
            g.fn, g.op, g.lhs, g.rhs = fn, None, None, None
            return
    raise KeyError(gname)


class FenceCom(D):
    """K01: the fence carries the marks of the committed entries only."""
    def actions(self):
        A = super().actions()

        def cmarks(md, st, b, d):
            P, a = self.move[0], self.move[1]
            keys = {self.mkey(e[4][0], e[4][1]) for e in self.com(st, a)
                    if e[0] in M.MARKED and e[2] == P and e[4] is not None}
            d.f['_e']['cm'] = frozenset((k, self.mark(st, a, k, P, committed=True)) for k in keys)
        set_update(act(A, 'fence'), 'carry', cmarks)
        return A


class FenceLate(D):
    """K02: the old group keeps judging writes to the slot until its fence commits."""
    def owner(self, st, P):
        if self.move and self.move[0] == P:
            _, a, b = self.move
            if any(e[0] == 'open' and e[1] == P for e in self.log(st, b)):
                return b
            if any(e[0] == 'fence' and e[1] == P for e in self.com(st, a)):
                return None
            return a
        return self.place[P]


class AnswerTail(D):
    """K03: the client takes an answer from the leader's uncommitted tail."""
    @staticmethod
    def answers(grp):
        return grp[0] + grp[1]


class SameLife(D):
    """K04: a restarted loop keeps its old session number."""
    def actions(self):
        A = super().actions()

        def crash(md, st, b, d):
            self.set_own(d, b['i'], up=M.DOWN, pos=(), iss=(), held=())
            self.bump(d, M.C_F, M.C_RR)
        set_update(act(A, 'crash'), 'crash', crash)
        return A


class SkipEarly(D):
    """K05: a skip is answered before the log end it was judged against commits."""
    @staticmethod
    def answers(grp):
        return grp[0] + tuple(e for e in grp[1] if e[0] == 'k')


class MarkWhole(D):
    """K06: an applied write raises the mark to its whole record (the write number is not stored)."""
    def actions(self):
        A = super().actions()

        def setmark(md, st, b, d):
            d.f['_e']['mk'] = self.copy_mk(b['m'])[:3] + (M.WMAX,)
        set_update(act(A, 'apply'), 'mark', setmark)
        return A


class RefuseWhole(D):
    """K07: a refused write raises the mark to its whole record."""
    def actions(self):
        A = super().actions()

        def setmark(md, st, b, d):
            d.f['_e']['mk'] = self.copy_mk(b['m'])[:3] + (M.WMAX,)
        set_update(act(A, 'refuse'), 'mark', setmark)
        return A


def _slot_marks(self, st, name, s):
    for P in self.oslots:
        yield self.mark(st, self.com_owner(st, P), self.mkey(name, s), P, committed=True)


class RpMax(D):
    """K08: derive's restart point is the highest mark over the output slots."""
    def rp_read(self, st, name):
        if self.mode != 'derive':
            return D.rp_read(self, st, name)
        return tuple(max(0 if m == M.NEGM else m[0] + (1 if m[1] == M.WMAX else 0) for m in _slot_marks(self, st, name, s))
                     for s in self.slots_src)


class RpWhole(D):
    """K09: an output's mark counts its record as whole (restart one past it)."""
    def rp_read(self, st, name):
        if self.mode != 'derive':
            return D.rp_read(self, st, name)
        return tuple(min(0 if m == M.NEGM else m[0] + 1 for m in _slot_marks(self, st, name, s)) for s in self.slots_src)


class AnsweredOff1(D):
    """K11: run()'s cursor passes the last record read before its writes are answered (off by one)."""
    def actions(self):
        A = super().actions()

        def answered(w, st, b):
            for x in self.own(st, b['i'])[3]:
                if x[2][0] == 'o':
                    nm, s, q, P, c = self.outs[x[2][1]]
                    if s == b['s'] and q < b['p'] - 1 and x[3] == M.WAIT:
                        return False
            return True
        set_guard(act(A, 'cursor'), 'answered', answered)
        return A


class OseqPerOwner(D):
    """K12: issue order is kept per process, not per session (a restart reuses the numbers)."""
    def oseq(self, st, g, sess, P, committed=False, grp=None):
        hi = 0
        ents = (grp[0] if committed else grp[0] + grp[1]) if grp is not None else self.ents(st, g, committed)
        for e in ents:
            if e[0] in M.JUDGED and e[1][0] == sess[0] and e[2] == P:
                hi = max(hi, e[3])
            elif e[0] == 'open' and e[1] == P:
                for ss, h in e[2][1]:
                    if ss[0] == sess[0]:
                        hi = max(hi, h)
        return hi


class ResyncTail(D):
    """K14: on `expired` the reader reads its marks (or cursor) again from the leader's log end, tail included."""
    def rp_resync(self, st, name):
        return self.rp_from(st, name, True)


class RefusedBlocks(D):
    """K15: run()'s cursor treats a refused write as not answered."""
    def actions(self):
        A = super().actions()

        def answered(w, st, b):
            for x in self.own(st, b['i'])[3]:
                if x[2][0] == 'o':
                    nm, s, q, P, c = self.outs[x[2][1]]
                    if s == b['s'] and q < b['p'] and x[3] in (M.WAIT, M.REF):
                        return False
            return True
        set_guard(act(A, 'cursor'), 'answered', answered)
        return A


class ResumeOldPos(D):
    """K16: a loop that ended on an error (a gap, a spent write) is started again in the same process from its own
    read position, not from the marks."""
    def end_loop(self, d, i):
        o = d.f['ds'][i]
        if o[0] + 1 < self.lmax:
            self.set_own(d, i, life=o[0] + 1, up=M.DOWN, iss=(), held=())
        else:
            self.set_own(d, i, up=M.GAVEUP, pos=(), iss=(), held=())

    def actions(self):
        A = super().actions()

        def start(md, st, b, d):
            i = b['i']
            o = d.f['ds'][i]
            tok = st[M.IX['hold']][1] if (self.share and self.owners[i] == self.shared) else 0
            pos = o[2] if o[2] else self.rp_read(st, self.owners[i])
            self.set_own(d, i, up=M.UP, pos=pos, iss=(), held=(), tok=tok)
        set_update(act(A, 'start'), 'read', start)
        return A


class SkipByRecord(D):
    """K17: the leader's skip compares the record only, not the write's number."""
    def actions(self):
        A = super().actions()
        set_guard(act(A, 'skip'), 'below', lambda w, st, b: self.mk_of(st, b)[0] <= self.mark_of(st, b)[0])
        return A


MUTANTS = {
    'K01-fence-com': (FenceCom, ()),
    'K02-fence-late': (FenceLate, ()),
    'K03-answer-tail': (AnswerTail, ()),
    'K04-same-life': (SameLife, ()),
    'K05-skip-early': (SkipEarly, ()),
    'K06-mark-whole': (MarkWhole, ()),
    'K07-refuse-whole': (RefuseWhole, ()),
    'K08-rp-max': (RpMax, ()),
    'K09-rp-whole': (RpWhole, ()),
    'K10-bare-busy': (D, ('bare.idle', 'bmark.inorder')),
    'K11-answered-off1': (AnsweredOff1, ()),
    'K12-oseq-per-owner': (OseqPerOwner, ()),
    'K13-min-over-marked': (M.OPTIONS['marks-marked'], ()),
    'K14-resync-tail': (ResyncTail, ()),
    'K15-refused-blocks': (RefusedBlocks, ()),
    'K16-resume-old-pos': (ResumeOldPos, ()),
    'K17-skip-by-record': (SkipByRecord, ()),
}
WHAT = {
    'K01-fence-com': 'the fence carries only the committed marks',
    'K02-fence-late': 'the old group keeps judging writes until its fence commits',
    'K03-answer-tail': 'the client takes an answer from the uncommitted tail',
    'K04-same-life': 'a restarted loop keeps its old session number',
    'K05-skip-early': 'a skip is answered before the log end it was judged on commits',
    'K06-mark-whole': 'an applied write marks its whole record (no write number stored)',
    'K07-refuse-whole': 'a refused write marks its whole record',
    'K08-rp-max': 'marks() takes the highest mark over the slots',
    'K09-rp-whole': 'an output\'s mark counts its record as whole',
    'K10-bare-busy': 'a bare mark is sent while a write waits, and bare marks skip issue order',
    'K11-answered-off1': 'run()\'s cursor passes the last record before its writes are answered',
    'K12-oseq-per-owner': 'issue order is kept per process, not per session',
    'K13-min-over-marked': 'marks() takes the lowest mark over only the slots that have one',
    'K14-resync-tail': 'on `expired`, the marks are read again with the uncommitted tail',
    'K15-refused-blocks': 'run()\'s cursor treats a refused write as not answered',
    'K16-resume-old-pos': 'a loop that ended on an error starts again from its own position, not the marks',
    'K17-skip-by-record': 'the leader\'s skip compares the record only, not the write\'s number',
}

def order():
    """The ablation's order: smallest bounds first, then its two verify bounds."""
    return list(M.SWEEP) + list(M.VERIFY)


def run1(cls, bound, drop=()):
    t0 = time.time()
    r = engine.explore(cls(bound), engine.Mutation(drop=list(drop)), stop_first=True, limit=LIMIT)
    row = {'states': r.states, 'complete': r.complete, 'secs': round(time.time() - t0, 1)}
    if r.fail:
        p = min(r.fail, key=lambda k: r.fail[k][0])
        row['broke'] = sorted(r.fail)
        row['first'] = p
        row['steps'] = r.fail[p][0]
        row['trace'] = [' '.join(str(x) for x in lab) for lab in r.fail[p][1]]
    return row


def main():
    out, names = sys.argv[1], sys.argv[2:] or list(MUTANTS)
    with open(out, 'a') as f:
        for n in names:
            cls, drop = MUTANTS[n]
            caught, stopped = None, []
            for b in order():
                row = run1(cls, M.BOUNDS[b], drop)
                row.update({'mutant': n, 'what': WHAT[n], 'bound': b, 'drop': list(drop)})
                f.write(json.dumps(row) + '\n')
                f.flush()
                if 'broke' in row:
                    caught = (b, row['first'], row['steps'])
                    break
                if not row['complete']:
                    stopped.append(b)
            print(n, '->', caught or 'survived every bound', ('(stopped at the state limit: ' + ', '.join(stopped) + ')')
                  if stopped and not caught else '', flush=True)


if __name__ == '__main__':
    main()
