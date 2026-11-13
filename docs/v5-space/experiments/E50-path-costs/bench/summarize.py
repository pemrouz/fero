#!/usr/bin/env python3
# E-50: print the tables of README.md from results/*.jsonl, as markdown. Each cell is the median of the runs, then
# (lowest-highest run). Every results file holds, per process, one /proc/loadavg line and then its JSON line(s).
#   python3 bench/summarize.py > results/tables.md                                    (the rerun)
#   python3 bench/summarize.py results/first-pass > results/first-pass/tables.md      (the walkers' first runs, kept as they wrote them)
import json, os, statistics, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, '..', 'results')
LOADS = []

def lines(name):
    out, load = [], None
    p = os.path.join(R, name + '.jsonl')
    if not os.path.exists(p):
        return out
    for l in open(p):
        l = l.strip()
        if not l:
            continue
        if l.startswith('{"load":') and '} {' in l:  # the reads walker's first-pass form: {"load":x} {json}
            i = l.find('} {'); load = json.loads(l[:i + 1])['load']; LOADS.append(load)
            d = json.loads(l[i + 2:]); d['_load'] = load; out.append(d)
        elif l.startswith('{'):
            d = json.loads(l); d['_load'] = load; out.append(d)
        else:
            load = float(l.split()[0]); LOADS.append(load)
    return out

def med(xs, unit=''):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    m = statistics.median(xs)
    lo, hi = min(xs), max(xs)
    f = (lambda v: f'{v:,.0f}') if m >= 100 else (lambda v: f'{v:.2f}') if m < 10 else (lambda v: f'{v:.1f}')
    return f'{f(m)}{unit} ({f(lo)}-{f(hi)})' if len(xs) > 1 else f'{f(m)}{unit}'

def group(rows, key):
    g = defaultdict(list)
    for r in rows:
        g[r[key]].append(r)
    return g

def table(head, rows):
    print('| ' + ' | '.join(head) + ' |')
    print('|' + '---|' * len(head))
    for r in rows:
        print('| ' + ' | '.join(str(c) for c in r) + ' |')
    print()

# ---------------------------------------------------------------- write
print('## bench/write\n')
crc = lines('crc')
if crc:
    print(f'### One checksum pass: ns per pass ({len(crc)} runs)\n')
    sizes = [r['size'] for r in crc[0]['rows']]
    def cell(size, k):
        return med([next(x[k] for x in r['rows'] if x['size'] == size) for r in crc])
    table(['bytes', "v4's crc32c (JS, table)", 'crc32c slice-by-8 (JS)', 'zlib.crc32 (native, IEEE)', 'v4 MB/s', 'native MB/s'],
          [[f'{s:,}', cell(s, 'v4_ns'), cell(s, 'sb8_ns'), cell(s, 'zlib_ns'), cell(s, 'v4_MBps'), cell(s, 'zlib_MBps')] for s in sizes])
codec = lines('codec')
if codec:
    print(f"### v4's codec per record: ns per record ({len(codec)} runs)\n")
    keys = [(x['N'], x['kind']) for x in codec[0]['rows']]
    def c(N, kind, k):
        return med([next(x[k] for x in r['rows'] if x['N'] == N and x['kind'] == kind) for r in codec])
    table(['frame', 'record', 'wire bytes per record', 'encode', 'of it crc', 'scan', 'key', 'full decode', 'copyOf at issue', 'walk only'],
          [[N, kind, c(N, kind, 'bytesPerRec'), c(N, kind, 'encode'), c(N, kind, 'crcOnly'), c(N, kind, 'scan'), c(N, kind, 'key'), c(N, kind, 'full'), c(N, kind, 'copyOf'), c(N, kind, 'encodable')] for N, kind in keys])
    def b(kind, k):
        return med([next(x[k] for x in r['big'] if x['kind'] == kind) for r in codec])
    table(['1 MiB value', 'encode µs', 'crc alone µs', 'scan µs', 'full decode µs', 'copyOf µs', 'one slice copy µs'],
          [[kind, b(kind, 'encode_us'), b(kind, 'crcOnly_us'), b(kind, 'scan_us'), b(kind, 'full_us'), b(kind, 'copyOf_us'), b(kind, 'sliceCopy_us')] for kind in ['str', 'u8']])
