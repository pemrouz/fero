"""Find reads that no linearization can explain, with a proof a person can check by hand.

For an ok read R of key k that returned v: let S be the writes and cas on k that finished ok
before R was sent, and T0 the latest call time among them. Whatever value R saw was written by
the last write linearized before R; that op is linearized at or after T0 (it comes after every op
in S, and the member of S called last is linearized after its call T0), so it finished after T0 or
never answered, and it was called before R answered. If no op on k that could have written v (an ok
or unanswered write of v, an ok or unanswered cas to v) was called before R answered and finished
after T0 or stayed unanswered, R cannot be linearized.
Failed operations surely did not happen and are ignored, as Knossos and Porcupine do.
Prints each such read with S's last op and the candidate count (0). Usage:
stale_witness.py <history.edn> [key]
"""
import json
import subprocess
import sys
import os

INF = 1 << 62
here = os.path.dirname(os.path.abspath(__file__))
ops = [json.loads(l) for l in subprocess.run(
    [sys.executable, '-I', os.path.join(here, 'porcupine', 'hist2json.py'), sys.argv[1]],
    capture_output=True, text=True, check=True).stdout.splitlines()]
only = int(sys.argv[2]) if len(sys.argv) > 2 else None


def writes(o):
    """The value an op may write, or None."""
    if o['f'] == 'write':
        return o['value']
    if o['f'] == 'cas':
        return o['to']
    return None


found = 0
for r in ops:
    if r['f'] != 'read' or r['type'] != 'ok' or (only is not None and r['key'] != only):
        continue
    k, v = r['key'], r['value']
    s = [o for o in ops if o['key'] == k and o['f'] != 'read' and o['type'] == 'ok' and o['ret'] < r['call']]
    if not s:
        continue
    last = max(s, key=lambda o: o['call'])
    t0 = last['call']
    cands = [o for o in ops if o['key'] == k and writes(o) == v and o['ret'] >= t0 and o['call'] < r['ret']]
    if cands:
        continue
    found += 1
    print(f"key {k}: read by process {r['client']} sent at {r['call'] / 1e9:.4f} s returned {v}; "
          f"the last-called op that finished before it: {last['f']} {writes(last)} by process {last['client']}, "
          f"called {t0 / 1e9:.4f} s, done {last['ret'] / 1e9:.4f} s; ops that could have written {v} and finished "
          f"after {t0 / 1e9:.4f} s or never answered, called before the read answered: 0")
print(f'{found} reads that no linearization can explain')
