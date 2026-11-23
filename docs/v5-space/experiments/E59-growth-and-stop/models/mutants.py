#!/usr/bin/env python3
"""
mutants.py: hand-written mutants of the design (a builder's likely mistakes),
beyond the mechanical drops, flips and swaps of ablate.py. Each mutant runs on
every bound in order (sweep, verify, extra) and stops at the first property
that breaks. A mutant that breaks nothing survives; "equivalent" is a reading
of the code, written next to it, not a check.

    python3 models/mutants.py [--jobs 2] [--limit 2000000] [OPTION:MUTANT ...]

m1-m20 were written by the review of this record; m21-m26 test the rules
added after it (the bounded exit, the held check, the restart).
"""
import argparse
import multiprocessing as mp
import os
import resource
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402
import importlib.util  # noqa: E402

CAP = int(os.environ.get('MEMCAP_MB', '4000')) * 1024 * 1024
spec = importlib.util.spec_from_file_location('grow', os.path.join(HERE, 'grow.py'))
G = importlib.util.module_from_spec(spec)
sys.modules['grow'] = G
spec.loader.exec_module(G)
from grow import UP, DOWN, EXIT, LEAVING, NONE, ST, RT, LV, LMS, LG, CM, maj, cfg_of, tset, E  # noqa: E402


def act(acts, name):
    return next(a for a in acts if a.name == name)


def guard(acts, an, gn):
    return next(g for g in act(acts, an).guards if g.name == gn)


def drop_guard(acts, an, gn):
    a = act(acts, an)
    a.guards = [g for g in a.guards if g.name != gn]


def ex_committed_only(w, st, m):
    g = w.gcfg(st)
    if not g:
        return True
    V, L, i = g
    rest = [v for v in V if v != m and st[ST][v] == UP]
    return maj(len(rest), len(V)) and all(w.cfg(st, v) is not None and w.cfg(st, v)[2] >= i for v in rest)


def ex_noapplied(w, st, m):
    g = w.gcfg(st)
    if not g:
        return True
    V = g[0]
    if not maj(sum(1 for v in V if v != m and st[ST][v] == UP), len(V)):
        return False
    for x in range(w.N):
        if st[ST][x] == EXIT:
            continue
        for e in st[LG][x][len(st[CM]):]:
            if e[1][0] == 'c' and m in e[1][1]:
                Vp = e[1][1]
                if not maj(sum(1 for v in Vp if v != m and st[ST][v] == UP), len(Vp)):
                    return False
    return True


def ex_countself(w, st, m):
    g = w.gcfg(st)
    if not g:
        return True
    V, L, i = g
    if not maj(sum(1 for v in V if st[ST][v] == UP), len(V)):
        return False
    return all(w.cfg(st, v) is not None and w.cfg(st, v)[2] >= i for v in V if v != m and st[ST][v] == UP)


def M1(w, acts):    # the exit check ignores configs in flight
    for an in ('exit', 'exitms'):
        guard(acts, an, 'safe').fn = lambda w, st, b: ex_committed_only(w, st, b['m'])


def M2(w, acts):    # the exit check does not ask that the voters left applied the latest config
    for an in ('exit', 'exitms'):
        guard(acts, an, 'safe').fn = lambda w, st, b: ex_noapplied(w, st, b['m'])


def M3(w, acts):    # the exit check counts the leaver among the voters left
    for an in ('exit', 'exitms'):
        guard(acts, an, 'safe').fn = lambda w, st, b: ex_countself(w, st, b['m'])


def M4(w, acts):    # the exit check is waived while any machine is down
    for an in ('exit', 'exitms'):
        g = guard(acts, an, 'safe')
        f = g.fn
        g.fn = lambda w, st, b, f=f: any(x == DOWN for x in st[ST]) or f(w, st, b)


