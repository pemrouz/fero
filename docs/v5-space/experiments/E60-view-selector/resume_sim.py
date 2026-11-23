#!/usr/bin/env python3
"""
resume_sim.py: the folded resume at sizes the model cannot hold (E-60 part 2).

One partition. A seeded log of writes: a set of a random key (new or old,
with a new value) or a removal of a key that is there. A copy keeps rows with
their versions (the position of the last write) and tombstones, dropping
tombstones older than a window. A client holds a base (its rows at a cursor),
goes away for k writes (a dropped link, or a restart from a saved base), and
comes back with `connect({ resume: cursor })`.

The copy answers with the rows newer than the cursor plus the tombstones
newer than it, if its window reaches back to the cursor; else a new picture.
After every resume the client's rows must equal the rows got by replaying
the log up to the copy's position (the oracle is a plain fold of each
record; it shares no code with the copy's versions and tombstones). Bytes are counted with 100 B rows
(E-56's size) and a tombstone of a 16 B key plus an 8 B version (a guess).

    python3 resume_sim.py [--seeds 1000] [--plant window|tombs|versions|gcfloor] [--out file.jsonl]

Each resume also records the smaller of the folded answer and a picture: a
copy may send a picture when it is smaller (E-57 A2's rule for the ring).

Planted bugs: `window` answers with the folded form even when the window does
not reach back; `tombs` leaves the tombstones out; `versions` compares a
row's version with `>=` instead of `>` (sends the row at the cursor again:
harmless, a cost bug); `gcfloor` (the review's) keeps the floor one gc batch
(64 writes) low, so the copy claims tombstones it has dropped.

The gaps: 1, 10, 100, 1,000 or 10,000 writes, or `near`: the window plus or
minus up to 130 writes (two gc batches), so a cursor often lands just below
or just above the floor. With no window, `near` is 1,000 plus or minus 130.
"""
import argparse
import json
import random
import statistics

ROW_B, TOMB_B = 100, 24


class Copy:
    def __init__(self, window, plant=''):
        self.plant = plant
        self.rows, self.ver, self.tomb = {}, {}, {}
        self.pos = 0
        self.window = window
        self.tbase = 0

    def apply(self, rec):
        self.pos += 1
        op, k, v = rec
        if op == 'set':
            self.rows[k] = v
            self.ver[k] = self.pos
            self.tomb.pop(k, None)
        else:
            self.rows.pop(k, None)
            self.ver.pop(k, None)
            self.tomb[k] = self.pos
        # the window: tombstones older than pos - window go, in batches (a gc)
        if self.window is not None and self.pos % 64 == 0:
            floor = max(0, self.pos - self.window)
            for t in [t for t, p in self.tomb.items() if p <= floor]:
                del self.tomb[t]
            self.tbase = max(self.tbase, floor - 64 if self.plant == 'gcfloor' else floor)

    def resume(self, cur, plant):
        if self.tbase > cur and plant != 'window':
            return 'pic', dict(self.rows), None
        gt = (lambda p: p >= cur) if plant == 'versions' else (lambda p: p > cur)
        sets = {k: self.rows[k] for k, p in self.ver.items() if gt(p)}
        rem = [] if plant == 'tombs' else [k for k, p in self.tomb.items() if p > cur]
        return 'fold', sets, rem


