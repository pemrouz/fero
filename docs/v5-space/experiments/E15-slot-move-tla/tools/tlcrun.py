#!/usr/bin/env python3
"""
tlcrun.py: run SlotMove.tla under TLC for one (variant, bound) pair, the same
pairs slot_move.py runs, and print one JSON line with the verdict.

    python3 tools/tlcrun.py fixed move            # one run
    python3 tools/tlcrun.py --plan                # list the 76 runs of slot_move.py's plan()
    python3 tools/tlcrun.py --plan --do 1/4       # run a quarter of the plan
    python3 tools/tlcrun.py fixed move --workers 1

Each run writes an MC module and a cfg into $SP/e15/runs/<variant>-<bound>/,
runs TLC (soft property checks: every failing property is printed with its
step count and the search goes on; the liveness graph is printed as edges),
then checks AG EF Done on that graph with agef.py. The variant names, their
fixes and the bounds are read from docs/v5-spec/slot_move.py so both checkers
run exactly the same configurations; nothing else is taken from it.

Output: results/tlc/<variant>-<bound>.json and .log (trimmed).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'docs', 'v5-spec'))
import slot_move as sm  # noqa: E402  (only VARIANTS, BOUNDS and plan())

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
JAR = os.environ.get('TLA_JAR', os.path.join(SP, 'dl', 'tla', 'tla2tools.jar'))
HEAVY = os.environ.get('HEAVY', os.path.join(SP, 'bin', 'heavy'))
WORK = os.path.join(SP, 'e15', 'runs')
OUT = os.path.join(ROOT, 'results', 'tlc')
sys.path.insert(0, HERE)
import agef  # noqa: E402


def tla_seq(xs):
    return '<<' + ', '.join(f'"{x}"' for x in xs) + '>>'


def constants(variant, bound, calm=True, soft=True):
    kw = dict(shards=2, writes=(sm.S, sm.T), window=1, resends=1, deposes=1, moves=1,
              recovery=True)
    kw.update(sm.BOUNDS[bound][1])
    fixes = sm.VARIANTS[variant][2]
    return {
        'K': str(kw['shards']),
        'WSlots': tla_seq(kw['writes']),
        'W': str(kw['window'] or 0),
        'R': str(kw['resends']),
        'D': str(kw['deposes']),
        'M': str(kw['moves']),
        'Rec': 'TRUE' if kw['recovery'] else 'FALSE',
        'V': f'"{variant}"',
        'Fix': '{' + ', '.join(f'"{f}"' for f in fixes) + '}',
        'WithCalm': 'TRUE' if calm else 'FALSE',
        'Soft': 'TRUE' if soft else 'FALSE',
        'UseCache': 'TRUE' if os.environ.get('E15_CACHE', '1') == '1' else 'FALSE',
    }


def spec_hash():
    import hashlib
    return hashlib.sha256(open(os.path.join(ROOT, 'tla', 'SlotMove.tla'), 'rb').read()).hexdigest()


def write_model(d, consts, invariants, extra_defs='', module='MC', extends='SlotMove', copy_spec=True):
    os.makedirs(d, exist_ok=True)
    # a snapshot of the spec, so a run waiting for the lock uses the spec as
    # it was when the run was set up
    import shutil
    if copy_spec:
        shutil.copy(os.path.join(ROOT, 'tla', 'SlotMove.tla'), os.path.join(d, 'SlotMove.tla'))
    lines = [f'---- MODULE {module} ----', f'EXTENDS {extends}']
    for k, v in consts.items():
        lines.append(f'c_{k} == {v}')
    if extra_defs:
        lines.append(extra_defs)
    lines.append('====')
    with open(os.path.join(d, f'{module}.tla'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    cfg = ['CONSTANTS'] + [f'  {k} <- c_{k}' for k in consts]
    cfg += ['INIT Init', 'NEXT Next']
    cfg += [f'INVARIANT {i}' for i in invariants]
    cfg += ['CHECK_DEADLOCK FALSE']
    with open(os.path.join(d, f'{module}.cfg'), 'w') as f:
        f.write('\n'.join(cfg) + '\n')


def tlc(d, module='MC', workers=2, heavy=True, timeout=None, extra=()):
    tla_dir = os.path.join(ROOT, 'tla')
    env = dict(os.environ)
    cmd = ['java', '-XX:+UseParallelGC', '-Xmx3g', f'-DTLA-Library={tla_dir}',
           '-cp', JAR, 'tlc2.TLC', '-workers', str(workers), '-nowarning', '-fp', '7',
           '-metadir', os.path.join(d, 'states'), '-cleanup', *extra, f'{module}.tla']
    if heavy:
        cmd = [HEAVY] + cmd
    t0 = time.time()
    p = subprocess.run(cmd, cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, timeout=timeout, env=env)
    return p.stdout, time.time() - t0


FAIL = re.compile(r'^<<"FAIL", (\d+), (\d+)>>$')
NODE = re.compile(r'^<<"N", <<(-?\d+), (-?\d+)>>, (TRUE|FALSE)>>$')
EDGE = re.compile(r'^<<"E", <<(-?\d+), (-?\d+)>>, <<(-?\d+), (-?\d+)>>>>$')
DIST = re.compile(r'([\d,]+) states generated, ([\d,]+) distinct states found')


def parse(out):
    fails, nodes, edges = {}, {}, []
    distinct = None
    errors = []
    keep = []
    for line in out.splitlines():
        m = FAIL.match(line)
        if m:
            p, k = int(m.group(1)), int(m.group(2))
            fails[p] = min(k, fails.get(p, k))
            continue
        m = NODE.match(line)
        if m:
            nodes[(int(m.group(1)), int(m.group(2)))] = m.group(3) == 'TRUE'
            continue
        m = EDGE.match(line)
        if m:
            edges.append(((int(m.group(1)), int(m.group(2))), (int(m.group(3)), int(m.group(4)))))
            continue
        m = DIST.search(line)
        if m:
            distinct = int(m.group(2).replace(',', ''))
        if ('Error' in line or 'Exception' in line) and 'No error has been found' not in line:
            errors.append(line)
        keep.append(line)
    return fails, nodes, edges, distinct, errors, keep


def run(variant, bound, workers=2, heavy=True, timeout=None, calm=True):
    name = f'{variant}-{bound}'
    d = os.path.join(WORK, name)
    h = spec_hash()
    write_model(d, constants(variant, bound, calm=calm), ['SoftInv', 'CalmNode'])
    out, secs = tlc(d, workers=workers, heavy=heavy, timeout=timeout)
    fails, nodes, edges, distinct, errors, keep = parse(out)
    live = agef.check(nodes, edges) if calm else None
    res = {
        'variant': variant, 'bound': bound, 'kind': sm.VARIANTS[variant][0],
        'workers': workers, 'secs': round(secs, 1),
        'distinct_total': distinct,
        'calm_states': len(nodes),
        'states': (distinct - len(nodes)) if distinct is not None else None,
        'failed': sorted(fails),
        'steps': {str(p): k for p, k in sorted(fails.items())},
        'live_stuck': live['stuck'] if live else None,
        'live_edges': len(edges),
        'errors': errors[:5],
        'complete': distinct is not None and not errors,
        'spec_sha256': h,
    }
    if live and live['stuck']:
        res['failed'] = sorted(set(res['failed']) | {7})
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name + '.json'), 'w') as f:
        json.dump(res, f, indent=1, sort_keys=True)
    with open(os.path.join(OUT, name + '.log'), 'w') as f:
        f.write('\n'.join(keep[-60:]) + '\n')
    if live and live['stuck']:
        with open(os.path.join(d, 'stuck.json'), 'w') as f:
            json.dump(live['stuck_nodes'], f)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('variant', nargs='?')
    ap.add_argument('bound', nargs='?')
    ap.add_argument('--plan', action='store_true')
    ap.add_argument('--do', default=None, help='k/n: run the k-th of n slices of the plan')
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--no-heavy', action='store_true')
    ap.add_argument('--skip-done', action='store_true')
    ap.add_argument('--only-bound', default=None)
    a = ap.parse_args()
    if a.plan:
        jobs = sm.plan()
        if a.only_bound:
            jobs = [j for j in jobs if j[1] in a.only_bound.split(',')]
        if a.do:
            k, n = map(int, a.do.split('/'))
            jobs = jobs[k - 1::n]
        if not a.do and not a.skip_done and a.variant is None and len(sys.argv) == 2:
            for v, b in jobs:
                print(v, b)
            return
    else:
        jobs = [(a.variant, a.bound)]
    for v, b in jobs:
        if a.skip_done and os.path.exists(os.path.join(OUT, f'{v}-{b}.json')):
            continue
        r = run(v, b, workers=a.workers, heavy=not a.no_heavy)
        print(json.dumps(r, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
