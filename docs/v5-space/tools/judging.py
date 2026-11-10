#!/usr/bin/env python3
"""The judging tools: one format, checked and counted by code, so two judges can be compared
cell by cell and the verdict is arithmetic, not prose. Run from docs/v5-space.

  python3 tools/judging.py requirements          parse REQUIREMENTS.md -> judging/requirements.json
  python3 tools/judging.py check FILE            check one judge's file
  python3 tools/judging.py diff GROUP            compare judging/GROUP.j1.json with .j2.json
  python3 tools/judging.py settle GROUP          agreed cells + the referee's rulings -> GROUP.settled.json
  python3 tools/judging.py verdict               every settled group -> judging/outcome.json and OUTCOME.md

A judge's file:
  { "group": "SC", "judge": "j1", "cells": [
      { "req": "SC-03", "part": "M",
        "default": { "v": "open", "basis": "reasoned", "ev": ["E-18"], "why": "...", "closes": "..." },
        "except": { "CELL": { "v": "fails", "proof": "ceiling", "basis": "measured", "ev": ["E-18"], "why": "..." } } } ] }
A MUST part takes v = met | open | fails. A SHOULD part takes v = met | not | open.
"fails" needs proof = counterexample | ceiling | structural (REQUIREMENTS, judging rule 1).
Optional on any verdict: "depends_on" (a choice the user sets) with "alt" (the verdict if the user
chooses the other way), and "gap" (gap / bar, a number) on a ceiling failure.
"""
import json, os, re, sys, itertools

J = 'judging'
ROWS = ['DRAFT', 'MIN', 'RUST', 'SRV', 'LEAN', 'CELL', 'LANE', 'SPLIT', 'PD', 'ISR', 'SLOG', 'OBJ', 'V4',
        'MIN-P', 'MIN-TS', 'RLOG', 'EMB-V8', 'SIDE', 'BUY', 'COMP']
GROUPS = {'P': ['P'], 'PERF-DATA': ['PERF', 'DATA'], 'SC': ['SC'], 'F': ['F'], 'DEV': ['DEV'],
          'DEP': ['DEP'], 'TEST-OPS': ['TEST', 'OPS']}
VM, VS = ('met', 'open', 'fails'), ('met', 'not', 'open')
PROOFS = ('counterexample', 'ceiling', 'structural')
BASES = ('measured', 'model', 'cited', 'reasoned', 'construction')
CHOICES = ('F_w', 'N_res', 'PERF-01 losses', 'region scope', 'shared tier', 'fsync figure', 'F-06 reading', 'other')

def load(p):
    with open(p) as f:
        return json.load(f)

def dump(p, o):
    with open(p, 'w') as f:
        json.dump(o, f, indent=1, ensure_ascii=False)
        f.write('\n')

def requirements():
    parts = []
    for l in open('REQUIREMENTS.md').read().splitlines():
        m = re.match(r'^\| ((PERF|DATA|TEST|DEV|DEP|OPS|SC|P|F)-\d+) \|(.*)\|\s*([MS](?:\s*/\s*[MS])?)\s*\|\s*$', l)
        if not m:
            continue
        rid, area, ms = m.group(1), m.group(2), m.group(4).replace(' ', '')
        t = re.search(r'\*\*(.+?)\*\*', m.group(3))
        group = next(g for g, a in GROUPS.items() if area in a)
        for part in ms.split('/'):
            parts.append({'req': rid, 'part': part, 'area': area, 'group': group, 'title': t.group(1).rstrip('.') if t else ''})
    dump(J + '/requirements.json', {'rows': ROWS, 'groups': GROUPS, 'choices': CHOICES, 'parts': parts})
    print('parts:', len(parts), ' MUST:', sum(p['part'] == 'M' for p in parts), ' SHOULD:', sum(p['part'] == 'S' for p in parts))
    for g in GROUPS:
        print(' ', g, sum(p['group'] == g for p in parts), 'parts')

def parts_of(group):
    return [p for p in load(J + '/requirements.json')['parts'] if p['group'] == group]

