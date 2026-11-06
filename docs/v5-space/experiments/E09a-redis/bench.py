#!/usr/bin/env python3
"""E-09a: Redis 7.0.15 on the box, driven by redis-benchmark 7.0.15 (memtier_benchmark could not be run here;
see README). One extra row, SET + WAIT, uses respbench (our port of the load loop), because
redis-benchmark sends one command per request.

Usage (run with python3 -I):
  bench.py run CONFIG... [--runs 3]   timed runs, a fresh server (or three) per run
  bench.py smoke CONFIG...            one short unrecorded run each (plumbing check, not a result)
  bench.py table                      results/runs.jsonl -> results/tables.md

Every run: GET, SET or INCR, 100-byte values, 200 clients on 4 client threads (4 threads x 50 clients),
random keys over 100,000, pipeline 1 or 16. Keys are filled first (SET, not measured), so GET hits.
"""
import json, os, re, shutil, signal, statistics, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
WORK = SP + '/e09/redis'
RESPB = SP + '/e09/bin/respbench'
HERE = os.path.dirname(os.path.abspath(__file__))
RES = HERE + '/results'
TCK = os.sysconf('SC_CLK_TCK')
PORTS = [36379, 36380, 36381]
SECONDS = 20  # target length of one measured test; -n is sized from it (see NREQ)

# server setups
SETUPS = {
    'default': dict(n=1, args=[]),                                              # Redis as shipped
    'aof':     dict(n=1, args=['--appendonly', 'yes', '--appendfsync', 'always']),  # PERF-02's matched config
    'aof-r3':  dict(n=3, args=['--appendonly', 'yes', '--appendfsync', 'always']),  # same, with two async replicas
}
# requests per measured test, sized from smoke runs so a quiet-box run lasts about 10-40 s
NREQ = json.load(open(HERE + '/nreq.json')) if os.path.exists(HERE + '/nreq.json') else {}


def configs():
    c = {}
    for s in SETUPS:
        for t in ('set', 'get', 'incr'):
            if s == 'aof-r3' and t == 'get':
                continue  # a GET does not touch the AOF or the replicas: the 'aof' rows cover it
            for p in (1, 16):
                c['%s-%s-p%d' % (s, t, p)] = dict(setup=s, test=t, pipe=p, tool='redis-benchmark')
    # SET + WAIT 1 0 on a primary with two replicas: the write is on the primary's disk (fsync always)
    # and in a replica's memory before the reply. respbench, since redis-benchmark cannot pair commands.
    for p in (1, 16):
        c['aof-r3-setwait1-p%d' % p] = dict(setup='aof-r3', test='set', pipe=p, tool='respbench', wait=1)
        c['aof-r3-set-p%d-respbench' % p] = dict(setup='aof-r3', test='set', pipe=p, tool='respbench', wait=0)
    return c


CONFIGS = configs()


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
    return sum(f) - f[3] - f[4], sum(f)


def start(setup):
    subprocess.run(['pkill', '-f', 'redis-server 127.0.0.1:3638'], capture_output=True)
    shutil.rmtree(WORK + '/data', ignore_errors=True)
    procs = []
    s = SETUPS[setup]
    for i in range(s['n']):
        d = WORK + '/data/%d' % i
        os.makedirs(d)
        cmd = ['redis-server', '--port', str(PORTS[i]), '--bind', '127.0.0.1', '--dir', d,
               '--logfile', d + '/redis.log', '--daemonize', 'no'] + s['args']
        if i > 0:
            cmd += ['--replicaof', '127.0.0.1', str(PORTS[0])]
        procs.append(subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for _ in range(100):
        ok = subprocess.run(['redis-cli', '-p', str(PORTS[0]), 'ping'], capture_output=True, text=True).stdout.strip() == 'PONG'
        if ok and s['n'] > 1:
            info = subprocess.run(['redis-cli', '-p', str(PORTS[0]), 'info', 'replication'], capture_output=True, text=True).stdout
            ok = 'connected_slaves:%d' % (s['n'] - 1) in info and info.count('state=online') == s['n'] - 1
        if ok:
            return procs
        time.sleep(0.1)
    stop(procs)
    raise SystemExit('redis did not start')


def stop(procs):
    for p in procs:
        p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(20)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    shutil.rmtree(WORK + '/data', ignore_errors=True)


def fill():
    # every key of the key space exists before a measured test (not timed, not recorded)
    subprocess.run(['redis-benchmark', '-p', str(PORTS[0]), '-c', '50', '-n', '300000', '-r', '100000', '-d', '100',
                    '-P', '64', '-t', 'set', '-q'], capture_output=True)


def parse_rb(out):
    r = {}
    m = re.search(r'throughput summary: ([\d.]+) requests per second', out); r['ops_s'] = float(m.group(1)) if m else None
    m = re.search(r'latency summary \(msec\):\s*\n\s*avg\s+min\s+p50\s+p95\s+p99\s+max\s*\n\s*([\d.\s]+)\n', out)
    if m:
        v = [float(x) for x in m.group(1).split()]
        r.update(avg_ms=v[0], p50=v[2], p95=v[3], p99=v[4], max_ms=v[5])
    for p, v in re.findall(r'^\s*([\d.]+)% <= ([\d.]+) milliseconds', out, re.M):
        if float(p) >= 99.9:
            r['p999'] = float(v); break
    m = re.search(r'(\d+) requests completed in ([\d.]+) seconds', out)
    if m:
        r['requests'] = int(m.group(1)); r['seconds'] = float(m.group(2))
    return r


def run_one(name, run, record=True, n=None, secs=None):
    c = CONFIGS[name]
    procs = start(c['setup'])
    try:
        fill()
        if c['tool'] == 'redis-benchmark':
            n = n or NREQ.get(name, 100000)
            cmd = ['redis-benchmark', '-p', str(PORTS[0]), '-c', '200', '--threads', '4', '-n', str(n), '-r', '100000',
                   '-d', '100', '-P', str(c['pipe']), '-t', c['test'], '--precision', '3']
        else:
            cmd = [RESPB, '-addr', '127.0.0.1:%d' % PORTS[0], '-clients', '200', '-pipeline', str(c['pipe']), '-size', '100',
                   '-keyspace', '100000', '-op', c['test'], '-wait', str(c['wait']), '-duration', '%ds' % (secs or SECONDS), '-warmup', '2s']
        la = loadavg()
        c0 = [proc_cpu(p.pid) for p in procs]; b0 = box_busy(); t0 = time.time(); ru0 = os.times()
        r = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, GOMAXPROCS='4'))
        ru1 = os.times(); t1 = time.time(); b1 = box_busy(); c1 = [proc_cpu(p.pid) for p in procs]
        wall = t1 - t0
        out = r.stdout + r.stderr
        srv = [round(b - a, 2) for a, b in zip(c0, c1)]
        cli = round((ru1.children_user - ru0.children_user) + (ru1.children_system - ru0.children_system), 2)
        busy = (b1[0] - b0[0]) / (b1[1] - b0[1]) * os.cpu_count()
        res = {'exp': 'E-09a', 'config': name, 'run': run, 'tool': c['tool'], 'setup': c['setup'], 'test': c['test'],
               'pipeline': c['pipe'], 'cmd': ' '.join(cmd), 'loadavg_before': la, 'wall_s': round(wall, 2), 'rc': r.returncode,
               'server_cpu_s': srv, 'client_cpu_s': cli, 'server_cores': round(sum(srv) / wall, 2),
               'primary_cores': round(srv[0] / wall, 2), 'client_cores': round(cli / wall, 2),
               'box_busy_cores': round(busy, 2), 'other_cores': round(busy - (sum(srv) + cli) / wall, 2),
               'at': time.strftime('%Y-%m-%dT%H:%M:%S')}
        if c['tool'] == 'redis-benchmark':
            res.update(parse_rb(out))
        else:
            j = json.loads(r.stdout.strip().splitlines()[-1])
            res.update({k: j[k] for k in ('ops_s', 'p50', 'p95', 'p99', 'p999', 'requests', 'seconds', 'error_replies')})
            res['max_ms'] = j['max']
        if record:
            open('%s/raw/%s-%d.txt' % (RES, name, run), 'w').write(trim(out))
            with open(RES + '/runs.jsonl', 'a') as f:
                f.write(json.dumps(res) + '\n')
        return res
    finally:
        stop(procs)


