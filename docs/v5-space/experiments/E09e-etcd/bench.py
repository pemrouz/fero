#!/usr/bin/env python3
"""E-09e: etcd 3.5.17, three members on the box, driven by etcd's own `benchmark` tool (v3.5.17).

Usage (run with python3 -I):
  bench.py calibrate              short runs to size each config's total (not results)
  bench.py run CONFIG... [--runs 3]   timed runs; each run on a fresh 3-member cluster
  bench.py table                  results/runs.jsonl -> results/tables.md

Each run records /proc/loadavg first, then the CPU seconds of every etcd member and of the load
generator, and the box's busy cores, so other agents' load shows. Raw tool output goes to
results/raw/<config>-<run>.txt.
"""
import json, os, re, shutil, signal, statistics, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
ETCD = SP + '/dl/etcd/etcd-v3.5.17-linux-amd64'
BENCH = SP + '/tools-src/etcd-benchmark/etcd-benchmark'
LOCKB = SP + '/e09/bin/lockbench'
WORK = SP + '/e09/etcd'
HERE = os.path.dirname(os.path.abspath(__file__))
RES = HERE + '/results'
TCK = os.sysconf('SC_CLK_TCK')

MEMBERS = [('m1', 32379, 32380), ('m2', 32479, 32480), ('m3', 32579, 32580)]
EPS = ','.join('127.0.0.1:%d' % c for _, c, _ in MEMBERS)
PUT = ['--key-size=8', '--sequential-keys', '--key-space-size=100000', '--val-size=256']
L1 = ['--conns=1', '--clients=1', '--target-leader']
L1000 = ['--conns=100', '--clients=1000', '--target-leader']
A1000 = ['--conns=100', '--clients=1000']

# name: (kind, global flags, subcommand, fsync).  kind 'b' = etcd benchmark, 'l' = lockbench.
CONFIGS = {
    'put-1c':            ('b', L1, ['put'] + PUT, True),
    'put-1000c':         ('b', L1000, ['put'] + PUT, True),
    'put-1000c-all':     ('b', A1000, ['put'] + PUT, True),
    'range-l-1c':        ('b', L1, ['range', 'foo', '--consistency=l'], True),
    'range-l-1000c':     ('b', A1000, ['range', 'foo', '--consistency=l'], True),
    'range-s-1c':        ('b', L1, ['range', 'foo', '--consistency=s'], True),
    'range-s-1000c':     ('b', A1000, ['range', 'foo', '--consistency=s'], True),
    'txn-put-1c':        ('b', L1, ['txn-put', '--txn-ops=1'] + [f for f in PUT if f != '--sequential-keys'], True),
    'txn-put-1000c':     ('b', L1000, ['txn-put', '--txn-ops=1'] + [f for f in PUT if f != '--sequential-keys'], True),
    'lease-keepalive-1000c': ('b', L1000, ['lease-keepalive'], True),
    # stm: one key per transaction, written every time (--txn-wr-percent=100): get, then a txn that puts only if
    # the key's revision is unchanged, i.e. a compare-and-set. (With the default 50% and one key, int(0.5) = 0
    # writes, and the transaction is read-only.)
    'stm-1c':            ('b', L1, ['stm', '--keys=100000', '--keys-per-txn=1', '--txn-wr-percent=100', '--val-size=256'], True),
    'stm-1000c':         ('b', L1000, ['stm', '--keys=100000', '--keys-per-txn=1', '--txn-wr-percent=100', '--val-size=256'], True),
    # the same, wrapped in etcd's client lock (concurrency.Mutex on one name, 'stmlock'): lock, CAS, unlock
    'stm-lock-1c':       ('b', L1, ['stm', '--keys=100000', '--keys-per-txn=1', '--txn-wr-percent=100', '--val-size=256', '--stm-locker=lock-client'], True),
    'lock-1c':           ('l', ['-clients', '1', '-conns', '1', '-locks', '0'], None, True),
    'lock-100c':         ('l', ['-clients', '100', '-conns', '10', '-locks', '0'], None, True),
    # informative only: etcd's non-default, unsafe switch that skips fsync (prices the fsync)
    'put-1c-nofsync':    ('b', L1, ['put'] + PUT, False),
    'put-1000c-nofsync': ('b', L1000, ['put'] + PUT, False),
}
TOTALS_FILE = HERE + '/totals.json'
LOCK_SECONDS = 20


