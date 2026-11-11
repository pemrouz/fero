#!/usr/bin/env python3
"""Write judging/closure/results/ladder-*.md: the support ladder under each mix of the user's open choices.
Run from docs/v5-space: python3 tools/closure_ladders.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import closure as C

R = 'judging/closure/results'
RUNS = [('restated', ()), ('restated', ('DATA-01 reading',)), ('restated', ('PERF-01 losses',)),
        ('restated', ('PERF-01 losses', 'DATA-01 reading')), ('worded', ()), ('restated', ('other',)),
        ('restated', ('F_w',)), ('restated', ('N_res',)), ('restated', ('shared tier',)), ('restated', ('region scope',)), ('restated', ('fsync figure',))]

for f in os.listdir(R):
    if f.startswith('ladder-'):
        os.remove(os.path.join(R, f))
for sc, ch in RUNS:
    txt, rows, S = C.ladder(sc, ch or None, None)  # every cap from 0 up; a run of caps with the same result prints as one line
    tag = sc + ''.join('-' + c.replace(' ', '_') for c in ch)
    head = '# Support ladder: %s%s\n\nBuilt by `python3 tools/closure_ladders.py`. Rule 3 among the rows that are in, as more cells that no judged row supports are allowed (the judged rows include the closure pass\'s, judging/closure/hybrids/cards.json). Columns: novel / SHOULDs / pairs / open MUSTs.\n\n' % (sc, (', choices: ' + ', '.join(ch)) if ch else '')
    open('%s/ladder-%s.md' % (R, tag), 'w').write(head + txt + '\n')
    print('=====', tag); print('\n'.join(txt.split('\n')[:9]))