def check_verdict(v, part, where, errs):
    if not isinstance(v, dict):
        errs.append(where + ': not an object'); return
    allowed = VM if part == 'M' else VS
    if v.get('v') not in allowed:
        errs.append('%s: v must be one of %s, got %r' % (where, '/'.join(allowed), v.get('v')))
    if not str(v.get('why', '')).strip():
        errs.append(where + ': why is empty')
    if v.get('basis') not in BASES:
        errs.append('%s: basis must be one of %s' % (where, '/'.join(BASES)))
    if not isinstance(v.get('ev', []), list):
        errs.append(where + ': ev must be a list of experiment ids')
    if v.get('v') == 'fails':
        if v.get('proof') not in PROOFS:
            errs.append('%s: fails needs proof = %s' % (where, '/'.join(PROOFS)))
        if v.get('proof') in ('counterexample', 'ceiling') and not v.get('ev'):
            errs.append(where + ': a counterexample or a ceiling needs its experiment in ev')
    if v.get('v') == 'open' and part == 'M' and not str(v.get('closes', '')).strip():
        errs.append(where + ': an open MUST needs "closes" (the experiment or build phase that closes it)')
    if 'depends_on' in v:
        if v['depends_on'] not in CHOICES:
            errs.append('%s: depends_on must be one of %s' % (where, '/'.join(CHOICES)))
        if v.get('alt') not in allowed:
            errs.append(where + ': depends_on needs alt (the verdict under the other choice)')

def check(path, quiet=False):
    d, errs = load(path), []
    group = d.get('group')
    if group not in GROUPS:
        print('unknown group', group); sys.exit(1)
    want = [(p['req'], p['part']) for p in parts_of(group)]
    have = [(c.get('req'), c.get('part')) for c in d.get('cells', [])]
    for w in want:
        if have.count(w) != 1:
            errs.append('%s %s: must appear exactly once (appears %d times)' % (w[0], w[1], have.count(w)))
    for h in have:
        if h not in want:
            errs.append('%s %s: not a part of group %s' % (h[0], h[1], group))
    for c in d.get('cells', []):
        w = '%s %s' % (c.get('req'), c.get('part'))
        check_verdict(c.get('default'), c.get('part'), w + ' default', errs)
        for row, v in (c.get('except') or {}).items():
            if row not in ROWS:
                errs.append('%s: unknown row %r' % (w, row))
            check_verdict(v, c.get('part'), '%s %s' % (w, row), errs)
    if errs:
        print('%d problems in %s' % (len(errs), path))
        for e in errs[:60]:
            print('  -', e)
        sys.exit(1)
    if not quiet:
        cells = expand(d)
        print('ok: %s, %d parts x %d rows = %d cells' % (path, len(want), len(ROWS), len(cells)))
        for row in ROWS:
            f = [k[0] + k[1].replace('M', '') for k, v in cells.items() if k[2] == row and v['v'] == 'fails']
            n = [k[0] for k, v in cells.items() if k[2] == row and v['v'] == 'not']
            print('  %-7s fails %2d %s | SHOULDs not met %2d' % (row, len(f), ' '.join(f), len(n)))
    return d

def expand(d):
    cells = {}
    for c in d['cells']:
        for row in ROWS:
            cells[(c['req'], c['part'], row)] = (c.get('except') or {}).get(row, c['default'])
    return cells

def decisive(part, a, b):
    """A disagreement that can change the ranking: out or not (MUST), counted or not (SHOULD)."""
    return (a == 'fails') != (b == 'fails') if part == 'M' else (a == 'met') != (b == 'met')

def diff(group):
    a, b = check('%s/%s.j1.json' % (J, group), True), check('%s/%s.j2.json' % (J, group), True)
    ca, cb = expand(a), expand(b)
    rows, same, dec = [], 0, 0
    for k in ca:
        va, vb = ca[k], cb[k]
        if va['v'] == vb['v']:
            same += 1; continue
        d = decisive(k[1], va['v'], vb['v'])
        dec += d
        rows.append({'req': k[0], 'part': k[1], 'row': k[2], 'decisive': d, 'j1': va, 'j2': vb})
    n = len(ca)
    dump('%s/%s.diff.json' % (J, group), {'group': group, 'cells': n, 'same': same, 'decisive': dec, 'minor': n - same - dec, 'disagreements': rows})
    out = ['# %s: where the two judges differ' % group, '',
           '%d cells. Same verdict: %d (%.1f%%). Decisive differences (out or not; counted or not): %d. Minor (met against open; not against open): %d.'
           % (n, same, 100.0 * same / n, dec, n - same - dec), '',
           '| Requirement | Row | Kind | Judge 1 | Judge 2 |', '|---|---|---|---|---|']
    cut = lambda v: ('**%s**%s: %s' % (v['v'], ' (%s)' % v['proof'] if v.get('proof') else '', v['why'])).replace('|', '/').replace('\n', ' ')
    for r in sorted(rows, key=lambda r: (not r['decisive'], r['req'], r['row'])):
        out.append('| %s %s | %s | %s | %s | %s |' % (r['req'], r['part'], r['row'], 'decisive' if r['decisive'] else 'minor', cut(r['j1']), cut(r['j2'])))
    open('%s/%s.diff.md' % (J, group), 'w').write('\n'.join(out) + '\n')
    print('%s: %d cells, same %d (%.1f%%), decisive %d, minor %d -> %s/%s.diff.md' % (group, n, same, 100.0 * same / n, dec, n - same - dec, J, group))