hop = lines('hop')
if hop:
    print(f'### One hop when the box is idle: µs ({len(hop)} runs of {hop[0]["rows"][1]["n"]:,} round trips)\n')
    names = [x['name'] for x in hop[0]['rows']]
    def h(n, k):
        return med([next(x[k] for x in r['rows'] if x['name'] == n) for r in hop])
    table(['hop', 'p50', 'p90', 'p99'], [[n, h(n, 'p50'), h(n, 'p90'), h(n, 'p99')] for n in names])
sd = lines('strdec')
if sd:
    print(f'### Decoding the 13 strings of a row: ns per string ({len(sd)} runs)\n')
    table(['TextDecoder per string (v4)', 'short-ASCII fast path', 'fast path + field-name cache'],
          [[med([r['td'] for r in sd]), med([r['ascii'] for r in sd]), med([r['intern'] for r in sd])]])

# ---------------------------------------------------------------- reads
print('## bench/reads\n')
lr = lines('local-read')
if lr:
    print('### One local read of a held row: ns per read (key-string building, `idx.only`, subtracted)\n')
    ways = ['snapshot.k', 'snapshot', 'lens.k', 'handle.k', 'map.get']
    rows = []
    for n in sorted({o['rows'] for o in lr}):
        rs = [o for o in lr if o['rows'] == n]
        cells = []
        for w in ways:
            v = [o['ns'][w] - (o['ns']['idx.only'] if w != 'snapshot' else 0) for o in rs]
            cells.append(med([x / 1e6 for x in v], ' ms') if statistics.median(v) > 1e6 else med(v))
        rows.append([f'{n:,}', len(rs)] + cells)
    table(['rows', 'runs'] + ways, rows)
ss = lines('snapshot-serve')
if ss:
    print('### Answering one state-mode SUB of one 100-row room: µs\n')
    ks = ['scan', 'index', 'encode', 'shared, 100 subscribers', 'shared, 1000 subscribers']
    table(['rows', 'runs'] + ks, [[f'{n:,}', len(rs)] + [med([o['us'][k] for o in rs]) for k in ks]
                                  for n in sorted({o['rows'] for o in ss}) for rs in [[o for o in ss if o['rows'] == n]]])
rt = lines('route')
if rt:
    print(f'### Routing one committed record to its followers: ns per record, frames of 256 ({len(rt)} runs)\n')
    rows = []
    for kind in ['row', 'field']:
        for F in [0, 10, 1000, 100000]:
            rs = [o['ns'][f'{kind}/F={F}'] for o in rt]
            rows.append([kind, f'{F:,}', f'{rs[0]["hitRate"] * 100:.1f} %'] + [med([r[w] for r in rs]) for w in ['scan+full', 'scan+key', 'scan+slot', 'slot test only']])
    table(['record', 'followed partitions (of 100,000)', 'records that hit', 'scan + full decode', 'scan + key decode', 'scan + slot test', 'slot test alone'], rows)
    rows = []
    for kind in ['row', 'field']:
        rs = [o['ns'][f'{kind}/per-frame'] for o in rt]
        rows.append([kind, rs[0]['bytesPerRecord'], med([r['crc check (v4 JS)'] for r in rs]), med([r['scan'] for r in rs])])
    table(['record', 'bytes per record', 'crc check (v4 JS crc32c)', 'boundary scan'], rows)
    rows = []
    for kind in ['row', 'field']:
        for sel in [1, 16, 256]:
            rs = [o['ns'][f'{kind}/cut sel={sel}'] for o in rt]
            rows.append([kind, sel] + [med([r[w] for r in rs]) for w in ['reencode', 'copy+crc', 'copy+zcrc']])
    print('Cutting one subscriber\'s frame out of a committed batch: ns per chosen record\n')
    table(['record', 'records chosen of 256', 're-encode from objects (v4)', 'copy bytes + v4 JS crc', 'copy bytes + native crc'], rows)
    print('Self-check (a cut frame decodes back to exactly the chosen records): ' + str(all(o['ns']['selfcheck'] for o in rt)) + '\n')
