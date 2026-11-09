#!/usr/bin/env python3
"""E-38(c): three real etcd 3.5.17 members on real TCP, with links cut by iptables.

Each member runs in its own network namespace (e38m1..e38m3, addresses 10.38.0.1-3 on a bridge, e38br, whose
root-namespace address 10.38.0.254 the load client uses). A fault is a set of iptables DROP rules in the
INPUT chain of the receiving member's namespace: "drop what m2 sends to m1" is `-s 10.38.0.2 -j DROP` in e38m1.
So one-way faults are real one-way packet loss under TCP (a TCP stream then also loses its ACKs one way).

Every run: a fresh cluster (heartbeat 100 ms, election E = 1,000 ms, PreVote on; etcd always runs CheckQuorum),
leadership moved to m1, a steady load (E-13's Go client: 1,000 logical puts/s of 256 B over 16 writers, every
write retried until acknowledged, each writer pinned to one member, so a member cut from the leader stalls only
its own writers and the group's writability is the gap between acks over all writers), the fault at 6 s, healed at 26 s
(20 E later), the run ends at 30 s. Elections are read from the members' own logs ("became leader at term").

Run as root, under $SP/bin/timing:  python3 -I gray.py run [--runs 3] [--only name,name]   then   gray.py table
"""
import json, os, re, shutil, signal, statistics, subprocess, sys, time
from datetime import datetime

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
ETCD = SP + '/dl/etcd/etcd-v3.5.17-linux-amd64'
LOAD = SP + '/e13/e13load'           # built from ../E13-handover/load (run.sh builds it)
WORK = SP + '/e38c'
HERE = os.path.dirname(os.path.abspath(__file__))
RES = HERE + '/results'
IP = {1: '10.38.0.1', 2: '10.38.0.2', 3: '10.38.0.3'}
E_MS = 1000
FAULT_S, HEAL_S, END_S = 6.0, 26.0, 30.0
CG = '/sys/fs/cgroup/cpu/e38slow'

# name -> (list of (receiver, sender) pairs whose packets are dropped, what it is)
# m1 is the leader when the fault starts; m2 and m3 are followers.
SCEN = {
    'none':            ([], 'no fault (baseline)'),
    'cloudflare':      ([(1, 2), (2, 1)], 'leader-follower link down both ways; both still reach m3 (Cloudflare 2020 shape)'),
    'follower-link':   ([(2, 3), (3, 2)], 'link between the two followers down both ways'),
    'leader-isolated': ([(1, 2), (2, 1), (1, 3), (3, 1)], 'leader cut from both followers, both ways'),
    'leader-cannot-send': ([(2, 1), (3, 1)], 'followers drop what the leader sends (one-way)'),
    'leader-cannot-hear': ([(1, 2), (1, 3)], 'leader drops what the followers send (one-way loss into the leader)'),
    'oneway-to-follower': ([(2, 1)], 'm2 drops what the leader sends (one one-way link)'),
    'slow-cpu':        ('cpu', 'leader CPU capped at 10% of one core (cgroup v1 cpu quota), not a link fault'),
}


def sh(*a, **k):
    return subprocess.run(list(a), capture_output=True, text=True, **k)


def ns(i, *cmd, **k):
    return sh('ip', 'netns', 'exec', 'e38m%d' % i, *cmd, **k)


def net_up():
    if sh('ip', 'link', 'show', 'e38br').returncode == 0:
        return
    sh('ip', 'link', 'add', 'e38br', 'type', 'bridge')
    sh('ip', 'addr', 'add', '10.38.0.254/24', 'dev', 'e38br')
    sh('ip', 'link', 'set', 'e38br', 'up')
    for i in (1, 2, 3):
        sh('ip', 'netns', 'add', 'e38m%d' % i)
        sh('ip', 'link', 'add', 'e38h%d' % i, 'type', 'veth', 'peer', 'name', 'e38n%d' % i)
        sh('ip', 'link', 'set', 'e38n%d' % i, 'netns', 'e38m%d' % i)
        sh('ip', 'link', 'set', 'e38h%d' % i, 'master', 'e38br')
        sh('ip', 'link', 'set', 'e38h%d' % i, 'up')
        ns(i, 'ip', 'addr', 'add', IP[i] + '/24', 'dev', 'e38n%d' % i)
        ns(i, 'ip', 'link', 'set', 'e38n%d' % i, 'up')
        ns(i, 'ip', 'link', 'set', 'lo', 'up')


