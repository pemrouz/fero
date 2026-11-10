#!/usr/bin/env python3
"""E-41: what each candidate costs the hosted platform, per project per month, at DEP-21's three loads.

A spreadsheet as code. Every number is one of:
  cited    a published price (PRICES: value, unit, link, how it was read, date)
  measured a number from this study's experiments (MEASURED: value, the experiment)
  assumed  a size the requirement leaves open (ASSUMED: value, why)
Run:  python3 cost.py            prints the tables (markdown) and writes results/cost.csv and results/inputs.md
"""
import csv, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
H = 730.0                                   # hours in a month
S = H * 3600                                # seconds in a month
GB = 1e9

# ── cited prices ───────────────────────────────────────────────────────────────────────────────────────────────
# "how": every one was read on 2026-11-10 from a web search's summary of the page named, not from the page itself:
# this session cannot open fly.io or aws.amazon.com (outside its allowed network). Each must be re-read on the
# vendor's page before VERDICT.md is final. Where a third-party copy was the only source, it says so.
D = '2026-11-10'
PRICES = {
  # Fly.io (J's platform: "a Fly app per project"). Ashburn (iad) rates.
  'fly.shared1x.256':   (2.19,   '$/month, always on', 'https://fly.io/docs/about/pricing/', 'search summary; equals J\'s own figure for a free project with a live app', D),
  'fly.ram.gb':         (6.00,   '$/GB-month of extra RAM on any preset', 'https://fly.io/pricing/', 'search summary of Fly\'s pricing page', D),
  'fly.shared.cpu':     (0.69,   '$/month for one shared vCPU without RAM (2.19 less 0.25 GB of RAM)', 'https://fly.io/docs/about/pricing/', 'derived from the two rows above; 512 MB = 3.69 and 1 GB = 6.70 agree', D),
  'fly.perf.cpu':       (21.00,  '$/month for one performance vCPU without RAM (performance-1x with 2 GB is 33.00)', 'https://fly.io/pricing/', 'search summary of Fly\'s pricing page', D),
  'fly.volume.gb':      (0.15,   '$/GB-month, provisioned size', 'https://fly.io/docs/about/pricing/', 'search summary', D),
  'fly.rootfs.gb':      (0.15,   '$/GB-month for a stopped Machine\'s root filesystem', 'https://fly.io/docs/about/pricing/', 'third-party copies only; no primary text seen', D),
  'fly.egress.gb':      (0.02,   '$/GB out to North America and Europe (0.04 Asia Pacific, 0.12 Africa and India)', 'https://fly.io/docs/about/pricing/', 'search summary', D),
  'fly.private.gb':     (0.0,    '$/GB between Machines in one region', 'https://fly.io/docs/about/pricing/', 'search summary: "same-region transfer is free"', D),
  'tigris.storage.gb':  (0.02,   '$/GB-month (Fly\'s object store partner)', 'https://www.tigrisdata.com/docs/pricing/', 'NOT confirmed by the search; taken as S3-like. Traffic from Fly to Tigris is free (Fly docs, search summary)', D),
  'tigris.put.k':       (0.005,  '$ per 1,000 write requests', 'https://www.tigrisdata.com/docs/pricing/', 'NOT confirmed by the search; set equal to S3 Standard', D),
  # AWS, US East (N. Virginia)
  'aws.t4g.nano':       (0.0042, '$/hour on demand (2 vCPU burstable, 0.5 GB)', 'https://aws.amazon.com/ec2/pricing/on-demand/', 'search summary (ec2instances.info and an AWS page copy)', D),
  'aws.t4g.small':      (0.0168, '$/hour on demand (2 vCPU burstable, 2 GB)', 'https://aws.amazon.com/ec2/pricing/on-demand/', 'search summary', D),
  'aws.c7g.medium':     (0.0363, '$/hour on demand (1 vCPU, 2 GB)', 'https://aws.amazon.com/ec2/pricing/on-demand/', 'search summary (third-party calculators)', D),
  'aws.c7g.large':      (0.0725, '$/hour on demand (2 vCPU, 4 GB)', 'https://aws.amazon.com/ec2/pricing/on-demand/', 'search summary (two third-party calculators agree)', D),
  'aws.gp3.gb':         (0.08,   '$/GB-month (3,000 IOPS and 125 MB/s included)', 'https://aws.amazon.com/ebs/pricing/', 'search summary', D),
  'aws.interaz.gb':     (0.02,   '$/GB between Availability Zones (0.01 out plus 0.01 in)', 'https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer', 'search summary; REQUIREMENTS DEP-21 cites the same 0.01 each way', D),
  'aws.egress.gb':      (0.09,   '$/GB out to the internet (first 10 TB a month)', 'https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer', 'not searched: the long-standing list price, from memory', D),
  's3.storage.gb':      (0.023,  '$/GB-month, S3 Standard, first 50 TB', 'https://aws.amazon.com/s3/pricing/', 'search summary', D),
  's3.put.k':           (0.005,  '$ per 1,000 PUT, COPY, POST or LIST, S3 Standard', 'https://aws.amazon.com/s3/pricing/', 'search summary (third-party guides agree)', D),
  's3.get.k':           (0.0004, '$ per 1,000 GET, S3 Standard', 'https://aws.amazon.com/s3/pricing/', 'search summary', D),
  's3x.storage.gb':     (0.11,   '$/GB-month, S3 Express One Zone (one zone only)', 'https://aws.amazon.com/s3/pricing/', 'search summary', D),
  's3x.put.k':          (0.00113,'$ per 1,000 PUT, S3 Express One Zone, since 2025-04-10', 'https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone', 'search summary of AWS\'s own post', D),
  's3x.upload.gb':      (0.0032, '$/GB uploaded, S3 Express One Zone', 'https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone', 'search summary', D),
}
P = {k: v[0] for k, v in PRICES.items()}

