"""Print, for each key Knossos found not linearizable in one run, the operation it could not
place and the last operation it could (results.edn, the :workload results).

Each line: key, the failing op (:f, :value, :time in s since the test start), the last ok op
before it, and the time between the two. A read whose value is older than an op that had
already finished is a stale read.
Usage: lin_failures.py <run name> <results.edn>
"""
import re
import sys

name, path = sys.argv[1], sys.argv[2]
res = open(path, encoding='utf-8', errors='replace').read()
w = res.find(':workload {')
body = res[w:] if w >= 0 else ''
fails = re.search(r':failures\s*\[([^\]]*)\]', body)
keys = fails.group(1).split() if fails else []


def op(s):
    f = re.search(r':f :(\w+)', s).group(1)
    v = re.search(r':value ([^,]+?),\s*:index', s, re.S)
    v = re.sub(r'\s+', ' ', v.group(1)) if v else '?'
    t = int(re.search(r':time (\d+)', s).group(1)) / 1e9
    ty = re.search(r':type :(\w+)', s).group(1)
    p = re.search(r':process (\d+)', s).group(1)
    return f, v, t, ty, p


print(f'{name}: {len(keys)} keys not linearizable: {" ".join(keys)}')
# Each key's block starts with "<key> {:linearizable {:valid? false" inside :results.
for k in keys:
    m = re.search(r'[\s{]' + re.escape(k) + r' \{:linearizable \{:valid\? false,(.*?):timeline', body, re.S)
    if not m:
        print(f'  key {k}: block not found')
        continue
    blk = ',' + m.group(1)  # the comma after ':valid? false' starts the map's next key
    prev = re.search(r':previous-ok \{([^}]*)\}', blk)
    bad = re.findall(r',\s+:op \{([^}]*)\}', blk)  # the map's own :op, not the {:op ...} inside :final-paths
    msgs = sorted(set(re.findall(r'Inconsistent\{:msg "([^"]+)"', blk)))
    b = op(bad[-1]) if bad else None
    p = op(prev.group(1)) if prev else None
    line = f'  key {k}: '
    if b:
        line += f'{b[3]} {b[0]} {b[1]} (process {b[4]}, done at {b[2]:.3f} s)'
    if p:
        line += f' after {p[3]} {p[0]} {p[1]} (process {p[4]}, done at {p[2]:.3f} s)'
    if b and p:
        line += f', {1000 * (b[2] - p[2]):.1f} ms later'
    print(line)
    for s in msgs:
        if s.startswith("can't read"):
            print(f'      knossos: {s}')