def settle(group):
    d = load('%s/%s.diff.json' % (J, group))
    a, b = load('%s/%s.j1.json' % (J, group)), load('%s/%s.j2.json' % (J, group))
    ca, cb = expand(a), expand(b)
    rul = {(r['req'], r['part'], r['row']): r for r in load('%s/%s.rulings.json' % (J, group))}
    errs, cells = [], []
    for k in ca:
        va, vb = ca[k], cb[k]
        if va['v'] == vb['v']:
            v = dict(va); v['why2'] = vb['why']; by = 'both'
            if va['v'] == 'fails' and va.get('proof') != vb.get('proof'):
                v['proof2'] = vb.get('proof')
        else:
            if k not in rul:
                errs.append('%s %s %s: the judges differ and there is no ruling' % k); continue
            v = {x: y for x, y in rul[k].items() if x not in ('req', 'part', 'row')}
            check_verdict(v, k[1], '%s %s %s ruling' % k, errs); by = 'referee'
        cells.append({'req': k[0], 'part': k[1], 'row': k[2], 'by': by, 'j1': va['v'], 'j2': vb['v'], **v})
    for k in rul:
        if k not in ca:
            errs.append('%s %s %s: a ruling for a cell that does not exist' % k)
    if errs:
        print('%d problems' % len(errs))
        for e in errs[:60]:
            print('  -', e)
        sys.exit(1)
    dump('%s/%s.settled.json' % (J, group), {'group': group, 'cells_total': d['cells'], 'same': d['same'], 'decisive': d['decisive'], 'minor': d['minor'], 'cells': cells})
    print('%s settled: %d cells, %d by both judges, %d by the referee' % (group, len(cells), sum(c['by'] == 'both' for c in cells), sum(c['by'] == 'referee' for c in cells)))

# ---- the verdict: REQUIREMENTS, judging rules 1 to 3, as arithmetic ----

def tally(cells, dev01, pairs, opt=None):
    opt = opt or {}
    t = {r: {'fails': [], 'open': 0, 'met': 0, 's_met': [], 's_not': [], 's_open': [], 'gap': 0.0} for r in ROWS}
    for c in cells:
        r, v = c['row'], c[opt.get('use', 'v')] if opt.get('use') else c['v']
        if opt.get('choice') and c.get('depends_on') == opt['choice']:
            v = c['alt']
        if (c['req'], c['part']) in opt.get('drop', ()):
            continue
        if c['part'] == 'M':
            if v == 'fails':
                t[r]['fails'].append(c['req']); t[r]['gap'] += float(c.get('gap') or 0)
            else:
                t[r]['open' if v == 'open' else 'met'] += 1
        else:
            if v == 'open' and opt.get('open_s'):
                v = opt['open_s']
            t[r]['s_' + v].append(c['req'])
    for r in ROWS:
        t[r]['dev01'] = dev01.get(r)
        t[r]['pairs'] = pairs.get(r)
    return t

def beats(a, b, t, shoulds_first=False):
    """Rule 3 between two rows that are both in. Returns 1 if a wins, -1 if b wins, 0 for a tie."""
    da, db = t[a]['dev01'], t[b]['dev01']
    sa, sb = len(t[a]['s_met']), len(t[b]['s_met'])
    by_dev = 0 if da is None or db is None or abs(da - db) < 2 else (1 if da < db else -1)
    by_s = (sa > sb) - (sa < sb)
    first, second = (by_s, by_dev) if shoulds_first else (by_dev, by_s)
    if first: return first
    if second: return second
    pa, pb = t[a]['pairs'], t[b]['pairs']
    if pa is None or pb is None or pa == pb: return 0
    return 1 if pa < pb else -1