# ── measured here ──────────────────────────────────────────────────────────────────────────────────────────────
MEASURED = {
  'row.heap.overhead':   (230,    'bytes of V8 heap per row on top of its ~100 B of data (315-338 B per 100 B row)', 'E-05'),
  'row.heap.d13':        (1.6,    'x: decision 13\'s two-thread form holds 510-528 B per 100 B row, 1.6 x the one-thread form', 'E-05'),
  'process.fixed.core':  (0.25,   'core: a pipeline process uses 0.2-0.3 core at up to tens of thousands of appends a second, in TS, Rust and Go alike', 'E-02'),
  'fold.us':             (4.6,    'us per record: fero v4\'s decode 2.7 us plus data\'s fold 0.22-1.9 us (batches of 256)', 'E-05'),
  'idle.core':           (0.01,   'core: an idle member with 2,000 quiet groups and 99 links (0.95% in Node, 0.33% in Rust)', 'E-25, E-11'),
  'subs.core.per.1000':  (0.17,   'core for 1,000 subscribers at 10 messages a second each over TLS (0.088 over plain TCP)', 'E-27'),
  'tls.link.kb':         (49.7,   'KB of memory per idle TLS client link in Node (3.7 KB plain TCP)', 'E-27'),
  'dormant.group.bytes': (57,     'bytes of memory per dormant group on a log-tier process (24 B on disk)', 'E-26'),
  'empty.process.mb':    (85,     'MB: an empty fero v4 copy (70-100 MB; DEP-13\'s bar is 100 MB)', 'REQUIREMENTS DEP-13 (v4 measured)'),
  'replay.s.per.gb':     (36,     's per GB to rebuild rows from the log (so a cold failover of 1 GB of rows fails F-05\'s 2.5 s)', 'E-05'),
  'jetstream.us':        (23,     'us of server CPU per message, three JetStream servers, default sync', 'E-09b'),
  'v4.writes.per.member':(250,    'persisted writes a second per member, fero v4', 'REQUIREMENTS PERF-09 (v4 measured)'),
  'journal.ceiling.mb':  (280,    'MB/s: the pipeline\'s ceiling on this disk (2.8M appends of 100 B a second)', 'E-02'),
  'tenant.budget.mb':    (5,      'MB/s of big-record bytes one tenant may write before a neighbour\'s p99 moves past SC-11\'s bar (1 MiB/s on a shared journal, 5 with a journal per tenant)', 'E-35'),
}
M = {k: v[0] for k, v in MEASURED.items()}

