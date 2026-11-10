#!/usr/bin/env python3
"""dotfilter.py: reads TLC's `-dump dot,actionlabels` stream (from a FIFO)
and keeps only what the liveness check needs, so a graph of millions of
states fits on the disk.

  dotfilter.py IN.dot OUT_PREFIX [--labels]

Writes OUT_PREFIX.g.gz, one line per node and per edge:
  N id goal live faults nup maxterm init plan open
  E src dst
and, with --labels, OUT_PREFIX.l.gz with each node's full TLC label
("id<TAB>label"), for printing a trace later.

The flags are read from MCferoraft's variables in each state's label:
goalv, livev, faults, up (counted), currentTerm (its largest value) and
planv and openv (2 when the model has no such variable).
"""
import gzip
import re
import sys

Q = r'"((?:[^"\\]|\\.)*)"'
NODE = re.compile(r'^(-?\d+) \[label=' + Q + r'(,tooltip=' + Q + r')?(.*)\];?\s*$')
EDGE = re.compile(r'^(-?\d+) -> (-?\d+)')
F_GOAL = re.compile(r'/\\\\ goalv = (TRUE|FALSE)')
F_LIVE = re.compile(r'/\\\\ livev = (TRUE|FALSE)')
F_FAULTS = re.compile(r'/\\\\ faults = (\d+)')
F_UP = re.compile(r'/\\\\ up = (\{[^}]*\})')
F_PLAN = re.compile(r'/\\\\ planv = (TRUE|FALSE)')
F_OPEN = re.compile(r'/\\\\ openv = (TRUE|FALSE)')
F_TERM = re.compile(r'/\\\\ currentTerm = \(([^)]*)\)')
TERMV = re.compile(r':> (\d+)')


def count_up(s):
    s = s.strip()
    return 0 if s == '{}' else s.count(',') + 1


def main():
    src, prefix = sys.argv[1], sys.argv[2]
    labels = '--labels' in sys.argv
    g = gzip.open(prefix + '.g.gz', 'wt', compresslevel=1)
    lf = gzip.open(prefix + '.l.gz', 'wt', compresslevel=1) if labels else None
    nn = ne = 0
    with open(src, encoding='utf-8', errors='replace') as f:
        for line in f:
            if ' -> ' in line:
                m = EDGE.match(line)
                if m:
                    g.write('E %s %s\n' % (m.group(1), m.group(2)))
                    ne += 1
                continue
            m = NODE.match(line.strip())
            if not m:
                continue
            lab = m.group(4) or m.group(2)
            t = F_TERM.search(lab)
            mt = max([int(x) for x in TERMV.findall(t.group(1))] or [0]) if t else 0
            pl = F_PLAN.search(lab)
            op = F_OPEN.search(lab)
            g.write('N %s %d %d %s %d %d %d %d %d\n' % (
                m.group(1),
                F_GOAL.search(lab).group(1) == 'TRUE',
                F_LIVE.search(lab).group(1) == 'TRUE',
                F_FAULTS.search(lab).group(1),
                count_up(F_UP.search(lab).group(1)),
                mt,
                'filled' in (m.group(5) or ''),
                2 if pl is None else (pl.group(1) == 'TRUE'),
                2 if op is None else (op.group(1) == 'TRUE')))
            if lf:
                lf.write('%s\t%s\n' % (m.group(1), lab))
            nn += 1
    g.close()
    if lf:
        lf.close()
    print('dotfilter: %d node lines, %d edge lines' % (nn, ne), file=sys.stderr)


if __name__ == '__main__':
    main()
