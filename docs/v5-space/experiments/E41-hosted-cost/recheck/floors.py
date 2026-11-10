import sys, importlib.util
spec = importlib.util.spec_from_file_location('cost', sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
P0 = dict(c.P)
exact = {'fly.shared.cpu': 0.0000008465*2592000 - 0.25*0.000002316*2592000, 'fly.perf.cpu': 0.000012732*2592000 - 2*0.000002316*2592000, 'fly.ram.gb': 0.000002316*2592000}
xfer_gb = 10 * c.A['row.bytes'] * c.S / c.GB
print('log uploaded at 10 w/s: %.2f GB a month; at 5,000 w/s: %.0f GB' % (xfer_gb, 5000*c.A['row.bytes']*c.S/c.GB))
variants = {
  'SRV, two app machines (E-41)':  dict(c.SHAPES['SRV']),
  'SRV, one app machine':          dict(c.SHAPES['SRV'], app=1),
  'PD (E-41: 3 stores, 3 PD, 2 app)': dict(c.SHAPES['PD']),
  'PD, one app machine':           dict(c.SHAPES['PD'], app=1),
  'PD, PD inside the stores, one app': dict(c.SHAPES['PD'], app=1, pd=0),
  'BUY (E-41: NATS 512 MB, 2 app)':   dict(c.SHAPES['BUY']),
  'BUY, one app machine':          dict(c.SHAPES['BUY'], app=1),
}
for label, rate in (('as published', None), ('page rates, 730 h, no Tigris transfer', 0.0), ('page rates, 730 h, transfer $0.006/GB', 0.006), ('page rates, 730 h, transfer $0.02/GB', 0.02)):
    c.P.clear(); c.P.update(P0)
    if rate is not None:
        c.P.update(exact)
        for k in ('fly.shared.cpu','fly.perf.cpu','fly.ram.gb'): c.P[k] *= 730/720
    print('\n## ' + label)
    for v, shape in variants.items():
        c.SHAPES['_X'] = shape
        t = c.total('_X', 'small', 'fly') + ((rate or 0) * xfer_gb if not shape.get('buy') else 0)
        print('  %-36s $%6.2f  (%.2f x the $10 bar)' % (v, t, t/10))
