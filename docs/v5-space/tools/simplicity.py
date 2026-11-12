#!/usr/bin/env python3
"""The simplicity re-rank (DECISIONS V5-1 and V5-6): every row's rules, borrowed or not, counted at one grain.

Run from docs/v5-space. Standard library only, no network, deterministic.

  python3 tools/simplicity.py [rank] [--strict]   every row ranked by its rules (the mid count), with rule 3 beside it
  python3 tools/simplicity.py row NAME            one row's mechanisms, largest first, with counts, bases and owners
  python3 tools/simplicity.py diff A B            the mechanisms that differ between two rows, and their rules

The counts are judging/simplicity.json ('mechanisms'). A row's mechanisms come from tools/closure.py: the 20 study
rows' options are in judging/closure/axes.json, the 11 closure rows' in judging/closure/hybrids/cards.json, and a row
carries a mechanism when closure.py's carries() says so. The owner's base is added in three lines:
  BASE          simplicity.json's base 'mechanisms' (no dormant groups)
  BASE+dormant  its 'with_dormant' list (dormant groups for SC-13's 100,000 resources)
  BASE-ack      BASE without ack-stages, which no study row priced (V5-5 builds answer stages second)

A row's rules: each carried mechanism's count, less its row_minus for that row ('BASE' for the three base lines).
controller-hints rides with controller-commands (RIDES). In 'diff' and the footer, a '@per-resource' record and its
study record (and slow-leader-self and slow-leader-controller) hold the same rules, so they cancel (SAME).
low and high add the records' low and high the same way. Who owns each rule: the record's owner, or its
owner_by_row for that row, or its owner_split. issue-order (3) and timeline-merge (2) are in no line (see the footer).

Rule 3's numbers sit beside each row, as closure.py scores them: novel mechanisms and interacting pairs (DEV-01 and
DEV-02, Model.score), and SHOULDs met. The frame is the owner's (VERDICT 11.6): the clauses restated, DATA-01's loose
reading, JetStream's default test line accepted as a loss (the choice 'PERF-01 losses'). --strict adds DATA-01's
strict reading. 'r3' is rule 3's place pair by pair among the judged rows that fail no MUST (1 + the rows that beat
it), as the repro script's 'rank --loss' prints it (candidates/README.md). The base is no judged row: its rule-3
numbers are those of its option vector (MIN with Z par and C self), predicted by closure.py, marked '~'.
"""
import json, os, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import closure as C  # noqa: E402

DATA = os.path.join(ROOT, 'judging', 'simplicity.json')
OWNERS = ('fero', 'library', 'outside')
BASE_LINES = ('BASE', 'BASE+dormant', 'BASE-ack')
# The base's option vector: the closure tool's MIN row with Z par and C self (simplicity.json base.decisions[0]).
BASE_VEC = ('MIN', {'Z': 'par', 'C': 'self'})
# What the owner's decisions swap in that vector's carried list (base.decisions): records that move from #meta or the
# project to each resource's home log, the dormant groups kept as a variant, and the two new records.
BASE_SWAPS = {'meta-members': 'meta-members@per-resource', 'meta-catalog': 'meta-catalog@per-resource',
              'meta-directory': 'meta-directory@per-resource', 'healing-self': 'healing-self@per-resource',
              'planner-hints': 'planner-hints@per-resource',
              'genesis-conditional-create': 'genesis-conditional-create@per-resource',
              'cluster-version': 'cluster-version@per-resource', 'cluster-credentials': 'cluster-credentials@per-resource'}
