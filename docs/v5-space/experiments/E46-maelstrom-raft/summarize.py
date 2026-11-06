"""Summarize one E-46 Maelstrom run as one JSON line.

Reads the run folder that run-one.sh made: maelstrom.out (Jepsen's log), the
store's results.edn and history.edn, the node logs and the pauser log. Prints:
  valid       Maelstrom's verdict (Knossos per key, plus its stats checkers)
  lin_valid   the linearizability checker's verdict alone (:workload :valid?)
  ops         ok / fail / info counts by kind
  elections   distinct terms in which some node became leader, and the max term
  partitions  nemesis partition starts seen in the history
  pauses      SIGSTOP pauses from the pauser log
  hash_check  every node's applied-prefix hash agrees at each logged index
"""
import json
import os
import re
import sys
from collections import defaultdict

(run_dir, name, nodes, read_mode, seed, secs, nemesis, pause, compact, rate, conc,
 code, wall) = sys.argv[1:14]


def read(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return ''


out = read(os.path.join(run_dir, 'maelstrom.out'))
store = os.path.join(run_dir, 'store', 'lin-kv')
runs = sorted(d for d in os.listdir(store)) if os.path.isdir(store) else []
runs = [d for d in runs if d != 'latest' and os.path.isdir(os.path.join(store, d))]
sdir = os.path.join(store, runs[-1]) if runs else ''
results = read(os.path.join(sdir, 'results.edn')) if sdir else ''
history = read(os.path.join(sdir, 'history.edn')) if sdir else ''

verdict = 'unknown'
if 'Everything looks good!' in out:
    verdict = 'valid'
elif 'Analysis invalid!' in out:
    verdict = 'invalid'
elif 'Errors occurred during analysis' in out:
    verdict = 'unknown-errors'

# The last top-level :valid? in results.edn is the whole test's verdict. The
# :workload map holds the linearizability verdict; find it by its key.
m = re.search(r':workload\s*\{:valid\?\s*(true|false|:unknown)', results)
lin_valid = m.group(1) if m else None
m = re.findall(r':valid\?\s*(true|false|:unknown)', results)
top_valid = m[-1] if m else None

# Op counts from the history: completions only.
ops = defaultdict(int)
for t, f in re.findall(r':type :(ok|fail|info),\s*:f :(read|write|cas)', history):
    ops[f'{f}_{t}'] += 1
if not ops:  # Jepsen may print :f before :type
    for f, t in re.findall(r':f :(read|write|cas),[^}]*?:type :(ok|fail|info)', history):
        ops[f'{f}_{t}'] += 1
partitions = len(re.findall(r':f :start-partition', history)) // 2  # :invoke and :info
pause_ops_in_history = len(re.findall(r':f :pause', history))

# Linearizability failures: the keys whose checker said false.
bad_keys = re.findall(r'(\d+)\s*\{:valid\?\s*false', results)

# Node logs: elections and the applied-prefix hash.
terms_led = set()
max_term = 0
hashes = defaultdict(dict)  # idx -> node -> (term, hash)
snap_sent = snap_applied = 0
stats_last = {}
logdir = os.path.join(sdir, 'node-logs') if sdir else ''
for fn in sorted(os.listdir(logdir)) if logdir and os.path.isdir(logdir) else []:
    node = fn.split('.')[0]
    for line in read(os.path.join(logdir, fn)).splitlines():
        mm = re.search(r'ROLE term=(\d+) StateLeader', line)
        if mm:
            terms_led.add(int(mm.group(1)))
        mm = re.search(r'ROLE term=(\d+)', line)
        if mm:
            max_term = max(max_term, int(mm.group(1)))
        mm = re.search(r'APPLIED idx=(\d+) term=(\d+) h=([0-9a-f]+)', line)
        if mm:
            hashes[int(mm.group(1))][node] = mm.group(3)
        mm = re.search(r'SNAP_APPLIED idx=(\d+) term=\d+ keys=\d+ h=([0-9a-f]+)', line)
        if mm:
            hashes[int(mm.group(1))][node] = mm.group(2)
        if 'SNAP_SENT' in line:
            snap_sent += 1
        if 'SNAP_APPLIED' in line:
            snap_applied += 1
        mm = re.search(r'STATS applied=(\d+) term=(\d+) (\{.*\})', line)
        if mm:
            stats_last[node] = json.loads(mm.group(3)) | {'applied': int(mm.group(1))}
compared = sum(1 for v in hashes.values() if len(v) >= 2)
mismatch = [i for i, v in hashes.items() if len(set(v.values())) > 1]
crashes = len(re.findall(r'(?i)RaftPanic|E46: |Error:|Unhandled', ' '.join(
    read(os.path.join(logdir, f)) for f in (os.listdir(logdir) if logdir and os.path.isdir(logdir) else []))))

pauses = re.findall(r' pause (n\d+) (\d+)ms', read(os.path.join(run_dir, 'pauses.log')))
agg = defaultdict(int)
for s in stats_last.values():
    for k, v in s.items():
        if k != 'applied':
            agg[k] += v

print(json.dumps({
    'name': name, 'nodes': int(nodes), 'read': read_mode, 'seed': int(seed), 'secs': int(secs),
    'nemesis': nemesis, 'pause': int(pause), 'compact': int(compact), 'rate': rate, 'conc': conc,
    'exit': int(code), 'wall_s': int(wall),
    'verdict': verdict, 'valid_top': top_valid, 'lin_valid': lin_valid, 'bad_keys': len(bad_keys),
    'ops': dict(sorted(ops.items())),
    'elections': len(terms_led), 'max_term': max_term,
    'partitions': partitions, 'pause_ops_in_history': pause_ops_in_history,
    'pauses': len(pauses), 'paused_ms': sum(int(ms) for _, ms in pauses),
    'hash_points_compared': compared, 'hash_mismatches': len(mismatch),
    'snap_sent': snap_sent, 'snap_applied': snap_applied, 'node_errors': crashes,
    'node_stats': dict(agg), 'store': sdir,
}))
