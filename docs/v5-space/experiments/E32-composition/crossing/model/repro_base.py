"""Step 1: reproduce the base. Runs E-17's slot model, unchanged, on every
SWEEP bound and compares states, edges and digest with E-17's stored
results/slot-ablation.json (base)."""
import json, os, sys
if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)
HERE = os.path.dirname(os.path.abspath(__file__))
E17 = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'E17-partitioning'))
sys.path.insert(0, os.path.join(E17, 'harness'))
import runner
from bounds import SWEEP
old = json.load(open(os.path.join(E17, 'results', 'slot-ablation.json')))['base']
ok = True
for b in SWEEP:
    r = runner.run('slot', b, stop_first=False)
    same = list(r.digest) == old[b]['digest'] and not r.fail
    ok &= same
    print(f'{b:7} {r.states:7,} states {r.edges:8,} steps {r.secs:6.1f}s  fails: {sorted(r.fail) or "none"}  '
          f'stored digest {old[b]["digest"]}  now {list(r.digest)}  {"SAME" if same else "DIFFERENT"}')
print('base reproduced' if ok else 'BASE DIFFERS')
