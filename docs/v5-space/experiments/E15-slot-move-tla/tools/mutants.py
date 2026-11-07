#!/usr/bin/env python3
"""
mutants.py: REQUIREMENTS DEV-10's mechanical mutants of the fixed protocol
(tla/SlotMoveFixed.tla), made from the text between MUTATE-BEGIN and
MUTATE-END (minus the MUTATE-PAUSE block), and run under TLC.

    python3 tools/mutants.py --list            # the mutants, one a line
    python3 tools/mutants.py --run [--slice k/n]
    python3 tools/mutants.py --table           # results/mutants.md

The kinds (DEV-10 (d)):
  G  drop a guard conjunct: one bullet item `/\\ ...` (a line of a vertical
     conjunction list) that holds no step (no `Go(`) becomes TRUE;
  C  turn < into <=, <= into <, > into >=, >= into > (also PLt <-> PLe on
     positions and VLt -> VLe on table versions), one occurrence at a time;
  U  drop a state update: `Upd(old, new)` becomes `old`, and an argument of
     a step `Go(shards', table', cl', net', ...)` that changes a variable
     becomes the unchanged variable (the bookkeeping arguments started,
     recovered and maxpos are bounds of the model and are left alone);
  S  swap two updates in one action: none arise, since every action of
     this text appends at most one entry (said in the README).
Lines tagged `\\* env` are bounds of the model (moves allowed, the calm
world, one recovery, no duplicate send), not rules, and are left alone.

Each mutant is checked on the bounds move, dedup, deep and write in turn,
safety first (TLC stops at the first broken property), until one breaks.
A mutant no safety run catches is then checked for property 7 on move and
write (the calm graph). One that nothing catches is "equivalent" if its
state counts equal the fixed protocol's on all four bounds, else
"survived". A mutant TLC cannot evaluate (for example a dropped domain
guard that makes a function be read outside its domain) is "ill-formed".
"""
import argparse
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import tlcrun  # noqa: E402
import agef  # noqa: E402

SRC = os.path.join(ROOT, 'tla', 'SlotMoveFixed.tla')
WORK = os.path.join(tlcrun.SP, 'e15', 'mutants')
OUTF = os.path.join(ROOT, 'results', 'mutants.json')
BOUNDS = os.environ.get('E15_MUT_BOUNDS', 'move,dedup,deep,write0').split(',')
# write0 is `write` without depositions (one write to s, one resend, either
# shard, one move, one recovery): it keeps the case fix 5 guards (a position
# reused after a recovered target's abort) at a fraction of `write`'s size.
# The mechanical mutants use it in place of `write` to stay in the budget.
HEAVY = True

OPEN = {'(': ')', '{': '}', '[': ']', '<<': '>>'}
CLOSE = {v: k for k, v in OPEN.items()}
TOK = re.compile(r'<<|>>|[(){}\[\]]')


def region(lines):
    """Indexes of the lines that may be mutated."""
    out, on = [], False
    for i, l in enumerate(lines):
        tag = l.strip()
        if tag.startswith(('\\* MUTATE-BEGIN', '\\* MUTATE-RESUME')):
            on = True
            continue
        if tag.startswith(('\\* MUTATE-END', '\\* MUTATE-PAUSE')):
            on = False
            continue
        if on:
            out.append(i)
    return out


def code(l):
    """The line without its trailing comment."""
    j = l.find('\\*')
    return l if j < 0 else l[:j]


def balanced_prefix(text):
    """Split text into the longest prefix whose brackets never go below zero
    depth and the rest (from the first unmatched closer)."""
    depth = 0
    for m in TOK.finditer(text):
        t = m.group(0)
        if t in OPEN:
            depth += 1
        else:
            depth -= 1
            if depth < 0:
                return text[:m.start()].rstrip(), text[m.start():]
    return text.rstrip(), ''


def bullets(lines, reg):
    """Every bullet `/\\` in the region: (line, column)."""
    regs = set(reg)
    cols = {i: [m.start() for m in re.finditer(r'/\\', code(lines[i]))] for i in reg}
    out = []
    for i in reg:
        for c in cols[i]:
            first = code(lines[i])[:c].strip() == ''
            sib = any(c in cols.get(j, []) for j in (i - 1, i + 1) if j in regs)
            after = code(lines[i])[:c].rstrip()
            lead = after.endswith(('IF', ':', '(', '==', '\\/', 'THEN', 'ELSE', 'IN'))
            if first or (sib and lead) or (sib and first):
                out.append((i, c))
    return out