# ── assumed (the requirement leaves these open) ────────────────────────────────────────────────────────────────
ASSUMED = {
  'row.bytes':           (1000,   'bytes per row: DEP-21 says writes of 1 KB'),
  'free.rows':           (312,    'rows in the sleeping free project (J\'s small project)'),
  'small.rows':          (10000,  'rows in the 10 writes/s project (DEP-13: 256 MB holds 10,000 small rows)'),
  'big.rows':            (1000000,'rows in the 5,000 writes/s project (1 GB of rows: one Node heap, SC-10)'),
  'history.hours.local': (1,      'hours of log kept on each replica\'s own disk'),
  'history.hours.store': (24,     'hours of log kept in the object store (replay, forks, new replicas)'),
  'segment.mb':          (64,     'MB per uploaded log segment'),
  'upload.every.s':      (60,     'at low rates a segment is uploaded at least this often'),
  'image.gb':            (0.25,   'GB of root filesystem per Machine (a Node app image)'),
  'min.volume.gb':       (1,      'GB: the smallest volume'),
  'obj.batch.ms':        (10,     'ms: OBJ groups commits into one PUT per window (its latency floor, E-28)'),
  'tier.node.month':     (21*2 + 6*4 + 0.15*500, '$: one log-tier node: two performance vCPUs, 4 GB, a 500 GB volume'),
  'tier.node.mb':        (50,     'MB/s a log-tier node is budgeted to take from all its tenants (a fifth of E-02\'s ceiling, for headroom and tails)'),
  'pool.node.month':     (21*4 + 6*16 + 0.15*500, '$: one pooled server (EMB-V8): four performance vCPUs, 16 GB, a 500 GB volume'),
  'isolate.mb':          (30,     'MB per awake V8 isolate in a pooled server (reasoned; E-03 measured isolate memory in its own form)'),
  'subs.share':          (1.0,    'share of the writes each subscriber receives (1 = every subscriber gets every write)'),
}
A = {k: v[0] for k, v in ASSUMED.items()}

LOADS = {
  'sleeping':  dict(name='a sleeping free project', wps=0, rows=A['free.rows'], subs=0, awake=0.0),
  'small':     dict(name='10 writes/s of 1 KB, 100 subscribers', wps=10, rows=A['small.rows'], subs=100, awake=1.0),
  'big':       dict(name='5,000 writes/s of 1 KB', wps=5000, rows=A['big.rows'], subs=0, awake=1.0),
}

def heap_gb(rows, form=1.0):
    """V8 heap for the rows of one folding replica."""
    return rows * (A['row.bytes'] + M['row.heap.overhead']) * form / GB

def machine(platform, cores, ram_gb):
    """Smallest machine with that many sustained cores and that much RAM; returns ($/month awake, label)."""
    if platform == 'fly':
        if cores <= 0.06:                                  # a shared vCPU sustains a small fraction of a core
            ram = max(0.25, 2 ** max(-2, __import__('math').ceil(__import__('math').log2(ram_gb))))
            return P['fly.shared.cpu'] + P['fly.ram.gb'] * ram, 'shared-cpu-1x %g MB' % (ram * 1024)
        n = max(1, __import__('math').ceil(cores))
        ram = max(2 * n, 2 ** __import__('math').ceil(__import__('math').log2(max(ram_gb, 2))))
        return P['fly.perf.cpu'] * n + P['fly.ram.gb'] * ram, 'performance-%dx %g GB' % (n, ram)
    if cores <= 0.06 and ram_gb <= 0.5: return P['aws.t4g.nano'] * H, 't4g.nano'
    if cores <= 0.2 and ram_gb <= 2:   return P['aws.t4g.small'] * H, 't4g.small'
    if cores <= 1 and ram_gb <= 2:     return P['aws.c7g.medium'] * H, 'c7g.medium'
    n = max(1, __import__('math').ceil(max(cores / 2, ram_gb / 4)))
    return P['aws.c7g.large'] * H * n, 'c7g.large' + (' x%d' % n if n > 1 else '') if n == 1 else ('c7g.%s' % {2: 'xlarge', 4: '2xlarge'}.get(n, 'large x%d' % n))

