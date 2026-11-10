#!/usr/bin/env python3
"""count.py: DEV-10's count for E-24. Reads an ablation result, takes the rules
the ablation kept, and puts each under the mechanism it belongs to, with that
mechanism's precedent (DEV-10 (a), (b)). A mechanism is novel only if no cited
paper or production system has the same state and rules in the same role.
This is the first agent's count; DEV-10 (e) asks a second agent to count on
their own and settle the differences.

    python3 count.py results/saga-fullundo-ablation.json
    python3 count.py results/ramp-ablation.json
"""
import json
import sys

# (rule id prefix or exact id, mechanism, precedent or 'NOVEL: why')
SAGA = [
    ('claim.', 'lock with lease and fencing token',
     'Chubby sequencers (Burrows, OSDI 2006); etcd lease + revision; Kleppmann 2016 "fencing tokens"'),
    ('giveup.', 'a holder refused by a fence stops and retries',
     'Kleppmann 2016 (a client whose token is refused must stop); the app retry of saga(steps, { id })'),
    ('step.fence', 'per-partition fence table', 'Chubby: the resource server checks the sequencer'),
    ('step.raise', 'per-partition fence table', 'Chubby: the resource server keeps the latest sequencer'),
    ('fail.fence', 'per-partition fence table', 'Chubby'),
    ('undo.fence', 'per-partition fence table', 'Chubby'),
    ('undo.raise', 'per-partition fence table', 'Chubby'),
    ('bump.', 'the ender writes every partition (fence bump)',
     'Kafka KIP-98: InitProducerId bumps the epoch; markers go to every partition of the open transaction'),
    ('fail.raise', 'a refusal raises the fence (kernel)', 'NOVEL: no cited system commits a record for a refused write'),
    ('.holds0', 'fenced writes to the intent row', 'Chubby sequencer checked by the resource (here #sagas in M)'),
    ('.holdsN', 'fenced writes to the intent row', 'Chubby sequencer checked by the resource (here #sagas in M)'),
    ('.noother', 'locks owned by the unit; resolve an unfinished unit first',
     'Percolator (Peng and Dabek, OSDI 2010): a transaction that meets a dead one\'s lock rolls it forward or back first'),
    ('other.', 'locks owned by the unit; resolve an unfinished unit first', 'Percolator'),
    ('backoff.', 'locks owned by the unit; resolve an unfinished unit first', 'Percolator'),
    ('retry.', 'locks owned by the unit; resolve an unfinished unit first', 'Percolator'),
    # counted strictly: new to sagas. If the judges accept Kafka's end markers as "the
    # same state and the same rules in the same role" (DEV-10 b), this line is published
    # and the saga's novel count is 0.
    ('decide.pc', 'the ender writes every partition (undo every step)',
     'NOVEL (strict count): no published saga undoes steps that never ran. Nearest precedent: Kafka KIP-98 '
     '(end markers go to every partition of the transaction) with KIP-890 (the epoch rises at every end)'),
    ('', 'saga log: intent row, forward and backward recovery, program order',
     'Garcia-Molina and Salem, SIGMOD 1987 (the saga log; backward recovery by compensation; forward recovery)'),
]

RAMP = [
    ('r1.mono', 'monotonic reads (fero\'s read rule, API.md "Reads")', 'existing fero rule, not RAMP\'s'),
    ('finish.seen', 'monotonic reads (fero\'s read rule, API.md "Reads")', 'existing fero rule, not RAMP\'s'),
    ('r2.commit', 'commit on fetch', 'NOVEL here: RAMP leaves a failed client\'s commits to recovery'),
    ('r2.last', 'commit on fetch', 'NOVEL here'),
    ('gc.', 'version garbage collection', 'RAMP (Bailis et al., SIGMOD 2014), versions kept for in-flight reads'),
    ('restart.', 'reader restarts when a version was collected', 'RAMP\'s GC discussion (reasoned)'),
    ('move.', 'a slot move carries the slot\'s fold', 'E-15 and DESIGN-V5 4.2\'s carried state (one more field)'),
    ('', 'RAMP-Fast: prepare, commit markers after all prepares, lastCommit max, two-round reads',
     'RAMP-Fast (Bailis et al., SIGMOD 2014)'),
]


def classify(rid, table):
    for pre, mech, prec in table:
        if pre and (rid.startswith(pre) or rid.endswith(pre) or rid == pre):
            return mech, prec
    return table[-1][1], table[-1][2]


def main():
    o = json.load(open(sys.argv[1]))
    table = RAMP if o.get('option') in ('ramp', 'noserve') else SAGA
    kept = [r for r in o.get('rules', []) if r['kept'] and not r.get('pinned')]
    mechs = {}
    prec = {}
    for r in kept:
        m, p = classify(r['id'], table)
        mechs.setdefault(m, []).append(r['id'])
        prec.setdefault(m, p)          # the first (fullest) precedent line of the mechanism
    und = [r['id'] for r in kept if r.get('final') and r['final'][1] == 'LIMIT']
    print(f'## {o.get("option")}: {len(kept)} rules kept, by mechanism\n')
    if und:
        print(f'Kept without a counterexample (their removal stops at the state limit): ' +
              ', '.join(f'`{i}`' for i in und) + f'. Needed with a counterexample: {len(kept) - len(und)}.\n')
    print('| mechanism | rules kept | precedent |')
    print('|---|---|---|')
    novel_rules = 0
    novel_mechs = 0
    for m, ids in mechs.items():
        p = prec[m]
        print(f'| {m} | {len(ids)}: ' + ', '.join(f'`{i}`' for i in ids) + f' | {p} |')
        if p.startswith('NOVEL'):
            novel_rules += len(ids)
            novel_mechs += 1
    print(f'\nNovel by this count: {novel_mechs} mechanisms, {novel_rules} rules.\n')


if __name__ == '__main__':
    main()
