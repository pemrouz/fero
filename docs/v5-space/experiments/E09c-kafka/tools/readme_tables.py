#!/usr/bin/env python3
"""Compact README tables for E-09c (Kafka) and E-09d (Redpanda), from both runs.jsonl files, in one layout.
Medians of the runs, range in brackets. Usage: python3 -I readme_tables.py > some.md"""
import json, os, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = [HERE + '/../results/runs.jsonl', HERE + '/../../E09d-redpanda/results/runs.jsonl']
rows = []
for f in FILES:
    if os.path.exists(f):
        rows += [json.loads(l) for l in open(f)]
G = {}
for r in rows:
    G.setdefault((r['system'], r['setup'], r['test']), []).append(r)
SETUPS = [('kafka', 'default'), ('kafka', 'flush1'), ('redpanda', 'fsync'), ('redpanda', 'wcache')]
LABEL = {('kafka', 'default'): 'Kafka `default` (no fsync)', ('kafka', 'flush1'): 'Kafka `flush1` (fsync, matched)',
         ('redpanda', 'fsync'): 'Redpanda `fsync` (its default, matched)', ('redpanda', 'wcache'): 'Redpanda `wcache` (write caching)'}


def m(xs, d=0, scale=1.0):
    xs = [x * scale for x in xs if isinstance(x, (int, float))]
    if not xs:
        return '-'
    f = '{:,.%df}' % d
    md = statistics.median(xs)
    if len(xs) == 1:
        return f.format(md)
    return '%s (%s-%s)' % (f.format(md), f.format(min(xs)), f.format(max(xs)))


def st(r):
    return r.get('steady') or r.get('total') or {}


out = []
out += ['**Most throughput** (PERF-05/06 "max MB/s"): the producer at full speed, steady state after the warm-up records.', '',
        '| system and setup | settings | records/s | MB/s | producer p50 ms | producer p99 ms | broker cores | client cores | other cores | broker µs CPU per record |',
        '|---|---|---|---|---|---|---|---|---|---|']
for s in SETUPS:
    for t, name in (('max-omb', "OMB's (1 MiB batches, linger 1 ms)"), ('max-default', "producer defaults (16 KiB, linger 5 ms)")):
        rs = G.get(s + (t,))
        if not rs:
            continue
        out.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            LABEL[s], name, m([st(r).get('rec_s') for r in rs]), m([st(r).get('mb_s') for r in rs], 1),
            m([st(r).get('p50') for r in rs]), m([st(r).get('p99') for r in rs]),
            m([r.get('server_cores') for r in rs], 2), m([r.get('client_cores') for r in rs], 2),
            m([r.get('other_cores') for r in rs], 2),
            m([r['server_cores'] / st(r)['rec_s'] * 1e6 for r in rs if st(r).get('rec_s')], 1)))
out += ['', '**End-to-end latency under load** (PERF-05/06 "p99 at half of the max rate"): OMB\'s latency settings (128 KiB batches, linger 1 ms); e2e = consumer receive time minus the producer\'s CreateTime, 1 ms resolution.', '',
        '| system and setup | offered records/s | achieved records/s | e2e p50 ms | e2e p99 ms | e2e p99.9 ms | e2e max ms | producer p99 ms | broker cores | other cores |',
        '|---|---|---|---|---|---|---|---|---|---|']
for s in SETUPS:
    for t in ('half', 'rate50k'):
        rs = G.get(s + (t,))
        if not rs:
            continue
        e = [r.get('e2e', {}) for r in rs]
        out.append('| %s | %s%s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            LABEL[s], m([r.get('offered_rec_s') for r in rs]), ' (half)' if t == 'half' else '',
            m([st(r).get('rec_s') for r in rs]), m([x.get('p50') for x in e]), m([x.get('p99') for x in e]),
            m([x.get('p999') for x in e]), m([x.get('max') for x in e]), m([st(r).get('p99') for r in rs]),
            m([r.get('server_cores') for r in rs], 2), m([r.get('other_cores') for r in rs], 2)))
out += ['', '**One record at a time.** `ack1`: AckProbe, one record in flight, send to ack, µs timer (shown in ms). `e2e1`: `kafka-e2e-latency`, send, ack and consume one record, whole ms rounded down.', '',
        '| system and setup | ack1 acks/s | ack1 p50 ms | ack1 p90 ms | ack1 p99 ms | ack1 p99.9 ms | e2e1 p50 ms | e2e1 p99 ms | e2e1 p99.9 ms | e2e1 avg ms |',
        '|---|---|---|---|---|---|---|---|---|---|']
for s in SETUPS:
    a, e = G.get(s + ('ack1',), []), G.get(s + ('e2e1',), [])
    if not a and not e:
        continue
    out.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
        LABEL[s], m([r.get('rate') for r in a]), m([r.get('p50') for r in a], 3, 1e-3), m([r.get('p90') for r in a], 3, 1e-3),
        m([r.get('p99') for r in a], 3, 1e-3), m([r.get('p999') for r in a], 2, 1e-3),
        m([r.get('p50') for r in e]), m([r.get('p99') for r in e]), m([r.get('p999') for r in e]), m([r.get('avg_ms') for r in e], 2)))
out += ['', '**Consumers.** `consume`: one classic consumer reads back `max-default`\'s records (whole run includes about 1 s of group join; "fetch" leaves it out). `share-4c`: 4 consumers in one share group (Kafka\'s queues) read the same records.', '',
        '| system and setup | records | consume records/s (whole run) | consume fetch records/s | share-4c records/s (4 consumers) | share-4c broker cores |',
        '|---|---|---|---|---|---|']
for s in SETUPS:
    c, sh = G.get(s + ('consume',), []), G.get(s + ('share-4c',), [])
    if not c:
        continue
    shv = 'not supported (UNSUPPORTED on every share-group API)' if sh and all(r.get('unsupported') for r in sh) else m([r.get('nMsg.sec') for r in sh])
    out.append('| %s | %s | %s | %s | %s | %s |' % (
        LABEL[s], m([r.get('data.consumed.in.nMsg') for r in c]), m([r.get('nMsg.sec') for r in c]), m([r.get('fetch.nMsg.sec') for r in c]),
        shv, m([r.get('server_cores') for r in sh if not r.get('unsupported')], 2)))
print('\n'.join(out))
