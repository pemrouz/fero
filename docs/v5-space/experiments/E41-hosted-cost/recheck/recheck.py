# E-41 price re-check, scratch only. Imports a COPY of cost.py; never calls tables() (which writes files).
import sys, importlib.util, copy
spec = importlib.util.spec_from_file_location('cost', sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
order = ['MIN','LEAN','DRAFT','SLOG','OBJ','EMB-V8','SRV','PD','V4','BUY']
P0 = dict(c.P)
def run(label, patch=None, tigris_xfer=0.0, month_scale=False):
    c.P.clear(); c.P.update(P0)
    if patch: c.P.update(patch)
    if month_scale:   # Fly prices are per 30 days (720 h); cost.py's month is 730 h
        k = 730/720
        for key in ('fly.shared.cpu','fly.perf.cpu','fly.ram.gb'): c.P[key] *= k
    res = {}
    for cand in order:
        row = {}
        for l in ('sleeping','small','big'):
            if cand == 'V4' and l == 'big': row[l] = None; continue
            t = c.total(cand, l, 'fly')
            s = c.SHAPES[cand]
            if c.LOADS[l]['wps'] and not s.get('nostore') and not s.get('buy'):
                t += tigris_xfer * c.LOADS[l]['wps'] * c.A['row.bytes'] * c.S / c.GB   # the log, uploaded once, Fly -> Tigris
            row[l] = t
        row['awake_out'] = c.total(cand, 'small', 'fly', True) + (tigris_xfer * 10 * c.A['row.bytes'] * c.S / c.GB if not c.SHAPES[cand].get('nostore') and not c.SHAPES[cand].get('buy') else 0)
        res[cand] = row
    print('\n## ' + label)
    print('| row | asleep | 10 w/s (inside) | x $10 bar | 10 w/s outside | 5,000 w/s |')
    print('|---|---|---|---|---|---|')
    for cand, r in res.items():
        big = '-' if r['big'] is None else '%.0f' % r['big']
        print('| %s | %.2f | %.2f | %.2f | %.2f | %s |' % (cand, r['sleeping'], r['small'], r['small']/10, r['awake_out'], big))
    return res
exact = {'fly.shared.cpu': 0.0000008465*2592000 - 0.25*0.000002316*2592000, 'fly.perf.cpu': 0.000012732*2592000 - 2*0.000002316*2592000, 'fly.ram.gb': 0.000002316*2592000}
print('exact Fly per-30-day rates from the page source:', {k: round(v,4) for k,v in exact.items()})
base = run('A. E-41 as published (prices unchanged)')
run('B. exact per-second rates from Fly page source, 30-day month', exact)
run('C. B, and Fly bills a 730-hour month (per-second billing)', exact, month_scale=True)
run('D. C, plus Fly->Tigris upload billed at the private cross-region rate $0.006/GB (lower bound)', exact, 0.006, True)
run('E. C, plus Fly->Tigris upload billed at the internet rate $0.02/GB (upper bound)', exact, 0.02, True)
