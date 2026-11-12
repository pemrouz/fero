#!/usr/bin/env python3
"""
run47.py: every run of E-47 on E-16's engine (engine.explore), with traces.

    python3 run47.py [STEP ...]     steps: base info rules sets subs greedy w1 row verify (default: all)

Each run is (rung config, rule set, bound, mode). A config names the rungs of
groups A and B: PP (both persisted), MP (A memory, B persisted), MM (both
memory; only A can lose its tail). Results are cached in results/runs.json, so
a rerun skips what is done (delete the file to start over). Each cache key
holds a hash of models/memrung.py and the bound's own settings, so a changed
model or bound is run again, never read from an old entry. Text with traces
goes to results/<step>.txt.
"""
import hashlib
import importlib.util
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

MODEL = os.path.join(HERE, 'models', 'memrung.py')
with open(MODEL, 'rb') as _f:
    MODEL_HASH = hashlib.sha256(_f.read()).hexdigest()[:16]
_spec = importlib.util.spec_from_file_location('memrung', MODEL)
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

RES = os.path.join(HERE, 'results')
CACHE = os.path.join(RES, 'runs.json')
LIMIT = 3_000_000

TXN = ('txn', 'txnb', 'txn1')
LOCK = ('lockAA', 'lockBA', 'lockAB')
ROW = ('lockAA-row', 'lockBA-row', 'lockAB-row')
ALLB = TXN + ('dedup',) + LOCK          # the sweep: tokens are TSO timestamps (TiKV's shape)
VERIFYB = ('txn1-2r', 'dedup-v', 'lockAA-v', 'lockBA-v')
VLIMIT = 6_000_000                      # about 7 GB at 1.2 KB a state

# larger bounds for the rule sets that hold (step `verify`)
M.BOUNDS.update({
    # three copies of the commit, the coordinator may crash, and two readers
    'dedup-v': dict(M.BOUNDS['dedup'], cmcopies=3, crashes=1, readers=((('x',), 1), (('x',), 1))),
    # each holder may claim again after a fenced write; two paused leases
    'lockAA-v': dict(M.BOUNDS['lockAA'], reclaims=1, lapses=2),
    'lockBA-v': dict(M.BOUNDS['lockBA'], reclaims=1, lapses=2),
})

PLAIN = {
    't.begin': '{0} begins: a start ts from the TSO; it sends its prewrites',
    't.refused': '{0} is refused by a rule',
    't.prewritten': '{0} hears its prewrite of {1}: {2}',
    't.prewrite-again': '{0} sends its prewrite of {1} again (no answer, no copy in flight)',
    't.commit': '{0} takes a commit ts from the TSO and sends the primary\'s commit',
    't.committed': '{0} hears the primary\'s commit: {2}',
    't.commit-again': '{0} sends the primary\'s commit again (timeout)',
    't.secondaries': '{0} sends the secondaries\' commits and stops',
    'r.snapshot': 'the reader takes a snapshot ts from the TSO',
    'r.read': 'the reader reads {1}: {2}',
    'r.check': 'the reader finds {1} locked, its TTL run out; it sends: {2}',
    'r.resolve': 'the reader sends: {2}',
    'h.claim': '{0} sends a claim of the lock',
    'h.refused': '{0}: the claim is refused by a rule',
    'h.claimed': '{0} hears its claim: {1}',
    'h.claim-again': '{0} sends its claim again (no answer, no copy in flight)',
    'h.write': '{0} sends its protected write of x',
    'h.write-refused': '{0}: the protected write is refused by a rule',
    'h.written': '{0} hears its write: {1}',
    'h.write-again': '{0} sends its write again (no answer, no copy in flight)',
}
TOLD = {'ok': 'ok (told committed)', 'rolledback': 'rolled back (told aborted)',
        'notfound': 'lock not found (told aborted)', 'stale': 'stale epoch (told unknown)'}


