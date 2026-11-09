"""E-18: the tables. Reads the raw JSON lines and writes results/summary.md and
trimmed CSV files. Usage: python3 report.py <raw dir> <results dir>"""
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

RAW, OUT = sys.argv[1], sys.argv[2]
SS = [256, 1024, 4096, 16384]
DISTS = ['uniform', 'zipf-0.8', 'zipf-0.99', 'zipf-1.2', 'pareto-1.16', 'pareto-2', 'hot-0.01', 'hot-0.1']
lines = []


def load(pattern):
    rows = []
    for p in sorted(glob.glob(os.path.join(RAW, pattern))):
        with open(p) as f:
            rows += [json.loads(l) for l in f if l.strip()]
    return pd.DataFrame(rows)


def fmt(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return '-'
    if isinstance(v, (float, np.floating)):
        if abs(v) >= 100:
            return f'{v:.0f}'
        if abs(v) >= 10:
            return f'{v:.1f}'
        return f'{v:.3f}' if abs(v) < 2 else f'{v:.2f}'
    return str(v)


def md(df, index=True):
    cols = ([df.index.name or ''] if index else []) + [str(c) for c in df.columns]
    out = ['| ' + ' | '.join(cols) + ' |', '|' + '---|' * len(cols)]
    for idx, row in df.iterrows():
        cells = ([str(idx)] if index else []) + [fmt(v) for v in row.tolist()]
        out.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(out)


def say(*a):
    lines.append(' '.join(str(x) for x in a))


# ------------------------------------------------------------- part A --
st = load('static-*.jsonl')
if len(st):
    part = st[st.get('kind') == 'part'][['dist', 'N', 'seed', 'pmax', 'G_part']]
    slot = st[st.get('kind') == 'slot'][['dist', 'N', 'seed', 'S', 'smax', 'G_slot', 'empty']]
    pl = st[st['kind'].isna()].drop(columns=['kind', 'pmax', 'G_part', 'smax', 'G_slot', 'empty'], errors='ignore')
    pl = pl.merge(part[['dist', 'N', 'seed', 'pmax']], on=['dist', 'N', 'seed'])
    pl['exempt'] = pl['pmax'] * pl['G'] > 1 + 1e-12
    agg = pl.groupby(['dist', 'N', 'S', 'place', 'G']).agg(
        r_med=('r', 'median'), r_max=('r', 'max'), rlb_max=('rlb', 'max'),
        exempt=('exempt', 'max'), seeds=('r', 'size')).reset_index()
    agg.to_csv(os.path.join(OUT, 'static-agg.csv.gz'), index=False, float_format='%.5g', compression='gzip')
    capped_static = int((pl['reached'] == -1).sum()) if 'reached' in pl else 0

    say('## Part A: max/mean on a grid of groups\n')
    say(f'Controller runs that hit the move cap: {capped_static}.',
        'Every value is the largest group load over the mean (1.000 is perfect). "worst" is the worst seed;',
        'seeds: 10 at N = 1e4 and 1e5, 5 at 1e6, 3 at 1e7. Full table: `static-agg.csv.gz`.\n')

    # A1: the threshold check
    say('### A1. The threshold: does each slot count keep max/mean <= 1.25 up to 64 groups?\n')
    say('A point is exempt when the hottest partition alone carries more than 1/G of the load (a ceiling for any',
        'design). "strict" is the worst max/mean over every non-exempt point with G <= 64 (all N, all seeds);',
        '"vs ideal" is the worst max over the key-level floor max(mean, hottest partition) over every point',
        'with G <= 64, exempt or not. "first fail" is the smallest G on the grid where some non-exempt point',
        'is above 1.25 (grid up to 256; ">256": none).\n')
    for place in ('lpt', 'inc', 'ranges-best', 'ranges-equal', 'halving'):
        rows = []
        for d in DISTS:
            row = {}
            for S in SS:
                x = pl[(pl.dist == d) & (pl.S == S) & (pl.place == place)]
                le = x[x.G <= 64]
                ne = le[~le.exempt]
                row[f'{S} strict'] = ne.r.max() if len(ne) else np.nan
                row[f'{S} vs ideal'] = le.rlb.max()
                bad = x[(~x.exempt) & (x.r > 1.25 + 1e-12)]
                row[f'{S} first fail'] = str(int(bad.G.min())) if len(bad) else '>256'
            if pl[(pl.dist == d) & (pl.place == place)].empty:
                continue
            rows.append(pd.Series(row, name=d))
        say(f'**{place}**\n')
        say(md(pd.DataFrame(rows).rename_axis('distribution')))
        say('')

    # A2: placements side by side at S = 1,024
    say('### A2. Placements side by side (S = 1,024 for the slot rows), worst seed over every N\n')
    for G in (16, 64, 256):
        rows = []
        for d in DISTS:
            row = {}
            for place in ('fixN', 'ranges-equal', 'ranges-best', 'halving', 'lpt', 'inc', 'key-contig', 'key-lpt', 'key-lb'):
                S = 0 if place.startswith('key') or place == 'fixN' else 1024
                x = agg[(agg.dist == d) & (agg.S == S) & (agg.place == place) & (agg.G == G)]
                row[place] = x.r_max.max() if len(x) else np.nan
            if agg[agg.dist == d].empty:
                continue
            rows.append(pd.Series(row, name=d))
        say(f'**G = {G}**\n')
        say(md(pd.DataFrame(rows).rename_axis('distribution')))
        say('')

    # A3: slot counts side by side, lpt and inc, by N
    say('### A3. Slot counts side by side: greedy packing (lpt) and the controller (inc), worst seed\n')
    for G in (64, 128, 256):
        rows = []
        for d in DISTS:
            for N in sorted(pl.N.unique()):
                if agg[(agg.dist == d) & (agg.N == N)].empty:
                    continue
                row = {}
                for S in SS:
                    for place in ('lpt', 'inc'):
                        x = agg[(agg.dist == d) & (agg.N == N) & (agg.S == S) & (agg.place == place) & (agg.G == G)]
                        row[f'{S} {place}'] = x.r_max.max() if len(x) else np.nan
                kl = agg[(agg.dist == d) & (agg.N == N) & (agg.place == 'key-lb') & (agg.G == G)]
                row['key-lb'] = kl.r_max.max()
                rows.append(pd.Series(row, name=f'{d} N={N:.0e}'))
        say(f'**G = {G}**\n')
        say(md(pd.DataFrame(rows).rename_axis('distribution, N')))
        say('')

    # A4: where one slot alone passes a fair share
    say('### A4. The group count at which one slot alone exceeds a fair share (median over seeds)\n')
    say('G_part: the smallest G at which the hottest partition alone exceeds 1/G (any design).',
        'G_slot: the same for the hottest slot. Empty: slots with no partition (median).\n')
    p = part.groupby(['dist', 'N']).G_part.median()
    s = slot.groupby(['dist', 'N', 'S']).agg(G_slot=('G_slot', 'median'), empty=('empty', 'median')).reset_index()
    rows = []
    for d in DISTS:
        for N in sorted(part.N.unique()):
            if (d, N) not in p.index:
                continue
            row = {'G_part': p.get((d, N), np.nan)}
            for S in SS:
                x = s[(s.dist == d) & (s.N == N) & (s.S == S)]
                row[f'G_slot {S}'] = x.G_slot.iloc[0] if len(x) else np.nan
            for S in (4096, 16384):
                x = s[(s.dist == d) & (s.N == N) & (s.S == S)]
                row[f'empty {S}'] = x['empty'].iloc[0] if len(x) else np.nan
            rows.append(pd.Series(row, name=f'{d} N={N:.0e}'))
    say(md(pd.DataFrame(rows).rename_axis('distribution, N')))
    say('')

    # A5: growth cost
    say('### A5. Cost of growing one group at a time from 1 group (the controller), median over seeds\n')
    say('moves: slot moves in total; rows: rows copied, as a multiple of the resource (1.0 = the whole resource once).\n')
    inc = pl[pl.place == 'inc']
    rows = []
    for d in ('uniform', 'zipf-0.99', 'pareto-1.16'):
        for N in (10**4, 10**6):
            row = {}
            for S in SS:
                for G in (16, 64, 256):
                    x = inc[(inc.dist == d) & (inc.N == N) & (inc.S == S) & (inc.G == G)]
                    if len(x):
                        row[f'{S} G{G} moves'] = x.moves.median()
                        row[f'{S} G{G} rows'] = x.rows_moved.median()
            rows.append(pd.Series(row, name=f'{d} N={N:.0e}'))
    gc = pd.DataFrame(rows).rename_axis('distribution, N')
    for S in SS:
        say(f'**S = {S}**\n')
        say(md(gc[[c for c in gc.columns if c.startswith(f'{S} ')]].rename(columns=lambda c: c.split(' ', 1)[1])))
        say('')

# ------------------------------------------------------------- part B --
ef = load('eff-*.jsonl')
if len(ef):
    key = ef[ef.kind == 'key'][['dist', 'N', 'seed', 'pmax', 'Ekey', 'Wkey']]
    fx = ef[ef.kind == 'fixN'][['dist', 'N', 'seed', 'G', 'r_pure', 'r_split']]
    e = ef[ef.kind == 'eff'].drop(columns=['kind', 'pmax', 'Ekey', 'Wkey', 'G', 'r_pure', 'r_split'], errors='ignore')
    e.to_csv(os.path.join(OUT, 'eff-raw.csv'), index=False, float_format='%.5g')
    capped_eff = int(e['capped'].fillna(0).sum()) if 'capped' in e else 0
    fx.to_csv(os.path.join(OUT, 'fixN-raw.csv'), index=False, float_format='%.5g')
    say('## Part B: effective writers per resource (SC-10), searched to 1,024 groups\n')
    say(f'Controller runs that hit the move cap: {capped_eff}.\n')
    say('E: the largest G with max/mean <= 1.25 at every G\' <= G. E07: the same with SC-03\'s 0.7 x n',
        '(max/mean <= 1.43). Wmax: the most writer-equivalents, max over G of G / (max/mean).',
        '"pure": the distribution as drawn; "split": the app splits each partition above 1/(2G) of the load.',
        'Ekey: the key-level ceiling of any design on pure load (hottest partition <= 1.25/G).',
        'Values: median over seeds (min over seeds in brackets).\n')
    for d in DISTS:
        x = e[e.dist == d]
        if not len(x):
            continue
        rows = []
        for N in sorted(x.N.unique()):
            k = key[(key.dist == d) & (key.N == N)]
            for S in SS:
                row = {'Ekey (pure)': int(k.Ekey.median())}
                for variant in ('pure', 'split'):
                    for place in ('lpt', 'inc'):
                        y = x[(x.N == N) & (x.S == S) & (x.variant == variant) & (x.place == place)]
                        if not len(y):
                            continue
                        row[f'E {variant} {place}'] = f'{int(y.E.median())} ({int(y.E.min())})'
                        if place == 'lpt':
                            row[f'E07 {variant}'] = int(y.E07.median())
                            row[f'Wmax {variant}'] = y.Wmax.median()
                rows.append(pd.Series(row, name=f'N={N:.0e} S={S}'))
        say(f'**{d}**\n')
        say(md(pd.DataFrame(rows).rename_axis('N, slots')))
        say('')
    # the one-line answer per slot count: worst over N and seeds, zipf-0.99
    say('### B1. Effective writers under Zipf 0.99, worst over N (1e4 to 1e7) and seeds\n')
    rows = []
    z = e[e.dist == 'zipf-0.99']
    for S in SS:
        row = {}
        for variant in ('pure', 'split'):
            for place in ('lpt', 'inc'):
                y = z[(z.S == S) & (z.variant == variant) & (z.place == place)]
                row[f'E {variant} {place}'] = int(y.E.min()) if len(y) else np.nan
                row[f'Eany {variant} {place}'] = int(y.Eany.min()) if len(y) else np.nan
        rows.append(pd.Series(row, name=S))
    k = key[key.dist == 'zipf-0.99']
    say(md(pd.DataFrame(rows).rename_axis('slots')))
    if len(k):
        say(f'\nKey-level ceiling on pure Zipf 0.99 (any design): Ekey from {int(k.Ekey.min())} to {int(k.Ekey.max())};',
            f'hottest partition {100 * k.pmax.min():.2f} % to {100 * k.pmax.max():.2f} % of the load.\n')
    say('### B2. fixN: partitions hashed straight onto 16 (CELL) or 64 (LANE) groups\n')
    rows = []
    for d in DISTS:
        for G in (16, 64):
            y = fx[(fx.dist == d) & (fx.G == G)]
            if len(y):
                rows.append(pd.Series({'max/mean pure (median)': y.r_pure.median(), 'pure (worst)': y.r_pure.max(),
                                       'split (median)': y.r_split.median(), 'split (worst)': y.r_split.max(),
                                       'writer-equivalents split (worst)': G / y.r_split.max()},
                                      name=f'{d} G={G}'))
    say(md(pd.DataFrame(rows).rename_axis('distribution, groups')))
    say('')

    ec = load('effc-*.jsonl')
    if len(ec):
        say('### B3. How much the app must split: the split cap c/G, Zipf 0.99\n')
        say('The app splits each partition above c/G of the load. c = 0.5 is the default above; c = 1 splits',
            'only what passes a full fair share; c = 0.25 splits more. E for greedy packing and for the',
            'controller, median (min) over seeds.\n')
        allc = pd.concat([ec[ec.kind == 'eff'], e[(e.dist == 'zipf-0.99') & e.N.isin(ec.N.unique())]])
        rows = []
        for N in sorted(allc.N.unique()):
            for S in SS:
                row = {}
                for c in sorted(allc.c.unique()):
                    for place in ('lpt', 'inc'):
                        y = allc[(allc.N == N) & (allc.S == S) & (allc.c == c) & (allc.variant == 'split') & (allc.place == place)]
                        if len(y):
                            row[f'c={c} {place}'] = f'{int(y.E.median())} ({int(y.E.min())})'
                rows.append(pd.Series(row, name=f'N={N:.0e} S={S}'))
        say(md(pd.DataFrame(rows).rename_axis('N, slots')))
        say('')

# ------------------------------------------------------------- part C --
dy = load('dyn-*.jsonl')
if len(dy):
    dy.to_csv(os.path.join(OUT, 'dyn-raw.csv.gz'), index=False, float_format='%.5g', compression='gzip')
    say('## Part C: moves after a load shift (the controller, trigger 1.25, target 1.10)\n')
    say(f'Controller runs that hit the move cap: {int((dy.reached == -1).sum())}.\n')
    say('Per epoch: moves = slots moved; rows % = rows copied, as a share of the resource; before = busiest',
        'group over the floor right after the shift; after = the same once the controller stopped; repack % =',
        'rows a fresh greedy packing would move; key rows % = rows a per-partition controller moves',
        '(N = 1e4 only). Means over epochs and seeds; max in brackets.\n')
    rows = []
    for scen in dy.scen.unique():
        for N in sorted(dy.N.unique()):
            for S in SS:
                for G in sorted(dy.G.unique()):
                    x = dy[(dy.scen == scen) & (dy.N == N) & (dy.S == S) & (dy.G == G)]
                    if not len(x):
                        continue
                    row = {'acted %': 100 * x.acted.mean(),
                           'moves': f'{x.moves.mean():.1f} ({x.moves.max()})',
                           'rows %': f'{100 * x.rows.mean():.2f} ({100 * x.rows.max():.2f})',
                           'before': f'{x.r_before.mean():.2f} ({x.r_before.max():.2f})',
                           'after max': x.r_after.max(),
                           'reached %': 100 * (x.reached == 1).mean()}
                    if 'forced_moves' in x and x.forced_moves.notna().any():
                        row['moves'] = f'{x.forced_moves.mean():.0f} forced + {x.moves.mean():.1f}'
                        row['rows %'] = f'{100 * x.forced_rows.mean():.2f} forced + {100 * x.rows.mean():.2f}'
                    if 'repack_rows' in x and x.repack_rows.notna().any():
                        row['repack %'] = 100 * x.repack_rows.mean()
                    if 'key_rows' in x and x.key_rows.notna().any():
                        row['key rows %'] = f'{100 * x.key_rows.mean():.2f} ({100 * x.key_rows.max():.2f})'
                    rows.append(pd.Series(row, name=f'{scen} N={N:.0e} S={S} G={G}'))
    say(md(pd.DataFrame(rows).rename_axis('scenario, N, slots, groups')))
    say('')

# ------------------------------------------------------------- part D --
hc = load('hash.jsonl')
if len(hc):
    hc.to_csv(os.path.join(OUT, 'hash.csv'), index=False, float_format='%.5g')
    say('## Part D: real hashes of key names against the random stand-in\n')
    say('Keys `room0`, `room1`, ...; slot = hash mod S. "random" is the stand-in used everywhere else',
        '(5 seeds: median, with min to max). chi2/dof is about 1 for a fair hash.\n')
    rows = []
    cols = ['rows_max_over_mean', 'chi2_per_dof', 'uniform_G64', 'uniform_G256', 'zipf-0.99_G64', 'zipf-0.99_G256']
    for N in sorted(hc.N.unique()):
        for S in sorted(hc.S.unique()):
            for hname in hc.hash.unique():
                x = hc[(hc.N == N) & (hc.S == S) & (hc.hash == hname)]
                if hname == 'random':
                    row = {c: f'{x[c].median():.3f} ({x[c].min():.3f}-{x[c].max():.3f})' for c in cols}
                else:
                    row = {c: f'{x[c].iloc[0]:.3f}' for c in cols}
                rows.append(pd.Series(row, name=f'N={N:.0e} S={S} {hname}'))
    say(md(pd.DataFrame(rows).rename_axis('N, slots, hash')))
    say('')

# ------------------------------------------------------------- part E --
tl = load('tail-*.jsonl')
if len(tl):
    def wilson(k, n, z=1.96):
        if n == 0:
            return (np.nan, np.nan)
        p = k / n
        d = 1 + z * z / n
        c = (p + z * z / (2 * n)) / d
        m = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
        return (max(0.0, c - m), min(1.0, c + m))
    say('## Part E: how often the slots alone miss the bar at G <= 64\n')
    say('A draw is a slot failure when at some G <= 64 greedy packing of the slots gives max/mean > 1.25',
        'while the hottest partition alone carries at most 1/G (so Q-18 does not excuse it). "split": the app',
        'split every partition above 0.5/G first (nothing is excused). Rate in %, with a 95 % Wilson interval;',
        'first G: the median smallest failing G among failing draws. Seeds 100 and up (parts A and B used 0 to 9).\n')
    rows = []
    for variant in ('pure', 'split'):
        for d in DISTS:
            for N in sorted(tl.N.unique()):
                x = tl[(tl.variant == variant) & (tl.dist == d) & (tl.N == N)]
                if not len(x):
                    continue
                row = {'draws': int(x[x.S == 1024].shape[0])}
                for S in SS:
                    y = x[x.S == S]
                    k = int((y['first'] > 0).sum()); n = len(y)
                    lo, hi = wilson(k, n)
                    row[f'{S} rate %'] = f'{100 * k / n:.1f} [{100 * lo:.1f}, {100 * hi:.1f}]'
                    row[f'{S} first G'] = int(y[y['first'] > 0]['first'].median()) if k else '-'
                rows.append(pd.Series(row, name=f'{variant} {d} N={N:.0e}'))
    tab = pd.DataFrame(rows).rename_axis('variant, distribution, N')
    say(md(tab))
    say('')
    tl.groupby(['variant', 'dist', 'N', 'S']).agg(draws=('first', 'size'), fails=('first', lambda s: int((s > 0).sum())),
        E64_min=('E64', 'min'), E64_med=('E64', 'median')).reset_index().to_csv(os.path.join(OUT, 'tail-agg.csv'), index=False)

with open(os.path.join(OUT, 'summary.md'), 'w') as f:
    f.write('# E-18 results (generated by src/report.py; do not edit)\n\n' + '\n'.join(lines) + '\n')
print('wrote', os.path.join(OUT, 'summary.md'))
