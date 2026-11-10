#!/usr/bin/env python3
"""The decision matrix over every judged row (the study's 20 and the closure pass's judged rows): the winner by the
judging rule under each mix of the user's open choices. Run from docs/v5-space:

  python3 tools/closure_matrix.py            prints the matrix and writes judging/closure/results/matrix.md
"""
import itertools, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import closure as C


def standings(M, rows, scenario, choices):
    res = {}
    for r, v in rows.items():
        t = C.tally1(M.cells(v, r), scenario, choices)
        s = M.score(v, r)
        res[r] = {'fails': t['fails'], 'gap': t['gap'], 'novel': s['novel'], 'S': len(t['s_met']), 'pairs': s['pairs'], 'open': t['open']}
    return res


def winners(res, open_first=False):
    inn = {r: x for r, x in res.items() if not x['fails']}
    if not inn:
        key = lambda r: (len(set(res[r]['fails'])), round(res[r]['gap'], 6))
        order = sorted(res, key=key)
        return 'all out; rule 2: ' + ', '.join(r for r in order if key(r) == key(order[0])), []
    if open_first:
        lo = min(x['open'] for x in inn.values())
        inn = {r: x for r, x in inn.items() if x['open'] == lo}
    ub = C.unbeaten({r: (x['novel'], x['S'], x['pairs']) for r, x in inn.items()})
    return ', '.join(ub), ub


def main():
    M = C.Model()
    rows = C.all_rows(M.ax)
    out = ['# Decision matrix over every judged row', '',
           'Built by `python3 tools/closure_matrix.py` from the %d judged rows (the study\'s 20 and the %d the closure pass judged, [hybrids/cards.json](../hybrids/cards.json)). Each line is the winner by the judging rule under one mix of the user\'s open choices. "Open MUSTs first" is not the rule as written: it ranks only the rows with the fewest open MUSTs, then applies rule 3, to show what the rule\'s blind spot decides.' % (len(rows), len(rows) - 20), '',
           '| Reading of the requirements | PERF-01: JetStream\'s default row accepted as a loss | DATA-01: data\'s own code must fold on servers | Rule 3 as written | Rule 3, open MUSTs first |', '|---|---|---|---|---|']
    for sc in ('restated', 'worded'):
        for perf, data in itertools.product((False, True), (False, True)):
            ch = tuple(x for x, on in (('PERF-01 losses', perf), ('DATA-01 reading', data)) if on)
            res = standings(M, rows, sc, ch)
            w, ub = winners(res)
            w2, ub2 = winners(res, True)
            fmt = lambda u: '; '.join('%s (%d novel, %d SHOULDs, %d pairs, %d open)' % (r, res[r]['novel'], res[r]['S'], res[r]['pairs'], res[r]['open']) for r in u) if u else None
            out.append('| %s | %s | %s | %s | %s |' % ('AMENDMENTS 1.3 restated' if sc == 'restated' else 'as worded', 'yes' if perf else 'no', 'yes' if data else 'no (DATA-09\'s test path)',
                       fmt(ub) or w, fmt(ub2) or w2))
    txt = '\n'.join(out) + '\n'
    os.makedirs('judging/closure/results', exist_ok=True)
    open('judging/closure/results/matrix.md', 'w').write(txt)
    print(txt)


if __name__ == '__main__':
    main()