def item_extent(lines, reg, i, c):
    regs = set(reg)
    j = i + 1
    while j in regs:
        s = code(lines[j])
        if s.strip() == '':
            j += 1
            continue
        if len(s) - len(s.lstrip()) <= c:
            break
        j += 1
    return j


def make(lines):
    reg = region(lines)
    muts = []
    # G: drop a guard conjunct
    for i, c in bullets(lines, reg):
        if lines[i].rstrip().endswith('\\* env'):
            continue
        j = item_extent(lines, reg, i, c)
        text = ' '.join(code(lines[k]) if k > i else code(lines[k])[c + 2:] for k in range(i, j))
        if 'Go(' in text or 'Do(' in text:
            continue
        body, rest = balanced_prefix(text.strip())
        new = list(lines)
        new[i] = code(lines[i])[:c] + '/\\ TRUE' + (' ' + rest if rest else '')
        for k in range(i + 1, j):
            new[k] = ''
        muts.append(('G', i + 1, f'drop guard: {body.strip()}', new))
    # C: comparisons
    pat = re.compile(r'PLt\(|PLe\(|VLt\(|(?<= )(<=|>=|<|>)(?= )')
    flip = {'PLt(': 'PLe(', 'PLe(': 'PLt(', 'VLt(': 'VLe(', '<': '<=', '<=': '<', '>': '>=', '>=': '>'}
    for i in reg:
        if lines[i].rstrip().endswith('\\* env'):
            continue
        cl = code(lines[i])
        for m in pat.finditer(cl):
            t = m.group(0)
            new = list(lines)
            new[i] = cl[:m.start()] + flip[t] + cl[m.end():]
            muts.append(('C', i + 1, f'{t.rstrip("(")} -> {flip[t].rstrip("(")} in: {cl.strip()}', new))
    # U: drop updates
    text = '\n'.join(lines)
    starts = [sum(len(l) + 1 for l in lines[:i]) for i in range(len(lines))]
    regset = set(reg)

    def line_of(pos):
        lo = 0
        for k, s in enumerate(starts):
            if s > pos:
                break
            lo = k
        return lo

    def args_at(pos):
        """Arguments of the call whose '(' is at pos: [(start, end)]."""
        depth, out, a = 0, [], pos + 1
        for m in TOK.finditer(text, pos):
            t = m.group(0)
            if m.start() == pos:
                depth = 1
                continue
            if t in OPEN:
                depth += 1
            else:
                depth -= 1
                if depth == 0:
                    out.append((a, m.start()))
                    return out
            # commas at depth 1 are found below
        return out

    def split_args(pos):
        depth, a, out = 0, pos + 1, []
        k = pos
        while k < len(text):
            ch2 = text[k:k + 2]
            if ch2 in ('<<', '>>'):
                depth += 1 if ch2 == '<<' else -1
                k += 2
                continue
            ch = text[k]
            if ch in '({[':
                depth += 1
            elif ch in ')}]':
                depth -= 1
                if depth == 0:
                    out.append((a, k))
                    return out
            elif ch == ',' and depth == 1:
                out.append((a, k))
                a = k + 1
            k += 1
        return out

    for m in re.finditer(r'\bUpd\(', text):
        if line_of(m.start()) not in regset:
            continue
        ar = split_args(m.end() - 1)
        old = text[ar[0][0]:ar[0][1]].strip()
        new_text = text[:m.start()] + old + text[ar[1][1] + 1:]
        muts.append(('U', line_of(m.start()) + 1, f'drop update: Upd({old}, ...) keeps {old}',
                     new_text.split('\n')))
    ident = ['shards', 'table', 'cl', 'net']
    for m in re.finditer(r'\bGo\(', text):
        if line_of(m.start()) not in regset:
            continue
        ar = split_args(m.end() - 1)
        for k, idn in enumerate(ident):
            a0, a1 = ar[k]
            arg = text[a0:a1].strip()
            if arg == idn:
                continue
            new_text = text[:a0] + ' ' + idn + text[a1:]
            muts.append(('U', line_of(m.start()) + 1,
                         f'drop update of {idn}: {arg[:60]} -> {idn}', new_text.split('\n')))
    return muts