def rank(t, shoulds_first=False):
    inn = [r for r in ROWS if not t[r]['fails']]
    if not inn:  # rule 2: every row fails a MUST
        order = sorted(ROWS, key=lambda r: (len(t[r]['fails']), t[r]['gap']))
        return {'all_out': True, 'order': order, 'winner': order[0], 'in': [], 'wins': {}}
    wins = {r: sum(beats(r, o, t, shoulds_first) > 0 for o in inn if o != r) for r in inn}
    losses = {r: sum(beats(r, o, t, shoulds_first) < 0 for o in inn if o != r) for r in inn}
    order = sorted(inn, key=lambda r: (-wins[r], losses[r], t[r]['dev01'] if t[r]['dev01'] is not None else 99, -len(t[r]['s_met'])))
    unbeaten = [r for r in inn if losses[r] == 0]
    return {'all_out': False, 'in': inn, 'order': order, 'wins': wins, 'losses': losses, 'unbeaten': unbeaten,
            'winner': order[0], 'clear': len(unbeaten) == 1 and wins[unbeaten[0]] == len(inn) - 1}

def verdict():
    cells, agree = [], {}
    for g in GROUPS:
        p = '%s/%s.settled.json' % (J, g)
        if not os.path.exists(p):
            print('missing', p); sys.exit(1)
        s = load(p)
        cells += s['cells']
        agree[g] = {k: s[k] for k in ('cells_total', 'same', 'decisive', 'minor')}
    mech = load(J + '/mechanisms.json') if os.path.exists(J + '/mechanisms.json') else {}
    dev01 = (mech.get('counts') or {}).get('settled', {})
    pairs = load(J + '/pairs.json').get('pairs', {}) if os.path.exists(J + '/pairs.json') else {}
    t = tally(cells, dev01, pairs)
    base = rank(t)
    sens = []
    def case(name, opt=None, d01=None, sf=False, sweep=''):
        tt = tally(cells, d01 if d01 is not None else dev01, pairs, opt)
        r = rank(tt, sf)
        sens.append({'case': name, 'sweep': sweep, 'winner': r['winner'], 'in': r['in'], 'top3': r['order'][:3], 'same_as_base': r['winner'] == base['winner']})
    case('judge 1 alone, before the referee', {'use': 'j1'})
    case('judge 2 alone, before the referee', {'use': 'j2'})
    case('every open SHOULD counted as met', {'open_s': 'met'})
    case('every open SHOULD counted as not met', {'open_s': 'not'})
    case('rule 3 the other way: SHOULDs first, then novel mechanisms', None, None, True)
    for who in ('a', 'b'):
        if (mech.get('counts') or {}).get(who):
            case('novel mechanisms as counter %s counted them' % who, None, mech['counts'][who])
    for ch in CHOICES:
        if any(c.get('depends_on') == ch for c in cells):
            case('the user chooses the other way on: ' + ch, {'choice': ch})
    for req, part in sorted({(c['req'], c['part']) for c in cells if c['part'] == 'S'}):
        case('without the SHOULD %s' % req, {'drop': {(req, part)}}, sweep='one SHOULD left out, each of the 16 in turn')
    for r in ROWS:
        if dev01.get(r) is not None:
            for d in (-2, 2):
                dd = dict(dev01); dd[r] = dev01[r] + d
                case('%s with %+d novel mechanisms' % (r, d), None, dd, sweep='one row given 2 more or 2 fewer novel mechanisms, each row in turn')
    back = []
    for r in ROWS:
        if t[r]['fails'] and len(set(t[r]['fails'])) <= 2:
            tt = json.loads(json.dumps(t)); tt[r]['fails'] = []
            rr = rank(tt)
            back.append({'row': r, 'if_these_musts_were_waived': sorted(set(t[r]['fails'])), 'it_would_place': rr['order'].index(r) + 1, 'winner_then': rr['winner']})
    dump(J + '/outcome.json', {'agreement': agree, 'tally': t, 'rank': base, 'sensitivity': sens, 'waivers': back})
    tot = {k: sum(a[k] for a in agree.values()) for k in ('cells_total', 'same', 'decisive', 'minor')}
    o = ['# The outcome, as arithmetic', '',
         'Built by `python3 tools/judging.py verdict` from the settled judging files in this folder. Nothing here is written by hand: it applies [REQUIREMENTS.md](../REQUIREMENTS.md)\'s judging rule to the cells. [VERDICT.md](../VERDICT.md) explains it.', '',
         '## 1. How far the two judges agreed', '',
         '| Group | Cells | Same verdict | Decisive differences | Minor differences |', '|---|---|---|---|---|']
    for g, a in agree.items():
        o.append('| %s | %d | %d (%.1f%%) | %d | %d |' % (g, a['cells_total'], a['same'], 100.0 * a['same'] / a['cells_total'], a['decisive'], a['minor']))
    o.append('| **All** | %d | %d (%.1f%%) | %d | %d |' % (tot['cells_total'], tot['same'], 100.0 * tot['same'] / tot['cells_total'], tot['decisive'], tot['minor']))
    o += ['', 'A decisive difference is one that could change the ranking: a MUST that one judge failed and the other did not, or a SHOULD that one counted as met and the other did not. A referee settled every difference in writing.', '',
          '## 2. Each row', '',
          '| Row | MUSTs failed by design | MUSTs open | MUSTs met | Novel mechanisms (DEV-01) | SHOULDs met | SHOULDs not met | SHOULDs open | Interacting pairs (DEV-02) |', '|---|---|---|---|---|---|---|---|---|']
    for r in ROWS:
        x = t[r]
        o.append('| %s | %s | %d | %d | %s | %d | %d | %d | %s |' % (r, ', '.join(sorted(set(x['fails']))) or 'none', x['open'], x['met'],
                 '?' if x['dev01'] is None else x['dev01'], len(x['s_met']), len(x['s_not']), len(x['s_open']), '?' if x['pairs'] is None else x['pairs']))
    o += ['', '## 3. The ranking', '']
    if base['all_out']:
        o.append('Every row fails at least one MUST, so rule 2 applies: fewest MUSTs failed first. Order: ' + ', '.join(base['order']) + '.')
    else:
        o.append('Rows still in (no MUST failed by design): ' + ', '.join(base['in']) + '.')
        o.append('')
        o.append('Rule 3 is applied to every pair of rows still in. ' + ('**%s beats every other row.**' % base['winner'] if base['clear'] else 'No single row beats every other; unbeaten rows: %s. The order below is by pairs won.' % ', '.join(base['unbeaten'])))
        o += ['', '| Place | Row | Pairs won | Pairs lost | Novel mechanisms | SHOULDs met |', '|---|---|---|---|---|---|']
        for i, r in enumerate(base['order']):
            o.append('| %d | %s | %d | %d | %s | %d |' % (i + 1, r, base['wins'][r], base['losses'][r], '?' if t[r]['dev01'] is None else t[r]['dev01'], len(t[r]['s_met'])))
    o += ['', '## 4. What flips the winner', '', 'Each line changes one thing and runs the rule again.', '', '| Change | Winner | Top three | Same winner? |', '|---|---|---|---|']
    for s in sens:
        if not s['sweep'] or not s['same_as_base']:
            o.append('| %s | %s | %s | %s |' % (s['case'], s['winner'], ', '.join(s['top3']), 'yes' if s['same_as_base'] else '**no**'))
    for sw in dict.fromkeys(s['sweep'] for s in sens if s['sweep']):
        grp = [s for s in sens if s['sweep'] == sw]
        o.append('| %s | %s | | %d of %d keep the winner%s |' % (sw, base['winner'], sum(s['same_as_base'] for s in grp), len(grp),
                 '' if all(s['same_as_base'] for s in grp) else '; the ones that do not are listed above'))
    if back:
        o += ['', '## 5. Rows that one or two MUSTs put out', '', '| Row | Out on | If those were waived it would place | Winner then |', '|---|---|---|---|']
        for b in back:
            o.append('| %s | %s | %d | %s |' % (b['row'], ', '.join(b['if_these_musts_were_waived']), b['it_would_place'], b['winner_then']))
    open(J + '/OUTCOME.md', 'w').write('\n'.join(o) + '\n')
    print('winner:', base['winner'], '| in:', base['in'], '| flips:', [s['case'] for s in sens if not s['same_as_base']][:12])

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'requirements': requirements()
    elif cmd == 'check': check(sys.argv[2])
    elif cmd == 'diff': diff(sys.argv[2])
    elif cmd == 'settle': settle(sys.argv[2])
    elif cmd == 'verdict': verdict()
    else: print(__doc__)
