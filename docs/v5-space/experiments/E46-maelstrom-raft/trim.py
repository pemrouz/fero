"""Copy a trimmed record of each E-46 run into results/runs/<name>/.

Kept per run: Maelstrom's verdict sections of results.edn (stats, availability,
net counts and the per-key linearizability results, cut to 400 lines), the
nemesis lines of the history, the pauser log, and each node's ROLE, SNAP and
STATS lines (the APPLIED hash lines are summarized in summary.jsonl). The full
stores stay in $E46_RUNS. Usage: trim.py <runs dir> <out dir>
"""
import os
import re
import shutil
import sys

runs, out = sys.argv[1], sys.argv[2]
for name in sorted(os.listdir(runs)):
    rdir = os.path.join(runs, name)
    store = os.path.join(rdir, 'store', 'lin-kv')
    if not os.path.isdir(store):
        continue
    ts = sorted(d for d in os.listdir(store) if d != 'latest')
    if not ts:
        continue
    sdir = os.path.join(store, ts[-1])
    odir = os.path.join(out, name)
    os.makedirs(odir, exist_ok=True)
    res = open(os.path.join(sdir, 'results.edn'), encoding='utf-8', errors='replace').read()
    # Drop the :perf section (gnuplot graphs and their stack traces); keep the rest.
    i = res.find(' :timeline {:valid?')
    keep = res[i:] if i >= 0 else res
    lines = keep.splitlines()
    if len(lines) > 400:
        lines = lines[:400] + [f';; ... cut by trim.py: {len(lines) - 400} more lines in the full store']
    with open(os.path.join(odir, 'results-verdict.edn'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    with open(os.path.join(odir, 'nemesis.edn'), 'w') as f:
        for line in open(os.path.join(sdir, 'history.edn'), encoding='utf-8', errors='replace'):
            if ':process :nemesis' in line and ':type :info' in line:
                f.write(line)
    if os.path.exists(os.path.join(rdir, 'pauses.log')):
        shutil.copy(os.path.join(rdir, 'pauses.log'), os.path.join(odir, 'pauses.log'))
    logs = os.path.join(sdir, 'node-logs')
    with open(os.path.join(odir, 'node-events.log'), 'w') as f:
        for fn in sorted(os.listdir(logs)):
            for line in open(os.path.join(logs, fn), encoding='utf-8', errors='replace'):
                if re.search(r' (INIT|ROLE|SNAP_SENT|SNAP_APPLIED|STATS) |Error|RaftPanic', line):
                    f.write(f'{fn[:-4]} {line}')
