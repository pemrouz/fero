#!/bin/sh
# E-09a downloads: Redis 7.0.15 from the signed Ubuntu 24.04 archive (apt checks the signature), and two cited
# files from Redis's GitHub repository. respbench uses only Go's standard library (no download).
# memtier_benchmark 2.5.2 is downloaded by ../tools-fetch.sh (steps memtier-layer, memtier-src) but was not run
# here: the session's safety check refused running or building it (see ../TOOLS.md, "Needs permission").
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
apt-get install -y --no-install-recommends redis-server=5:7.0.15-1ubuntu0.24.04.5 redis-tools=5:7.0.15-1ubuntu0.24.04.5
mkdir -p "$SP/dl/e09-cited"
# WAITAOF (wait until the AOF is fsynced locally and on replicas) arrived in Redis 7.2.0, after the 7.0 tested here.
curl -sSfL -o "$SP/dl/e09-cited/waitaof.json" https://raw.githubusercontent.com/redis/redis/7.2.0/src/commands/waitaof.json
echo "ee5826048414a46d85ba3b0545faa99d5f38c284d292840fd468973fea38b85d  $SP/dl/e09-cited/waitaof.json" | sha256sum -c -
# Redis 7.0.15's documented defaults (save points, appendonly no, appendfsync).
curl -sSfL -o "$SP/dl/e09-cited/redis.conf" https://raw.githubusercontent.com/redis/redis/7.0.15/redis.conf
echo "5c15af0dbfbf862f0de2408353d057705a091e0ed298a7c7baf431a8602c8297  $SP/dl/e09-cited/redis.conf" | sha256sum -c -
