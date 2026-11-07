#!/usr/bin/env python3
"""mutants.py: DEV-10's one-rule mutants of E-37 fix rules.

The rules are the lines between MUTATE-BEGIN and MUTATE-END in
tla/MCbadentry.tla that carry a tag:
  [g]      a guard conjunct: the mutant drops it (the line becomes TRUE);
  [u v]    an update of v: the mutant drops it (UNCHANGED v).
Every tagged line with a comparison also gets each flip DEV-10 names:
< to <=, <= to <, > to >=, >= to >. (DEV-10's "swap two updates" has no
meaning in TLA+: the conjuncts of an action are simultaneous, so a swap is
the same formula.) Nothing is hand-picked: every tagged line is mutated.

Each mutant is named Definition:kind:rNN, NN the rule's place among the
tagged lines (stable when lines move).

Usage: mutants.py --list            print the mutants
       mutants.py --write DIR       write DIR/<mutant>/MCbadentry.tla
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, 'tla', 'MCbadentry.tla')

FLIPS = [('<=', '<'), ('>=', '>'), ('<', '<='), ('>', '>=')]


def tagged_lines(text):
    lines = text.split('\n')
    inside = False
    out = []
    current_def = '?'
    for k, line in enumerate(lines):
        if 'MUTATE-BEGIN' in line:
            inside = True
            continue
        if 'MUTATE-END' in line:
            inside = False
            continue
        if not inside:
            continue
        m = re.match(r'^(\w+)(\(.*?\))?\s*==', line)
        if m:
            current_def = m.group(1)
        t = re.search(r'\\\* \[(g|u (\w+))\]\s*$', line)
        if t:
            out.append((k, current_def, 'g' if t.group(1) == 'g' else 'u', t.group(2)))
    return lines, out


def comparisons(code):
    """Positions of comparison operators in a line's code (not in comments,
    not part of |-> or <<, >>, =>, <=> or \\* )."""
    res = []
    i = 0
    while i < len(code):
        two = code[i:i + 2]
        if code[i:i + 3] in ('|->', '<=>'):
            i += 3
            continue
        if two in ('<<', '>>', '=>', '->', '\\*'):
            i += 2
            continue
        if two in ('<=', '>='):
            res.append((i, two))
            i += 2
            continue
        if code[i] in '<>':
            res.append((i, code[i]))
        i += 1
    return res


def mutants():
    text = open(SRC).read()
    lines, tags = tagged_lines(text)
    muts = []
    for n, (k, d, kind, var) in enumerate(tags):
        line = lines[k]
        code, _, comment = line.partition('\\*')
        indent = re.match(r'^(\s*(?:\w+\(.*?\)\s*==\s*)?/\\\s*)', code)
        prefix = indent.group(1) if indent else '    /\\ '
        if kind == 'g':
            new = prefix + 'TRUE      \\* mutant: guard dropped'
            muts.append(('%s:drop-guard:r%02d' % (d, n + 1), k, new, line.strip()))
        else:
            new = prefix + 'UNCHANGED %s      \\* mutant: update dropped' % var
            muts.append(('%s:drop-update-%s:r%02d' % (d, var, n + 1), k, new, line.strip()))
        for pos, op in comparisons(code):
            to = dict(FLIPS)[op]
            new = code[:pos] + to + code[pos + len(op):] + '\\*' + comment
            muts.append(('%s:flip-%s-to-%s:r%02d' % (d, op, to, n + 1), k, new.rstrip(), line.strip()))
    return lines, muts


def main():
    lines, muts = mutants()
    if '--list' in sys.argv:
        for name, k, new, old in muts:
            print('%-50s %s\n%50s -> %s' % (name, old, '', new.strip()))
        print('%d mutants' % len(muts))
        return
    if '--write' in sys.argv:
        out = sys.argv[sys.argv.index('--write') + 1]
        for name, k, new, old in muts:
            safe = re.sub(r'[^A-Za-z0-9_.-]', '_', name)
            d = os.path.join(out, safe)
            os.makedirs(d, exist_ok=True)
            ls = list(lines)
            ls[k] = new
            open(os.path.join(d, 'MCbadentry.tla'), 'w').write('\n'.join(ls))
            open(os.path.join(d, 'MUTANT'), 'w').write('%s\n%s\n-> %s\n' % (name, old, new.strip()))
        print('%d mutants written to %s' % (len(muts), out))


if __name__ == '__main__':
    main()
