#!/bin/sh
# E-09c downloads: Kafka 4.4.0 (the brokers and every perf tool) and, as cited context, OMB's Kafka driver
# configs. Kafka goes to $SP/dl/kafka (shared with E-45 and tools-fetch.sh); the OMB files are small and kept
# in results/cited/. Re-running checks every file against its checksum and skips work already done.
set -e
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
DL=$SP/dl
mkdir -p "$DL/kafka"
# Apache publishes sha512 only: https://downloads.apache.org/kafka/4.4.0/kafka_2.13-4.4.0.tgz.sha512
# (archive.apache.org and dlcdn.apache.org were blocked on the study box; downloads.apache.org worked)
want=f5ceba8a265ab6bb2d68362b1f6859a95e15d60ef92ba83b43fdf065b557dc18e98d6383c15b9977320e25b3a2c8b6f11decb17b0fa6c0f163423793a0eb95cb
if ! { [ -f "$DL/kafka/kafka.tgz" ] && echo "$want  $DL/kafka/kafka.tgz" | sha512sum -c --quiet -; }; then
  curl -sSfL --retry 3 --max-time 900 -o "$DL/kafka/kafka.tgz" https://downloads.apache.org/kafka/4.4.0/kafka_2.13-4.4.0.tgz
  echo "$want  $DL/kafka/kafka.tgz" | sha512sum -c --quiet -
fi
[ -d "$DL/kafka/kafka_2.13-4.4.0" ] || tar -xzf "$DL/kafka/kafka.tgz" -C "$DL/kafka"

# OpenMessaging Benchmark, commit 5b1fa70951a323da26bd587174b58bb2c65b0b5c (master on 2026-11-06):
# the Kafka driver's producer settings (cited; OMB itself is not built here, TOOLS.md says why).
# sha256 values are first-seen (GitHub publishes none for single files).
O=https://raw.githubusercontent.com/openmessaging/benchmark/5b1fa70951a323da26bd587174b58bb2c65b0b5c
mkdir -p "$HERE/results/cited"
get() {
  [ -f "$2" ] && echo "$3  $2" | sha256sum -c --quiet - 2>/dev/null && return 0
  curl -sSfL --retry 3 --max-time 60 -o "$2" "$1"; echo "$3  $2" | sha256sum -c --quiet -
}
get $O/driver-kafka/kafka-throughput.yaml "$HERE/results/cited/omb-kafka-throughput.yaml" 306e7d70520488ca91748dd13efd3884586870dccda22c3ed54d7ea6d5a23e0c
get $O/driver-kafka/kafka-latency.yaml "$HERE/results/cited/omb-kafka-latency.yaml" 5bbbac4272f06dfa8c8050d60e504601ff1273ca5d4fc695ee9cc22e61a074fa
get $O/workloads/1-topic-16-partitions-1kb.yaml "$HERE/results/cited/omb-1-topic-16-partitions-1kb.yaml" db52041ce9e0852579f2de1ed47fdbc6a7226d6c421b88b4f04f04f6445e7dad
echo "fetch ok"
