#!/usr/bin/env python3
"""E-09b: NATS 2.10.22 driven by the nats CLI 0.5.1 (`nats bench`, `nats latency`).

Usage (run with python3 -I):
  bench.py run SETUP... [--runs 3]   timed runs; each run starts SETUP fresh and runs all its tests
  bench.py smoke SETUP...            one short unrecorded run (plumbing check, not a result)
  bench.py table                     results/runs.jsonl -> results/tables.md

Setups:
  core        one server, core NATS (no JetStream): 1 -> 1 and 1 -> 16 at 16 B and 1 KiB; `nats latency`
  core-route  three clustered servers: `nats latency` with the publisher on server A and the subscriber on B
  js-always   three servers, JetStream file storage, sync_interval: always (fsync before the ack: matched)
  js-default  the same with NATS's default sync_interval (2 minutes): the competitor's default
JetStream tests: publish with acks (sync, 1 and 16 clients; async batch 500, 100 B and 1 KiB), a pull
consumer (fetch, batch 500), and a work-queue stream (publish, then 4 pull clients that ack each message).
Streams have 3 replicas and file storage.
"""
import json, os, re, shutil, signal, statistics, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
NATS = SP + '/dl/natscli/unz/nats-0.5.1-linux-amd64/nats'
NSRV = SP + '/dl/nats/nats-server-v2.10.22-linux-amd64/nats-server'
WORK = SP + '/e09/nats'
HERE = os.path.dirname(os.path.abspath(__file__))
RES = HERE + '/results'
TCK = os.sysconf('SC_CLK_TCK')
CPORT = [34222, 34223, 34224]
RPORT = [36222, 36223, 36224]
MSGS = json.load(open(HERE + '/msgs.json')) if os.path.exists(HERE + '/msgs.json') else {}
LAT_SECONDS = 20
LAT_RATE = 10000

CORE_TESTS = ['pubsub-1to1-16B', 'pubsub-1to16-16B', 'pubsub-1to1-1KB', 'pubsub-1to16-1KB', 'latency-16B', 'latency-1KB']
JS_TESTS = ['pub-sync-1c-100B', 'pub-sync-16c-100B', 'pub-async-100B', 'fetch-100B', 'pub-async-1KB', 'wq-pub-100B', 'wq-fetch-4c-100B']
SETUPS = {'core': CORE_TESTS, 'core-route': ['latency-route-16B'], 'js-always': JS_TESTS, 'js-default': JS_TESTS}


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


def url(i=0):
    return 'nats://127.0.0.1:%d' % CPORT[i]


def start(setup):
    subprocess.run(['pkill', '-f', WORK + '/conf/'], capture_output=True)
    time.sleep(0.2)
    shutil.rmtree(WORK + '/data', ignore_errors=True)
    os.makedirs(WORK + '/conf', exist_ok=True); os.makedirs(WORK + '/data')
    n = 1 if setup == 'core' else 3
    procs = []
    for i in range(n):
        conf = ['server_name: n%d' % i, 'listen: 127.0.0.1:%d' % CPORT[i]]
        if n > 1:
            conf += ['cluster { name: e09b, listen: 127.0.0.1:%d, routes: [%s] }' % (
                RPORT[i], ', '.join('nats://127.0.0.1:%d' % p for p in RPORT))]
        if setup.startswith('js'):
            js = 'jetstream { store_dir: "%s/data/n%d"' % (WORK, i)
            if setup == 'js-always':
                js += ', sync_interval: always'
            conf.append(js + ' }')
        f = WORK + '/conf/n%d.conf' % i
        open(f, 'w').write('\n'.join(conf) + '\n')
        procs.append(subprocess.Popen([NSRV, '-c', f], stdout=open(WORK + '/data/n%d.log' % i, 'w'), stderr=subprocess.STDOUT))
    for _ in range(300):
        if setup.startswith('js'):
            r = subprocess.run([NATS, '-s', url(), 'stream', 'ls', '--json'], capture_output=True, text=True)
            if r.returncode == 0:
                return procs
        else:
            r = subprocess.run([NATS, '-s', url(n - 1), 'rtt'], capture_output=True, text=True)
            if r.returncode == 0:
                time.sleep(0.5 if n > 1 else 0)
                return procs
        time.sleep(0.1)
    stop(procs)
    raise SystemExit('nats did not start: ' + r.stdout + r.stderr)


