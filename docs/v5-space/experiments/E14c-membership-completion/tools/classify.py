#!/usr/bin/env python3
"""classify.py: sort a run's stuck states (agef2.py's: a live majority and
no progress path to a working leader) by what holds them, from each state's
TLC label, and print the shortest trace to one state of each kind.

  python3 tools/classify.py RUNDIR JUDGE [--trace]

Kinds (checked in this order):
  candidate   an up server is a candidate: E-14's bound "one candidate at a
              time" (shipped MCetcdraft's) never lets a candidate that lost
              stand again, and no other member of its configuration may
              stand while it is a candidate. A bound of the model, not of
              Raft, where a candidate times out and stands again.
  nonvoter    an up server leads but is not a voter of its own applied
              configuration (E-14's goal asks for a voter leader).
  window-N    E-14b's two-voter window, in general form: nobody leads or
              stands; a majority of the latest COMMITTED configuration is
              up; but no up server could win an election in the latest
              configuration IT knows to be committed (it is no voter of it,
              or a majority of its voters is not up, or a voter it needs
              holds a more up-to-date log). N is the size of the older
              configuration known to the up servers that could win in the
              latest one (its voters with the most up-to-date log): they
              have not heard that the change committed. N is 0 when no
              such server is up.
  other       anything else.
Needs the run's graph and label files (run with E14C_KEEP=1).
"""
import glob
import os
import re
import sys

import numpy as np


def openlab(p):
    """A label file: gzip (as dotfilter.py writes it) or xz (recompressed later)."""
    import gzip
    import lzma
    return lzma.open(p, 'rt') if p.endswith('.xz') else gzip.open(p, 'rt')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agef2  # noqa: E402

ROLE = re.compile(r'(s\d) :> "(\w+)"')
CONF = re.compile(r'(s\d) :> \[jointConfig \|-> <<(\{[^}]*\}), \{\}>>')
UP = re.compile(r'/\\ up = \{([^}]*)\}')


def unescape(lab):
    return lab.replace('\\n', '\n').replace('\\\\', '\\').replace('\\"', '"')


def field(lab, name):
    m = re.search(r'/\\ ' + name + r' = (.*?)(?=\n/\\ |\Z)', lab, re.S)
    return re.sub(r'\s+', ' ', m.group(1)) if m else ''


ENT = re.compile(r'\[\s*term \|-> (\d+),\s*type \|-> "(\w+)",\s*value \|->\s*\[(?:newconf \|-> \{([^}]*)\}, learners \|-> \{[^}]*\}|[^\]]*)\]\s*\]')
CIDX = re.compile(r'(s\d) :> (\d+)')


def names(v):
    return set(x.strip() for x in (v or '').split(',') if x.strip())


def logs_of(lab):
    """Each server's log as a list of (term, voters or None)."""
    out = {}
    for part in re.split(r'\s*@@\s*(?=s\d :>)', field(lab, 'log').strip('() ')):
        m = re.match(r'\s*(s\d) :>', part)
        if m:
            out[m.group(1)] = [(int(t), names(v) if ty == 'ConfigEntry' else None) for t, ty, v in ENT.findall(part)]
    return out


def window(lab, up, roles):
    """The size N of the window (see the header), or None."""
    committed = [names(v) for v in re.findall(r'newconf \|-> \{([^}]*)\}', field(lab, 'ctl'))]
    latest = committed[-1] if committed else set()
    if not latest or len(latest & up) * 2 <= len(latest):
        return None
    logs = logs_of(lab)
    ci = {s: int(v) for s, v in CIDX.findall(field(lab, 'commitIndex'))}

    def known(s):
        cs = [v for _, v in logs.get(s, [])[:ci.get(s, 0)] if v is not None]
        return cs[-1] if cs else set()

    def key(s):
        lg = logs.get(s, [])
        return (lg[-1][0] if lg else 0, len(lg))

    def can_win(s):
        k = known(s)
        if s not in k:
            return False
        ok = [j for j in k & up if j == s or key(j) <= key(s)]
        return len(ok) * 2 > len(k)
    if not up or any(can_win(s) for s in up):
        return None
    # The up servers with the most up-to-date log that are voters of the
    # latest configuration: the ones that would win in it, if they knew it.
    top = max(key(s) for s in up)
    return max([len(known(s)) for s in up if key(s) == top and s in latest] or [0])


def kind(lab):
    lab = unescape(lab)
    up = set(x.strip() for x in (UP.search(lab).group(1) if UP.search(lab) else '').split(',') if x.strip())
    roles = dict(ROLE.findall(field(lab, 'state')))
    conf = {s: set(x.strip() for x in v.strip('{}').split(',') if x.strip())
            for s, v in CONF.findall(field(lab, 'config'))}
    if any(roles.get(s) == 'Candidate' for s in up):
        return 'candidate'
    if any(roles.get(s) == 'Leader' and s not in conf.get(s, set()) for s in up):
        return 'nonvoter'
    if not any(roles.get(s) == 'Leader' for s in up):
        n = window(lab, up, roles)
        if n is not None:
            return 'window-%d' % n
    return 'other'


