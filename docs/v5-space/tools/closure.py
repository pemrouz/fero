#!/usr/bin/env python3
"""The closure pass: is any row built from the judged rows' own options better, by the judging rule, than the named answer?

The 20 judged rows are 20 points in a space of 22 axes. This tool lets code search the points between them.
Three files say how a row's standing follows from its options (judging/closure/README.md):

  judging/closure/attrib/<GROUP>.json  every requirement part: the axes that decide its cell, and the verdict per option
  judging/closure/mechanisms.json      every mechanism: the options that carry it
  judging/closure/constraints.json     the options that force or forbid others (SPACE section 5)

Each must reproduce the judged rows exactly; the check commands below say where it does not.
Accepted re-rulings (judging/closure/rerulings.cells.json, rerulings.mech.json) are applied to the settled files
before any check or prediction; the settled files themselves are never edited.

  python3 tools/closure.py check GROUP      a group's attribution against its settled cells (the 20 rows)
  python3 tools/closure.py check-mech       the mechanism conditions against mechanisms.json's rows
  python3 tools/closure.py check-cons       every judged row satisfies every constraint
  python3 tools/closure.py check-all        all of the above
  python3 tools/closure.py row 'R=raft,G=pslot,...'   predict one row (unnamed axes are COMP's), with its support
  python3 tools/closure.py mechrow 'C=cent-co,Z=par' [BASE]   mechanisms only: novel count and pairs of BASE (default COMP) changed
  python3 tools/closure.py search [--depth N]         every row within N axis changes of a judged row, ranked
"""
import itertools, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
J = os.path.join(ROOT, 'judging')
CL = os.path.join(J, 'closure')
sys.path.insert(0, HERE)
import judging as JG  # noqa: E402

GROUPS = ['P', 'PERF-DATA', 'SC', 'F', 'DEV', 'DEP', 'TEST-OPS']
FIELDS = ('v', 'alt', 'depends_on')


def load(p):
    with open(p) as f:
        return json.load(f)


def axes():
    return load(os.path.join(CL, 'axes.json'))


def settled(group):
    """The settled cells of one group, keyed (req, part, row), with any accepted re-rulings applied."""
    d = load(os.path.join(J, '%s.settled.json' % group))
    cells = {(c['req'], c['part'], c['row']): c for c in d['cells']}
    rr = os.path.join(CL, 'rerulings.cells.json')
    if os.path.exists(rr):
        for x in load(rr).get('cells', []):
            if x.get('ruling') != 'accept' or x.get('group') != group:
                continue
            for row in x['rows']:
                k = (x['req'], x['part'], row)
                c = dict(cells[k])
                c.update(x['to'])
                for f in ('alt', 'depends_on', 'gap'):
                    if f in x['to'] and x['to'][f] is None:
                        c.pop(f, None)
                cells[k] = c
    return cells


def matches(vec, when):
    return all(vec.get(a) in tags for a, tags in when.items())


def predict_part(p, vec, row=None):
    """The cell one attribution entry gives a row; row names a judged row (its overrides apply)."""
    if row and row in (p.get('overrides') or {}):
        return dict(p['overrides'][row], _rule='override')
    for i, r in enumerate(p.get('rules', [])):
        if matches(vec, r['when']):
            return dict(r, _rule=i)
    if 'else' in p:
        return dict(p['else'], _rule='else')
    return None


def norm(c):
    o = {f: c.get(f) for f in FIELDS}
    if o['depends_on'] is None:
        o['alt'] = None
    fails = 'fails' in (o['v'], o['alt'])
    o['gap'] = round(float(c.get('gap') or 0), 2) if fails else None
    return o


def attrib(group):
    p = os.path.join(CL, 'attrib', '%s.json' % group)
    return load(p) if os.path.exists(p) else None


