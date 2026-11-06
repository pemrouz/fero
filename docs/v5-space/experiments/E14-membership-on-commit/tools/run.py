#!/usr/bin/env python3
"""run.py: E-14's TLC runs. Each run is a named set of constants for
MCferoraft.tla (or MCetcdraft.tla as shipped). It writes the .cfg, runs TLC
under the study's heavy lock, optionally dumps the state graph and runs
agef.py on it, and saves the trimmed log in results/.

  python3 tools/run.py --list
  python3 tools/run.py RUN [RUN ...] [--keep-dot]

Environment: SP (the scratchpad), TLA_JAR (tla2tools.jar), RAFT_TLA (etcd's
raft/tla folder). run.sh sets them.
"""
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
JAR = os.environ.get('TLA_JAR', SP + '/dl/tla/tla2tools.jar')
RAFT_TLA = os.environ.get('RAFT_TLA', SP + '/dl/raftsrc/raft/tla')
HEAVY = os.environ.get('HEAVY', SP + '/bin/heavy')
WORK = os.environ.get('E14_WORK', SP + '/e14/runs')

SCEN = {
    # name: (voters, learners, joiners)
    'three': (['s1', 's2', 's3'], [], []),
    'three+spare': (['s1', 's2', 's3'], [], ['s4']),
    'four': (['s1', 's2', 's3'], ['s4'], []),
    'two': (['s1', 's2'], ['s3'], []),
    'one': (['s1'], ['s2', 's3'], []),
    'four-voters': (['s1', 's2', 's3', 's4'], [], []),
}

BASE = dict(ReconfigurationLimit=2, MaxTermLimit=5, RequestLimit=0, FaultLimit=1,
            FeroRules=True, OnAppend=False, AllowDup=False, AllowLoseDisk=False,
            AllowRestart=False, AllowSnapshot=False, GhostReturn=False, CoarseAE=True, InitLeader=True, AllowDrop=True, AllowStepDown=True, LeaderLease=False, Plan='all', EagerApply=False, CrashLeaderOnly=False, InitR21=False,
            R6=True)

SAFETY = ['LogInv', 'MoreThanOneLeaderInv', 'ElectionSafetyInv', 'LogMatchingInv',
          'QuorumLogInvLive', 'MoreUpToDateCorrectInv', 'LeaderCompletenessInv',
          'CommittedIsDurableInv']

# Each run: scenario, overrides, whether to dump the graph for agef.
RUNS = {}


def run(name, scen, dot=True, sym=True, invs=None, **kw):
    RUNS[name] = dict(scen=scen, kw=kw, dot=dot, sym=sym, invs=invs or SAFETY)


# --- the design (on commit, etcd's code rules) ---------------------------
# Liveness runs (with the graph and agef.py): faults are crashes (and lost
# disks where the scenario has a spare id); terms <= 5; the healing plan of
# each scenario (tla/MCferoraft.tla, PlanOK) picks which changes the leader
# may make, in any order and at any time.
LIVE = dict(AllowDrop=False, AllowStepDown=False, LeaderLease=True)
run('four', 'four', Plan='swap', **LIVE)                         # healing.py `four`: a swap; a cut-off leader demotes a member
run('four-voters', 'four-voters', Plan='demote', ReconfigurationLimit=1, **LIVE)
run('four-eager', 'four', Plan='swap', EagerApply=True, CrashLeaderOnly=True, **LIVE)
run('four-voters-eager', 'four-voters', Plan='demote', ReconfigurationLimit=1, EagerApply=True, CrashLeaderOnly=True, **LIVE)
# healing.py's R2-1, from the state just after the fault: on commit, and on append
run('r21', 'four-voters', Plan='demote', ReconfigurationLimit=0, FaultLimit=0, InitR21=True, MaxTermLimit=4, **LIVE)
run('r21-append', 'four-voters', Plan='demote', ReconfigurationLimit=0, FaultLimit=0, InitR21=True, OnAppend=True, MaxTermLimit=4, **LIVE)
# The same two, asking only whether the goal is reachable from that state
# (no graph): TLC stops at the first goal state, or finishes and shows none.
run('r21-ef', 'four-voters', Plan='demote', ReconfigurationLimit=0, FaultLimit=0, InitR21=True, MaxTermLimit=4,
    dot=False, invs=SAFETY + ['NotGoal'], **{k: v for k, v in LIVE.items()})
run('r21-append-ef', 'four-voters', Plan='demote', ReconfigurationLimit=0, FaultLimit=0, InitR21=True, OnAppend=True,
    MaxTermLimit=4, dot=False, invs=SAFETY + ['NotGoal'], **{k: v for k, v in LIVE.items()})
