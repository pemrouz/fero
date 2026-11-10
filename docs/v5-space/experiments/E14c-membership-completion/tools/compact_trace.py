#!/usr/bin/env python3
"""compact_trace.py: one line per changed state of a TLC error trace (role,
term, commit index, who is up, faults, votes) and the logs when they change.

  python3 tools/compact_trace.py SEG.out > results/RUN-trace.txt
"""
import re
import sys


def var(s, name):
    m = re.search(r'/\\ ' + name + r' = (.*?)(?=\n/\\ |\n\n|\Z)', s, re.S)
    return re.sub(r'\s+', ' ', m.group(1)) if m else '?'


def short(v):
    return v.replace('"', '').replace(' @@ ', ', ').replace(':> ', '')


ENTRY = re.compile(r'\[\s*([^\[\]]*\[[^\[\]]*\][^\[\]]*)\]')


def shortentry(m):
    """One log entry, whatever order TLC prints its fields in: v<t> for an
    empty entry of term t, C<t>:{voters} for a configuration entry."""
    body = m.group(1)
    t = re.search(r'term \|-> (\d+)', body)
    if t is None or 'type |->' not in body:
        return m.group(0)
    if 'ConfigEntry' in body:
        v = re.search(r'newconf \|-> (\{[^}]*\})', body)
        return 'C%s:%s' % (t.group(1), v.group(1) if v else '?')
    v = re.search(r'val \|-> (\d+)', body)
    return ('v%s' % t.group(1)) if v and v.group(1) == '1' else ('x%s' % t.group(1))


def shortlog(lg):
    return ENTRY.sub(shortentry, lg).replace(' @@ ', ' | ')


def main():
    t = open(sys.argv[1]).read()
    i = t.find('Error: Invariant')
    print(t[i:t.find('\n', i)])
    print('(v<t> = an empty entry of term t; x<t> = a client entry; C<t>:{...} = a configuration entry of term t with those voters)')
    body = t[t.find('Error: The behavior up to this point is:'):]
    parts = re.split(r'\nState (\d+): ', body)
    prev = None
    for k in range(1, len(parts), 2):
        s = parts[k + 1]
        act = s.split('\n', 1)[0]
        row = (short(var(s, 'state')), short(var(s, 'currentTerm')), short(var(s, 'commitIndex')), var(s, 'up'),
               var(s, 'faults'), short(var(s, 'votedFor')), shortlog(var(s, 'log')),
               re.sub(r'jointConfig \|-> <<(\{[^}]*\}), \{\}>>, learners \|-> ', r'V\1 L', short(var(s, 'config'))))
        if row != prev:
            print('%s %s' % (parts[k], act[:80]))
            print('    role %s | term %s | commit %s | up %s | faults %s | voted %s' % row[:6])
            if prev is None or row[6] != prev[6]:
                print('    log %s' % row[6])
            if prev is None or row[7] != prev[7]:
                print('    applied config %s' % row[7])
        prev = row


if __name__ == '__main__':
    main()
