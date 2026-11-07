#!/usr/bin/env python3
"""E-09c (Kafka 4.4.0) and E-09d (Redpanda 26.2.6), driven by Kafka's own perf tools.

Usage (run with python3 -I):
  kbench.py run SYSTEM SETUP PHASE [--runs 3] [--first 1] [--results DIR]   timed runs (numbered from --first), each on a fresh cluster
  kbench.py smoke SYSTEM SETUP PHASE [--scale 0.2]               one short unrecorded run (plumbing check)
  kbench.py table [--results DIR]                                runs.jsonl -> tables.md

SYSTEM   kafka: three KRaft nodes, each broker+controller, 1 GB heap (Kafka's own default for a broker)
         redpanda: three nodes, --smp 1 --memory 2G --overprovisioned
SETUP    kafka:    default (acks=all, min.insync.replicas=2, no flush: the competitor's default)
                   flush1  (the same plus topic config flush.messages=1: fsync after every append: matched)
         redpanda: fsync   (Redpanda's default: acks=all is acknowledged after a majority fsynced: matched)
                   wcache  (topic config write.caching=true: acknowledged at a majority in memory)
PHASE    max: producer at full speed with the client's defaults (max-default) and with OMB's throughput
              settings (max-omb), the consumer perf tool reading max-default's topic, then a share group of
              4 consumers reading it (Kafka's queues, the work-queue bar)
         lat: the producer throttled to half of max-omb's median rate with OMB's latency settings and an
              end-to-end consumer beside it (half); the same at OMB's standard 50,000/s (rate50k); then
              kafka-e2e-latency, one record at a time (e2e1); then AckProbe, one record in flight, timed in µs (ack1)
Every topic: 16 partitions, replication 3, min.insync.replicas=2, 1,024-byte records, acks=all.
"""
import json, os, re, shutil, signal, socket, statistics, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
K = SP + '/dl/kafka/kafka_2.13-4.4.0'
RP = '/opt/redpanda/bin/redpanda'      # a link to $SP/dl/redpanda-deb/root/opt/redpanda (TOOLS.md)
RPK = '/opt/redpanda/bin/rpk'
HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = SP + '/e09/kafka/classes'      # E2eConsumer.class, built by run.sh
TCK = os.sysconf('SC_CLK_TCK')
COUNTS = json.load(open(HERE + '/counts.json'))
PORTS = {'kafka': [39091, 39092, 39093], 'redpanda': [39291, 39292, 39293]}
CTRL = [39191, 39192, 39193]             # Kafka controller listeners
RPC = [39391, 39392, 39393]              # Redpanda internal RPC
ADMIN = [39491, 39492, 39493]            # Redpanda admin API
SETUPS = {'kafka': ['default', 'flush1'], 'redpanda': ['fsync', 'wcache']}
PHASES = {'max': ['max-default', 'consume', 'share-4c', 'max-omb'], 'lat': ['half', 'rate50k', 'e2e1', 'ack1']}
TOOL_ENV = dict(os.environ, KAFKA_HEAP_OPTS='-Xmx512M')
MIN_FREE_GB = 10


def work(system):
    return SP + '/e09/' + system


def loadavg():
    return open('/proc/loadavg').read().strip()


def proc_cpu(pid):
    try:
        f = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
        return (int(f[11]) + int(f[12])) / TCK
    except OSError:
        return None


def proc_rss_mb(pid):
    try:
        for line in open('/proc/%d/status' % pid):
            if line.startswith('VmRSS:'):
                return round(int(line.split()[1]) / 1024)
    except OSError:
        return None


def box_busy():
    f = [int(x) for x in open('/proc/stat').readline().split()[1:]]
    return sum(f) - f[3] - f[4], sum(f)


def free_gb(path):
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize / 2 ** 30


def boot(system):
    return ','.join('127.0.0.1:%d' % p for p in PORTS[system])