def volume(platform, gb): return (P['fly.volume.gb'] if platform == 'fly' else P['aws.gp3.gb']) * gb
def stopped(platform): return (P['fly.rootfs.gb'] * A['image.gb']) if platform == 'fly' else P['aws.gp3.gb'] * 8   # AWS: a stopped instance keeps its 8 GB root volume
def store(platform, gb, puts, express=False):
    if platform == 'fly': return P['tigris.storage.gb'] * gb + P['tigris.put.k'] * puts / 1000
    if express: return P['s3x.storage.gb'] * gb + P['s3x.put.k'] * puts / 1000
    return P['s3.storage.gb'] * gb + P['s3.put.k'] * puts / 1000
def interaz(platform, gb): return 0.0 if platform == 'fly' else P['aws.interaz.gb'] * gb

# what a row is made of, for cost. Rows that differ only on axes that do not move cost at these loads share a shape.
#   full     replicas that hold a log and fold the rows (a machine with RAM for the rows)
#   logonly  voters that hold a log but no rows, on machines of the project's own
#   tier     log replicas on the shared log tier (a share of its nodes)
#   standby  with one server only, failover is cold: 36 s per GB of rows (E-05), so F-05 needs a second
#   app      machines for the user's app when fero is a separate server (H `srv`); 0 when fero runs inside the app (H `emb`)
#   pd       extra control machines of the project's own (TiKV's placement driver)
#   pool     True: the project is isolates inside shared servers (EMB-V8)
#   obj      True: every commit batch is an object PUT
SHAPES = {
  'MIN':    dict(full=3, logonly=0, tier=0, app=0, why='three full copies, each folds; a process per project'),
  'MIN-TS': dict(full=3, logonly=0, tier=0, app=0, why='as MIN (the language does not change the machine at these loads, E-02)'),
  'MIN-P':  dict(full=3, logonly=0, tier=0, app=0, why='as MIN (project-owned groups save memory per resource, E-36, not per row)'),
  'RUST':   dict(full=3, logonly=0, tier=0, app=0, why='as MIN (E-02: 0.2-0.3 core per process in Rust too)'),
  'SIDE':   dict(full=3, logonly=0, tier=0, app=0, why='as MIN plus a daemon per host (inside the same machine)'),
  'LEAN':   dict(full=2, logonly=1, tier=0, app=0, why='the leader and one warm standby fold; the third voter keeps only the log'),
  'V4':     dict(full=3, logonly=0, tier=0, app=0, nostore=True, why='three members that each apply every write; no object store'),
  'DRAFT':  dict(full=2, logonly=0, tier=1, app=0, why='two full copies plus a log-only voter on the shared log tier'),
  'CELL':   dict(full=2, logonly=0, tier=1, app=0, why='as DRAFT'),
  'LANE':   dict(full=2, logonly=0, tier=1, app=0, why='as DRAFT'),
  'SPLIT':  dict(full=2, logonly=0, tier=1, app=0, why='as DRAFT'),
  'SLOG':   dict(full=2, logonly=0, tier=3, app=0, servers_disposable=True, why='three log members on the shared tier; two servers that fold (one would make failover cold: 36 s per GB)'),
  'RLOG':   dict(full=2, logonly=0, tier=3, app=0, servers_disposable=True, why='as SLOG: Raft runs on three log members; two servers are learners that fold'),
  'OBJ':    dict(full=2, logonly=0, tier=0, app=0, obj=True, servers_disposable=True, why='the object store is the log: one PUT per commit window; a leader and one lazy standby'),
  'SRV':    dict(full=3, logonly=0, tier=0, app=2, why='three server machines, and the app runs beside them (two app machines, so one can fail)'),
  'ISR':    dict(full=3, logonly=0, tier=0, app=0, why='three brokers, the controller inside them'),
  'PD':     dict(full=3, logonly=0, tier=0, app=2, pd=3, why='three stores, three placement-driver machines, and the app beside them'),
  'EMB-V8': dict(full=3, logonly=0, tier=0, app=0, pool=True, why='isolates inside three pooled servers shared by many projects'),
  'BUY':    dict(full=0, logonly=3, tier=0, app=2, buy=True, why='three NATS servers (log only) and the app, which folds, beside them'),
}