def stop(procs):
    for p in procs:
        p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(20)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    shutil.rmtree(WORK + '/data', ignore_errors=True)


UNIT = {'ns': 1e-6, 'us': 1e-3, 'µs': 1e-3, 'ms': 1.0, 's': 1e3}


def dur_ms(s):
    m = re.match(r'([\d.,]+)\s*(ns|us|µs|ms|s)', s.strip())
    return float(m.group(1).replace(',', '')) * UNIT[m.group(2)] if m else None


def parse_bench(out):
    """The aggregate line: '... stats: 28,296 msgs/sec ~ ... ~ P50: 18.92us ~ P90: ... ~ P99: ... ~ P99.9: ...'."""
    r = {}
    role = 'pub'
    for line in out.splitlines():
        if 'stats:' in line and 'msgs/sec' in line:
            role = 'sub' if ('subscriber' in line or 'consumer' in line) else 'pub'
            m = re.search(r'stats: ([\d,]+) msgs/sec', line)
            r[role + '_msgs_s'] = float(m.group(1).replace(',', ''))
        if ('stats:' in line and 'msgs/sec' in line) or 'latencies per operation' in line:
            # one client: 'P50: 18.92us'; several clients (aggregate line): 'P50 79.28us', 'P99.9: 3,858.96us'
            for k, v in re.findall(r'(P50|P90|P99\.9|P99|max|avg|min):? ([\d.,]+\s*(?:ns|us|µs|ms|s))', line):
                r[role + '_' + k.lower().replace('.', '')] = dur_ms(v)
    return r


def parse_latency(out):
    r = {}
    for p, v in re.findall(r'^(?:\S+ )?([\d.]+):\s+([\d.]+\s*(?:ns|us|µs|ms|s))\s*$', out, re.M):
        r['p' + p.replace('.', '')] = dur_ms(v)
    m = re.search(r'Actual Msgs/Sec: (\d+)', out); r['msgs_s'] = float(m.group(1)) if m else None
    m = re.search(r'Maximum Latency: (\S+)', out); r['max_ms'] = dur_ms(m.group(1)) if m else None
    return r


def run_cmds(cmds, procs):
    """Start cmds[:-1] in the background, then run cmds[-1]; wait for all. Return outputs and CPU."""
    la = loadavg()
    c0 = [proc_cpu(p.pid) for p in procs]; b0 = box_busy(); t0 = time.time(); ru0 = os.times()
    bg = [subprocess.Popen(c, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) for c in cmds[:-1]]
    if bg:
        time.sleep(1.0)  # let the subscribers connect before the publisher starts
    fg = subprocess.run(cmds[-1], capture_output=True, text=True, timeout=240)
    outs = []
    for p in bg:
        try:
            outs.append(p.communicate(timeout=120)[0])
        except subprocess.TimeoutExpired:
            p.kill(); outs.append(p.communicate()[0] + '\n[killed: timed out]')
    ru1 = os.times(); t1 = time.time(); b1 = box_busy(); c1 = [proc_cpu(p.pid) for p in procs]
    wall = t1 - t0 - (1.0 if bg else 0)
    srv = [round(b - a, 2) for a, b in zip(c0, c1)]
    cli = round((ru1.children_user - ru0.children_user) + (ru1.children_system - ru0.children_system), 2)
    busy = (b1[0] - b0[0]) / (b1[1] - b0[1]) * os.cpu_count()
    meta = {'loadavg_before': la, 'wall_s': round(wall, 2), 'server_cpu_s': srv, 'client_cpu_s': cli,
            'server_cores': round(sum(srv) / wall, 2), 'client_cores': round(cli / wall, 2),
            'box_busy_cores': round(busy, 2), 'other_cores': round(busy - (sum(srv) + cli) / wall, 2), 'rc': fg.returncode}
    return outs + [fg.stdout + fg.stderr], meta


