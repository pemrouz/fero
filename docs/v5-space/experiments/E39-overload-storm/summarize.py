#!/usr/bin/env python3
"""E-39: tables from results/pipe.jsonl and results/storm.jsonl (medians with min-max over runs)."""
import json, sys, os, statistics
from collections import defaultdict

R = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'results')

def med(xs, f='{:,.0f}'):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    m = statistics.median(xs)
    return f.format(m) + (' (' + f.format(min(xs)) + '-' + f.format(max(xs)) + ')' if len(xs) > 1 else '')

def rows(name):
    p = os.path.join(R, name)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []

pipe = rows('pipe.jsonl')
if pipe:
    ok = [r for r in pipe if r.get('ok')]
    print('### Maximum (closed loop, 20,000 writes outstanding, no retries)\n')
    print('| impl | runs | committed/s | admitted p50 ms | admitted p99 ms | leader cores | follower cores (each) | load cores | load avg |')
    print('|---|---|---|---|---|---|---|---|---|')
    for impl in ('ts', 'rust'):
        xs = [r for r in ok if r['impl'] == impl and r['mult'] == 'max']
        if not xs: continue
        print(f"| {impl} | {len(xs)} | {med([x['goodput'] for x in xs])} | {med([x['phase1']['adm_ms']['p50'] for x in xs], '{:.1f}')} | {med([x['phase1']['adm_ms']['p99'] for x in xs], '{:.1f}')} | "
              f"{med([x['cores_phase1']['leader'] for x in xs], '{:.2f}')} | {med([x['cores_phase1']['f1'] for x in xs], '{:.2f}')} | {med([x['cores_phase1']['load'] for x in xs], '{:.2f}')} | {med([float(x['loadavg'].split()[0]) for x in xs], '{:.1f}')} |")
    print()
    combos = [('unbounded', 'naive', 'un-naive'), ('bounded', 'naive', 'b-naive'), ('bounded', 'jitter', 'b-jitter'), ('bounded', 'jitter-t2', 'b-jitter-t2'), ('bounded-prio', 'jitter', 'b-prio'), ('bounded', 'credit', 'b-credit')]
    g = defaultdict(list)
    for r in ok:
        if r['mult'] != 'max': g[(r['impl'], r['policy'], r['client'] + ('-t2' if r.get('timeout_ms') == 2000 else ''), r['mult'])].append(r)
    print('### Open loop at 0.5, 1, 1.5 and 2 x max (phase 1: 10 s, the first 3 s are warm-up; phase 2: 8 s at 0.5 x)\n')
    print('Target = the offered rate asked for; offered (sent) = the new writes the two client processes managed to create (below the target when retries saturate them). Goodput = writes whose first live attempt committed, a second. Admitted latency = from the send of the attempt that committed to its commit. Steady = b-jitter at 0.5 x (no overload; every combination behaves alike there). Recovery = time after the drop to 0.5 x until a half-second bucket\'s admitted p99 is back within 2 x steady and stays there.\n')
    print('| impl | combination | x max | runs | target/s | offered/s (sent) | goodput/s | goodput % of max | refused/s | retries/s | timeouts/s | wasted commits/s | given up/s | admitted p50 ms | admitted p99 ms | p99 / steady | end-to-end p99 ms | phase 2 goodput/s | recovery s | leader cores |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for impl in ('ts', 'rust'):
        for pol, cl, name in combos:
            steady = [x['phase1']['adm_ms']['p99'] for x in g.get((impl, 'bounded', 'jitter', '0.5'), []) if x['phase1']['adm_ms']['p99'] > 0]
            st = statistics.median(steady) if steady else None
            for m in ('0.5', '1', '1.5', '2'):
                xs = g.get((impl, pol, cl, m))
                if not xs: continue
                mx = xs[0]['max']
                def rec(x):
                    if st is None: return None
                    s = x['series']; t2 = 10.0
                    bs = [b for b in s if b[0] >= t2 and b[0] < t2 + 8]
                    for i, b in enumerate(bs):
                        if all(0 <= c[7] <= 2 * st for c in bs[i:] if c[2] > 0) and b[7] >= 0: return b[0] - t2
                    return None
                def ratio(x):
                    p = x['phase1']['adm_ms']['p99']
                    return p / st if st and p > 0 else None
                print(f"| {impl} | {name} | {m} | {len(xs)} | {med([x['phase1']['rate'] for x in xs])} | {med([x['phase1']['offered_per_s'] for x in xs])} | {med([x['phase1']['goodput_per_s'] for x in xs])} | {med([100 * x['phase1']['goodput_per_s'] / mx for x in xs], '{:.0f}')} | "
                      f"{med([x['phase1']['refused_per_s'] for x in xs])} | {med([x['phase1']['retries_per_s'] for x in xs])} | {med([x['phase1']['timeouts_per_s'] for x in xs])} | {med([x['phase1']['wasted_per_s'] for x in xs])} | {med([x['phase1']['giveups_per_s'] for x in xs])} | "
                      f"{med([x['phase1']['adm_ms']['p50'] if x['phase1']['adm_ms']['p50'] >= 0 else None for x in xs], '{:.1f}')} | {med([x['phase1']['adm_ms']['p99'] if x['phase1']['adm_ms']['p99'] >= 0 else None for x in xs], '{:.1f}')} | {med([ratio(x) for x in xs], '{:.1f}')} | "
                      f"{med([x['phase1']['e2e_ms']['p99'] if x['phase1']['e2e_ms']['p99'] >= 0 else None for x in xs], '{:.0f}')} | {med([x['phase2']['goodput_per_s'] for x in xs])} | {med([rec(x) for x in xs], '{:.1f}')} | {med([x['cores_phase1']['leader'] for x in xs], '{:.2f}')} |")
    bad = [r for r in pipe if not r.get('ok')]
    if bad: print(f"\n{len(bad)} failed run(s):", '; '.join(f"{b['impl']} {b['mult']} {b['policy']} {b['client']} run {b['run']}" for b in bad))
    print()

storm = rows('storm.jsonl')
if storm:
    print('### Reconnect storm: 10,000 subscribers, the server killed and restarted\n')
    print('| link | redial | TLS resumption | runs | restart ms | 50% resubscribed s | 99% s | 100% s | steady p99 µs | storm p99 µs | storm / steady | after p99 µs | server cores, first 10 s | MB sent, first 10 s | full handshakes | resumed | catch-up msgs | shortfalls | load avg |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for r in storm: g[(r['mode'], r['policy'], r['resume'])].append(r)
    for k in sorted(g):
        xs = g[k]
        print(f"| {k[0]} | {k[1]} | {'yes' if k[2] else 'no'} | {len(xs)} | {med([x['restart_ms'] for x in xs])} | {med([x['resub_s']['p50'] for x in xs], '{:.2f}')} | {med([x['resub_s']['p99'] for x in xs], '{:.2f}')} | {med([x['resub_s']['all'] for x in xs], '{:.2f}')} | "
              f"{med([x['steady']['lat_us']['p99'] for x in xs])} | {med([x['storm']['lat_us']['p99'] for x in xs])} | {med([x['p99_ratio_storm_to_steady'] for x in xs], '{:.1f}')} | {med([x['after']['lat_us']['p99'] for x in xs])} | "
              f"{med([x['storm']['server_cores_first_10s'] for x in xs], '{:.2f}')} | {med([x['storm']['bytes_out'] / 1e6 for x in xs], '{:.1f}')} | {med([x['storm']['full_handshakes'] for x in xs])} | {med([x['storm']['resumed'] for x in xs])} | "
              f"{med([x['storm']['replayed_msgs'] for x in xs])} | {med([x['storm']['shortfalls'] for x in xs])} | {med([float(x['loadavg'].split()[0]) for x in xs], '{:.1f}')} |")
