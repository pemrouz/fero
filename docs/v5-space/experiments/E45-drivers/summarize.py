#!/usr/bin/env python3
"""summarize.py: the tool's own last lines from each results/*.txt, plus the gateway's counters.
   python3 -I summarize.py > results/summary.md
Every number here is the E-22 SIMULATOR's behind a gateway, never fero's."""
import glob, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
KEEP = [
    r'^====== .* ======', r'throughput summary', r'^\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s*$',
    r'stats: ', r'aggregated stats', r'Actual Msgs/Sec', r'Median Latency', r'Maximum Latency',
    r'^## ', r'Requests/sec', r'99% in', r'records sent', r'^\d{4}-\d\d-\d\d .*, [0-9.]+, ', r'Avg latency', r'Percentiles',
    r'^\{"tool"', r'^(pipelined|chained)', r'Messages: ', r'Created topic', r'^Topic: ', r'tool exit code', r'^summary \(', r'^ok: tsc', r'error TS',
]
out = []
for f in sorted(glob.glob(os.path.join(HERE, 'results', '*.txt'))):
    name = os.path.basename(f)[:-4]
    lines = open(f, errors='replace').read().splitlines()
    head = [l for l in lines[:3] if l.startswith('# ')]
    keep = [l.rstrip() for l in lines if any(re.search(p, l) for p in KEEP)]
    keep = [re.sub(r'(ops\{)', r'\n    \1', l) if l.startswith('summary') else l for l in keep]
    out.append('**%s**\n```\n%s\n```' % (name, '\n'.join(head + keep)))
print('\n\n'.join(out))
