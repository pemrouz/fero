#!/usr/bin/env python3
"""
count.py: a Markdown summary of ablate.py's results, and the rules counted
the way LAYERS counts them (one sentence of a record is one rule).

    python3 models/count.py results/ablation-absent.json results/ablation-shrink.json [...]
"""
import json
import sys

# Each design rule (DEV-10 grain: a guard conjunct or an update) belongs to one
# sentence (LAYERS' grain). Rules not listed are Raft's own (the leader and
# one-change-at-a-time guards on each proposal) or the transfer's own checks
# (raft-leader-transfer), reported apart, as E-52 did.
SENTENCES = [
    # growth: no record counts these (LAYERS 2.3 "Growing from one voter")
    ('G1', 'growth', 'a placement that names fewer than three machines grows to three once three live '
     'machines say nothing (written into the log first)', ['grow.small', 'grow.cand', 'grow.append']),
    ('G2', 'growth', 'with one voter, every live machine that says nothing is added as a learner',
     ['standby.one', 'standby.new', 'standby.cand', 'standby.notret', 'standby.append']),
    ('G3', 'growth', 'from one voter, promote only once two placed learners hold the commit offset and '
     'answer (two promotions back to back)', ['promote.pair']),
    ('G4', 'growth', 'two voters step back to one: with fewer than three live machines that say nothing and '
     'neither voter retiring, the other voter becomes a learner',
     ['stepback.two', 'stepback.other', 'stepback.few', 'stepback.noret', 'stepback.append']),
    ('G5', 'growth', 'a learner gone to the leader is dropped',
     ['dropl.learner', 'dropl.gone', 'dropl.append']),
    # healing-self (17 in LAYERS), as far as this model has it
    ('H-add', 'healing', 'add only a placed machine not in the config, as a learner (healing-self 1, 15)',
     ['add.placed', 'add.new', 'add.cand', 'add.append']),
    ('H-prom', 'healing', 'promote only a placed learner that holds the commit offset and answers now, never '
     'past four voters (healing-self 2, 14, 15; learners 3)',
     ['promote.learner', 'promote.placed', 'promote.caught', 'promote.live', 'promote.odd', 'promote.append']),
    ('H-rem', 'healing', 'remove only a gone voter, only from four, once the new voter holds the offset again '
     '(healing-self)', ['remove.voter', 'remove.gone', 'remove.four', 'remove.newok', 'remove.append']),
    ('H-sur', 'healing', 'a surplus removal takes the voter the placement leaves out, once the voters left '
     'answer and hold the offset (healing-self)',
     ['surplus.voter', 'surplus.four', 'surplus.last', 'surplus.allheld', 'surplus.append']),
    ('H-pick', 'healing', 'a placed machine gone or retiring: pick one not placed, that answers, and write the '
     'placement first (healing-self 15)', ['pick.need', 'pick.cand', 'pick.new', 'pick.append']),
    # retiring and the clean stop
    ('S1', 'stop', 'a leaver says "retiring" first (meta-members 1)', ['leave.mark']),
    ('S2', 'stop', 'healing never picks, adds or promotes a machine that says retiring (meta-members 2)',
     ['pick.notret', 'add.notret', 'promote.notret', 'opromote.notret']),
    ('S3', 'stop', 'a retiring leader hands over, never to a retiring machine (planner-hints 6)',
     ['handover.self', 'handover.notret', 'handover.transfer']),
    ('S4', 'stop', 'an only voter that says retiring first promotes a caught-up learner (DESIGN-V5 4.2)',
     ['opromote.one', 'opromote.self', 'opromote.learner', 'opromote.caught', 'opromote.live',
      'opromote.append']),
    ('S5', 'stop', 'a voter that says retiring is removed while the live voters left are a majority, no spare '
     'exists and a voter that is not leaving stays (DESIGN-V5 4.2); absent: only from two voters; shrink: '
     'from three only a leave',
     ['lrem.voter', 'lrem.ret', 'lrem.maj', 'lrem.few', 'lrem.keep', 'lrem.newok', 'lrem.two', 'lrem.leave',
      'lrem.append']),
    ('S6', 'stop', "dead voters are removed first when a leave that reached leave.ms needs it (V4-60)",
     ['ldead.voter', 'ldead.dead', 'ldead.carry', 'ldead.maj', 'ldead.append']),
    ('S7', 'stop', 'the leaver exits once no config names it and it leads nothing, or at leave.ms; either way '
     'only once the voters left have applied the latest config, can commit without it and hold every '
     'committed entry',
     ['exit.unnamed', 'exit.nolead', 'exit.safe', 'exit.held', 'exitms.lms', 'exitms.safe', 'exitms.held']),
    ('S8', 'stop', 'a leader that has appended its own removal takes no new write', ['write.stay']),
    ('S9', 'stop', "a retiring voter is left to its own leave until leave.ms (meta-members' high rule)",
     ['pick.wait']),
    ('S10', 'stop', 'a leaving learner is dropped from the config', ['ldrop.learner', 'ldrop.leave', 'ldrop.append']),
    ('S11', 'stop', 'at leave.ms, a leaver that nothing can carry the group without (no live majority, or no live '
     'machine that could stand in for it) stops as a crash would; the group waits for its restart',
     ['exitalone.lms', 'exitalone.alone', 'exitalone.stop']),
]
# LAYERS' own grain: its numbered rules (2.3 growth 1-4, 8.9 B1-B4) and the
# unnumbered rules it lists as owed, each with the sentences above that write it.
LAYERS = [
    ('2.3 rule 1', 'learners first: a placement of three, the others as learners', ['G1', 'G2']),
    ('2.3 rule 2', 'two promotions back to back', ['G3']),
    ('2.3 rule 3', 'two voters step back to one', ['G4']),
    ('2.3 rule 4', 'a gone learner is dropped', ['G5']),
    ('8.9 B1', 'say retiring first; no pick, add or promotion of a retiring machine', ['S1', 'S2']),
    ('8.9 B2', 'hand over, never to a retiring machine', ['S3']),
    ('8.9 B4', 'exit once no config names it, or at leave.ms (with the checks and the bound added here)',
     ['S7', 'S11']),
    ('only voter', "the leave of an only voter: promote a learner first (DESIGN-V5), be removed from two",
     ['S4', 'S5']),
    ('V4-60', 'dead voters removed first when a leave needs it', ['S6']),
    ('leaving learner', 'a leaving learner is dropped', ['S10']),
    ('meta-members high', 'a retiring voter is left to its own leave until leave.ms', ['S9']),
    ('new: write.stay', 'a leader that appended its own removal takes no new write', ['S8']),
]
SID = {}
for sid, area, text, ids in SENTENCES:
    for i in ids:
        SID[i] = sid