sb = lines('substream')
if sb:
    print(f"### A live subscription's changes: v4's one control frame per change against one frame per 256: ns per change ({len(sb)} runs)\n")
    rows = []
    for kind in ['row', 'field']:
        for n in [1, 100]:
            rs = [o['ns'][f'{kind}/serve, {n} subscribers, per change per subscriber'] for o in sb]
            rows.append([kind, f'serve, {n} subscriber{"s" if n > 1 else ""}, per subscriber', med([r['subrec'] for r in rs]), med([r['batch'] for r in rs])])
        rs = [o['ns'][f'{kind}/apply on the client, per change'] for o in sb]
        rows.append([kind, 'apply on the client (decode + data)', med([r['subrec'] for r in rs]), med([r['batch'] for r in rs])])
        bb = rs[0]['frame bytes per change']
        rows.append([kind, 'wire bytes per change', bb['subrec'], bb['batch']])
    table(['record', 'step', 'v4 SUBREC per change', 'one frame per 256'], rows)

# ---------------------------------------------------------------- upkeep
print('## bench/upkeep\n')
b1 = lines('b1')
if b1:
    g = group(b1, 'case')
    print(f'### b1: a checksum and a copy, per byte (32 MB; 100 B records, 256 to a batch; {len(next(iter(g.values())))} runs)\n')
    table(['case', 'ns per byte', 'ns per 100 B record', 'MB/s'],
          [[k, med([r['ns_per_byte'] for r in rs]), med([r['ns_per_100B_record'] for r in rs]), med([r['mb_per_s'] for r in rs])] for k, rs in g.items()])
b2 = lines('b2')
if b2:
    g = defaultdict(list)
    for r in b2:
        g[(r['form'], r['level'])].append(r)
    print(f'### b2: each level of reading a batch, µs per record (200,000 small rows, 256 to a batch; {len(next(iter(g.values())))} runs)\n')
    table(['form', 'level', 'µs per record, wall', 'µs per record, CPU', 'bytes per row'],
          [[f, l, med([r['us_per_record'] for r in rs]), med([r['cpu_us_per_record'] for r in rs]), rs[0].get('bytes_per_row', '')] for (f, l), rs in g.items()])

b3 = lines('b3')
if b3:
    g = defaultdict(list)
    for r in b3:
        g[(r['shape'], r['form'], r['keep'], r['rows'])].append(r)
    print('### b3: one decode pass with the rows kept or not, µs per row (256 to a frame; no checksum)\n')
    fname = {'v4': "v4's codec", 'rec': 'binary key, value as JSON, per record', 'json': 'one JSON array per frame', 'v8': "V8's format per frame"}
    rows = []
    for shp in ['field', 'small', 'big']:
        for n in sorted({k[3] for k in g if k[0] == shp}):
            for frm in ['v4', 'rec', 'json', 'v8']:
                for kp in [False, True]:
                    t = g.get((shp, frm, kp, n), [])
                    if t:
                        rows.append([shp, f'{n:,}', fname[frm], 'kept' if kp else 'not kept', len(t), t[0]['bytes_per_row'], med([r['us_per_row'] for r in t]), med([r['cpu_us_per_row'] for r in t]), med([r['gc_us_per_row'] for r in t]), med([r['heap_mb'] for r in t])])
    table(['shape', 'rows decoded', 'form', 'the rows', 'runs', 'bytes per row', 'µs per row, wall', 'µs per row, CPU', 'GC µs per row', 'heap after, MB'], rows)

# ---------------------------------------------------------------- core
print('## bench/core\n')
api = lines('api'); alloc = lines('alloc'); jv = lines('jsonval'); sysr = lines('sys'); link = lines('link'); cb = lines('codecbytes')
if api:
    print('### B1: one write and one received record through fero v4 (solo runtime, no I/O)\n')
    ga = group(api, 'mode'); gal = group(alloc, 'mode')
    table(['mode', 'runs', 'ns per op', 'bytes allocated per op'],
          [[m, len(ga.get(m, [])), med([r['ns_per_op'] for r in ga.get(m, [])]), med([r['bytes_per_op'] for r in gal.get('alloc-' + m, [])])]
           for m in ['write-num', 'write-row', 'inbound-num', 'inbound-row']])
profs = {}
for m in ['write-num', 'write-row', 'inbound-num', 'inbound-row']:
    p = os.path.join(R, f'prof-{m}.json')
    if os.path.exists(p):
        profs[m] = json.load(open(p))