BASE_ADDS = ('soft-directory', 'ack-stages')
BASE_VARIANT = 'dormant-groups'
# Records the closure catalogue folds into another and this tool carries beside it: controller-hints is DEP-17's hint
# path at a controller (RM-05 calls the hints inputs to the controller's loop), carried wherever controller-commands is.
RIDES = {'controller-hints': 'controller-commands'}
# Records that hold the same rules under another key (simplicity.json says so in each one's notes): every
# '@per-resource' record and its study record, and the slow-leader rule in its two forms. interval() counts their
# shared rules once: a pair in the two rows cancels to the fixed difference of its mid counts.
SAME = {'slow-leader-self': 'slow-leader-controller'}
NB = '\u00a0'
# Plain areas for the row view, so a row's rules can be read by what they do. A presentation choice of this tool;
# a '@per-resource' record takes its study record's area.
AREAS = (
    ('Raft', 'raft-log raft-term-vote raft-commit raft-config learners raft-snapshot raft-prevote-checkquorum '
             'raft-leader-transfer raft-readindex log-replicas'),
    ('other logs', 'writer-epoch-rlog loglet loglet-seal loglet-chain writer-epoch-slog isr-log isr-set high-watermark '
                   'leader-epoch eligible-leaders obj-log obj-manifest obj-writer-lease outside-log'),
    ('v4 kernel', 'v4-lanes v4-stamps v4-digests v4-tombstones v4-frontiers v4-orphans v4-sheds v4-latches v4-teachers '
                  'v4-floors v4-feed-words v4-views v4-ring v4-confirm-ladder'),
    ('many groups', 'link-pings quiet-groups dormant-groups slow-leader-controller slow-leader-self project-groups'),
    ('control', 'meta-members meta-catalog meta-directory healing-self controller-commands controller-hints planner-hints '
                'controller-sessions soft-directory genesis-conditional-create genesis-init cluster-version '
                'cluster-credentials'),
    ('partitions', 'slot-table slot-move move-policy slot-sequence lanes rekey split-record merge-record range-table '
                   'split-policy lineage'),
    ('writes', 'writer-judging dedup-window client-sessions producer-state caller-keys srchi-marks route-forward '
               'route-smart admission-credits ack-stages issue-order'),
    ('time', 'writer-time timestamp-oracle timeline-merge'),
    ('transactions', 'lock-rows fence-tokens saga-intents two-phase-commit mvcc ktxn-coordinator ktxn-markers'),
    ('storage', 'memory-rung none-rung journal wal-per-group lsm-store tier restore-mark dir-lease disk-incarnation '
                'par-repair'),
    ('reads', 'fold-all fold-leader fold-lazy fold-version subscribe read-lease closed-timestamps'),
    ('platform', 'worker-map side-seam leader-calls tenant-budget consumer-groups presence-rows queue-claims forks '
                 'input-recorder'),
)
AREA = {k: a for a, ks in AREAS for k in ks.split()}
EXTRAS = (('issue-order', 'every line'), ('timeline-merge', 'every line without a timestamp oracle (T tso)'))


def say(text, indent=''):
    """Print one paragraph, wrapped to 116 columns."""
    print(textwrap.fill(text, 116, initial_indent=indent, subsequent_indent=indent + '  ',
                        break_on_hyphens=False).replace(NB, ' '))


def nb(text):
    """One list item that say() keeps on one line."""
    return text.replace(' ', NB)


def load():
    with open(DATA) as f:
        return json.load(f)


def base_vec(ax):
    b0, ch = BASE_VEC
    v = dict(ax['rows'][b0])
    v.update(ch)
    return v


def rows(S):
    """name -> (option vector or None, carried mechanism keys), in a fixed order: 20 study rows, 11 closure rows, base."""
    ax = C.axes()
    cm = C.mech()['mechanisms']
    out = {}
    for nm, vec in C.all_rows(ax).items():
        ks = [e['key'] for e in cm if C.carries(e, vec)]
        out[nm] = (vec, ks + [k for k, host in RIDES.items() if host in ks])
    b = S['base']
    out['BASE'] = (None, list(b['mechanisms']))
    out['BASE+dormant'] = (None, list(b['with_dormant']))
    out['BASE-ack'] = (None, [k for k in b['mechanisms'] if k != 'ack-stages'])
    # The base list must be its vector's carried list with the decisions' swaps (a guard against drift).
    approx = [e['key'] for e in cm if C.carries(e, base_vec(ax))]
    want = [BASE_SWAPS.get(k, k) for k in approx if k != BASE_VARIANT] + list(BASE_ADDS)
    if sorted(want) != sorted(b['mechanisms']):
        raise SystemExit('simplicity.json base.mechanisms is not MIN (Z par, C self) with the decisions\' swaps: %s'
                         % sorted(set(want) ^ set(b['mechanisms'])))
    if sorted(b['with_dormant']) != sorted(b['mechanisms'] + [BASE_VARIANT]):
        raise SystemExit('simplicity.json base.with_dormant is not base.mechanisms plus %s' % BASE_VARIANT)
    noarea = sorted(k for k in S['mechanisms'] if k.split('@')[0] not in AREA)
    if noarea:
        raise SystemExit('no area for: %s' % ', '.join(noarea))
    missing = sorted({k for _, ks in out.values() for k in ks if k not in S['mechanisms']})
    if missing:
        raise SystemExit('no count in simplicity.json for: %s' % ', '.join(missing))
    return out


