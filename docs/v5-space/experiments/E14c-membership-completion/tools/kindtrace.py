#!/usr/bin/env python3
"""kindtrace.py: one short trace file per kind of stuck state, from the
output of `classify.py RUNDIR JUDGE --trace`.

  python3 tools/kindtrace.py RUN_NAME CLASSIFY_OUTPUT OUT_PREFIX

Writes OUT_PREFIX-<kind>-trace.txt for each kind that has a trace, in
compact_trace.py's short form (one line per changed state).
"""
import io
import os
import re
import sys
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compact_trace  # noqa: E402


def main():
    run, src, prefix = sys.argv[1:4]
    t = open(src).read()
    parts = re.split(r'\n=== shortest trace to a stuck state of kind (\S+): (\d+) states ===\n', t)
    for k in range(1, len(parts), 3):
        kind, body = parts[k], parts[k + 2]
        tmp = prefix + '-' + kind + '.tlcout.tmp'
        with open(tmp, 'w') as f:
            f.write('Error: Invariant none: %s, shortest trace to a stuck state of kind %s\n' % (run, kind))
            f.write('Error: The behavior up to this point is:\n\n' + body)
        buf = io.StringIO()
        argv = sys.argv
        sys.argv = ['compact_trace.py', tmp]
        with redirect_stdout(buf):
            compact_trace.main()
        sys.argv = argv
        os.remove(tmp)
        out = prefix + '-' + kind + '-trace.txt'
        open(out, 'w').write(buf.getvalue())
        print('%s: %s states' % (out, parts[k + 1]))


if __name__ == '__main__':
    main()