if profs:
    print('Where the time goes: self time by area, % (one CPU profile per mode)\n')
    areas = []
    for p in profs.values():
        for a in p['areas']:
            if a not in areas:
                areas.append(a)
    table(['area'] + list(profs), [[a] + [profs[m]['areas'].get(a, 0) for m in profs] for a in areas])
    print('Top functions (self time, %):\n')
    for m, p in profs.items():
        print(f'- {m}: ' + '; '.join(f'{k} {v}' for k, v in p['top'][:8]))
    print()
if sysr:
    gs = group(sysr, 'mode')
    print('### B2, B5, B6: the per-batch constants (CPU of the whole process: every thread)\n')
    rows = []
    for m in ['fsync-grow', 'fsync-over', 'jthread', 'a1', 'a2', 'write', 'writev', 'imm', 'hop']:
        t = gs.get(m, [])
        if t:
            pp = f"{med([r.get('p50_us') for r in t])} / {med([r.get('p99_us') for r in t])}" if 'p50_us' in t[0] else '-'
            rows.append([m, len(t), med([r['wall_us_per_op'] for r in t]), med([r['cpu_us_per_op'] for r in t]),
                         f"{med([r['user_us_per_op'] for r in t])} / {med([r['sys_us_per_op'] for r in t])}", med([r['vol_ctx_per_op'] for r in t]), pp])
    table(['mode', 'runs', 'wall µs per op', 'CPU µs per op', 'of it user / system', 'voluntary context switches per op', 'p50 / p99 µs'], rows)
    rows = []
    for m in ['tick1', 'idle']:
        t = gs.get(m, [])
        if t:
            rows.append([m, len(t), med([r['cpu_share_of_core'] for r in t]), med([r['cpu_us_per_tick'] for r in t]), med([r['ticks'] / r['seconds'] for r in t]), med([r['vol_ctx_per_s'] for r in t])])
    table(['idle process, 3 s', 'runs', 'share of one core', 'CPU µs per tick', 'ticks a second', 'voluntary context switches a second'], rows)
if link:
    gl = group(link, 'mode')
    print('### B3: a link, per 150 B message (sender and receiver in one process), per link, and per signature\n')
    table(['mode', 'runs', 'CPU µs per message', 'of it user / system', 'wall µs per message', 'reads per message'],
          [[m, len(t), med([r['cpu_us_per_op'] for r in t]), f"{med([r['user_us_per_op'] for r in t])} / {med([r['sys_us_per_op'] for r in t])}", med([r['wall_us_per_op'] for r in t]), med([r['reads_per_msg'] for r in t])]
           for m in ['tcp-each', 'tcp-cork64', 'tcp-cat64', 'tls-each', 'tls-cork64', 'tls-cat64'] for t in [gl.get(m, [])] if t])
    table(['per link', 'runs', 'CPU µs per connection (both ends)', 'wall µs per connection'],
          [[m, len(t), med([r['cpu_us_per_op'] for r in t]), med([r['wall_us_per_op'] for r in t])] for m in ['hs-tcp', 'hs-tls'] for t in [gl.get(m, [])] if t])
    t = gl.get('crypto', [])
    if t:
        table(['per 150 B message', 'runs', 'HMAC-SHA256 µs', 'Ed25519 verify µs', 'ES256 verify µs'],
              [['crypto', len(t), med([r['hmac_sha256_us'] for r in t]), med([r['ed25519_verify_us'] for r in t]), med([r['es256_verify_us'] for r in t])]])
if cb:
    print("### B4: v4's record bytes, and a 1-byte length for short strings\n")
    rows = defaultdict(list)
    for r in cb:
        for x in r['rows']:
            rows[(x['format'], x['kind'])].append(x)
    table(['format', 'record', 'runs', 'round trip', 'bytes per record (frames of 256)', 'envelope of one frame, bytes', 'frame of 1 record, bytes', 'encode ns per record', 'full decode ns per record'],
          [[k[0], k[1], len(t), all(x['roundTrip'] for x in t), med([x['record_bytes'] for x in t]), med([x['envelope_bytes_one_frame'] for x in t]), med([x['frame1_bytes'] for x in t]), med([x['encode_ns'] for x in t]), med([x['decode_ns'] for x in t])]
           for k in [('v4', 'row'), ('short', 'row'), ('v4', 'field'), ('short', 'field')] for t in [rows.get(k, [])] if t])
    o = cb[0]['others']
    print(f"Same row, other forms: JSON {o['json_record_bytes']} B, V8 serialize {o['v8_serialize_record_bytes']} B; its field names {o['field_names_bytes']} B; strings per row record {o['strings_per_row_record']}.\n")
