#!/usr/bin/env python3
"""trim_trace.py: shorten a TLC error trace for results/.

Keeps TLC's header and summary lines, and for every state of the trace only
the variables named (each on one line), plus the last state in full.

Usage: trim_trace.py IN OUT var [var ...]
"""
import re
import sys


def main():
    src, dst, names = sys.argv[1], sys.argv[2], sys.argv[3:]
    text = open(src).read()
    head, sep, rest = text.partition('Error: The behavior up to this point is:')
    if not sep:
        open(dst, 'w').write(text)
        return
    # states start with "State N:" lines
    parts = re.split(r'\n(?=State \d+: )', rest)
    tail_idx = None
    for k, p in enumerate(parts):
        if re.search(r'\n\d[\d,]* states generated', p):
            tail_idx = k
    out = [head.rstrip(), 'Error: The behavior up to this point is (trimmed: %s; the last state in full):' % ', '.join(names)]
    states = [p for p in parts if p.startswith('State ')]
    for k, p in enumerate(states):
        first = p.split('\n', 1)[0]
        if k == len(states) - 1:
            body = p
            m = re.search(r'\n\d[\d,]* states generated', body)
            if m:
                body = body[:m.start()]
            out.append(body.rstrip())
            continue
        out.append(first)
        # variables: lines starting with "/\ name = ", continuing until the next "/\ "
        for name in names:
            m = re.search(r'^/\\ %s = (.*?)(?=^/\\ |\Z)' % re.escape(name), p, re.S | re.M)
            if m:
                out.append('  %s = %s' % (name, ' '.join(m.group(1).split())))
    m = re.search(r'\n(\d[\d,]* states generated.*)', rest, re.S)
    if m:
        out.append(m.group(1).strip())
    open(dst, 'w').write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()
