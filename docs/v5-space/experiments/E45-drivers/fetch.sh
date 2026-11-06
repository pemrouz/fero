#!/bin/sh
# E-45 downloads. The competitor tools themselves (redis-benchmark, the nats CLI, etcd and its
# benchmark, Kafka 4.4.0) come from ../tools-fetch.sh, with their checksums; run it first.
# This script adds what the gateways need, all under $SP/dl/ (never the repo):
#   1. npm: @grpc/grpc-js 1.14.7, @grpc/proto-loader 0.8.1 (the etcd gRPC front), hdr-histogram-js
#      3.0.1 (the ported lock loop). npm/package-lock.json pins every package by its sha512.
#   2. Kafka's message specs: common/message/*.json from kafka-clients-4.4.0.jar (inside the Kafka
#      tarball that tools-fetch.sh checks by sha512); the jar's sha256 is checked here.
#   3. etcd's protos: go.etcd.io/etcd/api/v3@v3.5.17 from the Go module proxy (checked against the
#      Go checksum database), trimmed by proto/trim.py into proto/etcd-subset.proto (committed).
set -eu
cd "$(dirname "$0")"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
DL="$SP/dl"

# 1. npm, exactly as locked
mkdir -p "$DL/e45-npm"
cp npm/package.json npm/package-lock.json "$DL/e45-npm/"
(cd "$DL/e45-npm" && npm ci --no-audit --no-fund)

# 2. Kafka's message specs
JAR="$DL/kafka/kafka_2.13-4.4.0/libs/kafka-clients-4.4.0.jar"
echo "9e4514622675f9b24c83373d0d5b35dd7a4dba34bad69762fe90a9e54cfb71de  $JAR" | sha256sum -c --quiet -
mkdir -p "$DL/e45-kafka-specs"
(cd "$DL/e45-kafka-specs" && unzip -o -q "$JAR" 'common/message/*.json')

# 3. etcd's protos (only to re-derive proto/etcd-subset.proto; the derived file is committed)
GOFLAGS=-mod=mod GOTOOLCHAIN=local go mod download -json go.etcd.io/etcd/api/v3@v3.5.17 > /dev/null 2>&1 || true
P="$(go env GOMODCACHE)/go.etcd.io/etcd/api/v3@v3.5.17"
if [ -d "$P" ]; then python3 -I proto/trim.py "$P/etcdserverpb/rpc.proto" "$P/mvccpb/kv.proto" > "$DL/e45-etcd-subset.proto" && cmp "$DL/e45-etcd-subset.proto" proto/etcd-subset.proto && echo "proto/etcd-subset.proto re-derived: identical"; fi
echo "E-45 fetch done"