def wait_port(port, secs=60):
    t = time.time()
    while time.time() - t < secs:
        try:
            socket.create_connection(('127.0.0.1', port), 0.5).close()
            return True
        except OSError:
            time.sleep(0.2)
    return False


def kafka_tool(name, args, timeout=300):
    return subprocess.run([K + '/bin/' + name] + args, capture_output=True, text=True, env=TOOL_ENV, timeout=timeout)


# ---------------------------------------------------------------- clusters

def start_kafka(setup):
    W = work('kafka')
    stop_all('kafka')
    shutil.rmtree(W + '/data', ignore_errors=True); shutil.rmtree(W + '/logs', ignore_errors=True)
    os.makedirs(W + '/conf', exist_ok=True); os.makedirs(W + '/data'); os.makedirs(W + '/logs')
    voters = ','.join('%d@127.0.0.1:%d' % (i + 1, CTRL[i]) for i in range(3))
    cid = 'e09cKafkaBench4-4-0Aaa'[:22]
    procs = []
    for i in range(3):
        conf = W + '/conf/b%d.properties' % i
        open(conf, 'w').write('\n'.join([
            'process.roles=broker,controller', 'node.id=%d' % (i + 1),
            'controller.quorum.voters=' + voters,
            'listeners=PLAINTEXT://127.0.0.1:%d,CONTROLLER://127.0.0.1:%d' % (PORTS['kafka'][i], CTRL[i]),
            'advertised.listeners=PLAINTEXT://127.0.0.1:%d' % PORTS['kafka'][i],
            'controller.listener.names=CONTROLLER', 'inter.broker.listener.name=PLAINTEXT',
            'listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
            # the rest of Kafka's shipped config/server.properties, unchanged:
            'num.network.threads=3', 'num.io.threads=8', 'socket.send.buffer.bytes=102400',
            'socket.receive.buffer.bytes=102400', 'socket.request.max.bytes=104857600',
            'num.recovery.threads.per.data.dir=2', 'log.retention.hours=168', 'log.segment.bytes=1073741824',
            'log.retention.check.interval.ms=300000',
            'log.dirs=%s/data/b%d' % (W, i),
            # three brokers: internal topics replicated 3 ways, like the data topics
            'num.partitions=16', 'default.replication.factor=3', 'min.insync.replicas=2',
            'offsets.topic.replication.factor=3', 'transaction.state.log.replication.factor=3',
            'transaction.state.log.min.isr=2', 'share.coordinator.state.topic.replication.factor=3',
            'share.coordinator.state.topic.min.isr=2',
            # bench hygiene: no 3 s wait before a consumer group's first join; deleted topics free disk at once
            'group.initial.rebalance.delay.ms=0', 'log.segment.delete.delay.ms=1000',
        ]) + '\n')
        r = subprocess.run([K + '/bin/kafka-storage.sh', 'format', '-t', cid, '-c', conf],
                           capture_output=True, text=True, env=TOOL_ENV)
        if r.returncode != 0:
            raise SystemExit('format failed: ' + r.stdout + r.stderr)
        env = dict(os.environ, KAFKA_HEAP_OPTS='-Xmx1G -Xms1G', LOG_DIR='%s/logs/b%d' % (W, i))
        procs.append(subprocess.Popen([K + '/bin/kafka-server-start.sh', conf], env=env,
                                      stdout=open('%s/logs/b%d.out' % (W, i), 'w'), stderr=subprocess.STDOUT))
    for p in PORTS['kafka']:
        if not wait_port(p, 90):
            stop(procs, 'kafka'); raise SystemExit('kafka broker on %d did not open its port' % p)
    return procs