def check(group, quiet=False):
    ax, cells, at = axes(), settled(group), attrib(group)
    if at is None:
        print('%s: no attribution file yet' % group)
        return 1
    parts = sorted({(k[0], k[1]) for k in cells})
    got = {(p['req'], p['part']): p for p in at.get('parts', [])}
    errs = []
    for k in parts:
        if k not in got:
            errs.append('%s %s: no entry' % k)
    for k, p in got.items():
        if k not in parts:
            errs.append('%s %s: not a part of this group' % k)
            continue
        for a in deciding(p):
            if a not in ax['axes']:
                errs.append('%s %s: unknown axis %r' % (k + (a,)))
        for r in p.get('rules', []):
            for a, tags in r['when'].items():
                bad = [t for t in tags if t not in ax['options'].get(a, []) and t != 'par']
                if bad:
                    errs.append('%s %s: tags %s are not options of %s (axes.json)' % (k[0], k[1], bad, a))
        for row, vec in ax['rows'].items():
            want = norm(cells[(k[0], k[1], row)])
            pr = predict_part(p, vec, row)
            if pr is None:
                errs.append('%s %s %s: no rule matches (want %s)' % (k[0], k[1], row, want))
                continue
            have = norm(pr)
            if have != want:
                errs.append('%s %s %s: rule %s gives %s, settled is %s' % (k[0], k[1], row, pr['_rule'], have, want))
    nover = sum(len(p.get('overrides') or {}) for p in got.values())
    if not quiet or errs:
        print('%s: %d parts, %d cells, %d overrides, %d mismatches' % (group, len(parts), len(parts) * len(ax['rows']), nover, len(errs)))
        for e in errs[:80]:
            print('  -', e)
    return len(errs)


def deciding(p):
    s = set()
    for r in p.get('rules', []):
        s |= set(r['when'])
    return sorted(s)


def mech():
    return load(os.path.join(CL, 'mechanisms.json'))


def mech_rows():
    """mechanisms.json's settled rows per mechanism, with any accepted mechanism re-rulings applied."""
    d = load(os.path.join(J, 'mechanisms.json'))
    ms = {m['key']: dict(m) for m in d['mechanisms']}
    rr = os.path.join(CL, 'rerulings.mech.json')
    if os.path.exists(rr):
        for x in load(rr).get('mechanisms', []):
            if x.get('ruling') != 'accept':
                continue
            m = ms[x['key']]
            for row in x.get('add_rows', []):
                if row not in m['rows']:
                    m['rows'] = m['rows'] + [row]
            m['rows'] = [r for r in m['rows'] if r not in x.get('drop_rows', [])]
            if 'novel' in x:
                m['novel'] = x['novel']
    return ms


def carries(entry, vec):
    return any(matches(vec, w) for w in entry['when'])


def check_mech(quiet=False):
    ax, ms = axes(), mech_rows()
    cm = mech()
    got = {m['key']: m for m in cm['mechanisms']}
    errs = []
    for k in ms:
        if k not in got:
            errs.append('%s: no entry' % k)
    for k, e in got.items():
        if k not in ms:
            errs.append('%s: not in judging/mechanisms.json' % k)
            continue
        for row, vec in ax['rows'].items():
            want = row in ms[k]['rows']
            have = carries(e, vec)
            if want != have:
                errs.append('%s %s: condition says %s, mechanisms.json says %s' % (k, row, have, want))
    if not quiet or errs:
        print('mechanisms: %d entries, %d mismatches' % (len(got), len(errs)))
        for e in errs[:80]:
            print('  -', e)
    return len(errs)


def cons():
    p = os.path.join(CL, 'constraints.json')
    return load(p)['constraints'] if os.path.exists(p) else []


def violates(vec, cs):
    return [c for c in cs if matches(vec, c['if']) and not matches(vec, c['then'])]


def check_cons(quiet=False):
    ax, cs, errs = axes(), cons(), []
    for row, vec in ax['rows'].items():
        for c in violates(vec, cs):
            errs.append('%s breaks %s' % (row, c.get('id', c)))
    if not quiet or errs:
        print('constraints: %d, %d broken by judged rows' % (len(cs), len(errs)))
        for e in errs[:80]:
            print('  -', e)
    return len(errs)


# ---- prediction and search ----