def minus_key(row):
    return 'BASE' if row in BASE_LINES else row


def items(S, row, keys):
    """One entry per carried mechanism: its rules in this row, low, high, basis, and rules per owner."""
    rk = minus_key(row)
    out = []
    for k in keys:
        m = S['mechanisms'][k]
        mi = (m.get('row_minus') or {}).get(rk, 0)
        n, lo, hi = m['count'] - mi, max(0, m['low'] - mi), max(0, m['high'] - mi)
        who = (m.get('owner_by_row') or {}).get(rk, m['owner'])
        own = dict.fromkeys(OWNERS, 0)
        if m.get('owner_split'):
            for o, c in m['owner_split'].items():
                own[o] += c
            own[m['owner']] -= mi
            who = '/'.join('%s %d' % (o, own[o]) for o in OWNERS if own[o])
        else:
            own[who] += n
        out.append({'key': k, 'n': n, 'lo': lo, 'hi': hi, 'minus': mi, 'basis': m['basis'], 'own': own, 'owner': who})
    return out


def basis_of(S, i):
    """One carried record's rules in this row by basis: its basis_split where its rules mix bases (a row_minus comes
    off the record's own basis), else all on its basis."""
    split = S['mechanisms'][i['key']].get('basis_split')
    if not split:
        return {i['basis']: i['n']}
    out = dict(split)
    out[i['basis']] = out.get(i['basis'], 0) - i['minus']
    return out


def total(its):
    t = {'n': sum(i['n'] for i in its), 'lo': sum(i['lo'] for i in its), 'hi': sum(i['hi'] for i in its), 'mechs': len(its)}
    for o in OWNERS:
        t[o] = sum(i['own'][o] for i in its)
    return t


def beats(x, y):
    """Rule 3, one pair (as the repro script): does x beat y? x, y = (novel, SHOULDs, pairs)."""
    if y[0] - x[0] >= 2:
        return True
    if x[0] - y[0] >= 2:
        return False
    return x[1] > y[1] or (x[1] == y[1] and x[2] < y[2])


def rule3(strict):
    """Rule 3's numbers on the owner's frame for every judged row, and the base's predicted from its vector."""
    M = C.Model()
    choice = ('PERF-01 losses',) + (('DATA-01 reading',) if strict else ())
    res = {}
    for nm, vec in C.all_rows(M.ax).items():
        t = C.tally1(M.cells(vec, row=nm, with_support=False), 'restated', choice)
        s = M.score(vec, nm)
        res[nm] = {'novel': s['novel'], 'S': len(t['s_met']), 'pairs': s['pairs'], 'fails': t['fails'], 'open': t['open'],
                   'approx': False}
    cs = M.cells(base_vec(M.ax))
    t = C.tally1(cs, 'restated', choice)
    s = M.score(base_vec(M.ax))
    guessed = [c['req'] + ' ' + c['part'] for c in cs if not c['support']]
    b = {'novel': s['novel'], 'S': len(t['s_met']), 'pairs': s['pairs'], 'fails': t['fails'], 'open': t['open'],
         'approx': True, 'guessed': guessed}
    for nm in BASE_LINES:
        res[nm] = b
    inn = [nm for nm in res if not res[nm]['fails'] and not res[nm]['approx']]
    sc = {nm: (res[nm]['novel'], res[nm]['S'], res[nm]['pairs']) for nm in res}
    for nm in res:
        if not res[nm]['fails']:
            res[nm]['place'] = 1 + sum(1 for o in inn if o != nm and beats(sc[o], sc[nm]))
    return res, len(inn)


