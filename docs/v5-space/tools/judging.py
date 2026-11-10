#!/usr/bin/env python3
"""The judging tools: one format, checked and counted by code, so two judges can be compared
cell by cell and the verdict is arithmetic, not prose. Run from docs/v5-space.

  python3 tools/judging.py requirements          parse REQUIREMENTS.md -> judging/requirements.json
  python3 tools/judging.py check FILE            check one judge's file
  python3 tools/judging.py diff GROUP            compare judging/GROUP.j1.json with .j2.json
  python3 tools/judging.py settle GROUP          agreed cells + the referee's rulings -> GROUP.settled.json
  python3 tools/judging.py mechanisms            check judging/mechanisms.json and count novel mechanisms per row
  python3 tools/judging.py pairs                 mechanisms that share state -> judging/pairs.json and PAIRS.md
  python3 tools/judging.py verdict               every settled group -> judging/outcome.json and OUTCOME.md
  python3 tools/judging.py rows                  one scorecard per row -> judging/rows/ROW.md

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
CHOICES = ('restated', 'F_w', 'N_res', 'PERF-01 losses', 'region scope', 'shared tier', 'fsync figure', 'F-06 reading', 'other')

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

def restated(v):
    """The verdict if the requirement is restated as AMENDMENTS 1.3 asks (else the verdict as worded)."""
    return v.get('alt') if v.get('depends_on') == 'restated' else v.get('v')

def decisive(part, a, b):
    """A disagreement that can change the ranking: out or not (MUST), counted or not (SHOULD)."""
    return (a == 'fails') != (b == 'fails') if part == 'M' else (a == 'met') != (b == 'met')

def diff(group):
    a, b = check('%s/%s.j1.json' % (J, group), True), check('%s/%s.j2.json' % (J, group), True)
    ca, cb = expand(a), expand(b)
    rows, same, dec = [], 0, 0
    for k in ca:
        va, vb = ca[k], cb[k]
        if va['v'] == vb['v'] and restated(va) == restated(vb):
            same += 1; continue
        d = decisive(k[1], va['v'], vb['v']) or decisive(k[1], restated(va), restated(vb))
        dec += d
        rows.append({'req': k[0], 'part': k[1], 'row': k[2], 'decisive': d, 'j1': va, 'j2': vb})
    n = len(ca)
    dump('%s/%s.diff.json' % (J, group), {'group': group, 'cells': n, 'same': same, 'decisive': dec, 'minor': n - same - dec, 'disagreements': rows})
    out = ['# %s: where the two judges differ' % group, '',
           '%d cells. Same verdict: %d (%.1f%%). Decisive differences (out or not; counted or not): %d. Minor (met against open; not against open): %d.'
           % (n, same, 100.0 * same / n, dec, n - same - dec), '',
           '| Requirement | Row | Kind | Judge 1 | Judge 2 |', '|---|---|---|---|---|']
    cut = lambda v: ('**%s**%s%s: %s' % (v['v'], ' (%s)' % v['proof'] if v.get('proof') else '',
                     '; if %s: **%s**' % (v['depends_on'], v.get('alt')) if v.get('depends_on') else '', v['why'])).replace('|', '/').replace('\n', ' ')
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
        agree = va['v'] == vb['v'] and restated(va) == restated(vb)
        if agree and k in rul and not rul[k].get('overrules'):
            errs.append('%s %s %s: the judges agree; a ruling here needs "overrules": true and a source' % k); continue
        if agree and k not in rul:
            v = dict(va); v['why2'] = vb['why']; by = 'both'
            if 'depends_on' not in v and vb.get('depends_on'):
                v['depends_on'], v['alt'] = vb['depends_on'], vb.get('alt')
            if va['v'] == 'fails' and va.get('proof') != vb.get('proof'):
                v['proof2'] = vb.get('proof')
        elif agree:
            v = {x: y for x, y in rul[k].items() if x not in ('req', 'part', 'row', 'overrules')}
            check_verdict(v, k[1], '%s %s %s ruling' % k, errs); by = 'referee, against both judges'
        else:
            if k not in rul:
                errs.append('%s %s %s: the judges differ and there is no ruling' % k); continue
            v = {x: y for x, y in rul[k].items() if x not in ('req', 'part', 'row')}
            check_verdict(v, k[1], '%s %s %s ruling' % k, errs); by = 'referee'
        cells.append({'req': k[0], 'part': k[1], 'row': k[2], 'by': by, 'j1': va['v'], 'j2': vb['v'], 'j1r': restated(va), 'j2r': restated(vb), **v})
    for k in rul:
        if k not in ca:
            errs.append('%s %s %s: a ruling for a cell that does not exist' % k)
    if errs:
        print('%d problems' % len(errs))
        for e in errs[:60]:
            print('  -', e)
        sys.exit(1)
    dump('%s/%s.settled.json' % (J, group), {'group': group, 'cells_total': d['cells'], 'same': d['same'], 'decisive': d['decisive'], 'minor': d['minor'], 'cells': cells})
    print('%s settled: %d cells, %d by both judges, %d by the referee where they differed, %d by the referee against both'
          % (group, len(cells), sum(c['by'] == 'both' for c in cells), sum(c['by'] == 'referee' for c in cells), sum(c['by'].startswith('referee,') for c in cells)))

# ---- mechanisms (DEV-01) and interacting pairs (DEV-02) ----

def mechanisms():
    """judging/mechanisms.json: every mechanism (DEV-10 a), who carries it, and whether it is novel (DEV-10 b),
    as two counters judged it on their own (a, b) and as settled. This command checks the file and counts."""
    d, errs = load(J + '/mechanisms.json'), []
    keys = [m.get('key') for m in d.get('mechanisms', [])]
    for k in set(keys):
        if keys.count(k) > 1: errs.append('%s: key appears %d times' % (k, keys.count(k)))
    for m in d.get('mechanisms', []):
        w = str(m.get('key'))
        for f in ('name', 'state', 'rules'):
            if not str(m.get(f, '')).strip(): errs.append('%s: %s is empty' % (w, f))
        for f in ('reads', 'writes', 'rows'):
            if not isinstance(m.get(f), list): errs.append('%s: %s must be a list' % (w, f))
        for r in m.get('rows') or []:
            if r not in ROWS: errs.append('%s: unknown row %r' % (w, r))
        if not isinstance(m.get('novel'), bool): errs.append('%s: novel must be true or false' % w)
        if m.get('novel') is False and not str(m.get('precedent', '')).strip():
            errs.append('%s: not novel needs a precedent (a paper or a production system with the same state and rules in the same role)' % w)
        for who in ('a', 'b'):
            x = m.get(who)
            if not isinstance(x, dict) or not isinstance(x.get('novel'), bool) or not isinstance(x.get('rows'), list):
                errs.append('%s: needs "%s": {"novel": true|false, "rows": [...]} (that counter\'s own judgment; use rows [] if the counter did not list it)' % (w, who))
    if errs:
        print('%d problems' % len(errs))
        for e in errs[:60]: print('  -', e)
        sys.exit(1)
    counts = {'a': {r: 0 for r in ROWS}, 'b': {r: 0 for r in ROWS}, 'settled': {r: 0 for r in ROWS}}
    carried = {r: 0 for r in ROWS}
    for m in d['mechanisms']:
        for r in m['rows']:
            carried[r] += 1
            counts['settled'][r] += bool(m['novel'])
        for who in ('a', 'b'):
            for r in m[who]['rows']:
                counts[who][r] += bool(m[who]['novel'])
    d['counts'], d['carried'] = counts, carried
    dump(J + '/mechanisms.json', d)
    print('%d mechanisms. Novel mechanisms per row (counter a / counter b / settled), and all mechanisms carried:' % len(d['mechanisms']))
    for r in ROWS:
        print('  %-7s %2d / %2d / %2d   carried %2d' % (r, counts['a'][r], counts['b'][r], counts['settled'][r], carried[r]))

def pairs():
    """DEV-02: two mechanisms interact when both touch one piece of state and at least one of them writes it."""
    d = load(J + '/mechanisms.json')
    ms = d['mechanisms']
    def shared(a, b):
        ta, tb = set(a['reads']) | set(a['writes']), set(b['reads']) | set(b['writes'])
        return sorted((set(a['writes']) & tb) | (set(b['writes']) & ta))
    distinct, per = {}, {r: [] for r in ROWS}
    for a, b in itertools.combinations(ms, 2):
        sh = shared(a, b)
        if not sh: continue
        rows = [r for r in ROWS if r in a['rows'] and r in b['rows']]
        if not rows: continue
        distinct[(a['key'], b['key'])] = {'a': a['key'], 'b': b['key'], 'state': sh, 'rows': rows}
        for r in rows: per[r].append([a['key'], b['key'], sh])
    dump(J + '/pairs.json', {'pairs': {r: len(per[r]) for r in ROWS}, 'detail': per, 'distinct': list(distinct.values())})
    o = ['# Interacting pairs of mechanisms (DEV-02)', '',
         'Built by `python3 tools/judging.py pairs` from [mechanisms.json](mechanisms.json). Two mechanisms interact when both touch one piece of state and at least one of them writes it.', '',
         '| Row | Mechanisms carried | Interacting pairs |', '|---|---|---|']
    for r in ROWS:
        o.append('| %s | %d | %d |' % (r, sum(r in m['rows'] for m in ms), len(per[r])))
    o += ['', '## Every distinct pair', '', '| Mechanism | Mechanism | Shared state | Rows that carry both |', '|---|---|---|---|']
    for x in sorted(distinct.values(), key=lambda x: (-len(x['rows']), x['a'], x['b'])):
        o.append('| %s | %s | %s | %s |' % (x['a'], x['b'], ', '.join(x['state']), ', '.join(x['rows']) if len(x['rows']) < len(ROWS) else 'all'))
    open(J + '/PAIRS.md', 'w').write('\n'.join(o) + '\n')
    print('%d distinct pairs; per row: %s' % (len(distinct), ' '.join('%s=%d' % (r, len(per[r])) for r in ROWS)))

# ---- the verdict: REQUIREMENTS, judging rules 1 to 3, as arithmetic ----

def view(cells, scenario):
    """The cells as worded, or with each clause restated as AMENDMENTS 1.3 asks (the "alt" of a "restated" cell)."""
    if scenario != 'restated':
        return cells
    out = []
    for c in cells:
        c = dict(c)
        if c.get('depends_on') == 'restated':
            c['v'] = c['alt']
        c['j1'], c['j2'] = c.get('j1r', c['j1']), c.get('j2r', c['j2'])
        out.append(c)
    return out

def tally(cells, dev01, pairs, opt=None):
    opt = opt or {}
    t = {r: {'fails': [], 'open': 0, 'met': 0, 's_met': [], 's_not': [], 's_open': [], 'gap': 0.0} for r in ROWS}
    for c in cells:
        r, v = c['row'], c[opt['use']] if opt.get('use') else c['v']
        if opt.get('choice') and c.get('depends_on') == opt['choice'] and not opt.get('use'):
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
        order = sorted(ROWS, key=lambda r: (len(set(t[r]['fails'])), t[r]['gap']))
        best = len(set(t[order[0]]['fails']))
        return {'all_out': True, 'order': order, 'winner': order[0], 'in': [], 'wins': {}, 'losses': {}, 'unbeaten': [],
                'tied_first': [r for r in order if len(set(t[r]['fails'])) == best], 'clear': False}
    wins = {r: sum(beats(r, o, t, shoulds_first) > 0 for o in inn if o != r) for r in inn}
    losses = {r: sum(beats(r, o, t, shoulds_first) < 0 for o in inn if o != r) for r in inn}
    order = sorted(inn, key=lambda r: (-wins[r], losses[r], t[r]['dev01'] if t[r]['dev01'] is not None else 99, -len(t[r]['s_met'])))
    unbeaten = [r for r in inn if losses[r] == 0]
    return {'all_out': False, 'in': inn, 'order': order, 'wins': wins, 'losses': losses, 'unbeaten': unbeaten,
            'winner': order[0], 'clear': len(unbeaten) == 1 and wins[unbeaten[0]] == len(inn) - 1}

def outcome(cells, dev01, pairs, mech):
    t = tally(cells, dev01, pairs)
    base = rank(t)
    sens = []
    def case(name, opt=None, d01=None, sf=False, sweep=''):
        r = rank(tally(cells, d01 if d01 is not None else dev01, pairs, opt), sf)
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
        if ch != 'restated' and any(c.get('depends_on') == ch for c in cells):
            case('the user chooses the other way on: ' + ch, {'choice': ch})
    for req, part in sorted({(c['req'], c['part']) for c in cells if c['part'] == 'S'}):
        case('without the SHOULD %s' % req, {'drop': {(req, part)}}, sweep='one SHOULD left out, each in turn')
    for r in ROWS:
        if dev01.get(r) is not None:
            for d in (-2, 2):
                dd = dict(dev01); dd[r] = dev01[r] + d
                case('%s with %+d novel mechanisms' % (r, d), None, dd, sweep='one row given 2 more or 2 fewer novel mechanisms, each row in turn')
    back = []
    for r in ROWS:
        f = sorted(set(t[r]['fails']))
        if f and len(f) <= 2 and not base['all_out']:
            tt = json.loads(json.dumps(t)); tt[r]['fails'] = []
            rr = rank(tt)
            back.append({'row': r, 'if_these_musts_were_waived': f, 'it_would_place': rr['order'].index(r) + 1, 'winner_then': rr['winner']})
    return {'tally': t, 'rank': base, 'sensitivity': sens, 'waivers': back}

def write_outcome(o, res, head):
    t, base, sens, back = res['tally'], res['rank'], res['sensitivity'], res['waivers']
    o += ['', '### %s.1 Each row' % head, '',
          '| Row | MUSTs failed by design | MUSTs open | MUSTs met | Novel mechanisms (DEV-01) | SHOULDs met | SHOULDs not met | SHOULDs open | Interacting pairs (DEV-02) |', '|---|---|---|---|---|---|---|---|---|']
    for r in ROWS:
        x = t[r]
        o.append('| %s | %s | %d | %d | %s | %d | %d | %d | %s |' % (r, ', '.join(sorted(set(x['fails']))) or 'none', x['open'], x['met'],
                 '?' if x['dev01'] is None else x['dev01'], len(x['s_met']), len(x['s_not']), len(x['s_open']), '?' if x['pairs'] is None else x['pairs']))
    o += ['', '### %s.2 The ranking' % head, '']
    if base['all_out']:
        o.append('Every row fails at least one MUST, so rule 2 applies: fewest MUSTs failed first, then the smaller sum of gap over bar. '
                 + ('First: **%s**.' % base['winner'] if len(base['tied_first']) == 1 else 'Level on the count of MUSTs failed: %s.' % ', '.join(base['tied_first'])))
        o += ['', '| Place | Row | MUSTs failed | Sum of gap over bar |', '|---|---|---|---|']
        for i, r in enumerate(base['order']):
            o.append('| %d | %s | %d | %.2f |' % (i + 1, r, len(set(t[r]['fails'])), t[r]['gap']))
    else:
        o.append('Rows still in (no MUST failed by design): ' + ', '.join(base['in']) + '.')
        o.append('')
        o.append('Rule 3 is applied to every pair of rows still in. ' + ('**%s beats every other row.**' % base['winner'] if base['clear']
                 else 'No single row beats every other. Rows that lose to none: %s. The order below is by pairs won.' % (', '.join(base['unbeaten']) or 'none')))
        o += ['', '| Place | Row | Pairs won | Pairs lost | Novel mechanisms | SHOULDs met | Interacting pairs |', '|---|---|---|---|---|---|---|']
        for i, r in enumerate(base['order']):
            o.append('| %d | %s | %d | %d | %s | %d | %s |' % (i + 1, r, base['wins'][r], base['losses'][r], '?' if t[r]['dev01'] is None else t[r]['dev01'],
                     len(t[r]['s_met']), '?' if t[r]['pairs'] is None else t[r]['pairs']))
    o += ['', '### %s.3 What flips the winner' % head, '', 'Each line changes one thing and runs the rule again.', '', '| Change | Winner | Top three | Same winner? |', '|---|---|---|---|']
    for s in sens:
        if not s['sweep'] or not s['same_as_base']:
            o.append('| %s | %s | %s | %s |' % (s['case'], s['winner'], ', '.join(s['top3']), 'yes' if s['same_as_base'] else '**no**'))
    for sw in dict.fromkeys(s['sweep'] for s in sens if s['sweep']):
        grp = [s for s in sens if s['sweep'] == sw]
        o.append('| %s | %s | | %d of %d keep the winner%s |' % (sw, base['winner'], sum(s['same_as_base'] for s in grp), len(grp),
                 '' if all(s['same_as_base'] for s in grp) else '; the ones that do not are listed above'))
    if back:
        o += ['', '### %s.4 Rows that one or two MUSTs put out' % head, '', '| Row | Out on | If those were waived it would place | Winner then |', '|---|---|---|---|']
        for b in back:
            o.append('| %s | %s | %d | %s |' % (b['row'], ', '.join(b['if_these_musts_were_waived']), b['it_would_place'], b['winner_then']))

def verdict():
    cells, agree = [], {}
    for g in GROUPS:
        p = '%s/%s.settled.json' % (J, g)
        if not os.path.exists(p):
            print('missing', p); sys.exit(1)
        s = load(p)
        cells += s['cells']
        agree[g] = {k: s[k] for k in ('cells_total', 'same', 'decisive', 'minor')}
        agree[g]['referee_against_both'] = sum(c['by'].startswith('referee,') for c in s['cells'])
    mech = load(J + '/mechanisms.json') if os.path.exists(J + '/mechanisms.json') else {}
    dev01 = (mech.get('counts') or {}).get('settled', {})
    pairs = load(J + '/pairs.json').get('pairs', {}) if os.path.exists(J + '/pairs.json') else {}
    has_restated = any(c.get('depends_on') == 'restated' for c in cells)
    worded = outcome(cells, dev01, pairs, mech)
    rest = outcome(view(cells, 'restated'), dev01, pairs, mech) if has_restated else None
    dump(J + '/outcome.json', {'agreement': agree, 'as_worded': worded, 'restated': rest})
    tot = {k: sum(a[k] for a in agree.values()) for k in ('cells_total', 'same', 'decisive', 'minor', 'referee_against_both')}
    o = ['# The outcome, as arithmetic', '',
         'Built by `python3 tools/judging.py verdict` from the settled judging files in this folder. Nothing here is written by hand: it applies the judging rule of [REQUIREMENTS.md](../REQUIREMENTS.md) to the cells. [VERDICT.md](../VERDICT.md) explains it.', '',
         '## 1. How far the two judges agreed', '',
         '| Group | Cells | Same verdict | Decisive differences | Minor differences | Referee against both |', '|---|---|---|---|---|---|']
    for g, a in agree.items():
        o.append('| %s | %d | %d (%.1f%%) | %d | %d | %d |' % (g, a['cells_total'], a['same'], 100.0 * a['same'] / a['cells_total'], a['decisive'], a['minor'], a['referee_against_both']))
    o.append('| **All** | %d | %d (%.1f%%) | %d | %d | %d |' % (tot['cells_total'], tot['same'], 100.0 * tot['same'] / tot['cells_total'], tot['decisive'], tot['minor'], tot['referee_against_both']))
    o += ['', 'A cell is one requirement part for one row. A decisive difference could change the ranking: a MUST that one judge failed and the other did not, or a SHOULD that one counted as met and the other did not. A referee ruled on every difference in writing.']
    if has_restated:
        n = sum(c.get('depends_on') == 'restated' for c in cells)
        o += ['', 'Two outcomes follow. [AMENDMENTS.md](../AMENDMENTS.md) section 1.3 lists requirement clauses that the evidence shows no row can meet as worded, and what each experiment asks instead. %d cells carry two verdicts for that reason: one as the requirement is worded, one as restated. Part A uses the first, part B the second.' % n,
              '', '## A. As the requirements are worded today']
        write_outcome(o, worded, 'A')
        o += ['', '## B. With the clauses of AMENDMENTS 1.3 restated as the evidence asks']
        write_outcome(o, rest, 'B')
    else:
        o += ['', '## A. The outcome']
        write_outcome(o, worded, 'A')
    open(J + '/OUTCOME.md', 'w').write('\n'.join(o) + '\n')
    for name, res in (('as worded', worded), ('restated', rest)):
        if res:
            b = res['rank']
            print('%s: winner %s | all out: %s | in: %s | flips: %s' % (name, b['winner'], b['all_out'], b['in'], [x['case'] for x in res['sensitivity'] if not x['same_as_base']][:10]))

def rows():
    """One scorecard per row: every requirement part with its settled verdict, reason and what closes it."""
    req = load(J + '/requirements.json')
    title = {(p['req'], p['part']): p['title'] for p in req['parts']}
    cells = []
    for g in GROUPS:
        p = '%s/%s.settled.json' % (J, g)
        if os.path.exists(p):
            cells += [dict(c, group=g) for c in load(p)['cells']]
    mech = load(J + '/mechanisms.json') if os.path.exists(J + '/mechanisms.json') else {}
    pairs = load(J + '/pairs.json').get('pairs', {}) if os.path.exists(J + '/pairs.json') else {}
    os.makedirs(J + '/rows', exist_ok=True)
    esc = lambda x: str(x or '').replace('|', '/').replace('\n', ' ')
    for r in ROWS:
        mine = [c for c in cells if c['row'] == r]
        m = [c for c in mine if c['part'] == 'M']
        sh = [c for c in mine if c['part'] == 'S']
        rest = lambda c: c['alt'] if c.get('depends_on') == 'restated' else c['v']
        novel = [x for x in mech.get('mechanisms', []) if r in x.get('rows', []) and x.get('novel')]
        o = ['# %s: the scorecard' % r, '',
             'Built by `python3 tools/judging.py rows` from the settled judging files. Each line is one requirement part of [REQUIREMENTS.md](../../REQUIREMENTS.md) as two judges scored it for this row; "by" says whether both judges agreed or a referee ruled. The report is [candidates/%s.md](../../candidates/%s.md).' % (r, r), '',
             '| | As worded | With AMENDMENTS 1.3 restated |', '|---|---|---|',
             '| MUSTs failed by design | %d | %d |' % (sum(c['v'] == 'fails' for c in m), sum(rest(c) == 'fails' for c in m)),
             '| MUSTs open | %d | %d |' % (sum(c['v'] == 'open' for c in m), sum(rest(c) == 'open' for c in m)),
             '| MUSTs met | %d | %d |' % (sum(c['v'] == 'met' for c in m), sum(rest(c) == 'met' for c in m)),
             '| SHOULDs met | %d | %d |' % (sum(c['v'] == 'met' for c in sh), sum(rest(c) == 'met' for c in sh)),
             '| SHOULDs not met | %d | %d |' % (sum(c['v'] == 'not' for c in sh), sum(rest(c) == 'not' for c in sh)),
             '| SHOULDs open | %d | %d |' % (sum(c['v'] == 'open' for c in sh), sum(rest(c) == 'open' for c in sh)), '',
             'Novel mechanisms (DEV-01): %s%s. Interacting pairs (DEV-02): %s.' % (
                 (mech.get('counts') or {}).get('settled', {}).get(r, '?'),
                 ' (%s)' % ', '.join(x['name'] for x in novel) if novel else '', pairs.get(r, '?'))]
        fails = [c for c in m if c['v'] == 'fails']
        if fails:
            o += ['', '## MUSTs failed by design', '', '| Requirement | Proof | If restated | Why |', '|---|---|---|---|']
            for c in fails:
                o.append('| %s %s | %s | %s | %s |' % (c['req'], esc(title.get((c['req'], 'M'))), c.get('proof', ''), rest(c) if c.get('depends_on') == 'restated' else '', esc(c['why'])))
        for g in GROUPS:
            gc = [c for c in mine if c['group'] == g]
            if not gc: continue
            o += ['', '## %s' % g, '', '| Requirement | Part | Verdict | If restated | Basis | Evidence | Why | What closes it | By |', '|---|---|---|---|---|---|---|---|---|']
            for c in gc:
                dep = ''
                if c.get('depends_on') == 'restated': dep = c['alt']
                elif c.get('depends_on'): dep = 'if %s: %s' % (c['depends_on'], c.get('alt'))
                o.append('| %s %s | %s | **%s** | %s | %s | %s | %s | %s | %s |' % (c['req'], esc(title.get((c['req'], c['part']))), c['part'], c['v'], dep, c.get('basis', ''),
                         ', '.join(c.get('ev') or []), esc(c['why']), esc(c.get('closes')), c['by']))
        open('%s/rows/%s.md' % (J, r), 'w').write('\n'.join(o) + '\n')
    print('wrote %d scorecards from %d cells' % (len(ROWS), len(cells)))

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'requirements': requirements()
    elif cmd == 'check': check(sys.argv[2])
    elif cmd == 'diff': diff(sys.argv[2])
    elif cmd == 'settle': settle(sys.argv[2])
    elif cmd == 'mechanisms': mechanisms()
    elif cmd == 'pairs': pairs()
    elif cmd == 'verdict': verdict()
    elif cmd == 'rows': rows()
    else: print(__doc__)
