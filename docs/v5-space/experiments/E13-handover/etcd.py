#!/usr/bin/env python3
"""E-13 (etcd part): planned handover, failover and catch-up per GB on three etcd 3.5.17 members.

Run with python3 -I, under $SP/bin/timing. Every run starts a fresh cluster and deletes it after.
  etcd.py move  [--runs 3]          etcdctl move-leader, 5 transfers per run, under a steady put load
  etcd.py kill  --election 1000|2000 [--runs 3]   kill -9 of the leader under a steady put load
  etcd.py join  --mode log|snap [--gb 1] [--runs 3]   a fourth member joins a cluster that holds about 1 GB
  etcd.py table                      results/*.jsonl -> results/tables.md

The load is ../load (etcd's Go client): 2,000 logical puts/s of 256 B over 16 writers, each write retried
until acknowledged. It stamps every write's first try and its ack, and the driver's marks, on one clock.
"""
import json, os, signal, shutil, statistics, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
ETCD = SP + '/dl/etcd/etcd-v3.5.17-linux-amd64'
BENCH = SP + '/tools-src/etcd-benchmark/etcd-benchmark'
LOAD = SP + '/e13/e13load'
WORK = SP + '/e13/etcd'
HERE = os.path.dirname(os.path.abspath(__file__))
RES = HERE + '/results'
MEMBERS = [('m1', 33379, 33380), ('m2', 33479, 33480), ('m3', 33579, 33580), ('m4', 33679, 33680)]


def loadavg():
    return open('/proc/loadavg').read().strip()


def sh(*a, **k):
    return subprocess.run(list(a), capture_output=True, text=True, **k)


def ep(m):
    return '127.0.0.1:%d' % m[1]


def kill_strays():
    sh('pkill', '-9', '-f', WORK + '/data/')


def start_member(m, cluster, state, extra, procs):
    n, c, p = m
    cmd = [ETCD + '/etcd', '--name', n, '--data-dir', WORK + '/data/' + n,
           '--listen-client-urls', 'http://127.0.0.1:%d' % c, '--advertise-client-urls', 'http://127.0.0.1:%d' % c,
           '--listen-peer-urls', 'http://127.0.0.1:%d' % p, '--initial-advertise-peer-urls', 'http://127.0.0.1:%d' % p,
           '--initial-cluster', cluster, '--initial-cluster-token', 'e13', '--initial-cluster-state', state,
           '--log-level', 'error', '--pre-vote=true'] + extra
    procs[n] = subprocess.Popen(cmd, stdout=open(WORK + '/logs/%s.log' % n, 'a'), stderr=subprocess.STDOUT)


def status(eps):
    r = sh(ETCD + '/etcdctl', '--endpoints', ','.join(eps), 'endpoint', 'status', '-w', 'json', timeout=10)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []


def leader_of(eps):
    for s in status(eps):
        if s['Status']['header']['member_id'] == s['Status']['leader']:
            return s['Endpoint'], s['Status']['leader']
    return None, None


def start_cluster(extra):
    kill_strays()
    shutil.rmtree(WORK + '/data', ignore_errors=True)
    os.makedirs(WORK + '/data'); os.makedirs(WORK + '/logs', exist_ok=True)
    ic = ','.join('%s=http://127.0.0.1:%d' % (n, p) for n, _, p in MEMBERS[:3])
    procs = {}
    for m in MEMBERS[:3]:
        start_member(m, ic, 'new', extra, procs)
    eps = [ep(m) for m in MEMBERS[:3]]
    for _ in range(300):
        st = status(eps)
        if len(st) == 3 and len({s['Status']['leader'] for s in st}) == 1 and st[0]['Status']['leader'] != 0:
            if sh(ETCD + '/etcdctl', '--endpoints', ','.join(eps), 'put', 'foo', 'x').returncode == 0:
                return procs, eps
        time.sleep(0.1)
    stop_cluster(procs)
    raise SystemExit('etcd cluster did not start')


def stop_cluster(procs):
    for p in procs.values():
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
    for p in procs.values():
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    shutil.rmtree(WORK + '/data', ignore_errors=True)


def member_ids(eps):
    r = sh(ETCD + '/etcdctl', '--endpoints', ','.join(eps), 'member', 'list', '-w', 'json')
    return {m['name']: m['ID'] for m in json.loads(r.stdout)['members']}