def M5(w, acts):    # promote.pair accepts the learner being promoted (one promotion from one voter)
    guard(acts, 'promote', 'pair').fn = lambda w, st, b: len(w.V(st, b['n'])) != 1 or any(
        x in w.plc(st, b['n']) and w.live(st, x) and not w.ret(st, x) and w.caught(st, b['n'], x)
        for x in w.Lr(st, b['n']))


def M6(w, acts):    # promote.pair does not ask the second learner to hold the commit offset
    guard(acts, 'promote', 'pair').fn = lambda w, st, b: len(w.V(st, b['n'])) != 1 or any(
        x != b['m'] and x in w.plc(st, b['n']) and w.live(st, x) and not w.ret(st, x) for x in w.Lr(st, b['n']))


def M7(w, acts):    # lrem's majority over the old set size
    def f(w, st, b):
        V = w.V(st, b['n'])
        return maj(sum(1 for v in V - {b['m']} if w.live(st, v)), len(V))
    guard(acts, 'lrem', 'maj').fn = f


def M8(w, acts):    # V4-60 fires before leave.ms
    guard(acts, 'ldead', 'carry').fn = lambda w, st, b: any(
        st[RT][x] == LEAVING and x in w.V(st, b['n']) for x in range(w.N) if x != b['m'])


def M9(w, acts):    # V4-60 with no majority check
    drop_guard(acts, 'ldead', 'maj')


def M10(w, acts):   # dropl drops a gone voter too
    guard(acts, 'dropl', 'learner').fn = lambda w, st, b: b['m'] in (w.Lr(st, b['n']) | w.V(st, b['n']))
    u = act(acts, 'dropl').updates[0]

    def ap(w, st, b, d):
        n = b['n']
        lg = d.f['lg']
        p = ('c', w.V(st, n) - {b['m']}, w.Lr(st, n) - {b['m']})
        d.f['lg'] = tset(lg, n, lg[n] + ((st[G.TM][n], p),))
        d.f['chg'] = d.f['chg'] + 1
    u.fn = ap


def M11(w, acts):   # standby adds learners at two voters too
    guard(acts, 'standby', 'one').fn = lambda w, st, b: len(w.V(st, b['n'])) <= 2


def M12(w, acts):   # write.stay looks only at the last entry
    def f(w, st, b):
        lg = st[LG][b['n']]
        return not (lg and lg[-1][1][0] == 'c' and b['n'] not in lg[-1][1][1])
    guard(acts, 'write', 'stay').fn = f


def M13(w, acts):   # hand-over to any member, a learner too
    guard(acts, 'handover', 'voter').fn = lambda w, st, b: True
    guard(acts, 'handover', 'tvoter').fn = lambda w, st, b: True


def M14(w, acts):   # exit's "unnamed" reads only the committed config
    def f(w, st, b):
        g = w.gcfg(st)
        return not (g and (b['m'] in g[0] or b['m'] in g[1]))
    guard(acts, 'exit', 'unnamed').fn = f


def M15(w, acts):   # step back with three live machines that say nothing
    drop_guard(acts, 'stepback', 'few')


def M16(w, acts):   # the "retiring" mark survives a restart (see world())
    pass


def M17(w, acts):   # the only voter promotes a learner that is down or behind
    drop_guard(acts, 'opromote', 'live')
    guard(acts, 'opromote', 'caught').fn = lambda w, st, b: True


def M18(w, acts):   # growth's placement may name a retiring machine
    guard(acts, 'grow', 'cand').fn = lambda w, st, b: all(w.live(st, m) for m in (b['n'], b['x'], b['y']))


def M19(w, acts):   # lrem.keep accepts a leaving voter as the one that stays
    guard(acts, 'lrem', 'keep').fn = lambda w, st, b: any(w.live(st, v) for v in w.V(st, b['n']) - {b['m']})


def M20(w, acts):   # lrem without the option's guard
    a = act(acts, 'lrem')
    a.guards = [g for g in a.guards if g.name not in ('two', 'leave')]