def area_of(rid, role):
    if rid in SID:
        return [a for s, a, _, _ in SENTENCES if s == SID[rid]][0]
    if rid.endswith('.leader') or rid.endswith('.idle'):
        return "raft's own"
    if role == 'xfer':
        return 'transfer'
    return role


def ff(f):
    if not f:
        return '-'
    b, p, d, _ = f
    if p == 'LIMIT':
        return f'undecided ({b}: state limit)'
    return f'{p} on {b} ({d} steps)'


def one(path):
    o = json.load(open(path))
    name = o['option']
    print(f'## {name}\n')
    if o.get('error'):
        print(f'**Error:** {o["error"]}\n')
        return None
    base = o['base']
    print('The design, every bound: ' + '; '.join(
        f'{b}: {x["states"]:,} states' for b, x in base.items()) + '.\n')
    rows = [r for r in o['rules'] if not r['pinned']]
    core = [r for r in o['rules'] if r.get('core')]
    kept = [r for r in rows if r['kept']]
    print(f'**{len(kept)} of {len(rows)} design rules kept** (DEV-10 grain).\n')
    areas = {}
    for r in rows:
        a = area_of(r['id'], r['role'])
        k, n = areas.get(a, (0, 0))
        areas[a] = (k + (1 if r['kept'] else 0), n + 1)
    print('| Area | Written | Kept |\n|---|---|---|')
    for a, (k, n) in sorted(areas.items()):
        print(f'| {a} | {n} | {k} |')
    print()
    print('**By sentence (LAYERS\' grain)**: a sentence counts if at least one of its rules is kept.\n')
    print('| Sentence | Area | Rule | Kept rules |\n|---|---|---|---|')
    ks = set(r['id'] for r in kept)
    nsent = {}
    for sid, area, text, ids in SENTENCES:
        kk = [i for i in ids if i in ks]
        if kk:
            nsent[area] = nsent.get(area, 0) + 1
        print(f'| {sid} | {area} | {text} | {", ".join(kk) or "none"} |')
    print()
    print('Sentences kept by area: ' + ', '.join(f'{a} {n}' for a, n in sorted(nsent.items())) + '.\n')
    print('### Each design rule dropped alone (pass 1), and its fate\n')
    print('| Rule | Role | Dropped alone breaks | Kept | Dropped from the smallest model breaks |\n|---|---|---|---|---|')
    for r in rows:
        print(f'| `{r["id"]}` | {area_of(r["id"], r["role"])} | {ff(r.get("alone"))} | '
              f'{"yes" if r["kept"] else "no"} | {ff(r.get("final")) if r["kept"] else ""} |')
    print()
    print('### Raft-core rules dropped alone (pinned in the ablation)\n')
    print('| Rule | Dropped alone breaks |\n|---|---|')
    for r in core:
        print(f'| `{r["id"]}` | {ff(r.get("alone"))} |')
    print()
    ms = o.get('mutants', [])
    if ms:
        c = sum(1 for m in ms if m['caught'])
        e = sum(1 for m in ms if not m['caught'] and m.get('equivalent'))
        u = sum(1 for m in ms if m.get('undecided'))
        s = len(ms) - c - e - u
        print(f'### Mutants of the smallest model: {len(ms)}; caught {c}; equivalent {e}; undecided {u}; '
              f'survived {s} ({100 * c / max(1, len(ms) - e):.0f} % of the non-equivalent)\n')
        print('| Kind | Rule | Caught by |\n|---|---|---|')
        for m in ms:
            what = ff(m['caught']) if m['caught'] else ('equivalent' if m.get('equivalent') else
                                                       ('undecided' if m.get('undecided') else 'SURVIVED'))
            print(f'| {m["kind"]} | `{m["rule"]}` | {what} |')
        print()
    cc = sum(1 for r in core if r.get('alone'))
    print(f'Raft-core rules caught when dropped alone: {cc} of {len(core)}.\n')
    return name, len(kept), nsent


def main():
    print('# E-59 ablation summary\n')
    out = []
    for p in sys.argv[1:]:
        x = one(p)
        if x:
            out.append(x)
    if out:
        print('## Side by side\n')
        print('| Option | Design rules kept (DEV-10) | Sentences kept (LAYERS\' grain) |\n|---|---|---|')
        for name, k, ns in out:
            print(f'| {name} | {k} | {sum(ns.values())} ({", ".join(f"{a} {n}" for a, n in sorted(ns.items()))}) |')


if __name__ == '__main__':
    main()
