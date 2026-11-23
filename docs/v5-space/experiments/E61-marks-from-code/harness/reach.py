#!/usr/bin/env python3
"""
reach.py: what each bound of the design reaches, so a property that holds is not holding for want of a case.

    python3 harness/reach.py OUT.jsonl [BOUND ...]

For each bound, over every reachable state of the design: states with an owner stopped `expired`; states where
the source's floor passed a reader's committed restart point; `resync` jumps and `expire` stops taken; states
with an applied output in a lost tail; loops ended by a failed write (a gap, or a write lost with its copies
spent); `fenced` refusals; skips of an output that was refused on its row; states with a record held inside an
async fn; takeovers taken while the old owner runs; and states where a supervisor gave up (must be 0, or DONE
would not hold). One JSON line per bound.
"""
import importlib.util
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

spec = importlib.util.spec_from_file_location('e61marks', os.path.join(HERE, '..', 'models', 'marks.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
IX = M.IX


def reach(name, limit=1_500_000):
    model = M.Design(M.BOUNDS[name])
    c = engine.Compiled(model, engine.Mutation())
    init = model.init()
    seen = {init}
    todo = [init]
    n = {k: 0 for k in ('expired_states', 'floor_past_a_restart_point', 'resync_steps', 'expire_steps',
                        'states_with_an_output_in_a_lost_tail', 'loop_ends', 'fenced_steps', 'skips_of_a_refused_output',
                        'states_with_a_record_held_in_fn', 'takeovers_old_running', 'gave_up_states')}
    while todo:
        s = todo.pop()
        ds = s[IX['ds']]
        if any(o[1] == M.EXPIRED for o in ds):
            n['expired_states'] += 1
        if any(o[1] == M.GAVEUP for o in ds):
            n['gave_up_states'] += 1
        if any(o[4] for o in ds):
            n['states_with_a_record_held_in_fn'] += 1
        if any(any(e[0] == 'w' for t in s[0][g][2] for e in t) for g in M.BG):
            n['states_with_an_output_in_a_lost_tail'] += 1
        fl = s[IX['floor']]
        if any(model.rp(s, nm)[j] < fl[j] for nm in model.names for j in range(len(fl))):
            n['floor_past_a_restart_point'] += 1
        w, r = model.counts(s)
        for lab, kind, t in c.succ(s):
            a = lab[0]
            if a == 'resync':
                n['resync_steps'] += 1
            elif a == 'expire':
                n['expire_steps'] += 1
            elif a == 'fenced':
                n['fenced_steps'] += 1
            elif a in ('gap', 'fail') and [o[0] for o in ds] != [o[0] for o in t[IX['ds']]]:
                n['loop_ends'] += 1
            elif a == 'skip':
                m = dict(lab[1])['m']
                if m[4][0] == 'o' and m[4][1] in r:
                    n['skips_of_a_refused_output'] += 1
            elif a == 'takeover' and ds[s[IX['hold']][0]][1] == M.UP:
                n['takeovers_old_running'] += 1
            if t not in seen:
                seen.add(t)
                todo.append(t)
        if len(seen) > limit:
            break
    return dict(bound=name, states=len(seen), complete=not todo, **n)


def main():
    out, names = sys.argv[1], sys.argv[2:] or list(M.ALL)
    with open(out, 'a') as f:
        for b in names:
            row = reach(b)
            f.write(json.dumps(row) + '\n')
            f.flush()
            print(json.dumps(row), flush=True)


if __name__ == '__main__':
    main()
