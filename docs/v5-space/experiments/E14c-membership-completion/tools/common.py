"""common.py: paths and small helpers shared by E-14c's tools.

E-14c reads, never writes: etcd's raft/tla folder (etcdraft.tla), E-14's
model files (../E14-membership-on-commit/tla) and E-14b's reduced model
(../E14b-membership-liveness/tla/MCferolive.tla). It stages copies of them,
plus its own tla/MCferoc.tla, in a fresh run folder under $SP/e14c/runs,
and runs TLC there with the real CommunityModules jar on the classpath (as
E-14b). A run may replace one staged file (a mutant of MCferoraft.tla, or a
planted bug in etcdraft.tla) through `patch`.
"""
import os
import re
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
JAR = os.environ.get('TLA_JAR', SP + '/dl/tla/tla2tools.jar')
CMJAR = os.environ.get('CM_JAR', SP + '/dl/communitymodules/CommunityModules-deps.jar')
RAFT_TLA = os.environ.get('RAFT_TLA', SP + '/dl/raftsrc/raft/tla')
HEAVY = os.environ.get('HEAVY', SP + '/bin/heavy')
WORK = os.environ.get('E14C_WORK', SP + '/e14c/runs')
EXP = os.path.dirname(HERE)
E14 = os.path.join(EXP, 'E14-membership-on-commit')
E14_TLA = os.path.join(E14, 'tla')
E14B = os.path.join(EXP, 'E14b-membership-liveness')
E14B_TLA = os.path.join(E14B, 'tla')
STUBS = ['SequencesExt.tla', 'FiniteSetsExt.tla', 'BagsExt.tla']
RESULTS = os.path.join(HERE, 'results')

# Inside one hold of the heavy lock (tools/batch.py sets these), TLC runs
# are not wrapped again, and every run stops by the hold's deadline.
INHOLD = bool(os.environ.get('E14C_INHOLD'))
DEADLINE = float(os.environ.get('E14C_DEADLINE', '0') or 0)


def offpeak_wait():
    """The user asked that no new heavy work start in peak hours (8 AM to
    2 PM US Eastern, Monday to Friday); work already running may finish.
    So before each new TLC segment, wait until peak hours are over."""
    if os.environ.get('E14C_IGNORE_PEAK'):
        return
    while True:
        out = subprocess.run(['date', '+%u %H'], env=dict(os.environ, TZ='America/New_York'),
                             capture_output=True, text=True).stdout.split()
        day, hour = int(out[0]), int(out[1])
        if not (day <= 5 and 8 <= hour < 14):
            return
        print('peak hours (US Eastern day %d, hour %d): waiting before the next segment' % (day, hour), flush=True)
        time.sleep(300)


def heavy():
    return [] if INHOLD else [HEAVY]


def time_left():
    return (DEADLINE - time.time()) if DEADLINE else 10 ** 9


def classpath():
    return JAR + ':' + CMJAR


def fresh_dir(name):
    wd = os.path.join(WORK, name)
    if os.path.isdir(wd):
        shutil.rmtree(wd)
    os.makedirs(wd)
    return wd


def stage(wd, patch=None):
    """Copy etcd's spec, E-14's and E-14b's model modules and E-14c's into
    the run folder; then apply `patch` ({file name: new text})."""
    shutil.copy(os.path.join(RAFT_TLA, 'etcdraft.tla'), wd)
    for d in (E14_TLA, E14B_TLA, os.path.join(HERE, 'tla')):
        for f in os.listdir(d):
            if f.endswith('.tla') and f not in STUBS:
                shutil.copy(os.path.join(d, f), wd)
    for f, text in (patch or {}).items():
        with open(os.path.join(wd, f), 'w') as fh:
            fh.write(text)


def trim(out):
    keep = []
    for line in out.splitlines():
        if line.startswith(('Picked up JAVA', 'Semantic processing', 'Linting', 'Parsing file')):
            continue
        keep.append(line)
    return '\n'.join(keep)


def summary(out):
    ms = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', out)
    d = re.search(r'The depth of the complete state graph search is (\d+)', out)
    viol = re.search(r'Error: Invariant (\w+) is violated', out)
    err = None
    if viol is None and re.search(r'^Error:', out, re.M):
        err = re.search(r'^Error:.*$', out, re.M).group(0)[:200]
    m = ms[-1] if ms else None
    return dict(generated=int(m[0].replace(',', '')) if m else None,
                distinct=int(m[1].replace(',', '')) if m else None,
                queue=int(m[2].replace(',', '')) if m else None,
                depth=int(d.group(1)) if d else None,
                violated=viol.group(1) if viol else None,
                # TLC prints this line also when -Dtlc2.TLC.stopAfter stops it
                # early, so a run is complete only with nothing left on the queue
                # (E-14b's first trap).
                complete=('Model checking completed. No error has been found.' in out
                          and m is not None and int(m[2].replace(',', '')) == 0),
                error=err)
