#!/usr/bin/env python3
"""E-01 result reader. Modes:
  fio <name> <run> <json>            -> one JSON line (sync and write latency, iops)
  probe <name> <run> <prefix> <w>    -> one JSON line (write+flush and flush-only percentiles)
  cdf <prefix> <runs>                -> 1,000 quantiles (µs) of the 1-writer flush time, for E-02
  sustained <run> <prefix>           -> one JSON line (bandwidth per second, probe latency)
  summary <results dir>              -> markdown tables: median and spread over runs
"""
import glob, json, os, statistics, sys
import numpy as np

def load(path):
    return open(path).read().strip()

def fio(name, run, path):
    j = json.loads(open(path).read()[open(path).read().index('{'):])
    job = j['jobs'][0]
    w = job['write']
    out = {'name': name, 'run': int(run), 'loadavg': load(path + '.load'), 'fio': j.get('fio version'),
           'iops': round(w['iops'], 1), 'bw_MBps': round(w['bw_bytes'] / 1e6, 2)}
    def pct(d):
        p = d.get('percentile', {})
        return {k: round(p[v] / 1e3, 1) for k, v in
                (('p50_us', '50.000000'), ('p90_us', '90.000000'), ('p99_us', '99.000000'),
                 ('p999_us', '99.900000'), ('p9999_us', '99.990000')) if v in p}
    out['write_clat'] = pct(w['clat_ns'])
    out['write_clat']['mean_us'] = round(w['clat_ns']['mean'] / 1e3, 1)
    s = job.get('sync', {})
    if s.get('total_ios', 0) or s.get('lat_ns', {}).get('N', 0):
        out['sync_lat'] = pct(s['lat_ns'])
        out['sync_lat']['mean_us'] = round(s['lat_ns']['mean'] / 1e3, 1)
        out['sync_lat']['max_us'] = round(s['lat_ns']['max'] / 1e3, 1)
    print(json.dumps(out))

def samples(prefix, w=None):
    files = sorted(glob.glob(prefix + '.*.bin'))
    a = np.concatenate([np.fromfile(f, dtype=np.uint32).reshape(-1, 2) for f in files])
    return a, files

def probe(name, run, prefix, w):
    a, files = samples(prefix)
    tot, fl = np.sort(a[:, 0]) / 1e3, np.sort(a[:, 1]) / 1e3
    q = lambda x, p: round(float(x[min(len(x) - 1, int(p * len(x)))]), 1)
    out = {'name': name, 'run': int(run), 'writers': int(w), 'loadavg': load(prefix + '.load'),
           'ops': int(len(tot)), 'ops_per_s_total': None,
           'write_plus_flush': {f'p{k}_us': q(tot, p) for k, p in (('50', .5), ('99', .99), ('999', .999))} | {'max_us': q(tot, 1)},
           'flush_only': {f'p{k}_us': q(fl, p) for k, p in (('50', .5), ('99', .99), ('999', .999))} | {'max_us': q(fl, 1)}}
    secs = {'nosync-1w': 10}.get(name, 20)
    out['ops_per_s_total'] = round(len(tot) / secs)
    print(json.dumps(out))
    if not name.startswith('grow-1w'):
        for f in files:
            os.remove(f)

def cdf(prefix, runs):
    parts = []
    for i in range(1, int(runs) + 1):
        a, _ = samples(f'{prefix}.{i}')
        parts.append(a[:, 1])
    fl = np.sort(np.concatenate(parts)) / 1e3
    print(f'# E-01 1-writer fdatasync time (flush only, 4 KiB appends, ext4 on /dev/vda), {len(fl)} samples from {runs} runs')
    print('# 1,000 quantiles in microseconds, q = (i + 0.5) / 1000; E-02 samples a delay from this table')
    for i in range(1000):
        print(f'{fl[min(len(fl) - 1, int((i + 0.5) / 1000 * len(fl)))]:.1f}')

def sustained(run, prefix):
    j = json.loads(open(prefix + '.json').read()[open(prefix + '.json').read().index('{'):])
    bulk = next(x for x in j['jobs'] if x['jobname'] == 'bulk')
    pr = next(x for x in j['jobs'] if x['jobname'] == 'probe')
    bw = []
    for f in sorted(glob.glob(prefix + '.bulk_bw*.log')):
        for line in open(f):
            t, v = line.split(',')[:2]
            bw.append(round(int(v) / 1024, 1))   # KiB/s -> MiB/s
    sp = pr['sync']['lat_ns']['percentile']
    out = {'run': int(run), 'loadavg': load(prefix + '.load'),
           'bulk_GiB': round(bulk['write']['io_bytes'] / 2**30, 2), 'bulk_secs': round(bulk['job_runtime'] / 1e3, 1),
           'bulk_MiBps_mean': round(bulk['write']['bw_bytes'] / 2**20, 1),
           'bulk_MiBps_per_s': bw,
           'probe_ops': pr['sync']['lat_ns']['N'],
           'probe_sync_p50_us': round(sp['50.000000'] / 1e3, 1), 'probe_sync_p99_us': round(sp['99.000000'] / 1e3, 1),
           'probe_sync_p999_us': round(sp['99.900000'] / 1e3, 1), 'probe_sync_max_us': round(pr['sync']['lat_ns']['max'] / 1e3, 1)}
    print(json.dumps(out))

