#!/usr/bin/env python3
"""run37.py: E-37's TLC runs. Each run is a named set of constants for
tla/MCbadentry.tla. It writes the .cfg (also into cfg/), stages the modules
into a run folder under $SP/e37/runs/, runs TLC under the study's heavy
lock, optionally pipes the state graph into gzip and runs tools/agef37.py on
it, and saves the trimmed log in results/<run>.txt and a line in
results/runs.json.

  python3 tools/run37.py --list
  python3 tools/run37.py RUN [RUN ...] [--timeout S] [--mutant DIR]

Modules: etcd's etcdraft.tla (unchanged), E-14's MCferoraft.tla (read from
E-14's folder, unchanged), tla/MCferolive.tla (E-14b's, copied unchanged,
sha256 in results/versions.txt) and tla/MCbadentry.tla. TLC runs with the
real CommunityModules jar on its classpath (E-14b showed it gives E-14's
stand-ins' results exactly).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
JAR = os.environ.get('TLA_JAR', SP + '/dl/tla/tla2tools.jar')
CMJAR = os.environ.get('CM_JAR', SP + '/dl/communitymodules/CommunityModules-deps.jar')
RAFT_TLA = os.environ.get('RAFT_TLA', SP + '/dl/raftsrc/raft/tla')
HEAVY = os.environ.get('HEAVY', SP + '/bin/heavy')
WORK = os.environ.get('E37_WORK', SP + '/e37/runs')
E14_TLA = os.path.join(os.path.dirname(HERE), 'E14-membership-on-commit', 'tla')

# Three voters; s1 leads in term 2 and its empty entry is committed and
# known to all (E-14's InitLeader). One client entry may be written. No
# membership change. Crashes keep the disk; E-14b's reductions (EagerReady,
# BatchVote, EagerNet, DeadView) and LeaderLease (a follower stands only when
# no up server leads in its term or a later one: PreVote with CheckQuorum).
BASE = dict(ReconfigurationLimit=0, MaxTermLimit=4, RequestLimit=1, FaultLimit=1,
            FeroRules=True, OnAppend=False, AllowDup=False, AllowLoseDisk=False,
            AllowRestart=False, AllowSnapshot=False, GhostReturn=False, CoarseAE=True,
            InitLeader=True, AllowDrop=False, AllowStepDown=False, LeaderLease=True,
            Plan='all', EagerApply=False, CrashLeaderOnly=False, InitR21=False, R6=True,
            EagerReady=True, BatchVote=True, EagerNet=True, DeadView=True,
            ZMode='par', DamageLimit=1, DistinctOffsets=False, RepairFrom='peer',
            DamageLeaderOnly=False, NoCrash=False)

SAFETY = ['ZLogInv', 'MoreThanOneLeaderInv', 'ElectionSafetyInv', 'ZLogMatchingInv',
          'ZQuorumLogInvLive', 'ZMoreUpToDateCorrectInv', 'ZLeaderCompletenessInv',
          'CommittedIsDurableInv', 'NoLostCommit', 'ZEagerNetOK']

RUNS = {}


def run(name, dot=False, invs=None, note='', **kw):
    RUNS[name] = dict(kw=kw, dot=dot, invs=invs or SAFETY, note=note)


# --- one damaged entry: Raft as published (Z crash) ------------------------
# "cut": no checksum, the bad entry is cut as a torn tail would be.
run('cut1', ZMode='cut', FaultLimit=1, note='one damage, cut as a torn tail')
run('cut1-obs', ZMode='cut', FaultLimit=1, invs=[i for i in SAFETY if i != 'ZQuorumLogInvLive'],
    note='the same, without the structural QuorumLogInv, to see the observable loss')
run('cut2', ZMode='cut', FaultLimit=2, invs=[i for i in SAFETY if i != 'ZQuorumLogInvLive'],
    note='one damage plus one crash')
run('silent1', ZMode='silent', FaultLimit=1, note='one damage, a flip inside the value, no checksum')
# --- Z rejoin: checksum, wipe, new incarnation (E-14's lost disk) ---------
run('rejoin1', ZMode='rejoin', FaultLimit=1, dot=True, note='one damage')
run('rejoin2', ZMode='rejoin', FaultLimit=2, DamageLimit=2, NoCrash=True, dot=True,
    note='two damages on two replicas, no crash')
run('ghost1', ZMode='ghost', FaultLimit=1, note='the wipe, back under its old id')
run('ghost1-obs', ZMode='ghost', FaultLimit=1, invs=[i for i in SAFETY if i != 'ZQuorumLogInvLive'],
    note='the same, without the structural QuorumLogInv, to see the observable loss')
# --- Z par: checksum, refuse to vote/take appends/stand, repair from a peer
run('par1', ZMode='par', FaultLimit=1, dot=True, note='one damage')
run('par1r2', ZMode='par', FaultLimit=1, RequestLimit=2, note='one damage, two client entries (safety only)')
run('par1c', ZMode='par', FaultLimit=2, CrashLeaderOnly=True,
    note='one damage plus one crash of a leader (safety only)')
run('par2', ZMode='par', FaultLimit=2, DamageLimit=2, NoCrash=True, dot=True,
    note='two damages on two replicas, any offsets, no crash')
run('par2d', ZMode='par', FaultLimit=2, DamageLimit=2, DistinctOffsets=True, NoCrash=True, dot=True,
    note='two damages on two replicas at different offsets, no crash')
run('par2d-leader', ZMode='par', FaultLimit=2, DamageLimit=2, DistinctOffsets=True, NoCrash=True,
    RepairFrom='leader', dot=True, note='two damages at different offsets, repair only from the current leader')
run('par2-leader', ZMode='par', FaultLimit=2, DamageLimit=2, NoCrash=True, RepairFrom='leader', dot=True,
    note='two damages, any offsets, repair only from the current leader')
run('cut1r2', ZMode='cut', FaultLimit=1, RequestLimit=2, invs=[i for i in SAFETY if i != 'ZQuorumLogInvLive'],
    note='one damage, two client entries')


def tla(v):
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if isinstance(v, str):
        return '"%s"' % v
    return str(v)


def cfg_text(r):
    kw = dict(BASE)
    kw.update(r['kw'])
    lines = ['SPECIFICATION ZSpec', 'CONSTANTS',
             '    Server = {s1, s2, s3}', '    InitServer = {s1, s2, s3}',
             '    InitVoters = {s1, s2, s3}', '    InitLearners = {}', '    Joiners = {}']
    for k in sorted(kw):
        lines.append('    %s = %s' % (k, tla(kw[k])))
    lines += ['    Send <- FeroSend', '    Reply <- FeroReply',
              '    GetJointConfig <- MCGetJointConfig', '    GetLearners <- MCGetLearners',
              '    Nil = Nil', '    ValueEntry = "ValueEntry"', '    ConfigEntry = "ConfigEntry"',
              '    Follower = "Follower"', '    Candidate = "Candidate"', '    Leader = "Leader"',
              '    RequestVoteRequest = "RequestVoteRequest"',
              '    RequestVoteResponse = "RequestVoteResponse"',
              '    AppendEntriesRequest = "AppendEntriesRequest"',
              '    AppendEntriesResponse = "AppendEntriesResponse"',
              'SYMMETRY Symmetry', 'VIEW ZView', 'CHECK_DEADLOCK FALSE', 'INVARIANTS']
    lines += ['    ' + i for i in r['invs']]
    return '\n'.join(lines) + '\n'


def prepare(name, r, mutant=None):
    wd = os.path.join(WORK, name)
    if os.path.isdir(wd):
        shutil.rmtree(wd)
    os.makedirs(wd)
    shutil.copy(os.path.join(RAFT_TLA, 'etcdraft.tla'), wd)
    shutil.copy(os.path.join(E14_TLA, 'MCferoraft.tla'), wd)
    for f in ('MCferolive.tla', 'MCbadentry.tla'):
        shutil.copy(os.path.join(HERE, 'tla', f), wd)
    if mutant:
        shutil.copy(os.path.join(mutant, 'MCbadentry.tla'), wd)
    with open(os.path.join(wd, name + '.cfg'), 'w') as f:
        f.write(cfg_text(r))
    if not mutant:
        shutil.copy(os.path.join(wd, name + '.cfg'), os.path.join(HERE, 'cfg', name + '.cfg'))
    return wd


def tlc(wd, cfg, dot=None, timeout=1500, workers=2, heavy=True):
    cmd = ([HEAVY] if heavy else []) + ['timeout', str(timeout), 'java', '-XX:+UseParallelGC', '-Xmx2500m',
                                        '-cp', JAR + ':' + CMJAR, 'tlc2.TLC', '-workers', str(workers),
                                        '-cleanup', '-config', cfg, '-metadir', os.path.join(wd, 'meta')]
    gz = None
    if dot:
        if os.path.exists(dot):
            os.remove(dot)
        os.mkfifo(dot)
        gz = subprocess.Popen('gzip -1 < %s > %s.gz' % (dot, dot), shell=True)
        cmd += ['-dump', 'dot,actionlabels', dot]
    cmd.append('MCbadentry.tla')
    t0 = time.time()
    logp = os.path.join(wd, 'tlc.log')
    with open(logp, 'w') as lf:
        p = subprocess.run(cmd, cwd=wd, stdout=lf, stderr=subprocess.STDOUT, text=True)
    if gz:
        if p.returncode != 0 and gz.poll() is None:
            try:
                fd = os.open(dot, os.O_WRONLY | os.O_NONBLOCK)
                os.close(fd)
            except OSError:
                pass
        gz.wait()
    with open(logp) as lf:
        out = lf.read()
    return out, time.time() - t0


def trim(out, maxlines=400):
    keep = []
    for line in out.splitlines():
        if line.startswith(('Picked up JAVA', 'Semantic processing', 'Linting', 'Parsing file', 'Loading')):
            continue
        keep.append(line)
    if len(keep) > maxlines:
        keep = keep[:maxlines // 2] + ['... (%d lines cut)' % (len(keep) - maxlines)] + keep[-maxlines // 2:]
    return '\n'.join(keep)


def summary(out):
    ms = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', out)
    d = re.search(r'The depth of the complete state graph search is (\d+)', out)
    viol = re.search(r'Error: Invariant (\w+) is violated', out)
    err = None
    if viol is None and re.search(r'^Error:', out, re.M):
        err = re.search(r'^Error:.*$', out, re.M).group(0)[:200]
    steps = len(re.findall(r'^State \d+:', out, re.M))
    m = ms[-1] if ms else None
    return dict(generated=int(m[0].replace(',', '')) if m else None,
                distinct=int(m[1].replace(',', '')) if m else None,
                queue=int(m[2].replace(',', '')) if m else None,
                depth=int(d.group(1)) if d else None,
                violated=viol.group(1) if viol else None,
                trace_states=steps or None,
                complete=('Model checking completed. No error has been found.' in out
                          and m is not None and int(m[2].replace(',', '')) == 0),
                error=err)


def record(name, row):
    p = os.path.join(HERE, 'results', 'runs.json')
    data = {}
    if os.path.exists(p):
        with open(p) as f:
            data = json.load(f)
    data[name] = row
    with open(p, 'w') as f:
        json.dump(data, f, indent=1, sort_keys=True)


def do(name, timeout, mutant=None, tag=None, heavy=True, save=True):
    r = RUNS[name]
    key = tag or name
    wd = prepare(key, r, mutant)
    dot = os.path.join(wd, 'graph.dot') if r['dot'] else None
    out, secs = tlc(wd, key + '.cfg', dot=dot, timeout=timeout, heavy=heavy)
    s = summary(out)
    s['secs'] = round(secs)
    s['note'] = r['note']
    ag = ''
    if dot and s['complete']:
        mt = dict(BASE, **r['kw'])['MaxTermLimit']
        p = subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'agef37.py'), dot + '.gz',
                            '--judge-max-term', str(mt - 2), '--trace', '1'],
                           capture_output=True, text=True)
        ag = p.stdout + p.stderr
        m = re.search(r'stuck states (\d+)\s+of which with a live majority (\d+)', ag)
        j = re.search(r'judged states \(highest term <= \d+\) (\d+)', ag)
        if m:
            s['stuck'] = int(m.group(1))
            s['stuck_live'] = int(m.group(2))
            s['judged'] = int(j.group(1)) if j else None
        dm = re.search(r'^DAMAGE (.*)$', ag, re.M)
        if dm:
            s['by_damage'] = dm.group(1)
    ct = ''
    if s['violated']:
        p = subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'trace37.py'), os.path.join(wd, 'tlc.log')],
                           capture_output=True, text=True)
        ct = p.stdout
    if save:
        with open(os.path.join(HERE, 'results', key + '.txt'), 'w') as f:
            f.write('# run %s (%s): %.0f s wall incl. waiting for the lock, cap %d s\n' % (key, r['note'], secs, timeout))
            if ct:
                f.write('\n# the trace, condensed by tools/trace37.py (the full trace follows)\n' + ct + '\n')
            f.write(trim(out) + '\n')
            if ag:
                f.write('\n# agef37.py (AG EF goal over progress steps)\n' + trim(ag, 300) + '\n')
        record(key, s)
    print('%-14s %6.0f s  %s' % (key, secs, {k: v for k, v in s.items() if k != 'note'}), flush=True)
    if dot and os.path.exists(dot + '.gz'):
        os.remove(dot + '.gz')
    return s


def main():
    args = sys.argv[1:]
    if not args or '--list' in args:
        for k, r in RUNS.items():
            print('%-14s %s  %s' % (k, r['kw'], r['note']))
        return
    timeout = int(args[args.index('--timeout') + 1]) if '--timeout' in args else 1500
    names = [a for a in args if a in RUNS]
    # --inhold: the caller already holds the heavy lock (one hold for many
    # small runs); otherwise each TLC run takes the lock itself
    heavy = '--inhold' not in args
    for n in names:
        do(n, timeout, heavy=heavy)


if __name__ == '__main__':
    main()
