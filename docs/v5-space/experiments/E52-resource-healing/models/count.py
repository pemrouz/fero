#!/usr/bin/env python3
"""
count.py: E-52's rules grouped by the simplicity record that owns them
(judging/simplicity.json), from an ablation result (engine.Ablation).

    python3 models/count.py results/res-ablation.json

For each record: the rules written, the rules kept (each with the property,
bound and counterexample length its removal gives, or `undecided`), the
rules dropped, and the count of distinct checks: within one record, one
guard name written in several actions counts once (so `add.notret` and
`promote.notret` are one check of meta-members). E-16's report.py counts
distinct checks per actor instead (by role), so its total differs; both
totals are printed.
"""
import json
import sys

# rule id -> (record, the record's rule it stands for)
E16_14 = {'add.new', 'add.append', 'promote.learner', 'promote.need', 'promote.odd', 'promote.append',
          'remove.voter', 'remove.gone', 'remove.four', 'remove.append', 'surplus.four', 'surplus.last',
          'surplus.allheld', 'surplus.append'}


def record(rid):
    act, name = rid.split('.', 1)
    if act in ('add', 'promote', 'remove', 'surplus', 'dropl', 'pick'):
        if name == 'notret':
            return 'meta-members@per-resource', 'rule 2: never a new copy on a retiring machine'
        if act == 'pick' and name == 'append':
            return 'healing-self@per-resource', 'rule 15: the pick written to the log before the add'
        if name == 'placed':
            return 'healing-self@per-resource', 'rule 15 (read side): adds and promotions follow the stored placement'
        if act == 'pick' and name == 'cand':
            return 'healing-self@per-resource', "high bound: add.cand (reached within evict.after)"
        tag = "E-16's 14" if rid in E16_14 else ('E-16 dropped it' if act != 'pick' else 'the pick')
        return 'healing-self@per-resource', tag
    if act == 'dial':
        if name == 'leader':
            return 'raft (a working leader; one entry at a time)', "Raft's own"
        return 'healing-self@per-resource', 'new: dial a machine the directory lists before using it'
    if act == 'repref':
        if name == 'leader':
            return 'raft (a working leader; one entry at a time)', "Raft's own"
        return 'hand-back (V5-7)', 'who is preferred once the preferred member leaves the placement'
    if act == 'leave':
        return 'meta-members@per-resource', 'rule 1: says retiring first' if name == 'mark' else \
            'rule 1: leaves the directory'
    if act == 'handback':
        if name == 'leader':
            return 'raft (a working leader; one entry at a time)', "Raft's own"
        if name == 'notdrn':
            return 'planner-hints@per-resource', 'rule 5: no hand-back to a draining member'
        if name == 'transfer':
            return 'raft-leader-transfer', 'the transfer itself'
        return 'hand-back (V5-7)', 'when the hand-back runs'
    if act in ('handover', 'lead'):
        if name in ('voter', 'notme', 'live', 'caught', 'transfer'):
            return 'raft-leader-transfer', "the transfer's own checks"
        if name == 'stale':
            return 'planner-hints@per-resource', 'rule 1: stale-plan'
        if name == 'pref':
            return 'planner-hints@per-resource', 'rule 4: a lead hint sets the preferred leader'
        if name in ('self', 'notdrn'):
            return 'planner-hints@per-resource', 'rule 5: drains hand over, never to a draining member'
    if act == 'drain':
        return 'planner-hints@per-resource', 'rule 5: a draining process says so in its pings'
    if act == 'place':
        if name == 'stale':
            return 'planner-hints@per-resource', 'rule 1: stale-plan'
        if name == 'reach':
            return 'planner-hints@per-resource', 'rule 3: adds only to reachable machines'
        if name == 'append':
            return 'planner-hints@per-resource', "the hint path: write the hint's placement"
    if act == 'gone':
        if name == 'link':
            return 'planner-hints@per-resource', "rule 2: a gone hint is ignored while the leader's link is up"
        if name == 'mark':
            return 'planner-hints@per-resource', 'the hint path: take the gone hint'
    if name in ('leader', 'idle'):
        return 'raft (a working leader; one entry at a time)', "Raft's own"
    return 'other', ''


def fmt(ff):
    if not ff:
        return '-'
    b, p, d, _ = ff
    if p == 'LIMIT':
        return f'undecided ({b}: state limit)'
    return f'{p} on {b}, {d} steps'


def main():
    o = json.load(open(sys.argv[1]))
    rows = [r for r in o['rules'] if not r.get('pinned')]
    groups = {}
    for r in rows:
        rec, tag = record(r['id'])
        r['_tag'] = tag
        groups.setdefault(rec, []).append(r)
    print('## Rules by record (models/count.py)\n')
    print('| record | written | kept | distinct checks kept | kept with a counterexample |')
    print('|---|---|---|---|---|')
    order = ['healing-self@per-resource', 'meta-members@per-resource', 'planner-hints@per-resource',
             'hand-back (V5-7)', 'raft-leader-transfer', 'raft (a working leader; one entry at a time)']
    tot = [0, 0, 0, 0]
    for rec in order + [g for g in groups if g not in order]:
        if rec not in groups:
            continue
        rs = groups[rec]
        kept = [r for r in rs if r['kept']]
        dec = [r for r in kept if r.get('final') and r['final'][1] != 'LIMIT']
        distinct = {(r['id'].split('.', 1)[1] if r['kind'] == 'guard' else r['id']) for r in kept}
        if rec == 'healing-self@per-resource':
            # one guard in several healing actions is one check of the leader's routine
            distinct = {(r['id'].split('.', 1)[1] if r['kind'] == 'guard' else r['id']) for r in kept}
        print(f'| {rec} | {len(rs)} | **{len(kept)}** | {len(distinct)} | {len(dec)} |')
        for k, v in enumerate((len(rs), len(kept), len(distinct), len(dec))):
            tot[k] += v
    print(f'| **total** | {tot[0]} | **{tot[1]}** | {tot[2]} (summed per record) | {tot[3]} |')
    for rec in order + [g for g in groups if g not in order]:
        if rec not in groups:
            continue
        print(f'\n### {rec}\n')
        print('| rule | stands for | kept | removing it breaks | alone on the sweep |')
        print('|---|---|---|---|---|')
        for r in groups[rec]:
            print(f"| `{r['id']}` | {r['_tag']} | {'yes' if r['kept'] else 'no'} | "
                  f"{fmt(r.get('final')) if r['kept'] else '-'} | {fmt(r.get('alone'))} |")


if __name__ == '__main__':
    main()
