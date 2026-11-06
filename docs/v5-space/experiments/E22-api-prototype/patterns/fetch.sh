#!/bin/sh
# E-22 step 2 downloads nothing. It needs what step 1 needs: Node 22 (22.22.0 here), TypeScript 6.0.2
# on PATH for ./run.sh types, and data at 63fea66, which step 1's fetch.sh clones:
exec "$(dirname "$0")/../fetch.sh" "$@"