class Model:
    def __init__(self):
        self.ax = axes()
        self.parts = []
        for g in GROUPS:
            a = attrib(g)
            if a is None:
                raise SystemExit('missing attribution for %s' % g)
            for p in a['parts']:
                self.parts.append(dict(p, group=g))
        ms = mech_rows()
        self.mech = [(e, ms[e['key']]) for e in mech()['mechanisms']]
        self.cons = cons()
        self.judged = self.ax['rows']

    def cells(self, vec, row=None):
        """Predicted cells, each with its support: the judged rows that share its tags on every deciding axis."""
        out = []
        for p in self.parts:
            pr = predict_part(p, vec, row)
            dax = deciding(p)
            sup = [r for r, v in self.judged.items() if all(v[a] == vec[a] for a in dax)] if row is None else [row]
            if row is None and set(sup) & set(p.get('overrides') or {}):
                # a judged row with the same deciding tags has its own, different cell: the axes do not explain it
                sup = []
            c = {'req': p['req'], 'part': p['part'], 'row': row or '?', 'group': p['group'],
                 'support': sup, 'rule': pr['_rule'] if pr else None, 'axes': dax}
            if pr:
                c.update({f: pr.get(f) for f in FIELDS})
                c['gap'] = pr.get('gap')
            else:
                c['v'] = None
            out.append(c)
        return out

    def mechs(self, vec):
        return [m for e, m in self.mech if carries(e, vec)]

    def score(self, vec, row=None):
        ms = self.mechs(vec)
        novel = sum(bool(m['novel']) for m in ms)
        pairs = 0
        for a, b in itertools.combinations(ms, 2):
            ta, tb = set(a['reads']) | set(a['writes']), set(b['reads']) | set(b['writes'])
            if (set(a['writes']) & tb) or (set(b['writes']) & ta):
                pairs += 1
        return {'mechs': [m['key'] for m in ms], 'novel': novel, 'pairs': pairs}


def tally1(cells, scenario='restated', choice=None, only_req=None):
    t = {'fails': [], 'open': 0, 'met': 0, 's_met': [], 's_not': [], 's_open': [], 'gap': 0.0, 'unknown': []}
    for c in cells:
        v = c['v']
        if v is None:
            t['unknown'].append(c['req'] + ' ' + c['part'])
            continue
        if scenario == 'restated' and c.get('depends_on') == 'restated':
            v = c['alt']
        if choice and c.get('depends_on') == choice and (only_req is None or only_req == c['req']):
            v = c['alt']
        if c['part'] == 'M':
            if v == 'fails':
                t['fails'].append(c['req']); t['gap'] += float(c.get('gap') or 0)
            else:
                t['open' if v == 'open' else 'met'] += 1
        else:
            t['s_' + v].append(c['req'])
    return t


def unbeaten(rows):
    """Rule 3 over many rows at once: the rows no other row beats. rows: name -> (novel, shoulds, pairs)."""
    if not rows:
        return []
    lo = min(v[0] for v in rows.values())
    cand = {k: v for k, v in rows.items() if v[0] <= lo + 1}
    best_s = max(v[1] for v in cand.values())
    cand = {k: v for k, v in cand.items() if v[1] == best_s}
    best_p = min(v[2] for v in cand.values())
    return sorted(k for k, v in cand.items() if v[2] == best_p)


def name(vec, base):
    return ' '.join('%s=%s' % (a, vec[a]) for a in vec if vec[a] != base[a])


