#!/usr/bin/env python3
"""E-09a2: Redis 7.0.15 driven by memtier_benchmark 2.5.2 (PERF-02's first-named tool), on E-09a's three
server setups (default, aof, aof-r3), with redis-benchmark 7.0.15 control rows in the same timing holds, and
the E-45 RESP gateway over the E-22 prototype (a SIMULATOR, not a fero kernel) driven by the same memtier
commands.

Usage (run with python3 -I):
  bench.py run PREFIX... [--runs 3]   timed runs, round-robin over the matching configs (run 1 of each, then
                                      run 2 of each, ...); a fresh server (or three, or a fresh host) per run;
                                      configs already in results/runs.jsonl are skipped (resume)
  bench.py smoke CONFIG...            one short unrecorded run each (plumbing check, not a result)
  bench.py list                       the config names
  bench.py table                      results/runs.jsonl -> results/tables.md (+ the comparison with E-09a)
  bench.py tails                      the kept memtier JSON -> results/tails.md (where in a run the tail sits)

Workload (PERF-02): 4 threads x 50 clients (200 connections), 100-byte values, uniform random keys over
1..100,000 (each client its own seed), pipeline 1 or 16, 20 s per measured run. Tests: SET (--ratio 1:0),
GET (--ratio 0:1), INCR (--command "incr __key__" on keys counter:N), MIX (--ratio 1:10, one SET per ten GETs).
Before each Redis run the 100,000 keys are filled (memtier, SET, pipeline 64, not measured), so GETs hit.
"""
import glob, json, os, re, shutil, signal, statistics, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
MT = os.environ.get('MEMTIER', SP + '/opt/memtier/bin/memtier_benchmark')
WORK = SP + '/e09a2/redis'          # server data dirs (deleted after each run)
KEEP = SP + '/e09a2/keep'           # full memtier JSON and HdrHistogram text tables (too big for the repo)
HERE = os.path.dirname(os.path.abspath(__file__))
RES = HERE + '/results'
E09A = os.path.normpath(HERE + '/../E09a-redis')          # read only: its runs.jsonl for the comparison
E45 = os.path.normpath(HERE + '/../E45-drivers')          # read only: host.ts + lib/resp.ts (the RESP gateway)
TCK = os.sysconf('SC_CLK_TCK')
PORTS = [36479, 36480, 36481]       # E-09a used 36379-36381; different so the two never meet
GW_PORT = 16490                     # the prototype gateway (E-45 used 16390)
SECONDS = 20                        # memtier --test-time of one measured run
KEYS = 100000

# E-09a's three server setups, copied verbatim from ../E09a-redis/bench.py (same args, same replica wiring)
SETUPS = {
    'default': dict(n=1, args=[]),                                              # Redis as shipped
    'aof':     dict(n=1, args=['--appendonly', 'yes', '--appendfsync', 'always']),  # PERF-02's matched config
    'aof-r3':  dict(n=3, args=['--appendonly', 'yes', '--appendfsync', 'always']),  # same, with two async replicas
}
# The prototype host (E-45's host.ts over E-22's simulator): `proto` with Node's default heap (about 2 GB here), then
# `proto8g` with an 8 GB heap, because the simulator keeps every verb in memory (its history, for the checkers) and the
# `proto` hold's GET at pipeline 16 ran out of the default heap (results/raw/proto-get-p16-1-failed.txt)
PROTOS = ['proto', 'proto8g']
PROTO_HEAP_MB = {'proto': None, 'proto8g': 8192}


class RunFailed(Exception):
    pass


# redis-benchmark control rows: exactly E-09a's command and fill, -n from E-09a's nreq.json (copied in ours)
NREQ = json.load(open(HERE + '/nreq.json'))