run('two', 'two', Plan='stepback', **LIVE)                       # two voters back to one (or growth to three)
run('one', 'one', Plan='grow', **LIVE)                           # one voter grows to three
run('three-disk', 'three+spare', Plan='replace', AllowLoseDisk=True, **LIVE)   # a lost disk comes back as a new id
run('three-all', 'three', Plan='all', ReconfigurationLimit=1, **LIVE)          # any one change, three voters
# Safety-only runs with every fault kind (crash, lost disk, message loss and
# duplication, a leader or candidate giving up, instant restart), no lease,
# no graph; they may hit the 25-minute cap, and then report what they reached.
ALLF = dict(AllowDrop=True, AllowStepDown=True, AllowDup=True, AllowRestart=True, LeaderLease=False, dot=False)
run('four-voters-allf', 'four-voters', Plan='demote', ReconfigurationLimit=1, **ALLF)
run('two-allf', 'two', Plan='stepback', **ALLF)
run('three-disk-allf', 'three+spare', Plan='replace', AllowLoseDisk=True, **ALLF)
run('four-f2', 'four', Plan='swap', FaultLimit=2, AllowDrop=False, AllowStepDown=False, LeaderLease=True, dot=False)
# From genesis (no leader yet), so the first election is in the search too.
run('four-voters-genesis', 'four-voters', Plan='demote', ReconfigurationLimit=1, InitLeader=False, **LIVE)
# --- the mutant: a config takes effect when appended ----------------------
run('four-append', 'four', Plan='swap', OnAppend=True, **LIVE)
run('four-voters-append', 'four-voters', Plan='demote', ReconfigurationLimit=1, OnAppend=True, **LIVE)
run('four-eager-append', 'four', Plan='swap', EagerApply=True, CrashLeaderOnly=True, OnAppend=True, **LIVE)
run('four-voters-eager-append', 'four-voters', Plan='demote', ReconfigurationLimit=1, EagerApply=True, CrashLeaderOnly=True, OnAppend=True, **LIVE)
run('two-append', 'two', Plan='stepback', OnAppend=True, **LIVE)
run('one-append', 'one', Plan='grow', OnAppend=True, **LIVE)
# --- learners refuse votes (R6 off), on commit -----------------------------
run('four-novote', 'four', Plan='swap', R6=False, **LIVE)
run('one-novote', 'one', Plan='grow', R6=False, **LIVE)
run('four-novote-eager', 'four', Plan='swap', R6=False, EagerApply=True, CrashLeaderOnly=True, **LIVE)
# --- the shipped membership actions (FeroRules = FALSE), safety only -------
run('three-shipped', 'three+spare', Plan='all', FeroRules=False, RequestLimit=1, dot=False,
    **dict(AllowDrop=False, AllowStepDown=False, LeaderLease=False))
# --- a lost disk that returns under its old id (must break safety) --------
run('three-ghost', 'three', Plan='all', ReconfigurationLimit=1, AllowLoseDisk=True, GhostReturn=True, dot=False,
    **dict(AllowDrop=False, AllowStepDown=False, LeaderLease=True))


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
    lines = ['SPECIFICATION FeroSpec', 'CONSTANTS',
             '    Server = %s' % st(server),
             '    InitServer = %s' % st(voters + learners),
             '    InitVoters = %s' % st(voters),
             '    InitLearners = %s' % st(learners),
             '    Joiners = %s' % st(joiners)]
    for k in sorted(kw):
        lines.append('    %s = %s' % (k, tla(kw[k])))
    lines += ['    Send <- FeroSend',
              '    Reply <- FeroReply',
              '    GetJointConfig <- MCGetJointConfig',
              '    GetLearners <- MCGetLearners',
              '    Nil = Nil',
              '    ValueEntry = "ValueEntry"', '    ConfigEntry = "ConfigEntry"',
              '    Follower = "Follower"', '    Candidate = "Candidate"', '    Leader = "Leader"',
              '    RequestVoteRequest = "RequestVoteRequest"',
              '    RequestVoteResponse = "RequestVoteResponse"',
              '    AppendEntriesRequest = "AppendEntriesRequest"',
              '    AppendEntriesResponse = "AppendEntriesResponse"']
    if r['sym']:
        lines.append('SYMMETRY Symmetry')
    lines.append('VIEW FeroView')
    lines.append('CHECK_DEADLOCK FALSE')
    lines.append('INVARIANTS')
    lines += ['    ' + i for i in r['invs']]
    return '\n'.join(lines) + '\n'


def prepare(name, r, tla_dir=None):
    wd = os.path.join(WORK, name)
    if os.path.isdir(wd):
        shutil.rmtree(wd)
    os.makedirs(wd)
    shutil.copy(os.path.join(RAFT_TLA, 'etcdraft.tla'), wd)
    src = tla_dir or os.path.join(HERE, 'tla')
    for f in os.listdir(src):
        if f.endswith('.tla'):
            shutil.copy(os.path.join(src, f), wd)
    with open(os.path.join(wd, name + '.cfg'), 'w') as f:
        f.write(cfg_text(r))
    shutil.copy(os.path.join(wd, name + '.cfg'), os.path.join(HERE, 'cfg', name + '.cfg'))
    return wd


