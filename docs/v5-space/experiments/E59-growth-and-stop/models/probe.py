#!/usr/bin/env python3
"""
probe.py: shortest traces to named moments of the design, and the end states
of a clean stop, for the README's scenarios. Breadth first, so every trace is
a shortest one.

    python3 models/probe.py traces            the named traces below
    python3 models/probe.py outcomes          where a clean stop with no spare ends, per option
    python3 models/probe.py pending           a retire with no spare stays pending (r1), and completes (r1s)
"""
import os
import sys
from collections import deque

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402
import importlib.util  # noqa: E402
import resource  # noqa: E402

CAP = int(os.environ.get('MEMCAP_MB', '4000')) * 1024 * 1024
try:
    resource.setrlimit(resource.RLIMIT_AS, (CAP, CAP))
except (ValueError, OSError):
    pass
spec = importlib.util.spec_from_file_location('grow', os.path.join(HERE, 'grow.py'))
G = importlib.util.module_from_spec(spec)
sys.modules['grow'] = G
spec.loader.exec_module(G)


def bfs(model, comp, edge_pred=None, state_pred=None, limit=3_000_000):
    init = model.init()
    parent = {init: None}
    q = deque([init])
    while q:
        s = q.popleft()
        if state_pred and state_pred(model, s):
            return trace(parent, s)
        for lab, kind, t in comp.succ(s):
            if edge_pred and edge_pred(model, s, lab, kind, t):
                return trace(parent, s) + [lab]
            if t not in parent:
                parent[t] = (s, lab)
                q.append(t)
                if len(parent) > limit:
                    return None
    return None


def trace(parent, s):
    out = []
    while parent[s] is not None:
        s, lab = parent[s]
        out.append(lab)
    return list(reversed(out))


def show(title, tr):
    print(f'\n{title}' + ('' if tr else ': not reached'))
    if tr:
        engine.show_trace(tr)
    sys.stdout.flush()


def stepped_back(s):
    """The committed history holds a two-voter config followed by a one-voter config."""
    sizes = [len(e[1][1]) for e in s[G.CM] if e[1][0] in ('c', 'f')]
    return any(a == 2 and b == 1 for a, b in zip(sizes, sizes[1:]))


def cfgV(model, s):
    g = model.gcfg(s)
    return g[0] if g else frozenset()


TRACES = [
    ('shrink', 'g0', 'growth: placement of three, learners, two promotions back to back',
     None, lambda m, s: len(cfgV(m, s)) == 3 and m.settled(s)),
    ('shrink', 'g1', 'a crash between the two promotions, then the step back to one voter',
     lambda m, s, lab, k, t: lab[0] == 'stepback' and s[G.NF] == 1, None),
    ('shrink', 'g1', 'the second learner crashes between the promotions; the step back commits',
     None, lambda m, s: s[G.NF] == 1 and stepped_back(s)),
    ('shrink', 'g1', 'a gone learner dropped',
     lambda m, s, lab, k, t: lab[0] == 'dropl', None),
    ('shrink', 'g1', "E-14b's two-voter window: the second promotion commits, the leader crashes "
     'before the other voter applies it',
     None, lambda m, s: m.judged(s)['WIN'] and s[G.NF] == 1 and not any(
         x[0] == 'n' and False for x in ()) and len(cfgV(m, s)) == 3 and s[G.ST][0] == G.DOWN
     and m.cfg(s, 1) is not None and len(m.cfg(s, 1)[0]) == 2),
    ('absent', 's1', 'absent: a voter leaves with no spare, exits at leave.ms and stays in the config',
     lambda m, s, lab, k, t: lab[0] == 'exitms' and dict(lab[1])['m'] in cfgV(m, s), None),
    ('shrink', 's1', 'shrink: a voter leaves with no spare, is removed (two voters), the group steps back to one',
     None, lambda m, s: len(cfgV(m, s)) == 1 and not any(m.up_leaver(s, x) for x in range(m.N))
     and m.settled(s)),
    ('absent', 's2', 'absent, two leaves with no spare: the absent voter is removed as dead when the second '
     'leave needs it (V4-60), and the last machine carries on',
     None, lambda m, s: len(cfgV(m, s)) == 1 and not any(m.up_leaver(s, x) for x in range(m.N))
     and m.settled(s) and m.writable(s)),
    ('shrink', 'o1', 'the leave of an only voter: promote the learner, hand over, be removed, exit',
     lambda m, s, lab, k, t: lab[0] == 'exit' and dict(lab[1])['m'] == 0, None),
    ('shrink', 's1f', "shrink's two-voter window: a crash of a voter that stays, once the leaver's removal "
     'has committed; the leaver is still up, and no working leader can be had until the crashed one returns '
     '(SWF stuck)',
     None, lambda m, s: s[G.NF] == 1 and len(m.gcfg(s)[0]) == 2 and any(s[G.ST][v] == G.DOWN
                                                                       for v in m.gcfg(s)[0])
     and any(m.up_leaver(s, x) for x in range(m.N))),
    ('absent', 'solo', 'a one-machine server, Ctrl-C: it stops at leave.ms (the bounded exit)',
     lambda m, s, lab, k, t: lab[0] == 'exitalone', None),
    ('absent', 'o1d', 'the only voter leaves while its learner is down: it stops at leave.ms, and the group '
     'waits for a restart',
     lambda m, s, lab, k, t: lab[0] == 'exitalone', None),
]