def start_load(eps, dur):
    p = subprocess.Popen([LOAD, '-endpoints', ','.join(eps), '-rate', '2000', '-workers', '16', '-dur', '%ds' % dur],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stderr.readline()  # ready
    return p


def mark(p, name):
    p.stdin.write('mark %s\n' % name); p.stdin.flush()


def analyse(out, names, window_s=8.0):
    """Per event: the longest gap between consecutive acks in [mark - 0.2 s, mark + window], the time from the mark to
    the first ack of a write whose first try came after the mark, and the longest logical-write latency (first try to ack,
    retries included) among writes first tried in the window. Baseline: the same over a quiet window."""
    W = out['writes']; acks = sorted(w[1] for w in W)
    res = []
    def gap(a, b):
        xs = [x for x in acks if a <= x <= b]
        return max((y - x for x, y in zip(xs, xs[1:])), default=None), len(xs)
    for n in names:
        m = out['marks'][n]
        g, cnt = gap(m - 200_000, m + int(window_s * 1e6))
        after = [w[1] for w in W if w[0] >= m]
        first_new = (min(after) - m) if after else None
        lat = max((w[1] - w[0] for w in W if m - 200_000 <= w[0] <= m + int(window_s * 1e6)), default=None)
        tries = max((w[2] for w in W if m - 200_000 <= w[0] <= m + int(window_s * 1e6)), default=None)
        res.append({'event': n, 'gap_ms': g / 1e3 if g is not None else None, 'first_new_ack_ms': first_new / 1e3 if first_new is not None else None,
                    'max_write_ms': lat / 1e3 if lat is not None else None, 'max_tries': tries, 'acks_in_window': cnt})
    q = out['marks'].get('quiet0'), out['marks'].get('quiet1')
    base = None
    if q[0] and q[1]:
        g, cnt = gap(q[0], q[1])
        lats = sorted(w[1] - w[0] for w in W if q[0] <= w[0] <= q[1])
        base = {'gap_ms': g / 1e3 if g else None, 'acks': cnt, 'p50_ms': lats[len(lats) // 2] / 1e3 if lats else None,
                'p99_ms': lats[int(len(lats) * 0.99)] / 1e3 if lats else None, 'max_ms': lats[-1] / 1e3 if lats else None}
    return res, base


def run_move(runs):
    for r in range(runs):
        la = loadavg(); procs, eps = start_cluster([])
        ids = member_ids(eps)
        load = start_load(eps, 26)
        time.sleep(2); mark(load, 'quiet0'); time.sleep(3); mark(load, 'quiet1')
        names = []
        for k in range(5):
            lead_ep, lead_id = leader_of(eps)
            targets = [hex(v)[2:] for n, v in ids.items() if v != lead_id]
            tgt = targets[k % len(targets)]
            name = 'move%d' % k; mark(load, name); t = time.time()
            rr = sh(ETCD + '/etcdctl', '--endpoints', lead_ep, 'move-leader', tgt, timeout=20)
            names.append(name)
            print(name, 'took', round((time.time() - t) * 1000, 1), 'ms', rr.stdout.strip()[:80], rr.stderr.strip()[:120], flush=True)
            time.sleep(3.5)
        out = json.loads(load.communicate(timeout=60)[0])
        stop_cluster(procs)
        ev, base = analyse(out, names, window_s=3.0)
        rec = {'exp': 'E-13', 'part': 'move', 'run': r, 'loadavg': la, 'events': ev, 'baseline': base, 'writes': len(out['writes']), 'errors': out['errors']}
        open(RES + '/etcd-move.jsonl', 'a').write(json.dumps(rec) + '\n')
        print(json.dumps({k: rec[k] for k in ('run', 'events', 'baseline', 'errors')}), flush=True)


def run_kill(runs, election):
    hb = 100
    for r in range(runs):
        la = loadavg(); procs, eps = start_cluster(['--heartbeat-interval', str(hb), '--election-timeout', str(election)])
        load = start_load(eps, 16)
        time.sleep(2); mark(load, 'quiet0'); time.sleep(3); mark(load, 'quiet1')
        lead_ep, lead_id = leader_of(eps)
        name = [n for n, c, _ in MEMBERS if '127.0.0.1:%d' % c == lead_ep][0]
        mark(load, 'kill'); procs[name].send_signal(signal.SIGKILL)
        out = json.loads(load.communicate(timeout=60)[0])
        stop_cluster(procs)
        ev, base = analyse(out, ['kill'], window_s=8.0)
        rec = {'exp': 'E-13', 'part': 'kill', 'election_ms': election, 'heartbeat_ms': hb, 'run': r, 'loadavg': la, 'events': ev, 'baseline': base,
               'writes': len(out['writes']), 'errors': out['errors']}
        open(RES + '/etcd-kill.jsonl', 'a').write(json.dumps(rec) + '\n')
        print(json.dumps({k: rec[k] for k in ('run', 'election_ms', 'events', 'baseline')}), flush=True)


def du(path):
    tot = 0
    for root, _, files in os.walk(path):
        for f in files:
            try: tot += os.path.getsize(os.path.join(root, f))
            except OSError: pass
    return tot


def run_join(runs, mode, gb):
    extra = ['--quota-backend-bytes', str(8 << 30)]
    if mode == 'snap':
        extra += ['--snapshot-count', '1000']   # the leader compacts its log, so a new member must take a snapshot
    val = 65536; total = int(gb * (1 << 30) / val)
    for r in range(runs):
        la = loadavg(); procs, eps = start_cluster(extra)
        lead_ep, _ = leader_of(eps)
        t = time.time()
        b = sh(BENCH, '--endpoints', lead_ep, '--conns', '4', '--clients', '16', 'put', '--key-size', '8', '--sequential-keys',
               '--key-space-size', str(total), '--total', str(total), '--val-size', str(val))
        load_s = time.time() - t
        st = {s['Endpoint']: s['Status'] for s in status(eps)}
        target = max(s['raftIndex'] for s in st.values()); db = max(s['dbSize'] for s in st.values())
        m4 = MEMBERS[3]
        ic = ','.join('%s=http://127.0.0.1:%d' % (n, p) for n, _, p in MEMBERS)
        t0 = time.time()
        add = sh(ETCD + '/etcdctl', '--endpoints', ','.join(eps), 'member', 'add', 'm4', '--peer-urls', 'http://127.0.0.1:%d' % m4[2])
        start_member(m4, ic, 'existing', extra, procs)
        caught = None; first_status = None; samples = []
        while time.time() - t0 < 300:
            s4 = status([ep(m4)])
            if s4:
                s = s4[0]['Status']
                if first_status is None: first_status = time.time() - t0
                samples.append((round(time.time() - t0, 2), s.get('raftAppliedIndex', 0), s['dbSize']))
                if s.get('raftAppliedIndex', 0) >= target:
                    caught = time.time() - t0; break
            time.sleep(0.05)
        disk4 = du(WORK + '/data/m4')
        stop_cluster(procs)
        rec = {'exp': 'E-13', 'part': 'join', 'mode': mode, 'run': r, 'loadavg': la, 'gb_target': gb, 'values': total, 'val_bytes': val,
               'load_s': round(load_s, 1), 'db_bytes': db, 'target_index': target, 'caught_up_s': caught, 'first_status_s': first_status,
               's_per_gb_db': round(caught / (db / (1 << 30)), 2) if caught else None, 'm4_disk_bytes': disk4, 'add': add.stdout.strip()[:200],
               'samples': samples[::max(1, len(samples) // 40)], 'bench_tail': b.stdout.strip()[-300:]}
        open(RES + '/etcd-join.jsonl', 'a').write(json.dumps(rec) + '\n')
        print(json.dumps({k: rec[k] for k in ('mode', 'run', 'load_s', 'db_bytes', 'target_index', 'caught_up_s', 's_per_gb_db')}), flush=True)


def table():
    def med(xs):
        xs = [x for x in xs if x is not None]
        return (statistics.median(xs), min(xs), max(xs)) if xs else (None, None, None)
    f = lambda t: '-' if t[0] is None else '%.1f (%.1f-%.1f)' % t
    lines = ['| part | setting | events | longest gap between acks, ms | first new write acked after the event, ms | longest logical write (retries in), ms | quiet-window gap, ms | quiet p99, ms |', '|---|---|---|---|---|---|---|---|']
    for part, fn in (('move', 'etcd-move.jsonl'), ('kill', 'etcd-kill.jsonl')):
        p = RES + '/' + fn
        if not os.path.exists(p): continue
        rows = [json.loads(l) for l in open(p)]
        keys = sorted({r.get('election_ms', 0) for r in rows})
        for k in keys:
            rs = [r for r in rows if r.get('election_ms', 0) == k]
            evs = [e for r in rs for e in r['events']]
            setting = 'election %d ms' % k if k else 'election 1000 ms'
            lines.append('| %s | %s | %d events in %d runs | %s | %s | %s | %s | %s |' % (part, setting, len(evs), len(rs), f(med([e['gap_ms'] for e in evs])),
                f(med([e['first_new_ack_ms'] for e in evs])), f(med([e['max_write_ms'] for e in evs])),
                f(med([r['baseline']['gap_ms'] for r in rs if r['baseline']])), f(med([r['baseline']['p99_ms'] for r in rs if r['baseline']]))))
    p = RES + '/etcd-join.jsonl'
    if os.path.exists(p):
        rows = [json.loads(l) for l in open(p)]
        lines += ['', '| join mode | runs | db size, GB | caught up, s | s per GB of db | load time, s |', '|---|---|---|---|---|---|']
        for mode in ('log', 'snap'):
            rs = [r for r in rows if r['mode'] == mode]
            if not rs: continue
            lines.append('| %s | %d | %s | %s | %s | %s |' % (mode, len(rs), '%.2f' % statistics.median([r['db_bytes'] / (1 << 30) for r in rs]),
                f(med([r['caught_up_s'] for r in rs])), f(med([r['s_per_gb_db'] for r in rs])), f(med([r['load_s'] for r in rs]))))
    open(RES + '/tables.md', 'w').write('\n'.join(lines) + '\n'); print('\n'.join(lines))


if __name__ == '__main__':
    a = sys.argv[1:]
    def opt(k, d):
        return a[a.index(k) + 1] if k in a else d
    os.makedirs(RES, exist_ok=True)
    if a[0] == 'move': run_move(int(opt('--runs', 3)))
    elif a[0] == 'kill': run_kill(int(opt('--runs', 3)), int(opt('--election', 1000)))
    elif a[0] == 'join': run_join(int(opt('--runs', 3)), opt('--mode', 'log'), float(opt('--gb', 1)))
    elif a[0] == 'table': table()