def say(lab, cfg):
    name = lab[0]
    if isinstance(lab[1], tuple):
        a = list(lab[1])
        if name == 'deliver':
            g, cmd = a
            rung = cfg[0 if g == 'A' else 1]
            tail = ', committed' if (rung == 'M' or g == 'B') else ', not yet on a majority\'s disks'
            return f'{g} ({"memory" if rung == "M" else "persisted"}) appends: {cmd}{tail}'
        if name == 't.committed':
            a[2] = TOLD.get(a[2], a[2])
        if name == 'r.check':
            a[2] = a[2].split(': ', 1)[-1]
        while len(a) < 3:
            a.append('')
        return PLAIN.get(name, name + ' {0} {1} {2}').format(*a)
    g = lab[1]
    if name == 'sync':
        return f'{g}: a majority\'s disks catch up ({lab[2]})'
    if name == 'stop':
        return f'{g}: {lab[2]}'
    if name == 'crash':
        return f'{g} crashes'
    if name == 'lapse':
        return f'{g}\'s lease lapses ({lab[2]}); {g} is paused and does not know'
    if name == 'expire':
        return f'{lab[2]} ({g})'
    return ' '.join(map(str, lab))


def load():
    if os.path.exists(CACHE):
        with open(CACHE) as f:
            return json.load(f)
    return {}


DB = load()


def save():
    tmp = CACHE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(DB, f, indent=0, sort_keys=True)
    os.replace(tmp, CACHE)


def run(cfg, rules, bound, mode='bug', drop=(), allfails=False, W=2, limit=LIMIT):
    key = json.dumps([MODEL_HASH, cfg, sorted(rules), bound, M.BOUNDS[bound], mode, sorted(drop), allfails, W, limit],
                     sort_keys=True)
    if key in DB:
        return DB[key]
    cls = M.option(cfg, tuple(rules), W=W)
    b = dict(M.BOUNDS[bound], mode=mode)
    r = engine.explore(cls(b), engine.Mutation(drop=drop), stop_first=not allfails, limit=limit,
                       liveness=(mode == 'bug'))
    out = {'model': MODEL_HASH, 'states': r.states, 'secs': round(r.secs, 1), 'complete': r.complete,
           'fail': {p: [d, [[x[0], list(x[1])] if isinstance(x[1], tuple) else list(x) for x in tr]]
                    for p, (d, tr) in r.fail.items()},
           'judged': {k: list(v) for k, v in r.judged.items()}}
    DB[key] = out
    save()
    return out


def fails(x):
    return sorted(x['fail'])


def verdict(x):
    f = fails(x)
    if f:
        return ', '.join(f'{p} {x["fail"][p][0]}' for p in f)
    return 'holds' if x['complete'] else 'LIMIT (no counterexample)'


def tr_text(x, p, cfg, ind='    '):
    out = []
    for i, lab in enumerate(x['fail'][p][1], 1):
        lab = (lab[0], tuple(lab[1])) if len(lab) == 2 and isinstance(lab[1], list) else tuple(lab)
        out.append(f'{ind}{i:2}. {say(lab, cfg)}')
    return '\n'.join(out)


class Out:
    def __init__(self, step, title):
        self.path = os.path.join(RES, step + '.txt')
        self.f = open(self.path, 'w')
        self.w(f'# E-47 {step}: {title}')
        self.w(f'# {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, Python {sys.version.split()[0]}, '
               f'{os.cpu_count()} vCPU, load {open("/proc/loadavg").read().split()[:3]}')

    def w(self, s=''):
        print(s, file=self.f, flush=True)
        print(s, flush=True)

    def close(self):
        self.f.close()


def line(o, cfg, rules, bound, x, extra=''):
    o.w(f'{cfg:3} {"+".join(rules) or "no rules":28} {bound:11} {x["states"]:>9,} states {x["secs"]:7.1f}s  '
        f'{verdict(x)}{extra}')


