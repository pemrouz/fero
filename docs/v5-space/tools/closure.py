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
  python3 tools/closure.py row 'C=cent-co' [BASE]     predict one row: BASE (a judged row or a seed, default COMP) changed
  python3 tools/closure.py card 'C=cent-co' [BASE]    a row's full predicted scorecard: every cell, its reason, the judged rows behind it
  python3 tools/closure.py mechrow 'C=cent-co,Z=par' [BASE]   mechanisms only: novel count and pairs of BASE (default COMP) changed
  python3 tools/closure.py ladder [--worded] [--choice C [--only REQ]]
        rule 3 among the rows that are in, as more cells without a supporting judged row are allowed
  python3 tools/closure.py search [--depth N] [--worded] [--choice C [--only REQ]] [--out F]
        every row within N axis changes of a judged row or a seed, then around the best rows, ranked by rule 3
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
                bad = [t for t in tags if t not in ax['options'].get(a, [])]
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

SEEDS = {
    # The rows the VERDICT review built by hand (VERDICT.md sections 1 and 10), as changes to a judged row.
    'COMP2': ('COMP', {'C': 'cent-co', 'Z': 'par'}),
    'COMP+par': ('COMP', {'Z': 'par'}),
    'MIN-P+m': ('COMP', {'C': 'cent-co'}),
    'MIN-P+par': ('MIN-P', {'Z': 'par'}),
    'SPLIT2': ('SPLIT', {'D': 'sess', 'C': 'cent-co', 'V': '+lrn', 'P': 'split+merge', 'Z': 'par'}),
    'PD+fix': ('PD', {'Z': 'rejoin', 'S': 'lsm +tier', 'Q': 'mix'}),
    'H2': ('COMP', {'C': 'cent-co', 'P': 'split+merge', 'O': 'off+lin'}),
}


class Model:
    def __init__(self):
        self.ax = axes()
        self.parts = []
        for g in GROUPS:
            a = attrib(g)
            if a is None:
                raise SystemExit('missing attribution for %s' % g)
            for p in a['parts']:
                q = dict(p, group=g)
                q['_rules'] = [(tuple((k, frozenset(v)) for k, v in r['when'].items()), r) for r in p.get('rules', [])]
                q['_axes_upto'] = []
                acc = set()
                for r in p.get('rules', []):
                    acc |= set(r['when'])
                    q['_axes_upto'].append(tuple(sorted(acc)))
                q['_all'] = tuple(sorted(acc))
                q['_cache'] = {}
                self.parts.append(q)
        ms = mech_rows()
        self.mech = [(e, ms[e['key']]) for e in mech()['mechanisms']]
        self.cons = cons()
        self.judged = self.ax['rows']
        self._pairs = {}

    def cell(self, p, vec):
        """(index of the rule that fires or 'else', the rule) for an unjudged row; cached on the deciding tags."""
        key = tuple(vec[a] for a in p['_all'])
        hit = p['_cache'].get(key)
        if hit is None:
            hit = ('else', p.get('else'))
            for i, (w, r) in enumerate(p['_rules']):
                if all(vec[a] in tags for a, tags in w):
                    hit = (i, r)
                    break
            p['_cache'][key] = hit
        return hit

    def support(self, p, vec, i):
        """The judged rows that get the same cell for the same reason: the same rule fires for them, and they hold
        vec's own tags on that rule's axes. For else, they also fall to else and hold vec's tags on every axis the
        part names. Overridden rows never count."""
        ov = p.get('overrides') or {}
        if i == 'else':
            axs = p['_all']
        else:
            axs = tuple(k for k, _ in p['_rules'][i][0])
        out = []
        for r, v in self.judged.items():
            if r in ov or not all(v[a] == vec[a] for a in axs):
                continue
            if self.cell(p, v)[0] == i:
                out.append(r)
        return out

    def cells(self, vec, row=None, with_support=True):
        out = []
        for p in self.parts:
            if row and row in (p.get('overrides') or {}):
                i, r = 'override', p['overrides'][row]
            else:
                i, r = self.cell(p, vec)
            c = {'req': p['req'], 'part': p['part'], 'group': p['group'], 'rule': i}
            if r is None:
                c['v'] = None
            else:
                c.update({f: r.get(f) for f in FIELDS})
                c['gap'] = r.get('gap')
            if with_support:
                c['support'] = [row] if row else self.support(p, vec, i) if r is not None else []
            out.append(c)
        return out

    def mechs(self, vec):
        return [m for e, m in self.mech if carries(e, vec)]

    def score(self, vec, row=None):
        ms = self.mechs(vec)
        key = frozenset(m['key'] for m in ms)
        if key not in self._pairs:
            pairs = 0
            for a, b in itertools.combinations(ms, 2):
                ta, tb = set(a['reads']) | set(a['writes']), set(b['reads']) | set(b['writes'])
                if (set(a['writes']) & tb) or (set(b['writes']) & ta):
                    pairs += 1
            self._pairs[key] = (sum(bool(m['novel']) for m in ms), pairs)
        novel, pairs = self._pairs[key]
        return {'mechs': sorted(key), 'novel': novel, 'pairs': pairs}


