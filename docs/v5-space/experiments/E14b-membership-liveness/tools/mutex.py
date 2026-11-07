#!/usr/bin/env python3
"""mutex.py: DEV-10's mutants of E-14's membership rules, by exhaustive
search (E-14 could run them only in random simulation).

The mutants are E-14's own (its tools/mutants.py, unchanged, reading E-14's
tla/MCferoraft.tla): each tagged guard dropped, each tagged update dropped,
each comparison flipped; 22 in all. Each mutant runs on every scenario in
MUT_SCEN below, on E-14b's reduced model (MCferolive.tla), to completion:
the 8 safety invariants in every state, then AG EF on the state graph for
E-14's goal (a working leader) and for the plan goal (healing finishes when
nothing fails). The design runs the same scenarios first and must pass.

A mutant is caught when some scenario breaks an invariant, or reports a
stuck state (or an unfinishable plan) where the design reports none.

  python3 tools/mutex.py --design            # the design on every scenario
  python3 tools/mutex.py [--only SUBSTR]     # the mutants
  python3 tools/mutex.py --table             # results/mutants-exhaustive.md
Each scenario run is one TLC run; runs are capped (--cap S, default 600 s),
and a capped run is reported as not finished.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import live as L  # noqa: E402

sys.path.insert(0, os.path.join(C.E14, 'tools'))
import mutants as M  # noqa: E402  (E-14's generator, read-only)

LIVE = dict(AllowDrop=False, AllowStepDown=False, LeaderLease=True)
# Scenarios small enough to finish per mutant (sizes in README):
MUT_SCEN = [
    # three voters, any one change, one crash, terms <= 4
    ('m3', 'three', dict(Plan='all', ReconfigurationLimit=1, FaultLimit=1, MaxTermLimit=4, **LIVE)),
    # two voters and a learner, any two changes, no fault, terms <= 4
    ('m2', 'two', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=0, MaxTermLimit=4, **LIVE)),
    # three voters and a spare id, any two changes, one lost disk, terms <= 4
    ('m3s', 'three+spare', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=1, AllowLoseDisk=True,
                                MaxTermLimit=4, **LIVE)),
    # R2-1's shape: four voters, demote one, one crash, terms <= 4
    ('m4', 'four-voters', dict(Plan='demote', ReconfigurationLimit=1, FaultLimit=1, MaxTermLimit=4, **LIVE)),
]
OUT = os.path.join(C.RESULTS, 'mutants')


def scen_run(tag, scen, kw):
    return dict(scen=scen, kw=kw, dot=True, sym=True, invs=L.SAFETY, spec='LiveSpec')


def one(mname, src, cap, judge_off=2):
    rows = {}
    for sname, scen, kw in MUT_SCEN:
        safe = re.sub(r'[^A-Za-z0-9_.-]', '_', mname)
        name = 'mut-%s-%s' % (safe[:48], sname)
        r = scen_run(name, scen, kw)
        res = L.go(name, seg_secs=cap, max_seg=1, workers=2, heap='4g', labels=True, mutant_src=src, r=r,
                   result_name=os.path.join('mutants', safe + '--' + sname),
                   judge=kw['MaxTermLimit'] - judge_off)
        a = res.get('agef', {})
        rows[sname] = dict(distinct=res.get('distinct'), complete=res.get('complete'), violated=res.get('violated'),
                           error=res.get('error'), secs=res.get('secs'), agef=a.get('result'),
                           stuck_live=a.get('stuck_live'), plan=a.get('plan_result'), plan_stuck=a.get('plan_stuck'))
        print('%-55s %-4s %s' % (mname, sname, json.dumps(rows[sname])), flush=True)
    return rows


def main():
    a = sys.argv[1:]
    os.makedirs(OUT, exist_ok=True)
    cap = int(a[a.index('--cap') + 1]) if '--cap' in a else 600
    path = os.path.join(C.RESULTS, 'mutants-exhaustive.json')
    db = json.load(open(path)) if os.path.exists(path) else {}
    if '--table' in a:
        return table(db)
    lines, muts = M.mutants()
    if '--design' in a:
        db['design'] = one('design', open(os.path.join(C.E14_TLA, 'MCferoraft.tla')).read(), cap)
        json.dump(db, open(path, 'w'), indent=1, sort_keys=True)
        return
    only = a[a.index('--only') + 1] if '--only' in a else None
    for name, k, new, old in muts:
        if only and only not in name:
            continue
        if '--skip-done' in a and name in db:
            continue
        ls = list(lines)
        ls[k] = new
        db[name] = one(name, '\n'.join(ls), cap)
        db[name + '#rule'] = old
        json.dump(db, open(path, 'w'), indent=1, sort_keys=True)
    table(db)


def verdict(rows, design):
    how = []
    unfinished = []
    for s, r in rows.items():
        d = design.get(s, {})
        if r.get('violated'):
            how.append('%s: %s' % (s, r['violated']))
        elif r.get('error'):
            how.append('%s: TLC error' % s)
        elif not r.get('complete'):
            unfinished.append(s)
        else:
            if r.get('agef') == 'FAIL' and d.get('agef') == 'PASS':
                how.append('%s: stuck with a live majority (%s states)' % (s, r.get('stuck_live')))
            if r.get('plan') == 'FAIL' and d.get('plan') == 'PASS':
                how.append('%s: plan cannot finish (%s states)' % (s, r.get('plan_stuck')))
    caught = any('TLC error' not in h for h in how)
    return ('caught' if caught else ('not finished' if unfinished and not how else 'not caught')), how, unfinished


def table(db):
    design = db.get('design', {})
    lines, muts = M.mutants()
    out = ['# DEV-10 mutants of E-14\'s membership rules, by exhaustive search on MCferolive.tla',
           '#   scenarios: ' + '; '.join('%s = %s %s' % (n, s, json.dumps(k, sort_keys=True)) for n, s, k in MUT_SCEN),
           '#   design: ' + json.dumps(design, sort_keys=True), '',
           '| mutant | rule | verdict | how | states per scenario |', '|---|---|---|---|---|']
    n = c = 0
    for name, k, new, old in muts:
        rows = db.get(name)
        if not rows:
            out.append('| %s | `%s` | not run | | |' % (name, old.split('\\*')[0].strip().replace('|', '\\|')))
            continue
        v, how, unf = verdict(rows, design)
        n += 1
        c += v == 'caught'
        sizes = ', '.join('%s %s%s' % (s, r.get('distinct'), '' if r.get('complete') or r.get('violated') else ' (not finished)')
                          for s, r in rows.items())
        out.append('| %s | `%s` | %s | %s | %s |' % (name, old.split('\\*')[0].strip().replace('|', '\\|'), v,
                                                     '; '.join(how), sizes))
    out.append('\n%d mutants run: %d caught' % (n, c))
    open(os.path.join(C.RESULTS, 'mutants-exhaustive.md'), 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out[-3:]))


if __name__ == '__main__':
    main()
