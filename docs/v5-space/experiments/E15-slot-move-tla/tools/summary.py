#!/usr/bin/env python3
"""
summary.py: the README's summary tables, from results/ only.

    python3 tools/summary.py > results/summary.md

1. The plan by kind of variant: runs, runs done on both checkers, and how
   many agree on verdict, state counts and steps.
2. The 18 mutants of slot_move.md: per mutant, the bounds run on both, the
   properties each checker finds failing (union over those bounds), and
   whether the two agree run by run.
3. DEV-10's mechanical mutants (results/mutants.json): the tally by kind and
   verdict, the catch rate, and the rule count.
"""
import collections
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


def same(p, t):
    v = p['failed'] == t['failed']
    s = p['states'] == t['states'] and p['live_nodes'] == t['calm_states']
    k = all(p['steps'].get(x) == t['steps'].get(x) for x in set(p['steps']) | set(t['steps']) if x != '7')
    return v, s, k


def plan_table(py, tl):
    print('| Variants | Runs in the plan | Done on both | Same verdict | Same states | Same steps |')
    print('|---|---|---|---|---|---|')
    tot = collections.Counter()
    for kind in ('design', 'reading', 'mutant'):
        runs = [(v, b) for v, b in sm.plan() if sm.VARIANTS[v][0] == kind]
        both = [j for j in runs if j in py and j in tl]
        c = collections.Counter()
        for j in both:
            v, s, k = same(py[j], tl[j])
            c['v'] += v
            c['s'] += s
            c['k'] += k
        name = {'design': '`design`, `fixed`', 'reading': 'the six readings', 'mutant': 'the 18 mutants'}[kind]
        print(f'| {name} | {len(runs)} | {len(both)} | {c["v"]} | {c["s"]} | {c["k"]} |')
        tot.update({'runs': len(runs), 'both': len(both), 'v': c['v'], 's': c['s'], 'k': c['k']})
    print(f'| **all** | **{tot["runs"]}** | **{tot["both"]}** | **{tot["v"]}** | **{tot["s"]}** | **{tot["k"]}** |')
    missing = [(v, b) for v, b in sm.plan() if not ((v, b) in py and (v, b) in tl)]
    if missing:
        print()
        print('Not run on both: ' + '; '.join(
            f'`{v} {b}` ({"slot_move.py only" if (v, b) in py else "neither"})' for v, b in missing) + '.')


def mut18(py, tl):
    print('| Mutant | Bounds run on both | slot_move.py: fails | TLC: fails | Same |')
    print('|---|---|---|---|---|')
    for v, (kind, _desc, _fixes) in sm.VARIANTS.items():
        if kind != 'mutant':
            continue
        bounds = [b for vv, b in sm.plan() if vv == v]
        both = [b for b in bounds if (v, b) in py and (v, b) in tl]
        fp = sorted(set().union(*[py[(v, b)]['failed'] for b in both])) if both else []
        ft = sorted(set().union(*[tl[(v, b)]['failed'] for b in both])) if both else []
        ok = all(same(py[(v, b)], tl[(v, b)]) == (True, True, True) for b in both)
        only_py = [b for b in bounds if (v, b) in py and (v, b) not in tl]
        note = f' (and {", ".join(only_py)} in slot_move.py only)' if only_py else ''
        print(f'| `{v}` | {", ".join(both)}{note} | {", ".join(map(str, fp)) or "none"} | '
              f'{", ".join(map(str, ft)) or "none"} | {"yes" if ok else "**no**"} |')


def dev10():
    f = os.path.join(ROOT, 'results', 'mutants.json')
    if not os.path.exists(f):
        print('(no mechanical mutants run yet)')
        return
    res = json.load(open(f))
    sys.path.insert(0, HERE)
    import mutants
    made = mutants.make(open(mutants.SRC).read().split('\n'))
    kinds = collections.Counter(m[0] for m in made)
    tally = collections.defaultdict(collections.Counter)
    for r in res.values():
        tally[r['kind']][r['verdict']] += 1
    verdicts = ['caught', 'ill-formed', 'unbounded', 'survived', 'equivalent']
    print('| Kind | Made | Run | ' + ' | '.join(verdicts) + ' |')
    print('|---|---|---|' + '---|' * len(verdicts))
    for k, name in (('G', 'G: drop a guard conjunct'), ('C', 'C: flip a comparison'), ('U', 'U: drop a state update')):
        t = tally[k]
        print(f'| {name} | {kinds[k]} | {sum(t.values())} | ' + ' | '.join(str(t[v]) for v in verdicts) + ' |')
    allc = collections.Counter()
    for t in tally.values():
        allc.update(t)
    print(f'| **all** | **{len(made)}** | **{sum(allc.values())}** | ' +
          ' | '.join(f'**{allc[v]}**' for v in verdicts) + ' |')
    print()
    n = sum(allc.values())
    eq, ill, c, ub = allc['equivalent'], allc['ill-formed'], allc['caught'], allc['unbounded']
    if n:
        print(f'- caught / run: {c}/{n} = {100 * c / n:.0f}%')
        print(f'- caught / (run - equivalent): {c}/{n - eq} = {100 * c / max(1, n - eq):.0f}%')
        print(f'- (caught + ill-formed + unbounded) / (run - equivalent): {c + ill + ub}/{n - eq} = '
              f'{100 * (c + ill + ub) / max(1, n - eq):.0f}%')
    rules = sum(1 for r in res.values() if r['kind'] in 'GU' and r['verdict'] == 'caught')
    print(f'- rules (DEV-10 (c): G and U mutants whose removal a checker catches): {rules}')
    by = collections.Counter(r.get('by', '').split(':')[0] for r in res.values() if r['verdict'] == 'caught')
    print('- caught on: ' + ', '.join(f'{b} {k}' for b, k in sorted(by.items())))
    props = collections.Counter(r.get('by', '').split(': ')[-1] for r in res.values() if r['verdict'] == 'caught')
    print('- caught by: ' + ', '.join(f'{p} {k}' for p, k in sorted(props.items())))
    bounds_tried = collections.Counter(','.join(b for b in r['runs'] if not b.endswith('-live'))
                                       for r in res.values() if r['verdict'] in ('survived', 'equivalent'))
    print('- the uncaught, by the bounds they ran on: ' +
          '; '.join(f'{b}: {k}' for b, k in sorted(bounds_tried.items())))


def main():
    py, tl = load('py'), load('tlc')
    print('## The plan\n')
    plan_table(py, tl)
    print('\n## The 18 mutants\n')
    mut18(py, tl)
    print('\n## DEV-10 mechanical mutants\n')
    dev10()


if __name__ == '__main__':
    main()