def start_redpanda(setup):
    W = work('redpanda')
    stop_all('redpanda')
    shutil.rmtree(W + '/data', ignore_errors=True)
    os.makedirs(W + '/data')
    seeds = ''.join('\n    - host: {address: 127.0.0.1, port: %d}' % p for p in RPC)
    procs = []
    for i in range(3):
        d = '%s/data/n%d' % (W, i)
        os.makedirs(d + '/conf'); os.makedirs(d + '/store')
        yaml = d + '/conf/redpanda.yaml'
        open(yaml, 'w').write(
            'redpanda:\n'
            '  data_directory: %s/store\n'
            '  node_id: %d\n'
            '  empty_seed_starts_cluster: false\n'
            '  seed_servers:%s\n'
            '  rpc_server: {address: 127.0.0.1, port: %d}\n'
            '  advertised_rpc_api: {address: 127.0.0.1, port: %d}\n'
            '  kafka_api: [{address: 127.0.0.1, port: %d}]\n'
            '  advertised_kafka_api: [{address: 127.0.0.1, port: %d}]\n'
            '  admin: [{address: 127.0.0.1, port: %d}]\n'
            '  developer_mode: true\n'
            % (d, i, seeds, RPC[i], RPC[i], PORTS['redpanda'][i], PORTS['redpanda'][i], ADMIN[i]))
        # cluster properties at first start (Redpanda reads .bootstrap.yaml beside redpanda.yaml)
        # wcache: write caching on for every topic (Kafka's TopicCommand refuses the topic-level name
        # write.caching, as it checks names against Kafka's own list, so the cluster default is used)
        open(d + '/conf/.bootstrap.yaml', 'w').write(
            'default_topic_replications: 3\nauto_create_topics_enabled: false\n'
            + ('write_caching_default: "true"\n' if setup == 'wcache' else ''))
        procs.append(subprocess.Popen(
            [RP, '--redpanda-cfg', yaml, '--smp', '1', '--memory', '2G', '--overprovisioned',
             '--unsafe-bypass-fsync=false', '--default-log-level=warn'],
            stdout=open(d + '/rp.log', 'w'), stderr=subprocess.STDOUT))
    for p in PORTS['redpanda']:
        if not wait_port(p, 90):
            stop(procs, 'redpanda'); raise SystemExit('redpanda on %d did not open its port' % p)
    for _ in range(300):
        r = subprocess.run([RPK, 'cluster', 'health', '-X', 'admin.hosts=127.0.0.1:%d' % ADMIN[0]],
                           capture_output=True, text=True)
        if re.search(r'Healthy:\s+true', r.stdout):
            return procs
        time.sleep(0.2)
    stop(procs, 'redpanda'); raise SystemExit('redpanda cluster not healthy: ' + r.stdout + r.stderr)


def start(system, setup):
    return start_kafka(setup) if system == 'kafka' else start_redpanda(setup)


def stop_all(system):
    subprocess.run(['pkill', '-f', work(system) + '/'], capture_output=True)
    time.sleep(0.5)


def stop(procs, system):
    for p in procs:
        p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(60)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    stop_all(system)
    shutil.rmtree(work(system) + '/data', ignore_errors=True)


def topic_configs(system, setup):
    c = ['min.insync.replicas=2']
    if setup == 'flush1':
        c.append('flush.messages=1')
    if system == 'redpanda':
        c = [x for x in c if not x.startswith('min.insync')]  # Redpanda: a Raft majority; see README
    return c


def create_topic(system, setup, topic):
    args = ['--bootstrap-server', boot(system), '--create', '--topic', topic, '--partitions', '16',
            '--replication-factor', '3']
    for c in topic_configs(system, setup):
        args += ['--config', c]
    for _ in range(60):
        r = kafka_tool('kafka-topics.sh', args)
        if r.returncode == 0:
            break
        time.sleep(1)
    else:
        raise SystemExit('create topic failed: ' + r.stdout + r.stderr)
    # wait until every partition has a leader and 3 in-sync replicas
    for _ in range(120):
        r = kafka_tool('kafka-topics.sh', ['--bootstrap-server', boot(system), '--describe', '--topic', topic])
        isr = re.findall(r'Isr: ([\d,]+)', r.stdout)
        if len(isr) == 16 and all(len(x.split(',')) == 3 for x in isr):
            return r.stdout
        time.sleep(0.5)
    raise SystemExit('topic not fully in sync: ' + r.stdout)