def same(k):
    """The key whose rules this record holds: a '@per-resource' record's study record, or SAME's."""
    k = k.split('@')[0]
    return SAME.get(k, k)


def interval(S, a, ka, b, kb):
    """A's rules less B's, counted on the mechanisms that differ only, with low and high. A record in both rows cancels;
    so does a pair that holds the same rules under two keys (same()), to the fixed difference of its mid counts."""
    ia = {same(i['key']): i for i in items(S, a, ka)}
    ib = {same(i['key']): i for i in items(S, b, kb)}
    assert len(ia) == len(ka) and len(ib) == len(kb), 'a row carries both records of a pair'
    d = lo = hi = 0
    for k, i in ia.items():
        if k in ib:
            x = i['n'] - ib[k]['n']
            d, lo, hi = d + x, lo + x, hi + x
        else:
            d, lo, hi = d + i['n'], lo + i['lo'], hi + i['hi']
    for k, i in ib.items():
        if k not in ia:
            d, lo, hi = d - i['n'], lo - i['hi'], hi - i['lo']
    return d, lo, hi


def find(R, name):
    if name in R:
        return name
    low = {k.lower(): k for k in R}
    if name.lower() in low:
        return low[name.lower()]
    raise SystemExit('no row %r. Rows: %s' % (name, ', '.join(R)))


def place_in(T, judged_in, nm, f='n'):
    """1 + the judged rows in with fewer rules: where a line falls among them (for a base line, where it would fall)."""
    return 1 + sum(1 for o in judged_in if o != nm and T[o][f] < T[nm][f])