def cost(cand, load_key, platform='fly', subs_outside=False):
    s, L = SHAPES[cand], LOADS[load_key]
    wps, rows, subs, awake = L['wps'], L['rows'], L['subs'], L['awake']
    items = []                                                  # (what, $)
    add = lambda what, d: items.append((what, d))
    bps = wps * A['row.bytes']                                  # bytes of log a second
    month_gb = bps * S / GB
    local_gb = max(A['min.volume.gb'], round(bps * 3600 * A['history.hours.local'] / GB + 2.2 * rows * A['row.bytes'] / GB + 1))   # log, two snapshots, reserve (E-29)
    store_gb = bps * 3600 * A['history.hours.store'] / GB + rows * A['row.bytes'] / GB
    puts = 0 if wps == 0 else max(S / A['upload.every.s'], bps * S / (A['segment.mb'] * 1e6))
    rows_gb = heap_gb(rows)
    cpu_full = (M['process.fixed.core'] if wps >= 1000 else M['idle.core']) + wps * M['fold.us'] / 1e6 + subs / 1000 * M['subs.core.per.1000']
    cpu_log = M['process.fixed.core'] if wps >= 1000 else M['idle.core']
    ram_full = M['empty.process.mb'] / 1024 + rows_gb + subs * M['tls.link.kb'] / 1e6
    ram_log = M['empty.process.mb'] / 1024 * 0.6

    if s.get('pool'):
        # a share of three pooled servers, by memory (asleep: nothing resident) and by CPU
        share = 0 if awake == 0 else max((A['isolate.mb'] / 1024 + rows_gb) / 16, cpu_full / 4)
        add('share of 3 pooled servers (%.2f%% each)' % (100 * share), 3 * share * A['pool.node.month'])
        add('disk on the pooled servers', 3 * P['fly.volume.gb' if platform == 'fly' else 'aws.gp3.gb'] * (local_gb if wps else rows * A['row.bytes'] / GB))
    else:
        if awake == 0:
            n = 1                                               # a free project keeps one copy (DEP-16 states its loss window)
            if s.get('buy') or s.get('app'): n = (1 if not s.get('buy') else 3) + 1       # a separate server (three for JetStream R3) and the app
            add('%d stopped machine(s), root filesystem only' % n, n * stopped(platform))
            if not (s['tier'] or s.get('obj')): add('%d volume(s) of %d GB' % (1 if not s.get('buy') else 3, A['min.volume.gb']), (1 if not s.get('buy') else 3) * volume(platform, A['min.volume.gb']))
        else:
            if s['full']:
                c, label = machine(platform, cpu_full, ram_full)
                add('%d x %s (fold)' % (s['full'], label), s['full'] * c)
                if not s.get('obj'): add('%d x %d GB volume' % (s['full'], local_gb), s['full'] * volume(platform, local_gb))
            if s['logonly']:
                cl, ll = machine(platform, cpu_log + (wps * M['jetstream.us'] / 1e6 / 3 if s.get('buy') else 0), ram_log + (0.25 if s.get('buy') else 0))
                add('%d x %s (log only)' % (s['logonly'], ll), s['logonly'] * cl)
                add('%d x %d GB volume' % (s['logonly'], local_gb), s['logonly'] * volume(platform, local_gb))
            if s.get('pd'):
                c, label = machine(platform, M['idle.core'], 0.25); add('%d x %s (placement driver)' % (s['pd'], label), s['pd'] * c)
            if s['app']:
                ca, la = machine(platform, (M['idle.core'] + wps * M['fold.us'] / 1e6 + subs / 1000 * M['subs.core.per.1000']) if s.get('buy') else M['idle.core'] + wps * 2e-6, (ram_full if s.get('buy') else 0.2))
                add('%d x %s (the app%s)' % (s['app'], la, ', which folds' if s.get('buy') else ''), s['app'] * ca)
    if s['tier']:
        share = max(bps / (A['tier.node.mb'] * 1e6), (bps * 3600 * A['history.hours.local'] / GB) / 500, M['dormant.group.bytes'] * 20 / 4e9)
        add('share of %d log-tier node(s) (%.3f%% each)' % (s['tier'], 100 * share), s['tier'] * share * A['tier.node.month'])
    # bytes across failure domains: replication (zones on AWS; free inside a Fly region)
    # (three zones hold the bytes, so they cross a zone line twice, however the copies are split between servers and
    # the log tier; OBJ's PUTs go to the region's store, which bills no zone transfer)
    copies_out = (min(3, s['full'] + s['logonly'] + s['tier']) - 1) if not s.get('obj') else 0
    if wps and copies_out > 0 and platform == 'aws': add('replication across zones (%d crossings of %.0f GB)' % (copies_out, month_gb), interaz(platform, copies_out * month_gb))
    # the object store
    if s.get('obj'):
        commits = min(wps, 1000 / A['obj.batch.ms']) * S
        add('object store: %.1fM commit PUTs, %.0f GB kept' % (commits / 1e6, store_gb), store(platform, store_gb, commits))
        if platform == 'aws': add('  (the same on S3 Express One Zone, one zone only)', 0.0)
    elif not s.get('nostore') and not s.get('buy'):
        add('object store: %.0f GB kept, %.0fk uploads' % (store_gb, puts / 1000), store(platform, store_gb, puts))
    # fan-out to subscribers outside the platform (the same for every row)
    if subs and subs_outside:
        gb = subs * bps * A['subs.share'] * S / GB
        add('fan-out to %d subscribers over the internet (%.0f GB)' % (subs, gb), (P['fly.egress.gb'] if platform == 'fly' else P['aws.egress.gb']) * gb)
    return items

