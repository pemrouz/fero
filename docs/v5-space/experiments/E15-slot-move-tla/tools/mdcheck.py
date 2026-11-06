#!/usr/bin/env python3
"""
mdcheck.py: does slot_move.py, re-run here, still give the numbers printed in
docs/v5-spec/slot_move.md? And what does TLC say for the same rows?

Two tables:
1. The runs slot_move.md gives in full (design, fixed, the readings): states,
   liveness states, failing properties and steps, against this re-run.
2. The 18 mutants: the properties slot_move.md says catch each one (its
   mutant table, which stopped a run past 1,000,000 states once something
   failed), against the union of failing properties over the same bounds
   in the full runs here, by slot_move.py and by TLC.
The numbers below are copied from slot_move.md (second round).
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# (variant, bound): (states, failing {prop: steps}); live states for fixed
MD = {
    ('design', 'move'): (47754, {1: 20, 9: 15}), ('design', 'moves'): (530385, {1: 20, 9: 15}),
    ('design', 'write'): (1251562, {1: 20, 6: 26, 9: 15}), ('design', 'dedup'): (327308, {}),
    ('design', 'deep'): (286188, {}),
    ('fixed', 'move'): (47457, {}), ('fixed', 'moves'): (898312, {}), ('fixed', 'write'): (1107824, {}),
    ('fixed', 'dedup'): (351262, {}), ('fixed', 'deep'): (308274, {}), ('fixed', 'three'): (7510764, {}),
    ('fixed-but-recovery-resumes', 'move'): (71784, {9: 19}),
    ('fixed-but-recovery-resumes', 'moves'): (1175418, {1: 32, 9: 19}),
    ('fixed-but-recovery-resumes', 'write'): (1835310, {9: 19}),
    ('fixed-but-table-by-writer', 'move'): (24474, {9: 16}),
    ('fixed-but-table-by-writer', 'moves'): (309780, {9: 16}),
    ('fixed-but-table-by-writer', 'write'): (579576, {9: 16}),
    ('fixed-but-table-unversioned', 'move'): (31713, {1: 19, 9: 15}),
    ('fixed-but-table-unversioned', 'moves'): (598753, {1: 19, 9: 15}),
    ('fixed-but-table-unversioned', 'write'): (746372, {1: 19, 9: 15}),
    ('fixed-but-recovery-reads-table-only', 'move'): (48981, {9: 15}),
    ('fixed-but-recovery-reads-table-only', 'moves'): (948381, {9: 15}),
    ('fixed-but-recovery-reads-table-only', 'write'): (1158978, {9: 15}),
    ('fixed-but-fence-ignores-incarnation', 'move'): (55197, {1: 23, 9: 21}),
    ('fixed-but-fence-ignores-incarnation', 'moves'): (1088268, {1: 23, 9: 21}),
    ('fixed-but-fence-ignores-incarnation', 'write'): (1318048, {1: 23, 9: 21}),
    ('fixed-but-unfence-at-old-epoch', 'move'): (45837, {}),
    ('fixed-but-unfence-at-old-epoch', 'moves'): (869816, {}),
    ('fixed-but-unfence-at-old-epoch', 'write'): (1069440, {6: 25}),
}
MD_LIVE_FIXED = {'move': 205, 'moves': 3694, 'write': 1725, 'dedup': 5694, 'deep': 16923, 'three': 17819}

# slot_move.md's mutant table: the properties that catch each mutant
MD_MUT = {
    'table-after-open': {9}, 'recovery-trusts-table': set(), 'abort-keeps-table': {1, 9},
    'a-unfences-alone': {1, 9}, 'no-exporting': {1, 7, 9},
    'ready-before-copy-commits': {7}, 'fence-without-ready': {7},
    'stream-before-fence-commits': {1, 2, 3, 4, 5, 6, 7, 9}, 'b-serves-before-open-commits': set(),
    'b-serves-before-open': {2, 4, 5, 6}, 'fence-N-from-committed': {2, 3, 4, 6, 7},
    'stamp-from-committed': {3, 4, 6}, 'no-carried-sequence': {2, 6}, 'no-carried-outcomes': {5},
    'no-max-merge': {5}, 'unfence-on-appended-abort': {1, 7, 9}, 'b-aborts-after-open': {4},
    'guards-on-committed': {1, 2, 4, 5, 6, 9},
}


def load(d):
    out = {}
    for f in glob.glob(os.path.join(ROOT, 'results', d, '*.json')):
        r = json.load(open(f))
        out[(r['variant'], r['bound'])] = r
    return out


def fmt(fails):
    return ', '.join(f'{p} ({s})' if s is not None else str(p) for p, s in sorted(fails.items())) or 'all hold'


def main():
    py, tl = load('py'), load('tlc')
    print('| run | bound | slot_move.md | slot_move.py here | TLC here | same |')
    print('|---|---|---|---|---|---|')
    same = 0
    for (v, b), (n, f) in MD.items():
        p, t = py.get((v, b)), tl.get((v, b))
        md = f'{n:,}: {fmt(f)}'
        ph = f'{p["states"]:,}: {fmt({int(k): s for k, s in p["steps"].items()})}' if p else '—'
        th = (f'{t["states"]:,}: ' + fmt({int(k): t["steps"].get(k) for k in map(str, t["failed"])}) if t else '—')
        ok = p and t and p['states'] == n == t['states'] and \
            {int(k): s for k, s in p['steps'].items()} == f and \
            sorted(t['failed']) == sorted(f) and all(t['steps'].get(str(k)) == s for k, s in f.items())
        if b in MD_LIVE_FIXED and v == 'fixed' and p and t:
            ok = ok and p['live_nodes'] == MD_LIVE_FIXED[b] == t['calm_states']
        same += bool(ok)
        print(f'| {v} | {b} | {md} | {ph} | {th} | {"yes" if ok else "no"} |')
    print(f'\n{same} of {len(MD)} rows the same in all three.\n')
    print('| mutant | slot_move.md: caught by | slot_move.py here, full runs | TLC here | note |')
    print('|---|---|---|---|---|')
    import slot_move_plan  # noqa
    for m, md in MD_MUT.items():
        bounds = [b for v, b in slot_move_plan.plan() if v == m]
        pf = set().union(*[set(py[(m, b)]['failed']) for b in bounds if (m, b) in py]) if bounds else set()
        tf = set().union(*[set(tl[(m, b)]['failed']) for b in bounds if (m, b) in tl]) if bounds else set()
        done_p = all((m, b) in py for b in bounds)
        done_t = all((m, b) in tl for b in bounds)
        note = []
        if done_p and pf != md:
            note.append('more than slot_move.md: ' + ', '.join(map(str, sorted(pf - md)))
                        if pf >= md else 'DIFFERENT')
        if done_p and done_t and pf != tf:
            note.append('TLC and slot_move.py DIFFER')
        print(f'| {m} | {", ".join(map(str, sorted(md))) or "not caught"} | '
              f'{", ".join(map(str, sorted(pf))) if done_p else "(not all run)"} | '
              f'{", ".join(map(str, sorted(tf))) if done_t else "(not all run)"} | {"; ".join(note)} |')


if __name__ == '__main__':
    sys.path.insert(0, os.path.abspath(os.path.join(ROOT, '..', '..', '..', 'v5-spec')))
    import slot_move as slot_move_plan  # noqa: E402
    sys.modules['slot_move_plan'] = slot_move_plan
    main()
