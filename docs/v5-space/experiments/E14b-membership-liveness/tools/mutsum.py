#!/usr/bin/env python3
"""mutsum.py: the README's mutant summary, from results/mutants-exhaustive.json.

  python3 tools/mutsum.py     # prints one row per mutant and the counts
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import mutex as X  # noqa: E402


def main():
    db = json.load(open(os.path.join(C.RESULTS, 'mutants-exhaustive.json')))
    design = db.get('design', {})
    lines, muts = X.M.mutants()
    rows, caught, notcaught, notrun = [], 0, 0, 0
    for name, k, new, old in muts:
        r = db.get(name)
        rule = old.split('\\*')[0].strip().replace('|', '\\|')
        if not r:
            rows.append('| %s | `%s` | not run | |' % (name, rule))
            notrun += 1
            continue
        how = [(s, X.caught_by(x, design.get(s, {}))) for s, x in r.items() if not x.get('skipped')]
        how = [(s, h) for s, h in how if h]
        ran = [s for s, x in r.items() if X.done_row(x) and not x.get('skipped')]
        unfinished = [s for s in ('m3', 'm2', 'm2p', 'm3c') if s not in ran]
        if how:
            caught += 1
            s, h = how[0]
            rows.append('| %s | `%s` | **caught** | %s: %s; %s states explored |' % (
                name, rule, s, h, '{:,}'.format(r[s]['distinct'])))
        else:
            notcaught += 1
            rows.append('| %s | `%s` | not caught | on %s%s |' % (
                name, rule, ', '.join(ran), ('; not run on ' + ', '.join(unfinished)) if unfinished else ''))
    print('| mutant | rule line | verdict | where |')
    print('|---|---|---|---|')
    print('\n'.join(rows))
    print('\n%d mutants: %d caught, %d not caught, %d not run' % (len(muts), caught, notcaught, notrun))


if __name__ == '__main__':
    main()
