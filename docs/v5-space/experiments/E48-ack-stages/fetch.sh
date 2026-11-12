#!/bin/sh
# E-48 downloads nothing. The model is plain Python 3 (standard library only) on
# E-16's engine (../E16-controller-loop/engine/engine.py), which loads E-17's
# rule language (../E17-partitioning/harness/dsl.py); both are in this repo.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
for f in "$HERE/../E16-controller-loop/engine/engine.py" "$HERE/../E17-partitioning/harness/dsl.py"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done
python3 --version
echo "E-48 needs nothing else"
