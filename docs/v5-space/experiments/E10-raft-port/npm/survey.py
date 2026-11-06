"""Summarises npm registry metadata for JS Raft libraries (no tarball is downloaded or run).
Reads the search results and packuments fetched by npm/fetch.sh. Usage:
  python3 -I npm/survey.py <dir with search_*.json and pack/*.json>"""
import json, glob, os, re, sys

d = sys.argv[1]
search = {}
for f in glob.glob(os.path.join(d, 'search_*.json')):
    for o in json.load(open(f))['objects']:
        search[o['package']['name']] = o
rows = []
for f in sorted(glob.glob(os.path.join(d, 'pack', '*.json'))):
    p = json.load(open(f))
    if 'error' in p or 'dist-tags' not in p:
        continue
    name = p['name']
    latest = p['dist-tags'].get('latest')
    v = p['versions'].get(latest, {})
    t = p.get('time', {})
    readme = (p.get('readme') or '') + (v.get('readme') or '')
    test = (v.get('scripts') or {}).get('test', '')
    dev = sorted((v.get('devDependencies') or {}).keys())
    deps = sorted((v.get('dependencies') or {}).keys())
    s = search.get(name, {})
    flags = [k for k, rx in [
        ('etcd', r'etcd'), ('datadriven', r'datadriven|data-driven'), ('jepsen', r'jepsen'),
        ('TLA+', r'\bTLA\+?|tla\+'), ('simulation', r'simulat'), ('fuzz', r'fuzz'),
        ('joint/membership', r'joint consensus|membership change|add.?server|addPeer|add peer|reconfig'),
        ('snapshot', r'snapshot'), ('prevote', r'pre-?vote'), ('production', r'production'),
    ] if re.search(rx, readme, re.I)]
    real_test = bool(test) and 'no test specified' not in test
    rows.append(dict(
        name=name, latest=latest, created=t.get('created', '')[:10], last_publish=t.get(latest, '')[:10],
        versions=len(p.get('versions', {})), license=v.get('license') or p.get('license'),
        weekly=(s.get('downloads') or {}).get('weekly'), dependents=s.get('dependents'),
        test_script=test[:60], has_test_script=real_test,
        test_devdeps=[x for x in dev if re.search(r'mocha|jest|tap|ava|vitest|chai|tape|lab|jasmine|c8|nyc|sinon', x)],
        deps=len(deps), types=bool(v.get('types') or v.get('typings')), files=(v.get('dist') or {}).get('fileCount'),
        unpacked_kb=round(((v.get('dist') or {}).get('unpackedSize') or 0) / 1024), readme_mentions=flags,
        description=(p.get('description') or '')[:100],
    ))
rows.sort(key=lambda r: -(r['weekly'] or 0))
json.dump(rows, open(os.path.join(d, 'survey.json'), 'w'), indent=1)
print('| package | latest | last publish | versions | weekly dl | dependents | test script | test devDeps | types | readme mentions |')
print('|---|---|---|---|---|---|---|---|---|---|')
for r in rows:
    print(f"| {r['name']} | {r['latest']} | {r['last_publish']} | {r['versions']} | {r['weekly'] if r['weekly'] is not None else '?'} | {r['dependents'] if r['dependents'] is not None else '?'} | {'yes' if r['has_test_script'] else 'no'} | {', '.join(r['test_devdeps']) or '-'} | {'yes' if r['types'] else 'no'} | {', '.join(r['readme_mentions']) or '-'} |")