def net_down():
    for i in (1, 2, 3):
        sh('ip', 'netns', 'del', 'e38m%d' % i)
        sh('ip', 'link', 'del', 'e38h%d' % i)
    sh('ip', 'link', 'del', 'e38br')


def heal():
    for i in (1, 2, 3):
        ns(i, 'iptables', '-F', 'INPUT')


def cep(i):
    return '%s:2379' % IP[i]


EPS = [cep(i) for i in (1, 2, 3)]


def ctl(*a, timeout=10):
    return sh(ETCD + '/etcdctl', '--endpoints', ','.join(EPS), '--dial-timeout', '2s', '--command-timeout', '3s', *a, timeout=timeout)


def status():
    r = ctl('endpoint', 'status', '-w', 'json')
    try:
        return json.loads(r.stdout) if r.stdout.strip() else []
    except json.JSONDecodeError:
        return []


def start_cluster(procs):
    sh('pkill', '-9', '-f', WORK + '/data/')
    shutil.rmtree(WORK + '/data', ignore_errors=True)
    os.makedirs(WORK + '/data'); os.makedirs(WORK + '/logs', exist_ok=True)
    ic = ','.join('m%d=http://%s:2380' % (i, IP[i]) for i in (1, 2, 3))
    for i in (1, 2, 3):
        log = WORK + '/logs/m%d.log' % i
        open(log, 'w').close()
        cmd = ['ip', 'netns', 'exec', 'e38m%d' % i, ETCD + '/etcd', '--name', 'm%d' % i, '--data-dir', WORK + '/data/m%d' % i,
               '--listen-client-urls', 'http://%s:2379' % IP[i], '--advertise-client-urls', 'http://%s:2379' % IP[i],
               '--listen-peer-urls', 'http://%s:2380' % IP[i], '--initial-advertise-peer-urls', 'http://%s:2380' % IP[i],
               '--initial-cluster', ic, '--initial-cluster-token', 'e38c', '--initial-cluster-state', 'new',
               '--heartbeat-interval', '100', '--election-timeout', str(E_MS), '--pre-vote=true', '--log-level', 'info']
        procs[i] = subprocess.Popen(cmd, stdout=open(log, 'a'), stderr=subprocess.STDOUT)
    for _ in range(300):
        st = status()
        if len(st) == 3 and len({s['Status']['leader'] for s in st}) == 1 and st[0]['Status']['leader'] != 0:
            if ctl('put', 'foo', 'x').returncode == 0:
                return st
        time.sleep(0.1)
    raise SystemExit('cluster did not start')


def make_m1_leader():
    for _ in range(5):
        st = status()
        ids = {s['Endpoint']: s['Status']['header']['member_id'] for s in st}
        lead = st[0]['Status']['leader'] if st else 0
        if ids.get(cep(1)) == lead:
            return True
        lead_ep = [e for e, m in ids.items() if m == lead]
        if lead_ep:
            sh(ETCD + '/etcdctl', '--endpoints', lead_ep[0], 'move-leader', hex(ids[cep(1)])[2:], timeout=10)
        time.sleep(1)
    return False


def stop_cluster(procs):
    for p in procs.values():
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
    for p in procs.values():
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()


def etcd_pid(i):
    r = sh('pgrep', '-f', 'data-dir %s/data/m%d' % (WORK, i))
    return [int(x) for x in r.stdout.split()]


