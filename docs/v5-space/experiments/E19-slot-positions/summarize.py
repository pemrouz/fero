#!/usr/bin/env python3
"""E-19: results/header.jsonl and results/cursor.jsonl -> markdown tables (median and range of the runs)."""
import json, os, statistics
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
H = [json.loads(l) for l in open(R + '/header.jsonl')]
C = [json.loads(l) for l in open(R + '/cursor.jsonl')]
f = lambda xs: '%.1f (%.1f-%.1f)' % (statistics.median(xs), min(xs), max(xs))
print('## Record header: bytes and ns per record (batches of 256 records of 100 B)\n')
print('Per-slot sequence = how many writes each slot has seen; 1,024 slots, so 1e3 per slot is a resource with about 1e6 writes.\n')
print('| impl | per-slot sequence | form | header bytes per record | extra bytes vs `off` | encode ns/record | decode ns/record | extra encode ns | extra decode ns | runs | load averages |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for impl in ('node', 'rust'):
    rs = [r for r in H if r['impl'] == impl]
    for sb in (1000, 1000000, 1000000000):
        base = [[x for x in r['rows'] if x['form'] == 'off' and x['seq_base'] == sb][0] for r in rs]
        for form in ('off', 'slot', 'slotfix', 'slotimp'):
            xs = [[x for x in r['rows'] if x['form'] == form and x['seq_base'] == sb][0] for r in rs]
            print('| %s | %.0e | %s | %.2f | %+.2f | %s | %s | %s | %s | %d | %s |' % (impl, sb, form, xs[0]['header_bytes_per_record'], xs[0]['header_bytes_per_record'] - base[0]['header_bytes_per_record'],
                  f([x['enc_ns'] for x in xs]), f([x['dec_ns'] for x in xs]), f([x['enc_ns'] - b['enc_ns'] for x, b in zip(xs, base)]), f([x['dec_ns'] - b['dec_ns'] for x, b in zip(xs, base)]),
                  len(xs), '; '.join(r['loadavg'].split()[0] for r in rs)))
c = C[0]
print('\n## Whole-resource cursor, bytes (1,024 slots; exact, the same in every run)\n')
forms = ['raw', 'varint', 'dense', 'delta', 'rle', 'deflate']
print('| writes to the resource | moves | unclean recoveries | ' + ' | '.join(forms) + ' |')
print('|---|---|---|' + '---|' * len(forms))
for x in c['rows']:
    print('| %s | %d | %d | %s |' % (x['load'], x['moves'], x['unclean_recoveries'], ' | '.join(str(x[k]) for k in forms)))
print('\n## Filtered cursor (a client that follows k partitions), varint form, bytes\n')
print('| writes | 1 | 10 | 64 | 1,024 partitions |\n|---|---|---|---|---|')
for x in c['filtered']:
    print('| %s | %d | %d | %d | %d |' % (x['load'], x['k1'], x['k10'], x['k64'], x['k1024parts']))
print('\n## Offset forms (CELL, LANE, SPLIT), bytes\n')
print('| form | writes | after | bytes |\n|---|---|---|---|')
for x in c['offset_forms']:
    print('| %s | %.0e | %s | %d |' % (x['form'], x['N'], x.get('after_splits', '-') if 'after_splits' in x else 'moves (a re-key breaks cursors)', x['bytes']))
print('\n## Reconnect storm: 10,000 clients at once, cursor bytes in all\n')
print('| form | all clients send a whole-resource cursor (typical), MB | (worst), MB |\n|---|---|---|')
for x in c['storm']:
    if 'MB' in x: print('| %s | %.3f | |' % (x['form'], x['MB']))
    else: print('| %s | %.2f | %.2f |' % (x['form'], x['all_whole_resource_typical_MB'], x['all_whole_resource_worst_MB']))
print('\n## Light timing: one whole-resource cursor (delta form, Zipf 0.99, 1e9 writes, %d B) in Node\n' % c['timing'][0]['bytes'])
print('| encode µs | decode µs | runs |\n|---|---|---|')
print('| %s | %s | %d |' % (f([r['timing'][0]['encode_us'] for r in C]), f([r['timing'][0]['decode_us'] for r in C]), len(C)))
