#!/bin/sh
# E-23 downloads nothing. It needs only what is on the box:
#   - Node 22 (run with --experimental-strip-types; measured on v22.22.0)
#   - Python 3 (only for the cross-check of the exact sum against math.fsum)
#   - data, the state engine, at the commit E-23 ran against.
# This script checks those three and says what differs.
set -eu
DATA_DIR=${DATA_DIR:-/home/user/pemrouz/data}
WANT=63fea66fb5d1369023ae1baa35c27302ce0c7157
node --version
python3 --version
HAVE=$(git -C "$DATA_DIR" rev-parse HEAD)
if [ "$HAVE" = "$WANT" ]; then
  echo "data at $WANT: ok"
else
  echo "data is at $HAVE, E-23 ran at $WANT."
  echo "To match: git -C $DATA_DIR checkout $WANT (data's repository: https://github.com/pemrouz/data)"
fi
[ -z "$(git -C "$DATA_DIR" status --porcelain)" ] && echo "data working tree clean: ok" || echo "data has local changes"
