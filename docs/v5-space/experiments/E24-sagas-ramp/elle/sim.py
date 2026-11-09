#!/usr/bin/env python3
"""
sim.py: E-24's histories for real Elle (list-append). A seeded random
simulation, not the exhaustive model: it gives Elle many histories with
concurrent readers, which the model has none of for sagas.

Units are sagas over 2 or 3 of the partitions k0, k1, k2: each appends its
unit id to the list at each of its partitions, under the saga's locks (taken
in key order, owned by the unit until it ends, as models/saga.py checks).
A holder may crash between any two steps; a later holder finishes or undoes
the unit. A step's condition may fail; then the unit is undone.

Two visibility modes:
  plain  each step's append is visible at once (DESIGN-V5 5.3's saga; readers
         may see a unit half done)
  rampv  as ramp, but a version carries, for each sibling partition, the
         newest unit it includes that also wrote there (its value includes
         every earlier unit's append, not only its writer's), and the reader
         repeats round 2 until nothing more is needed; the rounds are counted
  ramp   RAMP-Fast under the same locks: each step is a prepare (a pending
         version with the unit id and its sibling partitions), invisible to
         round-1 reads; once every prepare is acked the unit's decision is
         recorded (a timestamp is assigned) and commit markers go to each
         partition one by one; a failed prepare aborts (pending versions are
         dropped and never seen). A reader reads each partition's lastCommit
         version in round 1, then fetches any newer sibling version by unit
         id in round 2.

Readers read 2 or 3 partitions per transaction, one partition per step, so
writes interleave between their reads.

Each history is written as Elle EDN: a unit is one transaction of appends
(:ok if it ended done, :fail if undone or aborted); a read transaction is
one transaction of reads (:ok). Usage:
    python3 sim.py OUTDIR MODE SEEDS [P_FAIL]
"""
import os
import random
import sys

PARTS = (0, 1, 2)