def step_base():
    o = Out('base', 'runs 1 to 4: no rules; every property broken, each with its shortest trace')
    groups = [
        ('Run 1: both groups persisted (baseline)', 'PP', ALLB + ('txn1-2r',) + ROW),
        ('Run 2: one group memory, no rules; everything on the memory group', 'MP', ('txn1', 'dedup', 'lockAA')),
        ('Run 3: a transaction spanning a memory and a persisted group', 'MP', ('txn', 'txnb')),
        ('Run 3b: a transaction spanning two memory groups (only A loses its tail)', 'MM', ('txn', 'txnb')),
        ('Run 4: locks and dedup with the memory group in each role', 'MP',
         ('dedup', 'lockAA', 'lockBA', 'lockAB', 'lockAA-row', 'lockBA-row', 'lockAB-row')),
    ]
    for title, cfg, bounds in groups:
        o.w()
        o.w(f'## {title}')
        for b in bounds:
            x = run(cfg, (), b, allfails=True)
            live = x['judged'].get('done')
            line(o, cfg, (), b, x, f'   (liveness: {live[1]:,} of {live[0]:,} states stuck)' if live else '')
            for p in fails(x):
                o.w(f'  {p}, shortest trace, {x["fail"][p][0]} steps:')
                o.w(tr_text(x, p, cfg))
    o.close()


def step_info():
    o = Out('info', 'what the rung\'s contract allows: an acknowledged write on a memory group lost (LOST), '
                    'a later snapshot older on a memory key (READBACK); reported, not counted')
    for cfg, rules in (('MP', ()), ('MP', ('R1s', 'R3', 'R2.claim')), ('MP', ('R2',))):
        o.w()
        o.w(f'## {cfg}, {"+".join(rules) or "no rules"}')
        for b in ('txn', 'txnb', 'txn1', 'txn1-2r', 'dedup', 'lockAA', 'lockBA'):
            x = run(cfg, rules, b, mode='info', allfails=True)
            line(o, cfg, rules, b, x)
            if not rules or b.startswith('txn1'):
                for p in fails(x):
                    o.w(f'  {p} (allowed), shortest trace, {x["fail"][p][0]} steps:')
                    o.w(tr_text(x, p, cfg))
    o.close()


FULL = ('R1', 'R2', 'R3', 'R4')


def table(o, sets, cfgs=('MP', 'MM'), bounds=ALLB, drop=(), W=2, show=True, limit=LIMIT):
    res = {}
    for name, rules, dr in sets:
        o.w()
        o.w(f'## {name}')
        bad = []
        for cfg in cfgs:
            for b in bounds:
                x = run(cfg, rules, b, drop=dr, W=W, limit=limit)
                line(o, cfg, rules, b, x, f'   (drop {", ".join(dr)})' if dr else '')
                if fails(x) or not x['complete']:
                    bad.append((cfg, b, x))
        if show and bad:
            cfg, b, x = min(bad, key=lambda t: min((t[2]['fail'][p][0] for p in t[2]['fail']), default=999))
            if x['fail']:
                p = min(x['fail'], key=lambda q: x['fail'][q][0])
                o.w(f'  shortest counterexample: {cfg} {b}, {p}, {x["fail"][p][0]} steps:')
                o.w(tr_text(x, p, cfg))
        o.w(f'  => {"holds on every bound" if not bad else "breaks on " + ", ".join(c + " " + bb + " (" + verdict(xx) + ")" for c, bb, xx in bad)}')
        res[name] = bad
    return res


def step_rules():
    o = Out('rules', 'run 5: the four candidate rules together, then each one dropped (DEV-10 ablation)')
    table(o, [('R1+R2+R3+R4 (all four)', FULL, ())])
    table(o, [(f'all four, without {r}', FULL, (r,)) for r in FULL])
    o.close()


def step_sets():
    o = Out('sets', 'run 5: candidate rule sets on their own')
    sets = [('no rules', (), ()), ('R1 alone', ('R1',), ()), ('R2 alone (RR-14\'s one rule)', ('R2',), ()),
            ('R3 alone', ('R3',), ()), ('R4 alone (W = 2)', ('R4',), ()), ('R1+R3', ('R1', 'R3'), ()),
            ('R1s alone', ('R1s',), ()), ('R1s+R3', ('R1s', 'R3'), ()),
            ('R1s+R3+R2.claim (lock rows off memory groups)', ('R1s', 'R3', 'R2.claim'), ()), ('R1+R2', ('R1', 'R2'), ())]
    table(o, sets)
    o.close()


