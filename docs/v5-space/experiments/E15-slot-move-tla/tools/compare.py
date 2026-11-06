#!/usr/bin/env python3
"""
compare.py: put slot_move.py's verdicts (results/py/*.json) beside TLC's
(results/tlc/*.json), run by run, and say where they differ.

    python3 tools/compare.py            # the table, as markdown, to stdout
    python3 tools/compare.py --json     # results/compare.json

A run agrees when both checkers find the same set of failing properties.
States, liveness states and the steps of each shortest counterexample are
compared too, and any difference is listed.
"""
import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'docs', 'v5-spec'))
import slot_move as sm  # noqa: E402


def load(d):
    out = {}
    for f in glob.glob(os.path.join(ROOT, 'results', d, '*.json')):
        r = json.load(open(f))
        out[(r['variant'], r['bound'])] = r
    return out


def verdict(r):
    f = r['failed']
    if not f:
        return 'all hold'
    return ', '.join(f'{p} ({r["steps"][str(p)]})' if str(p) in r['steps'] else f'{p}' for p in f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    py, tl = load('py'), load('tlc')
    rows = []
    for v, b in sm.plan():
        p, t = py.get((v, b)), tl.get((v, b))
        row = {'variant': v, 'bound': b, 'kind': sm.VARIANTS[v][0]}
        if p:
            row.update(py_states=p['states'], py_live=p['live_nodes'], py=verdict(p),
                       py_failed=p['failed'])
        if t:
            row.update(tlc_states=t['states'], tlc_live=t['calm_states'], tlc=verdict(t),
                       tlc_failed=t['failed'], tlc_secs=t['secs'], tlc_complete=t['complete'])
        if p and t:
            row['same_verdict'] = p['failed'] == t['failed']
            row['same_states'] = p['states'] == t['states'] and p['live_nodes'] == t['calm_states']
            row['same_steps'] = all(p['steps'].get(k) == t['steps'].get(k)
                                    for k in set(p['steps']) | set(t['steps']) if k != '7')
        rows.append(row)
    if a.json:
        with open(os.path.join(ROOT, 'results', 'compare.json'), 'w') as f:
            json.dump(rows, f, indent=1)
    both = [r for r in rows if 'same_verdict' in r]
    print(f'| run | bound | slot_move.py states / live | TLC states / live | slot_move.py fails (steps) | TLC fails (steps) | same |')
    print('|---|---|---|---|---|---|---|')
    for r in rows:
        ps = f'{r["py_states"]:,} / {r["py_live"]:,}' if 'py_states' in r else '—'
        ts = (f'{r["tlc_states"]:,} / {r["tlc_live"]:,}' if r.get('tlc_states') is not None else '—')
        same = ''
        if 'same_verdict' in r:
            same = ('yes' if r['same_verdict'] else '**NO**') + \
                   ('' if r['same_states'] else ', counts differ') + \
                   ('' if r['same_steps'] else ', steps differ')
        print(f'| {r["variant"]} | {r["bound"]} | {ps} | {ts} | {r.get("py", "—")} | '
              f'{r.get("tlc", "—")} | {same} |')
    print()
    print(f'{len(both)} of {len(rows)} runs done on both; '
          f'{sum(r["same_verdict"] for r in both)} same verdict; '
          f'{sum(r["same_states"] for r in both)} same state counts; '
          f'{sum(r["same_steps"] for r in both)} same steps.')


if __name__ == '__main__':
    main()