def delete_topic(system, topic):
    kafka_tool('kafka-topics.sh', ['--bootstrap-server', boot(system), '--delete', '--topic', topic])
    time.sleep(3)


# ---------------------------------------------------------------- parsing

PROD = re.compile(r'(\d+) (?:steady state )?records sent, ([\d.]+) records/sec \(([\d.]+) MB/sec\), ([\d.]+) ms avg latency, '
                  r'([\d.]+) ms max latency, (\d+) ms 50th, (\d+) ms 95th, (\d+) ms 99th, (\d+) ms 99\.9th')


def parse_producer(out):
    r = {}
    for line in out.splitlines():
        m = PROD.search(line)
        if not m:
            continue
        d = dict(zip(['records', 'rec_s', 'mb_s', 'avg_ms', 'max_ms', 'p50', 'p95', 'p99', 'p999'],
                     [float(x) for x in m.groups()]))
        if 'steady' in line.lower():
            r['steady'] = d
        else:
            r['total'] = d
    return r


def parse_csv_stats(out):
    lines = [l for l in out.splitlines() if l.strip() and 'JAVA_TOOL' not in l]
    for i, l in enumerate(lines):
        if l.startswith('start.time'):
            keys = [k.strip() for k in l.split(',')]
            vals = [v.strip() for v in lines[i + 1].split(',')] if i + 1 < len(lines) else []
            d = {}
            for k, v in zip(keys, vals):
                try:
                    d[k] = float(v)
                except ValueError:
                    d[k] = v
            return d
    return {}


def parse_e2e1(out):
    r = {}
    m = re.search(r'Avg latency: ([\d.]+) ms', out)
    if m:
        r['avg_ms'] = float(m.group(1))
    m = re.search(r'Percentiles: 50th = ([\d.]+), 99th = ([\d.]+), 99\.9th = ([\d.]+)', out)
    if m:
        r['p50'], r['p99'], r['p999'] = (float(x) for x in m.groups())
    return r


# ---------------------------------------------------------------- one test

def measure(procs, fg_cmd, bg_cmd=None, bg_ready=None, timeout=300):
    """Run fg_cmd (with bg_cmd beside it, started first). Return outputs and CPU use of brokers and clients."""
    la = loadavg()
    bg = None
    if bg_cmd:
        bg = subprocess.Popen(bg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=TOOL_ENV)
        t = time.time()
        while time.time() - t < 60:  # wait for 'e2e-consumer ready'
            line = bg.stderr.readline()
            if not line or bg_ready in line:
                break
    c0 = [proc_cpu(p.pid) for p in procs]; b0 = box_busy(); t0 = time.time(); ru0 = os.times()
    fg = subprocess.run(fg_cmd, capture_output=True, text=True, timeout=timeout, env=TOOL_ENV)
    t1 = time.time(); c1 = [proc_cpu(p.pid) for p in procs]; b1 = box_busy()
    bgout = ''
    if bg:
        try:
            o, e = bg.communicate(timeout=90)
            bgout = o + e
        except subprocess.TimeoutExpired:
            bg.kill(); o, e = bg.communicate(); bgout = o + e + '\n[killed: timed out]'
    ru1 = os.times()
    wall = t1 - t0
    srv = [round(b - a, 2) for a, b in zip(c0, c1)]
    cli = round((ru1.children_user - ru0.children_user) + (ru1.children_system - ru0.children_system), 2)
    busy = (b1[0] - b0[0]) / (b1[1] - b0[1]) * os.cpu_count()
    meta = {'loadavg_before': la, 'wall_s': round(wall, 2), 'server_cpu_s': srv, 'client_cpu_s': cli,
            'server_cores': round(sum(srv) / wall, 2), 'client_cores': round(cli / wall, 2),
            'box_busy_cores': round(busy, 2), 'other_cores': round(busy - (sum(srv) + cli) / wall, 2),
            'rc': fg.returncode, 'server_rss_mb': [proc_rss_mb(p.pid) for p in procs]}
    return fg.stdout + fg.stderr, bgout, meta


