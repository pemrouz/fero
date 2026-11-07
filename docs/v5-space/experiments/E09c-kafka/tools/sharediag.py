#!/usr/bin/env python3
"""Diagnostic for the share-group rows: is the share-4c rate a steady rate, or a fixed start-up cost spread
over few records? One Kafka cluster (SETUP), 900,000 x 1 KiB records written with OMB's throughput settings,
then kafka-share-consumer-perf-test (4 consumers, one new share group each time) RUNS times with per-second
stats (--show-detailed-stats --reporting-interval 1000), and the classic consumer once for comparison.
Run under $SP/bin/timing (it is a speed). Prints the tools' own lines; the README reads the steady part.
HB_MS (optional): set the brokers' share-group heartbeat interval (group.share.heartbeat.interval.ms and
group.share.min.heartbeat.interval.ms, both 5000 by default) to test whether the start-up wait is one heartbeat.
Usage: python3 -I sharediag.py [SETUP] [RUNS] [HB_MS]"""
import importlib.util, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('kbench', HERE + '/../kbench.py')
kb = importlib.util.module_from_spec(spec); spec.loader.exec_module(kb)
setup = sys.argv[1] if len(sys.argv) > 1 else 'default'
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
if len(sys.argv) > 3:
    os.environ['KBENCH_BROKER_EXTRA'] = 'group.share.heartbeat.interval.ms=%s;group.share.min.heartbeat.interval.ms=%s' % (sys.argv[3], sys.argv[3])
print('# broker extras:', os.environ.get('KBENCH_BROKER_EXTRA', '(none: Kafka defaults, share heartbeat 5000 ms)'), flush=True)
N = 900000
B = kb.boot('kafka')
procs = kb.start('kafka', setup)
try:
    kb.warm('kafka', setup, procs, kb.COUNTS['kafka'][setup]['warm'])
    kb.create_topic('kafka', setup, 'tshare')
    r = subprocess.run([kb.K + '/bin/kafka-producer-perf-test.sh', '--bootstrap-server', B, '--record-size', '1024',
                        '--topic', 'tshare', '--num-records', str(N), '--throughput', '-1', '--command-property']
                       + kb.OMB_THROUGHPUT, capture_output=True, text=True, env=kb.TOOL_ENV, timeout=300)
    print('# wrote', [l for l in r.stdout.splitlines() if 'records sent' in l][-1:], flush=True)
    for i in range(1, runs + 1):
        g = 'sgdiag-%d-%d' % (i, int(time.time()))
        kb.kafka_tool('kafka-configs.sh', ['--bootstrap-server', B, '--alter', '--entity-type', 'groups',
                                           '--entity-name', g, '--add-config', 'share.auto.offset.reset=earliest'])
        out, _, meta = kb.measure(procs, [kb.K + '/bin/kafka-share-consumer-perf-test.sh', '--bootstrap-server', B,
                                          '--topic', 'tshare', '--num-records', str(N), '--threads', '4', '--group', g,
                                          '--timeout', '30000', '--show-detailed-stats', '--reporting-interval', '1000'])
        print('# share run %d (%s): %s' % (i, setup, {k: meta[k] for k in ('loadavg_before', 'wall_s', 'server_cores', 'client_cores', 'other_cores')}))
        print('\n'.join(l for l in out.splitlines() if 'JAVA_TOOL' not in l), flush=True)
    out, _, meta = kb.measure(procs, [kb.K + '/bin/kafka-consumer-perf-test.sh', '--bootstrap-server', B, '--topic', 'tshare',
                                      '--num-records', str(N), '--timeout', '30000', '--group', 'cgdiag-%d' % int(time.time()),
                                      '--show-detailed-stats', '--reporting-interval', '1000'])
    print('# classic consumer (%s): %s' % (setup, {k: meta[k] for k in ('loadavg_before', 'wall_s', 'server_cores', 'client_cores', 'other_cores')}))
    print('\n'.join(l for l in out.splitlines() if 'JAVA_TOOL' not in l), flush=True)
finally:
    kb.stop(procs, 'kafka')