def loadavg():
    return open('/proc/loadavg').read().strip()


def proc_cpu(pid):
    try:
        f = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
        return (int(f[11]) + int(f[12])) / TCK
    except OSError:
        return None


def box_busy():
    f = [int(x) for x in open('/proc/stat').readline().split()[1:]]
    idle = f[3] + f[4]
    return sum(f) - idle, sum(f)


def sh(*a, **k):
    return subprocess.run(list(a), capture_output=True, text=True, **k)


def kill_strays():
    subprocess.run(['pkill', '-f', WORK + '/data/'], capture_output=True)
    time.sleep(0.3)


def start_cluster(fsync=True):
    kill_strays()
    shutil.rmtree(WORK + '/data', ignore_errors=True)
    os.makedirs(WORK + '/data'); os.makedirs(WORK + '/logs', exist_ok=True)
    ic = ','.join('%s=http://127.0.0.1:%d' % (n, p) for n, _, p in MEMBERS)
    procs = []
    for n, c, p in MEMBERS:
        cmd = [ETCD + '/etcd', '--name', n, '--data-dir', WORK + '/data/' + n,
               '--listen-client-urls', 'http://127.0.0.1:%d' % c, '--advertise-client-urls', 'http://127.0.0.1:%d' % c,
               '--listen-peer-urls', 'http://127.0.0.1:%d' % p, '--initial-advertise-peer-urls', 'http://127.0.0.1:%d' % p,
               '--initial-cluster', ic, '--initial-cluster-token', 'e09e', '--initial-cluster-state', 'new',
               '--log-level', 'error']
        if not fsync:
            cmd.append('--unsafe-no-fsync')
        procs.append(subprocess.Popen(cmd, stdout=open(WORK + '/logs/%s.log' % n, 'w'), stderr=subprocess.STDOUT))
    ctl = ETCD + '/etcdctl'
    for _ in range(200):
        r = sh(ctl, '--endpoints', EPS, 'endpoint', 'status', '-w', 'json')
        if r.returncode == 0:
            st = json.loads(r.stdout)
            leaders = {s['Status']['leader'] for s in st}
            if len(st) == 3 and len(leaders) == 1 and 0 not in leaders:
                lead = [s['Endpoint'] for s in st if s['Status']['header']['member_id'] == s['Status']['leader']]
                if sh(ctl, '--endpoints', EPS, 'put', 'foo', 'x' * 256).returncode == 0:
                    return procs, lead[0] if lead else '?'
        time.sleep(0.1)
    stop_cluster(procs)
    raise SystemExit('etcd cluster did not start')


def stop_cluster(procs):
    for p in procs:
        p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    shutil.rmtree(WORK + '/data', ignore_errors=True)


def parse_bench(out):
    r = {}
    m = re.search(r'Requests/sec:\s+([\d.]+)', out); r['ops_s'] = float(m.group(1)) if m else None
    m = re.search(r'Total:\s+([\d.]+) secs', out); r['seconds'] = float(m.group(1)) if m else None
    m = re.search(r'Average:\s+([\d.]+) secs', out); r['avg_ms'] = float(m.group(1)) * 1e3 if m else None
    m = re.search(r'Slowest:\s+([\d.]+) secs', out); r['max_ms'] = float(m.group(1)) * 1e3 if m else None
    for p, v in re.findall(r'([\d.]+)% in ([\d.]+) secs', out):
        r['p' + p.replace('.', '')] = float(v) * 1e3
    m = re.search(r'Error distribution:(.*)', out, re.S); r['errors'] = m.group(1).strip()[:500] if m else ''
    return r