def tally1(cells, scenario='restated', choice=None, only_req=None):
    t = {'fails': [], 'open': 0, 'met': 0, 's_met': [], 's_not': [], 's_open': [], 'gap': 0.0, 'unknown': [], 'fail_cells': []}
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
                t['fails'].append(c['req']); t['fail_cells'].append(c); t['gap'] += float(c.get('gap') or 0)
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


def r3key(score, lo):
    """An order that lists rule 3's unbeaten rows first: rows within one novel mechanism of the fewest, then SHOULDs, then pairs."""
    n, s, p = score
    return (n > lo + 1, -s, p, n)


def name(vec, base):
    return ' '.join('%s=%s' % (a, vec[a]) for a in vec if vec[a] != base[a])


class Search:
    def __init__(self, scenario='restated', choice=None, only_req=None):
        self.M = Model()
        ax = self.M.ax
        self.axes = ax['axes']
        self.opts = {a: [t for t in ax['options'][a] if t not in ('theirs', 'outside', 'ts client')] for a in self.axes}
        self.scenario, self.choice, self.only_req = scenario, choice, only_req
        self.res = {}       # key -> result
        self.broken = 0
        self.judged_keys = {self.key(v): r for r, v in ax['rows'].items()}

    def key(self, vec):
        return tuple(vec[a] for a in self.axes)

    def neighbours(self, base, depth):
        for k in range(depth + 1):
            for combo in itertools.combinations(self.axes, k):
                choices = [[t for t in self.opts[a] if t != base[a]] for a in combo]
                for pick in itertools.product(*choices):
                    vec = dict(base)
                    vec.update(dict(zip(combo, pick)))
                    yield vec

    def label(self, vec):
        """A row's name: the judged row or seed it differs least from, then the differences."""
        named = dict(self.M.ax['rows'])
        for nm, (b0, ch) in SEEDS.items():
            v = dict(named[b0]); v.update(ch); named[nm] = v
        best = min(((sum(vec[a] != v[a] for a in self.axes), nm) for nm, v in named.items() if nm != 'BUY'))
        return (best[1] + ' ' + name(vec, named[best[1]])).strip()

    def evaluate(self, vec, label):
        k = self.key(vec)
        if k in self.res:
            return self.res[k]
        M = self.M
        if violates(vec, M.cons):
            self.res[k] = None
            self.broken += 1
            return None
        row = self.judged_keys.get(k)
        cells = M.cells(vec, row, with_support=False)
        t = tally1(cells, self.scenario, self.choice, self.only_req)
        # a fail counts only when some judged row supports it; an unsupported fail marks the row for judging
        sup_fail, unsup_fail = [], []
        for c in t['fail_cells']:
            p = [q for q in M.parts if q['req'] == c['req'] and q['part'] == c['part']][0]
            sup = [row] if row else M.support(p, vec, c['rule'])
            (sup_fail if sup else unsup_fail).append(c['req'])
        s = M.score(vec, row)
        r = {'name': row or self.label(vec), 'judged': bool(row), 'vec': vec, 'novel': s['novel'], 'shoulds': len(t['s_met']),
             'pairs': s['pairs'], 'open': t['open'], 'met': t['met'], 's_met': t['s_met'], 's_open': t['s_open'],
             'fails': sup_fail, 'unsupported_fails': unsup_fail, 'unknown': t['unknown']}
        self.res[k] = r
        return r

    def expand(self, base_vec, base_label, depth):
        for vec in self.neighbours(base_vec, depth):
            self.evaluate(vec, (base_label + ' ' + name(vec, base_vec)).strip())

    def ranked(self, lenient):
        inn = {k: r for k, r in self.res.items() if r and not r['fails'] and not r['unknown'] and (lenient or not r['unsupported_fails'])}
        if not inn:
            return [], [], inn
        sc = {k: (r['novel'], r['shoulds'], r['pairs']) for k, r in inn.items()}
        lo = min(v[0] for v in sc.values())
        order = sorted(inn, key=lambda k: r3key(sc[k], lo) + (inn[k]['name'],))
        return unbeaten(sc), order, inn

    def run(self, depth=2, rounds=4, top=25):
        ax = self.M.ax
        for r, v in ax['rows'].items():
            if r != 'BUY':
                self.expand(v, r, depth)
        for nm, (b, ch) in SEEDS.items():
            vec = dict(ax['rows'][b]); vec.update(ch)
            self.evaluate(vec, nm)
            self.expand(vec, nm, depth)
        first = len(self.res)
        done = set()
        for rnd in range(rounds):
            _, order, inn = self.ranked(lenient=True)
            todo = [k for k in order[:top] if k not in done]
            if not todo:
                break
            for k in todo:
                done.add(k)
                self.expand(inn[k]['vec'], inn[k]['name'], depth)
        return first


