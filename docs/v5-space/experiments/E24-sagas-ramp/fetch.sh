#!/bin/sh
# E-24 downloads nothing of its own. The models are plain Python 3 (standard
# library only) on E-16's engine and E-17's rule language, both in this repo.
# The Elle step uses real Elle 0.2.8 and its jars, fetched from Clojars with
# Maven and checked by sha1/sha256 in ../E22b-real-elle/fetch.sh (listed in
# ../TOOLS.md). This script only checks that they are there.
set -eu
SP="${SP:-/tmp/fero-sp}"
[ -f "$SP/dl/elle-mvn/jars/elle-0.2.8.jar" ] || sh "$(dirname "$0")/../E22b-real-elle/fetch.sh"
sha1sum "$SP/dl/elle-mvn/jars/elle-0.2.8.jar" | grep -q a6dc52fca28872825e65e74ec7f51862e7bd34ab && echo "elle 0.2.8 ok"