def half_rate(results, system, setup):
    """Half of max-omb's median steady-state rate (PERF-05: p99 end-to-end at half of the max rate)."""
    rows = [json.loads(l) for l in open(results + '/runs.jsonl')] if os.path.exists(results + '/runs.jsonl') else []
    rates = [r['steady']['rec_s'] for r in rows
             if r['system'] == system and r['setup'] == setup and r['test'] == 'max-omb' and r.get('steady')]
    if not rates:
        raise SystemExit('no max-omb runs for %s %s yet: run the max phase first' % (system, setup))
    return int(statistics.median(rates) / 2)


# OMB's Kafka driver settings (cited: results/omb-*.yaml): throughput workloads and latency workloads
OMB_THROUGHPUT = ['acks=all', 'linger.ms=1', 'batch.size=1048576']
OMB_LATENCY = ['acks=all', 'linger.ms=1', 'batch.size=131072']


def run_test(system, setup, test, procs, n, results, scale):
    B = boot(system)
    prod = [K + '/bin/kafka-producer-perf-test.sh', '--bootstrap-server', B, '--record-size', '1024']
    if test in ('max-default', 'max-omb'):
        topic = 'tmax' if test == 'max-default' else 'tomb'
        create_topic(system, setup, topic)
        props = OMB_THROUGHPUT if test == 'max-omb' else ['acks=all']
        cmd = prod + ['--topic', topic, '--num-records', str(n), '--warmup-records', str(n // 6),
                      '--throughput', '-1', '--command-property'] + props
        out, _, meta = measure(procs, cmd)
        res = parse_producer(out)
        if test == 'max-omb':
            delete_topic(system, topic)
        return out, res, meta
    if test == 'consume':
        cmd = [K + '/bin/kafka-consumer-perf-test.sh', '--bootstrap-server', B, '--topic', 'tmax',
               '--num-records', str(n), '--timeout', '30000', '--group', 'cg-%d' % int(time.time())]
        out, _, meta = measure(procs, cmd)
        return out, parse_csv_stats(out), meta
    if test == 'share-4c' and system == 'redpanda':
        # Redpanda answers every share-group API with UNSUPPORTED (results/apicheck.txt): nothing to run
        delete_topic(system, 'tmax')
        return 'share groups: not supported by this server (see apicheck.txt)\n', {'unsupported': True}, {'rc': None, 'loadavg_before': loadavg()}
    if test == 'share-4c':
        g = 'sg-%d' % int(time.time())
        r = kafka_tool('kafka-configs.sh', ['--bootstrap-server', B, '--alter', '--entity-type', 'groups',
                                            '--entity-name', g, '--add-config', 'share.auto.offset.reset=earliest'])
        if r.returncode != 0:
            return r.stdout + r.stderr, {'error': 'share group config refused'}, {'rc': r.returncode, 'loadavg_before': loadavg()}
        cmd = [K + '/bin/kafka-share-consumer-perf-test.sh', '--bootstrap-server', B, '--topic', 'tmax',
               '--num-records', str(n), '--threads', '4', '--group', g, '--timeout', '30000']
        out, _, meta = measure(procs, cmd)
        res = parse_csv_stats(out)
        delete_topic(system, 'tmax')
        return out, res, meta
    if test in ('half', 'rate50k'):
        rate = n  # records/s: half of max-omb's median, or OMB's standard 50,000/s
        secs, warm = max(5, int(35 * scale)), max(1, int(5 * scale))
        # keep the disk safe: at most 2.5 M records (7.5 GB across the three replicas) per run
        secs = max(10, min(secs, 2500000 // rate)) if scale >= 1 else secs
        create_topic(system, setup, 'thalf')
        cons = ['java', '-Xmx512M', '-cp', CLASSES + ':' + K + '/libs/*', 'E2eConsumer', B, 'thalf',
                str(rate * warm), str(secs + 10), '5']
        cmd = prod + ['--topic', 'thalf', '--num-records', str(rate * secs), '--warmup-records', str(rate * warm),
                      '--throughput', str(rate), '--command-property'] + OMB_LATENCY
        out, cout, meta = measure(procs, cmd, cons, 'e2e-consumer ready')
        res = parse_producer(out)
        m = re.search(r'\{"count".*\}', cout)
        res['e2e'] = json.loads(m.group(0)) if m else {'error': cout[-500:]}
        res['offered_rec_s'] = rate
        delete_topic(system, 'thalf')
        return out + '\n--- e2e consumer ---\n' + cout, res, meta
    if test == 'ack1':
        create_topic(system, setup, 'tack')
        cmd = ['java', '-Xmx512M', '-cp', CLASSES + ':' + K + '/libs/*', 'AckProbe', B, 'tack', str(n),
               str(min(2000, n // 10)), '40']
        out, _, meta = measure(procs, cmd)
        m = re.search(r'\{"count".*\}', out)
        res = json.loads(m.group(0)) if m else {'error': out[-500:]}
        delete_topic(system, 'tack')
        return out, res, meta
    if test == 'e2e1':
        create_topic(system, setup, 'te2e')
        cmd = [K + '/bin/kafka-e2e-latency.sh', '--bootstrap-server', B, '--topic', 'te2e', '--num-records', str(n),
               '--producer-acks', 'all', '--record-size', '1024']
        out, _, meta = measure(procs, cmd)
        res = parse_e2e1(out)
        delete_topic(system, 'te2e')
        return out, res, meta
    raise KeyError(test)


def warm(system, setup, procs, n):
    """Not recorded: about 10 s of producing at full speed on a scratch topic, so the brokers' JIT and
    caches are warm before the first timed test (results/warmcheck.txt: a cold cluster streamed at about 3 x the latency of a warm one)."""
    create_topic(system, setup, 'twarm')
    subprocess.run([K + '/bin/kafka-producer-perf-test.sh', '--bootstrap-server', boot(system), '--record-size', '1024',
                    '--topic', 'twarm', '--num-records', str(n), '--throughput', '-1', '--command-property'] + OMB_THROUGHPUT,
                   capture_output=True, text=True, env=TOOL_ENV, timeout=300)
    delete_topic(system, 'twarm')


def run_phase(system, setup, phase, run, results, record=True, scale=1.0):
    if free_gb(SP) < MIN_FREE_GB:
        raise SystemExit('only %.1f GB free on the scratch disk: stop' % free_gb(SP))
    procs = start(system, setup)
    rows = []
    try:
        warm(system, setup, procs, int(COUNTS[system][setup]['warm'] * scale))
        for test in PHASES[phase]:
            if test == 'half':
                n = half_rate(results, system, setup) if record else int(COUNTS[system][setup]['half'] * scale)
            elif test == 'rate50k':
                n = 50000
                if record and half_rate(results, system, setup) * 2 < 50000 * 1.1:
                    print('%s:%s: rate50k skipped: max-omb median is under 55,000/s' % (system, setup), flush=True)
                    continue
            elif test in ('consume', 'share-4c'):
                n = int(COUNTS[system][setup]['max-default'] * scale)  # read back what max-default wrote
            else:
                n = int(COUNTS[system][setup][test] * scale)
            out, res, meta = run_test(system, setup, test, procs, n, results, scale)
            row = dict(system=system, setup=setup, test=test, run=run, n=n, **res, **meta)
            rows.append(row)
            summary = {k: row.get(k) for k in ('n', 'rc', 'wall_s', 'server_cores', 'client_cores', 'other_cores')}
            print('%s:%s:%s run %d: %s %s' % (system, setup, test, run, json.dumps(res)[:400], summary), flush=True)
            if record:
                open('%s/raw/%s-%s-%s-r%d.txt' % (results, system, setup, test, run), 'w').write(trim(out))
                with open(results + '/runs.jsonl', 'a') as f:
                    f.write(json.dumps(row) + '\n')
            else:
                print(trim(out, 30))
    finally:
        if not record:
            for p in procs:
                print('server', p.pid, 'rss_mb', proc_rss_mb(p.pid))
        stop(procs, system)
    return rows


def trim(out, keep=60):
    lines = [l for l in out.splitlines() if 'JAVA_TOOL_OPTIONS' not in l]
    return '\n'.join(lines if len(lines) <= 2 * keep else lines[:keep] + ['[... %d lines cut ...]' % (len(lines) - 2 * keep)] + lines[-keep:]) + '\n'


# ---------------------------------------------------------------- tables

def med(xs):
    xs = [x for x in xs if x is not None]
    return (statistics.median(xs), min(xs), max(xs)) if xs else None


def fmt(t, d=1):
    if t is None:
        return '-'
    f = '{:,.%df}' % d
    return '%s (%s-%s)' % (f.format(t[0]), f.format(t[1]), f.format(t[2]))


def table(results):
    rows = [json.loads(l) for l in open(results + '/runs.jsonl')]
    out = ['# Tables (median of runs, range in brackets)', '']
    groups = {}
    for r in rows:
        groups.setdefault((r['system'], r['setup'], r['test']), []).append(r)
    out += ['## Producer (kafka-producer-perf-test, 1 KiB, acks=all; steady state after the warm-up records)', '',
            '| system:setup:test | runs | records/s | MB/s | p50 ms | p95 ms | p99 ms | p99.9 ms | max ms | e2e p50 ms | e2e p99 ms | e2e p99.9 ms | e2e max ms | server cores | client cores | other cores | broker µs CPU/record | load before (1-min) |',
            '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for key, rs in groups.items():
        if key[2] not in ('max-default', 'max-omb', 'half', 'rate50k'):
            continue
        st = [r.get('steady') or r.get('total') or {} for r in rs]
        e2e = [r.get('e2e', {}) for r in rs]
        cpu_per = [r['server_cores'] / s['rec_s'] * 1e6 if s.get('rec_s') else None for r, s in zip(rs, st)]
        out.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            ':'.join(key), len(rs), fmt(med([s.get('rec_s') for s in st]), 0), fmt(med([s.get('mb_s') for s in st])),
            fmt(med([s.get('p50') for s in st]), 0), fmt(med([s.get('p95') for s in st]), 0),
            fmt(med([s.get('p99') for s in st]), 0), fmt(med([s.get('p999') for s in st]), 0),
            fmt(med([s.get('max_ms') for s in st]), 0),
            fmt(med([e.get('p50') for e in e2e]), 0) if key[2] in ('half', 'rate50k') else '-',
            fmt(med([e.get('p99') for e in e2e]), 0) if key[2] in ('half', 'rate50k') else '-',
            fmt(med([e.get('p999') for e in e2e]), 0) if key[2] in ('half', 'rate50k') else '-',
            fmt(med([e.get('max') for e in e2e]), 0) if key[2] in ('half', 'rate50k') else '-',
            fmt(med([r.get('server_cores') for r in rs]), 2), fmt(med([r.get('client_cores') for r in rs]), 2),
            fmt(med([r.get('other_cores') for r in rs]), 2), fmt(med(cpu_per), 1),
            ' / '.join(r['loadavg_before'].split()[0] for r in rs)))
    out += ['', '## Consumers (kafka-consumer-perf-test; kafka-share-consumer-perf-test with 4 consumers in one share group)', '',
            '| system:setup:test | runs | records | MB/s (whole run) | records/s (whole run) | fetch MB/s | fetch records/s | server cores | client cores | load before (1-min) |',
            '|---|---|---|---|---|---|---|---|---|---|']
    for key, rs in groups.items():
        if key[2] not in ('consume', 'share-4c'):
            continue
        g = lambda k: med([r.get(k) for r in rs if isinstance(r.get(k), float)])
        if all(r.get('unsupported') for r in rs):
            out.append('| %s | %d | not supported by the server (apicheck.txt) | | | | | | | |' % (':'.join(key), len(rs)))
            continue
        out.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            ':'.join(key), len(rs), fmt(g('data.consumed.in.nMsg'), 0), fmt(g('MB.sec')), fmt(g('nMsg.sec'), 0),
            fmt(g('fetch.MB.sec')), fmt(g('fetch.nMsg.sec'), 0),
            fmt(med([r.get('server_cores') for r in rs]), 2), fmt(med([r.get('client_cores') for r in rs]), 2),
            ' / '.join(r['loadavg_before'].split()[0] for r in rs)))
    out += ['', '## One record at a time (kafka-e2e-latency, 1 KiB, acks=all): send, wait for the ack, wait for the consumer', '',
            '| system:setup:test | runs | records | avg ms | p50 ms | p99 ms | p99.9 ms | server cores | client cores | load before (1-min) |',
            '|---|---|---|---|---|---|---|---|---|---|']
    for key, rs in groups.items():
        if key[2] != 'e2e1':
            continue
        out.append('| %s | %d | %d | %s | %s | %s | %s | %s | %s | %s |' % (
            ':'.join(key), len(rs), rs[0]['n'], fmt(med([r.get('avg_ms') for r in rs]), 3),
            fmt(med([r.get('p50') for r in rs]), 3), fmt(med([r.get('p99') for r in rs]), 3),
            fmt(med([r.get('p999') for r in rs]), 3),
            fmt(med([r.get('server_cores') for r in rs]), 2), fmt(med([r.get('client_cores') for r in rs]), 2),
            ' / '.join(r['loadavg_before'].split()[0] for r in rs)))
    out += ['', '## One record in flight, ack timed in µs (AckProbe on Kafka\'s Java client: acks=all, linger.ms=0)', '',
            '| system:setup:test | runs | records | acks/s | p50 ms | p90 ms | p99 ms | p99.9 ms | max ms | server cores | client cores | load before (1-min) |',
            '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for key, rs in groups.items():
        if key[2] != 'ack1':
            continue
        ms = lambda k: med([r[k] / 1000 if isinstance(r.get(k), (int, float)) else None for r in rs])
        out.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            ':'.join(key), len(rs), fmt(med([r.get('count') for r in rs]), 0), fmt(med([r.get('rate') for r in rs]), 0),
            fmt(ms('p50'), 3), fmt(ms('p90'), 3), fmt(ms('p99'), 3), fmt(ms('p999'), 3), fmt(ms('max'), 1),
            fmt(med([r.get('server_cores') for r in rs]), 2), fmt(med([r.get('client_cores') for r in rs]), 2),
            ' / '.join(r['loadavg_before'].split()[0] for r in rs)))
    open(results + '/tables.md', 'w').write('\n'.join(out) + '\n')
    print('\n'.join(out))


def main():
    a = sys.argv[1:]
    results = HERE + '/results'
    if '--results' in a:
        i = a.index('--results'); results = os.path.abspath(a[i + 1]); del a[i:i + 2]
    runs = 3
    if '--runs' in a:
        i = a.index('--runs'); runs = int(a[i + 1]); del a[i:i + 2]
    first = 1  # number of the first run (to finish a phase whose later runs were cut off)
    if '--first' in a:
        i = a.index('--first'); first = int(a[i + 1]); del a[i:i + 2]
    scale = 0.2
    if '--scale' in a:
        i = a.index('--scale'); scale = float(a[i + 1]); del a[i:i + 2]
    os.makedirs(results + '/raw', exist_ok=True)
    if a[0] == 'table':
        return table(results)
    system, setup, phase = a[1], a[2], a[3]
    assert setup in SETUPS[system] and phase in PHASES, (system, setup, phase)
    if a[0] == 'smoke':
        run_phase(system, setup, phase, 0, results, record=False, scale=scale)
    elif a[0] == 'run':
        for r in range(first, first + runs):
            run_phase(system, setup, phase, r, results)


if __name__ == '__main__':
    main()
