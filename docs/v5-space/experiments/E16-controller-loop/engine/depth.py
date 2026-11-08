"""depth.py: how deep a breadth-first run gets within a state limit (safety only).

    python3 engine/depth.py MODELFILE OPTION BOUND LIMIT [RULE TO DROP ...]

Prints the states per level and the first safety failure with its depth.
Used to show that a verify run capped at the state limit still covers
every trace up to a stated length."""
# Prints states per level, and the first safety failure (property, depth).
import os, sys, resource, time
if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'; os.execv(sys.executable, [sys.executable] + sys.argv)
E16 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, E16 + '/engine')
import engine, importlib.util
path, opt, bound, limit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
drops = [a for a in sys.argv[5:]]
spec = importlib.util.spec_from_file_location('m', path); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
md = mod.OPTIONS[opt](mod.BOUNDS[bound]); c = engine.Compiled(md, engine.Mutation(drop=drops))
t = time.time(); init = md.init(); seen = {init}; level = [init]; d = 0; n = 1; fail = None
while level and n <= limit and fail is None:
    nxt = []
    for s in level:
        for lab, kind, u in c.succ(s):
            if c.err is not None:
                fail = fail or ('ERR', d + 1); c.err = None
            for p in md.check_edge(s, lab, kind, u):
                fail = fail or (p, d + 1)
            if u not in seen:
                seen.add(u); nxt.append(u); n += 1
                for p in md.check(u):
                    fail = fail or (p, d + 1)
    d += 1; level = nxt
    print(f'  depth {d}: {len(nxt):,} new, {n:,} total, {time.time()-t:.0f}s', flush=True)
print(opt, bound, 'drop', drops, 'states', n, 'levels', d, 'complete', not level, 'first failure', fail,
      f'{time.time()-t:.0f}s', 'peak RSS MB', resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024, flush=True)
