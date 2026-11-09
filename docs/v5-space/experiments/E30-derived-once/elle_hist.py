#!/usr/bin/env python3
"""
elle_hist.py: E-30's outputs as Elle list-append histories (TEST-13).

    python3 elle_hist.py OUTDIR [--walks 200] [--seed 1]

For each option and each of the bounds `short` and `long`, it takes seeded
random walks through derived.py's own transition system (the same steps
the exhaustive run explores; faults and time as the bound allows; after
about 40 steps only calm steps, so most walks finish). Each walk becomes one
EDN history:
  - every output of f is one operation [:append k v], k the B group's row
    ("b0" or "b1"), v the output's number (unique per key). It is invoked
    when the consumer first sends it; it completes :ok when the consumer
    that sent it learns it is applied, or :info if that consumer crashes
    first (a later consumer's resend of the same output is the same
    operation, so it adds no second invoke);
  - at the end one read of every row, [:r "b0" [...]] [:r "b1" [...]], from
    the B groups' committed logs, in log order.
An output applied twice shows as a repeated element in that read, which
Elle reports as :duplicate-elements. The walk's own ONCE and LOST checks
are written beside each file (index.jsonl), so the checker's verdict can be
compared with the model's.
"""
import argparse
import importlib.util
import json
import os
import random
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

_spec = importlib.util.spec_from_file_location('e30derived', os.path.join(HERE, 'models', 'derived.py'))
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)


def walk(model, rng, steps=40, tail=120):
    c = engine.Compiled(model)
    st = model.init()
    trace = [(None, st)]
    for i in range(steps + tail):
        succ = c.succ(st)
        if i >= steps:
            succ = [x for x in succ if x[1] in model.CALM]
        if not succ:
            break
        lab, kind, st = rng.choice(succ)
        trace.append((lab, st))
        if model.goals(st)['DONE'] and i >= steps:
            break
    return trace


def history(model, trace):
    """EDN ops from a walk: one :append per output, one final read."""
    IX = D.IX
    ops = []
    opened = {}           # output -> process that invoked it
    closed = set()
    for (lab, s0), (lab1, s1) in zip(trace, trace[1:]):
        cs0, cs1 = s0[IX['cs']], s1[IX['cs']]
        life0 = cs0[0]
        for o in range(len(model.outs)):
            v = o + 1
            key = D.GN[model.outs[o][2]]
            if o not in opened and cs1[2][o] == D.SENT and cs0[2][o] != D.SENT and not s1[IX['down']]:
                opened[o] = cs1[0]
                ops.append({'type': 'invoke', 'f': 'txn', 'value': [['append', key, v]], 'process': cs1[0]})
            if o in opened and o not in closed:
                p = opened[o]
                if cs1[2][o] == D.DONE and cs0[2][o] != D.DONE and cs1[0] == p and not s1[IX['down']]:
                    ops.append({'type': 'ok', 'f': 'txn', 'value': [['append', key, v]], 'process': p})
                    closed.add(o)
                elif s1[IX['down']] and not s0[IX['down']] and life0 == p:
                    ops.append({'type': 'info', 'f': 'txn', 'value': [['append', key, v]], 'process': p})
                    closed.add(o)
    for o in opened:
        if o not in closed:
            key = D.GN[model.outs[o][2]]
            ops.append({'type': 'info', 'f': 'txn', 'value': [['append', key, o + 1]], 'process': opened[o]})
    last = trace[-1][1]
    reads = []
    for g in D.BGROUPS:
        vals = [model.outs.index(e[2]) + 1 for e in model.com(last, g) if e[0] == 'w']
        reads.append(['r', D.GN[g], vals])
    ops.append({'type': 'invoke', 'f': 'txn', 'value': [['r', k, None] for _, k, _ in reads], 'process': 99})
    ops.append({'type': 'ok', 'f': 'txn', 'value': reads, 'process': 99})
    return ops


def edn(op):
    def val(x):
        if x is None:
            return 'nil'
        if isinstance(x, str):
            return ':' + x if x in ('append', 'r') else json.dumps(x)
        if isinstance(x, list):
            return '[' + ' '.join(val(y) for y in x) + ']'
        return str(x)
    return '{:type :%s, :f :%s, :value %s, :process %d}' % (op['type'], op['f'], val(op['value']), op['process'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--walks', type=int, default=200)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--options', default='win,sess,pid,keys,srcpos,srchi,srchi-slot')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    idx = open(os.path.join(a.out, 'index.jsonl'), 'w')
    for opt in a.options.split(','):
        for bname in ('short', 'long'):
            model = D.OPTIONS[opt](D.BOUNDS[bname])
            rng = random.Random(f'{a.seed}/{opt}/{bname}')
            for w in range(a.walks):
                tr = walk(model, rng)
                last = tr[-1][1]
                bad = model.check(last)
                ops = history(model, tr)
                fn = f'{opt}-{bname}-{w:03d}.edn'
                with open(os.path.join(a.out, fn), 'w') as f:
                    for op in ops:
                        f.write(edn(op) + '\n')
                idx.write(json.dumps({'file': fn, 'option': opt, 'bound': bname, 'model': bad,
                                      'done': model.goals(last)['DONE'], 'steps': len(tr) - 1}) + '\n')
    idx.close()


if __name__ == '__main__':
    main()