def main():
    wd, judge = sys.argv[1], int(sys.argv[2])
    segs = sorted(glob.glob(os.path.join(wd, 'seg*.g.gz')))
    labs = sorted(glob.glob(os.path.join(wd, 'seg*.l.gz')) + glob.glob(os.path.join(wd, 'seg*.l.xz')))
    ids, goal, live, faults, nup, mterm, init, es, ed, plan, _open = agef2.load(segs)
    ids = np.frombuffer(ids, dtype=np.int64)
    goal = np.frombuffer(goal, dtype=np.uint8).astype(bool)
    live = np.frombuffer(live, dtype=np.uint8).astype(bool)
    faults = np.frombuffer(faults, dtype=np.int16)
    nup = np.frombuffer(nup, dtype=np.int16)
    mterm = np.frombuffer(mterm, dtype=np.int16)
    sid, first = np.unique(ids, return_index=True)
    goal, live, faults, nup, mterm = goal[first], live[first], faults[first], nup[first], mterm[first]
    n = len(sid)
    es = np.frombuffer(es, dtype=np.int64)
    ed = np.frombuffer(ed, dtype=np.int64)
    s = np.searchsorted(sid, es)
    d = np.searchsorted(sid, ed)
    prog = (faults[s] == faults[d]) & (nup[s] == nup[d])
    ps, pd = s[prog], d[prog]
    o = np.argsort(pd, kind='stable')
    rsrc = ps[o]
    rptr = np.searchsorted(pd[o], np.arange(n + 1))
    good = agef2.back_reach(goal, rsrc, rptr)
    stuck = (~good) & (mterm <= judge) & live
    want = set(int(sid[x]) for x in np.nonzero(stuck)[0])
    lab = {}
    for lp in labs:
        with openlab(lp) as f:
            for line in f:
                k, _, v = line.partition('\t')
                if int(k) in want and int(k) not in lab:
                    lab[int(k)] = v.rstrip('\n')
    kinds = {}
    for k in want:
        kinds.setdefault(kind(lab.get(k, '')), []).append(k)
    print('stuck with a live majority, judged at term <= %d: %d' % (judge, len(want)))
    for kk in ['candidate', 'nonvoter'] + sorted(k for k in kinds if k.startswith('window')) + ['other']:
        print('  %-10s %d' % (kk, len(kinds.get(kk, []))))
    if '--trace' not in sys.argv:
        return
    # shortest path (all edges) from the initial state to a state of each kind
    o2 = np.argsort(s, kind='stable')
    fdst = d[o2]
    fptr = np.searchsorted(s[o2], np.arange(n + 1))
    parent = np.full(n, -2, dtype=np.int64)
    start = np.searchsorted(sid, np.array(init, dtype=np.int64))
    parent[start] = -1
    frontier = start
    target = {kk: set(np.searchsorted(sid, np.array(v, dtype=np.int64)).tolist()) for kk, v in kinds.items()}
    found = {}
    while frontier.size and len(found) < len(target):
        for kk, tg in target.items():
            if kk not in found:
                hit = [int(x) for x in frontier if int(x) in tg]
                if hit:
                    found[kk] = hit[0]
        r = agef2.ranges(fptr, frontier)
        src_of = np.repeat(frontier, fptr[frontier + 1] - fptr[frontier])
        nxt = fdst[r]
        fresh = parent[nxt] == -2
        nxt, src_of = nxt[fresh], src_of[fresh]
        nxt, fi = np.unique(nxt, return_index=True)
        parent[nxt] = src_of[fi]
        frontier = nxt
    need = {}
    for kk, h in found.items():
        p = []
        while h >= 0:
            p.append(h)
            h = int(parent[h])
        p.reverse()
        need[kk] = p
    allids = set(int(sid[x]) for p in need.values() for x in p)
    for lp in labs:
        with openlab(lp) as f:
            for line in f:
                k, _, v = line.partition('\t')
                if int(k) in allids and int(k) not in lab:
                    lab[int(k)] = v.rstrip('\n')
    for kk, p in need.items():
        print('\n=== shortest trace to a stuck state of kind %s: %d states ===' % (kk, len(p)))
        for i, x in enumerate(p):
            print('State %d: <step>' % (i + 1))
            print(lab.get(int(sid[x]), '(label not kept)').replace('\\n', '\n').replace('\\\\', '\\')
                  .replace('\\"', '"'))
            print()


if __name__ == '__main__':
    main()