def trim(out):
    out = out.replace('\r', '\n')
    keep = [l for l in out.splitlines() if l.strip() and not l.startswith(('SET: rps', 'GET: rps', 'INCR: rps'))]
    return '\n'.join(keep)[-8000:] + '\n'


def med_rng(xs, fmt):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    return (fmt % statistics.median(xs)) + ' (' + (fmt % min(xs)) + '-' + (fmt % max(xs)) + ')'


def table():
    rows = [json.loads(l) for l in open(RES + '/runs.jsonl')]
    out = ['| config | tool | runs | ops/s | p50 ms | p99 ms | p99.9 ms | max ms | redis cores (all servers) | primary cores | client cores | other cores | load before (1-min) |',
           '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for n in CONFIGS:
        rs = [r for r in rows if r['config'] == n]
        if not rs:
            continue
        out.append('| %s | %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, rs[0]['tool'], len(rs), med_rng([r.get('ops_s') for r in rs], '%.0f'), med_rng([r.get('p50') for r in rs], '%.3f'),
            med_rng([r.get('p99') for r in rs], '%.3f'), med_rng([r.get('p999') for r in rs], '%.3f'),
            med_rng([r.get('max_ms') for r in rs], '%.1f'), med_rng([r['server_cores'] for r in rs], '%.2f'),
            med_rng([r['primary_cores'] for r in rs], '%.2f'), med_rng([r['client_cores'] for r in rs], '%.2f'),
            med_rng([r['other_cores'] for r in rs], '%.2f'), ', '.join(r['loadavg_before'].split()[0] for r in rs)))
    open(RES + '/tables.md', 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    os.makedirs(RES + '/raw', exist_ok=True)
    if a[0] == 'smoke':
        for n in a[1:]:
            r = run_one(n, 0, record=False, n=200000, secs=3)
            print(n, 'ops/s %.0f p50 %s p99 %s p99.9 %s srv %s cli %s load %s' % (r.get('ops_s') or 0, r.get('p50'), r.get('p99'), r.get('p999'),
                  r['server_cores'], r['client_cores'], r['loadavg_before'].split()[0]), flush=True)
        return
    if a[0] == 'run':
        runs = 3
        if '--runs' in a:
            i = a.index('--runs'); runs = int(a[i + 1]); del a[i:i + 2]
        done = {}
        if os.path.exists(RES + '/runs.jsonl'):
            for l in open(RES + '/runs.jsonl'):
                j = json.loads(l); done[j['config']] = done.get(j['config'], 0) + 1
        names = []
        for pat in a[1:] or ['']:
            names += [n for n in CONFIGS if n.startswith(pat) and n not in names]
        for n in names:
            for k in range(done.get(n, 0) + 1, runs + 1):
                r = run_one(n, k)
                print('%s run %d: %.0f ops/s p50 %s p99 %s ms (load %s)' % (n, k, r.get('ops_s') or 0, r.get('p50'), r.get('p99'), r['loadavg_before']), flush=True)
        return
    if a[0] == 'table':
        table(); return
    print(__doc__)


if __name__ == '__main__':
    main()
