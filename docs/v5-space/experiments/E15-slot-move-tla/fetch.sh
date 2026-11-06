#!/bin/sh
# What E-15 uses from outside: only the TLA+ tools. Downloads go in $SP/dl/<name>/.
#  - tla2tools.jar, TLC2 "Version 2026.11.06.005304 (rev: 3ec1cc4)", the TLA+
#    nightly, https://nightly.tlapl.us/dist/tla2tools.jar
#    sha256 654aa50197faa48fa0136b41257270de6469d29ef323e7822ead59d2be43ce10
#    (the nightly URL moves on; this checksum is the copy every run here used)
# Not used: CommunityModules. The spec uses only TLC's own TLC and TLCExt
# modules (TLCFP, TLCCache, TLCGetOrDefault).
# Also needed, from this repo: docs/v5-spec/slot_move.py (Python 3.13), at
# sha256 abf6e871c121cabe904e3823da81fd4ebc07a77f4f5c9b54a313201fa1584019.
set -e
SP="${SP:-/tmp/fero-sp}"
mkdir -p "$SP/dl/tla"
[ -f "$SP/dl/tla/tla2tools.jar" ] || curl -fsSL -o "$SP/dl/tla/tla2tools.jar" https://nightly.tlapl.us/dist/tla2tools.jar
echo "654aa50197faa48fa0136b41257270de6469d29ef323e7822ead59d2be43ce10  $SP/dl/tla/tla2tools.jar" | sha256sum -c - \
  || echo "warning: a different tla2tools.jar than the one E-15 used"
