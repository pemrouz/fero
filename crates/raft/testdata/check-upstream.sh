#!/bin/sh
# Checks that the vendored etcd raft test files are unchanged.
#
#   sh check-upstream.sh                  check against SHA256SUMS
#   sh check-upstream.sh <etcd raft dir>  also compare with an upstream checkout
#
# Ends with "ok testdata: 41 files", or says what differs and exits 1.
set -eu

COMMIT=c51f010c851edd0dada5af41bafbf68e54617767
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

fail() {
    echo "FAIL testdata: $1" >&2
    exit 1
}

count=$(find . -name '*.txt' | wc -l | tr -d ' ')
[ "$count" = 41 ] || fail "found $count files, etcd has 41"
[ "$(wc -l < SHA256SUMS | tr -d ' ')" = 41 ] || fail "SHA256SUMS does not list 41 files"
sha256sum --quiet -c SHA256SUMS || fail "a file differs from SHA256SUMS"

if [ $# -ge 1 ]; then
    up=$1
    [ -d "$up/testdata" ] || fail "$up does not look like an etcd raft checkout"
    if [ -e "$up/.git" ]; then
        head=$(git -C "$up" rev-parse HEAD)
        [ "$head" = "$COMMIT" ] || fail "the checkout is at $head, not $COMMIT"
    fi
    for pair in ".:testdata" "quorum:quorum/testdata" "confchange:confchange/testdata"; do
        mine=${pair%%:*}
        theirs=${pair#*:}
        for f in "$up/$theirs"/*.txt; do
            name=$(basename "$f")
            [ -f "$mine/$name" ] || fail "upstream has $theirs/$name, which is missing here"
            cmp -s "$f" "$mine/$name" || fail "$mine/$name differs from upstream $theirs/$name"
        done
        for f in "$mine"/*.txt; do
            name=$(basename "$f")
            [ -f "$up/$theirs/$name" ] || fail "$mine/$name is not in upstream $theirs"
        done
    done
fi

echo "ok testdata: $count files"