def run_one(name, total, run, record=True):
    kind, g, sub, fsync = CONFIGS[name]
    procs, leader = start_cluster(fsync)
    try:
        if kind == 'b':
            cmd = [BENCH, '--endpoints', EPS, '--precise'] + g + sub + ['--total=%d' % total]
        else:
            cmd = [LOCKB, '-endpoints', EPS, '-duration', '%ds' % total, '-warmup', '2s'] + g
        la = loadavg()
        c0 = [proc_cpu(p.pid) for p in procs]; b0 = box_busy(); t0 = time.time()
        ru0 = os.times()
        r = subprocess.run(cmd, capture_output=True, text=True)
        ru1 = os.times()
        t1 = time.time(); b1 = box_busy(); c1 = [proc_cpu(p.pid) for p in procs]
        out = r.stdout + r.stderr
        wall = t1 - t0
        mem_cpu = [round(b - a, 2) for a, b in zip(c0, c1)]
        cli_cpu = round((ru1.children_user - ru0.children_user) + (ru1.children_system - ru0.children_system), 2)
        busy = (b1[0] - b0[0]) / (b1[1] - b0[1]) * os.cpu_count()
        res = {'exp': 'E-09e', 'config': name, 'run': run, 'fsync': fsync, 'total': total, 'cmd': ' '.join(cmd),
               'loadavg_before': la, 'leader': leader, 'wall_s': round(wall, 2), 'rc': r.returncode,
               'member_cpu_s': mem_cpu, 'client_cpu_s': cli_cpu,
               'member_cores': round(sum(mem_cpu) / wall, 2), 'client_cores': round(cli_cpu / wall, 2),
               'box_busy_cores': round(busy, 2), 'other_cores': round(busy - (sum(mem_cpu) + cli_cpu) / wall, 2),
               'at': time.strftime('%Y-%m-%dT%H:%M:%S')}
        if kind == 'b':
            res.update(parse_bench(out))
        else:
            j = json.loads(r.stdout.strip().splitlines()[-1])
            res.update({'ops_s': j['cycles_per_s'], 'seconds': j['seconds'], 'errors': j['errors'],
                        'acquire': j['acquire_ms'], 'p50': j['cycle_ms']['p50'], 'p99': j['cycle_ms']['p99'],
                        'p999': j['cycle_ms']['p999'], 'max_ms': j['cycle_ms']['max'], 'cycles': j['cycles']})
        if record:
            open('%s/raw/%s-%d.txt' % (RES, name, run), 'w').write(trim(out))
            with open(RES + '/runs.jsonl', 'a') as f:
                f.write(json.dumps(res) + '\n')
        return res
    finally:
        stop_cluster(procs)


KEEP = re.compile(r'^\s*(Summary:|Total:|Slowest:|Fastest:|Average:|Stddev:|Requests/sec:|Response time histogram:|'
                  r'Latency distribution:|Error distribution:|\[\d+\]|[\d.]+% in |[\d.]+ \[\d+\]|\{"clients")')


