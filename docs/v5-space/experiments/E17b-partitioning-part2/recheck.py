#!/usr/bin/env python3
"""recheck.py (2026-11-08): a fresh, cache-free check of part 2's reported results against the current
model files: for each result, the model as written (base) and the smallest
model (removed set) run on every sweep bound (and twice1 for the smallest);
states and state-set digests must equal the stored ones.
It does not re-derive the sets (part 3, ../E17c-partitioning-rerun, does) and
does not re-check 1-minimality or the mutants: it shows that the model files
as they stand now give exactly the state graphs the results were made from,
so no cached run from an older model text can have slipped into them.

    python3 recheck.py split split-rev split+giveup pslot-fused pslot-fused-rev pslot-fused+abort
    python3 recheck.py pslot pslot-rev pslot+abort lanes lanes-rev lanes+abort lanes-carry
"""
import json, os, sys
if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)
H = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'E17-partitioning')
sys.path.insert(0, os.path.join(H, 'harness'))
sys.dont_write_bytecode = True
import runner
from dsl import Mutation
from bounds import SWEEP, VERIFY
from concurrent.futures import ProcessPoolExecutor

def opt(name):
    b = name.split('+')[0]
    return b[:-4] if b.endswith('-rev') else b

def job(a):
    name, drop, bound = a
    r = runner.run(name, bound, Mutation(drop=drop), stop_first=False)
    return (r.states, list(r.digest), sorted(r.fail), r.complete)

names = sys.argv[1:]
tasks = []
for n in names:
    o = json.load(open(f'{H}/results/{n}-ablation.json'))
    on = opt(n)
    for b in SWEEP:
        tasks.append((n, 'base', on, [], b, o['base'][b]))
        tasks.append((n, 'min', on, o['removed'], b, o['minimal'][b]))
    for b in VERIFY:
        tasks.append((n, 'min', on, o['removed'], b, o['verify'].get(b)))
keys = []
for t in tasks:
    k = (t[2], tuple(sorted(t[3])), t[4])
    if k not in keys:
        keys.append(k)
with ProcessPoolExecutor(2) as ex:
    got = dict(zip(keys, ex.map(job, [(k[0], list(k[1]), k[2]) for k in keys])))
res = [got[(t[2], tuple(sorted(t[3])), t[4])] for t in tasks]
bad = 0
for t, (st, dg, fail, comp) in zip(tasks, res):
    n, kind, on, rem, b, ref = t
    same = ref is not None and ref['states'] == st and ref['digest'] == dg
    if not same or fail or not comp:
        bad += 1
    print(f'{n:20} {kind:4} {b:7} states {st:>8} fail {fail or "-"} {"same" if same else "DIFF " + str(ref and ref["states"])}')
print('ALL SAME' if not bad else f'{bad} DIFFERENT')
