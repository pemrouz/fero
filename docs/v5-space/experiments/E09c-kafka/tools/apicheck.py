#!/usr/bin/env python3
"""Which Kafka APIs a cluster answers (share groups need ShareGroupHeartbeat, ShareFetch, ShareAcknowledge),
and what topic configs it holds for a topic made the way kbench.py makes them. Not a timing run.
Usage: python3 -I apicheck.py SYSTEM SETUP"""
import importlib.util, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('kbench', HERE + '/../kbench.py')
kb = importlib.util.module_from_spec(spec); spec.loader.exec_module(kb)
system, setup = sys.argv[1], sys.argv[2]
procs = kb.start(system, setup)
try:
    r = kb.kafka_tool('kafka-broker-api-versions.sh', ['--bootstrap-server', kb.boot(system).split(',')[0]])
    lines = [l.strip() for l in r.stdout.splitlines() if 'JAVA_TOOL' not in l]
    print('%s %s: broker API versions (first broker), share-group APIs and a count:' % (system, setup))
    share = [l for l in lines if 'Share' in l]
    print('\n'.join(dict.fromkeys(share)) or '(no line mentions Share)')
    print('(the tool lists the 3 brokers; each line above appeared %d times) ' % (len(share) // max(1, len(set(share)))) +
          'APIs listed with a usable version: %d; marked UNSUPPORTED: %d' % (
        sum(1 for l in lines if re.search(r'usable: \d', l)), sum(1 for l in lines if 'UNSUPPORTED' in l)))
    kb.create_topic(system, setup, 'tcfg')
    r = kb.kafka_tool('kafka-configs.sh', ['--bootstrap-server', kb.boot(system), '--describe', '--entity-type', 'topics',
                                           '--entity-name', 'tcfg'])
    print('topic tcfg configs set at create:', ' '.join(l.strip() for l in r.stdout.splitlines() if 'JAVA_TOOL' not in l))
    if system == 'redpanda':
        r = subprocess.run([kb.RPK, 'cluster', 'config', 'get', 'write_caching_default', '-X',
                            'admin.hosts=127.0.0.1:%d' % kb.ADMIN[0]], capture_output=True, text=True)
        print('rpk cluster config get write_caching_default:', (r.stdout + r.stderr).strip())
        r = subprocess.run([kb.RPK, 'topic', 'describe', 'tcfg', '-c', '-X', 'brokers=' + kb.boot(system)],
                           capture_output=True, text=True)
        print('rpk topic describe tcfg -c (caching and flush lines):',
              ' | '.join(' '.join(l.split()) for l in r.stdout.splitlines() if 'caching' in l or 'flush' in l))
    if system == 'kafka':
        r = kb.kafka_tool('kafka-features.sh', ['--bootstrap-server', kb.boot(system), 'describe'])
        print('features:', ' | '.join(l.strip() for l in r.stdout.splitlines() if 'share' in l.lower() or 'metadata' in l.lower()))
finally:
    kb.stop(procs, system)