def test_cmds(setup, test, msgs):
    S = ['-s', url()]
    if test.startswith('pubsub'):
        subs = 16 if '1to16' in test else 1
        size = '16B' if test.endswith('16B') else '1KB'
        return [[NATS] + S + ['bench', 'sub', 'e09b.core', '--clients', str(subs), '--msgs', str(msgs), '--size', size, '--no-progress'],
                [NATS] + S + ['bench', 'pub', 'e09b.core', '--clients', '1', '--msgs', str(msgs), '--size', size, '--no-progress']]
    if test.startswith('latency'):
        size = '16' if '16B' in test else '1024'
        b = url(1) if 'route' in test else url()
        return [[NATS] + S + ['latency', '--server-b', b, '--size', size, '--rate', str(LAT_RATE), '--duration', '%ds' % LAT_SECONDS]]
    js = [NATS] + S + ['bench', 'js']
    common = ['--create', '--replicas', '3', '--storage', 'file', '--maxbytes', '1GB']
    if test == 'pub-sync-1c-100B':
        return [js + ['--stream', 's1', '--clients', '1', '--msgs', str(msgs), '--size', '100B', '--no-progress', 'pub', 'sync', 'e09b.s1'] + common]
    if test == 'pub-sync-16c-100B':
        return [js + ['--stream', 's16', '--clients', '16', '--msgs', str(msgs), '--size', '100B', '--no-progress', 'pub', 'sync', 'e09b.s16'] + common]
    if test == 'pub-async-100B':
        return [js + ['--stream', 'sa', '--clients', '1', '--msgs', str(msgs), '--size', '100B', '--no-progress', 'pub', 'async', 'e09b.sa', '--batch', '500'] + common]
    if test == 'fetch-100B':
        return [js + ['--stream', 'sa', '--clients', '1', '--msgs', str(msgs), '--no-progress', 'fetch', '--batch', '500']]
    if test == 'pub-async-1KB':
        return [js + ['--stream', 'sk', '--clients', '1', '--msgs', str(msgs), '--size', '1KB', '--no-progress', 'pub', 'async', 'e09b.sk', '--batch', '500'] + common]
    if test == 'wq-pub-100B':
        return [js + ['--stream', 'wq', '--clients', '1', '--msgs', str(msgs), '--size', '100B', '--no-progress', 'pub', 'async', 'e09b.wq', '--batch', '500']]
    if test == 'wq-fetch-4c-100B':
        return [js + ['--stream', 'wq', '--clients', '4', '--msgs', str(msgs), '--no-progress', 'fetch', '--batch', '500']]
    raise KeyError(test)


