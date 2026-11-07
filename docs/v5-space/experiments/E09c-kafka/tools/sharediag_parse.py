#!/usr/bin/env python3
"""Reads the output of tools/sharediag.py (kafka-share-consumer-perf-test with --show-detailed-stats) and prints,
per share run: the wait before each consumer's first record (its first report's fetch.time.ms: the tool prints a
report when the first record arrives), the drain rate after it (all records / (end - median first-record time)),
and the tool's own whole-run rate. Then the medians and ranges over the runs.
Usage: python3 -I sharediag_parse.py results/sharediag.txt [more files]"""
import re, statistics, sys
from datetime import datetime


def ts(s):
    return datetime.strptime(s.strip(), '%Y-%m-%d %H:%M:%S:%f').timestamp()


def runs(path):
    out, cur = [], None
    for line in open(path):
        if line.startswith('# share run'):
            cur = {'name': line.split(':')[0][2:], 'meta': line.split(': ', 1)[1].strip(), 'cons': {}, 'total': None}
            out.append(cur)
        elif line.startswith('#'):
            cur = None
        elif cur is not None and re.match(r'\d{4}-', line):
            f = [x.strip() for x in line.split(',')]
            m = re.search(r'for share consumer (\d+)', f[-1])
            if m:
                cur['cons'].setdefault(int(m.group(1)), []).append(
                    {'start': ts(f[0]), 'end': ts(f[1]), 'n': int(f[5]), 'ms': int(f[6].split()[0])})
            else:
                cur['total'] = {'start': ts(f[0]), 'end': ts(f[1]), 'n': int(f[5]), 'rate': float(f[4]), 'ms': int(f[6])}
    return out


def rng(xs, fmt):
    return '%s (%s-%s)' % (fmt % statistics.median(xs), fmt % min(xs), fmt % max(xs))


for path in sys.argv[1:]:
    print('## %s' % path)
    waits, drains, wholes = [], [], []
    for r in runs(path):
        t = r['total']
        if not t or not r['cons']:
            print('%s: incomplete' % r['name']); continue
        first = [c[0] for c in r['cons'].values()]
        wait = statistics.median(x['ms'] for x in first) / 1000
        t0 = statistics.median(x['end'] for x in first)
        drain = t['n'] / (t['end'] - t0)
        waits.append(wait); drains.append(drain); wholes.append(t['rate'])
        print('%s: %d consumers, wait before first record %.2f s (%s), then %d records in %.2f s = %d records/s; '
              'whole run %d records/s (tool), %s' % (r['name'], len(first), wait,
              ', '.join('%.2f' % (x['ms'] / 1000) for x in first), t['n'], t['end'] - t0, drain, t['rate'], r['meta']))
    if waits:
        print('median (range) over %d runs: wait %s s; drain after the wait %s records/s; whole run %s records/s'
              % (len(waits), rng(waits, '%.2f'), rng(drains, '%.0f'), rng(wholes, '%.0f')))
