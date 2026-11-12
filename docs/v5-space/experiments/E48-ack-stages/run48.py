#!/usr/bin/env python3
"""
run48.py: every run of E-48 on E-16's engine (engine.explore), with traces.

    python3 run48.py [STEP ...]     steps: base crash info rules subs greedy s2 verify (default: all)

Each run is (form, stage map, results in early answers, rule set, bound, mode,
rules dropped). Forms: S0 (persisted only), S1 (ack stages, commit at disk), S2
(commit in memory, answer per write). Stage maps: models/ackstage.py STAGES.
Results are cached in results/runs.json, keyed by a hash of models/ackstage.py
and the bound's own settings, so a rerun skips what is done and a changed model
runs afresh. Text with traces goes to results/<step>.txt.
"""
import fcntl
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

MODEL = os.path.join(HERE, 'models', 'ackstage.py')
with open(MODEL, 'rb') as _f:
    MODEL_HASH = hashlib.sha256(_f.read()).hexdigest()[:16]
_spec = importlib.util.spec_from_file_location('ackstage', MODEL)
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

RES = os.path.join(HERE, 'results')
CACHE = os.path.join(RES, 'runs.json')
LIMIT = 3_000_000

TXN = ('txn', 'txnb', 'txn1', 'dedup')
LOCK = ('lockAA', 'lockBA', 'lockAB')
PLAIN = ('pipe', 'pipe-t', 'ryw')
ALLB = TXN + LOCK + PLAIN
ALLC = tuple(b + '-c' for b in ALLB)
VERIFYB = ('txn1-2r', 'dedup-v', 'lockAA-v', 'lockAB-v', 'pipe3')

# larger bounds (step `verify`)
M.BOUNDS.update({
    'txn1-2r': dict(M.BOUNDS['txn1'], readers=((('a', 'c'), 2),)),
    'dedup-v': dict(M.BOUNDS['dedup'], cmcopies=3, crashes=1, readers=((('x',), 1), (('x',), 1))),
    'lockAA-v': dict(M.BOUNDS['lockAA'], reclaims=1, lapses=2),
    'lockAB-v': dict(M.BOUNDS['lockAB'], reclaims=1, lapses=2),
    'pipe3': dict(plain=dict(nw=3, read=True), preaders=1, stops=1, lcrash=1),
})

S1ST = ('recv', 'repl', 'mixr', 'mixp')
S2ST = ('mem', 'disk', 'e1')
W1 = ('W1.pw', 'W1.cm', 'W1.chk', 'W1.claim')
S1SET = ('W1', 'O.seq', 'Y')

SAY = {
    't.begin': '{0} begins: a start ts from the TSO; it sends its prewrites',
    't.refused': '{0} is refused by a rule',
    't.prewritten': '{0} acts on the answer to its prewrite of {1}: {2}',
    't.prewrite-again': '{0} sends its prewrite of {1} again (no answer, no copy in flight)',
    't.commit': '{0} takes a commit ts from the TSO and sends the primary\'s commit',
    't.committed': '{0} acts on the answer to the primary\'s commit: {2}',
    't.commit-again': '{0} sends the primary\'s commit again (timeout)',
    't.secondaries': '{0} sends the secondaries\' commits and stops',
    'r.snapshot': 'the reader takes a snapshot ts from the TSO',
    'r.read': 'the reader reads {1}: {2}',
    'r.check': 'the reader finds {1} locked, its TTL run out; it sends: {2}',
    'r.resolve': 'the reader sends: {2}',
    'h.claim': '{0} sends a claim of the lock',
    'h.refused': '{0}: the claim is refused by a rule',
    'h.claimed': '{0} acts on the answer to its claim: {1}',
    'h.claim-again': '{0} sends its claim again (no answer, no copy in flight)',
    'h.write': '{0} sends its protected write of x',
    'h.write-refused': '{0}: the protected write is refused by a rule',
    'h.written': '{0} acts on the answer to its write: {1}',
    'h.write-again': '{0} sends its write again (no answer, no copy in flight)',
    'w.send': 'the plain writer {1}',
    'w.again': 'the plain writer {1}',
    'w.read': 'the plain writer {1}',
    'w.end': 'the plain writer: {1}',
    'p.read': 'a plain reader {1}',
}
TOLD = {'ok': 'ok (committed)', 'rolledback': 'rolled back (aborted)',
        'notfound': 'lock not found (aborted)', 'stale': 'stale epoch (unknown)'}


