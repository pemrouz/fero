#!/bin/sh
# Upstream churn of etcd raft's non-test Go (what a port must follow), and raft-rs activity.
# Usage: tools/upstream_churn.sh <bare etcd raft clone> <bare raft-rs clone>
set -eu
E=$1; R=$2
cd "$E"
echo "## etcd raft, up to c51f010 ($(git log -1 --format=%ad --date=short c51f010))"
for since in 2023-11-06 2024-11-06 2025-11-06; do
  n=$(git log c51f010 --since=$since --no-merges --format=%h -- '*.go' ':!*_test.go' ':!raftpb/raft.pb.go' ':!rafttest/*' | wc -l)
  s=$(git log c51f010 --since=$since --no-merges --shortstat --format= -- '*.go' ':!*_test.go' ':!raftpb/raft.pb.go' ':!rafttest/*' | awk '{a+=$4; d+=$6} END{print a" added, "d" deleted"}')
  echo "since $since: $n non-merge commits touching non-test Go (generated pb and rafttest excluded); $s"
done
echo "### core commits since 2023-11-06, mechanical protobuf/pointer/lint commits filtered out"
git log c51f010 --since=2023-11-06 --no-merges --format='%h %ad %s' --date=short -- raft.go log.go log_unstable.go rawnode.go tracker quorum confchange read_only.go storage.go node.go | grep -iv "proto\|pointer\|GetXXX\|new to\|interface{}\|lint\|vet\|typo\|comment\|doc\|test" || true
cd "$R"
echo "## raft-rs: last commit $(git log -1 --format='%h %ad' --date=short); tags: $(git tag | tail -3 | tr '\n' ' ')"
echo "non-merge commits after v0.7.0 (2023-03-06): $(git log v0.7.0..HEAD --no-merges --format=%h | wc -l)"
git log v0.7.0..HEAD --no-merges --format='%h %ad %s' --date=short
echo "### raft-rs test data files at HEAD"
git ls-tree -r --name-only HEAD | grep "\.txt$" | grep -v "^datadriven/"
