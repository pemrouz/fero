#!/usr/bin/env python3
"""E-53 tables: the hand-back's pace (results/handback.jsonl), its cost to writes (results/load.jsonl), and the
settle check (results/settle.jsonl). Medians of the runs, with the range in brackets. Usage: summarize.py <results>"""
import json, os, sys
from statistics import median

RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'results')

def load(name):
    p = os.path.join(RES, name)
    if not os.path.exists(p): return []
    return [json.loads(l) for l in open(p) if l.strip()]

def fmt(x, d=0):
    if x is None: return '-'
    if isinstance(x, float) and d == 0 and abs(x) < 10 and x != int(x): d = 1
    return f'{x:,.{d}f}'

def mr(xs, d=0, scale=1.0):
    xs = [x * scale for x in xs if x is not None]
    if not xs: return '-'
    m = median(xs)
    if len(xs) == 1 or min(xs) == max(xs): return fmt(m, d)
    return f'{fmt(m, d)} ({fmt(min(xs), d)}-{fmt(max(xs), d)})'

def group(rows, key):
    out = {}
    for r in rows:
        if r.get('failed'): continue
        out.setdefault(key(r), []).append(r)
    return out

PACES = ['rate:10', 'cap:8', 'cap:32', 'cap:128']
def pace_key(p): return PACES.index(p) if p in PACES else 99

def pace_tables(rows, title):
    print(f'## {title}\n')
    g = group(rows, lambda r: (r['scenario'], r['R'], r['pace'], r['order'], r.get('settle_s', 10)))
    for scen in ['restart', 'cold']:
        keys = sorted([k for k in g if k[0] == scen], key=lambda k: (k[1], pace_key(k[2])))
        if not keys: continue
        print(f'### {scen}\n')
        if scen == 'restart':
            print('| R | pace | runs | off preferred at start | hand-back until every group is on its preferred member, s | until 99% are, s | transfers a second | one transfer, ms: p50 / p99 / max | failed (retried) | timer elections | CPU-s, the taker / each other | the taker\'s busiest second, cores | failover, s | restart until it knows every leader, s |')
            print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        else:
            print('| R | pace | runs | off preferred at start | hand-back until every group is on its preferred member, s | until 99% are, s | transfers a second | one transfer, ms: p50 / p99 / max | failed (retried) | timer elections | CPU-s per process | busiest second, cores | boot, s |')
            print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        for k in keys:
            rs = g[k]; R = k[1]; pl = k[2] + (f', settle {k[4]} s' if k[4] != 10 else '')
            even = [(r['even_ms'] if r.get('even_ms') is not None else r.get('even_est_ms')) for r in rs]
            est = any(r.get('stopped') for r in rs)
            ev = mr(even, 1, 0.001) + (' (computed: stopped after %d s)' % rs[0]['max_s'] if est else '')
            t99 = mr([r.get('t99_ms') for r in rs], 1, 0.001) if not est else '-'
            xf = ' / '.join(mr([r['xfer_ms'].get(q) for r in rs if r.get('xfer_ms')], 1) for q in ['p50', 'p99', 'max'])
            fails = mr([r.get('fails', 0) for r in rs]) + (' (%s late)' % mr([r.get('ok_late', 0) for r in rs]) if any(r.get('ok_late') for r in rs) else '')
            te = mr([r.get('timer_elections') for r in rs])
            if scen == 'restart':
                cpu_t = mr([r['cpu'][1]['cpu_s'] for r in rs], 2); cpu_o = mr([max(r['cpu'][0]['cpu_s'], r['cpu'][2]['cpu_s']) for r in rs], 2)
                peak = mr([r['cpu'][1]['peak_1s'] for r in rs], 2)
                print(f"| {R:,} | {pl} | {len(rs)} | {mr([r['off_pref'] for r in rs])} | {ev} | {t99} | {mr([r.get('per_s') for r in rs])} | {xf} | {fails} | {te} | {cpu_t} / {cpu_o} | {peak} | {mr([r.get('failover_ms') for r in rs], 1, 0.001)} | {mr([r.get('restart_ready_ms') for r in rs], 1, 0.001)} |")
            else:
                cpu = mr([max(c['cpu_s'] for c in r['cpu']) for r in rs], 2); peak = mr([max(c['peak_1s'] or 0 for c in r['cpu']) for r in rs], 2)
                print(f"| {R:,} | {pl} | {len(rs)} | {mr([r['off_pref'] for r in rs])} | {ev} | {t99} | {mr([r.get('per_s') for r in rs])} | {xf} | {fails} | {te} | {cpu} | {peak} | {mr([r.get('boot_ms') for r in rs], 1, 0.001)} |")
        print()

