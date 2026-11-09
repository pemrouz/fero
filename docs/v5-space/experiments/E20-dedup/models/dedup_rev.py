"""dedup_rev.py: dedup.py's options with their actions in reverse order, so
the ablation's greedy drops run in reverse model-text order (E-17 finding 5:
the order can change which of two twin rules is kept). Nothing else differs."""
import importlib.util
import os

_spec = importlib.util.spec_from_file_location('e20dedup', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dedup.py'))
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)


def rev(cls):
    class R(cls):
        def actions(self):
            return list(reversed(cls.actions(self)))
    R.__name__ = cls.__name__ + 'Rev'
    return R


OPTIONS = {k: rev(v) for k, v in base.OPTIONS.items()}
BOUNDS, SWEEP, VERIFY, PINNED, FIELDS = base.BOUNDS, base.SWEEP, base.VERIFY, base.PINNED, base.FIELDS
PINNED = dict(PINNED)
