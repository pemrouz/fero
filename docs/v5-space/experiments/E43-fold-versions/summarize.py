#!/usr/bin/env python3
"""E-43: print the tables of the README from results/. Run after ./run.sh: python3 summarize.py > results/summary.md"""
import json, os, re, glob
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
def lines(f):
    p = os.path.join(R, f)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
VER = {}
for l in open(os.path.join(R, 'commits.txt')):
    a = l.split(); VER[a[0]] = a[2]
ORDER = ['4479a92', '6b615e2', 'b831319', '46df5f9', 'ff85e6c', 'dc65b8f', '2b8b780', '63fea66']
runs = {}
for d in lines('fold.jsonl'):
    if d.get('failed'): runs[(d['data'], d['mode'], d['node'])] = None; continue
    runs[(d['data'], d['mode'], 'n22' if d['node'].startswith('v22') else 'n26')] = d

print('### The folds: final rows and digests (1,000,000 records)\n')
print('"refused" counts records the fold did not take (a reject or a throw). The digest is SHA-256 (first 16 hex digits) of the rows in the engine\'s own order.\n')
print('| data commit | SCHEDULE_VERSION | way in | rows at the end | refused | digest, Node 22 | Node 26: same digest, same per-record results |')
print('|---|---|---|---|---|---|---|')
for mode in ['lane-rec', 'lane-b256', 'seam', 'ingest-rec', 'ingest-b256']:
    for c in ORDER:
        a, b = runs.get((c, mode, 'n22')), runs.get((c, mode, 'n26'))
        if a is None and (c, mode, 'n22') not in runs: continue
        if a is None: print('| %s | %s | %s | run failed | | | |' % (c, VER[c], mode)); continue
        same = 'no Node 26 run' if b is None else ('yes' if (a['final']['engine'] == b['final']['engine'] and a['final']['public'] == b['final']['public'] and a['chain'] == b['chain'] and a.get('digest') == b.get('digest') and a.get('outcomes') == b.get('outcomes')) else '**NO**')
        refused = a['refused'] if a.get('refused') is not None else '%d rejected, %d calls threw' % (a['rejected'], a['threw'])
        print('| %s | %s | %s | %s | %s | %s | %s |' % (c, VER[c], mode, '{:,}'.format(a['final']['rows']), ('{:,}'.format(refused) if isinstance(refused, int) else refused), a['final']['engine'], same))

pairs = lines('pairs.jsonl')
def show(title, sel):
    print('\n### %s\n' % title)
    print('| pair | from | to | records after which the row differs | of those, where the two folds parted (roots) | rows still apart at the end | same row, but one side refused |')
    print('|---|---|---|---|---|---|---|')
    for p in pairs:
        if not sel(p['pair']): continue
        d = p['diff']
        print('| %s | %s | %s | %s | %s | %s | %s |' % (p['pair'], p['a'], p['b'], '{:,}'.format(d['rowDiffers']), '{:,}'.format(d['roots']), '{:,}'.format(d['rowsApartAtEnd']), '{:,}'.format(d['sameRowOtherOutcome'])))
show('data version against data version, Node 22', lambda n: n.startswith(('lane-', 'ingest-', 'seam-')))
show('three ways in at HEAD (the same data commit)', lambda n: n.startswith('head-'))
print('\n### Node 22 against Node 26\n')
node = [p for p in pairs if p['pair'].startswith('node-')]
bad = [p for p in node if p['diff']['rowDiffers'] or p['diff']['sameRowOtherOutcome']]
print('%d pairs (every commit, every per-record way in): %d differ.%s' % (len(node), len(bad), '' if not bad else ' ' + ', '.join(p['pair'] for p in bad)))

print('\n### Batch boundaries: one record a call against 256 a call\n')
print('| data commit | way in | same final rows | same at all 20 checkpoints |')
print('|---|---|---|---|')
for kind in ['lane', 'ingest']:
    for c in ORDER:
        a, b = runs.get((c, kind + '-rec', 'n22')), runs.get((c, kind + '-b256', 'n22'))
        if not a or not b: continue
        print('| %s | %s | %s | %s |' % (c, kind, 'yes' if a['final']['engine'] == b['final']['engine'] else '**no** (%s rows against %s)' % ('{:,}'.format(a['final']['rows']), '{:,}'.format(b['final']['rows'])), 'yes' if a['chain'] == b['chain'] else '**no**'))

def short(s, n=150): return s if len(s) <= n else s[:n] + '...'
print('\n### Where the folds part: the roots, by what the record met\n')
print('At most 3,000 roots per pair were explained (the first 3,000 in stream order). What the record writes, and the sort of value at the leaf, are left off so that like cases count together.\n')
for f in sorted(glob.glob(os.path.join(R, 'roots-*.json'))):
    name = os.path.basename(f)[6:-5]
    if name.startswith('node-'): continue
    groups = json.load(open(f))
    merged = {}
    for g in groups:
        k = re.sub(r'leaf own \w+', 'leaf present', re.sub(r'; writes \w+', '', g['situation']))   # like cases count together
        m = merged.setdefault(k, {'n': 0, 'ex': g['example']}); m['n'] += g['roots']
    tot = sum(m['n'] for m in merged.values())
    if not tot: continue
    print('**%s** (%s roots explained)\n' % (name, '{:,}'.format(tot)))
    print('| roots | what the record met; then how each side answered | example: the row before; the record; the row after on each side |')
    print('|---|---|---|')
    for k, m in sorted(merged.items(), key=lambda x: -x[1]['n'])[:8]:
        ex = m['ex']; sides = [x for x in ex if x not in ('index', 'record', 'before')]
        print('| %s | %s | record %s: before `%s`; record `%s`; %s |' % ('{:,}'.format(m['n']), k.replace('|', '/'), '{:,}'.format(ex['index']), short(ex['before'], 110), short(ex['record'], 110), '; '.join('%s: %s, `%s`' % (s, ex[s]['outcome'][:60], short(ex[s]['after'], 110)) for s in sides)))
    print()