def configs():
    c = {}
    for s in list(SETUPS) + PROTOS:
        for t in ('set', 'get', 'incr', 'mix'):
            if s == 'aof-r3' and t == 'get':
                continue  # as E-09a: a GET touches neither the AOF nor the replicas; the 'aof' rows cover it
            for p in (1, 16):
                c['%s-%s-p%d' % (s, t, p)] = dict(setup=s, test=t, pipe=p, tool='memtier')
    # same-hold controls with E-09a's tool and E-09a's exact command, so a memtier/redis-benchmark difference can
    # be told apart from a change in the box since E-09a ran: every E-09a row on Redis (GET, SET, INCR; the
    # default hold first ran only the SET ones, its GET and INCR controls ran in a hold of their own), and SET on
    # the prototype
    for s in list(SETUPS) + PROTOS:
        for t in ('set', 'get', 'incr'):
            if (s == 'aof-r3' and t == 'get') or (s in PROTOS and t != 'set'):
                continue
            for p in (1, 16):
                c['%s-%s-p%d-rb' % (s, t, p)] = dict(setup=s, test=t, pipe=p, tool='redis-benchmark')
    # the bridge hold `b2`: the container restarted (a new boot of the VM) between the `default2` and the `r3`
    # holds, and the new boot's fsync was much faster, so `aof`'s matched rows run again on the new boot beside
    # `aof-r3` (the first boot's `aof` rows are kept as they are). Same setup and command; `same_as` names the row.
    # A second restart (a third boot, kernel build fc-v310) came before `b2` could run, so `b2` also repeats
    # `aof-r3`'s six memtier rows: aof and aof-r3 then sit on one boot, and the r3 repeats show whether the third
    # boot matches the second (the `r3` hold's rows are kept as they are).
    for n in ('aof-set-p1', 'aof-set-p16', 'aof-incr-p1', 'aof-incr-p16', 'aof-mix-p1', 'aof-mix-p16', 'aof-get-p16',
              'aof-set-p1-rb', 'aof-set-p16-rb', 'aof-get-p16-rb',
              'aof-r3-set-p1', 'aof-r3-set-p16', 'aof-r3-incr-p1', 'aof-r3-incr-p16', 'aof-r3-mix-p1', 'aof-r3-mix-p16'):
        c['b2-' + n] = dict(c[n], same_as=n)
    # probe-only variants (never in a hold): the same 200 connections on fewer memtier threads, to see whether
    # Redis's idle time under memtier at pipeline 16 comes from sharing the 4 vCPUs with the client
    for th in (2, 1):
        c['probe-default-get-p16-t%d' % th] = dict(setup='default', test='get', pipe=16, tool='memtier', threads=th, clients=200 // th)
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


def proc_io(pid):
    # read and write syscalls of a process (syscr, syscw): commands per read shows how a tool batches
    try:
        d = dict(l.split(': ') for l in open('/proc/%d/io' % pid).read().splitlines())
        return int(d['syscr']), int(d['syscw'])
    except (OSError, KeyError, ValueError):
        return None


def proc_sched(pid):
    # /proc/<pid>/schedstat: ns on a CPU, ns waiting in the run queue for a CPU, timeslices (all threads of a
    # one-thread Redis; the main thread of a Node host)
    try:
        return [int(x) for x in open('/proc/%d/schedstat' % pid).read().split()]
    except (OSError, ValueError):
        return None


def box_busy():
    f = [int(x) for x in open('/proc/stat').readline().split()[1:]]
    return sum(f) - f[3] - f[4], sum(f)


# ---- servers -------------------------------------------------------------------------------------------

def start(setup):
    if setup in PROTOS:
        return start_proto(setup)
    subprocess.run(['pkill', '-f', 'redis-server 127.0.0.1:3648'], capture_output=True)
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


def start_proto(setup):
    # E-45's host: one Node process holding the E-22 simulated world (3 servers, virtual clock) and the RESP
    # gateway inside server s1. Durability: the resource default (`persisted`, simulated fsync).
    subprocess.run(['pkill', '-f', 'host.ts resp --listen 127.0.0.1:%d' % GW_PORT], capture_output=True)
    os.makedirs(WORK, exist_ok=True)
    log = open(WORK + '/proto-host.log', 'w')
    heap = PROTO_HEAP_MB[setup]
    p = subprocess.Popen(['node'] + (['--max-old-space-size=%d' % heap] if heap else []) +
                         ['--experimental-strip-types', '--no-warnings', E45 + '/host.ts', 'resp',
                          '--listen', '127.0.0.1:%d' % GW_PORT, '--every', '5' if heap else '1000'],
                         stdout=log, stderr=subprocess.STDOUT, cwd=E45)
    for _ in range(300):
        if open(WORK + '/proto-host.log').read().startswith('ready'):
            return [p]
        if p.poll() is not None:
            break
        time.sleep(0.1)
    stop([p])
    raise SystemExit('prototype host did not start: ' + open(WORK + '/proto-host.log').read()[-2000:])


def stop(procs):
    for p in procs:
        p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(20)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    shutil.rmtree(WORK + '/data', ignore_errors=True)


def port_of(setup):
    return GW_PORT if setup in PROTOS else PORTS[0]


# ---- fill (not measured) ----------------------------------------------------------------------------------

def fill_memtier(port):
    # every key memtier will GET exists before a measured run: 100,000 SETs of 100 B, each client its own
    # slice of the key range (P:P with allkeys), pipeline 64
    r = subprocess.run([MT, '-s', '127.0.0.1', '-p', str(port), '--threads=1', '--clients=50', '--pipeline=64',
                        '--data-size=100', '--key-minimum=1', '--key-maximum=%d' % KEYS, '--key-pattern=P:P',
                        '--ratio=1:0', '--requests=allkeys', '--hide-histogram'], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('fill failed: ' + (r.stdout + r.stderr)[-2000:])


def fill_rb(port):
    # E-09a's fill, verbatim (redis-benchmark key names, key:000000xxxxxx)
    subprocess.run(['redis-benchmark', '-p', str(port), '-c', '50', '-n', '300000', '-r', '100000', '-d', '100',
                    '-P', '64', '-t', 'set', '-q'], capture_output=True)


# ---- tools ------------------------------------------------------------------------------------------------

def memtier_cmd(c, port, prefix, secs):
    cmd = [MT, '-s', '127.0.0.1', '-p', str(port), '--protocol=redis', '--threads=%d' % c.get('threads', 4),
           '--clients=%d' % c.get('clients', 50),
           '--pipeline=%d' % c['pipe'], '--data-size=100', '--key-minimum=1', '--key-maximum=%d' % KEYS,
           '--distinct-client-seed', '--test-time=%d' % secs, '--hide-histogram',
           '--print-percentiles=50,90,99,99.9,99.99', '--json-out-file=%s.json' % prefix, '--hdr-file-prefix=%s' % prefix]
    t = c['test']
    if t == 'set':
        cmd += ['--ratio=1:0', '--key-pattern=R:R']
    elif t == 'get':
        cmd += ['--ratio=0:1', '--key-pattern=R:R']
    elif t == 'mix':
        cmd += ['--ratio=1:10', '--key-pattern=R:R']
    elif t == 'incr':
        cmd += ['--key-prefix=counter:', '--command=incr __key__', '--command-key-pattern=R']
    return cmd


def rb_cmd(c, port, n):
    return ['redis-benchmark', '-p', str(port), '-c', '200', '--threads', '4', '-n', str(n), '-r', '100000',
            '-d', '100', '-P', str(c['pipe']), '-t', c['test'], '--precision', '3']


def parse_rb(out):
    # E-09a's parser, verbatim
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


def parse_memtier(path):
    j = json.load(open(path))
    a = j['ALL STATS']
    out = {}
    for typ, st in a.items():
        if not isinstance(st, dict) or 'Ops/sec' not in st or not st.get('Count'):
            continue
        pl = st.get('Percentile Latencies', {})
        ts = st.get('Time-Serie', {})
        secs = [ts[k]['Count'] for k in sorted(ts, key=int)]
        inner = secs[1:-1] if len(secs) > 3 else secs   # drop the first and last (partial) second
        out[typ] = dict(count=st['Count'], ops_s=st['Ops/sec'], hits_s=st.get('Hits/sec'), misses_s=st.get('Misses/sec'),
                        avg_ms=st.get('Average Latency'), min_ms=st.get('Min Latency'), max_ms=st.get('Max Latency'),
                        p50=pl.get('p50.00'), p90=pl.get('p90.00'), p99=pl.get('p99.00'), p999=pl.get('p99.90'),
                        p9999=pl.get('p99.99'), conn_errors=st.get('Connection Errors'),
                        sec_min=min(inner) if inner else None, sec_max=max(inner) if inner else None)
    cpu = a.get('CPU', {})
    return out, dict(runtime_ms=a['Runtime']['Total duration'], memtier_cores=cpu.get('cpu_cores_used'),
                     memtier_cpu_s=cpu.get('cpu_total_seconds'))


def trim(out):
    out = out.replace('\r', '\n')
    keep = [l for l in out.splitlines() if l.strip() and not l.startswith(('SET: rps', 'GET: rps', 'INCR: rps'))
            and not re.match(r'^\[RUN #\d+ \d+%', l.strip())]
    return '\n'.join(keep)[-8000:] + '\n'


def versions():
    v = {}
    v['memtier'] = subprocess.run([MT, '--version'], capture_output=True, text=True).stdout.splitlines()[0]
    v['redis'] = subprocess.run(['redis-server', '--version'], capture_output=True, text=True).stdout.strip()
    v['node'] = subprocess.run(['node', '--version'], capture_output=True, text=True).stdout.strip()
    v['data'] = subprocess.run(['git', '-C', os.environ.get('DATA', '/home/user/pemrouz/data'), 'log', '-1', '--format=%h'],
                               capture_output=True, text=True).stdout.strip()
    v['fero'] = subprocess.run(['git', '-C', HERE, 'log', '-1', '--format=%h'], capture_output=True, text=True).stdout.strip()
    return v


# ---- one run -------------------------------------------------------------------------------------------------

def run_one(name, run, record=True, secs=None, n=None):
    c = CONFIGS[name]
    secs = secs or SECONDS
    port = port_of(c['setup'])
    procs = start(c['setup'])
    tag = '%s-%d' % (name, run) if record else 'smoke-%s' % name
    os.makedirs(KEEP, exist_ok=True)
    prefix = KEEP + '/' + tag
    for f in glob.glob(prefix + '_*') + glob.glob(prefix + '.json'):
        os.remove(f)
    host_tail = ''
    failed = None
    out = ''
    try:
        if c['tool'] == 'memtier':
            # Redis: fill before every run (as E-09a); prototype: only where GETs need the keys (see README)
            if c['setup'] not in PROTOS or c['test'] in ('get', 'mix'):
                fill_memtier(port)
            cmd = memtier_cmd(c, port, prefix, secs)
        else:
            if c['setup'] not in PROTOS:
                fill_rb(port)
            cmd = rb_cmd(c, port, n or NREQ[c.get('same_as', name)])
        la = loadavg()
        io0 = proc_io(procs[0].pid); sc0 = proc_sched(procs[0].pid)
        c0 = [proc_cpu(p.pid) for p in procs]; b0 = box_busy(); t0 = time.time(); ru0 = os.times()
        r = subprocess.run(cmd, capture_output=True, text=True)
        ru1 = os.times(); t1 = time.time(); b1 = box_busy(); c1 = [proc_cpu(p.pid) for p in procs]
        io1 = proc_io(procs[0].pid); sc1 = proc_sched(procs[0].pid)
        wall = t1 - t0
        out = r.stdout + r.stderr
        srv = [round(b - a, 2) for a, b in zip(c0, c1)]
        cli = round((ru1.children_user - ru0.children_user) + (ru1.children_system - ru0.children_system), 2)
        busy = (b1[0] - b0[0]) / (b1[1] - b0[1]) * os.cpu_count()
        res = {'exp': 'E-09a2', 'config': name, 'run': run, 'tool': c['tool'], 'setup': c['setup'], 'test': c['test'],
               'pipeline': c['pipe'], 'cmd': ' '.join(x if ' ' not in x else "'%s'" % x for x in cmd).replace(KEEP + '/', '$KEEP/'),
               'loadavg_before': la, 'wall_s': round(wall, 2), 'rc': r.returncode,
               'server_cpu_s': srv, 'client_cpu_s': cli, 'server_cores': round(sum(srv) / wall, 2),
               'primary_cores': round(srv[0] / wall, 2), 'client_cores': round(cli / wall, 2),
               'box_busy_cores': round(busy, 2), 'other_cores': round(busy - (sum(srv) + cli) / wall, 2),
               'at': time.strftime('%Y-%m-%dT%H:%M:%S')}
        if io0 and io1:
            res['primary_syscr'] = io1[0] - io0[0]; res['primary_syscw'] = io1[1] - io0[1]
        if sc0 and sc1:
            res['primary_oncpu_s'] = round((sc1[0] - sc0[0]) / 1e9, 2); res['primary_runq_wait_s'] = round((sc1[1] - sc0[1]) / 1e9, 3)
        if c['tool'] == 'memtier':
            try:
                per, meta = parse_memtier(prefix + '.json')
            except (OSError, ValueError, KeyError) as e:
                per, meta = {}, {'memtier_json_error': repr(e)}
            res.update(meta)
            tot = per.get('Totals')
            if not tot or not tot.get('count'):
                failed = 'memtier recorded no replies'
                tot = dict.fromkeys(('ops_s', 'avg_ms', 'p50', 'p90', 'p99', 'p999', 'p9999', 'max_ms', 'sec_min', 'sec_max', 'count'))
            res.update({k: tot[k] for k in ('ops_s', 'avg_ms', 'p50', 'p90', 'p99', 'p999', 'p9999', 'max_ms', 'sec_min', 'sec_max', 'count')})
            res['per_type'] = {k: v for k, v in per.items() if k != 'Totals'}
            g = per.get('Gets')
            if g and (g['hits_s'] or g['misses_s']):
                res['get_hit_ratio'] = round(g['hits_s'] / (g['hits_s'] + g['misses_s']), 4)
            res['warnings'] = [l.strip() for l in out.splitlines() if 'WARNING' in l.upper()][:5]
        else:
            res.update(parse_rb(out))
            res['count'] = res.get('requests')
            if not res.get('ops_s'):
                failed = 'redis-benchmark printed no throughput (exit %d)' % r.returncode
    finally:
        stop(procs)
        if c['setup'] in PROTOS:
            log = open(WORK + '/proto-host.log').read()
            host_tail = '\n'.join(l for l in log.splitlines() if l.startswith(('ready', 'summary', '[', '<---', 'FATAL'))
                                  or 'Mark-Compact' in l)
    if failed:
        if record:
            os.makedirs(RES + '/raw', exist_ok=True)
            open('%s/raw/%s-failed.txt' % (RES, tag), 'w').write('# FAILED: %s\n' % failed + trim(out) +
                                                               (('\n# prototype host:\n' + host_tail + '\n') if host_tail else ''))
        raise RunFailed('%s run %d: %s; host: %s' % (name, run, failed, host_tail[-300:].replace('\n', ' | ')))
    if c['setup'] in PROTOS:
        m = re.search(r'errors\{([^}]*)\}', host_tail)
        res['gateway_errors'] = m.group(1) if m else '?'
        m = re.search(r'summary.*cpu=([\d.]+)s', host_tail)
        res['host_cpu_s_total'] = float(m.group(1)) if m else None
    if record:
        os.makedirs(RES + '/raw', exist_ok=True); os.makedirs(RES + '/hdr', exist_ok=True)
        open('%s/raw/%s.txt' % (RES, tag), 'w').write(trim(out) + (('\n# prototype host:\n' + host_tail + '\n') if host_tail else ''))
        for f in glob.glob(prefix + '_*.hgrm'):
            shutil.copy(f, RES + '/hdr/' + os.path.basename(f))
        with open(RES + '/runs.jsonl', 'a') as f:
            f.write(json.dumps(res) + '\n')
    return res


# ---- tables --------------------------------------------------------------------------------------------------

def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def med_rng(xs, fmt):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    return (fmt % statistics.median(xs)) + ' (' + (fmt % min(xs)) + '-' + (fmt % max(xs)) + ')'


def stat(rs, k):
    xs = [r.get(k) for r in rs if r.get(k) is not None]
    if not xs:
        return None
    return dict(med=statistics.median(xs), lo=min(xs), hi=max(xs), spread=max(xs) - min(xs), n=len(xs))


def table():
    rows = [json.loads(l) for l in open(RES + '/runs.jsonl')]
    out = ['## All runs (median of 3, range in brackets; latency in ms)', '',
           '| config | tool | runs | ops/s | p50 | p99 | p99.9 | max | 1-s min ops | server cores | primary cores | client cores | client µs/op | other cores | GET hit ratio | load before (1-min) |',
           '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for n in CONFIGS:
        rs = [r for r in rows if r['config'] == n]
        if not rs:
            continue
        cus = [r['client_cpu_s'] / r['count'] * 1e6 for r in rs if r.get('count')]
        out.append('| %s | %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, rs[0]['tool'], len(rs), med_rng([r.get('ops_s') for r in rs], '%.0f'), med_rng([r.get('p50') for r in rs], '%.3f'),
            med_rng([r.get('p99') for r in rs], '%.3f'), med_rng([r.get('p999') for r in rs], '%.3f'),
            med_rng([r.get('max_ms') for r in rs], '%.1f'), med_rng([r.get('sec_min') for r in rs], '%.0f'),
            med_rng([r['server_cores'] for r in rs], '%.2f'), med_rng([r['primary_cores'] for r in rs], '%.2f'),
            med_rng([r['client_cores'] for r in rs], '%.2f'), med_rng(cus, '%.1f'),
            med_rng([r['other_cores'] for r in rs], '%.2f'), med_rng([r.get('get_hit_ratio') for r in rs], '%.4f'),
            ', '.join(r['loadavg_before'].split()[0] for r in rs)))
    # mixed loads: SET and GET apart
    out += ['', '## Mixed 1:10 SET:GET, by command (median of 3, range in brackets)', '',
            '| config | command | ops/s | p50 | p99 | p99.9 | max |', '|---|---|---|---|---|---|---|']
    for n in CONFIGS:
        if CONFIGS[n]['test'] != 'mix':
            continue
        rs = [r for r in rows if r['config'] == n]
        for typ in ('Sets', 'Gets'):
            v = [r['per_type'].get(typ, {}) for r in rs if 'per_type' in r]
            if not v:
                continue
            out.append('| %s | %s | %s | %s | %s | %s | %s |' % (n, typ[:-1].upper(), med_rng([x.get('ops_s') for x in v], '%.0f'),
                       med_rng([x.get('p50') for x in v], '%.3f'), med_rng([x.get('p99') for x in v], '%.3f'),
                       med_rng([x.get('p999') for x in v], '%.3f'), med_rng([x.get('max_ms') for x in v], '%.1f')))
    out += ['', compare(rows)]
    if os.path.exists(RES + '/probe.jsonl'):
        out += ['', '## Probes (one run each, not timed rows): how Redis is fed by each tool', '',
                'commands per read = requests / read syscalls of the primary Redis (`/proc/<pid>/io` syscr); Redis µs/request =',
                "the primary's CPU / requests; run-queue wait = time the primary waited for a CPU (`/proc/<pid>/schedstat`), probe 2 only.", '',
                '| probe | config | tool | threads x clients | ops/s | p99 ms | commands per read | primary cores | Redis µs/request | run-queue wait s | client cores | load before |',
                '|---|---|---|---|---|---|---|---|---|---|---|---|']
        k = 0
        for l in open(RES + '/probe.jsonl'):
            r = json.loads(l)
            k += 1
            c = CONFIGS.get(r['config'], {})
            out.append('| %d | %s | %s | %s | %.0f | %.3f | %s | %.2f | %.2f | %s | %.2f | %s |' % (
                1 if 'primary_runq_wait_s' not in r else 2, r['config'], r['tool'],
                '%dx%d' % (c.get('threads', 4), c.get('clients', 50)) if r['tool'] == 'memtier' else '4x50',
                r['ops_s'], r['p99'], ('%.1f' % (r['count'] / r['primary_syscr'])) if r.get('primary_syscr') else '-',
                r['primary_cores'], r['server_cpu_s'][0] / r['count'] * 1e6, r.get('primary_runq_wait_s', '-'),
                r['client_cores'], r['loadavg_before'].split()[0]))
    open(RES + '/tables.md', 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


def compare(rows):
    """memtier against redis-benchmark, row by row: E-09a's runs (read from ../E09a-redis/results/runs.jsonl)
    and this experiment's same-hold redis-benchmark controls. 'agree' = |difference of medians| <= the larger
    of the two ranges (max - min of 3 runs), the rule PERF-01 uses for a win."""
    e9 = [json.loads(l) for l in open(E09A + '/results/runs.jsonl')] if os.path.exists(E09A + '/results/runs.jsonl') else []
    out = ['## memtier vs redis-benchmark, row by row', '',
           '"E-09a rb" = redis-benchmark in E-09a (2026-11-06); "rb here" = the same redis-benchmark command in this',
           "experiment's hold, minutes from the memtier runs. ops ratio = memtier / redis-benchmark. agree = the medians",
           'differ by no more than the larger range of the two (PERF-01\'s spread rule).', '',
           '"paired" = memtier run k / redis-benchmark run k, the two runs minutes apart in the same hold (median and',
           "range of the three): it removes most of the box's drift between holds. The default setup's GET and INCR",
           'controls ran in a later hold (`default2`), so their pairs are an hour apart.', '',
           '| row | memtier ops/s | E-09a rb ops/s | ratio | agree? | rb here ops/s | ratio | agree? | paired | memtier p50 / p99 | E-09a rb p50 / p99 | rb here p50 / p99 |',
           '|---|---|---|---|---|---|---|---|---|---|---|---|']

    def agree(a, b):
        if not a or not b:
            return '-'
        return 'yes' if abs(a['med'] - b['med']) <= max(a['spread'], b['spread']) else 'no'

    def fmt(s, f='%.0f'):
        return '-' if not s else (f % s['med']) + ' (' + (f % s['lo']) + '-' + (f % s['hi']) + ')'

    for n, c in CONFIGS.items():
        if c['tool'] != 'memtier' or c['test'] == 'mix':
            continue
        mt = [r for r in rows if r['config'] == n]
        if not mt:
            continue
        e = [r for r in e9 if r['config'] == c.get('same_as', n)] if c['setup'] not in PROTOS else []
        h = [r for r in rows if r['config'] == n + '-rb']
        sm, se, sh = stat(mt, 'ops_s'), stat(e, 'ops_s'), stat(h, 'ops_s')
        lat = lambda rs: ('%.2f / %.2f' % (med([r.get('p50') for r in rs]), med([r.get('p99') for r in rs]))) if rs else '-'
        pr = [m['ops_s'] / b['ops_s'] for m in mt for b in h if m['run'] == b['run'] and b.get('ops_s')]
        pair = ('%.2f (%.2f-%.2f)' % (statistics.median(pr), min(pr), max(pr))) if pr else '-'
        out.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, fmt(sm), fmt(se), ('%.2f' % (sm['med'] / se['med'])) if se else '-', agree(sm, se),
            fmt(sh), ('%.2f' % (sm['med'] / sh['med'])) if sh else '-', agree(sm, sh), pair, lat(mt), lat(e), lat(h)))
    # rb here against E-09a's rb: did the box change?
    out += ['', '### redis-benchmark here against redis-benchmark in E-09a (same command: is the box the same?)', '',
            '| row | rb here ops/s | E-09a rb ops/s | ratio | agree? | rb here p99 | E-09a rb p99 |', '|---|---|---|---|---|---|---|']
    for n, c in CONFIGS.items():
        if c['tool'] != 'redis-benchmark' or c['setup'] in PROTOS:
            continue
        h = [r for r in rows if r['config'] == n]
        e = [r for r in e9 if r['config'] == c.get('same_as', n)[:-3]]
        if not h:
            continue
        sh, se = stat(h, 'ops_s'), stat(e, 'ops_s')
        out.append('| %s | %s | %s | %s | %s | %s | %s |' % (n[:-3], fmt(sh), fmt(se), ('%.2f' % (sh['med'] / se['med'])) if se else '-',
                   agree(sh, se), fmt(stat(h, 'p99'), '%.3f'), fmt(stat(e, 'p99'), '%.3f')))
    # the bridge hold: the same row on two boots of the VM (aof: boot 1 -> boot 3; aof-r3: boot 2 -> boot 3)
    out += ['', '### The same row on another boot (the `b2` hold, on the third boot, against the first run of that row)', '',
            '`aof` rows first ran on boot 1 (hold `aof`), `aof-r3` rows on boot 2 (hold `r3`); `b2` ran both on boot 3.', '',
            '| row | tool | first run ops/s | b2 ops/s | b2 / first | agree? | first p99 | b2 p99 |', '|---|---|---|---|---|---|---|---|']
    for n, c in CONFIGS.items():
        if not n.startswith('b2-'):
            continue
        b, f = [r for r in rows if r['config'] == n], [r for r in rows if r['config'] == c['same_as']]
        if not b or not f:
            continue
        sb, sf = stat(b, 'ops_s'), stat(f, 'ops_s')
        out.append('| %s | %s | %s | %s | %.2f | %s | %s | %s |' % (c['same_as'], c['tool'], fmt(sf), fmt(sb), sb['med'] / sf['med'],
                   agree(sb, sf), fmt(stat(f, 'p99'), '%.3f'), fmt(stat(b, 'p99'), '%.3f')))
    return '\n'.join(out)


def tails():
    """Where memtier's tail sits inside a run, from the full JSON kept in $KEEP (memtier records each second's
    count and percentiles): the second that holds the run's max (second 0 = the start, when 200 connections
    open at once), and the median of the per-second p99.9 over the whole seconds (the first and last dropped)
    beside the whole run's p99.9. A whole-run p99.9 well above the per-second median means a few bad seconds
    carry the tail, not every second."""
    rows = [json.loads(l) for l in open(RES + '/runs.jsonl')]
    # per-second numbers of every memtier run: from $KEEP when it is there, else from results/persec.jsonl
    # (written here, so the table can be rebuilt from the repo alone)
    ps = {}
    if os.path.exists(RES + '/persec.jsonl'):
        for l in open(RES + '/persec.jsonl'):
            j = json.loads(l); ps[(j['config'], j['run'])] = j['sec']
    for r in rows:
        f = '%s/%s-%d.json' % (KEEP, r['config'], r['run'])
        if r['tool'] == 'memtier' and os.path.exists(f):
            ts = json.load(open(f))['ALL STATS']['Totals']['Time-Serie']
            ps[(r['config'], r['run'])] = [[int(k), ts[k]['Count'], ts[k].get('p50.00'), ts[k].get('p99.00'), ts[k].get('p99.90'),
                                            ts[k].get('Max Latency')] for k in sorted(ts, key=int)]
    with open(RES + '/persec.jsonl', 'w') as f:
        for (n, k), sec in ps.items():
            f.write(json.dumps({'config': n, 'run': k, 'cols': 'second, count, p50, p99, p99.9, max (ms)', 'sec': sec}) + '\n')
    out = ['## Where memtier\'s tail sits (from results/persec.jsonl, per run)', '',
           '"max in s0" = runs whose max latency fell in the first second (the start). Latency in ms.', '',
           '| config | runs | max in s0 | max (median) | whole-run p99.9 (median) | per-second p99.9, median of the run medians | worst second\'s p99.9 (median) |',
           '|---|---|---|---|---|---|---|']
    for n, c in CONFIGS.items():
        if c['tool'] != 'memtier':
            continue
        rs = [r for r in rows if r['config'] == n]
        got = []
        for r in rs:
            sec = ps.get((n, r['run']))
            if not sec:
                continue
            mx = max(sec, key=lambda x: x[5] or 0)
            inner = [x[4] for x in sec[1:-1] if x[4] is not None]
            got.append((mx[0] == sec[0][0], r.get('max_ms'), r.get('p999'), statistics.median(inner) if inner else None,
                        max(inner) if inner else None))
        if not got:
            continue
        out.append('| %s | %d | %d | %s | %s | %s | %s |' % (n, len(got), sum(1 for g in got if g[0]),
                   '%.1f' % med([g[1] for g in got]), '%.3f' % med([g[2] for g in got]), '%.3f' % med([g[3] for g in got]),
                   '%.3f' % med([g[4] for g in got])))
    open(RES + '/tails.md', 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    if a[0] == 'list':
        print('\n'.join('%s  %s' % (n, c) for n, c in CONFIGS.items())); return
    if a[0] == 'smoke':
        for n in a[1:]:
            r = run_one(n, 0, record=False, secs=3, n=20000)
            print(n, 'ops/s %.0f p50 %s p99 %s p99.9 %s max %s srv %s cli %s hit %s gw-errors %s warn %s load %s' % (
                r.get('ops_s') or 0, r.get('p50'), r.get('p99'), r.get('p999'), r.get('max_ms'), r['server_cores'],
                r['client_cores'], r.get('get_hit_ratio'), r.get('gateway_errors'), r.get('warnings'), r['loadavg_before'].split()[0]), flush=True)
        return
    if a[0] == 'probe':
        # one full-length run of each config, kept apart in results/probe.jsonl (not a timed row): used for the
        # syscall counts (commands per server read) of the rows timed before those counts were recorded
        os.makedirs(RES, exist_ok=True)
        for n in a[1:]:
            r = run_one(n, 0, record=False)
            r['run'] = 'probe'
            r.pop('per_type', None)
            with open(RES + '/probe.jsonl', 'a') as f:
                f.write(json.dumps(r) + '\n')
            print('%s probe: %.0f ops/s p99 %s syscr %s syscw %s srv %s cli %s (load %s)' % (
                n, r.get('ops_s') or 0, r.get('p99'), r.get('primary_syscr'), r.get('primary_syscw'), r['server_cores'],
                r['client_cores'], r['loadavg_before']), flush=True)
        return
    if a[0] == 'run':
        runs = 3
        if '--runs' in a:
            i = a.index('--runs'); runs = int(a[i + 1]); del a[i:i + 2]
        os.makedirs(RES, exist_ok=True)
        done = set()
        if os.path.exists(RES + '/runs.jsonl'):
            for l in open(RES + '/runs.jsonl'):
                j = json.loads(l); done.add((j['config'], j['run']))
        names = []
        for pat in a[1:] or ['']:
            names += [n for n in CONFIGS if n.startswith(pat) and n not in names]
        with open(RES + '/timing-log.txt', 'a') as log:
            log.write('# hold %s: %s, start %s, load %s, %s\n' % (' '.join(a[1:]), len(names), time.strftime('%Y-%m-%dT%H:%M:%S'),
                      loadavg(), json.dumps(versions())))
        for k in range(1, runs + 1):           # round-robin: run k of every config before run k+1 of any
            for n in names:
                if (n, k) in done:
                    continue
                try:
                    r = run_one(n, k)
                except RunFailed as e:
                    line = '%s FAILED %s (not recorded as a run; see results/raw/%s-%d-failed.txt)' % (time.strftime('%Y-%m-%dT%H:%M:%S'), e, n, k)
                    print(line, flush=True)
                    with open(RES + '/timing-log.txt', 'a') as log:
                        log.write(line + '\n')
                    continue
                line = '%s %s run %d: %.0f ops/s p50 %s p99 %s p99.9 %s max %s (load %s)' % (
                    r['at'], n, k, r.get('ops_s') or 0, r.get('p50'), r.get('p99'), r.get('p999'), r.get('max_ms'), r['loadavg_before'])
                print(line, flush=True)
                with open(RES + '/timing-log.txt', 'a') as log:
                    log.write(line + '\n')
        with open(RES + '/timing-log.txt', 'a') as log:
            log.write('# hold %s: end %s\n' % (' '.join(a[1:]), time.strftime('%Y-%m-%dT%H:%M:%S')))
        return
    if a[0] == 'table':
        table(); return
    if a[0] == 'tails':
        tails(); return
    print(__doc__)


if __name__ == '__main__':
    main()
