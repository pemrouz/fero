#!/usr/bin/env python3
"""Check that a setup's fsync rule is really in force: start the cluster, run a producer at a fixed rate,
and count fsync/fdatasync calls of the first server for 8 s with strace. Not a timing run (strace slows
the server); it only shows whether flushes happen per append or not.
Usage: python3 -I fsynccheck.py SYSTEM SETUP [RATE]"""
import importlib.util, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('kbench', HERE + '/../kbench.py')
kb = importlib.util.module_from_spec(spec); spec.loader.exec_module(kb)
system, setup = sys.argv[1], sys.argv[2]


def metrics(system):
    if system != 'redpanda':
        return {}
    r = subprocess.run(['curl', '-s', '--noproxy', '*', 'http://127.0.0.1:%d/metrics' % kb.ADMIN[0]],
                       capture_output=True, text=True)
    d = {}
    for line in r.stdout.splitlines():
        if line and not line.startswith('#'):
            k, _, v = line.rpartition(' ')
            try:
                d[k] = float(v)
            except ValueError:
                pass
    return d


rate = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
procs = kb.start(system, setup)
try:
    kb.create_topic(system, setup, 'tsync')
    prod = subprocess.Popen([kb.K + '/bin/kafka-producer-perf-test.sh', '--bootstrap-server', kb.boot(system),
                             '--record-size', '1024', '--topic', 'tsync', '--num-records', str(rate * 20),
                             '--throughput', str(rate), '--command-property'] + kb.OMB_LATENCY,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=kb.TOOL_ENV)
    time.sleep(6)
    m0 = metrics(system)
    st = subprocess.run(['timeout', '-s', 'INT', '8', 'strace', '-f', '-c', '-e',
                         'trace=fsync,fdatasync,sync_file_range,io_submit,io_uring_enter',
                         '-p', str(procs[0].pid)], capture_output=True, text=True)
    m1 = metrics(system)
    out = prod.communicate(timeout=120)[0]
    print('%s %s: producer at %d records/s on 16 partitions; strace of server 1 for 8 s:' % (system, setup, rate))
    print('\n'.join(l for l in st.stderr.splitlines() if not l.endswith(' detached')))
    print([l for l in out.splitlines() if 'records sent' in l][-1:])
    if system == 'redpanda':
        print('Redpanda admin /metrics, counters with flush in the name, change over those 8 s on server 1:')
        for k in sorted(m1):
            if 'flush' in k and m1[k] != m0.get(k, 0):
                print('  %s +%g' % (k, m1[k] - m0.get(k, 0)))
finally:
    kb.stop(procs, system)
