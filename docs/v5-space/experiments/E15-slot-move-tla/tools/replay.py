#!/usr/bin/env python3
"""
replay.py: replay every slot_move.py counterexample (written by pyrun.py into
results/replays/<run>-p<prop>/RP.tla) as a TLA+ behavior of SlotMove.tla.

A replay starts from SlotMove's Init, takes only steps that SlotMove's Next
allows and that land on the next state of the Python trace, and succeeds when
it reaches the trace's last state with the property broken there (TLC then
reports the invariant NotGoal violated, with the TLA+ trace). For property 7
it succeeds when the trace's last state, after the Calm step (every message
lost, no more faults), lands on Python's stuck state, and no TLA+ step
sequence from there reaches Done.

    python3 tools/replay.py              # every replay not yet run
    python3 tools/replay.py --all        # every replay
    python3 tools/replay.py --table      # the summary table
"""
import argparse
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import tlcrun  # noqa: E402

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
REPLAYS = os.path.join(SP, 'e15', 'replays')  # large; only replays.json and samples are kept in results/
OUTF = os.path.join(ROOT, 'results', 'replays.json')


def judge(d, out):
    meta = json.load(open(os.path.join(d, 'meta.json')))
    p = meta['prop']
    res = dict(meta)
    if p == 7:
        reached = 'REACHED-NODE' in out
        done = 'Invariant NeverDone is violated' in out
        complete = 'Model checking completed' in out or 'No error has been found' in out
        m = tlcrun.DIST.search(out)
        res.update(reached=reached, done_reachable=done, complete=complete,
                   calm_states=int(m.group(2).replace(',', '')) if m else None)
        res['ok'] = reached and not done and complete
    else:
        ok = 'Invariant NotGoal is violated' in out
        m = re.search(r'The behavior up to this point is:|Error: Invariant NotGoal', out)
        steps = len(re.findall(r'^State \d+:', out, re.M))
        res.update(ok=ok, tla_states=steps, tla_steps=steps - 1 if steps else None)
        res['ok'] = ok and steps - 1 == meta['py_steps']
    res['errors'] = [l for l in out.splitlines()
                     if ('Error' in l or 'Exception' in l) and 'NotGoal' not in l
                     and 'NeverDone' not in l][:3]
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--table', action='store_true')
    ap.add_argument('--no-heavy', action='store_true')
    ap.add_argument('--budget', type=float, default=0, help='stop after this many seconds')
    a = ap.parse_args()
    import time
    t0 = time.time()
    results = json.load(open(OUTF)) if os.path.exists(OUTF) else {}
    if not a.table:
        for d in sorted(glob.glob(os.path.join(REPLAYS, '*'))):
            key = os.path.basename(d)
            if key in results and not a.all:
                continue
            if a.budget and time.time() - t0 > a.budget:
                break
            rp = os.path.join(d, 'RP.tla')
            t = open(rp).read().replace('c_Soft == FALSE', 'c_Soft == TRUE').replace('c_WithCalm == FALSE', 'c_WithCalm == TRUE')
            open(rp, 'w').write(t)
            out, secs = tlcrun.tlc(d, module='RP', workers=1, heavy=not a.no_heavy)
            r = judge(d, out)
            r['secs'] = round(secs, 1)
            results[key] = r
            with open(os.path.join(d, 'tlc.out'), 'w') as f:
                f.write(out)
            print(key, 'OK' if r['ok'] else 'FAILED', r, flush=True)
            with open(OUTF, 'w') as f:
                json.dump(results, f, indent=1, sort_keys=True)
    ok = sum(1 for r in results.values() if r['ok'])
    print(f'{ok} of {len(results)} replays succeed')
    for k, r in sorted(results.items()):
        if not r['ok']:
            print('  not ok:', k, r)


if __name__ == '__main__':
    main()