def cmd_rank(S, R, strict):
    T = {nm: total(items(S, nm, ks)) for nm, (_, ks) in R.items()}
    r3, nin = rule3(strict)
    order = sorted(R, key=lambda nm: (T[nm]['n'], T[nm]['lo'], T[nm]['hi'], nm))
    jin = [nm for nm in order if not r3[nm]['fails'] and not r3[nm]['approx']]
    frame = 'restated, DATA-01 %s, JetStream\'s default test line accepted as a loss' % ('strict' if strict else 'loose')
    say('Simplicity: every rule a builder must get right, borrowed or not (judging/simplicity.json). Ranked by rules '
        '(the mid count). # = place among all %d lines. in = place among the %d judged rows that fail no MUST on the '
        'frame (for a base line, where it would fall among them).' % (len(order), len(jin)))
    say('Rule 3 beside it, as closure.py scores it, on the frame: %s. novel = novel mechanisms, S = SHOULDs met, '
        'pairs = interacting pairs, open = MUSTs left open (neither measure counts them), r3 = rule 3\'s place among '
        'the same %d rows.' % (frame, nin))
    print()
    print('%3s %3s  %-24s %5s %5s %5s  %5s %5s %7s  %5s | %5s %3s %5s %5s  %s' % (
        '#', 'in', 'row', 'rules', 'low', 'high', 'fero', 'lib', 'outside', 'mechs', 'novel', 'S', 'pairs', 'open', 'r3'))
    for nm in order:
        t, x = T[nm], r3[nm]
        place = 1 + sum(1 for o in order if T[o]['n'] < t['n'])
        ap = '~' if x['approx'] else ''
        pin = '-' if x['fails'] else ap + str(place_in(T, jin, nm))
        if x['fails']:
            r3s = 'out: %d MUST%s' % (len(x['fails']), '' if len(x['fails']) == 1 else 's')
        else:
            r3s = '%s%d' % (ap, x['place'])
        print('%3d %3s  %-24s %5d %5d %5d  %5d %5d %7d  %5d | %5s %3s %5s %5s  %s' % (
            place, pin, nm, t['n'], t['lo'], t['hi'], t['fero'], t['library'], t['outside'], t['mechs'],
            ap + str(x['novel']), ap + str(x['S']), ap + str(x['pairs']), ap + str(x['open']), r3s))
    print()
    b = r3['BASE']
    say('~ The base is no judged row. Its rule-3 numbers are those of its option vector (MIN with Z par and C self), '
        'predicted by closure.py with %d guessed cell%s (%s). The per-resource records, the soft directory and ack '
        'stages are not in its catalogue. Its "in" and r3 are where it would fall among the judged rows in.' % (
            len(b['guessed']), '' if len(b['guessed']) == 1 else 's', ', '.join(b['guessed']) or 'none'))
    # The order at the bounds: every record at its low count, or every record at its high count.
    print()
    pl = lambda nm: nb('%s %d / %d / %d') % (nm, place_in(T, jin, nm, 'lo'), place_in(T, jin, nm), place_in(T, jin, nm, 'hi'))
    say('At the bounds, place among the rows in, with every record at its low count / mid / every record at its high '
        'count: %s.' % '; '.join(pl(nm) for nm in BASE_LINES))
    moved = [nm for nm in jin if max(place_in(T, jin, nm, f) for f in ('lo', 'n', 'hi'))
             - min(place_in(T, jin, nm, f) for f in ('lo', 'n', 'hi')) > 5]
    say('Judged rows in whose place moves by more than 5 between low, mid and high: %s.' % ('; '.join(pl(nm) for nm in moved) or 'none'), '  ')
    # The base against every other line, on the mechanisms that differ only, each record free between its bounds.
    fewer, more, either = [], [], []
    for nm in order:
        if nm in BASE_LINES:
            continue
        d, lo, hi = interval(S, nm, R[nm][1], 'BASE', R['BASE'][1])
        (fewer if hi < 0 else more if lo > 0 else either).append(nb('%s %+d [%+d..%+d]' % (nm, d, lo, hi)))
    print()
    say('Each line less BASE, on the mechanisms that differ (shared records cancel; each record free between its own '
        'low and high), mid [low..high]:')
    say('fewer rules at every bound (%d): %s' % (len(fewer), '; '.join(fewer) or 'none'), '  ')
    say('more rules at every bound (%d): %s' % (len(more), '; '.join(more) or 'none'), '  ')
    say('could go either way (%d): %s' % (len(either), '; '.join(either) or 'none'), '  ')
    # Where the two orders differ most, among the judged rows in.
    print()
    mv = [(place_in(T, jin, nm) - r3[nm]['place'], nm) for nm in jin]
    step = lambda nm: nb('%s %d -> %d' % (nm, r3[nm]['place'], place_in(T, jin, nm)))
    say('Against rule 3, among the judged rows in (r3 -> in), moving 5 or more places:')
    say('up: %s.' % ('; '.join(step(nm) for d, nm in sorted(mv) if d <= -5) or 'none'), '  ')
    say('down: %s.' % ('; '.join(step(nm) for d, nm in sorted(mv, key=lambda x: (-x[0], x[1])) if d >= 5) or 'none'), '  ')
    # issue-order and timeline-merge: in no line; what adding them alike would do.
    add = {}
    for nm, (vec, _) in R.items():
        oracle = vec is not None and vec.get('T') == 'tso'
        add[nm] = sum(S['mechanisms'][k]['count'] for k, where in EXTRAS
                      if where == 'every line' or not oracle)
    flips = ties = 0
    names = list(R)
    for i, a in enumerate(names):
        for c in names[i + 1:]:
            x0, x1 = T[a]['n'] - T[c]['n'], T[a]['n'] + add[a] - T[c]['n'] - add[c]
            if x0 * x1 < 0:
                flips += 1
            elif (x0 == 0) != (x1 == 0):
                ties += 1
    print()
    say('In no line: %s. Added as A-10 and V5-4 say (%s), they flip %d pair%s of lines and make or break %d tie%s; '
        'BASE then has %d rules.' % (
            ', '.join('%s (%d)' % (k, S['mechanisms'][k]['count']) for k, _ in EXTRAS),
            '; '.join('%s on %s' % (k, w) for k, w in EXTRAS),
            flips, '' if flips == 1 else 's', ties, '' if ties == 1 else 's', T['BASE']['n'] + add['BASE']))
    return 0