def say(lab, form):
    name = lab[0]
    if isinstance(lab[1], tuple):
        a = list(lab[1])
        if name in ('deliver', 'w.deliver'):
            g, cmd = a
            if g == 'B':
                return f'B appends and commits: {cmd}'
            return f'A\'s leader appends: {cmd}' + (' (not yet held by a majority)')
        if name == 't.committed':
            a[2] = TOLD.get(a[2], a[2])
        if name == 'r.check':
            a[2] = a[2].split(': ', 1)[-1]
        while len(a) < 3:
            a.append('')
        return SAY.get(name, name + ' {0} {1} {2}').format(*a)
    g = lab[1]
    if name in ('repl', 'sync', 'stop', 'lcrash'):
        return f'{g}: {lab[2]}' + (' (committed, visible)' if (name == 'repl' and form == 'S2') or
                                    (name == 'sync' and form != 'S2') else '')
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
    """Merge this process's runs into the cache under a lock, so steps may run side by side."""
    with open(CACHE + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        cur = load()
        cur.update(DB)
        DB.update(cur)
        tmp = f'{CACHE}.tmp.{os.getpid()}'
        with open(tmp, 'w') as f:
            json.dump(cur, f, indent=0, sort_keys=True)
        os.replace(tmp, CACHE)


def run(form, stage, rules, bound, res='spec', mode='bug', drop=(), allfails=False, limit=LIMIT):
    key = json.dumps([MODEL_HASH, form, stage, res, sorted(rules), bound, M.BOUNDS[bound], mode, sorted(drop),
                      allfails, limit], sort_keys=True)
    if key in DB:
        return DB[key]
    cls = M.option(form, stage, tuple(rules), res)
    b = dict(M.BOUNDS[bound], mode=mode)
    r = engine.explore(cls(b), engine.Mutation(drop=drop), stop_first=not (allfails or mode == 'info'),
                       limit=limit, liveness=(mode == 'bug'))
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


def tr_text(x, p, form, ind='    '):
    out = []
    for i, lab in enumerate(x['fail'][p][1], 1):
        lab = (lab[0], tuple(lab[1])) if len(lab) == 2 and isinstance(lab[1], list) else tuple(lab)
        out.append(f'{ind}{i:2}. {say(lab, form)}')
    return '\n'.join(out)


class Out:
    def __init__(self, step, title):
        self.path = os.path.join(RES, step + '.txt')
        self.f = open(self.path, 'w')
        self.w(f'# E-48 {step}: {title}')
        self.w(f'# {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, Python {sys.version.split()[0]}, '
               f'{os.cpu_count()} vCPU, load {open("/proc/loadavg").read().split()[:3]}, model {MODEL_HASH}')

    def w(self, s=''):
        print(s, file=self.f, flush=True)
        print(s, flush=True)

    def close(self):
        self.f.close()


def cfg(form, stage, res='spec'):
    return form + ('' if form == 'S0' else '-' + stage) + ('-blind' if res == 'blind' else '')


def line(o, form, stage, res, rules, bound, x, extra=''):
    o.w(f'{cfg(form, stage, res):14} {"+".join(rules) or "no rules":28} {bound:10} {x["states"]:>9,} states '
        f'{x["secs"]:7.1f}s  {verdict(x)}{extra}')


def configs(which):
    out = []
    for w in which:
        if w == 'S0':
            out.append(('S0', 'cmt', 'spec'))
        elif w.endswith('-blind'):
            f, s, _ = w.split('-')
            out.append((f, s, 'blind'))
        else:
            f, s = w.split('-')
            out.append((f, s, 'spec'))
    return out


def block(o, title, cfgs, rules, bounds, drop=(), allfails=False, show='all', limit=LIMIT, mode='bug'):
    """Run rules on every (config, bound); print one line each and the shortest trace(s)."""
    o.w()
    o.w(f'## {title}')
    bad = []
    for form, stage, res in cfgs:
        for b in bounds:
            x = run(form, stage, rules, b, res=res, mode=mode, drop=drop, allfails=allfails, limit=limit)
            live = x['judged'].get('done')
            extra = f'   (drop {", ".join(drop)})' if drop else ''
            if live and allfails:
                extra += f'   (liveness: {live[1]:,} of {live[0]:,} states stuck)'
            line(o, form, stage, res, rules, b, x, extra)
            if fails(x) or not x['complete']:
                bad.append((form, stage, res, b, x))
            if show == 'all':
                for p in fails(x):
                    o.w(f'  {p}{" (allowed by the early answer\'s contract)" if mode == "info" else ""}, '
                        f'shortest trace, {x["fail"][p][0]} steps:')
                    o.w(tr_text(x, p, form))
    if show == 'min' and bad:
        cands = [(t, p) for t in bad for p in t[4]['fail']]
        if cands:
            (form, stage, res, b, x), p = min(cands, key=lambda c: c[0][4]['fail'][c[1]][0])
            o.w(f'  shortest counterexample: {cfg(form, stage, res)} {b}, {p}, {x["fail"][p][0]} steps:')
            o.w(tr_text(x, p, form))
    o.w(f'  => {"holds on every bound" if not bad else "breaks on " + ", ".join(cfg(f, s, r) + " " + bb + " (" + verdict(xx) + ")" for f, s, r, bb, xx in bad)}')
    return bad


def step_base():
    o = Out('base', 'no rules: every property, each with its shortest trace; S0 is the baseline')
    block(o, 'S0: persisted only (the baseline; E-47 run 1 with the memory point and the leader crash added)',
          configs(['S0']), (), ALLB + ('pipe-s',), allfails=True)
    for st in S1ST:
        block(o, f'S1, every operation answered at stage map `{st}`, results judged at the leader (spec)',
              configs([f'S1-{st}']), (), ALLB, allfails=True)
    for st in S2ST:
        block(o, f'S2, commit in memory, stage map `{st}`', configs([f'S2-{st}']), (), ALLB, allfails=True)
    o.close()


def step_crash():
    o = Out('crash', 'the leader\'s process crash alone (page cache kept), no power loss: which early stage survives it')
    block(o, 'S0', configs(['S0']), (), ALLC + ('pipe-s-c',), allfails=True)
    for st in S1ST:
        block(o, f'S1 `{st}`, no rules', configs([f'S1-{st}']), (), ALLC, allfails=True)
    for st in S2ST:
        block(o, f'S2 `{st}`, no rules', configs([f'S2-{st}']), (), ALLC, allfails=True)
    o.close()


def step_info():
    o = Out('info', 'what an early answer\'s contract allows (EARLY-LOST, RESULT, EARLY-HOLDERS, READBACK), '
                    'reported, not counted; with the rules S1 needs')
    for c in ('S1-recv', 'S1-repl', 'S1-mixr', 'S1-recv-blind', 'S1-repl-blind'):
        block(o, f'{c} with W1+O.seq+Y', configs([c]), S1SET, ALLB + ALLC, mode='info')
    block(o, 'S2-mem, no rules (the memory rung\'s allowed losses)', configs(['S2-mem']), (), ALLB, mode='info')
    o.close()


def step_rules():
    o = Out('rules', 'S1 with W1+O.seq+Y on every stage map and both result modes, power loss and leader crash')
    block(o, 'S1 with W1+O.seq+Y', configs([f'S1-{s}' for s in S1ST] + [f'S1-{s}-blind' for s in S1ST]),
          S1SET, ALLB + ALLC, show='min')
    block(o, 'S0 with O.seq (pipelined plain writes, timeouts)', configs(['S0']), ('O.seq',), ALLB + ALLC + ('pipe-s', 'pipe-s-c'),
          show='min')
    o.close()


def step_subs():
    o = Out('subs', 'S1: each part of W1+O.seq+Y dropped (DEV-10 ablation), on stage maps recv and mixr (which act '
                    'earliest, so they cover repl and mixp), both faults')
    for r in W1 + ('O.seq', 'Y'):
        block(o, f'W1+O.seq+Y without {r}', configs(['S1-recv', 'S1-mixr']), S1SET, ALLB + ALLC,
              drop=(r,), show='min')
    o.close()


def holds(rules, cfgs, bounds):
    for form, stage, res in cfgs:
        for b in bounds:
            x = run(form, stage, rules, b, res=res)
            if fails(x) or not x['complete']:
                return False, (cfg(form, stage, res), b, verdict(x))
    return True, None


def step_greedy():
    o = Out('greedy', 'E-17\'s greedy ablation for S1 over W1, O.seq, Y and E-47\'s R3 (an epoch after a power loss), '
                      'on S1-recv and S1-mixr, every bound, power loss and leader crash')
    cf = configs(['S1-recv', 'S1-mixr'])
    bounds = ALLB + ALLC
    whole = ('R3', 'W1', 'O.seq', 'Y')
    parts = ('R3.fence', 'R3.stale', 'R3.res', 'R3.read') + W1 + ('O.seq', 'Y')
    # A fourth order (W1's parts before R3's) is left out to keep within the CPU budget: its outcome is fixed by
    # step `subs`, since every W1 part also breaks on a process-crash bound, where R3's epoch never fires.
    for cand, order in ((whole, whole), (whole, tuple(reversed(whole))), (parts, parts)):
        o.w()
        o.w(f'## order {", ".join(order)}')
        kept = list(cand)
        ok, why = holds(tuple(kept), cf, bounds)
        o.w(f'  start: {"+".join(kept)}: {"holds" if ok else why}')
        for r in order:
            trial = [x for x in kept if x != r]
            ok, why = holds(tuple(trial), cf, bounds)
            if ok:
                kept = trial
                o.w(f'  drop {r}: holds without it -> dropped')
            else:
                o.w(f'  drop {r}: {why[0]} {why[1]} breaks ({why[2]}) -> kept')
        fin = []
        for r in kept:
            ok, why = holds(tuple(x for x in kept if x != r), cf, bounds)
            fin.append(f'{r}: {"NOT NEEDED" if ok else "needed (" + " ".join(why) + ")"}')
        o.w(f'  smallest set: {"+".join(kept)}; final pass: ' + '; '.join(fin))
    # R3 alone in place of W1: does an epoch after a power loss cover what W1 covers?
    block(o, 'R3+O.seq+Y in place of W1 (an epoch after a power loss, no wait for disk in the library)',
          cf, ('R3', 'O.seq', 'Y'), bounds, show='min')
    o.close()


def step_s2():
    o = Out('s2', 'S2 (commit in memory, answer per write): which rules it needs')
    c3 = configs([f'S2-{s}' for s in S2ST])
    sets = [
        ('W1 (the library waits for disk; = MEMORY.md (e1) for transactions, claims and fenced writes)', ('W1',)),
        ('W1+O.seq+Y', ('W1', 'O.seq', 'Y')),
        ('W1+RD.txn+O.seq+Y (e1 plus readers of transaction keys read the disk prefix)', ('W1', 'RD.txn', 'O.seq', 'Y')),
        ('W1+RD+O.seq+Y (every reader reads the disk prefix)', ('W1', 'RD', 'O.seq', 'Y')),
        ('R2+O.seq+Y (E-47\'s refusal, per write: no transaction, claim or fenced write on S2 at all)', ('R2', 'O.seq', 'Y')),
        ('R1s+R3+R2.claim+O.seq+Y (E-47\'s rich set)', ('R1s', 'R3', 'R2.claim', 'O.seq', 'Y')),
        ('R1s+R3+R2.claim+RD.plain+O.seq+Y', ('R1s', 'R3', 'R2.claim', 'RD.plain', 'O.seq', 'Y')),
    ]
    good = None
    for name, rules in sets:
        bad = block(o, name, c3, rules, ALLB + ALLC, show='min')
        if not bad and good is None:
            good = rules
    if good:
        parts = sorted(M.expand(good))
        o.w()
        o.w(f'# the first set that holds, {"+".join(good)}: each part dropped, on S2-mem (where every part acts)')
        for r in parts:
            block(o, f'{"+".join(good)} without {r}', configs(['S2-mem']), good, ALLB + ALLC, drop=(r,),
                  show='min')
    o.close()


def step_verify():
    o = Out('verify', 'the sets that hold, on larger bounds (state limit 6 million)')
    block(o, 'S0 with O.seq', configs(['S0']), ('O.seq',), VERIFYB, show='min', limit=6_000_000)
    block(o, 'S1 with W1+O.seq+Y', configs(['S1-recv', 'S1-mixr']), S1SET, VERIFYB, show='min', limit=6_000_000)
    block(o, 'S1, no rules (the larger bounds still break)', configs(['S1-recv']), (), VERIFYB, show='min',
          limit=6_000_000)
    o.close()


STEPS = {'base': step_base, 'crash': step_crash, 'info': step_info, 'rules': step_rules, 'subs': step_subs,
         'greedy': step_greedy, 's2': step_s2, 'verify': step_verify}

if __name__ == '__main__':
    os.makedirs(RES, exist_ok=True)
    for s in sys.argv[1:] or list(STEPS):
        STEPS[s]()
