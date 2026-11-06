#!/bin/sh
# What E-14 uses from outside. Downloads go in $SP/dl/<name>/.
#  - tla2tools.jar, TLC2 "Version 2026.11.06.005304 (rev: 3ec1cc4)", the
#    TLA+ nightly: https://nightly.tlapl.us/dist/tla2tools.jar
#    sha256 of the copy used: see results/versions.txt
#  - etcd's raft at commit c51f010c851edd0dada5af41bafbf68e54617767, whose
#    raft/tla/ holds etcdraft.tla and MCetcdraft.tla(.cfg):
#    https://github.com/etcd-io/raft
# Not used: CommunityModules-deps.jar. tla/SequencesExt.tla, FiniteSetsExt.tla
# and BagsExt.tla define, in plain TLA+, the few operators the spec uses.
set -e
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
mkdir -p "$SP/dl/tla" "$SP/dl/raftsrc"
[ -f "$SP/dl/tla/tla2tools.jar" ] || curl -fsSL -o "$SP/dl/tla/tla2tools.jar" https://nightly.tlapl.us/dist/tla2tools.jar
if [ ! -d "$SP/dl/raftsrc/raft" ]; then
  git clone https://github.com/etcd-io/raft "$SP/dl/raftsrc/raft"
  git -C "$SP/dl/raftsrc/raft" checkout c51f010c851edd0dada5af41bafbf68e54617767
fi
sha256sum "$SP/dl/tla/tla2tools.jar" "$SP/dl/raftsrc/raft/tla/etcdraft.tla" \
  "$SP/dl/raftsrc/raft/tla/MCetcdraft.tla" "$SP/dl/raftsrc/raft/tla/MCetcdraft.cfg"