def load_tables(rows):
    if not rows: return
    print('## The cost to writes (300 loaded groups, 10 writes a second each)\n')
    print('Latency is the committed answer at the client minus the write\'s planned time, in ms. "Before": the last 8 s before the hand-back. "During": writes planned while it ran. "Caught": writes on a group planned from 50 ms before its own transfer began to 200 ms after it ended. "Others": writes during it on groups not in a transfer then. "After": 1-6 s after it ended. For pace none (no hand-back), "during" is a 10 s window at the same point.\n')
    g = group(rows, lambda r: (r['scenario'], r['R'], r['pace'], r['order']))
    order = {('none', 'random'): 0}
    def k2(k): return (k[1], {'none': 0, 'rate:10': 9}.get(k[2], 1 + pace_key(k[2])), 0 if k[3] == 'random' else 1)
    for scen in ['restart', 'cold']:
        keys = sorted([k for k in g if k[0] == scen], key=k2)
        if not keys: continue
        print(f'### {scen}\n')
        print('| R | pace, order | runs | before: p50 / p99 / max | during: p50 / p99 / max | caught: n, p50 / p99 / max | others during: p99 / max | after: p99 | caught writes sent again | loaded groups moved; all on their preferred member after, s | hand-back, s | failed | timer elections |')
        print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        for k in keys:
            rs = g[k]
            L = lambda cls, q: mr([r['lat'][cls].get(q) for r in rs if r.get('lat') and r['lat'][cls].get('n')], 1)
            ev = [(r['even_ms'] if r.get('even_ms') is not None else r.get('even_est_ms')) for r in rs] if k[2] != 'none' else []
            est = any(r.get('stopped') for r in rs)
            hbs = (mr(ev, 1, 0.001) + (' (computed)' if est else '')) if ev else '-'
            caught_n = mr([r['lat']['caught']['n'] for r in rs if r.get('lat')])
            print(f"| {k[1]:,} | {k[2]}, {k[3]} | {len(rs)} | {L('before','p50')} / {L('before','p99')} / {L('before','max')} | {L('during','p50')} / {L('during','p99')} / {L('during','max')} | {caught_n}: {L('caught','p50')} / {L('caught','p99')} / {L('caught','max')} | {L('during_other','p99')} / {L('during_other','max')} | {L('after','p99')} | {mr([r['lat_retried']['caught'] for r in rs if r.get('lat_retried')])} | {mr([r.get('loaded_moved') for r in rs])}; {mr([r.get('loaded_even_ms') for r in rs], 2, 0.001) if k[2] != 'none' else '-'} | {hbs} | {mr([r.get('fails', 0) for r in rs])} | {mr([r.get('timer_elections') for r in rs])} |")
        print()

