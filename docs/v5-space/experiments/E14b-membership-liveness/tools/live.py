#!/usr/bin/env python3
"""live.py: E-14b's TLC runs on MCferolive.tla (E-14's model plus stated
reductions), in segments of at most one heavy-lock hold each.

  python3 tools/live.py --list
  python3 tools/live.py RUN [RUN ...] [--seg-secs S] [--max-seg K] [--heap 5g] [--stubs]

A run with a graph (liveness) dumps TLC's state graph through a FIFO into
tools/dotfilter.py, which keeps only the flags and edges. A run longer than
one hold is split: TLC checkpoints every few minutes (-checkpoint), stops
by itself at --seg-secs (-Dtlc2.TLC.stopAfter, which closes the dump
cleanly), and the next segment, in a new hold, resumes from the last
checkpoint (-recover). Each segment writes its own graph file; agef2.py
reads them together. A run's state lives in $E14B_WORK/<run>/state.json,
so a run can be continued later by naming it again.

Writes results/<run>.txt (the segments' TLC output, trimmed, and the AG EF
result) and results/runs.json (one summary row per run).
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import agef2  # noqa: E402

SCEN = {
    # name: (voters, learners, joiners): E-14's scenarios
    'three': (['s1', 's2', 's3'], [], []),
    'three+spare': (['s1', 's2', 's3'], [], ['s4']),
    'four': (['s1', 's2', 's3'], ['s4'], []),
    'two': (['s1', 's2'], ['s3'], []),
    'one': (['s1'], ['s2', 's3'], []),
    'four-voters': (['s1', 's2', 's3', 's4'], [], []),
}

# E-14's defaults (tools/run.py BASE) plus E-14b's two reductions.
BASE = dict(ReconfigurationLimit=2, MaxTermLimit=5, RequestLimit=0, FaultLimit=1,
            FeroRules=True, OnAppend=False, AllowDup=False, AllowLoseDisk=False,
            AllowRestart=False, AllowSnapshot=False, GhostReturn=False, CoarseAE=True, InitLeader=True,
            AllowDrop=True, AllowStepDown=True, LeaderLease=False, Plan='all', EagerApply=False,
            CrashLeaderOnly=False, InitR21=False, R6=True,
            EagerReady=True, BatchVote=True, EagerNet=True, DeadView=True)
# The reductions (MCferolive.tla's header): R1 EagerReady, R2 BatchVote,
# R3 DeadView (exact), R4 EagerNet (a coarsening). NONE turns all four off.
NONE = dict(EagerReady=False, BatchVote=False, EagerNet=False, DeadView=False)
RB = dict(EagerReady=True, BatchVote=True, EagerNet=False, DeadView=False)
RBD = dict(EagerReady=True, BatchVote=True, EagerNet=False, DeadView=True)

FP = 7   # TLC's fingerprint polynomial index, the same for every segment

SAFETY = ['LogInv', 'MoreThanOneLeaderInv', 'ElectionSafetyInv', 'LogMatchingInv',
          'QuorumLogInvLive', 'MoreUpToDateCorrectInv', 'LeaderCompletenessInv',
          'CommittedIsDurableInv']

RUNS = {}


def run(name, scen, dot=True, sym=True, invs=None, spec='LiveSpec', **kw):
    RUNS[name] = dict(scen=scen, kw=kw, dot=dot, sym=sym, invs=invs or SAFETY, spec=spec)


# The liveness runs: E-14's LIVE settings (crashes as the fault, at most one;
# a recovery is free; LeaderLease; no message loss), the healing plan of
# each scenario, two changes (one for four-voters), terms up to 4 (Q-14's
# own bound; judged at 2 or lower, so every judged state has two elections
# in hand), which this shared box can finish.
LIVE = dict(AllowDrop=False, AllowStepDown=False, LeaderLease=True)
T4 = dict(MaxTermLimit=4, **LIVE)
run('four-voters', 'four-voters', Plan='demote', ReconfigurationLimit=1, **T4)
# The first four-voters run, at terms up to 5 (kept for its safety result;
# its graph broke at segment joins, see README):
run('four-voters-t5', 'four-voters', Plan='demote', ReconfigurationLimit=1, **LIVE)
run('four', 'four', Plan='swap', **T4)
run('two', 'two', Plan='stepback', **T4)
run('one', 'one', Plan='grow', **T4)
# one breaks QuorumLogInvLive in a state where a lagging learner's applied
# config is still the genesis {s1}; the same run without that one invariant
# checks the other seven over the whole space, and gives one's AG EF.
run('one-noq', 'one', Plan='grow', invs=[x for x in SAFETY if x != 'QuorumLogInvLive'], **T4)
run('three-disk', 'three+spare', Plan='replace', AllowLoseDisk=True, **T4)
# learners refuse votes (E-14's R6 = FALSE), on commit
run('four-novote', 'four', Plan='swap', R6=False, **T4)
run('one-novote', 'one', Plan='grow', R6=False, **T4)
run('two-novote', 'two', Plan='stepback', R6=False, **T4)
# the mutant: a config takes effect when appended
run('four-voters-append', 'four-voters', Plan='demote', ReconfigurationLimit=1, OnAppend=True, **T4)
run('four-append', 'four', Plan='swap', OnAppend=True, **T4)
run('two-append', 'two', Plan='stepback', OnAppend=True, **T4)
run('one-append', 'one', Plan='grow', OnAppend=True, **T4)
run('three-disk-append', 'three+spare', Plan='replace', AllowLoseDisk=True, OnAppend=True, **T4)
# a lost disk that returns under its old id (must break safety), no graph
run('three-ghost', 'three', Plan='all', ReconfigurationLimit=1, AllowLoseDisk=True, GhostReturn=True, dot=False,
    **T4)
# The same, without QuorumLogInvLive (the first invariant three-ghost
# breaks), to see whether a committed entry is really lost after it.
run('three-ghost-loss', 'three', Plan='all', ReconfigurationLimit=1, AllowLoseDisk=True, GhostReturn=True, dot=False,
    invs=[x for x in SAFETY if x != 'QuorumLogInvLive'], **T4)
run('three-disk-noghost', 'three', Plan='all', ReconfigurationLimit=1, AllowLoseDisk=True, dot=False, **T4)
# E-14's R2-1 pair, on E-14b's model: with every reduction, with R1+R2 only
# (the first runs), with R1-R3, and with none, to check the reductions keep
# both verdicts.
R21 = dict(Plan='demote', ReconfigurationLimit=0, FaultLimit=0, InitR21=True, MaxTermLimit=4, **LIVE)
CAL = SAFETY + ['EagerNetOK']
run('r21', 'four-voters', invs=CAL, **R21)
run('r21-rb', 'four-voters', **dict(R21, **RB))
run('r21-rbd', 'four-voters', **dict(R21, **RBD))
run('r21-append', 'four-voters', invs=CAL, OnAppend=True, **R21)
run('r21-append-rb', 'four-voters', OnAppend=True, **dict(R21, **RB))
run('r21-append-none', 'four-voters', OnAppend=True, **dict(R21, **NONE))
# R2-1 with one more crash allowed (any of B, C, D): a calibration of the
# reductions with a fault, small enough to finish without R3 and R4.
R21F = dict(R21, FaultLimit=1)
run('r21f', 'four-voters', invs=CAL, **R21F)
run('r21f-rb', 'four-voters', **dict(R21F, **RB))
# Small whole scenarios, each with and without EagerNet (the coarsening):
# three voters, one change of any kind, no fault / one crash.
C3 = dict(Plan='all', ReconfigurationLimit=1, FaultLimit=0, MaxTermLimit=4, **LIVE)
run('three-1c', 'three', invs=CAL, **C3)
run('three-1c-rbd', 'three', **dict(C3, **RBD))
run('three-1c-rb', 'three', **dict(C3, **RB))
C3F = dict(C3, FaultLimit=1)
run('three-1c1f', 'three', invs=CAL, **C3F)
run('three-1c1f-rbd', 'three', **dict(C3F, **RBD))
C2 = dict(Plan='stepback', ReconfigurationLimit=1, FaultLimit=1, MaxTermLimit=4, **LIVE)
run('two-1c1f', 'two', invs=CAL, **C2)
run('two-1c1f-rbd', 'two', **dict(C2, **RBD))
# The same small scenario on append (the mutant), for the stuck state
# two-1c1f found (a promotion from two voters committed, the leader lost
# before the other voter learns it).
run('two-1c1f-append', 'two', OnAppend=True, **C2)
# ... and with learners refusing votes (R6 = FALSE), to see whether
# "learners vote" is a rule the design needs.
run('two-1c1f-novote', 'two', R6=False, **C2)


def cfg_text(r):
    voters, learners, joiners = SCEN[r['scen']]
    server = voters + learners + joiners
    kw = dict(BASE)
    kw.update(r['kw'])

    def tla(v):
        if isinstance(v, bool):
            return 'TRUE' if v else 'FALSE'
        if isinstance(v, str):
            return '"%s"' % v
        return str(v)

    def st(xs):
        return '{' + ', '.join(xs) + '}'
    lines = ['SPECIFICATION %s' % r['spec'], 'CONSTANTS',
             '    Server = %s' % st(server),
             '    InitServer = %s' % st(voters + learners),
             '    InitVoters = %s' % st(voters),
             '    InitLearners = %s' % st(learners),
             '    Joiners = %s' % st(joiners)]
    for k in sorted(kw):
        lines.append('    %s = %s' % (k, tla(kw[k])))
    lines += ['    Send <- FeroSend', '    Reply <- FeroReply',
              '    GetJointConfig <- MCGetJointConfig', '    GetLearners <- MCGetLearners',
              '    Nil = Nil', '    ValueEntry = "ValueEntry"', '    ConfigEntry = "ConfigEntry"',
              '    Follower = "Follower"', '    Candidate = "Candidate"', '    Leader = "Leader"',
              '    RequestVoteRequest = "RequestVoteRequest"',
              '    RequestVoteResponse = "RequestVoteResponse"',
              '    AppendEntriesRequest = "AppendEntriesRequest"',
              '    AppendEntriesResponse = "AppendEntriesResponse"']
    if r['sym']:
        lines.append('SYMMETRY Symmetry')
    lines += ['VIEW LView', 'CHECK_DEADLOCK FALSE', 'INVARIANTS'] + ['    ' + i for i in r['invs']]
    return '\n'.join(lines) + '\n'


def tla_dir_default():
    return None


def prepare(name, r, stubs, mutant_src=None):
    wd = C.fresh_dir(name)
    C.stage(wd, stubs)
    if mutant_src:
        open(os.path.join(wd, 'MCferoraft.tla'), 'w').write(mutant_src)
    with open(os.path.join(wd, name + '.cfg'), 'w') as f:
        f.write(cfg_text(r))
    os.makedirs(os.path.join(C.HERE, 'cfg'), exist_ok=True)
    if not name.startswith('mut-'):
        shutil.copy(os.path.join(wd, name + '.cfg'), os.path.join(C.HERE, 'cfg', name + '.cfg'))
    return wd


def segment(name, wd, r, k, seg_secs, ckpt_min, workers, heap, stubs, labels):
    cmd = C.heavy() + ['timeout', str(seg_secs + 300), 'java', '-XX:+UseParallelGC', '-Xmx' + heap,
           '-Dtlc2.TLC.stopAfter=%d' % seg_secs,
           # -fp: TLC picks its fingerprint polynomial at random per process
           # unless told, and -recover does not restore it, so every segment
           # of a run must name the same one (found here: without it, states
           # carried across a checkpoint get new ids and the graph breaks).
           '-cp', C.classpath(stubs), 'tlc2.TLC', '-fp', str(FP), '-workers', str(workers), '-nowarning',
           '-checkpoint', str(ckpt_min), '-metadir', 'st', '-config', name + '.cfg']
    if k > 1:
        last = glob.glob(os.path.join(wd, 'st', '*', 'vars.chkpt'))
        if not last:
            raise SystemExit('%s: no checkpoint to resume from' % name)
        rec = os.path.dirname(max(last, key=os.path.getmtime))
        cmd += ['-recover', os.path.relpath(rec, wd)]
    gz = None
    fifo = os.path.join(wd, 'seg%d.dot' % k)
    if r['dot']:
        if os.path.exists(fifo):
            os.remove(fifo)
        os.mkfifo(fifo)
        fl = ['--labels'] if labels else []
        gz = subprocess.Popen([sys.executable, os.path.join(C.HERE, 'tools', 'dotfilter.py'), fifo,
                               os.path.join(wd, 'seg%d' % k)] + fl,
                              stderr=open(os.path.join(wd, 'seg%d.filter.log' % k), 'w'))
        cmd += ['-dump', 'dot,actionlabels', fifo]
    cmd.append('MCferolive.tla')
    t0 = time.time()
    logp = os.path.join(wd, 'seg%d.out' % k)
    with open(logp, 'w') as lf:
        p = subprocess.run(cmd, cwd=wd, stdout=lf, stderr=subprocess.STDOUT, text=True)
    if gz:
        if gz.poll() is None:
            try:   # TLC never opened the pipe: open it once so the filter ends
                fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                os.close(fd)
            except OSError:
                pass
        gz.wait()
        os.remove(fifo)
    out = open(logp).read()
    return out, time.time() - t0, p.returncode


def go(name, seg_secs=1500, max_seg=1, ckpt_min=4, workers=2, heap='5g', stubs=False, labels=True,
       mutant_src=None, r=None, result_name=None, judge=None, redo=False, results_dir=None, record=True,
       max_total=None):
    r = r or RUNS[name]
    kw = dict(BASE)
    kw.update(r['kw'])
    wd = os.path.join(C.WORK, name)
    stp = os.path.join(wd, 'state.json')
    st = json.load(open(stp)) if os.path.exists(stp) else None
    rn = result_name or name
    rdir = results_dir or C.RESULTS
    allp = os.path.join(rdir, 'runs.json')
    if st and st.get('done') and not redo and os.path.exists(allp) and record:
        prev = json.load(open(allp)).get(rn)
        if prev:
            return prev
    if st is None or st.get('done'):
        wd = prepare(name, r, stubs, mutant_src)
        st = dict(segments=0, secs=[], done=False, stubs=stubs)
    for _ in range(max_seg):
        if st['done']:
            break
        if max_total and st['segments'] >= max_total:
            print('%s: stopped unfinished after %d segments (the cap)' % (name, st['segments']), flush=True)
            break
        left = C.time_left()
        if left < 240:
            print('%s: no time left in this hold' % name, flush=True)
            break
        k = st['segments'] + 1
        out, secs, rc = segment(name, wd, r, k, int(min(seg_secs, left - 90)), ckpt_min, workers, heap,
                                st['stubs'], labels)
        s = C.summary(out)
        st['segments'] = k
        st['secs'].append(round(secs))
        st['last'] = s
        st['done'] = bool(s['complete'] or s['violated'] or s['error'])
        json.dump(st, open(stp, 'w'))
        print('%-24s seg %d: %.0f s  %s' % (name, k, secs, json.dumps(s)), flush=True)
    if st['segments'] == 0 or 'last' not in st:
        return dict(name=name, segments=0, done=False)
    res = dict(name=name, scen=r['scen'], kw=r['kw'], segments=st['segments'], secs=sum(st['secs']),
               stubs=st['stubs'], **st['last'])
    agef_text = ''
    if st['done'] and r['dot'] and st['last']['complete']:
        segs = sorted(glob.glob(os.path.join(wd, 'seg*.g.gz')))
        labs = sorted(glob.glob(os.path.join(wd, 'seg*.l.gz')))
        j = judge if judge is not None else kw['MaxTermLimit'] - 2
        a, agef_text = agef2.check(segs, j, 1, labs)
        res['agef'] = a
    if st['segments'] == 0:
        return dict(name=name, segments=0, done=False)
    os.makedirs(os.path.dirname(os.path.join(rdir, rn + '.txt')), exist_ok=True)
    with open(os.path.join(rdir, rn + '.txt'), 'w') as f:
        f.write('# run %s: scenario %s, %s\n' % (name, r['scen'], json.dumps(r['kw'], sort_keys=True)))
        f.write('# spec %s (MCferolive.tla), %s, %d segment(s), %s s wall in all, TLC -workers %d\n' % (
            r['spec'], 'E-14 stand-ins' if st['stubs'] else 'CommunityModules-deps.jar', st['segments'],
            st['secs'], workers))
        f.write('# done: %s\n' % st['done'])
        for k in range(1, st['segments'] + 1):
            lp = os.path.join(wd, 'seg%d.out' % k)
            if not os.path.exists(lp):
                continue
            lines = C.trim(open(lp).read()).splitlines()
            prog = [l for l in lines if l.startswith('Progress(')]
            other = [l for l in lines if not l.startswith('Progress(')]
            if len(prog) > 6:
                prog = prog[:2] + ['... (%d progress lines)' % (len(prog) - 4)] + prog[-2:]
            if len(other) > 260:
                other = other[:130] + ['... (%d lines cut)' % (len(other) - 260)] + other[-130:]
            f.write('\n## segment %d\n' % k + '\n'.join(other[:6] + prog + other[6:]) + '\n')
        if agef_text:
            if len(agef_text) > 300000:
                agef_text = agef_text[:300000] + '\n... (trace cut)\n'
            f.write('\n# agef2.py (AG EF goal over progress steps)\n' + agef_text + '\n')
    res['done'] = st['done']
    if record:
        allr = json.load(open(allp)) if os.path.exists(allp) else {}
        allr[rn] = res
        json.dump(allr, open(allp, 'w'), indent=1, sort_keys=True)
    # drop the big graph files once a run is judged validly, unless kept
    if (st['done'] and 'agef' in res and res['agef'].get('result') != 'INVALID'
            and not os.environ.get('E14B_KEEP')):
        for g in glob.glob(os.path.join(wd, 'seg*.l.gz')) + glob.glob(os.path.join(wd, 'seg*.g.gz')):
            os.remove(g)
        shutil.rmtree(os.path.join(wd, 'st'), ignore_errors=True)
    return res


def main():
    a = sys.argv[1:]
    if not a or '--list' in a:
        for n, r in RUNS.items():
            print(n, r['scen'], r['kw'], 'graph' if r['dot'] else '')
        return

    def opt(k, d, f=int):
        return f(a[a.index(k) + 1]) if k in a else d
    seg = opt('--seg-secs', 1500)
    mx = opt('--max-seg', 1)
    w = opt('--workers', 2)
    heap = opt('--heap', '5g', str)
    mt = opt('--max-total', None)
    names = [x for i, x in enumerate(a) if not x.startswith('--') and (i == 0 or not a[i - 1].startswith('--'))]
    for n in names:
        res = go(n, seg_secs=seg, max_seg=mx, workers=w, heap=heap, stubs='--stubs' in a,
                 labels='--no-labels' not in a, redo='--redo' in a, max_total=mt)
        print('==> %s: %s' % (n, json.dumps({k: res.get(k) for k in ('distinct', 'depth', 'violated', 'complete', 'secs')})
                               + ('  agef ' + json.dumps({k: res['agef'][k] for k in ('result', 'states', 'stuck_live', 'judged')}) if 'agef' in res else '')),
              flush=True)


if __name__ == '__main__':
    main()
