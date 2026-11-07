"""common.py: paths and small helpers shared by E-14b's tools.

E-14b reads E-14's model files (read-only) and etcd's raft/tla folder, and
runs TLC with the real CommunityModules jar on the classpath. The local
stand-ins E-14 wrote (SequencesExt.tla, FiniteSetsExt.tla, BagsExt.tla) are
copied into a run's folder only when a run asks for them (`stubs=True`), so
TLC otherwise resolves those modules from the jar, with its Java overrides.
"""
import os
import re
import shutil
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP = os.environ.get('SP', '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad')
JAR = os.environ.get('TLA_JAR', SP + '/dl/tla/tla2tools.jar')
CMJAR = os.environ.get('CM_JAR', SP + '/dl/communitymodules/CommunityModules-deps.jar')
RAFT_TLA = os.environ.get('RAFT_TLA', SP + '/dl/raftsrc/raft/tla')
HEAVY = os.environ.get('HEAVY', SP + '/bin/heavy')
WORK = os.environ.get('E14B_WORK', SP + '/e14b/runs')
E14 = os.path.join(os.path.dirname(HERE), 'E14-membership-on-commit')
E14_TLA = os.path.join(E14, 'tla')
STUBS = ['SequencesExt.tla', 'FiniteSetsExt.tla', 'BagsExt.tla']
RESULTS = os.path.join(HERE, 'results')

# Inside one hold of the heavy lock (tools/batch.py sets these), TLC runs
# are not wrapped again, and every run stops by the hold's deadline.
INHOLD = bool(os.environ.get('E14B_INHOLD'))
DEADLINE = float(os.environ.get('E14B_DEADLINE', '0') or 0)


def heavy():
    return [] if INHOLD else [HEAVY]


def time_left():
    return (DEADLINE - time.time()) if DEADLINE else 10 ** 9


def classpath(stubs):
    # With the stand-ins in the run folder, TLC finds them first; the jar is
    # left off the classpath then, so nothing of it is used.
    return JAR if stubs else JAR + ':' + CMJAR


def fresh_dir(name):
    wd = os.path.join(WORK, name)
    if os.path.isdir(wd):
        shutil.rmtree(wd)
    os.makedirs(wd)
    return wd


def stage(wd, stubs, extra=()):
    """Copy etcd's spec, E-14's model modules, E-14b's modules and any extra
    files into the run folder."""
    shutil.copy(os.path.join(RAFT_TLA, 'etcdraft.tla'), wd)
    for f in os.listdir(E14_TLA):
        if f.endswith('.tla') and (stubs or f not in STUBS):
            shutil.copy(os.path.join(E14_TLA, f), wd)
    mine = os.path.join(HERE, 'tla')
    for f in os.listdir(mine):
        if f.endswith('.tla'):
            shutil.copy(os.path.join(mine, f), wd)
    for f in extra:
        shutil.copy(f, wd)


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
                complete='Model checking completed. No error has been found.' in out,
                error=err)