def tlc(wd, cfg, spec, dot=None, timeout=1800, workers=2, extra=()):
    cmd = [HEAVY, 'timeout', str(timeout), 'java', '-XX:+UseParallelGC', '-Xmx6g',
           '-cp', JAR, 'tlc2.TLC', '-workers', str(workers), '-cleanup',
           '-config', cfg, '-metadir', os.path.join(wd, 'meta')] + list(extra)
    gz = None
    if dot:
        # TLC writes the graph into a pipe; gzip keeps it small on disk.
        if os.path.exists(dot):
            os.remove(dot)
        os.mkfifo(dot)
        gz = subprocess.Popen('gzip -1 < %s > %s.gz' % (dot, dot), shell=True)
        cmd += ['-dump', 'dot,actionlabels', dot]
    cmd.append(spec)
    t0 = time.time()
    logp = os.path.join(wd, 'tlc.log')
    with open(logp, 'w') as lf:
        p = subprocess.run(cmd, cwd=wd, stdout=lf, stderr=subprocess.STDOUT, text=True)
    if gz:
        if p.returncode != 0 and gz.poll() is None:
            # TLC never opened the pipe: open it once so gzip ends
            try:
                fd = os.open(dot, os.O_WRONLY | os.O_NONBLOCK)
                os.close(fd)
            except OSError:
                pass
        gz.wait()
    with open(logp) as lf:
        out = lf.read()
    return out, time.time() - t0


def trim(out):
    keep = []
    for line in out.splitlines():
        if line.startswith(('Picked up JAVA', 'Semantic processing', 'Linting', 'Parsing file', 'Loading')):
            continue
        keep.append(line)
    return '\n'.join(keep)


def summary(out):
    m = re.search(r'([\d,]+) states generated, ([\d,]+) distinct states found', out)
    d = re.search(r'The depth of the complete state graph search is (\d+)', out)
    viol = re.search(r'Error: Invariant (\w+) is violated', out)
    done = 'Model checking completed. No error has been found.' in out
    return dict(generated=m.group(1) if m else '?', distinct=m.group(2) if m else '?',
                depth=d.group(1) if d else '?', violated=viol.group(1) if viol else None,
                complete=done)


def special_run(name, cfg_src, spec, files, timeout, workers=2):
    wd = os.path.join(WORK, name)
    if os.path.isdir(wd):
        shutil.rmtree(wd)
    os.makedirs(wd)
    for f in files:
        shutil.copy(f, wd)
    shutil.copy(cfg_src, os.path.join(wd, name + '.cfg'))
    out, secs = tlc(wd, name + '.cfg', spec, timeout=timeout, workers=workers)
    s = summary(out)
    with open(os.path.join(HERE, 'results', name + '.txt'), 'w') as f:
        f.write('# run %s: %s with %s, %.0f s wall, cap %d s\n' % (name, spec, os.path.basename(cfg_src), secs, timeout))
        f.write(trim(out) + '\n')
    print('%-16s %6.0f s  %s' % (name, secs, s), flush=True)


STUBS = [os.path.join(HERE, 'tla', f) for f in ('SequencesExt.tla', 'FiniteSetsExt.tla', 'BagsExt.tla')]


def shipped_asis(tmo):
    # MCetcdraft exactly as shipped (its .cfg unchanged), for at most tmo s.
    special_run('shipped-asis', os.path.join(RAFT_TLA, 'MCetcdraft.cfg'), 'MCetcdraft.tla',
                [os.path.join(RAFT_TLA, 'etcdraft.tla'), os.path.join(RAFT_TLA, 'MCetcdraft.tla')] + STUBS, tmo)


def staleconfig(tmo):
    special_run('staleconfig', os.path.join(HERE, 'cfg', 'staleconfig.cfg'), 'MCstaleconfig.tla',
                [os.path.join(RAFT_TLA, 'etcdraft.tla'), os.path.join(RAFT_TLA, 'MCetcdraft.tla'),
                 os.path.join(HERE, 'tla', 'MCstaleconfig.tla')] + STUBS, min(tmo, 600), workers=1)