if jv:
    print("### B7: a small row's value as JSON, against v4's codec (frames of 256)\n")
    table(['form', 'runs', 'round trip', 'bytes per record', 'encode ns per record', 'decode ns per record'],
          [[name, len(jv), all(r[k]['ok'] for r in jv), med([r[k]['bytes_per_record'] for r in jv]), med([r[k]['encode_ns'] for r in jv]), med([r[k]['decode_ns'] for r in jv])]
           for k, name in [('rec', 'binary key, value as JSON, parsed per record'), ('batch', 'binary keys, values as one JSON array per frame'), ('v4', "v4's codec (its decode includes its JS crc32c)")]])

fd = lines('field'); esc = lines('escape'); s2 = lines('sys2'); rp = lines('raftport')
if fd:
    print("### B8: a field record (one number), v4's codec against a binary key and the value as JSON (frames of 256, hot loop, not kept)\n")
    table(['form', 'runs', 'round trip', 'bytes per record', 'encode ns per record', 'decode ns per record'],
          [[name, len(fd), all(r['ok'] for r in fd), fd[0][k + '_bytes'], med([r[k + '_encode_ns'] for r in fd]), med([r[k + '_decode_ns'] for r in fd])]
           for k, name in [('v4', "v4's codec"), ('rec', 'binary key and field, value as JSON')]])
if esc:
    print("### B9: PA-1b's tagged escape, ns per record\n")
    print('Self-check (every escaped class round-trips; plain values get no flag): ' + str(all(r['ok'] for r in esc)) + '\n')
    table(['shape', 'runs', 'JSON bytes', 'JSON.stringify', 'the walk alone', 'walk + stringify', 'stringify with a replacer', 'JSON.parse', 'JSON.parse with a reviver'],
          [[k, len(esc), esc[0][k]['json_bytes']] + [med([r[k][c] for r in esc]) for c in ['stringify_ns', 'walk_ns', 'walk_stringify_ns', 'replacer_ns', 'parse_ns', 'reviver_ns']] for k in ['field', 'small', 'big']])
if s2:
    g = group(s2, 'mode')
    print('### B10: the flush split: one 128 B write and one flush, preallocated file (CPU of the whole process)\n')
    names = {'inplace': 'writeSync + fdatasyncSync (in place)', 'inplacef': 'writeSync + fsyncSync (in place)', 'a1': 'writeSync + async fdatasync (one pool hop)',
             'a1f': 'writeSync + async fsync (one pool hop)', 'a2d': 'async write + async fdatasync (two pool hops)', 'a2': "async write + async fsync (two pool hops: v4's way)"}
    table(['mode', 'runs', 'CPU µs per op', 'p50 µs', 'p99 µs'],
          [[names[m], len(g[m]), med([r['cpu_us'] for r in g[m]]), med([r['p50_us'] for r in g[m]]), med([r['p99_us'] for r in g[m]])] for m in names if m in g])
if rp:
    g = defaultdict(list)
    for r in rp:
        g[(r['groups'], r['rate'])].append(r)
    print("### B11: E-10's TypeScript Raft port in E-11's host, three processes on loopback, one Raft entry per 100 B write\n")
    table(['groups', 'offered writes/s', 'runs', 'committed/s', 'cluster cores', 'CPU µs per write (cluster)', 'busiest process, cores', 'fsyncs/s per process', 'commit p50 ms', 'commit p99 ms'],
          [[k[0], f'{k[1]:,}', len(t), med([r['commits_s'] for r in t]), med([r['cluster_cores'] for r in t]), med([r['us_per_write'] for r in t]), med([r['busiest_cores'] for r in t]),
            med([statistics.median(r['fsyncs_s']) for r in t]), med([r['p50_ms'] for r in t]), med([r['p99_ms'] for r in t])] for k, t in sorted(g.items())])

if LOADS:
    print(f'Load average before each process: median {statistics.median(LOADS):.2f}, range {min(LOADS):.2f}-{max(LOADS):.2f}, n = {len(LOADS)}.')
