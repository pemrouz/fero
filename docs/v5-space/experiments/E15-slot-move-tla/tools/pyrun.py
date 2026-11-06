#!/usr/bin/env python3
"""
pyrun.py: run slot_move.py's own search for one (variant, bound) pair, in
full (no cap), save its verdict as JSON, and turn every counterexample it
finds into a TLA+ replay module (results/replays/<run>-p<prop>/).

    python3 tools/pyrun.py fixed move
    python3 tools/pyrun.py --plan --do 1/4

slot_move.py is imported unchanged; this file only calls its Model, explore,
liveness, trace and depth, and converts its states to TLA+ values in the
encoding SlotMove.tla uses (see the comment at the top of SlotMove.tla).
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'docs', 'v5-spec'))
import slot_move as sm  # noqa: E402

OUT = os.path.join(ROOT, 'results', 'py')
SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
REPLAYS = os.path.join(SP, 'e15', 'replays')  # large; only replays.json and samples are kept in results/

# ---------------------------------------------------------------- to TLA+

NAMED_ENTRY = {'fenced', 'cancel', 'unfenced', 'importing', 'imp', 'open', 'abort'}
NAMED_MSG = {'export', 'sub', 'data', 'ready', 'cancelled', 'aborted'}


def flat(v):
    """A table version: nested tuples of ints, flattened."""
    out = []
    for x in v:
        if isinstance(x, tuple):
            out.extend(flat(x))
        else:
            out.append(x)
    return out


def val(x):
    """A value where None means 'no position / no carried state' (<<>>)."""
    if x is None:
        return '<<>>'
    if isinstance(x, bool):
        return 'TRUE' if x else 'FALSE'
    if isinstance(x, int):
        return str(x)
    if isinstance(x, str):
        return f'"{x}"'
    if isinstance(x, (frozenset, set)):
        return '{' + ', '.join(sorted(val(y) for y in x)) + '}'
    if isinstance(x, tuple):
        return '<<' + ', '.join(val(y) for y in x) + '>>'
    raise TypeError(x)


def name(n):
    return '-1' if n is None else str(n)


def entry(e):
    k = e[0]
    parts = [val(k)]
    for i, x in enumerate(e[1:], 1):
        if i == 1 and k in NAMED_ENTRY:
            parts.append(name(x))
        else:
            parts.append(val(x))
    return '<<' + ', '.join(parts) + '>>'


def seq(es):
    return '<<' + ', '.join(entry(e) for e in es) + '>>'


def msg(m):
    k = m[0]
    parts = [val(k)]
    for i, x in enumerate(m[1:], 1):
        if i == 2 and k in NAMED_MSG:
            parts.append(name(x))
        elif i == 2 and k in ('tw', 'tack'):
            parts.append('<<' + ', '.join(str(y) for y in flat(x)) + '>>')
        else:
            parts.append(val(x))
    return '<<' + ', '.join(parts) + '>>'


def shard(sh):
    com, tail, deps, lost, pend, mem = sh
    return ('[com |-> ' + seq(com) + ', tail |-> ' + seq(tail) +
            f', dep |-> {deps[0]}, inh |-> {deps[1]}, lost |-> ' +
            '{' + ', '.join(sorted(seq(g) for g in lost)) + '}' +
            ', pend |-> ' + val(pend) + ', mem |-> ' + val(mem) + ']')


def state(st, calm=False):
    shards, table, cl, net, meta = st
    sh = ' @@ '.join(f'({x} :> {shard(s)})' for x, s in enumerate(shards))
    tb = f'[h |-> {table[0]}, v |-> <<' + ', '.join(str(y) for y in flat(table[1])) + '>>]'
    if cl is None:
        c = '<<>>'
    else:
        c = '<<' + ', '.join(f'[s |-> {s}, q |-> {val(q)}, cp |-> {cp}]' for s, q, cp in cl) + '>>'
    nt = '{' + ', '.join(sorted(msg(m) for m in net)) + '}'
    return (f'[shards |-> {sh}, table |-> {tb}, cl |-> {c}, net |-> {nt}, '
            f'started |-> {meta[0]}, recovered |-> {val(meta[1])}, maxpos |-> {val(meta[2])}, '
            f'calm |-> {val(calm)}]')


# ---------------------------------------------------------------- replays

def bound_consts(variant, bound):
    import importlib.util
    spec = importlib.util.spec_from_file_location('tlcrun', os.path.join(HERE, 'tlcrun.py'))
    tr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tr)
    return tr, tr.constants(variant, bound, calm=True, soft=True)


REPLAY_DEFS = r'''
VARIABLE i
St == [shards |-> shards, table |-> table, cl |-> cl, net |-> net, started |-> started,
       recovered |-> recovered, maxpos |-> maxpos, calm |-> calm]
StP == [shards |-> shards', table |-> table', cl |-> cl', net |-> net', started |-> started',
        recovered |-> recovered', maxpos |-> maxpos', calm |-> calm']
RInit == Init /\ i = 1 /\ St = Tr[1]
\* follow the trace: each step must be one of SlotMove's own steps
Follow == i < Len(Tr) /\ Next /\ StP = Tr[i + 1] /\ i' = i + 1
'''


def write_replay(variant, bound, prop, states, extra=None, node=None):
    """states: the Python trace, from the initial state on. For property 6 on
    an edge, `extra` is the state after the bad commit. For property 7, `node`
    is the calm (projected) state that is stuck."""
    tr, consts = bound_consts(variant, bound)
    run = f'{variant}-{bound}-p{prop}'
    d = os.path.join(REPLAYS, run)
    os.makedirs(d, exist_ok=True)
    tr_states = list(states) + ([extra] if extra is not None else [])
    body = 'Tr == <<\n  ' + ',\n  '.join(state(s) for s in tr_states) + '\n>>'
    body += REPLAY_DEFS
    if prop == 7:
        body += 'Node == ' + state(node, calm=True) + '\n'
        body += r'''
\* then every message is lost and no more faults happen (Calm), and from the
\* calm state no step sequence reaches Done
RNext == \/ Follow
         \/ i = Len(Tr) /\ Calm /\ StP = Node /\ i' = i + 1
         \/ i = Len(Tr) + 1 /\ calm /\ Step /\ UNCHANGED i
Mark == (i = Len(Tr) + 1 /\ St = Node) => PrintT("REACHED-NODE")
NeverDone == ~(calm /\ Done)
'''
        invs = ['Mark', 'NeverDone']
    else:
        if prop == 6 and extra is not None:
            goal = r'''LET prev == Tr[Len(Tr) - 1]
                  IN \E x \in Sh :
                       /\ Len(shards[x].com) = Len(prev.shards[x].com) + 1
                       /\ Kind(shards[x].com[Len(shards[x].com)]) = "w"
                       /\ ~PLt(prev.maxpos, shards[x].com[Len(shards[x].com)][3])'''
        else:
            goal = '~P%d' % prop
        body += f'''
RNext == Follow
\\* reaching the end of the trace with property {prop} broken is the goal:
\\* TLC reports this invariant violated exactly when the replay succeeds
NotGoal == ~(i = Len(Tr) /\\ {goal})
'''
        invs = ['NotGoal']
    lines = ['---- MODULE RP ----', 'EXTENDS SlotMove']
    for k, v in consts.items():
        lines.append(f'c_{k} == {v}')
    lines.append(body)
    lines.append('====')
    with open(os.path.join(d, 'RP.tla'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    cfg = ['CONSTANTS'] + [f'  {k} <- c_{k}' for k in consts]
    cfg += ['INIT RInit', 'NEXT RNext'] + [f'INVARIANT {x}' for x in invs] + ['CHECK_DEADLOCK FALSE']
    with open(os.path.join(d, 'RP.cfg'), 'w') as f:
        f.write('\n'.join(cfg) + '\n')
    meta = {'variant': variant, 'bound': bound, 'prop': prop,
            'py_steps': len(tr_states) - 1 if prop != 7 else len(states) - 1,
            'edge': extra is not None}
    with open(os.path.join(d, 'meta.json'), 'w') as f:
        json.dump(meta, f)
    return d


# ---------------------------------------------------------------- runs

def run(variant, bound, cap=None, replays=True):
    m = sm.Model(variant, **sm.BOUNDS[bound][1])
    t0 = time.time()
    seen, first, edges, dt = sm.explore(m, limit=cap)
    lv = sm.liveness(m, seen)
    failed = sorted(first)
    steps = {p: (sm.depth(seen, v[2]) if v[3] == 'state' else sm.depth(seen, v[0]) + 1)
             for p, v in first.items()}
    if lv[2]:
        failed = sorted(set(failed) | {7})
        steps[7] = sm.depth(seen, lv[3][0])
    res = {'variant': variant, 'bound': bound, 'kind': sm.VARIANTS[variant][0],
           'states': len(seen), 'transitions': edges, 'live_nodes': lv[0],
           'live_starts': lv[1], 'live_stuck': lv[2], 'failed': failed,
           'steps': {str(p): k for p, k in sorted(steps.items())},
           'capped': cap is not None and bool(first) and len(seen) > cap,
           'secs': round(time.time() - t0, 1)}
    if replays:
        for p, (s, lab, t, how) in first.items():
            if how == 'edge':
                write_replay(variant, bound, p, [sm_init(seen, s)] + [x for _, x in sm.trace(seen, s)],
                             extra=t)
            else:
                write_replay(variant, bound, p, [sm_init(seen, t)] + [x for _, x in sm.trace(seen, t)])
        if lv[2]:
            orig, node = lv[3]
            write_replay(variant, bound, 7, [sm_init(seen, orig)] + [x for _, x in sm.trace(seen, orig)],
                         node=node)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f'{variant}-{bound}.json'), 'w') as f:
        json.dump(res, f, indent=1, sort_keys=True)
    return res


def sm_init(seen, st):
    while seen[st] is not None:
        st = seen[st][0]
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('variant', nargs='?')
    ap.add_argument('bound', nargs='?')
    ap.add_argument('--plan', action='store_true')
    ap.add_argument('--do', default=None)
    ap.add_argument('--cap', type=int, default=0)
    ap.add_argument('--skip-done', action='store_true')
    ap.add_argument('--only-bound', default=None)
    ap.add_argument('--no-replays', action='store_true')
    a = ap.parse_args()
    if a.plan:
        jobs = sm.plan()
        if a.only_bound:
            jobs = [j for j in jobs if j[1] in a.only_bound.split(',')]
        if a.do:
            k, n = map(int, a.do.split('/'))
            jobs = jobs[k - 1::n]
    else:
        jobs = [(a.variant, a.bound)]
    for v, b in jobs:
        if a.skip_done and os.path.exists(os.path.join(OUT, f'{v}-{b}.json')):
            continue
        r = run(v, b, cap=a.cap or None, replays=not a.no_replays)
        print(json.dumps(r, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