def stale2(tmo, mutant=None):
    # The stale-config behavior on fero's model: the design, and the mutant
    # without the "no committed configuration left to apply" campaign guard.
    import mutants as M
    name = 'stale2' + ('-mutant' if mutant else '')
    files = [os.path.join(RAFT_TLA, 'etcdraft.tla'), os.path.join(HERE, 'tla', 'MCstale2.tla')] + STUBS
    tmpd = os.path.join(WORK, name + '-src')
    shutil.rmtree(tmpd, ignore_errors=True)
    os.makedirs(tmpd)
    src = open(os.path.join(HERE, 'tla', 'MCferoraft.tla')).read()
    if mutant:
        lines, muts = M.mutants()
        hit = [m for m in muts if m[0] == mutant]
        assert hit, mutant
        ls = list(lines)
        ls[hit[0][1]] = hit[0][2]
        src = '\n'.join(ls)
    open(os.path.join(tmpd, 'MCferoraft.tla'), 'w').write(src)
    special_run(name, os.path.join(HERE, 'cfg', name + '.cfg'), 'MCstale2.tla', files + [os.path.join(tmpd, 'MCferoraft.tla')],
                min(tmo, 600), workers=1)


def r21script(tmo):
    special_run('r21-script', os.path.join(HERE, 'cfg', 'r21-script.cfg'), 'MCr21script.tla',
                [os.path.join(RAFT_TLA, 'etcdraft.tla'), os.path.join(HERE, 'tla', 'MCr21script.tla'),
                 os.path.join(HERE, 'tla', 'MCferoraft.tla')] + STUBS, min(tmo, 600), workers=1)


SPECIAL = {'r21-script': r21script, 'shipped-asis': shipped_asis, 'staleconfig': staleconfig, 'stale2': stale2,
           'stale2-mutant': lambda tmo: stale2(tmo, 'CanCampaign:drop-guard:r20')}


def main():
    args = sys.argv[1:]
    if not args or '--list' in args:
        for n, r in RUNS.items():
            print(n, r['scen'], r['kw'], 'dot' if r['dot'] else '')
        return
    keep = '--keep-dot' in args
    tmo = 1800
    if '--timeout' in args:
        tmo = int(args[args.index('--timeout') + 1])
    os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
    os.makedirs(os.path.join(HERE, 'cfg'), exist_ok=True)
    names = [a for a in args if not a.startswith('--') and not a.isdigit()]
    # A long queue of runs can be steered without stopping it: names in the
    # file $E14_PRIORITY (one per line) run first, once each; names in the
    # file $E14_SKIP are skipped. Unset, both do nothing.
    pri = os.environ.get('E14_PRIORITY', '')
    skip = os.environ.get('E14_SKIP', '')
    if pri and os.path.exists(pri):
        todo = [l.strip() for l in open(pri) if l.strip()]
        open(pri, 'w').close()
        names = todo + names
    if skip and os.path.exists(skip):
        sk = set(l.strip() for l in open(skip) if l.strip())
        names = [n for n in names if n not in sk or n in locals().get('todo', [])]
    for name in names:
        if name in SPECIAL:
            SPECIAL[name](tmo)
            continue
        r = RUNS[name]
        wd = prepare(name, r)
        dot = os.path.join(wd, 'graph.dot') if (r['dot'] and '--nodot' not in args) else None
        out, secs = tlc(wd, name + '.cfg', 'MCferoraft.tla', dot=dot, timeout=tmo)
        s = summary(out)
        res = os.path.join(HERE, 'results', name + '.txt')
        with open(res, 'w') as f:
            f.write('# run %s: scenario %s, %s\n' % (name, r['scen'], r['kw']))
            f.write('# %.0f s wall, TLC -workers 2\n' % secs)
            f.write(trim(out) + '\n')
            if dot and os.path.exists(dot + '.gz') and s['complete']:
                kw = dict(BASE)
                kw.update(r['kw'])
                a = subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'agef.py'), dot + '.gz', '--trace', '1',
                                    '--judge-max-term', str(kw['MaxTermLimit'] - 2)],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                f.write('\n# agef.py (AG EF goal over progress steps)\n')
                agef = a.stdout
                # keep the trace but cap its size
                if len(agef) > 400000:
                    agef = agef[:400000] + '\n... (trace cut)\n'
                f.write(agef)
                s['agef'] = 'FAIL' if 'RESULT: FAIL' in a.stdout else ('PASS' if 'RESULT: PASS' in a.stdout else '?')
                m = re.search(r'stuck states (\d+)  of which with a live majority (\d+)', a.stdout)
                if m:
                    s['stuck'] = m.group(1)
                    s['stuck_live'] = m.group(2)
        if dot and os.path.exists(dot):
            os.remove(dot)
        # keep the graph if agef.py did not finish, so it can be rerun by hand
        if dot and os.path.exists(dot + '.gz') and not keep and s.get('agef') in ('PASS', 'FAIL'):
            os.remove(dot + '.gz')
        print('%-16s %6.0f s  %s' % (name, secs, s), flush=True)


if __name__ == '__main__':
    main()