def elections(t_from, t_to):
    """'became leader at term N' lines from every member's log, with wall times, between t_from and t_to."""
    ev = []
    for i in (1, 2, 3):
        for line in open(WORK + '/logs/m%d.log' % i, errors='replace'):
            if 'became leader at term' not in line:
                continue
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = datetime.fromisoformat(j['ts'].replace('Z', '+00:00')).timestamp()
            if t_from <= ts <= t_to:
                ev.append((round(ts - t_from, 3), 'm%d' % i, j['msg'].split('at term ')[-1]))
    return sorted(ev)


def analyse(out, t_fault_wall):
    W = out['writes']; m = out['marks']
    per_member = []
    for e in range(3):
        # the longest stretch with no ack from this member's writers, from the fault to the heal (the heal ends the last stretch)
        ys = [m['fault']] + sorted(w[1] for w in W if w[3] == e and m['fault'] <= w[1] <= m['heal']) + [m['heal']]
        per_member.append(round(max(y - x for x, y in zip(ys, ys[1:])) / 1e3, 1))
    acks = sorted(w[1] for w in W)
    f, h = m['fault'], m['heal']
    xs = [x for x in acks if f - 200_000 <= x <= h]
    gap = max((y - x for x, y in zip(xs, xs[1:])), default=None)
    first_new = min((w[1] for w in W if w[0] >= f), default=None)
    q = sorted(w[1] - w[0] for w in W if m['quiet0'] <= w[0] <= m['quiet1'])
    late = sorted(w[1] - w[0] for w in W if f + 2 * E_MS * 1000 <= w[0] <= h)
    pc = lambda xs, p: xs[min(len(xs) - 1, int(len(xs) * p))] / 1e3 if xs else None
    # acks per second over the fault window, and the last ack before heal
    last_ack_before_heal = max((x for x in acks if x <= h), default=None)
    tries = sum(w[2] for w in W if f <= w[0] <= h); writes = sum(1 for w in W if f <= w[0] <= h)
    return {'gap_ms': gap / 1e3 if gap else None, 'gap_E': round(gap / 1e3 / E_MS, 3) if gap else None,
            'first_new_ack_ms': (first_new - f) / 1e3 if first_new else None,
            'writing_at_heal': bool(last_ack_before_heal and h - last_ack_before_heal < 500_000),
            'quiet_p50_ms': pc(q, 0.5), 'quiet_p99_ms': pc(q, 0.99), 'after2E_p50_ms': pc(late, 0.5), 'after2E_p99_ms': pc(late, 0.99),
            'after2E_max_ms': late[-1] / 1e3 if late else None, 'writes_in_fault': writes, 'attempts_per_write_in_fault': round(tries / writes, 3) if writes else None,
            'acks_in_fault_window': len(xs), 'gap_per_member_ms': per_member}