def M21(w, acts):   # the bounded exit fires at leave.ms whatever
    drop_guard(acts, 'exitalone', 'alone')


def M22(w, acts):   # the bounded exit looks only at the live majority, not at who could stand in
    def f(w, st, b):
        g = w.gcfg(st)
        return bool(g) and not maj(sum(1 for v in g[0] if st[ST][v] == UP), len(g[0]))
    guard(acts, 'exitalone', 'alone').fn = f


def M23(w, acts):   # the bounded exit looks only at who could stand in, not at the live majority
    guard(acts, 'exitalone', 'alone').fn = lambda w, st, b: not w.carriers(st, b['m'])


def M24(w, acts):   # the bounded exit leaves for good (the machine never comes back)
    def u(w, st, b, d):
        m = b['m']
        d.f['st'] = tset(d.f['st'], m, EXIT)
        d.f['rl'] = tset(d.f['rl'], m, G.FOL)
        d.f['vg'] = tset(d.f['vg'], m, E)
    act(acts, 'exitalone').updates[0].fn = u


def M25(w, acts):   # the held check counts the leaver's own disk
    for an in ('exit', 'exitms'):
        def f(w, st, b):
            g = w.gcfg(st)
            if not g:
                return True
            return maj(sum(1 for v in g[0] if st[ST][v] == UP and G.is_prefix(st[CM], st[LG][v])), len(g[0]))
        guard(acts, an, 'held').fn = f


def M26(w, acts):   # a machine says it is leaving from the start of its leave, but healing still adds it
    guard(acts, 'standby', 'notret').fn = lambda w, st, b: st[RT][b['m']] != G.RETIRE
    guard(acts, 'add', 'notret').fn = lambda w, st, b: st[RT][b['m']] != G.RETIRE


MUTS = {f'm{i}': globals()[f'M{i}'] for i in range(1, 27)}
NOTES = {'m11': 'harmless: learners added at two voters are never placed, never promoted',
         'm12': 'equivalent: a removal is always the last entry while it is uncommitted (one change at a time)',
         'm14': 'equivalent while P7 holds: a pending config never names a leaver that the committed one does not'}


def mutant_class(option, mut):
    base = G.OPTIONS[option]

    class M(base):
        def actions(self):
            acts = super().actions()
            MUTS[mut](self, acts)
            return acts

        def world(self, st):
            out = super().world(st)
            if mut != 'm16':
                return out
            res = []
            for lab, kind, t in out:
                if lab[0] == 'recover':
                    t = tset(t, RT, st[RT])
                res.append((lab, kind, t))
            return res
    return M


def run(task):
    option, mut, limit = task
    try:
        resource.setrlimit(resource.RLIMIT_AS, (CAP, CAP))
    except (ValueError, OSError):
        pass
    cls = mutant_class(option, mut)
    for b in G.ALL:
        try:
            r = engine.explore(cls(G.BOUNDS[b]), None, stop_first=True, limit=limit)
        except MemoryError:
            return f'{option} {mut}: undecided ({b}: memory cap)'
        if r.fail:
            p, (d, _) = min(r.fail.items(), key=lambda x: x[1][0])
            return f'{option} {mut}: caught, {p} on {b} ({d} steps)'
        if not r.complete:
            return f'{option} {mut}: undecided ({b}: state limit)'
    note = NOTES.get(mut)
    return f'{option} {mut}: SURVIVED every bound' + (f' ({note})' if note else '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tasks', nargs='*')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--limit', type=int, default=2_000_000)
    a = ap.parse_args()
    tasks = [tuple(t.split(':')) + (a.limit,) for t in a.tasks] or [
        (o, m, a.limit) for m in MUTS for o in ('absent', 'shrink')]
    with mp.Pool(a.jobs) as pool:
        for line in pool.imap(run, tasks):
            print(line, flush=True)


if __name__ == '__main__':
    main()
