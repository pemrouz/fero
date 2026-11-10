#!/bin/sh
# What E-14c uses from outside (the same as E-14b). Downloads go in $SP/dl/<name>/.
#  - CommunityModules, release 202611060952 (2026-11-06), from the
#    tlaplus/CommunityModules GitHub releases. GitHub's release page lists no
#    checksum file; the sha256 values below were recorded on first download
#    (2026-11-07) and are checked on every later one.
#  - tla2tools.jar, TLC2 "Version 2026.11.06.005304 (rev: 3ec1cc4)", the
#    TLA+ nightly that E-14 used (its fetch.sh). The nightly URL serves a new
#    build each day, so a later download will not match the sha256 below;
#    the script then says so and keeps going.
#  - etcd's raft at commit c51f010c851edd0dada5af41bafbf68e54617767
#    (raft/tla/etcdraft.tla, as E-14).
#  - E-14's model files are read from ../E14-membership-on-commit/tla and
#    E-14b's MCferolive.tla from ../E14b-membership-liveness/tla (read-only).
set -e
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
CM_TAG=202611060952
CM_DEPS_SHA=a3b27c40f1fb5085f30c6ead37e918457f8cfc62c1e50a1dc668ef592ad2b5fb
CM_SHA=f9ceeef40e8fa7a7944329802256ecedc18c81658fb4e55768b093e0bc617e28
TLA_SHA=654aa50197faa48fa0136b41257270de6469d29ef323e7822ead59d2be43ce10
mkdir -p "$SP/dl/communitymodules" "$SP/dl/tla" "$SP/dl/raftsrc"
cd "$SP/dl/communitymodules"
for a in CommunityModules-deps.jar CommunityModules.jar; do
  [ -f "$a" ] || curl -fsSL -o "$a" "https://github.com/tlaplus/CommunityModules/releases/download/$CM_TAG/$a"
done
echo "$CM_DEPS_SHA  CommunityModules-deps.jar" | sha256sum -c -
echo "$CM_SHA  CommunityModules.jar" | sha256sum -c -
[ -f "$SP/dl/tla/tla2tools.jar" ] || curl -fsSL -o "$SP/dl/tla/tla2tools.jar" https://nightly.tlapl.us/dist/tla2tools.jar
echo "$TLA_SHA  $SP/dl/tla/tla2tools.jar" | sha256sum -c - || echo "note: tla2tools.jar is not E-14's nightly build"
if [ ! -d "$SP/dl/raftsrc/raft" ]; then
  git clone https://github.com/etcd-io/raft "$SP/dl/raftsrc/raft"
  git -C "$SP/dl/raftsrc/raft" checkout c51f010c851edd0dada5af41bafbf68e54617767
fi
echo "15c445684529c59a59877951c7fb7df9a40da250aaa445f056ef48f56bb27044  $SP/dl/raftsrc/raft/tla/etcdraft.tla" | sha256sum -c -