def extra_tables(rows, hb):
    """The cost to writes as extra over the pooled 'before' base, then the median over runs; beside it the time to
    even out without load (handback.jsonl), so a cap can be picked on both."""
    if not rows: return
    print('## The cost to writes, as extra latency over the steady state before the hand-back (results/load.jsonl)\n')
    print('Per run: the class\'s p50 / p99 minus the base, in ms (the max is shown as it is: a few hundred caught writes and 24,000 "before" writes do not compare at the max); then the median over runs, range in brackets. The base is the median "before" p50 / p99 / max over every run of the same scenario and R (all paces): one run\'s own "before" window can hold a collector pause or the boot\'s tail (one cold run at 10,000 had a "before" p99 of 330 ms). The control row (pace none) shows the box\'s own noise: its "others during" is a 10 s window at the same point with no hand-back. "Caught" is F-05\'s case (a write that meets its own group\'s transfer). "Others" are writes during the hand-back on groups not in a transfer then: the cost of the members\' busy thread. "Moved by" is when the last loaded group was handed back, from the hand-back\'s start. "Even, no load" is the median time to even out from handback.jsonl (random order), for the same scenario, R and pace.\n')
    g = group(rows, lambda r: (r['scenario'], r['R'], r['pace'], r['order']))
    gh = group(hb, lambda r: (r['scenario'], r['R'], r['pace']))
    gb = group([r for r in rows if r.get('lat') and r['lat']['before'].get('n')], lambda r: (r['scenario'], r['R']))
    base = {k: {q: median([r['lat']['before'][q] for r in rs]) for q in ('p50', 'p99', 'max')} for k, rs in gb.items()}
    print('Bases (median "before" over all runs, ms, p50 / p99 / max): ' + '; '.join(f"{k[0]} {k[1]:,}: {base[k]['p50']:.1f} / {base[k]['p99']:.1f} / {base[k]['max']:.1f}" for k in sorted(base)) + '\n')
    def k2(k): return (k[1], {'none': 0, 'rate:10': 9}.get(k[2], 1 + pace_key(k[2])), 0 if k[3] == 'random' else 1)
    for scen in ['restart', 'cold']:
        keys = sorted([k for k in g if k[0] == scen], key=k2)
        if not keys: continue
        print(f'### {scen}\n')
        print('| R | pace, order | runs | caught writes | caught: extra p50 / extra p99 / max | others during: extra p99 / max | others during: extra p99 over the control\'s | loaded groups moved by, s | caught writes sent again (moved) | even with load, s | even, no load, s |')
        print('|---|---|---|---|---|---|---|---|---|---|---|')
        ctl = {k[1]: median([r['lat']['during_other']['p99'] - base[(k[0], k[1])]['p99'] for r in g[k] if r.get('lat') and r['lat']['during_other'].get('n')]) for k in keys if k[2] == 'none'}
        for k in keys:
            rs = [r for r in g[k] if r.get('lat') and r['lat']['before'].get('n')]
            b = base[(k[0], k[1])]
            def ex(cls, q): return mr([r['lat'][cls][q] - b[q] for r in rs if r['lat'][cls].get('n')], 1)
            est = any(r.get('stopped') for r in rs)
            ev = [(r['even_ms'] if r.get('even_ms') is not None else r.get('even_est_ms')) for r in rs] if k[2] != 'none' else []
            hbr = gh.get((k[0], k[1], k[2]), [])
            ev0 = [(r['even_ms'] if r.get('even_ms') is not None else r.get('even_est_ms')) for r in hbr]
            moved_by = mr([r.get('loaded_even_ms') for r in rs], 2, 0.001) if k[2] != 'none' else '-'
            oc = mr([r['lat']['during_other']['p99'] - b['p99'] - ctl[k[1]] for r in rs if r['lat']['during_other'].get('n')], 1) if k[2] != 'none' and k[1] in ctl else '-'
            print(f"| {k[1]:,} | {k[2]}, {k[3]} | {len(rs)} | {mr([r['lat']['caught']['n'] for r in rs])} | {ex('caught','p50')} / {ex('caught','p99')} / {mr([r['lat']['caught']['max'] for r in rs if r['lat']['caught'].get('n')], 1)} | {ex('during_other','p99')} / {mr([r['lat']['during_other']['max'] for r in rs if r['lat']['during_other'].get('n')], 1)} | {oc} | {moved_by} | {mr([r['lat_retried']['caught'] for r in rs])} | {(mr(ev, 1, 0.001) + (' (computed)' if est else '')) if ev else '-'} | {mr(ev0, 1, 0.001) if ev0 else '-'} |")
        print()
    # were any writes lost, timed out, made to wait, or moved?
    print('### Every write accounted for\n')
    print('Summed over all runs of each configuration. Sent counts every send, resends included; "answered" are writes committed and answered; "left" were not answered within 3 s of the stop; "timed out" were not answered in 3 s and sent to the next member; "waited" reached their leader during a transfer and waited for it (host side); "moved" got a `moved` answer and were sent again (host side, every member).\n')
    print('| scenario | R | pace, order | runs | writes answered | left unanswered | timed out | waited at the leader | moved answers |')
    print('|---|---|---|---|---|---|---|---|---|')
    for k in sorted(g, key=lambda k: (0 if k[0] == 'restart' else 1,) + k2(k)):
        rs = [r for r in g[k] if r.get('client')]
        s = lambda f: sum(f(r) for r in rs)
        print(f"| {k[0]} | {k[1]:,} | {k[2]}, {k[3]} | {len(rs)} | {s(lambda r: r['client']['n']):,} | {s(lambda r: r['client']['left'])} | {s(lambda r: r['client']['timeouts'])} | {s(lambda r: r.get('client_waited', 0))} | {s(lambda r: r.get('client_moved', 0))} |")
    print()

