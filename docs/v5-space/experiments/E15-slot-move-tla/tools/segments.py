#!/usr/bin/env python3
"""
segments.py: a TLC run too long for one hold of the heavy lock (about 25
minutes), run in segments. TLC checkpoints every few minutes; a segment
stops TLC right after the first checkpoint past --seconds, and the next
segment (a new hold) resumes from it with -recover. The outputs of all
segments are merged (failures, calm states and calm steps; the distinct
count from the last segment, which TLC carries across the checkpoint).

    python3 tools/segments.py no-exporting moves          # one segment
    python3 tools/segments.py no-exporting moves --loop   # until done
    python3 tools/segments.py no-exporting three --cap 7000000

Without --loop it runs ONE segment and must itself be run under the heavy
lock; with --loop it takes the lock for each segment.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import tlcrun  # noqa: E402
import agef  # noqa: E402

HEAP = os.environ.get('E15_HEAP', '7g')  # TLCCache grows with the states: about 0.4 KB a state


def segment(variant, bound, seconds, workers, cap):
    name = f'{variant}-{bound}'
    d = os.path.join(tlcrun.WORK, name + '-seg')
    state = os.path.join(d, 'segments.json')
    os.makedirs(d, exist_ok=True)
    st = json.load(open(state)) if os.path.exists(state) else {'segments': 0, 'done': False}
    if st['done']:
        return st
    if st['segments'] == 0:
        extra = ''
        cons = []
        if cap:
            # a cap like slot_move.py's --cap: once some property has failed
            # (as this worker saw), states past `cap` are not expanded
            extra = (f'CapOK == TLCGet("distinct") < {int(cap)} \\/ '
                     '\\A p \\in {1, 2, 3, 4, 5, 6, 8, 9} : TLCGetOrDefault(p, 1000000) = 1000000')
            cons = ['CapOK']
        st['spec_sha256'] = tlcrun.spec_hash()
        tlcrun.write_model(d, tlcrun.constants(variant, bound), ['SoftInv', 'CalmNode'], extra_defs=extra)
        if cons:
            with open(os.path.join(d, 'MC.cfg'), 'a') as f:
                f.write('CONSTRAINT CapOK\n')
    k = st['segments'] + 1
    cmd = ['java', '-XX:+UseParallelGC', f'-Xmx{HEAP}', '-cp', tlcrun.JAR, 'tlc2.TLC',
           '-workers', str(workers), '-nowarning', '-fp', '7', '-checkpoint', '3', '-metadir', 'st']
    if k > 1:
        last = sorted(glob.glob(os.path.join(d, 'st', '*', 'vars.chkpt')))
        rec = os.path.dirname(max(last, key=os.path.getmtime))
        cmd += ['-recover', os.path.relpath(rec, d)]
    cmd += ['MC.tla']
    t0 = time.time()
    out = open(os.path.join(d, f'seg{k}.out'), 'w')
    p = subprocess.Popen(cmd, cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    stopped = False
    for line in p.stdout:
        out.write(line)
        if line.startswith('Checkpointing completed') and time.time() - t0 > seconds:
            p.terminate()
            stopped = True
            break
    out.close()
    p.wait()
    text = open(os.path.join(d, f'seg{k}.out')).read()
    st['segments'] = k
    st.setdefault('secs', []).append(round(time.time() - t0, 1))
    st['done'] = (not stopped) and 'distinct states found' in text
    json.dump(st, open(state, 'w'))
    if st['done']:
        merge(variant, bound, d, st, workers, cap)
    return st


def merge(variant, bound, d, st, workers, cap):
    fails, nodes, edges, distinct, errors = {}, {}, [], None, []
    # every segment's output, including one cut short by hand (seg<k>b.out):
    # its prints after its last checkpoint are repeated later, the ones
    # before are not, so all are kept; the distinct count is the last one's
    outs = sorted(glob.glob(os.path.join(d, 'seg*.out')), key=os.path.getmtime)
    for fn in outs:
        f, n, e, dist, err, _ = tlcrun.parse(open(fn).read())
        for p, s in f.items():
            fails[p] = min(s, fails.get(p, s))
        nodes.update(n)
        edges.extend(e)
        distinct = dist if dist is not None else distinct
        errors += err
    live = agef.check(nodes, edges)
    res = {'variant': variant, 'bound': bound, 'kind': tlcrun.sm.VARIANTS[variant][0],
           'workers': workers, 'secs': sum(st['secs']), 'segments': st['segments'],
           'distinct_total': distinct, 'calm_states': len(nodes),
           'states': distinct - len(nodes) if distinct is not None else None,
           'failed': sorted(set(fails) | ({7} if live['stuck'] else set())),
           'steps': {str(p): s for p, s in sorted(fails.items())},
           'live_stuck': live['stuck'], 'live_edges': len(edges), 'errors': errors[:5],
           'complete': distinct is not None and not errors,
           'cap': cap, 'spec_sha256': st.get('spec_sha256')}
    os.makedirs(tlcrun.OUT, exist_ok=True)
    with open(os.path.join(tlcrun.OUT, f'{variant}-{bound}.json'), 'w') as f:
        json.dump(res, f, indent=1, sort_keys=True)
    with open(os.path.join(tlcrun.OUT, f'{variant}-{bound}.log'), 'w') as f:
        for fn in sorted(glob.glob(os.path.join(d, 'seg*.out')), key=os.path.getmtime):
            lines = [l for l in open(fn) if not l.startswith('<<')]
            f.write(f'--- {os.path.basename(fn)}\n' + ''.join(lines[-25:]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('variant')
    ap.add_argument('bound')
    ap.add_argument('--seconds', type=float, default=1320)
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--cap', type=float, default=0)
    ap.add_argument('--loop', action='store_true')
    a = ap.parse_args()
    if a.loop:
        while True:
            subprocess.run([tlcrun.HEAVY, sys.executable, os.path.abspath(__file__), a.variant, a.bound,
                            '--seconds', str(a.seconds), '--workers', str(a.workers),
                            '--cap', str(a.cap)])
            st = json.load(open(os.path.join(tlcrun.WORK, f'{a.variant}-{a.bound}-seg', 'segments.json')))
            print(json.dumps(st), flush=True)
            if st['done']:
                return
    else:
        print(json.dumps(segment(a.variant, a.bound, a.seconds, a.workers, a.cap or None)))


if __name__ == '__main__':
    main()
