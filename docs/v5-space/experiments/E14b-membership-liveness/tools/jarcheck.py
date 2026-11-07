#!/usr/bin/env python3
"""jarcheck.py: E-14's finished runs, re-run with the real CommunityModules
jar, and again with E-14's local stand-ins, on the same TLC, same box.

E-14 replaced CommunityModules-deps.jar with three small modules of its own
(SequencesExt, FiniteSetsExt, BagsExt). If the stand-ins changed what the
spec means (FoldBag's argument order above all), a finished run would find
a different number of states or a different verdict. Each run here is one
of E-14's own, with E-14's own .cfg file, unchanged.

  python3 tools/jarcheck.py            # all runs, both module sets
  python3 tools/jarcheck.py NAME ...   # some runs

Writes results/jarcheck.md (the table) and results/jarcheck/<run>-<set>.txt.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

E14CFG = os.path.join(C.E14, 'cfg')

# name: (spec, cfg file, extra files from etcd's folder, mutant, workers, cap s)
RUNS = {
    'staleconfig': ('MCstaleconfig.tla', os.path.join(E14CFG, 'staleconfig.cfg'), ['MCetcdraft.tla'], None, 1, 900),
    'stale2': ('MCstale2.tla', os.path.join(E14CFG, 'stale2.cfg'), [], None, 1, 900),
    'stale2-mutant': ('MCstale2.tla', os.path.join(E14CFG, 'stale2-mutant.cfg'), [], 'CanCampaign:drop-guard:r20', 1, 900),
    'r21-script': ('MCr21script.tla', os.path.join(E14CFG, 'r21-script.cfg'), [], None, 1, 900),
    'r21-append-ef': ('MCferoraft.tla', os.path.join(E14CFG, 'r21-append-ef.cfg'), [], None, 2, 900),
    # the shipped model as shipped never finishes (E-14 F4): 5 minutes each
    'shipped-asis': ('MCetcdraft.tla', os.path.join(C.RAFT_TLA, 'MCetcdraft.cfg'), ['MCetcdraft.tla'], None, 2, 300),
}


def mutant_src(name):
    sys.path.insert(0, os.path.join(C.E14, 'tools'))
    import mutants as M  # E-14's own generator, reading E-14's MCferoraft.tla
    lines, muts = M.mutants()
    hit = [m for m in muts if m[0] == name]
    assert hit, name
    ls = list(lines)
    ls[hit[0][1]] = hit[0][2]
    return '\n'.join(ls)


# The module sets: 'jar' (CommunityModules-deps.jar on the classpath: its
# .tla files and its Java overrides), 'stubs' (E-14's stand-ins), 'jartext'
# (the jar's own .tla files copied in, the jar left off the classpath, so
# TLC evaluates the jar's TLA+ definitions with no Java override), and
# 'jartext-bagstub' (as jartext, but BagsExt is E-14's stand-in).
SETS = ('jar', 'stubs', 'jartext', 'jartext-bagstub')


def jar_text_dir():
    d = os.path.join(C.SP, 'e14b', 'cmtext')
    if not os.path.isdir(d):
        os.makedirs(d)
        subprocess.run(['unzip', '-q', '-o', C.CMJAR, '*.tla', '-d', d], check=True)
    return d


def one(name, mset):
    spec, cfg, extra, mutant, workers, cap = RUNS[name]
    if C.time_left() < 90:
        return None
    cap = int(min(cap, C.time_left() - 40))
    stubs = mset != 'jar'
    tag = '%s-%s' % (name, mset)
    wd = C.fresh_dir('jar-' + tag)
    C.stage(wd, mset == 'stubs', [os.path.join(C.RAFT_TLA, f) for f in extra])
    if mset.startswith('jartext'):
        td = jar_text_dir()
        for f in os.listdir(td):
            if f.endswith('.tla') and not (mset == 'jartext-bagstub' and f == 'BagsExt.tla'):
                shutil.copy(os.path.join(td, f), wd)
        if mset == 'jartext-bagstub':
            shutil.copy(os.path.join(C.E14_TLA, 'BagsExt.tla'), wd)
    if mutant:
        open(os.path.join(wd, 'MCferoraft.tla'), 'w').write(mutant_src(mutant))
    cfgname = os.path.basename(cfg)
    open(os.path.join(wd, cfgname), 'w').write(open(cfg).read())
    cmd = C.heavy() + ['timeout', str(cap), 'java', '-XX:+UseParallelGC', '-Xmx4g',
           '-Dtlc2.TLC.stopAfter=%d' % (cap - 20),
           '-cp', C.classpath(stubs), 'tlc2.TLC', '-workers', str(workers), '-cleanup',
           '-config', cfgname, '-metadir', os.path.join(wd, 'meta'), spec]
    t0 = time.time()
    p = subprocess.run(cmd, cwd=wd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    secs = time.time() - t0
    out = p.stdout
    s = C.summary(out)
    s['secs'] = round(secs)
    # TLC says which Java overrides of CommunityModules it loaded
    s['overrides'] = sorted(set(re.findall(r'Loading (\w+) operator override', out)))
    os.makedirs(os.path.join(C.RESULTS, 'jarcheck'), exist_ok=True)
    with open(os.path.join(C.RESULTS, 'jarcheck', tag + '.txt'), 'w') as f:
        f.write('# %s: %s with %s, %s, %.0f s wall (cap %d s)\n' % (
            tag, spec, cfgname, {'jar': 'CommunityModules-deps.jar', 'stubs': 'E-14 stand-ins',
                                 'jartext': "the jar's .tla text, no Java overrides",
                                 'jartext-bagstub': "the jar's .tla text, no Java overrides, E-14's BagsExt"}[mset],
            secs, cap))
        lines = C.trim(out).splitlines()
        # keep the head, the progress lines and the tail; a trace is cut to 60 lines
        if len(lines) > 400:
            lines = lines[:200] + ['... (%d lines cut)' % (len(lines) - 400)] + lines[-200:]
        f.write('\n'.join(lines) + '\n')
    print('%-28s %s' % (tag, json.dumps(s)), flush=True)
    return s


def main():
    names = [a for a in sys.argv[1:] if not a.startswith('-')] or list(RUNS)
    res = {}
    path = os.path.join(C.RESULTS, 'jarcheck.json')
    if os.path.exists(path):
        res = json.load(open(path))
    sets = [x.split('=')[1].split(',') for x in sys.argv[1:] if x.startswith('--sets=')]
    sets = sets[0] if sets else ['jar', 'stubs']
    for n in names:
        for mset in sets:
            key = '%s/%s' % (n, mset)
            if key in res and '--redo' not in sys.argv:
                continue
            s = one(n, mset)
            if s is None:
                print('%s: no time left in this hold' % key, flush=True)
                continue
            res[key] = s
            json.dump(res, open(path, 'w'), indent=1, sort_keys=True)
    rows = ['| run | module set | distinct states | depth | queue left | verdict | wall s |', '|---|---|---|---|---|---|---|']
    for n in RUNS:
        for st in SETS:
            s = res.get('%s/%s' % (n, st))
            if not s:
                continue
            v = ('violates ' + s['violated']) if s['violated'] else ('complete, no violation' if s['complete'] else (('TLC error: ' + s['error'].replace('|', '/')) if s['error'] else 'stopped at cap'))
            rows.append('| %s | %s | %s | %s | %s | %s | %s |' % (n, st, s['distinct'], s['depth'], s['queue'], v, s['secs']))
    open(os.path.join(C.RESULTS, 'jarcheck.md'), 'w').write('\n'.join(rows) + '\n')


if __name__ == '__main__':
    main()
