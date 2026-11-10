#!/usr/bin/env python3
"""
verify.py: E-21's verify family (E-17's "verify bound", DEV-10's step 5).

    python3 sim/verify.py [--seeds 30] [--jobs 2] [--out results/handover.json]

The seven scenario families change leaders only through a 2 s election,
longer than skew.max (250 ms), so two leaders' clocks never meet. The
verify family `handover` (timesim.py, VERIFY) is `drift` plus 2 to 6 planned
handovers: the leader stamps its last entry and another member stamps the
next one in the same tick.

1. Every option as designed, on `handover` x seeds.
2. For each option whose ablation holds (results/<option>-ablation.json,
   read unchanged): its smallest model on `handover`. If that breaks a
   check, each dropped rule is put back alone, latest dropped first; the
   first whose return fixes it is put back (E-17's procedure).
3. The new smallest model on all eight families (it must hold); each rule in
   it dropped on top (each must still break a check: 1-minimal).
4. Every mutant of the new smallest model, made as ablate.py makes them
   (drop each rule, flip each comparison, swap each pair of updates in one
   action, and each swap with the pinned clock reading), on all eight
   families. One that changes no number on any seed is `no change`.
"""
import argparse
import json
import os
import sys
import time
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timesim as ts   # noqa: E402
import ablate          # noqa: E402

ALL = ('wall', 'clamp', 'median', 'median1', 'hlc', 'mono', 'mono+ck', 'tt')
EIGHT = ts.FAMILIES + ts.VERIFY