def cmd_row(S, R, name):
    nm = find(R, name)
    its = sorted(items(S, nm, R[nm][1]), key=lambda i: (-i['n'], i['key']))
    t = total(its)
    by = {}
    for i in its:
        for b, c in basis_of(S, i).items():
            by[b] = by.get(b, 0) + c
    print('%s: %d mechanisms, %d rules (low %d, high %d); fero %d, library %d, outside %d.' % (
        nm, t['mechs'], t['n'], t['lo'], t['hi'], t['fero'], t['library'], t['outside']))
    print('By basis, by rule: %s.' % ', '.join('%s %d' % (k, by[k]) for k in sorted(by, key=lambda k: (-by[k], k))))
    ar = {}
    for i in its:
        a = AREA[i['key'].split('@')[0]]
        ar[a] = ar.get(a, 0) + i['n']
    say('By area: %s.' % ', '.join(nb('%s %d' % (a, ar[a])) for a, _ in AREAS if a in ar))
    print()
    print('%5s %4s %4s  %-14s %-22s %s' % ('rules', 'low', 'high', 'basis', 'owner', 'mechanism'))
    for i in its:
        print('%5d %4d %4d  %-14s %-22s %s%s' % (i['n'], i['lo'], i['hi'], i['basis'], i['owner'], i['key'],
                                                 '  (%d less here: row_minus)' % i['minus'] if i['minus'] else ''))
    return 0


def cmd_diff(S, R, a, b):
    a, b = find(R, a), find(R, b)
    ia = {same(i['key']): i for i in items(S, a, R[a][1])}
    ib = {same(i['key']): i for i in items(S, b, R[b][1])}
    ta, tb = total(list(ia.values())), total(list(ib.values()))
    d, lo, hi = interval(S, a, R[a][1], b, R[b][1])
    print('%s: %d rules (%d mechanisms). %s: %d rules (%d mechanisms).' % (a, ta['n'], ta['mechs'], b, tb['n'], tb['mechs']))
    print('%s less %s: %+d, and %+d to %+d at the low and high counts of the mechanisms that differ.' % (a, b, d, lo, hi))
    for title, xs in (('Only in %s' % a, [ia[k] for k in ia if k not in ib]), ('Only in %s' % b, [ib[k] for k in ib if k not in ia])):
        xs = sorted(xs, key=lambda i: (-i['n'], i['key']))
        print()
        print('%s (%d mechanisms, %d rules, low %d, high %d):' % (title, len(xs), sum(i['n'] for i in xs),
                                                                  sum(i['lo'] for i in xs), sum(i['hi'] for i in xs)))
        for i in xs:
            print('  %4d  %-14s %-22s %s' % (i['n'], i['basis'], i['owner'], i['key']))
    both = sorted(k for k in ia if k in ib and (ia[k]['n'] != ib[k]['n'] or ia[k]['owner'] != ib[k]['owner']
                                                or ia[k]['key'] != ib[k]['key']))
    print()
    print('In both, counted, owned or keyed differently (%d; a pair under two keys holds the same rules):' % len(both))
    for k in both:
        x, y = ia[k], ib[k]
        print('  %s %s %d (%s); %s %s %d (%s)' % (a, x['key'], x['n'], x['owner'], b, y['key'], y['n'], y['owner']))
    return 0


def main(argv):
    S = load()
    R = rows(S)
    strict = '--strict' in argv
    argv = [x for x in argv if x != '--strict']
    cmd = argv[0] if argv else 'rank'
    if cmd == 'rank' and len(argv) <= 1:
        return cmd_rank(S, R, strict)
    if cmd == 'row' and len(argv) == 2:
        return cmd_row(S, R, argv[1])
    if cmd == 'diff' and len(argv) == 3:
        return cmd_diff(S, R, argv[1], argv[2])
    print(__doc__)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:  # piped into head: stop quietly
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)
