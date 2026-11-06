#!/bin/sh
# Maelstrom runs this file as each node. Settings come in E46_* environment variables.
exec node --experimental-strip-types --no-warnings "$(dirname "$(readlink -f "$0")")/node.ts"
