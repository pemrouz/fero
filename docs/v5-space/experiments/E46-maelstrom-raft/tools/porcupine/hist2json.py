"""Turn a Maelstrom lin-kv history.edn into JSON lines for the Porcupine check (one line per operation).

Each client operation is its invoke paired with the next completion of the same process.
:fail completions are dropped (the operation surely did not happen; Knossos drops them too).
:info completions, and invokes with no completion, become "info": the operation may have
happened at any time after its call, or never. Times are ns since the test start.
Usage: hist2json.py <history.edn> > ops.jsonl
"""
import json
import re
import sys

INF = 1 << 62
open_ops = {}
out = []


def parse_value(f, s):
    s = s.strip()
    if f == 'cas':
        m = re.match(r'\[(\d+) \[(\S+) (\S+)\]\]', s)
        return int(m.group(1)), {'from': int(m.group(2)), 'to': int(m.group(3))}
    m = re.match(r'\[(\d+) (\S+)\]', s)
    v = m.group(2)
    return int(m.group(1)), {'value': None if v == 'nil' else int(v)}


for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    if ':process :nemesis' in line:
        continue
    t = re.search(r':type :(\w+)', line)
    f = re.search(r':f :(\w+)', line)
    if not t or not f or f.group(1) not in ('read', 'write', 'cas'):
        continue
    p = int(re.search(r':process (\d+)', line).group(1))
    time = int(re.search(r':time (\d+)', line).group(1))
    v = re.search(r':value (\[.*?\]\]?)(,|\})', line)
    key, val = parse_value(f.group(1), v.group(1))
    if t.group(1) == 'invoke':
        open_ops[p] = {'key': key, 'f': f.group(1), 'call': time, 'client': p, **val}
        continue
    op = open_ops.pop(p, None)
    if op is None:
        continue
    if t.group(1) == 'fail':
        continue
    if t.group(1) == 'ok':
        op.update(type='ok', ret=time)
        if op['f'] == 'read':
            op['value'] = val['value']
    else:
        op.update(type='info', ret=INF)
    out.append(op)
for op in open_ops.values():
    op.update(type='info', ret=INF)
    out.append(op)
for op in out:
    print(json.dumps(op))
