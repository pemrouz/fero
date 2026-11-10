#!/usr/bin/env python3
"""E-43: count every root of one pair by what the record met. allroots.py <classify output.json>"""
import json, re, sys
g = json.load(open(sys.argv[1]))
m = {}
for x in g:
    k = re.sub(r'leaf own \w+', 'leaf present', re.sub(r'; writes \w+', '', x['situation']))
    m[k] = m.get(k, 0) + x['roots']
print('# every root of the pair lane-v4-v4later (dc65b8f against 2b8b780, both SCHEDULE_VERSION 4), by what the record met')
tot = sum(m.values()); s = sum(n for k, n in m.items() if 'string' in k.split('||')[0])
print('%d roots; %d of them have a string on the path of the write' % (tot, s))
for k, n in sorted(m.items(), key=lambda t: -t[1]): print('%6d  %s' % (n, k))