def total(c, l, p, o=False): return sum(d for _, d in cost(c, l, p, o))

def obj_express(l):
    """OBJ on S3 Express One Zone (AWS only): the cheap variant, but one zone."""
    L = LOADS[l]; bps = L['wps'] * A['row.bytes']
    commits = min(L['wps'], 1000 / A['obj.batch.ms']) * S
    store_gb = bps * 3600 * A['history.hours.store'] / GB + L['rows'] * A['row.bytes'] / GB
    base = sum(d for w, d in cost('OBJ', l, 'aws') if not w.startswith('object store'))
    return base + store('aws', store_gb, commits, express=True) + P['s3x.upload.gb'] * bps * S / GB

def tables():
    out = []
    order = ['MIN', 'MIN-TS', 'MIN-P', 'RUST', 'SIDE', 'LEAN', 'DRAFT', 'CELL', 'LANE', 'SPLIT', 'SLOG', 'RLOG', 'OBJ', 'EMB-V8', 'SRV', 'ISR', 'PD', 'V4', 'BUY']
    rows_csv = [['candidate', 'load', 'platform', 'total_usd', 'x_cheapest', 'items']]
    for p, pname in (('fly', 'Fly.io, one region (J\'s platform)'), ('aws', 'AWS, three zones')):
        out.append('\n### %s: $ per project per month\n' % pname)
        out.append('| candidate | sleeping | 10 writes/s, 100 subscribers inside | 5,000 writes/s | x cheapest (sleeping / 10 / 5,000; BUY is never the base) |')
        out.append('|---|---|---|---|---|')
        tot = {c: [total(c, l, p) for l in LOADS] for c in order}
        can = {c: [True, True, not (c == 'V4')] for c in order}                 # V4: 250 writes/s per member measured
        low = [min(tot[c][i] for c in order if can[c][i] and c not in ('BUY',)) for i in range(3)]
        low[0] = 0                                                              # asleep, the cheapest is about nothing: a ratio says nothing there
        for c in order:
            t = tot[c]
            cells = ['%.2f' % t[0], '%.2f' % t[1], ('%.0f' % t[2]) if can[c][2] else 'cannot (v4 measured 250 writes/s a member)']
            xs = ['%.1f' % (t[i] / low[i]) if low[i] > 0 and can[c][i] else '-' for i in range(3)]
            out.append('| %s | %s | %s | %s | %s |' % (c, cells[0], cells[1], cells[2], ' / '.join(xs)))
            for i, l in enumerate(LOADS): rows_csv.append([c, l, p, '%.4f' % t[i], xs[i], '; '.join('%s = %.2f' % it for it in cost(c, l, p))])
        if p == 'aws': out.append('| OBJ on S3 Express One Zone (one zone: not the same durability) | - | %.2f | %.0f | - |' % (obj_express('small'), obj_express('big')))
    # the fan-out add-on
    out.append('\n### Fan-out to subscribers outside the platform (added to every row alike)\n')
    out.append('| each subscriber receives | GB a month | Fly, to North America or Europe | AWS |')
    out.append('|---|---|---|---|')
    for share in (1.0, 0.1, 0.01):
        gb = 100 * 10 * A['row.bytes'] * share * S / GB
        out.append('| %s of the writes | %.0f | $%.2f | $%.2f |' % ({1.0: 'all', 0.1: 'a tenth', 0.01: 'a hundredth'}[share], gb, gb * P['fly.egress.gb'], gb * P['aws.egress.gb']))
    # the bars
    out.append('\n### Against DEP-21\'s bars (Fly)\n')
    out.append('| candidate | free project asleep (bar $2.19) | free project awake all month, one copy | 10 writes/s (bar $10), subscribers inside | 10 writes/s, subscribers outside and each gets every write |')
    out.append('|---|---|---|---|---|')
    for c in order:
        s = SHAPES[c]
        if s.get('pool'): awake1 = 3 * ((A['isolate.mb'] / 1024 + heap_gb(A['free.rows'])) / 16) * A['pool.node.month']
        else:
            one, _ = machine('fly', M['idle.core'], M['empty.process.mb'] / 1024 + heap_gb(A['free.rows']))
            n = 1 + (1 if s['app'] else 0) + (2 if s.get('buy') else 0) + (s.get('pd', 0) and 1)
            awake1 = n * one + (0 if (s['tier'] or s.get('obj')) else P['fly.volume.gb'] * A['min.volume.gb'])
        t0, t1, t1o = total(c, 'sleeping', 'fly'), total(c, 'small', 'fly'), total(c, 'small', 'fly', True)
        ok = lambda v, bar: ('%.2f' % v) + (' ok' if v <= bar else ' OVER')
        out.append('| %s | %s | %s | %s | %s |' % (c, ok(t0, 2.19), ok(awake1, 2.19), ok(t1, 10), ok(t1o, 10)))
    # breakdown for a few rows
    out.append('\n### What the money goes on (Fly)\n')
    for c in ('MIN', 'LEAN', 'DRAFT', 'SLOG', 'OBJ', 'EMB-V8', 'SRV', 'BUY'):
        for l in LOADS:
            out.append('- **%s, %s:** %s. %s' % (c, LOADS[l]['name'], '; '.join('%s $%.2f' % it for it in cost(c, l, 'fly')), ''))
    # where LEAN's saving shows: more rows than the smallest whole-core machine holds
    out.append('\n### Sensitivity: 5,000 writes/s over 10 GB of rows (1e7 rows), Fly\n')
    LOADS['huge'] = dict(name='5,000 writes/s, 1e7 rows', wps=5000, rows=10_000_000, subs=0, awake=1.0)
    out.append('| candidate | $ a month | what |')
    out.append('|---|---|---|')
    for c in ('MIN', 'LEAN', 'DRAFT', 'SLOG', 'EMB-V8'):
        out.append('| %s | %.0f | %s |' % (c, total(c, 'huge', 'fly'), '; '.join('%s $%.0f' % it for it in cost(c, 'huge', 'fly'))))
    del LOADS['huge']
    # SLOG with one server (cold failover)
    one = total('SLOG', 'big', 'fly') - cost('SLOG', 'big', 'fly')[0][1] / 2 - cost('SLOG', 'big', 'fly')[1][1] / 2
    out.append('\n### Sensitivity: SLOG or RLOG with one server, Fly, 5,000 writes/s\n')
    out.append('- $%.0f a month, %.2f x MIN. A failover then rebuilds 1 GB of rows from the log: about %d s (E-05), against F-05\'s 2.5 s. So the two-server shape is the one that meets the MUSTs.' % (one, one / total('MIN', 'big', 'fly'), M['replay.s.per.gb']))
    out.append('\n### The same on AWS, 5,000 writes/s\n')
    for c in ('MIN', 'LEAN', 'DRAFT', 'SLOG', 'OBJ'):
        out.append('- **%s:** %s.' % (c, '; '.join('%s $%.2f' % it for it in cost(c, 'big', 'aws'))))
    # the threshold's own questions, answered from the numbers
    out.append('\n### The threshold\n')
    for p, pname in (('fly', 'Fly'), ('aws', 'AWS')):
        t = {c: total(c, 'big', p) for c in order if c not in ('BUY', 'V4')}
        cheapest = min(t, key=t.get); rest = min(v for c, v in t.items() if c not in ('OBJ', 'SLOG', 'RLOG'))
        out.append('- **%s, 5,000 writes/s:** the cheapest is %s ($%.0f). OBJ is $%.0f (%.1f x the cheapest row that is not OBJ or SLOG); SLOG is $%.0f (%.2f x). Neither is cheaper than the rest by 2 x, so the hosted shape is not reopened on cost.' % (pname, cheapest, t[cheapest], t['OBJ'], t['OBJ'] / rest, t['SLOG'], t['SLOG'] / rest))
        for i, l in enumerate(('small', 'big')):
            tt = {c: total(c, l, p) for c in order if not (c == 'V4' and l == 'big')}
            low = min(v for c, v in tt.items() if c != 'BUY')
            over = ['%s (%.1f x)' % (c, v / low) for c, v in tt.items() if v > 2 * low]
            out.append('  - more than 2 x the cheapest at %s: %s' % (LOADS[l]['name'], ', '.join(over) or 'none'))
    need = lambda c: (10 - total(c, 'small', 'fly')) / (100 * 10 * A['row.bytes'] * S / GB * P['fly.egress.gb'])
    out.append('- **The $10 bar and fan-out:** with subscribers outside Fly, MIN stays under $10 only if each subscriber receives at most %.1f%% of the writes (DRAFT: %.1f%%).' % (100 * need('MIN'), 100 * need('DRAFT')))
    with open(os.path.join(HERE, 'results', 'cost.csv'), 'w', newline='') as f: csv.writer(f).writerows(rows_csv)
    return '\n'.join(out)