RESUMED_AT = 56   # load.jsonl: the first 56 lines were written before the machine restart of 2026-11-14 (README)
def resume_check(rows):
    if len(rows) <= RESUMED_AT: return
    pre, post = rows[:RESUMED_AT], rows[RESUMED_AT:]
    print('## Runs before and after the machine restart (results/load.jsonl lines 1-56 against the rest)\n')
    print('Each configuration that has runs on both sides: medians of the hand-back time, the "before" window\'s p50 and p99, and the caught writes\' p99, in ms.\n')
    print('| configuration | runs before / after | hand-back, s: before / after | "before" p50: before / after | "before" p99: before / after | caught p99: before / after |')
    print('|---|---|---|---|---|---|')
    key = lambda r: r['tag']
    gp, gq = group(pre, key), group(post, key)
    for k in sorted(set(gp) & set(gq)):
        a, b = gp[k], gq[k]
        ev = lambda rs: mr([(r['even_ms'] if r.get('even_ms') is not None else r.get('even_est_ms')) for r in rs if r['pace'] != 'none'], 1, 0.001)
        q = lambda rs, c, p: mr([r['lat'][c].get(p) for r in rs if r.get('lat') and r['lat'][c].get('n')], 1)
        print(f"| {k} | {len(a)} / {len(b)} | {ev(a)} / {ev(b)} | {q(a,'before','p50')} / {q(b,'before','p50')} | {q(a,'before','p99')} / {q(b,'before','p99')} | {q(a,'caught','p99')} / {q(b,'caught','p99')} |")
    print()