def consts_for(b, calm, soft):
    if b == 'write0':
        c = tlcrun.constants('fixed', 'write', calm=calm, soft=soft)
        c['D'] = '0'
    else:
        c = tlcrun.constants('fixed', b, calm=calm, soft=soft)
    c.pop('V')
    c.pop('Fix')
    return c


def run_one(idx, kind, line, desc, new_lines, fixed_counts, prev=None):
    d = os.path.join(WORK, f'm{idx:03d}')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'SlotMoveFixed.tla'), 'w') as f:
        f.write('\n'.join(new_lines))
    shutil.copy(os.path.join(ROOT, 'tla', 'SlotMove.tla'), os.path.join(d, 'SlotMove.tla'))
    res = {'id': idx, 'kind': kind, 'line': line, 'desc': desc, 'runs': {}}
    # a survivor re-checked on more bounds keeps the runs it already has
    done_runs = dict(prev['runs']) if prev else {}
    invs = ['Inv1', 'Inv2', 'Inv3', 'Inv4', 'Inv5', 'Inv6', 'Inv8', 'Inv9']
    counts = {}
    for b in BOUNDS:
        if b in done_runs and done_runs[b].get('verdict') == 'holds':
            res['runs'][b] = done_runs[b]
            counts[b] = done_runs[b]['distinct']
            continue
        consts = consts_for(b, calm=False, soft=False)
        cap = CAP * fixed_counts[b]
        tlcrun.write_model(d, consts, invs, extends='SlotMoveFixed', module='MC',
                           extra_defs=EDGE_DEFS + cap_defs(cap), copy_spec=False)
        add_cap(d)
        out, secs = tlcrun.tlc(d, workers=1, heavy=HEAVY)
        r = classify(out, cap)
        r['secs'] = round(secs, 1)
        res['runs'][b] = r
        if r['verdict'] in ('caught', 'ill-formed', 'unbounded'):
            res['verdict'] = r['verdict']
            res['by'] = f'{b}: {r.get("prop")}'
            return res
        counts[b] = r['distinct']
    # no safety property broke: property 7 on move
    for b in ('move',):
        if b + '-live' in done_runs and not done_runs[b + '-live']['stuck']:
            res['runs'][b + '-live'] = done_runs[b + '-live']
            continue
        consts = consts_for(b, calm=True, soft=True)
        cap = CAP * fixed_counts[b]
        tlcrun.write_model(d, consts, ['SoftInv', 'CalmNode'], extends='SlotMoveFixed',
                           module='MC', extra_defs=cap_defs(cap), copy_spec=False)
        add_cap(d)
        out, secs = tlcrun.tlc(d, workers=1, heavy=HEAVY)
        fails, nodes, edges, distinct, errors, keep = tlcrun.parse(out)
        if distinct is not None and distinct >= cap:
            res['runs'][b + '-live'] = {'stuck': None, 'calm': len(nodes), 'secs': round(secs, 1),
                                        'distinct': distinct, 'errors': errors[:3]}
            res['verdict'] = 'unbounded'
            res['by'] = f'{b}-live: more than {cap:,} states'
            return res
        live = agef.check(nodes, edges)
        res['runs'][b + '-live'] = {'stuck': live['stuck'], 'calm': len(nodes), 'secs': round(secs, 1),
                                    'errors': errors[:3]}
        if live['stuck']:
            res['verdict'] = 'caught'
            res['by'] = f'{b}: 7'
            return res
    same = all(counts.get(b) == fixed_counts.get(b) for b in BOUNDS)
    res['bounds'] = list(BOUNDS)
    res['verdict'] = 'equivalent' if same else 'survived'
    res['counts'] = counts
    return res


# property 6 on a step: with Soft = FALSE, Commit asserts it, and TLC
# reports the failed Assert as an error naming "property 6 fails on a commit".
EDGE_DEFS = ''

# A mutant can make the state space blow up (a guard that stopped a step from
# repeating). Each run is capped at CAP times the fixed protocol's states on
# that bound: states past the cap are not expanded (a TLC CONSTRAINT; with one
# worker the search order, and so the cut, is deterministic). A run that
# reaches the cap with no property broken is "unbounded": the mutant changes
# the protocol's reachable states by more than CAP times, and no property
# broke in the part searched.
CAP = 10