def make_wq():
    r = subprocess.run([NATS, '-s', url(), 'stream', 'add', 'wq', '--subjects', 'e09b.wq', '--retention', 'work',
                        '--storage', 'file', '--replicas', '3', '--max-bytes', '1GB', '--defaults'], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('stream add wq failed: ' + r.stdout + r.stderr)


def run_setup(setup, run, record=True, scale=1.0):
    procs = start(setup)
    results = []
    try:
        for test in SETUPS[setup]:
            name = setup + ':' + test
            msgs = int(MSGS.get(name, 100000) * scale)
            if test == 'fetch-100B':
                msgs = results_msgs.get('pub-async-100B', msgs)
            if test == 'wq-fetch-4c-100B':
                msgs = results_msgs.get('wq-pub-100B', msgs)
            if test == 'wq-pub-100B':
                make_wq()
            cmds = test_cmds(setup, test, msgs)
            outs, meta = run_cmds(cmds, procs)
            res = {'exp': 'E-09b', 'config': name, 'setup': setup, 'test': test, 'run': run, 'msgs': msgs,
                   'cmd': ' | '.join(' '.join(c) for c in cmds), 'at': time.strftime('%Y-%m-%dT%H:%M:%S')}
            res.update(meta)
            joined = '\n'.join(outs)
            if test.startswith('latency'):
                res.update(parse_latency(joined))
            else:
                res.update(parse_bench(joined))
            if test.startswith('pubsub'):
                subs = 16 if '1to16' in test else 1
                if res.get('sub_msgs_s'):
                    res['deliveries_s'] = res['sub_msgs_s']  # the aggregated subscriber rate counts every delivery
                res['subscribers'] = subs
            res['killed'] = '[killed' in joined
            results.append(res)
            if record:
                open('%s/raw/%s-%s-%d.txt' % (RES, setup, test, run), 'w').write(trim(joined))
                with open(RES + '/runs.jsonl', 'a') as f:
                    f.write(json.dumps(res) + '\n')
            results_msgs[test] = msgs
            drop = {'pub-sync-1c-100B': 's1', 'pub-sync-16c-100B': 's16', 'fetch-100B': 'sa', 'pub-async-1KB': 'sk', 'wq-fetch-4c-100B': 'wq'}
            if test in drop:  # free the stream's storage reservation before the next test
                subprocess.run([NATS, '-s', url(), 'stream', 'rm', '-f', drop[test]], capture_output=True)
            print('%s run %d: %s' % (name, run, summary(res)), flush=True)
    finally:
        stop(procs)
    return results


results_msgs = {}


def summary(r):
    keys = ['pub_msgs_s', 'sub_msgs_s', 'pub_p50', 'pub_p99', 'msgs_s', 'p50', 'p99', 'p999', 'server_cores', 'client_cores', 'wall_s', 'rc', 'killed']
    return ' '.join('%s=%s' % (k, r[k]) for k in keys if k in r) + ' load=' + r['loadavg_before'].split()[0]


def trim(out):
    keep = [l for l in out.splitlines() if l.strip() and 'Starting' not in l]
    return '\n'.join(keep)[-8000:] + '\n'


def med_rng(xs, fmt):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    return (fmt % statistics.median(xs)) + ' (' + (fmt % min(xs)) + '-' + (fmt % max(xs)) + ')'


def table():
    rows = [json.loads(l) for l in open(RES + '/runs.jsonl')]
    order = []
    for s, ts in SETUPS.items():
        order += [s + ':' + t for t in ts]
    out = ['| setup : test | runs | msgs | publisher msgs/s | subscriber or consumer msgs/s (all clients) | pub p50 ms | pub p99 ms | pub p99.9 ms | server cores (all) | client cores | other cores | load before (1-min) |',
           '|---|---|---|---|---|---|---|---|---|---|---|---|']
    lat = ['| setup : test | runs | msgs/s | p50 ms | p90 ms | p99 ms | p99.9 ms | max ms | server cores | client cores | load before (1-min) |',
           '|---|---|---|---|---|---|---|---|---|---|---|']
    for n in order:
        rs = [r for r in rows if r['config'] == n]
        if not rs:
            continue
        la = ', '.join(r['loadavg_before'].split()[0] for r in rs)
        if 'latency' in n:
            lat.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
                n, len(rs), med_rng([r.get('msgs_s') for r in rs], '%.0f'), med_rng([r.get('p50') for r in rs], '%.3f'),
                med_rng([r.get('p90') for r in rs], '%.3f'), med_rng([r.get('p99') for r in rs], '%.3f'),
                med_rng([r.get('p999') for r in rs], '%.3f'), med_rng([r.get('max_ms') for r in rs], '%.2f'),
                med_rng([r['server_cores'] for r in rs], '%.2f'), med_rng([r['client_cores'] for r in rs], '%.2f'), la))
            continue
        out.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            n, len(rs), rs[0]['msgs'], med_rng([r.get('pub_msgs_s') for r in rs], '%.0f'), med_rng([r.get('sub_msgs_s') for r in rs], '%.0f'),
            med_rng([r.get('pub_p50') for r in rs], '%.3f'), med_rng([r.get('pub_p99') for r in rs], '%.3f'),
            med_rng([r.get('pub_p999') for r in rs], '%.3f'), med_rng([r['server_cores'] for r in rs], '%.2f'),
            med_rng([r['client_cores'] for r in rs], '%.2f'), med_rng([r['other_cores'] for r in rs], '%.2f'), la))
    bad = [(r['config'], r['run']) for r in rows if r.get('killed') or r.get('rc')]
    txt = '\n'.join(out) + '\n\n' + '\n'.join(lat) + '\n'
    if bad:
        txt += '\nRuns that timed out or failed: ' + ', '.join('%s run %d' % b for b in bad) + '\n'
    open(RES + '/tables.md', 'w').write(txt)
    print(txt)


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    os.makedirs(RES + '/raw', exist_ok=True)
    if a[0] == 'smoke':
        sc = 0.1
        if '--scale' in a:
            i = a.index('--scale'); sc = float(a[i + 1]); del a[i:i + 2]
        for s in a[1:]:
            run_setup(s, 0, record=False, scale=sc)
        return
    if a[0] == 'run':
        runs = 3
        if '--runs' in a:
            i = a.index('--runs'); runs = int(a[i + 1]); del a[i:i + 2]
        done = {}
        if os.path.exists(RES + '/runs.jsonl'):
            for l in open(RES + '/runs.jsonl'):
                j = json.loads(l); done[(j['setup'], j['run'])] = True
        for s in a[1:]:
            for k in range(1, runs + 1):
                if not done.get((s, k)):
                    run_setup(s, k)
        return
    if a[0] == 'table':
        table(); return
    print(__doc__)


if __name__ == '__main__':
    main()