def all_lines(rows, name):
    if not rows: return
    print(f'## Every run ({name})\n')
    print('| tag | run | load avg (1 min) | off | even or computed, ms | t99, ms | moved | fails | timer elections | term bumps / 3 | CPU-s per process |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        if r.get('failed'): print(f"| {r['tag']} | {r['run']} | {r['loadavg'].split()[0]} | FAILED: {r['failed'][:80]} | | | | | | | |"); continue
        e = r.get('even_ms') if r.get('even_ms') is not None else r.get('even_est_ms')
        print(f"| {r['tag']} | {r['run']} | {r['loadavg'].split()[0]} | {r['off_pref']} | {fmt(e, 0) if e is not None else '-'} | {fmt(r.get('t99_ms'), 0) if r.get('t99_ms') is not None else '-'} | {r.get('moved', '-')} | {r.get('fails', '-')} | {r.get('timer_elections')} | {round(r.get('term_bumps', 0) / 3)} | {' / '.join(str(c['cpu_s']) for c in r['cpu'])} |")
    print()

def restart_tables(rows):
    rs = [r for r in rows if not r.get('failed')]
    if not rs: return
    print('## The restart itself and the cold boot (pooled over every run of every pace, results/handback.jsonl and load.jsonl)\n')
    print('| R | restart runs | failover: kill -9 until every group has a leader, s | elections begun by a timer per failed-over group | elections that ran per failed-over group | restart from the journal until it knows every leader, s | collided balanced starts (setup) | cold boots | cold boot, s | off preferred after it |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for R in sorted({r['R'] for r in rs}):
        a = [r for r in rs if r['R'] == R and r['scenario'] == 'restart' and r.get('failover_ms') is not None]
        c = [r for r in rs if r['R'] == R and r['scenario'] == 'cold']
        n = R / 3
        print(f"| {R:,} | {len(a)} | {mr([r['failover_ms'] for r in a], 1, 0.001)} | {mr([r['failover_elections']['pre'] / n for r in a], 2)} | {mr([r['failover_elections']['cand'] / n for r in a], 2)} | {mr([r['restart_ready_ms'] for r in a], 1, 0.001)} | {sum(1 for r in a if r.get('setup_balance'))} | {len(c)} | {mr([r['boot_ms'] for r in c], 1, 0.001)} | {mr([r['off_pref'] / R * 100 for r in c], 0)}% |")
    print()

def cap_of(r): return r.get('cap') or int(r['pace'].split(':')[1])
def liveness_table(rows):
    if not rows: return
    print('## A giver dies in the middle of the hand-back (results/liveness.jsonl; not a timing)\n')
    print('Cold boot; member 3 killed 50 ms (R = 1,000) or 200 ms (R = 10,000) after the hand-back starts. Members 1 and 2 should still take back every group they are preferred for. Waited 40 s. Cap 32 ran first; cap 8 was added after the skeptic\'s check. "All slots stuck" counts members whose every slot was held by a transfer that could never finish, so their hand-back stopped.\n')
    print('| cap | R | the cap\'s timeout | runs | runs where members 1 and 2 took back all of theirs | their hand-back, s | failed and retried transfers per member | groups never taken back per member | slots left stuck per member | members with all slots stuck |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    g = group(rows, lambda r: (cap_of(r), r['R'], r.get('timeout_ms')))
    for k in sorted(g, key=lambda k: (-k[0], k[1], k[2])):
        rs = g[k]; lv = [x for r in rs for x in r['live']]
        print(f"| {k[0]} | {k[1]:,} | {'3 s' if k[2] == 3000 else 'none'} | {len(rs)} | {sum(1 for r in rs if all(x['finished'] for x in r['live']))} | {mr([x['ms'] for x in lv if x['ms'] is not None], 1, 0.001)} | {mr([x['fails'] for x in lv])} | {mr([x['pref'] - x['pref_led'] for x in lv])} | {mr([x['in_flight_left'] for x in lv])} | {sum(1 for x in lv if x['in_flight_left'] >= k[0])} of {len(lv)} |")
    print()
    print('Per run (cap 8 without the timeout): slots stuck and groups never taken back, member 1 / member 2.\n')
    for k in sorted(g):
        if k[0] != 8 or k[2] == 3000: continue
        print(f"- R = {k[1]:,}: " + '; '.join(f"run {r['run']}: {r['live'][0]['in_flight_left']} / {r['live'][1]['in_flight_left']} stuck, {r['live'][0]['pref'] - r['live'][0]['pref_led']} / {r['live'][1]['pref'] - r['live'][1]['pref_led']} never" for r in g[k]))
    print()

def xfer_table(rows):
    rows = [r for r in rows if r.get('xfer')]
    if not rows: return
    print('## The givers\' side: transfers to the dead member still set (results/xfer.jsonl and the cap-8 rows of liveness.jsonl; not a timing)\n')
    print('The same kill as above. In this harness each member asks its own transfers, so member 3 was also a taker: the groups members 1 and 2 led and were handing to it keep Raft\'s transfer set (leadTransferee) after it died. Read about 30 s after the kill (40 s where the hand-back never ended), summed over members 1 and 2: the groups still set, how many of them are quiet, and how many are still set 3 s after one write reached each of them (host patch 17). "As designed" is DESIGN-V5 4.2\'s quiet rule; "no quiet in a transfer" is host patch 18.\n')
    print('| cap | R | the cap\'s timeout | quiet rule | runs | read at, s after the kill | still set, both members: per run | of them quiet | still set 3 s after a write |')
    print('|---|---|---|---|---|---|---|---|---|')
    g = group(rows, lambda r: (cap_of(r), r['R'], r.get('timeout_ms'), bool(r.get('xferawake'))))
    for k in sorted(g, key=lambda k: (-k[0], k[3], k[1], k[2])):
        rs = g[k]
        per = lambda f: ', '.join(str(sum(f(x) for x in r['xfer'])) for r in rs)
        print(f"| {k[0]} | {k[1]:,} | {'3 s' if k[2] == 3000 else 'none'} | {'no quiet in a transfer' if k[3] else 'as designed'} | {len(rs)} | {mr([r['probe_s'] for r in rs], 0)} | {per(lambda x: x['set'])} | {per(lambda x: x['quiet'])} | {per(lambda x: x['set_3s_after_a_write'])} |")
    print()

def recheck_tables(rows):
    rows = [r for r in rows if r.get('lat') and r['lat'].get('met')]
    if not rows: return
    print('## F-05 again, after the skeptic\'s check (results/recheck.jsonl)\n')
    print('Busiest first, 300 loaded groups, more runs per cell (10; 5 at 100,000, with `settle` 20 s so the control fits before the hand-back). The base is the median "before" p50 / p99 over these runs of the same scenario and R. Readings of F-05 ("a planned handover pauses writes <= 10 ms"), in ms, median over runs (range), and in how many runs the reading is <= 10 ms: (a) the caught writes\' p99 minus the base p99 (the first version\'s reading); (b) the caught writes\' p99 minus the base p50; (c) the caught writes\' maximum, raw; (d) the caught writes\' p99 minus the p99 of the same run\'s like-for-like control (the median over its shifted windows). "Met" are the writes that met their own group\'s transfer: answered `moved`, or waited at the leader (host patch 16). "Control" is the like-for-like control: the same loaded groups\' caught windows shifted back into the steady state before the hand-back (same writes, same packing, no transfer); its p99 minus the base p99, over every shifted window of every run.\n')
    g = group(rows, lambda r: (r['scenario'], r['R'], r['pace']))
    print('| scenario | R | cap | runs | base p50 / p99 | hand-back, s | caught n | (a) caught p99 - base p99 | runs <= 10 | (b) caught p99 - base p50 | runs <= 10 | (c) caught max | runs <= 10 | (d) caught p99 - its own control\'s p99 | runs <= 10 | control: p99 - base p99, every window | control windows over +10 | control windows whose longest wait is over 10 ms |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    def ok(xs): return f"{sum(1 for x in xs if x <= 10)} of {len(xs)}"
    for k in sorted(g, key=lambda k: (0 if k[0] == 'restart' else 1, k[1], -cap_of(g[k][0]))):
        rs = g[k]; b50 = median([r['lat']['before']['p50'] for r in rs]); b99 = median([r['lat']['before']['p99'] for r in rs])
        a = [r['lat']['caught']['p99'] - b99 for r in rs]; bb = [r['lat']['caught']['p99'] - b50 for r in rs]; c = [r['lat']['caught']['max'] for r in rs]
        pl = [x['p99'] - b99 for r in rs for x in (r.get('placebo') or {}).get('lat', []) if x.get('n')]
        ev = [r.get('even_ms') for r in rs]
        d = [r['lat']['caught']['p99'] - median([x['p99'] for x in r['placebo']['lat'] if x.get('n')]) for r in rs if (r.get('placebo') or {}).get('lat')]
        print(f"| {k[0]} | {k[1]:,} | {cap_of(rs[0])} | {len(rs)} | {b50:.1f} / {b99:.1f} | {mr(ev, 1, 0.001)} | {mr([r['lat']['caught']['n'] for r in rs])} | {mr(a, 1)} | {ok(a)} | {mr(bb, 1)} | {ok(bb)} | {mr(c, 1)} | {ok(c)} | {mr(d, 1)} | {ok(d)} | {mr(pl, 1)} | {sum(1 for x in pl if x > 10)} of {len(pl)} | {sum(1 for r in rs for x in (r.get('placebo') or {}).get('lat', []) if x.get('n') and x['max'] > 10)} of {len(pl)} |")
    print()
    print('The writes that met a transfer, and the caught writes that did not: n per run, then p99 minus the base p50, p99 minus the base p99, and the maximum, raw. "Waited" counts the met writes that waited at their leader (the rest were answered `moved`).\n')
    print('| scenario | R | cap | met: n | waited | met: p99 - base p50 | runs <= 10 | met: p99 - base p99 | met: max | runs <= 10 | caught, not met: n | its p99 - base p99 | its max |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for k in sorted(g, key=lambda k: (0 if k[0] == 'restart' else 1, k[1], -cap_of(g[k][0]))):
        rs = g[k]; b50 = median([r['lat']['before']['p50'] for r in rs]); b99 = median([r['lat']['before']['p99'] for r in rs])
        m50 = [r['lat']['met']['p99'] - b50 for r in rs]; mmax = [r['lat']['met']['max'] for r in rs]
        print(f"| {k[0]} | {k[1]:,} | {cap_of(rs[0])} | {mr([r['lat']['met']['n'] for r in rs])} | {mr([r.get('met_waited', 0) for r in rs])} | {mr(m50, 1)} | {sum(1 for x in m50 if x <= 10)} of {len(rs)} | {mr([r['lat']['met']['p99'] - b99 for r in rs], 1)} | {mr(mmax, 1)} | {sum(1 for x in mmax if x <= 10)} of {len(rs)} | {mr([r['lat']['caught_nomet']['n'] for r in rs])} | {mr([r['lat']['caught_nomet']['p99'] - b99 for r in rs if r['lat']['caught_nomet'].get('n')], 1)} | {mr([r['lat']['caught_nomet']['max'] for r in rs if r['lat']['caught_nomet'].get('n')], 1)} |")
    print()
    print('Per run: caught p99 minus the base p99, and the worst one-second p99 of all writes from 2 s before the hand-back to 3 s after it ended (a whole-box stall shows there), ms.\n')
    for k in sorted(g, key=lambda k: (0 if k[0] == 'restart' else 1, k[1], -cap_of(g[k][0]))):
        rs = g[k]; b99 = median([r['lat']['before']['p99'] for r in rs])
        def worst(r):
            hb_s = (r.get('even_ms') or 0) / 1000
            xs = [x[2] for x in r.get('series', []) if -2 <= x[0] <= hb_s + 3 and x[2] is not None]
            return max(xs) if xs else None
        print(f"- {k[0]}, {k[1]:,}, cap {cap_of(rs[0])}: " + '; '.join(f"{r['lat']['caught']['p99'] - b99:+.1f} ({worst(r)})" for r in rs))
    print()

hb = load('handback.jsonl'); ld = load('load.jsonl'); st = load('settle.jsonl'); lv = load('liveness.jsonl')
print('# E-53 tables (generated by summarize.py)\n')
pace_tables(hb, 'The hand-back without load (results/handback.jsonl)')
load_tables(ld)
extra_tables(ld, hb)
resume_check(ld)
restart_tables(hb + ld)
liveness_table([r for r in lv if not r.get('failed')])
xfer_table([r for r in lv + load('xfer.jsonl') if not r.get('failed')])
recheck_tables([r for r in load('recheck.jsonl') if not r.get('failed')])
if st:
    base = [r for r in hb if r['R'] == 100000]
    pace_tables(st + [r for r in base if r['pace'] in {s['pace'] for s in st}], 'settle.ms 30 s against the harness\'s 10 s, R = 100,000 (results/settle.jsonl; the 10 s rows repeated from handback.jsonl)')
all_lines(hb, 'handback.jsonl'); all_lines(ld, 'load.jsonl'); all_lines(st, 'settle.jsonl')
fails = [r for r in lv if r.get('failed')]
if fails:
    print('## Liveness runs that crashed before the self-connect fix (patch 14), run again\n')
    for r in fails: print(f"- {r['tag']} run {r['run']}: {r['failed'].splitlines()[-1][:120] if r['failed'] else ''}")
    print()
