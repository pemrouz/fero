#!/bin/sh
# Fetches what E-10 used. Everything lands under $SP/dl/, never in the repo.
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}

# 1. etcd raft at c51f010 (the port's source and its datadriven files). Shared with other
#    experiments as $SP/dl/raftsrc/raft; the commit id is the checksum.
if [ ! -d "$SP/dl/raftsrc/raft" ]; then
  mkdir -p "$SP/dl/raftsrc" && git clone -q https://github.com/etcd-io/raft "$SP/dl/raftsrc/raft"
  git -C "$SP/dl/raftsrc/raft" checkout -q c51f010c851edd0dada5af41bafbf68e54617767
fi
test "$(git -C "$SP/dl/raftsrc/raft" rev-parse HEAD)" = c51f010c851edd0dada5af41bafbf68e54617767

# 2. Go 1.26.10 (etcd raft's go.mod asks for it) and the module's test dependencies.
#    GOTOOLCHAIN fetches the toolchain from proxy.golang.org; go.sum and the Go checksum
#    database verify every module (cockroachdb/datadriven v1.0.3, testify, protobuf).
mkdir -p "$SP/dl/e10-go"
[ -d "$SP/dl/e10-go/raft-c51f010" ] || cp -r "$SP/dl/raftsrc/raft" "$SP/dl/e10-go/raft-c51f010"
export GOPATH=$SP/dl/e10-go/gopath GOMODCACHE=$SP/dl/e10-go/gopath/pkg/mod GOTOOLCHAIN=go1.26.10 GOFLAGS=-modcacherw GOCACHE=$SP/dl/e10-go/gocache
(cd "$SP/dl/e10-go/raft-c51f010" && go mod download && go version)

# 3. raft-rs 0.7.0 from crates.io (latest release). Cargo checks the crate's sha256:
#    f12688b23a649902762d4c11d854d73c49c9b93138f2de16403ef9f571ad5bae (raft-0.7.0.crate).
if [ ! -d "$SP/dl/raft-rs/raft-0.7.0" ]; then
  (cd /tmp && cargo info raft@0.7.0 >/dev/null)
  mkdir -p "$SP/dl/raft-rs"
  cp -r "$(ls -d ~/.cargo/registry/src/*/raft-0.7.0)" "$SP/dl/raft-rs/"
fi
sha256sum ~/.cargo/registry/cache/*/raft-0.7.0.crate

# 4. Histories, read only (git log), for upstream churn and raft-rs activity.
[ -d "$SP/dl/e10-raft-history/raft.git" ] || git clone -q --bare https://github.com/etcd-io/raft "$SP/dl/e10-raft-history/raft.git"
[ -d "$SP/dl/e10-raftrs-history/raft-rs.git" ] || git clone -q --bare https://github.com/tikv/raft-rs "$SP/dl/e10-raftrs-history/raft-rs.git"

# 5. npm registry metadata only (search results and packuments; no tarball is fetched).
#    Live data, so no checksum: the copies used are in results/npm-survey.json.
N=$SP/dl/e10-npm; mkdir -p "$N/pack"
for q in raft raft%20consensus keywords:raft keywords:consensus; do
  curl -sS --max-time 60 "https://registry.npmjs.org/-/v1/search?text=$q&size=250" -o "$N/search_$(echo $q | tr -c 'a-z0-9' '_').json"
done
for n in zmq-raft @markwylde/liferaft liferaft tinyraft hamok mokka skiff gaggle scull webraft node-raft-redis node-raft raptiye raft-logic @distributed-cordis/raft-logic @unrdf/consensus @ruvector/raft @maboke123/raft-core @botiroff/bulwark moirae-protocols logboat raftq @coaty/consensus.raft node-raft-over-mqtt buoyant raftjs cruise skiff-algorithm nodeway-raft @yipsec/brig antietcd raftctl; do
  curl -sS --max-time 30 "https://registry.npmjs.org/$(echo $n | sed 's#/#%2F#')" -o "$N/pack/$(echo $n | tr '/@' '__').json"
done
echo fetched