def cap_defs(cap):
    return f'\nCapOK == TLCGet("distinct") < {int(cap)}'


def add_cap(d):
    with open(os.path.join(d, 'MC.cfg'), 'a') as f:
        f.write('CONSTRAINT CapOK\n')

VIOL = re.compile(r'Invariant (\w+) is violated')
DIST = re.compile(r'([\d,]+) states generated, ([\d,]+) distinct states found')


def classify(out, cap=None):
    m = VIOL.search(out)
    if m:
        return {'verdict': 'caught', 'prop': m.group(1),
                'steps': len(re.findall(r'^State \d+:', out, re.M)) - 1}
    if 'property 6 fails on a commit' in out:
        return {'verdict': 'caught', 'prop': 'Inv6-step'}
    if 'Error' in out and 'No error has been found' not in out:
        err = [l for l in out.splitlines() if 'rror' in l or 'xception' in l][:3]
        return {'verdict': 'ill-formed', 'prop': None, 'errors': err}
    d = DIST.search(out)
    n = int(d.group(2).replace(',', '')) if d else None
    if cap and n is not None and n >= cap:
        return {'verdict': 'unbounded', 'prop': f'more than {int(cap):,} states', 'distinct': n}
    return {'verdict': 'holds', 'distinct': n}


def fixed_counts():
    """The fixed protocol's distinct state counts (safety runs, no calm)."""
    f = os.path.join(ROOT, 'results', 'fixed-counts.json')
    have = json.load(open(f)) if os.path.exists(f) else {}
    if all(b in have for b in BOUNDS):
        return have
    d = os.path.join(WORK, 'base')
    os.makedirs(d, exist_ok=True)
    shutil.copy(SRC, os.path.join(d, 'SlotMoveFixed.tla'))
    shutil.copy(os.path.join(ROOT, 'tla', 'SlotMove.tla'), os.path.join(d, 'SlotMove.tla'))
    counts = dict(have)
    for b in BOUNDS:
        if b in counts:
            continue
        consts = consts_for(b, calm=False, soft=False)
        tlcrun.write_model(d, consts, ['Inv1', 'Inv2', 'Inv3', 'Inv4', 'Inv5', 'Inv6', 'Inv8',
                                       'Inv9'],
                           extends='SlotMoveFixed', module='MC', extra_defs=EDGE_DEFS, copy_spec=False)
        out, secs = tlcrun.tlc(d, workers=1, heavy=HEAVY)
        r = classify(out)
        assert r['verdict'] == 'holds', (b, r, out[-2000:])
        counts[b] = r['distinct']
    json.dump(counts, open(f, 'w'), indent=1)
    return counts