print('\n### Views: Node 22 against Node 26, and a view that watched every record against one built at the end\n')
vs = lines('views.jsonl')
by = {}
for v in vs: by.setdefault(v['data'], {})[v['node'][:3]] = v
print('| data commit | view | Node 22 = Node 26 | live = rebuilt (content) | live = rebuilt (order too) |')
print('|---|---|---|---|---|')
for c, d in by.items():
    a, b = d.get('v22'), d.get('v26')
    if not a or 'views' not in a: print('| %s | (views could not be built: %s) | | | |' % (c, (a or {}).get('error', ''))); continue
    for name, v in a['views'].items():
        same = 'no Node 26 run' if not b or 'views' not in b else ('yes' if b['views'][name]['live'] == v['live'] and b['views'][name]['fresh'] == v['fresh'] else '**NO**')
        print('| %s | %s | %s | %s | %s |' % (c, name, same, 'yes' if v['sameContent'] else '**no**', 'yes' if v['sameOrder'] else 'no'))
for c, d in by.items():
    a = d.get('v22')
    if a and 'values' in a: print('\n%s, Node 22: %s; same sort-field sequence live and rebuilt: %s' % (c, '; '.join('%s live %s, rebuilt %s' % (k, v[0], v[1]) for k, v in a['values'].items()), a.get('sameSortFieldSequence')))

print('\n### One record that sets an array\'s length\n')
print('| Node | length set to | bytes of that record | one later write under the array | a write beside it | the row encoded for the wire |')
print('|---|---|---|---|---|---|')
for d in lines('bigarray.jsonl'):
    print('| %s | %s | %d | %s ms | %s ms | %s |' % (d['node'], '{:,}'.format(d['lengthSetTo']), d['recordBytes'], d['msForOneWriteUnderTheArray'], d['msForAWriteBesideTheArray'], ('%s bytes in %s ms' % ('{:,}'.format(d['encodedRowBytes']), d['msToEncodeTheRow'])) if isinstance(d['encodedRowBytes'], int) else d['encodedRowBytes']))

print('\n### Names that are also names on Object.prototype\n')
print('| data commit | Node | case | rows in the engine | rows in the public snapshot | Object.prototype changed | row a afterwards |')
print('|---|---|---|---|---|---|---|')
for d in lines('hostile.jsonl'):
    for k, v in d.items():
        if isinstance(v, dict):
            print('| %s | %s | %s | %s | %s | %s | %s |' % (d['data'], d['node'], k, ', '.join(v['engineRows']), ', '.join(v['publicRows']) if isinstance(v['publicRows'], list) else v['publicRows'], 'no' if not v['objectPrototypeAfter'] else '**yes** ' + str(v['objectPrototypeAfter']), '' if v['rowA'] is None else ('own keys %s; reads .polluted = %s; plain prototype: %s' % (v['rowA']['ownKeys'], v['rowA']['readsPolluted'], v['rowA']['plainPrototype']))))

print('\n### JavaScript behaviours: Node 22 against Node 26\n')
p22 = dict(l.rstrip('\n').split('\t', 1) for l in open(os.path.join(R, 'nodeprobe-node22.txt')))
p26 = dict(l.rstrip('\n').split('\t', 1) for l in open(os.path.join(R, 'nodeprobe-node26.txt')))
diff = [k for k in p22 if p22[k] != p26.get(k)]
print('%d probes, %d differ (%d of them are the version strings themselves).\n' % (len(p22), len(diff), len([k for k in diff if k.startswith('version.')])))
print('| probe | Node 22 | Node 26 |')
print('|---|---|---|')
for k in diff:
    a, b = p22[k], p26.get(k, '')
    if len(a) > 160 or len(b) > 160:
        try:
            ja, jb = json.loads(a), json.loads(b)
            idx = [i for i in range(min(len(ja), len(jb))) if ja[i] != jb[i]]
            a = '; '.join(str(ja[i]) for i in idx[:6]); b = '; '.join(str(jb[i]) for i in idx[:6])
        except Exception:
            wa, wb = a.split(' '), b.split(' ')
            idx = [i for i in range(min(len(wa), len(wb))) if wa[i] != wb[i]]
            a = ' '.join(wa[i] for i in idx[:6]); b = ' '.join(wb[i] for i in idx[:6])
    print('| %s | `%s` | `%s` |' % (k, short(a.replace('|', '/'), 200), short(b.replace('|', '/'), 200)))
