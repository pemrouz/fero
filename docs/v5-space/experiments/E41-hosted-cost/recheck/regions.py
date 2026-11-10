import sys, importlib.util
spec = importlib.util.spec_from_file_location('cost', sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
P0 = dict(c.P)
base = {'fly.shared.cpu': 0.0000008465*2592000 - 0.25*0.000002316*2592000, 'fly.perf.cpu': 0.000012732*2592000 - 2*0.000002316*2592000, 'fly.ram.gb': 0.000002316*2592000}
# region: (machine markup from Fly's RegionPricingSelector.jsx, egress $/GB for its region group, private cross-region $/GB)
regions = {'iad/ewr (cheapest)': (1.0, 0.02, 0.006), 'fra': (1.153846154, 0.02, 0.006), 'ord/dfw': (1.25, 0.02, 0.006),
           'sin/syd': (1.269230769, 0.04, 0.015), 'jnb': (1.302884615, 0.12, 0.05), 'nrt': (1.307692308, 0.04, 0.015), 'gru': (1.615384615, 0.04, 0.015)}
rows = ['MIN', 'DRAFT', 'SLOG', 'EMB-V8', 'SRV', 'PD', 'BUY', 'OBJ']
xfer_gb = 10 * c.A['row.bytes'] * c.S / c.GB
print('10 writes/s, 100 subscribers inside; $ a month; Tigris upload low = private cross-region rate, high = internet egress rate of the region group')
print('| region | ' + ' | '.join(rows) + ' |'); print('|---' * (len(rows)+1) + '|')
for r, (mk, eg, pv) in regions.items():
    cells = []
    for cand in rows:
        out = []
        for rate in (pv, eg):
            c.P.clear(); c.P.update(P0); c.P.update(base)
            for k in ('fly.shared.cpu','fly.perf.cpu','fly.ram.gb'): c.P[k] *= mk * 730/720
            t = c.total(cand, 'small', 'fly') + (rate * xfer_gb if not c.SHAPES[cand].get('buy') else 0)
            out.append(t)
        cells.append('%.2f-%.2f' % tuple(out))
    print('| %s | %s |' % (r, ' | '.join(cells)))
print('\nnote: the pooled-server and log-tier node prices (assumed in cost.py from iad rates) are not marked up here; EMB-V8 and the tier share therefore read low outside iad.')