def sweep(pool, opt, seeds, m, fams, stop=False):
    mk = (tuple(sorted(m.drop)), tuple(sorted(m.flip)), tuple(sorted(m.swap.items())))
    jobs = [(opt, s, f, mk) for f in fams for s in range(seeds)]
    tot = {k: 0 for k in ts.CHECKS + ('overlap', 'ERR')}
    tot['late_max'] = 0.0
    tot['early_max'] = 0.0
    first = None
    per = {}
    step = 8
    for c in range(0, len(jobs), step):
        for fam, seed, r, lm, em in pool.map(ablate._one, jobs[c:c + step]):
            for k in tot:
                if k in r:
                    tot[k] += r[k]
            tot['late_max'] = max(tot['late_max'], lm)
            tot['early_max'] = max(tot['early_max'], em)
            per[f'{fam}/{seed}'] = r
            bad = [k for k in ts.CHECKS + ('ERR',) if r[k]]
            if bad and first is None:
                first = (fam, seed, bad)
        if first and stop:
            break
    tot['first'] = first
    return tot, per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', type=int, default=30)
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'results', 'handover.json'))
    a = ap.parse_args()
    res = os.path.dirname(os.path.abspath(a.out))
    out = {'family': 'handover', 'seeds': a.seeds, 'options': {}}
    t0 = time.time()
    log = lambda *x: print(*x, flush=True)
    with Pool(a.jobs) as pool:
        for o in ALL:
            row = out['options'].setdefault(o, {})
            d, _ = sweep(pool, o, a.seeds, ts.Mutation(), ts.VERIFY)
            row['design'] = d
            log(f'{o} design on handover: {json.dumps(d)}')
            p = os.path.join(res, f'{o}-ablation.json')
            if not os.path.exists(p):
                continue
            ab = json.load(open(p))
            if ab.get('fails_as_designed'):
                continue
            removed = list(ab['removed'])
            s, _ = sweep(pool, o, a.seeds, ts.Mutation(drop=removed), ts.VERIFY)
            # how far writer time stepped back at worst (ms), over the same seeds
            bm = max(ts.run_one(o, sd, 'handover', ts.Mutation(drop=removed)).get('back_max', 0.0) for sd in range(a.seeds))
            row['smallest'] = {'removed': removed, 'result': s, 'back_max_ms': round(bm, 3)}
            log(f'{o} smallest model ({len(ab["kept"])} rules) on handover: {json.dumps(s)}')
            back = None
            if s['first']:
                row['put_back_tries'] = {}
                for r in reversed(removed):
                    t, _ = sweep(pool, o, a.seeds, ts.Mutation(drop=[x for x in removed if x != r]), ts.VERIFY, stop=True)
                    row['put_back_tries'][r] = t['first']
                    log(f'  put back {r}: {"holds" if not t["first"] else t["first"]}')
                    if not t['first'] and back is None:
                        back = r
            row['put_back'] = back
            if s['first'] and back is None:
                log(f'  {o}: no single rule put back fixes it')
                continue
            new_removed = [x for x in removed if x != back]
            kept = [i for i in ab['kept']] + ([back] if back else [])
            row['rules_needed'] = len(kept)
            full, mper = sweep(pool, o, a.seeds, ts.Mutation(drop=new_removed), EIGHT)
            row['new_smallest_on_eight'] = full
            log(f'  {o} new smallest ({len(kept)} rules) on eight families: first {full["first"]}')
            row['kept'] = {}
            for r in kept:
                t, _ = sweep(pool, o, a.seeds, ts.Mutation(drop=new_removed + [r]), EIGHT, stop=True)
                row['kept'][r] = t['first']
                log(f'  drop {r}: {t["first"]}')
            # every mutant of the new smallest model, made as ablate.py makes them, on eight families
            acts = ts.OPTIONS[o]().actions()
            rl = [r for r in ts.rules(acts) if r.id not in ablate.PINNED]
            muts = []
            for r in rl:
                if r.id not in new_removed:
                    muts.append(('drop', r.id, ts.Mutation(drop=new_removed + [r.id])))
            for r in rl:
                if r.id not in new_removed and isinstance(r, ts.Guard) and r.is_cmp():
                    muts.append(('flip', r.id, ts.Mutation(drop=new_removed, flip=[r.id])))
            for act in acts:
                live = [k for k, u in enumerate(act.updates) if u.id not in new_removed and u.id not in ablate.PINNED]
                for x in range(len(live)):
                    for y in range(x + 1, len(live)):
                        i, j = live[x], live[y]
                        muts.append(('swap', f'{act.name}: {act.updates[i].name} <-> {act.updates[j].name}',
                                     ts.Mutation(drop=new_removed, swap={act.name: (i, j)})))
            for act in acts:
                if act.name == 'stamp':
                    for j, u in enumerate(act.updates):
                        if j and u.id not in new_removed:
                            muts.append(('swap', f'stamp: read <-> {u.name}',
                                         ts.Mutation(drop=new_removed, swap={'stamp': (0, j)})))
            row['mutants'] = []
            for kind, what, m in muts:
                t, _ = sweep(pool, o, a.seeds, m, EIGHT, stop=True)
                if t['first']:
                    row['mutants'].append({'kind': kind, 'rule': what, 'caught': t['first']})
                else:
                    _, p3 = sweep(pool, o, a.seeds, m, EIGHT)
                    row['mutants'].append({'kind': kind, 'rule': what, 'caught': None, 'no_change': p3 == mper})
                log(f'  mutant {kind} {what}: {row["mutants"][-1]}')
    out['secs'] = round(time.time() - t0)
    with open(a.out, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    # the table
    md = ['# E-21: the verify family `handover`', '',
          f'`drift` plus 2 to 6 planned handovers per run, {a.seeds} seeds, 3 or 5 nodes (made by `sim/verify.py`). '
          'A handover: the leader stamps its last entry, another member takes over and stamps the next in the same tick.', '',
          '| option | as designed | worst early (ms) | worst late (ms) | smallest model of the seven families | rule put back | rules needed now | mutants caught / not "no change" (eight families) |',
          '|---|---|---|---|---|---|---|---|']
    for o in ALL:
        r = out['options'][o]
        d = r['design']
        bad = ', '.join(f'{k} {d[k]}' for k in ts.CHECKS if d[k]) or 'holds'
        if 'smallest' not in r:
            md.append(f'| `{o}` | {bad} | {d["early_max"]:.0f} | {d["late_max"]:.0f} | (fails as designed on the seven) | - | - | - |')
            continue
        s = r['smallest']['result']
        sb = ', '.join(f'{k} {s[k]}' for k in ts.CHECKS if s[k]) or 'holds'
        if s['back']:
            sb += f' (worst step back {r["smallest"]["back_max_ms"]} ms)'
        ms = r.get('mutants', [])
        c = sum(1 for m in ms if m['caught'])
        nc = sum(1 for m in ms if not m['caught'] and m.get('no_change'))
        err = sum(1 for m in ms if m['caught'] and 'ERR' in m['caught'][2])
        mt = f'{c} / {len(ms) - nc}' + (f' ({err} of them by an evaluation error)' if err else '') if ms else '-'
        md.append(f'| `{o}` | {bad} | {d["early_max"]:.0f} | {d["late_max"]:.0f} | {sb} | '
                  f'{("`" + r["put_back"] + "`") if r.get("put_back") else "none"} | {r.get("rules_needed", "-")} | {mt} |')
    md += ['']
    for o in ALL:
        r = out['options'][o]
        if 'kept' not in r:
            continue
        md += [f'## {o}: each rule of the new smallest model dropped on top (eight families)', '',
               '| rule | breaks (family, seed, checks) |', '|---|---|']
        md += [f'| `{k}` | {v or "nothing"} |' for k, v in r['kept'].items()]
        if r.get('put_back_tries'):
            md += ['', 'Put back alone on the old smallest model (latest dropped first): ' +
                   ', '.join(f'`{k}` {"holds" if not v else v}' for k, v in r['put_back_tries'].items()) + '.']
        md += ['', '| mutant | kind | result |', '|---|---|---|']
        md += [f'| `{m["rule"]}` | {m["kind"]} | ' + (str(m['caught']) if m['caught'] else 'no change' if m.get('no_change') else 'SURVIVED') + ' |'
               for m in r.get('mutants', [])]
        md += ['']
    with open(os.path.join(res, 'handover.md'), 'w') as f:
        f.write('\n'.join(md))
    log(f'done in {out["secs"]} s')


if __name__ == '__main__':
    main()
