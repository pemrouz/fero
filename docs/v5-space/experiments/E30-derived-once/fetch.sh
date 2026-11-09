#!/bin/sh
# The model is plain Python 3 on E-16's engine and E-17's rule language (read
# unchanged from ../E16-controller-loop and ../E17-partitioning). The outside
# checker is real Elle 0.2.8 (jepsen-io/elle, Clojure), with its jars in
# $SP/dl/elle-mvn/jars/, fetched and checksum-checked by E-22b's fetch.sh:
exec "$(cd "$(dirname "$0")" && pwd)/../E22b-real-elle/fetch.sh" "$@"