def cell_report(M, vec, row=None):
    cells = M.cells(vec, row)
    return [c['req'] + ' ' + c['part'] for c in cells if not c['support']]


def search(depth=2, scenario='restated', choice=None, only_req=None, top=30, out=None, rounds=4, quiet=False):
    S = Search(scenario, choice, only_req)
    first = S.run(depth, rounds)
    total = len(S.res)
    ok = sum(1 for r in S.res.values() if r)
    res = {}
    for lenient in (False, True):
        ub, order, inn = S.ranked(lenient)
        res['lenient' if lenient else 'strict'] = (ub, order, inn)
    if not quiet:
        print('Searched %d rows: every row within %d axis changes of a judged row or a seed (%d), then %d more around the best rows; %d break a constraint.' % (
            total, depth, first, total - first, S.broken))
        print('Scenario: %s%s.' % (scenario, (', choice ' + choice + (' (' + only_req + ' only)' if only_req else '')) if choice else ''))
        for lab in ('strict', 'lenient'):
            ub, order, inn = res[lab]
            print()
            print('%s: %d rows are in%s.' % (lab.upper(), len(inn), '' if lab == 'strict' else ' when a fail no judged row supports is set aside'))
            if not inn:
                continue
            print('Unbeaten by rule 3: %s' % '; '.join(inn[k]['name'] for k in ub))
            print('%-58s %5s %3s %5s %5s  %s' % ('row', 'novel', 'S', 'pairs', 'open', 'unsupported fails / cells no judged row supports'))
            for k in order[:top]:
                v = inn[k]
                uns = cell_report(S.M, v['vec'], k in S.judged_keys and S.judged_keys[k])
                print('%-58s %5d %3d %5d %5d  %s | %d: %s' % (v['name'][:58], v['novel'], v['shoulds'], v['pairs'], v['open'],
                      ','.join(v['unsupported_fails']) or '-', len(uns), ', '.join(uns[:6]) + (' ...' if len(uns) > 6 else '')))
    if out:
        dump = {}
        for lab in ('strict', 'lenient'):
            ub, order, inn = res[lab]
            dump[lab] = {'in': len(inn), 'unbeaten': [dict(inn[k], unsupported=cell_report(S.M, inn[k]['vec'])) for k in ub],
                         'top': [dict(inn[k], unsupported=cell_report(S.M, inn[k]['vec'])) for k in order[:100]]}
        json.dump({'depth': depth, 'scenario': scenario, 'choice': choice, 'only_req': only_req, 'searched': total,
                   'broken': S.broken, **dump}, open(out, 'w'), indent=1, ensure_ascii=False)
    return res, S


