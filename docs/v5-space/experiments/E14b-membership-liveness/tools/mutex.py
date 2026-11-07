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
    # cheapest first; a mutant stops at the first scenario that catches it.
    # three voters, any one change, no fault, terms <= 4 (an election
    # happens only when a leader's own change removes it)
    ('m3', 'three', dict(Plan='all', ReconfigurationLimit=1, FaultLimit=0, MaxTermLimit=4, **LIVE)),
    # two voters and a learner, any two changes, no fault, terms <= 4
    ('m2', 'two', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=0, MaxTermLimit=4, **LIVE)),
    # two voters and a learner with a specific healing plan (demote a voter or
    # promote the learner), one change, no fault, terms <= 4: the plan goal
    # catches mutants that stop a change from ever taking effect, which "any
    # change" plans cannot (their plan goal is E-14's goal)
    ('m2p', 'two', dict(Plan='stepback', ReconfigurationLimit=1, FaultLimit=0, MaxTermLimit=4, **LIVE)),
    # three voters, any one change, one crash of the leader, terms <= 4
    ('m3c', 'three', dict(Plan='all', ReconfigurationLimit=1, FaultLimit=1, CrashLeaderOnly=True,
                          MaxTermLimit=4, **LIVE)),
    # R2-1's shape: four voters, demote or remove one, one crash of the leader,
    # terms <= 4. Too big per mutant on this box (the design run did not
    # finish in 15 minutes), so the passes in run.sh leave it out.
    ('m4c', 'four-voters', dict(Plan='demote', ReconfigurationLimit=1, FaultLimit=1, CrashLeaderOnly=True,
                                MaxTermLimit=4, **LIVE)),
]
OUT = os.path.join(C.RESULTS, 'mutants')
# Each mutant run's full TLC output (traces) stays in the scratchpad; only
# the table (results/mutants-exhaustive.md) and the JSON summary are kept.
RAW = os.path.join(C.SP, 'e14b', 'mutraw')


def scen_run(tag, scen, kw):
    return dict(scen=scen, kw=kw, dot=True, sym=True, invs=L.SAFETY, spec='LiveSpec')


def caught_by(r, d):
    """How scenario row r (a mutant) differs from d (the design), if it does."""
    if r.get('violated'):
        return '%s' % r['violated']
    if r.get('complete'):
        if r.get('agef') == 'FAIL' and d.get('agef') == 'PASS':
            return 'stuck with a live majority (%s states)' % r.get('stuck_live')
        if r.get('plan') == 'FAIL' and d.get('plan') == 'PASS':
            return 'plan cannot finish (%s states)' % r.get('plan_stuck')
    return None


def one(mname, src, cap, judge_off=2, design=None, stop_early=True, prev=None, only=None):
    rows = dict(prev or {})
    for sname, scen, kw in MUT_SCEN:
        if only and sname not in only:
            continue
        p = (prev or {}).get(sname)
        if p and (p.get('complete') or p.get('violated') or p.get('error') or p.get('skipped')):
            rows[sname] = p     # this scenario already ran to an answer
            continue
        if stop_early and design is not None and any(caught_by(r, design.get(s, {})) for s, r in rows.items()):
            rows[sname] = dict(skipped=True)
            continue
        safe = re.sub(r'[^A-Za-z0-9_.-]', '_', mname)
        name = 'mut-%s-%s' % (safe[:48], sname)
        r = scen_run(name, scen, kw)
        res = L.go(name, seg_secs=cap, max_seg=1, workers=2, heap='4g', labels=True, mutant_src=src, r=r,
                   result_name=safe + '--' + sname, judge=kw['MaxTermLimit'] - judge_off,
                   results_dir=RAW, record=False, redo=True, max_total=2)
        a = res.get('agef', {})
        rows[sname] = dict(distinct=res.get('distinct'), complete=res.get('complete'), violated=res.get('violated'),
                           error=res.get('error'), secs=res.get('secs'), agef=a.get('result'),
                           stuck_live=a.get('stuck_live'), plan=a.get('plan_result'), plan_stuck=a.get('plan_stuck'))
        print('%-55s %-4s %s' % (mname, sname, json.dumps(rows[sname])), flush=True)
    return rows


def main():
    a = sys.argv[1:]
    os.makedirs(RAW, exist_ok=True)
    cap = int(a[a.index('--cap') + 1]) if '--cap' in a else 600
    path = os.path.join(C.RESULTS, 'mutants-exhaustive.json')
    db = json.load(open(path)) if os.path.exists(path) else {}
    if '--table' in a:
        return table(db)
    lines, muts = M.mutants()
    if '--design' in a:
        db['design'] = one('design', open(os.path.join(C.E14_TLA, 'MCferoraft.tla')).read(), cap,
                           prev=db.get('design'),
                           only=a[a.index('--scen') + 1].split(',') if '--scen' in a else None)
        json.dump(db, open(path, 'w'), indent=1, sort_keys=True)
        return
    only = a[a.index('--only') + 1] if '--only' in a else None
    scen = a[a.index('--scen') + 1].split(',') if '--scen' in a else [n for n, _, _ in MUT_SCEN]
    for name, k, new, old in muts:
        if only and only not in name:
            continue
        if '--skip-done' in a and finished(db.get(name), scen, db.get('design')):
            continue
        if C.time_left() < 300:
            print('mutex: no time left in this hold, stopping before %s' % name, flush=True)
            break
        ls = list(lines)
        ls[k] = new
        db[name] = one(name, '\n'.join(ls), cap, design=db.get('design'), prev=db.get(name), only=scen)
        db[name + '#rule'] = old
        json.dump(db, open(path, 'w'), indent=1, sort_keys=True)
    table(db)


def done_row(r):
    return bool(r) and bool(r.get('complete') or r.get('violated') or r.get('error') or r.get('skipped'))


def finished(rows, names, design=None):
    """This mutant is caught already, or every scenario in names ran to an
    answer (a complete graph, a broken invariant, or a TLC error)."""
    if not rows:
        return False
    if design and any(caught_by(r, design.get(s, {})) for s, r in rows.items()):
        return True
    return all(done_row(rows.get(n)) for n in names)


def verdict(rows, design):
    how = []
    unfinished = []
    for s, r in rows.items():
        d = design.get(s, {})
        if r.get('skipped'):
            continue
        c = caught_by(r, d)
        if c:
            how.append('%s: %s' % (s, c))
        elif r.get('error'):
            how.append('%s: TLC error' % s)
        elif not r.get('complete'):
            unfinished.append(s)
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
        sizes = ', '.join('%s %s' % (s, 'skipped' if r.get('skipped') else '%s%s' % (
            r.get('distinct'), '' if r.get('complete') or r.get('violated') else ' (not finished)'))
            for s, r in rows.items())
        out.append('| %s | `%s` | %s | %s | %s |' % (name, old.split('\\*')[0].strip().replace('|', '\\|'), v,
                                                     '; '.join(how), sizes))
    out.append('\n%d mutants run: %d caught' % (n, c))
    open(os.path.join(C.RESULTS, 'mutants-exhaustive.md'), 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out[-3:]))


if __name__ == '__main__':
    main()
