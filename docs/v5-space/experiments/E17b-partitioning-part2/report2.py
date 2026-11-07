#!/usr/bin/env python3
"""
report2.py: results/summary.md for E-17 part 2, made by E-17's own
report.py (unchanged) over part 2's options only.

    python3 report2.py > results/summary.md
"""
import contextlib
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
H = os.path.join(os.path.dirname(HERE), 'E17-partitioning')
sys.path.insert(0, os.path.join(H, 'harness'))
import report                                       # noqa: E402
import runner                                       # noqa: E402

# pslot-fused lives in options/pslot/fused.py: count its model lines there
_load = runner.load


def _load_fused_path(name):
    cls, path = _load(name)
    if name == 'pslot-fused':
        path = os.path.join(os.path.dirname(path), 'fused.py')
    return cls, path


runner.load = _load_fused_path

report.ORDER = ('pslot', 'pslot-rev', 'pslot+abort', 'pslot+giveup',
                'pslot-fused', 'pslot-fused-rev', 'pslot-fused+abort',
                'split', 'split-rev', 'split+giveup',
                'lanes', 'lanes-rev', 'lanes-carry', 'lanes+abort',
                'slot', 'slot-rev', 'slot+abort')
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    report.main()
out = buf.getvalue().replace('# E-17 part 1: results',
                             '# E-17 part 2: results (pslot, split + merge, lanes + range moves; slot from part 1 for reference)', 1)
print(out)