def inputs():
    out = ['## Cited prices\n', '| key | value | unit | link | how it was read | date |', '|---|---|---|---|---|---|']
    for k, (v, u, link, how, d) in PRICES.items(): out.append('| %s | %g | %s | %s | %s | %s |' % (k, v, u, link, how, d))
    out += ['\n## Measured in this study\n', '| key | value | what | where |', '|---|---|---|---|']
    for k, (v, w, e) in MEASURED.items(): out.append('| %s | %g | %s | %s |' % (k, v, w, e))
    out += ['\n## Assumed\n', '| key | value | why |', '|---|---|---|']
    for k, (v, w) in ASSUMED.items(): out.append('| %s | %g | %s |' % (k, v, w))
    out += ['\n## Shapes\n', '| candidate | full copies | log-only voters of its own | log-tier replicas | app machines beside it | why |', '|---|---|---|---|---|---|']
    for c, s in SHAPES.items(): out.append('| %s | %d | %d | %d | %d | %s |' % (c, s['full'], s['logonly'], s['tier'], s['app'], s['why']))
    return '\n'.join(out)

if __name__ == '__main__':
    t = tables(); i = inputs()
    open(os.path.join(HERE, 'results', 'tables.md'), 'w').write(t + '\n')
    open(os.path.join(HERE, 'results', 'inputs.md'), 'w').write(i + '\n')
    print(t)