def run(mode, seed, units=10, readers=3, reads_each=6, p_crash=0.08, p_fail=0.15, stats=None):
    stats = {} if stats is None else stats
    rnd = random.Random(seed)
    hist = []
    now = [0]

    def ev(kind, proc, value):
        now[0] += 1
        hist.append({'type': kind, 'process': proc, 'value': value, 'time': now[0]})

    # partition state
    plain = {k: [] for k in PARTS}                 # visible list (plain mode)
    vers = {k: {} for k in PARTS}                  # ramp: ts -> list value (pending or committed)
    order = {k: [] for k in PARTS}                 # ramp: unit ids prepared in lock order
    last = {k: 0 for k in PARTS}                   # ramp: lastCommit ts
    md = {}                                        # ramp: ts -> sibling partitions
    vec = {k: {} for k in PARTS}                   # rampv: ts -> {sibling: newest unit included}
    uts = {}                                       # unit id -> ts
    owner = {k: None for k in PARTS}               # lock: the unit holding it
    tsn = [0]

    stats['reads'] = stats['round2'] = stats['round3'] = stats['maxrounds'] = 0

    def needs(c):
        need = {k: 0 for k in c['ks']}
        for k, (ts, _) in c['got'].items():
            if mode == 'rampv':
                for s, t in vec[k].get(ts, {}).items():
                    if s in need and t > need[s]:
                        need[s] = t
            else:
                for s in md.get(ts, ()):
                    if s in need and ts > need[s]:
                        need[s] = ts
        return need
    U = []
    for u in range(1, units + 1):
        ks = sorted(rnd.sample(PARTS, rnd.choice((2, 3))))
        U.append({'id': u, 'parts': ks, 'pc': 'lock', 'i': 0, 'state': None, 'ts': 0,
                  'crashed': False, 'proc': 100 + u, 'started': False, 'ended': False})
    R = [{'proc': r, 'n': 0, 'cur': None} for r in range(readers)]

    def unit_step(u):
        if u['pc'] == 'lock':
            k = u['parts'][u['i']]
            if owner[k] not in (None, u['id']):
                return False                        # held by another unit until it ends
            owner[k] = u['id']
            if not u['started']:
                u['started'] = True
                ev('invoke', u['proc'], [['append', k2, u['id']] for k2 in u['parts']])
            u['i'] += 1
            if u['i'] == len(u['parts']):
                u['pc'], u['i'], u['state'] = 'step', 0, 'run'
            return True
        if u['pc'] == 'step':
            k = u['parts'][u['i']]
            if rnd.random() < p_fail:
                u['state'] = 'undo'
                u['pc'] = 'undo'
                u['i'] = len(u['parts']) - 1       # undo every step (models/saga.py: fullundo)
                return True
            if mode == 'plain':
                if u['id'] not in plain[k]:
                    plain[k].append(u['id'])
            else:
                if u['id'] not in order[k]:
                    order[k].append(u['id'])
            u['i'] += 1
            if u['i'] == len(u['parts']):
                if mode == 'plain':
                    u['pc'] = 'end'
                else:
                    tsn[0] += 1                    # the decision: every prepare acked
                    u['ts'] = tsn[0]
                    md[u['ts']] = tuple(u['parts'])
                    uts[u['id']] = u['ts']
                    for k2 in u['parts']:
                        upto = order[k2][:order[k2].index(u['id']) + 1]
                        vers[k2][u['ts']] = list(upto)
                        v = {}
                        for uid in upto:             # every unit this version includes
                            for s2 in U[uid - 1]['parts']:
                                v[s2] = max(v.get(s2, 0), uts[uid])
                        vec[k2][u['ts']] = v
                    u['pc'], u['i'] = 'commit', 0
            return True
        if u['pc'] == 'commit':
            k = u['parts'][u['i']]
            last[k] = max(last[k], u['ts'])
            u['i'] += 1
            if u['i'] == len(u['parts']):
                u['pc'] = 'end'
            return True
        if u['pc'] == 'undo':
            k = u['parts'][u['i']]
            if mode == 'plain':
                plain[k] = [v for v in plain[k] if v != u['id']]
            else:
                order[k] = [v for v in order[k] if v != u['id']]
            u['i'] -= 1
            if u['i'] < 0:
                u['pc'] = 'end'
            return True
        if u['pc'] == 'end':
            for k in u['parts']:
                if owner[k] == u['id']:
                    owner[k] = None
            u['ended'] = True
            done = u['state'] == 'run'
            ev('ok' if done else 'fail', u['proc'], [['append', k, u['id']] for k in u['parts']])
            return True
        return False

    def read_val(k, ts):
        if ts == 0:
            return []
        return list(vers[k][ts])

    def reader_step(r):
        if r['cur'] is None:
            if r['n'] >= reads_each:
                return False
            ks = sorted(rnd.sample(PARTS, rnd.choice((2, 3))))
            r['cur'] = {'ks': ks, 'got': {}, 'round': 1}
            ev('invoke', r['proc'], [['r', k, None] for k in ks])
            return True
        c = r['cur']
        if mode == 'plain':
            todo = [k for k in c['ks'] if k not in c['got']]
            if todo:
                k = todo[0]
                c['got'][k] = (0, list(plain[k]))
                return True
        else:
            if c['round'] == 1:
                todo = [k for k in c['ks'] if k not in c['got']]
                if todo:
                    k = todo[0]
                    c['got'][k] = (last[k], read_val(k, last[k]))
                    return True
                c['round'] = 2
                c['need'] = needs(c)
                return True
            if mode == 'rampv' and not [k for k in c['ks'] if c['need'][k] > c['got'][k][0]]:
                nn = needs(c)                        # what the round-2 versions brought in
                if any(nn[k] > c['got'][k][0] for k in c['ks']):
                    c['need'] = nn
                    c['rounds'] = c.get('rounds', 2) + 1
            todo = [k for k in c['ks'] if c['need'][k] > c['got'][k][0]]
            if todo and not c.get('r2'):
                c['r2'] = True
                stats['round2'] += 1
            if todo:
                k = todo[0]
                ts = c['need'][k]
                c['got'][k] = (ts, read_val(k, ts))     # the exact version, by unit id
                return True
        ev('ok', r['proc'], [['r', k, c['got'][k][1]] for k in c['ks']])
        stats['reads'] += 1
        if c.get('rounds', 2) > 2:
            stats['round3'] += 1
        stats['maxrounds'] = max(stats['maxrounds'], c.get('rounds', 2) if c.get('r2') else 1)
        r['cur'] = None
        r['n'] += 1
        return True

    steps = 0
    while steps < 100000:
        steps += 1
        live = [u for u in U if not u['ended'] and not u['crashed']]
        cands = [('u', u) for u in live] + [('r', r) for r in R if r['cur'] is not None or r['n'] < reads_each]
        if not cands:
            crashed = [u for u in U if u['crashed'] and not u['ended']]
            if not crashed:
                break
            # a later holder takes the crashed unit over (same unit, same locks)
            u = rnd.choice(crashed)
            u['crashed'] = False
            continue
        kind, a = rnd.choice(cands)
        if kind == 'u':
            if a['started'] and rnd.random() < p_crash:
                a['crashed'] = True                # its locks stay with the unit
                continue
            unit_step(a)
        else:
            reader_step(a)
        # sometimes a later holder recovers a crashed unit early
        for u in U:
            if u['crashed'] and rnd.random() < 0.05:
                u['crashed'] = False
    return hist


def edn(v):
    if v is None:
        return 'nil'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return ':' + v
    if isinstance(v, list):
        return '[' + ' '.join(edn(x) for x in v) + ']'
    raise TypeError(v)


def write(path, hist):
    with open(path, 'w') as f:
        f.write('[\n')
        for i, op in enumerate(hist):
            f.write('{:index %d :time %d :type :%s :process %d :f :txn :value %s}\n'
                    % (i, op['time'], op['type'], op['process'], edn(op['value'])))
        f.write(']\n')


def main():
    out, mode, seeds = sys.argv[1], sys.argv[2], int(sys.argv[3])
    pf = float(sys.argv[4]) if len(sys.argv) > 4 else 0.15
    tag = f'{mode}-f{int(pf * 100):02d}'
    os.makedirs(out, exist_ok=True)
    tot = {'reads': 0, 'round2': 0, 'round3': 0, 'maxrounds': 0}
    for s in range(seeds):
        st = {}
        write(os.path.join(out, f'{tag}-{s:03d}.edn'), run(mode, s, p_fail=pf, stats=st))
        for k in tot:
            tot[k] = max(tot[k], st[k]) if k == 'maxrounds' else tot[k] + st[k]
    print(f'{tag}: {seeds} histories, {tot["reads"]} read transactions, '
          f'{tot["round2"]} needed a second round ({100.0 * tot["round2"] / max(1, tot["reads"]):.1f}%), '
          f'{tot["round3"]} a third or more; most rounds in one read: {max(1, tot["maxrounds"])}')


if __name__ == '__main__':
    main()
