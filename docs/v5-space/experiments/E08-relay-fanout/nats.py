#!/usr/bin/env python3
"""E-08's yardstick: core NATS fan-out at E-08's record size (100 B), with NATS's own tool, on this box.
E-09b measured 1 -> 16 at 16 B and 1 KiB; this runs the same shape at 100 B, so the relay's deliveries per core
compare with NATS at the same size. One nats-server 2.10.22 (no JetStream) on a private port; `nats bench sub`
with 16 subscriber connections starts first, then `nats bench pub` sends N messages of 100 B on one subject.
The server's CPU is read from /proc over the whole publish. Run it under the timing lock.
  python3 nats.py [runs=3] [out=results/nats.jsonl]
"""
import json, os, re, subprocess, sys, time

SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
NATS = SP + '/dl/natscli/unz/nats-0.5.1-linux-amd64/nats'
NSRV = SP + '/dl/nats/nats-server-v2.10.22-linux-amd64/nats-server'
HERE = os.path.dirname(os.path.abspath(__file__))
runs = int(sys.argv[1]) if len(sys.argv) > 1 else 3
out = sys.argv[2] if len(sys.argv) > 2 else HERE + '/results/nats.jsonl'
TCK = os.sysconf('SC_CLK_TCK')
PORT = 24222
MSGS = int(os.environ.get('NATS_MSGS', 2_000_000))
ticks = lambda pid: (lambda x: int(x[11]) + int(x[12]))(open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()[1:])
for run in range(1, runs + 1):
    la = open('/proc/loadavg').read().strip()
    srv = subprocess.Popen([NSRV, '-a', '127.0.0.1', '-p', str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
    S = ['-s', 'nats://127.0.0.1:%d' % PORT]
    sub = subprocess.Popen([NATS] + S + ['bench', 'sub', 'e08.fan', '--clients', '16', '--msgs', str(MSGS), '--size', '100', '--no-progress'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1.0)
    c0, t0 = ticks(srv.pid), time.time()
    pub = subprocess.run([NATS] + S + ['bench', 'pub', 'e08.fan', '--clients', '1', '--msgs', str(MSGS), '--size', '100', '--no-progress'], capture_output=True, text=True, timeout=240)
    so = sub.communicate(timeout=240)[0]
    c1, t1 = ticks(srv.pid), time.time()
    srv.terminate(); srv.wait()
    def rate(txt, who):
        # the aggregate line, e.g. "NATS Core NATS subscriber aggregated stats: 4,126,000 msgs/sec ..." or a single client's stats
        m = [l for l in txt.splitlines() if 'msgs/sec' in l and ('aggregate' in l.lower() or 'stats' in l.lower())]
        return int(re.search(r'([\d,]+) msgs/sec', m[-1]).group(1).replace(',', '')) if m else None
    deliv = rate(so, 'sub')
    cores = (c1 - c0) / TCK / (t1 - t0)
    r = {'exp': 'E-08', 'part': 'nats', 'run': run, 'loadavg': la, 'size': 100, 'subs': 16, 'msgs': MSGS,
         'pub_msgs_per_s': rate(pub.stdout, 'pub'), 'deliveries_per_s': deliv, 'server_cores': round(cores, 3),
         'deliveries_per_server_core_s': round(deliv / cores) if deliv and cores else None, 'sub_tail': so.strip().splitlines()[-3:]}
    open(out, 'a').write(json.dumps(r) + '\n')
    print(json.dumps(r))
