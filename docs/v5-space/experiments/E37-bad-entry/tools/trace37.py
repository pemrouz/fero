#!/usr/bin/env python3
"""trace37.py: condense a TLC error trace of MCbadentry to one line per
state, so a reader can follow it.

  python3 tools/trace37.py TLC_LOG

Per server: its role (L leader, C candidate, F follower, - down, x gone for
good), its term, its log as entries, its commit index, and a bad slot if
any. Entries: g = the genesis config (term 1), nT = a leader's empty entry
of term T, cT = a client entry of term T, ?T = a damaged entry (its value
flipped, term T kept), XX = a zeroed record (the par mode's bad slot). The
step is named from what changed.
"""
import re
import sys


def blocks(text):
    parts = re.split(r'^State (\d+): <([^>]*)>\s*$', text, flags=re.M)
    out = []
    for k in range(1, len(parts) - 2, 3):
        body = re.split(r'^(?:[0-9,]+ states generated|Error|The |Finished|Progress|Model checking)', parts[k + 2],
                        flags=re.M)[0]
        out.append((int(parts[k]), parts[k + 1], body))
    return out


def var(body, name):
    m = re.search(r'^/\\ ' + name + r' = (.*?)(?=^/\\ |\Z)', body, re.M | re.S)
    return ' '.join(m.group(1).split()) if m else ''


def per_server(v):
    """'( s1 :> X @@ s2 :> Y )' -> {'s1': 'X', ...}, bracket-aware."""
    v = v.strip()
    if v.startswith('(') and v.endswith(')'):
        v = v[1:-1]
    out = {}
    depth = 0
    cur = ''
    i = 0
    items = []
    while i < len(v):
        if v.startswith('<<', i):
            depth += 1
            cur += '<<'
            i += 2
            continue
        if v.startswith('>>', i):
            depth -= 1
            cur += '>>'
            i += 2
            continue
        c = v[i]
        if c in '[{(':
            depth += 1
        elif c in ']})':
            depth -= 1
        if depth == 0 and v.startswith('@@', i):
            items.append(cur)
            cur = ''
            i += 2
            continue
        cur += c
        i += 1
    if cur.strip():
        items.append(cur)
    for it in items:
        k, _, val = it.partition(':>')
        out[k.strip()] = val.strip()
    return out


def entries(v):
    res = []
    for m in re.finditer(r'\[\s*term \|-> (\d+),\s*type \|-> "(\w+)",\s*value \|-> \[([^\]]*)\]', v):
        t, ty, val = int(m.group(1)), m.group(2), m.group(3)
        if ty == 'ConfigEntry':
            res.append('g' if t == 1 else 'k%d' % t)
        elif 'val |-> 7' in val:
            res.append('XX' if t == 0 else '?%d' % t)
        elif 'val |-> 1' in val:
            res.append('n%d' % t)
        else:
            res.append('c%d' % t)
    return res


def main():
    text = open(sys.argv[1]).read()
    viol = re.search(r'Error: Invariant (\w+) is violated', text)
    print('violated: %s' % (viol.group(1) if viol else '-'))
    prev = None
    for n, lab, body in blocks(text):
        state = per_server(var(body, 'state'))
        term = per_server(var(body, 'currentTerm'))
        log = per_server(var(body, 'log'))
        ci = per_server(var(body, 'commitIndex'))
        bad = per_server(var(body, 'bad'))
        up = var(body, 'up')
        dead = var(body, 'dead')
        dmg = var(body, 'damaged')
        row = []
        for s in sorted(state):
            role = {'"Leader"': 'L', '"Follower"': 'F', '"Candidate"': 'C'}.get(state[s], '?')
            if s not in up:
                role = 'x' if s in dead else '-'
            b = bad.get(s, '0')
            row.append('%s:%s t%s [%s] ci%s%s' % (s, role, term.get(s), ' '.join(entries(log.get(s, ''))),
                                                 ci.get(s), (' bad@' + b) if b not in ('0', '') else ''))
        line = ' | '.join(row)
        msgs = var(body, 'messages')
        nm = msgs.count('mtype')
        print('%3d %s%s%s' % (n, line, ('  net:%d' % nm) if nm else '', ('  damaged ' + dmg) if dmg not in ('{}', '') else ''))
        prev = line


if __name__ == '__main__':
    main()