def med(xs):
    xs = [x for x in xs if x is not None]
    return (statistics.median(xs), min(xs), max(xs)) if xs else (None, None, None)

def fmt(t):
    m, lo, hi = t
    if m is None:
        return '-'
    return f'{m:,.0f} ({lo:,.0f}-{hi:,.0f})' if m >= 100 else f'{m:.1f} ({lo:.1f}-{hi:.1f})'

def summary(rdir):
    rows = [json.loads(l) for l in open(os.path.join(rdir, 'fio.jsonl'))]
    print('### fio (median of runs, range in brackets; µs)\n')
    print('| job | runs | IOPS | sync p50 | sync p99 | sync p99.9 | sync max | write clat p50 | write clat p99 | write clat p99.9 |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for name in dict.fromkeys(r['name'] for r in rows):
        rs = [r for r in rows if r['name'] == name]
        g = lambda k, f: med([r.get(k, {}).get(f) for r in rs])
        print(f"| {name} | {len(rs)} | {fmt(med([r['iops'] for r in rs]))} | {fmt(g('sync_lat','p50_us'))} | {fmt(g('sync_lat','p99_us'))} | "
              f"{fmt(g('sync_lat','p999_us'))} | {fmt(g('sync_lat','max_us'))} | {fmt(g('write_clat','p50_us'))} | {fmt(g('write_clat','p99_us'))} | {fmt(g('write_clat','p999_us'))} |")
    p = os.path.join(rdir, 'probe.jsonl')
    if os.path.exists(p):
        rows = [json.loads(l) for l in open(p)]
        print('\n### probe: one pwrite plus fdatasync, timed together (µs). nosync-1w hit the probe sample cap (200k/s), so its ops/s is a floor\n')
        print('| layout | runs | ops/s (all writers) | write+flush p50 | p99 | p99.9 | flush only p50 | p99 | p99.9 |')
        print('|---|---|---|---|---|---|---|---|---|')
        for name in dict.fromkeys(r['name'] for r in rows):
            rs = [r for r in rows if r['name'] == name]
            g = lambda k, f: fmt(med([r[k][f] for r in rs]))
            print(f"| {name} | {len(rs)} | {fmt(med([r['ops_per_s_total'] for r in rs]))} | {g('write_plus_flush','p50_us')} | "
                  f"{g('write_plus_flush','p99_us')} | {g('write_plus_flush','p999_us')} | {g('flush_only','p50_us')} | {g('flush_only','p99_us')} | {g('flush_only','p999_us')} |")
    p = os.path.join(rdir, 'rtt.jsonl')
    if os.path.exists(p):
        rows = [json.loads(l) for l in open(p) if l.startswith('{')]
        print('\n### loopback TCP round trip, one message in flight (µs)\n')
        print('| impl | bytes | runs | round trips/s | p50 | p99 | p99.9 |')
        print('|---|---|---|---|---|---|---|')
        for impl in ('node', 'rust', 'go'):
            for b in (64, 1024):
                rs = [r for r in rows if r['impl'] == impl and r['bytes'] == b]
                if rs:
                    print(f"| {impl} | {b} | {len(rs)} | {fmt(med([r['rtt_per_s'] for r in rs]))} | {fmt(med([r['p50_us'] for r in rs]))} | "
                          f"{fmt(med([r['p99_us'] for r in rs]))} | {fmt(med([r['p999_us'] for r in rs]))} |")
    p = os.path.join(rdir, 'sustained.jsonl')
    if os.path.exists(p):
        rows = [json.loads(l) for l in open(p)]
        print('\n### sustained 10 GiB O_DIRECT write with a 4 KiB fdatasync probe (200/s offered) beside it\n')
        print('| run | GiB | seconds | MiB/s mean | MiB/s per second (min-max) | probe flushes | probe fdatasync p50 ms | p99 ms | max ms |')
        print('|---|---|---|---|---|---|---|---|---|')
        for r in rows:
            b = r['bulk_MiBps_per_s'] or [0]
            print(f"| {r['run']} | {r['bulk_GiB']} | {r['bulk_secs']} | {r['bulk_MiBps_mean']} | {min(b)}-{max(b)} | "
                  f"{r['probe_ops']} | {r['probe_sync_p50_us'] / 1e3:.0f} | {r['probe_sync_p99_us'] / 1e3:.0f} | {r['probe_sync_max_us'] / 1e3:.0f} |")

if __name__ == '__main__':
    m = sys.argv[1]
    {'fio': lambda: fio(*sys.argv[2:5]), 'probe': lambda: probe(*sys.argv[2:6]), 'cdf': lambda: cdf(*sys.argv[2:4]),
     'sustained': lambda: sustained(*sys.argv[2:4]), 'summary': lambda: summary(sys.argv[2])}[m]()
