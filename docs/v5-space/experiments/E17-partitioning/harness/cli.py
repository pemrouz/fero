#!/usr/bin/env python3
"""
cli.py: run the E-17 partitioning harness.

    python3 harness/cli.py --option slot --bound grow          # one run, traces
    python3 harness/cli.py --option slot --bound grow --drop write.dedup
    python3 harness/cli.py --option slot --rules                # the rule list
    python3 harness/cli.py --option slot --ablate --jobs 2      # ablation + mutants
    python3 harness/cli.py --list                               # options and bounds

Runs set PYTHONHASHSEED=0 (it re-executes itself if needed), so the state
digests that decide mutant equivalence are the same from run to run.
"""

import argparse
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import runner                                       # noqa: E402
from dsl import Mutation                            # noqa: E402
from bounds import BOUNDS, SWEEP                    # noqa: E402
from world import PROPS                             # noqa: E402

OPTIONS = ('fixN', 'rekey', 'rekey-carry', 'slot')


def show_trace(tr, indent='      '):
    for k, lab in enumerate(tr, 1):
        print(f'{indent}{k:2}. {" ".join(map(str, lab))}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--option')
    ap.add_argument('--bound')
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--flip', action='append', default=[])
    ap.add_argument('--rules', action='store_true')
    ap.add_argument('--ablate', action='store_true')
    ap.add_argument('--no-mutants', action='store_true')
    ap.add_argument('--giveup', action='store_true', help='pin the option\'s give-up path (GIVEUP)')
    ap.add_argument('--pin', action='append', default=[], help='pin these rules instead of GIVEUP (with --tag)')
    ap.add_argument('--warm-from', help='start from another option\'s dropped rules (results/<it>-ablation.json)')
    ap.add_argument('--warm-drop', action='append', default=[], help='also drop this rule in the warm start')
    ap.add_argument('--warm-keep', action='append', default=[], help='keep this rule in the warm start')
    ap.add_argument('--tag', help='save as results/<tag>-ablation.json (an alternative run)')
    ap.add_argument('--reverse', action='store_true', help='greedy drops in reverse model-text order')
    ap.add_argument('--seed-from', help='copy cached jobs from results/<it>-checkpoint.json into a new tagged checkpoint')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--cap', type=int, default=runner.CAP)
    ap.add_argument('--budget', type=float, default=None, help='seconds of work before stopping (resumable)')
    a = ap.parse_args()

    if a.list:
        print('options:', ', '.join(OPTIONS))
        for b in SWEEP:
            x = BOUNDS[b]
            print(f'  {b}: layouts {x["layouts"]}, attempts {x["attempts"]}, '
                  f'crashes {x["crashes"]}, reader {x["reader"]}')
        for p, t in PROPS.items():
            print(f'  {p}: {t}')
        return
    if a.rules:
        for r in runner.rule_list(a.option):
            k = 'guard ' if hasattr(r, 'op') else 'update'
            c = f' [{r.op}]' if getattr(r, 'op', None) else ''
            print(f'{k} {r.id:32} {r.role:7}{c} {r.note}')
        return
    if a.ablate:
        out = os.path.join(os.path.dirname(HERE), 'results')
        # one checkpoint per option, shared by its core and +giveup runs (run
        # them one after the other); a --tag run keeps its own
        ck = os.path.join(out, f'{a.tag or a.option}-checkpoint.json')
        pins = tuple(a.pin) if a.pin else runner.giveup(a.option) if a.giveup else ()
        tag = f'{a.option}+giveup' if a.giveup else a.option
        if a.giveup and not pins:
            print(f'  {a.option} has no give-up path')
            return
        warm = ()
        if a.warm_from:
            warm = json.load(open(os.path.join(out, f'{a.warm_from}-ablation.json')))['removed']
        if a.warm_drop:
            warm = [x for x in warm if x not in a.warm_keep] + a.warm_drop
        if a.tag:
            tag = a.tag
        if a.seed_from and not os.path.exists(ck):
            # a cache only: the same job gives the same result, so sharing
            # it changes nothing but time
            src = os.path.join(out, f'{a.seed_from}-checkpoint.json')
            if os.path.exists(src):
                with open(src) as f:
                    old = json.load(f)
                # a job's key names the rules, not the option: seed only
                # from a checkpoint of the same option
                assert old['option'] == a.option, (old['option'], a.option)
                with open(ck, 'w') as f:
                    json.dump({'option': a.option, 'cache': old['cache']}, f)
        try:
            res = runner.ablate(a.option, ck, jobs=a.jobs, budget=a.budget, mutate=not a.no_mutants,
                                pinned=pins, warm=warm, reverse=a.reverse)
        except runner.OutOfTime:
            print(f'  {tag}: out of time for this piece; run again to continue')
            sys.exit(3)
        res['option'] = tag
        runner.save(os.path.join(out, f'{tag}-ablation.json'), res)
        print(f'  wrote results/{tag}-ablation.json')
        return
    bounds = [a.bound] if a.bound else list(SWEEP)
    m = Mutation(drop=a.drop, flip=a.flip)
    for b in bounds:
        r = runner.run(a.option, b, m, stop_first=False, cap=a.cap)
        print(f'{a.option} {b} [{m}]: {r.summary()}')
        for p in sorted(r.fail):
            d, tr = r.fail[p]
            print(f'    {p} in {d} steps: {PROPS[p]}')
            show_trace(tr)


if __name__ == '__main__':
    main()
