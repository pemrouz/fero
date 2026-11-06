"""Splits swap survivors into syntactically independent pairs (each line's target is not
mentioned in the other line, so the swap cannot change the result: equivalent mutants)
and the rest. Usage: python3 -I diff/classify_swaps.py <mutation-run.txt> <port/src>"""
import re, sys, os
run, src = sys.argv[1], sys.argv[2]
lines = {}
indep, dep = [], []
for l in open(run):
    m = re.match(r'^  (\S+\.ts):(\d+) swap: ', l)
    if not m:
        continue
    f, n = m.group(1), int(m.group(2))
    if f not in lines:
        lines[f] = open(os.path.join(src, f)).read().split('\n')
    a, b = lines[f][n - 1].strip(), lines[f][n].strip()
    def target(s):
        t = re.match(r'^([\w.!\[\]()]+?)\s*(\+\+|--|=|\+=|-=)', s)
        return t.group(1).rstrip('!') if t else s
    ta, tb = target(a), target(b)
    base = lambda t: t.split('(')[0]
    mentions = lambda t, s: re.search(r'(?<![\w.])' + re.escape(base(t)) + r'(?!\w)', s) is not None
    if not mentions(ta, b) and not mentions(tb, a):
        indep.append(f'{f}:{n}  {a}  <->  {b}')
    else:
        dep.append(f'{f}:{n}  {a}  <->  {b}')
print(f'swap survivors: {len(indep) + len(dep)}; independent (equivalent) {len(indep)}; other {len(dep)}')
print('other:')
for d in dep:
    print('  ' + d)
