#!/usr/bin/env python3
"""report.py: a Markdown summary of ablation results (engine.Ablation).

    python3 engine/report.py results/A-ablation.json [results/B-ablation.json ...]

For each: the bounds, the design's states per bound, the rules kept (each
with the property and bound its removal breaks), the rules dropped, the
count by role, and the mutant table.
"""
import json
import sys
from collections import Counter


def fmt_ff(ff):
    if not ff:
        return '-'
    b, p, d, allp = ff
    if p == 'LIMIT':
        return f'undecided ({b}: state limit)'
    return f'{p} on {b} ({d} steps)'


def one(path):
    o = json.load(open(path))
    name = o.get('option', path)
    print(f'## {name}\n')
    if o.get('error'):
        print(f'**Error:** {o["error"]}\n')
    base = o.get('base', {})
    print('Bounds (the design): ' + '; '.join(
        f'{b}: {x["states"]:,} states{"" if x["complete"] else " (limit)"}' for b, x in base.items()))
    vr = o.get('verify_result') or {}
    if vr:
        print('Verify (the smallest model): ' + '; '.join(
            f'{b}: {x["states"]:,} states, {"holds" if not x["fail"] and x["complete"] else ("fails " + ",".join(x["fail"]) if x["fail"] else "limit")}'
            for b, x in vr.items()))
    rows = o.get('rules', [])
    pinned = [r for r in rows if r.get('pinned')]
    kept = [r for r in rows if r['kept'] and not r.get('pinned')]
    dropped = [r for r in rows if not r['kept'] and not r.get('pinned')]
    print(f"\n**{len(kept)} rules needed** of {len(rows) - len(pinned)} written; by role: " +
          ', '.join(f'{k} {v}' for k, v in sorted(Counter(r['role'] for r in kept).items())) + '.\n')
    # The same guard written in several actions of one actor (the leader's
    # healing routine; the controller's decisions; exec) is one check in
    # code: counted once here, beside DEV-10's count of guard conjuncts.
    def actor(act):
        if act.startswith('c_') and act != 'c_expire':
            return 'controller'
        if act in ('exec', 'c_expire'):
            return act
        return 'leader' if act in ('add', 'promote', 'remove', 'surplus', 'dropl') else act
    distinct = {(actor(r['id'].split('.')[0]), r['id'].split('.', 1)[1]) if r['kind'] == 'guard' else r['id']
                for r in kept}
    raft = sum(1 for r in kept if r['role'] == 'raft')
    print(f'Distinct checks (one guard repeated in several actions of one actor counted once): '
          f'**{len(distinct)}**; Raft\'s own guards (role raft: a working leader, one change at a time) '
          f'among the {len(kept)}: {raft}.\n')
    print('| rule | kind | role | removing it breaks |')
    print('|---|---|---|---|')
    for r in kept:
        print(f'| `{r["id"]}` | {r["kind"]} | {r["role"]} | {fmt_ff(r.get("final"))} |')
    if pinned:
        print('\nPinned (bounds and world steps written as rules, never dropped or mutated): ' +
              ', '.join(f'`{r["id"]}`' for r in pinned) + '.')
    if dropped:
        print('\nDropped (no property breaks without them, given the rules kept): ' +
              ', '.join(f'`{r["id"]}`' for r in dropped) + '.')
    muts = o.get('mutants', [])
    if muts:
        c = sum(1 for m in muts if m['caught'])
        eq = sum(1 for m in muts if not m['caught'] and m.get('equivalent'))
        und = sum(1 for m in muts if m.get('undecided'))
        surv = len(muts) - c - eq - und
        ne = len(muts) - eq
        pct = (100.0 * c / ne) if ne else 0
        print(f'\n**Mutants:** {len(muts)}; caught {c}; equivalent {eq}; undecided {und}; survived {surv}. '
              f'Caught of non-equivalent: {c}/{ne} ({pct:.0f}%).\n')
        print('| mutant | kind | result |')
        print('|---|---|---|')
        for m in muts:
            res = fmt_ff(m['caught']) if m['caught'] else ('equivalent' if m.get('equivalent') else
                                                           ('undecided' if m.get('undecided') else 'SURVIVED'))
            print(f'| `{m["rule"]}` | {m["kind"]} | {res} |')
    print()


def main():
    for p in sys.argv[1:]:
        one(p)


if __name__ == '__main__':
    main()
