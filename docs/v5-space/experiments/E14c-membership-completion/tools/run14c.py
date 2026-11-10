#!/usr/bin/env python3
"""run14c.py: E-14c's TLC runs on MCferoc.tla (E-14b's reduced model plus
the history variable ctl and the replacement invariants), in segments of
at most one heavy-lock hold each. Adapted from E-14b's tools/live.py; the
segment machinery is the same (-checkpoint, -Dtlc2.TLC.stopAfter,
-recover, the same -fp in every segment).

  python3 tools/run14c.py --list
  python3 tools/run14c.py RUN [RUN ...] [--seg-secs S] [--max-seg K] [--heap 5g] [--redo]

A run with a graph (liveness) dumps TLC's state graph through a FIFO into
tools/dotfilter.py, which keeps the flags and edges; tools/agef2.py then
checks AG EF over all segments. A run's state lives in
$E14C_WORK/<run>/state.json, so it can be continued by naming it again.

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

# E-14b's BASE (E-14's defaults plus its four reductions), unchanged.
BASE = dict(ReconfigurationLimit=2, MaxTermLimit=5, RequestLimit=0, FaultLimit=1,
            FeroRules=True, OnAppend=False, AllowDup=False, AllowLoseDisk=False,
            AllowRestart=False, AllowSnapshot=False, GhostReturn=False, CoarseAE=True, InitLeader=True,
            AllowDrop=True, AllowStepDown=True, LeaderLease=False, Plan='all', EagerApply=False,
            CrashLeaderOnly=False, InitR21=False, R6=True,
            EagerReady=True, BatchVote=True, EagerNet=True, DeadView=True)

FP = 7   # the same fingerprint polynomial in every segment (E-14b's second trap)

# E-14b's eight (etcd's shipped seven, QuorumLogInv as QuorumLogInvLive).
SHIPPED = ['LogInv', 'MoreThanOneLeaderInv', 'ElectionSafetyInv', 'LogMatchingInv',
           'QuorumLogInvLive', 'MoreUpToDateCorrectInv', 'LeaderCompletenessInv',
           'CommittedIsDurableInv']
# E-14c's set: the two too-strong ones replaced, one new (MCferoc.tla).
NEW = ['LogInv', 'MoreThanOneLeaderInv', 'ElectionSafetyInv', 'LogMatchingInv',
       'VoteQuorumInv', 'CommittedQuorumInv', 'MoreUpToDateCorrectInv', 'LeaderCompletenessRaftInv',
       'CommittedIsDurableInv', 'CommittedNeverLostInv']

RUNS = {}


def run(name, scen, dot=True, sym=True, invs=None, patch=None, judge_off=2, **kw):
    RUNS[name] = dict(scen=scen, kw=kw, dot=dot, sym=sym, invs=invs or NEW, patch=patch, judge_off=judge_off)


# E-14b's liveness settings: crashes as the fault (at most one; recovery is
# free, not a progress step), LeaderLease, no message loss, the scenario's
# healing plan, two changes, terms up to 4, judged at 2 or lower.
LIVE = dict(AllowDrop=False, AllowStepDown=False, LeaderLease=True)
T4 = dict(MaxTermLimit=4, **LIVE)

# --- step 3: the two scenarios E-14b could not finish, at its bounds.
run('three-disk', 'three+spare', Plan='replace', AllowLoseDisk=True, **T4)
run('four', 'four', Plan='swap', **T4)
# The full runs grow past 20 million states each (README), more than this
# study's CPU budget. So the same scenarios at the smallest bound that still
# holds the scenario: a crash only of the current leader (and, in
# three-disk, a lost disk of any member, as before).
run('four-lc', 'four', Plan='swap', CrashLeaderOnly=True, **T4)
run('three-disk-lc', 'three+spare', Plan='replace', AllowLoseDisk=True, CrashLeaderOnly=True, **T4)

# --- step 1: the replacements on runs E-14b finished or stopped (cost of
# the history variable; the old false alarms gone).
run('one', 'one', Plan='grow', **T4)                       # E-14b: QuorumLogInvLive false alarm
C3F = dict(Plan='all', ReconfigurationLimit=1, FaultLimit=1, MaxTermLimit=4, **LIVE)
run('three-1c1f', 'three', **C3F)                          # E-14b: 555,676 states, PASS (the history variable's cost)
run('three-1c', 'three', **dict(C3F, FaultLimit=0))        # E-14b: 12,098 states, PASS (a smoke test)
C2 = dict(Plan='stepback', ReconfigurationLimit=1, FaultLimit=1, MaxTermLimit=4, **LIVE)
run('two-1c1f', 'two', **C2)                               # E-14b: 64,245 states, the two-voter window


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
    lines = ['SPECIFICATION CSpec', 'CONSTANTS',
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
    lines += ['VIEW CView', 'CHECK_DEADLOCK FALSE', 'INVARIANTS'] + ['    ' + i for i in r['invs']]
    return '\n'.join(lines) + '\n'


def prepare(name, r, keep_cfg=True):
    wd = C.fresh_dir(name)
    C.stage(wd, r.get('patch'))
    with open(os.path.join(wd, name + '.cfg'), 'w') as f:
        f.write(cfg_text(r))
    if keep_cfg:
        os.makedirs(os.path.join(C.HERE, 'cfg'), exist_ok=True)
        shutil.copy(os.path.join(wd, name + '.cfg'), os.path.join(C.HERE, 'cfg', name + '.cfg'))
    return wd


def segment(name, wd, r, k, seg_secs, ckpt_min, workers, heap, labels):
    cmd = C.heavy() + ['timeout', str(seg_secs + 300), 'java', '-XX:+UseParallelGC', '-Xmx' + heap,
           '-Dtlc2.TLC.stopAfter=%d' % seg_secs,
           '-cp', C.classpath(), 'tlc2.TLC', '-fp', str(FP), '-workers', str(workers), '-nowarning',
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
    cmd.append('MCferoc.tla')
    t0 = time.time()
    logp = os.path.join(wd, 'seg%d.out' % k)
    with open(logp, 'w') as lf:
        lf.write('# load at start: %s' % open('/proc/loadavg').read())
        lf.flush()
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


def go(name, seg_secs=1500, max_seg=1, ckpt_min=4, workers=2, heap='5g', labels=True, r=None,
       result_name=None, redo=False, results_dir=None, record=True, keep_cfg=True):
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
    if st is None or st.get('done') or redo:
        wd = prepare(name, r, keep_cfg)
        st = dict(segments=0, secs=[], done=False)
    for _ in range(max_seg):
        if st['done']:
            break
        left = C.time_left()
        if left < 240:
            print('%s: no time left in this hold' % name, flush=True)
            break
        k = st['segments'] + 1
        C.offpeak_wait()
        out, secs, rc = segment(name, wd, r, k, int(min(seg_secs, left - 90)), ckpt_min, workers, heap, labels)
        s = C.summary(out)
        st['segments'] = k
        st['secs'].append(round(secs))
        st['last'] = s
        st['done'] = bool(s['complete'] or s['violated'])
        json.dump(st, open(stp, 'w'))
        print('%-24s seg %d: %.0f s  %s' % (name, k, secs, json.dumps(s)), flush=True)
        if s['error']:
            # A TLC error (for example a failed -recover) ends this call but
            # keeps the checkpoints, so the run can be retried or restarted.
            # Seen once: with -workers 1, -recover failed reading a queue pool
            # file the stopped segment had already consumed.
            st['error'] = s['error']
            json.dump(st, open(stp, 'w'))
            break
    if st['segments'] == 0 or 'last' not in st:
        return dict(name=name, segments=0, done=False)
    res = dict(name=name, scen=r['scen'], kw=r['kw'], invs=r['invs'], patched=sorted((r.get('patch') or {}).keys()),
               segments=st['segments'], secs=sum(st['secs']), **st['last'])
    agef_text = ''
    if st['done'] and r['dot'] and st['last']['complete']:
        segs = sorted(glob.glob(os.path.join(wd, 'seg*.g.gz')))
        labs = sorted(glob.glob(os.path.join(wd, 'seg*.l.gz')))
        j = kw['MaxTermLimit'] - r.get('judge_off', 2)
        a, agef_text = agef2.check(segs, j, 1, labs)
        a['judge'] = j
        res['agef'] = a
    os.makedirs(rdir, exist_ok=True)
    with open(os.path.join(rdir, rn + '.txt'), 'w') as f:
        f.write('# run %s: scenario %s, %s\n' % (name, r['scen'], json.dumps(r['kw'], sort_keys=True)))
        f.write('# invariants: %s\n' % ', '.join(r['invs']))
        if r.get('patch'):
            f.write('# patched files: %s\n' % ', '.join(sorted(r['patch'])))
        f.write('# spec CSpec (MCferoc.tla), CommunityModules-deps.jar, %d segment(s), %s s wall, '
                'TLC -workers %d -fp %d\n' % (st['segments'], st['secs'], workers, FP))
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
            and not os.environ.get('E14C_KEEP')):
        for g in glob.glob(os.path.join(wd, 'seg*.l.gz')) + glob.glob(os.path.join(wd, 'seg*.g.gz')):
            os.remove(g)
    if st['done']:
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
    names = [x for i, x in enumerate(a) if not x.startswith('--') and (i == 0 or not a[i - 1].startswith('--'))]
    for n in names:
        res = go(n, seg_secs=seg, max_seg=mx, workers=w, heap=heap, labels='--no-labels' not in a,
                 redo='--redo' in a)
        print('==> %s: %s' % (n, json.dumps({k: res.get(k) for k in ('distinct', 'depth', 'violated', 'complete', 'secs')})
                               + ('  agef ' + json.dumps({k: res['agef'].get(k) for k in ('result', 'states', 'stuck_live', 'judged', 'plan_result')}) if 'agef' in res else '')),
              flush=True)


if __name__ == '__main__':
    main()
