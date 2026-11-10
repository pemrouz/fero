#!/usr/bin/env python3
"""bugs.py: do the replacement invariants still catch real safety bugs?

Three kinds of bug, each run to its first violation (or to completion) on a
small scenario, once per invariant set, so each catch is attributed:

  ghost      E-14b's three-ghost: a lost disk comes back at once, empty,
             under its old id (MCferoraft's GhostReturn). E-14b showed a
             committed entry is then really lost (three-ghost-loss).
  minority   planted in etcdraft.tla: a leader commits once ANY one member
             (itself included) has the entry, not a quorum (a lost commit).
  anylog     planted in etcdraft.tla: a voter grants its vote whatever the
             candidate's log (the up-to-date check dropped; a lost commit).
  twovote    planted in etcdraft.tla: a voter grants a second vote in the
             same term (two leaders in one term).
  mutants    E-14's DEV-10 mutants that E-14b caught with QuorumLogInvLive
             (r02, r05, r06, r09) or might have caught with the shipped
             LeaderCompletenessInv, re-run with the new set (E-14's
             generator, unchanged, reading E-14's MCferoraft.tla).

  python3 tools/bugs.py [KIND ...]      # all kinds by default
  python3 tools/bugs.py --table         # results/bugs.md from results/bugs.json

Invariant sets per planted bug: each replacement alone, LogInv alone (does
the bug really lose a commit?), the full new set, the shipped set.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import run14c as R  # noqa: E402

sys.path.insert(0, os.path.join(C.E14, 'tools'))
import mutants as M  # noqa: E402  (E-14's generator, read-only)

LIVE = R.LIVE
OUT = os.path.join(C.RESULTS, 'bugs')
DB = os.path.join(C.RESULTS, 'bugs.json')

SETS = {
    'VoteQuorumInv': ['VoteQuorumInv'],
    'CommittedQuorumInv': ['CommittedQuorumInv'],
    'LeaderCompletenessRaftInv': ['LeaderCompletenessRaftInv'],
    'CommittedNeverLostInv': ['CommittedNeverLostInv'],
    'LogInv': ['LogInv'],
    'new': R.NEW,
    'shipped': R.SHIPPED,
}

# three voters, any one change, one crash (or lost disk), terms <= 4
C3F = dict(Plan='all', ReconfigurationLimit=1, FaultLimit=1, MaxTermLimit=4, **LIVE)
GHOST = dict(Plan='all', ReconfigurationLimit=1, AllowLoseDisk=True, GhostReturn=True, MaxTermLimit=4, **LIVE)

CAP = 300   # each run stops after this many seconds; BFS finds a shallow violation long before

RAFT = os.path.join(C.RAFT_TLA, 'etcdraft.tla')

PLANTS = {
    'minority': ('Agree(index) \\in Quorum(GetConfig(i))}', 'Agree(index) # {}}'),
    'anylog': ('/\\ logOk\n                 /\\ votedFor[i] \\in {Nil, j}',
               '/\\ TRUE\n                 /\\ votedFor[i] \\in {Nil, j}'),
    'twovote': ('/\\ votedFor[i] \\in {Nil, j}\n    IN', '/\\ TRUE\n    IN'),
}


def planted(kind):
    src = open(RAFT).read()
    old, new = PLANTS[kind]
    if src.count(old) != 1:
        raise SystemExit('%s: the text to plant into is not found exactly once' % kind)
    return src.replace(old, new)


def one(name, scen, kw, invs, patch=None, dot=False):
    r = dict(scen=scen, kw=kw, dot=dot, sym=True, invs=invs, patch=patch, judge_off=2)
    res = R.go(name, seg_secs=CAP, max_seg=1, workers=2, heap='3g', labels=dot, r=r, result_name=name,
               results_dir=OUT, record=False, redo=True, keep_cfg=False)
    row = {k: res.get(k) for k in ('distinct', 'depth', 'violated', 'complete', 'error', 'secs')}
    if res.get('agef'):
        row['agef'] = res['agef'].get('result')
        row['stuck_live'] = res['agef'].get('stuck_live')
        row['plan'] = res['agef'].get('plan_result')
    print('%-40s %s' % (name, json.dumps(row)), flush=True)
    return row


def trace_len(name):
    p = os.path.join(OUT, name + '.txt')
    if not os.path.exists(p):
        return None
    st = re.findall(r'^State (\d+):', open(p).read(), re.M)
    return int(st[-1]) if st else None


def main():
    a = sys.argv[1:]
    db = json.load(open(DB)) if os.path.exists(DB) else {}
    if '--table' in a:
        return table(db)
    sets = a[a.index('--sets') + 1].split(',') if '--sets' in a else list(SETS)
    kinds = [x for i, x in enumerate(a) if not x.startswith('--') and (i == 0 or a[i - 1] != '--sets')] \
        or ['ghost', 'minority', 'anylog', 'twovote', 'mutants']
    os.makedirs(OUT, exist_ok=True)
    for kind in kinds:
        if kind == 'mutants':
            mutants(db)
            continue
        if kind == 'ghost':
            scen, kw, patch = 'three', GHOST, None
        else:
            scen, kw, patch = 'three', C3F, {'etcdraft.tla': planted(kind)}
        for sname, invs in SETS.items():
            if sname not in sets:
                continue
            name = '%s--%s' % (kind, sname)
            row = one(name, scen, kw, invs, patch)
            row['trace_states'] = trace_len(name) if row.get('violated') else None
            db[name] = row
            json.dump(db, open(DB, 'w'), indent=1, sort_keys=True)
    table(db)


# E-14's mutants that E-14b caught with an invariant this study replaces,
# on the scenario that caught them there (m2), then m3c if needed.
MUT = ['FeroBecomeLeader:drop-update-pendingConfChangeIndex:r02', 'ProposeConf:drop-guard:r05',
       'ProposeConf:drop-guard:r06', 'ProposeConf:drop-update-pendingConfChangeIndex:r09']
MSCEN = [('m2', 'two', dict(Plan='all', ReconfigurationLimit=2, FaultLimit=0, MaxTermLimit=4, **LIVE)),
         ('m3c', 'three', dict(Plan='all', ReconfigurationLimit=1, FaultLimit=1, CrashLeaderOnly=True,
                               MaxTermLimit=4, **LIVE))]


def mutants(db):
    lines, muts = M.mutants()
    # the design first, on the cheaper scenario: it must pass
    row = one('design--m2', MSCEN[0][1], MSCEN[0][2], R.NEW, None, dot=True)
    row['mutant'] = 'design (no mutant)'
    db['design--m2'] = row
    json.dump(db, open(DB, 'w'), indent=1, sort_keys=True)
    for mname, k, new, old in muts:
        if mname not in MUT:
            continue
        ls = list(lines)
        ls[k] = new
        src = '\n'.join(ls)
        for sname, scen, kw in MSCEN:
            safe = re.sub(r'[^A-Za-z0-9_.-]', '_', mname)
            name = 'mut-%s--%s' % (safe.split('_')[-1], sname)
            # with the state graph, so AG EF can catch it too (E-14b's mutex.py
            # did the same; the design passes m2 and m3c, E-14b and step 1)
            row = one(name, scen, kw, R.NEW, {'MCferoraft.tla': src}, dot=True)
            row['mutant'] = mname
            row['trace_states'] = trace_len(name) if row.get('violated') else None
            db[name] = row
            json.dump(db, open(DB, 'w'), indent=1, sort_keys=True)
            if row.get('violated') or row.get('agef') == 'FAIL' or row.get('plan') == 'FAIL':
                break


def table(db):
    out = ['# Do the replacement invariants still catch real bugs? (tools/bugs.py)', '',
           'Planted bugs: one row per invariant set checked (the set named, alone). Mutants: E-14\'s',
           'DEV-10 mutants, checked with the new set (MCferoc.tla) on the scenario named.', '',
           '| bug | invariants checked, or scenario | result | first violated | trace (states) | distinct states |',
           '|---|---|---|---|---|---|']
    for name in sorted(db):
        r = db[name]
        kind, _, sname = name.partition('--')
        if r.get('mutant'):
            kind = r['mutant']
            sname = sname + ' (new set)'
        res = ('violated' if r.get('violated') else 'complete, none violated' if r.get('complete')
               else 'error: %s' % r['error'] if r.get('error') else 'not finished')
        if r.get('agef'):
            res += '; AG EF %s (%s stuck), plan %s' % (r['agef'], r.get('stuck_live'), r.get('plan'))
        out.append('| %s | %s | %s | %s | %s | %s |' % (
            kind, sname, res, r.get('violated') or '', r.get('trace_states') or '', r.get('distinct')))
    open(os.path.join(C.RESULTS, 'bugs.md'), 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