def one(seed, a):
    rnd = random.Random(seed)
    nrows = rnd.choice(a.rows)
    window = rnd.choice(a.windows)
    pdel = rnd.choice((0.1, 0.3))
    keys = list(range(int(nrows * 1.25)))
    log, live = [], set()
    copy = Copy(window, a.plant)
    oracle = {}            # the rows by a plain replay of the log: no versions, no tombstones

    def fold_into(rec):
        op, k, v = rec
        if op == 'set':
            oracle[k] = v
        else:
            oracle.pop(k, None)

    def write():
        if live and rnd.random() < pdel:
            k = rnd.choice(tuple(live)) if len(live) < 64 else rnd.choice(keys)
            if k in live:
                live.discard(k)
                rec = ('del', k, None)
                log.append(rec)
                copy.apply(rec)
                fold_into(rec)
                return
        k = rnd.choice(keys)
        live.add(k)
        rec = ('set', k, len(log))
        log.append(rec)
        copy.apply(rec)
        fold_into(rec)

    for _ in range(nrows * 2):
        write()
    out = []
    base_pos = copy.pos
    base = dict(copy.rows)
    for _ in range(a.resumes):
        g = rnd.choice(a.gaps)
        k = g if g != 'near' else max(1, (window or 1000) + rnd.randint(-130, 130))
        for _ in range(k):
            write()
        kind, sets, rem = copy.resume(base_pos, a.plant)
        if kind == 'pic':
            got = sets
            sent_rows, sent_tombs = len(sets), 0
        else:
            got = dict(base)
            for r in rem:
                got.pop(r, None)
            got.update(sets)
            sent_rows, sent_tombs = len(sets), len(rem)
        ok = got == oracle
        out.append({'seed': seed, 'rows': nrows, 'window': window, 'gap': g, 'k': k, 'kind': kind, 'ok': ok,
                    'sent_rows': sent_rows, 'sent_tombs': sent_tombs, 'pic_rows': len(copy.rows),
                    'bytes': sent_rows * ROW_B + sent_tombs * TOMB_B, 'pic_bytes': len(copy.rows) * ROW_B,
                    'min_bytes': min(sent_rows * ROW_B + sent_tombs * TOMB_B, len(copy.rows) * ROW_B)})
        # the client goes on live from here, then goes away again
        base_pos, base = copy.pos, dict(got)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', type=int, default=1000)
    ap.add_argument('--resumes', type=int, default=8)
    ap.add_argument('--plant', default='')
    ap.add_argument('--out')
    a = ap.parse_args()
    a.rows = (1000, 10000)
    a.windows = (1000, 10000, None)          # None: tombstones kept for ever
    a.gaps = (1, 10, 100, 1000, 10000, 'near')
    allr = []
    for s in range(a.seeds):
        allr.extend(one(s, a))
    bad_seeds = len({r['seed'] for r in allr if not r['ok']})
    summ = {'plant': a.plant or None, 'seeds': a.seeds, 'resumes': len(allr),
            'wrong': sum(1 for r in allr if not r['ok']), 'seeds_wrong': bad_seeds,
            'pictures': sum(1 for r in allr if r['kind'] == 'pic')}
    cells = {}
    for r in allr:
        cells.setdefault((r['rows'], r['window'], r['gap']), []).append(r)
    summ['cells'] = []
    for (n, w, g), rs in sorted(cells.items(), key=lambda x: (x[0][0], x[0][1] or 10**9,
                                                          x[0][2] if x[0][2] != 'near' else 10**6)):
        fr = [r['bytes'] / r['pic_bytes'] for r in rs if r['pic_bytes']]
        fm = [r['min_bytes'] / r['pic_bytes'] for r in rs if r['pic_bytes']]
        summ['cells'].append({'rows': n, 'window': w, 'gap': g, 'n': len(rs),
                              'pictures': sum(1 for r in rs if r['kind'] == 'pic'),
                              'median_bytes': statistics.median(r['bytes'] for r in rs),
                              'median_pic_bytes': statistics.median(r['pic_bytes'] for r in rs),
                              'median_share': round(statistics.median(fr), 4),
                              'max_share': round(max(fr), 4),
                              'bigger': sum(1 for x in fr if x > 1),
                              'median_share_min': round(statistics.median(fm), 4)})
    print(json.dumps(summ))
    if a.out:
        with open(a.out, 'a') as f:
            f.write(json.dumps(summ) + '\n')


if __name__ == '__main__':
    main()
