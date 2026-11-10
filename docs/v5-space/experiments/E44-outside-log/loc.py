#!/usr/bin/env python3
# E-44: count lines of code the way DEV-05 asks: fero-owned lines, no tests, no blank lines, no comment lines.
#   loc.py <file> ...
import sys, re
tot = 0
for f in sys.argv[1:]:
    n = 0; in_block = False
    for line in open(f, encoding='utf8'):
        s = line.strip()
        if in_block:
            if '*/' in s: in_block = False
            continue
        if not s or s.startswith('//'): continue
        if s.startswith('/*'):
            if '*/' not in s: in_block = True
            continue
        n += 1
    print(f"{n:6d}  {f}"); tot += n
print(f"{tot:6d}  total")
