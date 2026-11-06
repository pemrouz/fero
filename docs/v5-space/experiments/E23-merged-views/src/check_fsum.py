import sys, json, math
bad = 0; n = 0
for line in sys.stdin:
    if line.startswith('#'):
        print(line[1:].strip()); continue
    c = json.loads(line); n += 1
    want = math.fsum(float(x) for x in c['xs'])
    got = float(c['got'])
    if want != got or math.copysign(1, want) != math.copysign(1, got):
        bad += 1
        if bad <= 3: print('MISMATCH', c['got'], repr(want))
print(f'fsum cross-check: {n} cases, {bad} mismatches')