def search(depth=2, scenario='restated', choice=None, top=40, out=None):
    M = Model()
    ax = M.ax
    opts = {a: [t for t in ax['options'][a] if t not in ('theirs', 'outside')] for a in ax['axes']}
    seen, rows = {}, {}
    bases = [r for r in ax['rows'] if r != 'BUY']
    for base in bases:
        b = ax['rows'][base]
        for k in range(depth + 1):
            for combo in itertools.combinations(ax['axes'], k):
                choices = [[t for t in opts[a] if t != b[a]] for a in combo]
                for pick in itertools.product(*choices):
                    vec = dict(b)
                    vec.update(dict(zip(combo, pick)))
                    key = tuple(vec[a] for a in ax['axes'])
                    if key in seen:
                        continue
                    if violates(vec, M.cons):
                        seen[key] = None
                        continue
                    seen[key] = (base, vec)
    judged_keys = {tuple(v[a] for a in ax['axes']): r for r, v in ax['rows'].items()}
    res = {}
    for key, bv in seen.items():
        if bv is None:
            continue
        base, vec = bv
        row = judged_keys.get(key)
        cells = M.cells(vec, row)
        t = tally1(cells, scenario, choice)
        if t['fails'] or t['unknown']:
            continue
        s = M.score(vec, row)
        unsupported = [c['req'] + ' ' + c['part'] for c in cells if not c['support']]
        res[key] = {'name': row or ('%s %s' % (base, name(vec, ax['rows'][base]))), 'judged': bool(row), 'vec': vec,
                    'novel': s['novel'], 'shoulds': len(t['s_met']), 'pairs': s['pairs'], 'open': t['open'],
                    's_met': t['s_met'], 'unsupported': unsupported}
    if not res:
        print('no row is in')
        return {}
    score = {k: (v['novel'], v['shoulds'], v['pairs']) for k, v in res.items()}
    ub = unbeaten(score)
    order = sorted(res, key=lambda k: (score[k][0] > min(x[0] for x in score.values()) + 1, -score[k][1], score[k][2], score[k][0]))
    considered = sum(1 for v in seen.values() if v)
    print('%d distinct rows within %d axis changes of a judged row (%d break a constraint); %d are in (%s%s).' % (
        considered, depth, sum(1 for v in seen.values() if v is None), len(res), scenario, ', ' + choice if choice else ''))
    print('Unbeaten by rule 3: %s' % ('; '.join(res[k]['name'] for k in ub)))
    print('%-60s %5s %5s %5s %5s %s' % ('row', 'novel', 'S', 'pairs', 'open', 'cells no judged row supports'))
    for k in order[:top]:
        v = res[k]
        print('%-60s %5d %5d %5d %5d %s' % (v['name'][:60], v['novel'], v['shoulds'], v['pairs'], v['open'],
                                          ', '.join(v['unsupported'][:8]) + (' ...' if len(v['unsupported']) > 8 else '')))
    if out:
        json.dump({'depth': depth, 'scenario': scenario, 'choice': choice, 'considered': considered,
                   'in': len(res), 'unbeaten': [res[k] for k in ub], 'top': [res[k] for k in order[:200]]},
                  open(out, 'w'), indent=1, ensure_ascii=False)
    return res


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd = argv[0]
    if cmd == 'check':
        return 1 if check(argv[1]) else 0
    if cmd == 'check-mech':
        return 1 if check_mech() else 0
    if cmd == 'check-cons':
        return 1 if check_cons() else 0
    if cmd == 'check-all':
        n = sum(check(g, quiet=False) if attrib(g) else (print('%s: no attribution file yet' % g) or 1) for g in GROUPS)
        n += check_mech() if os.path.exists(os.path.join(CL, 'mechanisms.json')) else (print('mechanisms: no file yet') or 1)
        n += check_cons()
        return 1 if n else 0
    if cmd == 'row':
        M = Model()
        vec = dict(M.ax['rows']['COMP'])
        for kv in argv[1].split(','):
            a, t = kv.split('=', 1)
            vec[a.strip()] = t.strip()
        cells = M.cells(vec)
        for sc in ('worded', 'restated'):
            t = tally1(cells, sc)
            print('%s: fails %s; open MUSTs %d; SHOULDs met %s; unknown %s' % (sc, t['fails'], t['open'], t['s_met'], t['unknown']))
        s = M.score(vec)
        print('novel %d, pairs %d, mechanisms %d' % (s['novel'], s['pairs'], len(s['mechs'])))
        print('cells no judged row supports: %s' % [c['req'] + ' ' + c['part'] for c in cells if not c['support']])
        print('broken constraints: %s' % [c.get('id') for c in violates(vec, M.cons)])
        return 0
    if cmd == 'mechrow':
        ax = axes()
        vec = dict(ax['rows'][argv[2]] if len(argv) > 2 else ax['rows']['COMP'])
        for kv in argv[1].split(','):
            if kv.strip():
                k, t = kv.split('=', 1)
                vec[k.strip()] = t.strip()
        ms = mech_rows()
        got = [ms[e['key']] for e in mech()['mechanisms'] if carries(e, vec)]
        pairs = sum(1 for x, y in itertools.combinations(got, 2)
                    if (set(x['writes']) & (set(y['reads']) | set(y['writes']))) or (set(y['writes']) & (set(x['reads']) | set(x['writes']))))
        print('novel %d, pairs %d, mechanisms %d: %s' % (sum(bool(m['novel']) for m in got), pairs, len(got), ' '.join(m['key'] for m in got)))
        return 0
    if cmd == 'search':
        depth = int(argv[argv.index('--depth') + 1]) if '--depth' in argv else 2
        sc = 'worded' if '--worded' in argv else 'restated'
        ch = argv[argv.index('--choice') + 1] if '--choice' in argv else None
        out = argv[argv.index('--out') + 1] if '--out' in argv else None
        search(depth, sc, ch, out=out)
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
