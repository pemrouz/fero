#!/usr/bin/env python3
"""r19.py: settle E-14's mutant r19 (CanCampaign without `i \\in GetConfig(i)`:
a server that is not a voter of its own applied configuration may stand).

E-14b ran it on m3 and m2p (terms up to 4, judged at 2) and found nothing;
m2 and m3c did not finish. Reading the mutant: a non-voter can only stand
after the configuration has changed, and every change here starts at term 2
(the first leader's), so the first election a non-voter can take part in is
term 3, which a run judged at term 2 never judges. This tool runs the same
small scenarios one term further (terms up to 5, judged at 3), the design
first (it must pass), then the mutant, with E-14c's invariant set, and
keeps every stuck state's trace.

  python3 tools/r19.py [SCEN ...]      # default: m3 m2p
"""
import json
import os
import re
import sys

os.environ.setdefault('E14C_KEEP', '1')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import run14c as R  # noqa: E402

sys.path.insert(0, os.path.join(C.E14, 'tools'))
import mutants as M  # noqa: E402

LIVE = R.LIVE
SCEN = {
    # E-14b's mutant scenarios, one term further
    'm3': ('three', dict(Plan='all', ReconfigurationLimit=1, FaultLimit=0, MaxTermLimit=5, **LIVE)),
    'm2p': ('two', dict(Plan='stepback', ReconfigurationLimit=1, FaultLimit=0, MaxTermLimit=5, **LIVE)),
    'm2': ('two', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=0, MaxTermLimit=5, **LIVE)),
}
NAME = 'CanCampaign:drop-guard:r19'
DB = os.path.join(C.RESULTS, 'r19.json')
OUT = os.path.join(C.RESULTS, 'r19')


def main():
    names = [x for x in sys.argv[1:] if not x.startswith('--')] or ['m3', 'm2p']
    lines, muts = M.mutants()
    mut = [m for m in muts if m[0] == NAME][0]
    _, k, new, old = mut
    ls = list(lines)
    ls[k] = new
    src = {'design': None, 'r19': '\n'.join(ls)}
    db = json.load(open(DB)) if os.path.exists(DB) else {}
    db['rule'] = old.strip()
    db['mutant_line'] = new.strip()
    os.makedirs(OUT, exist_ok=True)
    for s in names:
        scen, kw = SCEN[s]
        for who in ('design', 'r19'):
            name = '%s-%s-t5' % (who, s)
            patch = {'MCferoraft.tla': src[who]} if src[who] else None
            r = dict(scen=scen, kw=kw, dot=True, sym=True, invs=R.NEW, patch=patch, judge_off=2)
            res = R.go(name, seg_secs=1500, max_seg=1, workers=2, heap='4g', labels=True, r=r,
                       result_name=name, results_dir=OUT, record=False, redo=True, keep_cfg=False)
            row = {x: res.get(x) for x in ('distinct', 'depth', 'violated', 'complete', 'secs')}
            a = res.get('agef') or {}
            row.update({('agef_' + x): a.get(x) for x in ('result', 'stuck_live', 'judged', 'judge', 'plan_result',
                                                         'plan_stuck')})
            db[name] = row
            json.dump(db, open(DB, 'w'), indent=1, sort_keys=True)
            print('%-18s %s' % (name, json.dumps(row)), flush=True)


if __name__ == '__main__':
    main()
