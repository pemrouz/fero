#!/bin/sh
# E-22 step 3: fetch and build the outside checkers. Everything comes from the Go module proxy,
# checked against the Go checksum database (go.sum pins each hash). Nothing else is downloaded.
#   Porcupine  github.com/anishathalye/porcupine v1.3.1  h1:fBZ4/NGNPnIDdd6xNtrNk9/GiEQ0L4FO5+scINN+t0E=
#   Elle (Go)  github.com/pingcap/tipocket v1.0.0         h1:gRvhXc+R8cveoI+FnlX2zWaj5VN/9Ec1ZgpTHpm2G+E=
#              (pkg/elle: a Go port of jepsen-io/elle's list-append checker; Elle itself is Clojure on
#              Clojars, which this box's proxy refuses: 403)
# Output: $SP/e22v/go-build/e22check
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
B="$SP/e22v/go-build"
export GOTOOLCHAIN=local GOFLAGS=-mod=mod
mkdir -p "$B"
cd "$B"
cp "$HERE"/go/*.go "$HERE"/go/go.mod "$B"/
[ -f "$HERE/go/go.sum" ] && cp "$HERE/go/go.sum" "$B"/
# the tipocket module zip, verified by the checksum database
SUM=$(go mod download -json github.com/pingcap/tipocket@v1.0.0 | sed -n 's/.*"Sum": "\(.*\)".*/\1/p')
[ "$SUM" = "h1:gRvhXc+R8cveoI+FnlX2zWaj5VN/9Ec1ZgpTHpm2G+E=" ] || { echo "tipocket checksum mismatch: $SUM"; exit 1; }
D="$(go env GOMODCACHE)/github.com/pingcap/tipocket@v1.0.0"
T="$B/tipocket-elle"
rm -rf "$T"; mkdir -p "$T/pkg/elle/core" "$T/pkg/elle/txn" "$T/pkg/elle/list_append"
for f in "$D"/pkg/elle/core/*.go; do case "$f" in *_test.go) ;; *) cp "$f" "$T/pkg/elle/core/";; esac; done
cp "$D/pkg/elle/txn/cycle.go" "$D/pkg/elle/txn/helper_fn.go" "$D/pkg/elle/txn/txn.go" "$T/pkg/elle/txn/"
cp "$D/pkg/elle/list_append/list_append.go" "$D/pkg/elle/list_append/utils.go" "$T/pkg/elle/list_append/"
cp "$D/LICENSE" "$D/pkg/elle/Elle-LICENSE" "$T/"
chmod -R u+w "$T"
cat > "$T/go.mod" <<'MOD'
module github.com/pingcap/tipocket

go 1.13

require (
	github.com/juju/errors v0.0.0-20190930114154-d42613fe1ab9
	github.com/ngaut/log v0.0.0-20180314031856-b8e36e7ba5ac
	go.uber.org/zap v1.14.0
)
MOD
go mod tidy
go build -o e22check .
cmp -s go.sum "$HERE/go/go.sum" || echo "note: go.sum differs from the committed one"
echo "built $B/e22check ($(go version))"
