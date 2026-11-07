"""Show how Maelstrom's lin-kv spread one run's operations over keys, client threads and nodes.

Jepsen splits the client threads into groups of 2n per key (independent/concurrent-generator),
and inside a group gen/reserve gives reads to threads 0..n-1 by their absolute number. So with
--concurrency 4n the second group (threads 2n..4n-1) never reads. Thread t talks to node t mod n
(jepsen/generator/interpreter.clj). A process that crashes (an :info result) comes back as
process p + concurrency on the same thread.
Prints, per key: ops, time span, the threads that touched it, and reads ok; then reads and
writes per thread.
Usage: keys_by_group.py <run name> <history.edn> <nodes> <concurrency>
"""
import re
import sys
from collections import Counter, defaultdict

name, path, n, conc = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
keys = defaultdict(lambda: {'ops': 0, 't0': None, 't1': 0.0, 'threads': set(), 'reads_ok': 0})
reads, writes = Counter(), Counter()
for line in open(path, encoding='utf-8', errors='replace'):
    if ':process :nemesis' in line:
        continue
    m = re.search(r':value \[(\d+) ', line)
    if not m:
        continue
    k = int(m.group(1))
    t = int(re.search(r':time (\d+)', line).group(1)) / 1e9
    th = int(re.search(r':process (\d+)', line).group(1)) % conc
    f = re.search(r':f :(\w+)', line).group(1)
    r = keys[k]
    r['ops'] += 1
    r['t0'] = t if r['t0'] is None else r['t0']
    r['t1'] = t
    r['threads'].add(th)
    if f == 'read' and ':type :ok' in line:
        r['reads_ok'] += 1
    if ':type :invoke' in line:
        (reads if f == 'read' else writes)[th] += 1
print(f'{name}: {n} nodes, concurrency {conc} (groups of {2 * n} threads per key; reads only on threads 0..{n - 1})')
for k in sorted(keys):
    r = keys[k]
    th = sorted(r['threads'])
    group = sorted({t // (2 * n) for t in th})
    print(f"  key {k}: {r['ops']} ops, {r['t0']:.1f}-{r['t1']:.1f} s, thread group {group}, "
          f"threads {th[0]}..{th[-1]}, reads ok {r['reads_ok']}")
print('  read invocations by thread (node = thread mod n): ' +
      ', '.join(f't{t}/n{t % n}: {c}' for t, c in sorted(reads.items())))
print('  write+cas invocations by thread: ' + ', '.join(f't{t}: {c}' for t, c in sorted(writes.items())))