def trim(out):
    # keep the tool's summary, histogram and percentiles; drop the progress bar and gRPC's log lines
    return '\n'.join(l for l in out.splitlines() if KEEP.match(l))[-6000:] + '\n'


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    os.makedirs(RES + '/raw', exist_ok=True)
    if a[0] == 'calibrate':
        names = a[1:] or list(CONFIGS)
        tot = json.load(open(TOTALS_FILE)) if os.path.exists(TOTALS_FILE) else {}
        for n in names:
            if CONFIGS[n][0] == 'l':
                tot[n] = LOCK_SECONDS; continue
            small = 2000 if n.endswith('-1c') or '-1c-' in n else 20000
            r = run_one(n, small, 0, record=False)
            print(n, 'ops/s', r.get('ops_s'), 'load', r['loadavg_before'], 'err', r.get('errors', '')[:80], flush=True)
            if r.get('ops_s'):
                t = r['ops_s'] * 25
                tot[n] = int(float('%.2g' % t))
            json.dump(tot, open(TOTALS_FILE, 'w'), indent=1, sort_keys=True)
        return
    if a[0] == 'run':
        runs = 3
        if '--runs' in a:
            i = a.index('--runs'); runs = int(a[i + 1]); del a[i:i + 2]
        tot = json.load(open(TOTALS_FILE))
        done = {}
        if os.path.exists(RES + '/runs.jsonl'):
            for l in open(RES + '/runs.jsonl'):
                j = json.loads(l); done[j['config']] = done.get(j['config'], 0) + 1
        for n in a[1:] or list(CONFIGS):
            for k in range(done.get(n, 0) + 1, runs + 1):
                r = run_one(n, tot[n], k)
                print('%s run %d: %.0f ops/s p50 %.3f p99 %.3f ms (load %s)' % (n, k, r.get('ops_s') or 0, r.get('p50') or 0, r.get('p99') or 0, r['loadavg_before']), flush=True)
        return
    if a[0] == 'table':
        table(); return
    if a[0] == 'smoke':  # one short unrecorded run per config: checks the plumbing, not a result
        for n in a[1:]:
            print(n, json.dumps(run_one(n, 3 if CONFIGS[n][0] == 'l' else 500, 0, record=False)), flush=True)
        return
    print(__doc__)


def med_rng(xs, fmt):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    return (fmt % statistics.median(xs)) + ' (' + (fmt % min(xs)) + '-' + (fmt % max(xs)) + ')'


def table():
    rows = [json.loads(l) for l in open(RES + '/runs.jsonl')]
    out = ['| config | runs | ops/s | p50 ms | p99 ms | p99.9 ms | max ms | etcd cores (3 members) | client cores | other cores | load before (1-min) |',
           '|---|---|---|---|---|---|---|---|---|---|---|']
    for n in CONFIGS:
        rs = [r for r in rows if r['config'] == n]
        if not rs:
            continue
        out.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, len(rs), med_rng([r.get('ops_s') for r in rs], '%.0f'), med_rng([r.get('p50') for r in rs], '%.3f'),
            med_rng([r.get('p99') for r in rs], '%.3f'), med_rng([r.get('p999') for r in rs], '%.2f'),
            med_rng([r.get('max_ms') for r in rs], '%.1f'), med_rng([r['member_cores'] for r in rs], '%.2f'),
            med_rng([r['client_cores'] for r in rs], '%.2f'), med_rng([r['other_cores'] for r in rs], '%.2f'),
            ', '.join(r['loadavg_before'].split()[0] for r in rs)))
    lk = [r for r in rows if 'acquire' in r]
    if lk:
        out += ['', 'Lock acquire alone (lockbench; the cycle columns above are Lock + Unlock):', '',
                '| config | runs | acquire p50 ms | acquire p99 ms | acquire p99.9 ms |', '|---|---|---|---|---|']
        for n in CONFIGS:
            rs = [r for r in lk if r['config'] == n]
            if rs:
                out.append('| %s | %d | %s | %s | %s |' % (n, len(rs), med_rng([r['acquire']['p50'] for r in rs], '%.3f'),
                           med_rng([r['acquire']['p99'] for r in rs], '%.3f'), med_rng([r['acquire']['p999'] for r in rs], '%.2f')))
    errs = [(r['config'], r['run'], r['errors']) for r in rows if r.get('errors')]
    if errs:
        out += ['', 'Runs with errors:', ''] + ['- %s run %d: %s' % e for e in errs]
    open(RES + '/tables.md', 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
