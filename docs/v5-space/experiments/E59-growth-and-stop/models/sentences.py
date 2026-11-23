#!/usr/bin/env python3
"""
sentences.py: the rule count at the grain of whole sentences, and of LAYERS'
own rules. Each sentence of count.py (and each LAYERS rule, the sentences that
write it) is dropped whole: every guard and update in it at once, which takes
its actions out when it is a whole action. It counts as needed only if a
property then breaks on some bound. Bounds run in order (grow.ALL), stopping
at the first that fails.

    python3 models/sentences.py OPTION [OPTION ...] [--jobs 2] [--limit 2000000]
"""
import argparse
import multiprocessing as mp
import os
import resource
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402
import importlib.util  # noqa: E402
import count  # noqa: E402

CAP = int(os.environ.get('MEMCAP_MB', '4000')) * 1024 * 1024
spec = importlib.util.spec_from_file_location('grow', os.path.join(HERE, 'grow.py'))
G = importlib.util.module_from_spec(spec)
sys.modules['grow'] = G
spec.loader.exec_module(G)
SENT = {sid: ids for sid, _, _, ids in count.SENTENCES}


def run(task):
    option, name, ids, limit = task
    try:
        resource.setrlimit(resource.RLIMIT_AS, (CAP, CAP))
    except (ValueError, OSError):
        pass
    cls = G.OPTIONS[option]
    have = set(r.id for r in engine.rules(cls(G.BOUNDS['s1']).actions()))
    ids = [i for i in ids if i in have]          # an option's own guard on lrem
    m = engine.Mutation(drop=ids)
    for b in G.ALL:
        try:
            r = engine.explore(cls(G.BOUNDS[b]), m, stop_first=True, limit=limit)
        except MemoryError:
            return option, name, f'undecided ({b}: memory cap)'
        if r.fail:
            p, (d, _) = min(r.fail.items(), key=lambda x: x[1][0])
            return option, name, f'{p} on {b} ({d} steps)'
        if not r.complete:
            return option, name, f'undecided ({b}: state limit)'
    return option, name, 'nothing breaks'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('options', nargs='+')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--limit', type=int, default=2_000_000)
    a = ap.parse_args()
    tasks = []
    for o in a.options:
        for sid, ids in SENT.items():
            tasks.append((o, sid, ids, a.limit))
        for lid, _, sids in count.LAYERS:
            if len(sids) > 1:
                tasks.append((o, lid, [i for s in sids for i in SENT[s]], a.limit))
    res = {}
    with mp.Pool(a.jobs) as pool:
        for o, name, what in pool.imap_unordered(run, tasks):
            res[(o, name)] = what
            print(f'{o} {name}: {what}', flush=True)
    print('\n## Whole sentences dropped\n')
    print('| Sentence | ' + ' | '.join(a.options) + ' |\n|---|' + '---|' * len(a.options))
    for sid in SENT:
        print(f'| {sid} | ' + ' | '.join(res[(o, sid)] for o in a.options) + ' |')
    print('\n## LAYERS rules dropped whole (the sentences that write each)\n')
    print('| LAYERS rule | What | Sentences | ' + ' | '.join(a.options) + ' |\n|---|---|---|' +
          '---|' * len(a.options))
    for lid, text, sids in count.LAYERS:
        key = lid if len(sids) > 1 else sids[0]
        print(f'| {lid} | {text} | {", ".join(sids)} | ' + ' | '.join(res[(o, key)] for o in a.options) + ' |')
    for o in a.options:
        ns = sum(1 for sid in SENT if 'breaks' not in res[(o, sid)] and 'undecided' not in res[(o, sid)])
        nl = sum(1 for lid, _, sids in count.LAYERS
                 if not any(x in res[(o, lid if len(sids) > 1 else sids[0])] for x in ('nothing', 'undecided')))
        print(f'\n{o}: {ns} of {len(SENT)} sentences needed whole; {nl} of {len(count.LAYERS)} LAYERS rules needed')


if __name__ == '__main__':
    main()
