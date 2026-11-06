#!/usr/bin/env python3
"""summarize.py: E-38's tables from results/*.jsonl.

E is election.ms (1,000 ms in these runs). "Writable in 2E" means the
longest time with no commit after the fault was at most 2E and writes were
still committing at the end. "Flaps" means more than one election in some
window of 10E, counted from 2E after the fault.
"""
import collections
import gzip
import json
import os
import sys

D = sys.argv[1] if len(sys.argv) > 1 else 'results'
E = 1e6


def load(name):
    p = os.path.join(D, name + '.jsonl')
    if os.path.exists(p):
        return [json.loads(l) for l in open(p) if l.strip()]
    if os.path.exists(p + '.gz'):
        return [json.loads(l) for l in gzip.open(p + '.gz', 'rt') if l.strip()]
    return []


def group(rows, key):
    g = collections.OrderedDict()
    for r in rows:
        g.setdefault(key(r), []).append(r)
    return g


def ms(us):
    return '-' if us < 0 else '%.1f' % (us / 1000)


def named():
    rows = load('named') + load('transfer')
    if not rows:
        return
    print('## Named topologies and leader transfer (PreVote, CheckQuorum, async writes on)\n')
    print('| suite | n | case | seeds | longest gap after fault (E) | writable in 2E | elections after fault (max) | most elections per 10E | p99 before -> after (ms) |')
    print('|---|---|---|---|---|---|---|---|---|')
    for (s, n, name), rs in group(rows, lambda r: (r['Suite'], r['N'], r['Name'])).items():
        print('| %s | %d | %s | %d | %.2f | %d/%d | %d | %d | %s -> %s |' % (
            s, n, name, len(rs), max(r['LongestGapUs'] for r in rs) / E,
            sum(r['WritableIn2E'] for r in rs), len(rs), max(r['LeaderChanges'] for r in rs),
            max(r['MaxChangesPer10E'] for r in rs), ms(max(r['SteadyP99'] for r in rs)), ms(max(r['AfterP99'] for r in rs))))
    print()


def sweep(name, title):
    rows = load(name)
    if not rows:
        return
    print('## %s\n' % title)
    print('| suite | PreVote | CheckQuorum | leader crash | connected majority (star) | runs | writable in 2E | writable later | never writable again | flaps | longest gap max (E) |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    fails = collections.OrderedDict()
    for (s, pv, cq, cr, star), rs in group(rows, lambda r: (r['Suite'].split(' ')[0], r['PreVote'], r['CQ'], r['Crash'], r['StarMajority'])).items():
        w2 = sum(r['WritableIn2E'] for r in rs)
        later = sum((not r['WritableIn2E']) and r['StillWriting'] for r in rs)
        never = sum(not r['StillWriting'] for r in rs)
        fl = sum(r['Flaps'] for r in rs)
        print('| %s | %s | %s | %s | %s | %d | %d | %d | %d | %d | %.2f |' % (
            s, pv, cq, cr, star, len(rs), w2, later, never, fl, max(r['LongestGapUs'] for r in rs) / E))
        if star:
            for r in rs:
                if not r['WritableIn2E'] or r['Flaps']:
                    k = (s, pv, cq, cr, r['Topology'])
                    fails.setdefault(k, []).append(r)
    print()
    if fails:
        print('Runs with a connected majority that missed F-17 (writable in 2E, at most one election per 10E):\n')
        print('| suite | PreVote | CheckQuorum | leader crash | links down | seeds failing | longest gap (E) | elections | still writing |')
        print('|---|---|---|---|---|---|---|---|---|')
        shown = 0
        for (s, pv, cq, cr, topo), rs in fails.items():
            if shown >= 60:
                print('| ... | | | | %d more topologies | | | | |' % (len(fails) - shown))
                break
            shown += 1
            print('| %s | %s | %s | %s | %s | %d | %.2f | %d | %s |' % (
                s, pv, cq, cr, topo, len(rs), max(r['LongestGapUs'] for r in rs) / E,
                max(r['LeaderChanges'] for r in rs), all(r['StillWriting'] for r in rs)))
        print()


def slow():
    rows = load('slow')
    if not rows:
        return
    print('## One node 10x slower (from the fault on; PreVote and CheckQuorum on)\n')
    print('| n | writes | load | slow node | slowed | seeds | leader changed | p99 before (ms) | p99 after (ms) | ratio | longest gap (E) |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for (n, a, name), rs in group(rows, lambda r: (r['N'], r['Async'], r['Name'])).items():
        who, _, kind, rate = name.split(' ')
        b = max(r['SteadyP99'] for r in rs)
        af = max(r['AfterP99'] for r in rs)
        lost = [r['LeaderLostAfter'] for r in rs if r['LeaderLostAfter'] >= 0]
        print('| %d | %s | %s | %s | %s | %d | %s | %s | %s | %s | %.2f |' % (
            n, 'async (leader fsyncs in parallel)' if a else 'sync (fsync before send)', rate, who, kind, len(rs),
            ('%d/%d, after %.1f s' % (len(lost), len(rs), max(lost) / E)) if lost else 'never',
            ms(b), ms(af), ('%.1fx' % (af / b)) if b > 0 and af > 0 else '-', max(r['LongestGapUs'] for r in rs) / E))
    print()


named()
sweep('sweep3', 'Every directed-link topology of 3 nodes (64), without and with a leader crash (PreVote, CheckQuorum on)')
sweep('ablate', 'The same 64 topologies, PreVote and CheckQuorum each on and off')
sweep('sweep5', 'Random directed-link topologies of 5 nodes (150 per seed), without and with a leader crash')
slow()
