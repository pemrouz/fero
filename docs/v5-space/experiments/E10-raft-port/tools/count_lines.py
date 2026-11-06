"""Counts lines of code: physical lines, non-blank, and code (non-blank, non-comment).
Handles // and /* */ comments (Go, TS, Rust). Usage: python3 -I count_lines.py <files...>
Prints one row per file and a total; tests and generated code are the caller's choice."""
import sys

def count(path):
    phys = blank = comment = 0
    in_block = False
    with open(path, encoding='utf-8', errors='replace') as f:
        for raw in f:
            phys += 1
            s = raw.strip()
            if in_block:
                comment += 1
                if '*/' in s:
                    in_block = False
                continue
            if not s:
                blank += 1
            elif s.startswith('//'):
                comment += 1
            elif s.startswith('/*'):
                comment += 1
                if '*/' not in s[2:]:
                    in_block = True
    return phys, phys - blank, phys - blank - comment

tot = [0, 0, 0]
for p in sys.argv[1:]:
    c = count(p)
    tot = [a + b for a, b in zip(tot, c)]
    print(f"{c[0]:7d} {c[1]:7d} {c[2]:7d}  {p}")
print(f"{tot[0]:7d} {tot[1]:7d} {tot[2]:7d}  TOTAL (physical, non-blank, code)")
