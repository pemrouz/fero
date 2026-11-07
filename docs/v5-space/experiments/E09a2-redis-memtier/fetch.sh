#!/bin/sh
# E-09a2 downloads.
# 1. memtier_benchmark 2.5.2: the binary layer of Redis's official image redislabs/memtier_benchmark:2.5.2
#    (linux/amd64 manifest sha256:ebdbcc1b2db83fbdede5810b358f620bb59a01b090a88feea2815e0a1fab1243), fetched
#    with crane (no Docker daemon) and checked by the layer digest. This is ../tools-fetch.sh's
#    `memtier-layer` step; the user allowed running it on 2026-11-06 ("allow Redpanda, memtier_benchmark
#    and LazyFS and anything else you need"). The binary is installed at $SP/opt/memtier/bin/.
#    Its source (tag 2.5.2 = f3ff1793d39bf19077957e986f966206eb349de7) is ../tools-fetch.sh's `memtier-src`
#    step; it was read here (shard_connection.cpp, client.cpp) to cite how memtier pipelines and times.
# 2. Redis 7.0.15 and redis-benchmark: the Ubuntu package, as ../E09a-redis/fetch.sh installs it.
# 3. redis-benchmark.c of Redis 7.0.15, read to cite how redis-benchmark times a pipeline (cited, not run).
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
# 1
sh "$HERE/../tools-fetch.sh" memtier-layer
mkdir -p "$SP/opt/memtier/bin"
cp "$SP/dl/memtier-image/root/usr/local/bin/memtier_benchmark" "$SP/opt/memtier/bin/memtier_benchmark"
echo "d8d87a6d0d7ba70b81aa2adc549d2af63f315be46ac71853dcb72818c7e94262  $SP/opt/memtier/bin/memtier_benchmark" | sha256sum -c -
# 2
apt-get install -y --no-install-recommends redis-server=5:7.0.15-1ubuntu0.24.04.5 redis-tools=5:7.0.15-1ubuntu0.24.04.5
# 3
mkdir -p "$SP/dl/e09a2-cited"
curl -sSfL -o "$SP/dl/e09a2-cited/redis-benchmark.c" https://raw.githubusercontent.com/redis/redis/7.0.15/src/redis-benchmark.c
echo "6e0172a2b4f0da7c1719d6db1dc0c54727015923b7df009cce7b7acb0a3f1d80  $SP/dl/e09a2-cited/redis-benchmark.c" | sha256sum -c -