def ladder(scenario='restated', choice=None, only_req=None, caps=(0, 1, 2, 3, 5, 8, 12, 20, 40, 148), top=6, depth=2):
    """Rule 3 among the rows that are in, as the number of cells no judged row supports is allowed to grow."""
    res, S = search(depth, scenario, choice, only_req, quiet=True)
    ub, order, inn = res['strict']
    M = S.M
    rows = []
    for k in order:
        r = inn[k]
        uns = cell_report(M, r['vec'], S.judged_keys.get(k))
        rows.append((len(uns), r, uns))
    head = 'Scenario: %s%s. %d rows searched, %d in.' % (scenario, (', choice ' + choice + (' (' + only_req + ' only)' if only_req else '')) if choice else '', len(S.res), len(inn))
    out = [head, '', '| At most this many unsupported cells | Rows in | Rule 3 unbeaten | novel / SHOULDs / pairs / open MUSTs | Unsupported cells of the first |', '|---|---|---|---|---|']
    tops = []
    for cap in caps:
        sel = {i: (r['novel'], r['shoulds'], r['pairs']) for i, (n, r, u) in enumerate(rows) if n <= cap}
        if not sel:
            out.append('| %d | 0 | none | | |' % cap)
            continue
        u = C_unbeaten = unbeaten(sel)
        lo = min(v[0] for v in sel.values())
        first = sorted(u, key=lambda i: (rows[i][0], rows[i][1]['name']))[0]
        n, r, uns = rows[first]
        out.append('| %d | %d | %s | %d / %d / %d / %d | %s |' % (cap, len(sel), '; '.join(rows[i][1]['name'] for i in u[:6]) + (' (+%d more)' % (len(u) - 6) if len(u) > 6 else ''),
                   r['novel'], r['shoulds'], r['pairs'], r['open'], ', '.join(uns) if len(uns) <= 12 else ', '.join(uns[:12]) + ' and %d more' % (len(uns) - 12)))
        tops.append((cap, [rows[i] for i in sorted(sel, key=lambda i: r3key(sel[i], lo))[:top]]))
    out += ['', 'The first rows at each step:', '']
    for cap, lst in tops:
        out.append('- at most %d: ' % cap + '; '.join('%s (%d/%d/%d, %d unsupported)' % (r['name'], r['novel'], r['shoulds'], r['pairs'], n) for n, r, u in lst))
    return '\n'.join(out), rows, S


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
        base = argv[2] if len(argv) > 2 else 'COMP'
        if base in SEEDS:
            b0, ch = SEEDS[base]
            vec = dict(M.ax['rows'][b0]); vec.update(ch)
        else:
            vec = dict(M.ax['rows'][base])
        for kv in argv[1].split(','):
            if kv.strip():
                a_, t = kv.split('=', 1)
                vec[a_.strip()] = t.strip()
        cells = M.cells(vec)
        for sc in ('worded', 'restated'):
            t = tally1(cells, sc)
            print('%s: fails %s; open MUSTs %d; SHOULDs met %s; unknown %s' % (sc, t['fails'], t['open'], t['s_met'], t['unknown']))
        s_ = M.score(vec)
        print('novel %d, pairs %d, mechanisms %d' % (s_['novel'], s_['pairs'], len(s_['mechs'])))
        print('cells no judged row supports: %s' % [c['req'] + ' ' + c['part'] for c in cells if not c['support']])
        print('broken constraints: %s' % [c.get('id') for c in violates(vec, M.cons)])
        return 0
    if cmd == 'card':
        M = Model()
        base = argv[2] if len(argv) > 2 else 'COMP'
        if base in SEEDS:
            b0, ch = SEEDS[base]
            vec = dict(M.ax['rows'][b0]); vec.update(ch)
        else:
            vec = dict(M.ax['rows'][base])
        for kv in argv[1].split(','):
            if kv.strip():
                a_, t = kv.split('=', 1)
                vec[a_.strip()] = t.strip()
        print('Row: ' + ', '.join('%s %s' % (a_, vec[a_]) for a_ in M.ax['axes']))
        sc = M.score(vec)
        print('Mechanisms (%d, %d novel, %d pairs): %s' % (len(sc['mechs']), sc['novel'], sc['pairs'], ' '.join(sc['mechs'])))
        print('| Req | Part | Predicted | Restated / alt | Depends on | Supported by | Why (the rule\'s basis) |')
        print('|---|---|---|---|---|---|---|')
        for c, p in zip(M.cells(vec), M.parts):
            i, r = M.cell(p, vec)
            basis = (r or {}).get('basis', '').replace('|', '/').replace('\n', ' ')
            print('| %s | %s | %s | %s | %s | %s | %s |' % (c['req'], c['part'], c['v'], c.get('alt') or '', c.get('depends_on') or '',
                  ', '.join(c['support']) or '**none**', basis[:400]))
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
    if cmd == 'ladder':
        g = lambda f, d=None: argv[argv.index(f) + 1] if f in argv else d
        txt, _, _ = ladder('worded' if '--worded' in argv else 'restated', g('--choice'), g('--only'))
        print(txt)
        return 0
    if cmd == 'search':
        g = lambda f, d=None: argv[argv.index(f) + 1] if f in argv else d
        search(int(g('--depth', 2)), 'worded' if '--worded' in argv else 'restated', g('--choice'), g('--only'),
               int(g('--top', 30)), g('--out'), int(g('--rounds', 4)))
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