def run(name, r):
    rules, what = SCEN[name]
    net_up(); heal()
    la = open('/proc/loadavg').read().strip()
    procs = {}
    try:
        start_cluster(procs)
        ok = make_m1_leader()
        load = subprocess.Popen([LOAD, '-endpoints', ','.join(EPS), '-rate', '1000', '-workers', '16', '-dur', '%ds' % int(END_S), '-timeout', '1s', '-pin'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        load.stderr.readline()
        t0 = time.time()
        def at(s):
            d = t0 + s - time.time()
            if d > 0: time.sleep(d)
        def mark(n):
            load.stdin.write('mark %s\n' % n); load.stdin.flush()
        at(2.0); mark('quiet0'); at(5.0); mark('quiet1')
        at(FAULT_S); mark('fault'); t_fault = time.time()
        if rules == 'cpu':
            os.makedirs(CG, exist_ok=True)
            open(CG + '/cpu.cfs_period_us', 'w').write('100000'); open(CG + '/cpu.cfs_quota_us', 'w').write('10000')
            for pid in etcd_pid(1):
                for tid in os.listdir('/proc/%d/task' % pid):
                    try: open(CG + '/tasks', 'w').write(tid)
                    except OSError: pass
        else:
            for recv, send in rules:
                ns(recv, 'iptables', '-A', 'INPUT', '-s', IP[send], '-j', 'DROP')
        at(HEAL_S); mark('heal'); t_heal = time.time()
        heal()
        if rules == 'cpu':
            for pid in etcd_pid(1):
                for tid in os.listdir('/proc/%d/task' % pid):
                    try: open('/sys/fs/cgroup/cpu/tasks', 'w').write(tid)
                    except OSError: pass
        out = json.loads(load.communicate(timeout=60)[0])
        time.sleep(0.3)
        ev = elections(t_fault, t_heal)
        evs_after = elections(t_heal, time.time())
    finally:
        stop_cluster(procs); heal()
    a = analyse(out, t_fault)
    # flapping: more than one election in some window of 10 E, counted from 2 E after the fault
    times = [e[0] for e in ev if e[0] >= 2 * E_MS / 1000]
    flaps = any(sum(1 for t in times if s <= t < s + 10 * E_MS / 1000) > 1 for s in times)
    rec = {'exp': 'E-38c', 'scenario': name, 'what': what, 'run': r, 'loadavg': la, 'm1_led_at_fault': ok, 'E_ms': E_MS,
           'elections_in_fault': ev, 'n_elections': len(ev), 'elections_after_heal': evs_after, 'flapping': flaps, **a, 'errors': out['errors']}
    open(RES + '/runs.jsonl', 'a').write(json.dumps(rec) + '\n')
    print(json.dumps({k: rec[k] for k in ('scenario', 'run', 'n_elections', 'gap_E', 'first_new_ack_ms', 'writing_at_heal', 'quiet_p99_ms', 'after2E_p99_ms', 'flapping', 'loadavg')}), flush=True)


def table():
    rows = [json.loads(l) for l in open(RES + '/runs.jsonl')]
    med = lambda xs: statistics.median(xs) if xs else None
    f = lambda xs, fmt='%.2f': '-' if not [x for x in xs if x is not None] else (fmt % med([x for x in xs if x is not None])) + ' (' + (fmt % min(x for x in xs if x is not None)) + '-' + (fmt % max(x for x in xs if x is not None)) + ')'
    L = ['| scenario | runs | elections during the fault (per run) | longest gap between acks, all writers, E | writable within 2E | flapping | p99 before, ms | p99 from 2E after the fault, ms (all writers) | longest gap per pinned member, s (m1, m2, m3; median) |',
         '|---|---|---|---|---|---|---|---|---|']
    for name in SCEN:
        rs = [x for x in rows if x['scenario'] == name]
        if not rs: continue
        L.append('| %s | %d | %s | %s | %d of %d | %d of %d | %s | %s | %s |' % (name, len(rs), ', '.join(str(x['n_elections']) for x in rs),
                 f([x['gap_E'] for x in rs], '%.3f'), sum(1 for x in rs if x['gap_E'] is not None and x['gap_E'] <= 2 and x['writing_at_heal']), len(rs),
                 sum(1 for x in rs if x['flapping']), len(rs), f([x['quiet_p99_ms'] for x in rs]), f([x['after2E_p99_ms'] for x in rs]),
                 ', '.join('-' if not [x['gap_per_member_ms'][e] for x in rs if x['gap_per_member_ms'][e] is not None] else '%.1f' % (med([x['gap_per_member_ms'][e] for x in rs if x['gap_per_member_ms'][e] is not None]) / 1e3) for e in range(3))))
    open(RES + '/tables.md', 'w').write('\n'.join(L) + '\n'); print('\n'.join(L))


if __name__ == '__main__':
    a = sys.argv[1:]
    os.makedirs(RES, exist_ok=True)
    if a[0] == 'run':
        runs = int(a[a.index('--runs') + 1]) if '--runs' in a else 3
        only = a[a.index('--only') + 1].split(',') if '--only' in a else list(SCEN)
        done = [json.loads(l) for l in open(RES + '/runs.jsonl')] if os.path.exists(RES + '/runs.jsonl') else []
        for r in range(runs):
            for name in only:
                if sum(1 for x in done if x['scenario'] == name) > r: continue
                run(name, r)
    elif a[0] == 'table': table()
    elif a[0] == 'down': net_down()