def equiv():
    """SlotMoveFixed against SlotMove with V = "fixed": the same states, calm
    states and verdicts on the mutant bounds (soft checks and the calm graph,
    as tlcrun). For move, dedup and deep, SlotMove's counts are slot_move.py's
    (results/py); for write0 SlotMove is run here too."""
    f = os.path.join(ROOT, 'results', 'fixed-equiv.json')
    out = json.load(open(f)) if os.path.exists(f) else {}
    for spec in ('SlotMoveFixed', 'SlotMove'):
        d = os.path.join(WORK, 'equiv-' + spec)
        os.makedirs(d, exist_ok=True)
        shutil.copy(SRC, os.path.join(d, 'SlotMoveFixed.tla'))
        shutil.copy(os.path.join(ROOT, 'tla', 'SlotMove.tla'), os.path.join(d, 'SlotMove.tla'))
        for b in (BOUNDS if spec == 'SlotMoveFixed' else ['write0']):
            key = f'{spec}-{b}'
            if key in out:
                continue
            if spec == 'SlotMove':
                c = tlcrun.constants('fixed', 'write', calm=True, soft=True)
                c['D'] = '0'
            else:
                c = consts_for(b, calm=True, soft=True)
            tlcrun.write_model(d, c, ['SoftInv', 'CalmNode'], extends=spec, module='MC', copy_spec=False)
            text, secs = tlcrun.tlc(d, workers=1, heavy=HEAVY)
            fails, nodes, edges, distinct, errors, keep = tlcrun.parse(text)
            live = agef.check(nodes, edges)
            out[key] = {'states': distinct - len(nodes) if distinct else None, 'calm': len(nodes),
                        'failed': sorted(fails), 'stuck': live['stuck'], 'errors': errors[:3],
                        'secs': round(secs, 1)}
            if b in ('move', 'dedup', 'deep'):
                pf = os.path.join(ROOT, 'results', 'py', f'fixed-{b}.json')
                if os.path.exists(pf):
                    pr = json.load(open(pf))
                    out[key]['same_as_slot_move_py'] = (pr['states'] == out[key]['states']
                                                       and pr['live_nodes'] == out[key]['calm'])
            print(key, out[key], flush=True)
            json.dump(out, open(f, 'w'), indent=1, sort_keys=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--equiv', action='store_true')
    ap.add_argument('--no-heavy', action='store_true')
    ap.add_argument('--budget', type=float, default=0)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--left', action='store_true', help='print how many mutants are not run yet')
    ap.add_argument('--survivors-left', action='store_true',
                    help='print how many uncaught mutants have not yet run on every bound in E15_MUT_BOUNDS')
    ap.add_argument('--redo-survivors', action='store_true',
                    help='run again the mutants no bound caught, on the bounds not tried yet')
    ap.add_argument('--run', action='store_true')
    ap.add_argument('--slice', default='1/1')
    ap.add_argument('--table', action='store_true')
    ap.add_argument('--only', default=None, help='comma-separated mutant ids')
    a = ap.parse_args()
    global HEAVY
    HEAVY = not a.no_heavy
    import time
    t0 = time.time()
    if a.equiv:
        equiv()
        return
    lines = open(SRC).read().split('\n')
    muts = make(lines)
    if a.list:
        for k, (kind, line, desc, _) in enumerate(muts, 1):
            print(f'm{k:03d} {kind} line {line}: {desc}')
        print(f'{len(muts)} mutants: ' + ', '.join(
            f'{x} {sum(1 for m in muts if m[0] == x)}' for x in 'GCU'))
        return
    results = json.load(open(OUTF)) if os.path.exists(OUTF) else {}
    if a.left:
        print(sum(1 for k in range(1, len(muts) + 1) if f'm{k:03d}' not in results))
        return
    if a.survivors_left:
        print(sum(1 for r in results.values() if r['verdict'] in ('survived', 'equivalent')
                  and not set(BOUNDS) <= set(r['runs'])))
        return
    if a.run:
        base = fixed_counts()
        k, n = map(int, a.slice.split('/'))
        only = set(int(x) for x in a.only.split(',')) if a.only else None
        for idx, (kind, line, desc, new) in enumerate(muts, 1):
            prev = results.get(f'm{idx:03d}')
            if (idx - 1) % n != k - 1:
                continue
            if prev and not (a.redo_survivors and prev['verdict'] in ('survived', 'equivalent')
                             and not set(BOUNDS) <= set(prev['runs'])):
                continue
            if only and idx not in only:
                continue
            if a.budget and time.time() - t0 > a.budget:
                break
            r = run_one(idx, kind, line, desc, new, base, prev=prev)
            results[f'm{idx:03d}'] = r
            print(f'm{idx:03d}', r['verdict'], r.get('by', ''), desc, flush=True)
            # merge with what other slices wrote meanwhile
            cur = json.load(open(OUTF)) if os.path.exists(OUTF) else {}
            cur.update({f'm{idx:03d}': r})
            with open(OUTF, 'w') as f:
                json.dump(cur, f, indent=1, sort_keys=True)
            results = cur
    if a.table or not a.run:
        rows = [results[k] for k in sorted(results)]
        tally = {}
        for r in rows:
            tally[r['verdict']] = tally.get(r['verdict'], 0) + 1
        print('| id | kind | line | mutant | verdict | caught by (bound: property) |')
        print('|---|---|---|---|---|---|')
        for r in rows:
            print(f'| m{r["id"]:03d} | {r["kind"]} | {r["line"]} | {r["desc"].replace("|", "/")} | '
                  f'{r["verdict"]} | {r.get("by", "")} |')
        print()
        print('Tally: ' + ', '.join(f'{k} {v}' for k, v in sorted(tally.items())) +
              f' (of {len(rows)} run, {len(muts)} made)')


if __name__ == '__main__':
    main()
