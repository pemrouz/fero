#!/bin/sh
# E-49: the outside documents the comparison quotes (read only; nothing is run). Into their own new folder,
# $SP/dl/e49-cited, with a sha256 of each. Fetched 2026-11-12 from the projects' own documentation repositories
# (docs.nats.io, docs.pingcap.com and cockroachlabs.com were not reachable from this box; their sources are).
# Kafka's operations page is quoted from Kafka 4.4.0's site-docs already fetched for E-09c ($SP/dl/kafka-sitedocs),
# and NATS's max_ha_assets row from the configuration page E-09b fetched ($SP/dl/e09-cited/nats-config.md).
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
D=$SP/dl/e49-cited
mkdir -p "$D"
for u in \
  pingcap/docs/master/best-practices/massive-regions-best-practices.md \
  pingcap/docs/master/tikv-configuration-file.md \
  nats-io/nats.docs/master/running-a-nats-service/nats_admin/jetstream_admin/replication.md \
  nats-io/nats.docs/master/running-a-nats-service/configuration/clustering/jetstream_clustering/README.md \
  cockroachdb/docs/main/src/current/v25.4/architecture/replication-layer.md \
  cockroachdb/docs/main/src/current/v25.4/architecture/distribution-layer.md \
  cockroachdb/docs/main/src/current/v25.4/recommended-production-settings.md \
  cockroachdb/docs/main/src/current/v25.4/configure-replication-zones.md \
  cockroachdb/cockroach/master/pkg/kv/kvserver/replica_raft_quiesce.go
do
  f=$(echo "$u" | tr '/' '_')
  curl -sSfL -o "$D/$f" "https://raw.githubusercontent.com/$u"
done
sha256sum "$D"/* > "$D/SHA256SUMS"
cat "$D/SHA256SUMS"
