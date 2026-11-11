#!/usr/bin/env python3
"""Build judging/closure/hybrids/cards.json from the closure referees' settled files (hybrids/<FAMILY>.settled.json).

Each row the closure judges settled gets a full card: every cell predicted from the judged rows, with the cells
the closure judges ruled on (unsupported cells and upheld crossings) put in their place, and its mechanisms as
the conditions give them plus the referee's additions and drops. Run from docs/v5-space, BEFORE the cards file
exists or after deleting it (the prediction must not already count the rows it builds):

  python3 tools/closure_cards.py
"""
import json, os, shlex, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import closure as C

CL = 'judging/closure'
OUT = CL + '/hybrids/cards.json'
NAMES = {'A1': 'MIN-P+m', 'A2': 'COMP2', 'A3': 'COMP2 V=full', 'A4': 'COMP+par C=cent V=full', 'A5': 'MIN-P+par',
         'A6': 'MIN-P+par V=full', 'A7': 'MIN-P+par C=cent V=full', 'A8': 'SRV V=full Y=fwd',
         'B1': 'TiKV-TS', 'B2': 'TiKV-persisted', 'B3': 'PD+fix'}


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    M = C.Model()
    rows = {}
    for fam in ('A', 'B'):
        d = json.load(open('%s/hybrids/%s.settled.json' % (CL, fam)))
        for rid, r in d['rows'].items():
            args = shlex.split(r['card'])
            changes, base = (args + ['COMP'])[:2] if len(args) >= 1 else ('', 'COMP')
            if base in C.SEEDS:
                b0, ch = C.SEEDS[base]
                vec = dict(M.ax['rows'][b0]); vec.update(ch)
            else:
                vec = dict(M.ax['rows'][base])
            for kv in changes.split(','):
                if kv.strip():
                    a, t = kv.split('=', 1)
                    vec[a.strip()] = t.strip()
            judged = {(c['req'], c['part']): c for c in r['cells']}
            cells = []
            for c, p in zip(M.cells(vec), M.parts):
                i, rule = M.cell(p, vec)
                k = (c['req'], c['part'])
                if k in judged:
                    j = judged[k]
                    cell = {f: j.get(f) for f in ('v', 'alt', 'depends_on', 'gap', 'proof', 'basis', 'ev', 'why', 'j1', 'j2', 'by', 'kind')}
                    cell['source'] = 'closure judges, %s.settled.json' % fam
                else:
                    cell = {f: c.get(f) for f in ('v', 'alt', 'depends_on', 'gap')}
                    cell.update({'basis': 'predicted', 'why': (rule or {}).get('basis', ''), 'support': c['support'],
                                 'source': 'predicted from the judged rows (rule %s)' % c['rule']})
                cell = {k2: v for k2, v in cell.items() if v is not None}
                cell.update({'req': c['req'], 'part': c['part'], 'group': p['group'], 'row': NAMES[rid]})
                cells.append(cell)
            mech = r.get('mechanisms') or {}
            have = set(M.score(vec)['mechs'])
            add = [x if isinstance(x, str) else x['key'] for x in mech.get('add', [])]
            mechs = sorted((have | set(add)) - set(mech.get('drop', [])))
            rows[NAMES[rid]] = {'id': rid, 'family': fam, 'card': r['card'], 'vec': vec, 'cells': cells, 'mechs': mechs,
                                'judged_cells': sorted('%s %s' % k for k in judged)}
            if r.get('pins'):
                rows[NAMES[rid]]['pins'] = r['pins']  # design rules the referee made part of the row (not cells)
    json.dump({'about': 'Rows the closure pass judged: options, full card and mechanisms. Built by tools/closure_cards.py from hybrids/A.settled.json and B.settled.json.',
               'rows': rows}, open(OUT, 'w'), indent=1, ensure_ascii=False)
    print('wrote %d rows to %s' % (len(rows), OUT))


if __name__ == '__main__':
    main()
