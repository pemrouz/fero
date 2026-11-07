"""Account for every snapshot (MsgSnap) in one compaction run.

Inputs: the run's node logs (SNAP_SENT / SNAP_APPLIED lines) and the output of
journal_snaps.clj (every MsgSnap sent, received or dropped) and journal_snapcheck.clj
(the follower's next MsgAppResp after each received one).
Each received snapshot is one of:
  restored  - the first receipt of that (follower, index) and the follower logged SNAP_APPLIED for it;
  repeat    - the same (follower, index) arrived again (the leader resent it; raft ignores it);
  behind    - the follower already held that index from appends (raft ignores it: commit >= index,
              or the log term matches and raft only moves its commit forward).
For every receipt, the follower's next accepted MsgAppResp must say Index >= the snapshot index.
Usage: snap_audit.py <run name> <node-logs dir> <snaps.txt> <snapcheck.txt>
"""
import os
import re
import sys
from collections import Counter

name, logs, snaps_f, check_f = sys.argv[1:5]
sent_log = 0
applied = Counter()
for f in sorted(os.listdir(logs)):
    node = f.split('.')[0]
    for line in open(os.path.join(logs, f), encoding='utf-8', errors='replace'):
        if ' SNAP_SENT ' in line:
            sent_log += 1
        m = re.search(r' SNAP_APPLIED idx=(\d+)', line)
        if m:
            applied[(node, int(m.group(1)))] += 1

sent = dropped = 0
for line in open(snaps_f):
    p = line.split()
    if len(p) < 6 or p[2] != '->':
        continue
    sent += 1
    dropped += p[-1] == 'DROPPED'

kinds = Counter()
bad = []
seen = Counter()
for line in open(check_f):
    p = line.split()
    if len(p) < 9 or p[2] != '->':
        continue
    dest, idx, resp = p[3], int(p[5]), p[7]
    seen[(dest, idx)] += 1
    if seen[(dest, idx)] > 1:
        kinds['repeat'] += 1
    elif applied[(dest, idx)]:
        kinds['restored'] += 1
    else:
        kinds['behind'] += 1
    if resp == 'none' or int(resp) < idx:
        bad.append(line.strip())
never_received = [k for k in applied if not seen[k]]
twice_applied = [k for k, c in applied.items() if c > 1]
print(f'{name}: sent {sent} (node logs {sent_log}), dropped by the partition {dropped}, '
      f'received {sent - dropped}: restored {kinds["restored"]}, repeat {kinds["repeat"]}, '
      f'behind {kinds["behind"]}; SNAP_APPLIED {sum(applied.values())}; '
      f'receipts without an accepted MsgAppResp >= index: {len(bad)}; '
      f'applied but never received: {len(never_received)}; applied twice: {len(twice_applied)}')
for b in bad:
    print('   NO-ACK', b)
