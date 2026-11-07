#!/usr/bin/env python3
"""Why kbench.py warms the cluster first: streamed latency at 2,000/s on a cold cluster, then after ~15 s at full
speed. Run under $SP/bin/heavy, not timing (a diagnostic). Usage: python3 -I warmdiag.py kafka default"""
import importlib.util, subprocess, sys, time, json, re
spec = importlib.util.spec_from_file_location('kbench', __import__('os').path.dirname(__import__('os').path.abspath(__file__)) + '/../kbench.py')
kb = importlib.util.module_from_spec(spec); spec.loader.exec_module(kb)
system, setup = sys.argv[1], sys.argv[2]
procs = kb.start(system, setup)
try:
    for label, rate, secs, props in [('cold-2000', 2000, 8, kb.OMB_LATENCY), ('warm-max', -1, 0, kb.OMB_THROUGHPUT),
                                     ('warm-2000', 2000, 8, kb.OMB_LATENCY), ('warm-2000-linger0', 2000, 8, ['acks=all', 'linger.ms=0']),
                                     ('warm-20000', 20000, 8, kb.OMB_LATENCY)]:
        kb.create_topic(system, setup, 'td')
        n = 2000000 if rate < 0 else rate * secs
        cmd = [kb.K + '/bin/kafka-producer-perf-test.sh', '--bootstrap-server', kb.boot(system), '--record-size', '1024',
               '--topic', 'td', '--num-records', str(n), '--warmup-records', str(n // 4), '--throughput', str(rate), '--command-property'] + props
        out, _, meta = kb.measure(procs, cmd)
        r = kb.parse_producer(out)
        print(label, json.dumps(r.get('steady')), meta['server_cores'], meta['client_cores'], flush=True)
        kb.delete_topic(system, 'td')
finally:
    kb.stop(procs, system)