def step_subs():
    o = Out('subs', 'run 5: which part of each rule is needed (sub-rules dropped from the two smallest sets)')
    table(o, [(f'R2 without {s}', ('R2',), (s,)) for s in ('R2.txn', 'R2.claim', 'R2.put')])
    table(o, [(f'R1s+R3+R2.claim without {s}', ('R1s', 'R3', 'R2.claim'), (s,))
              for s in ('R1s', 'R3.fence', 'R3.stale', 'R3.res', 'R3.read', 'R2.claim')])
    o.close()


def step_w1():
    o = Out('w1', 'R4 with the tightest window (W = 1: sync before the next append)')
    table(o, [('R4 alone, W = 1', ('R4',), ())], W=1)
    o.close()


def holds(rules, cfgs=('MP', 'MM'), bounds=ALLB):
    for cfg in cfgs:
        for b in bounds:
            x = run(cfg, rules, b)
            if fails(x) or not x['complete']:
                return False, (cfg, b, verdict(x))
    return True, None


def step_greedy():
    o = Out('greedy', 'run 5: E-17\'s greedy ablation over R1, R1s, R2, R3, R4 in three orders, '
                      'then over R2\'s three parts and the rest in a fourth')
    whole = ('R1', 'R1s', 'R2', 'R3', 'R4')
    parts = ('R1', 'R1s', 'R2.txn', 'R2.claim', 'R2.put', 'R3', 'R4')
    for cand, order in ((whole, whole), (whole, tuple(reversed(whole))), (whole, ('R2', 'R1', 'R1s', 'R3', 'R4')),
                        (parts, ('R2.txn', 'R2.put', 'R1', 'R1s', 'R2.claim', 'R3', 'R4'))):
        o.w()
        o.w(f'## order {", ".join(order)}')
        kept = list(cand)
        ok, why = holds(tuple(kept))
        o.w(f'  start: {"+".join(kept)}: {"holds" if ok else why}')
        for r in order:
            trial = [x for x in kept if x != r]
            ok, why = holds(tuple(trial))
            if ok:
                kept = trial
                o.w(f'  drop {r}: holds without it -> dropped')
            else:
                o.w(f'  drop {r}: {why[0]} {why[1]} breaks ({why[2]}) -> kept')
        fin = []
        for r in kept:
            ok, why = holds(tuple(x for x in kept if x != r))
            fin.append(f'{r}: {"NOT NEEDED" if ok else "needed (" + " ".join(why) + ")"}')
        o.w(f'  smallest set: {"+".join(kept)}; final pass: ' + '; '.join(fin))
    o.close()


def step_row():
    o = Out('row', 'tokens from a counter in the lock row (tok=row) instead of TSO timestamps')
    table(o, [('no rules', (), ()), ('R2', ('R2',), ()), ('R1s+R3', ('R1s', 'R3'), ()),
              ('R2 without R2.claim', ('R2',), ('R2.claim',)), ('R1s+R3+R2.claim', ('R1s', 'R3', 'R2.claim'), ())],
          cfgs=('MP',), bounds=ROW)
    o.close()


def step_verify():
    o = Out('verify', 'the two smallest sets and the full set on larger bounds (state limit 6 million)')
    table(o, [('R2', ('R2',), ()), ('R1s+R3+R2.claim', ('R1s', 'R3', 'R2.claim'), ()), ('R1+R2+R3+R4', FULL, ())],
          bounds=VERIFYB, limit=VLIMIT)
    table(o, [('no rules (the larger bounds still break without rules)', (), ())], cfgs=('MP',), bounds=VERIFYB,
          limit=VLIMIT)
    table(o, [('baseline: both persisted, no rules', (), ())], cfgs=('PP',), bounds=VERIFYB, limit=VLIMIT)
    o.close()


STEPS = {'base': step_base, 'info': step_info, 'rules': step_rules, 'sets': step_sets, 'subs': step_subs,
         'w1': step_w1, 'greedy': step_greedy, 'row': step_row, 'verify': step_verify}

if __name__ == '__main__':
    os.makedirs(RES, exist_ok=True)
    for s in sys.argv[1:] or list(STEPS):
        STEPS[s]()
