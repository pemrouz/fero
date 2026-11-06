#!/bin/bash
# E-46 downloads: Maelstrom 0.2.4 (Jepsen's workbench; Knossos and Elle are inside its jar).
# GitHub publishes no checksum file for this release, so the sha256 below was recorded on
# first download (2026-11-06) and is checked on every later one.
# Also needed, from the Ubuntu archive: a JDK (openjdk 21 here) and Node 22 (22.22.0 here).
# gnuplot is NOT needed: Maelstrom's lin-kv runs did not ask for it on this box (see README).
set -euo pipefail
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
D="$SP/dl/maelstrom"
URL=https://github.com/jepsen-io/maelstrom/releases/download/v0.2.4/maelstrom.tar.bz2
SHA=301ec71d6b12af0d765edb413f5cf5aa1046b5609bd4e31376a0b549548e5799
JAR_SHA=7d35db06546a737134a4dd4eb3b7dfb0955537df992d922d18cc716080853f67
mkdir -p "$D"
[ -f "$D/maelstrom.tar.bz2" ] || curl -fsSL -o "$D/maelstrom.tar.bz2" "$URL"
echo "$SHA  $D/maelstrom.tar.bz2" | sha256sum -c -
[ -d "$D/maelstrom" ] || tar -C "$D" -xjf "$D/maelstrom.tar.bz2"
echo "$JAR_SHA  $D/maelstrom/lib/maelstrom.jar" | sha256sum -c -