def traces():
    for opt, b, title, ep, sp in TRACES:
        model = G.OPTIONS[opt](G.BOUNDS[b])
        comp = engine.Compiled(model, engine.Mutation())
        show(f'{opt} {b}: {title}', bfs(model, comp, ep, sp))


def explore_all(model, comp, limit=3_000_000):
    init = model.init()
    seen = {init}
    q = deque([init])
    while q:
        s = q.popleft()
        yield s
        for lab, kind, t in comp.succ(s):
            if t not in seen:
                seen.add(t)
                q.append(t)
                if len(seen) > limit:
                    return


def outcomes():
    """Where a clean stop with no spare ends: states with no crashed machine,
    every leave over, nothing in flight, healed. For each: the voters, how many
    of them are up, and how many machines' crash would leave no live majority."""
    for b in ('s1', 's2', 'gl', 'o1'):
        for opt in ('absent', 'shrink'):
            model = G.OPTIONS[opt](G.BOUNDS[b])
            comp = engine.Compiled(model, engine.Mutation())
            ends = {}
            for s in explore_all(model, comp):
                if any(x == G.DOWN for x in s[G.ST]) or any(model.up_leaver(s, x) for x in range(model.N)):
                    continue
                if s[G.NL] == 0 or not model.healed(s) or model.pending(s) or not model.settled(s):
                    continue
                V = cfgV(model, s)
                up = [v for v in V if s[G.ST][v] == G.UP]
                L = model.gcfg(s)[1]
                live = [x for x in range(model.N) if s[G.ST][x] == G.UP]
                # a crash of one live machine: does a live majority of V remain?
                kill = sum(1 for x in live if not G.maj(sum(1 for v in up if v != x), len(V)))
                key = (len(V), len(up), len([x for x in L if s[G.ST][x] == G.UP]), len(live), kill,
                       len(V) // 2 + 1)
                ends[key] = ends.get(key, 0) + 1
            print(f'{opt} {b}: end states of the stop (voters, voters up, learners up, machines up, '
                  f'machines whose crash stops writes, disks each commit waits for): ' +
                  '; '.join(f'{k}: {n}' for k, n in sorted(ends.items())))
            sys.stdout.flush()


def pending():
    for opt in ('absent', 'shrink'):
        model = G.OPTIONS[opt](G.BOUNDS['r1'])
        comp = engine.Compiled(model, engine.Mutation())
        n = out = 0
        for s in explore_all(model, comp):
            n += 1
            for m in range(model.N):
                if s[G.RT][m] == G.RETIRE and m not in cfgV(model, s):
                    out += 1
        print(f'{opt} r1 (three voters, no spare, a retire hint): {n:,} states; states where the '
              f'retire-hinted machine has left the voters: {out}')
        model = G.OPTIONS[opt](G.BOUNDS['r1s'])
        comp = engine.Compiled(model, engine.Mutation())
        show(f'{opt} r1s: with a spare, the retire completes',
             bfs(model, comp, None, lambda m, s: any(s[G.RT][x] == G.RETIRE and x not in cfgV(m, s)
                                                     for x in range(m.N)) and m.settled(s)))


if __name__ == '__main__':
    {'traces': traces, 'outcomes': outcomes, 'pending': pending}[sys.argv[1]]()
