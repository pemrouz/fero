#!/bin/sh
# E-18 downloads nothing. It needs only what the study box already has:
#   Python 3.13 with numpy (2.5.3 here) and pandas (for report.py only), and gcc.
# This script checks they are present and says which versions it found.
set -eu
python3 -c 'import sys, numpy, pandas; print("python", sys.version.split()[0], "numpy", numpy.__version__, "pandas", pandas.__version__)'
gcc --version | head -1
echo "nothing to fetch"
