#!/bin/sh
# E-45: drive fero (the E-22 prototype) with each competitor's own tool, once each, to show the
# driver works end to end. NOT a timing experiment: every number the tools print measures the E-22
# simulator behind a gateway (one Node process, virtual time inside), never a fero kernel.
#
#   ./run.sh                 every block below, inside ONE hold of the study's heavy lock
#   ./run.sh resp|nats|js|etcd|kafka|lock|order|types     one block
#
# Needs fetch.sh first (npm packages, Kafka's message specs). Tools: redis-benchmark 7.0.15
# (Ubuntu), the nats CLI 0.5.1, etcd's benchmark v3.5.17 and etcdctl, Kafka 4.4.0's perf tools
# (all listed in ../TOOLS.md). Results land in results/<name>.txt.
set -eu
cd "$(dirname "$0")"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
NATS="$SP/dl/natscli/unz/nats-0.5.1-linux-amd64/nats"
EB="$SP/tools-src/etcd-benchmark/etcd-benchmark"
ECTL="$SP/dl/etcd/etcd-v3.5.17-linux-amd64/etcdctl"
K="$SP/dl/kafka/kafka_2.13-4.4.0/bin"
N="node --experimental-strip-types --no-warnings"
export E45_NPM="$SP/dl/e45-npm/" E45_KAFKA_SPECS="$SP/dl/e45-kafka-specs/common/message" KAFKA_HEAP_OPTS="-Xmx512M" ETCDCTL_API=3
D="sh ./drive.sh"
block="${1:-all}"
# `all` takes the study's heavy lock ONCE and runs every block inside it (about 15 minutes on a
# quiet box; the lock is held well under 30 minutes). `chain` is that inside part.
if [ "$block" = all ]; then exec "$SP/bin/heavy" sh "$0" chain; fi
if [ "$block" = chain ]; then for b in types resp nats js etcd kafka lock order; do sh "$0" $b; done; exit 0; fi

case "$block" in
types)   # strict type check of the gateways, the host and the ports (TypeScript 6.0.2, as E-22)
  { echo "# tsc $(tsc -v), $(date -u +%FT%TZ)"; tsc -p tsconfig.json && echo "ok: tsc --strict, exit 0"; } > results/typecheck.txt 2>&1 || true
  cat results/typecheck.txt ;;
resp)    # PERF-02's shape: 4 threads x 50 clients, 100 B, pipeline 1 and 16; GET, SET, INCR
  R="redis-benchmark -p 16390 -c 200 --threads 4 -r 100000 -d 100 --precision 3"
  $D resp-p1 resp "--listen 127.0.0.1:16390" $R -n 10000 -P 1 -t set,get,incr
  $D resp-p16 resp "--listen 127.0.0.1:16390" $R -n 20000 -P 16 -t set,get,incr
  $D resp-p1-fresh resp "--listen 127.0.0.1:16390 --get fresh" $R -n 5000 -P 1 -t get ;;
nats)    # PERF-03: 1 -> 1 and 1 -> 16 subscribers, 16 B and 1 KB, the `none` rung; persisted beside; latency; request-reply
  S="-s nats://127.0.0.1:14290"
  $D nats-1to1-16B nats "--listen 127.0.0.1:14290" sh -c "$NATS $S bench sub e45.core --clients 1 --msgs 10000 --size 16B --no-progress & sleep 1; $NATS $S bench pub e45.core --clients 1 --msgs 10000 --size 16B --no-progress; wait"
  $D nats-1to16-1KB nats "--listen 127.0.0.1:14290" sh -c "$NATS $S bench sub e45.core --clients 16 --msgs 2000 --size 1KB --no-progress & sleep 1; $NATS $S bench pub e45.core --clients 1 --msgs 2000 --size 1KB --no-progress; wait"
  $D nats-1to1-16B-persisted nats "--listen 127.0.0.1:14290 --durability persisted" sh -c "$NATS $S bench sub e45.core --clients 1 --msgs 3000 --size 16B --no-progress & sleep 1; $NATS $S bench pub e45.core --clients 1 --msgs 3000 --size 16B --no-progress; wait"
  $D nats-latency-16B nats "--listen 127.0.0.1:14290" $NATS $S latency --server-b nats://127.0.0.1:14290 --size 16 --rate 1000 --duration 5s
  $D nats-service nats "--listen 127.0.0.1:14290" sh -c "$NATS $S bench service serve e45.svc --clients 2 --msgs 1000 --no-progress & sleep 1; $NATS $S bench service request e45.svc --clients 1 --msgs 1000 --size 16B --no-progress; kill %1 2>/dev/null; wait" ;;
js)      # PERF-04: JetStream, file storage, 3 replicas; publish with acks; a pull consumer; work-queue retention
  S="-s nats://127.0.0.1:14290"; JS="$NATS $S bench js"; C="--create --replicas 3 --storage file --maxbytes 1GB"
  $D js nats "--listen 127.0.0.1:14290" sh -c "
    $JS --stream s1 --clients 1 --msgs 1000 --size 100B --no-progress pub sync e45.s1 $C &&
    $JS --stream s16 --clients 16 --msgs 2000 --size 100B --no-progress pub sync e45.s16 $C &&
    $JS --stream sa --clients 1 --msgs 5000 --size 100B --no-progress pub async e45.sa --batch 500 $C &&
    $JS --stream sa --clients 1 --msgs 5000 --no-progress fetch --batch 500 &&
    $NATS $S stream add wq --subjects e45.wq --retention work --storage file --replicas 3 --max-bytes 1GB --defaults > /dev/null &&
    $JS --stream wq --clients 1 --msgs 2000 --size 100B --no-progress pub async e45.wq --batch 500 &&
    $JS --stream wq --clients 4 --msgs 2000 --no-progress fetch --batch 500 &&
    $NATS $S stream info wq | grep -E 'Messages|Subjects'" ;;
etcd)    # PERF-07: etcd's benchmark, E-09e's commands, smaller totals
  EP="--endpoints 127.0.0.1:12390 --precise"; PUT="--key-size=8 --sequential-keys --key-space-size=100000 --val-size=256"
  L1="--conns=1 --clients=1 --target-leader"; L1000="--conns=100 --clients=1000 --target-leader"; A1000="--conns=100 --clients=1000"
  $D etcd etcd "--listen 127.0.0.1:12390" sh -c "
    $ECTL --endpoints 127.0.0.1:12390 put foo \$(printf '%0256d' 0 | tr 0 x) &&
    echo '## put-1c' && $EB $EP $L1 put $PUT --total=1000 &&
    echo '## put-1000c' && $EB $EP $L1000 put $PUT --total=5000 &&
    echo '## range-l-1c' && $EB $EP $L1 range foo --consistency=l --total=1000 &&
    echo '## range-l-1000c' && $EB $EP $A1000 range foo --consistency=l --total=5000 &&
    echo '## range-s-1c' && $EB $EP $L1 range foo --consistency=s --total=1000 &&
    echo '## range-s-1000c' && $EB $EP $A1000 range foo --consistency=s --total=5000 &&
    echo '## txn-put-1c' && $EB $EP $L1 txn-put --txn-ops=1 --key-size=8 --key-space-size=100000 --val-size=256 --total=1000 &&
    echo '## txn-put-1000c' && $EB $EP $L1000 txn-put --txn-ops=1 --key-size=8 --key-space-size=100000 --val-size=256 --total=5000 &&
    echo '## lease-keepalive-1000c' && $EB $EP $L1000 lease-keepalive --total=5000 &&
    echo '## stm-1c' && $EB $EP $L1 stm --keys=100000 --keys-per-txn=1 --txn-wr-percent=100 --val-size=256 --total=1000 &&
    echo '## stm-1000c' && $EB $EP $L1000 stm --keys=100000 --keys-per-txn=1 --txn-wr-percent=100 --val-size=256 --total=2000" ;;
kafka)   # PERF-05 (and PERF-06's fero side): 1 KB records, 16 partitions, replication 3, acks=all
  B="--bootstrap-server 127.0.0.1:19290"
  $D kafka kafka "--listen 127.0.0.1:19290" sh -c "
    $K/kafka-topics.sh $B --create --topic e45 --partitions 16 --replication-factor 3 &&
    $K/kafka-topics.sh $B --describe --topic e45 | head -3 &&
    echo '## producer' && $K/kafka-producer-perf-test.sh $B --topic e45 --num-records 10000 --record-size 1024 --throughput -1 --command-property acks=all &&
    echo '## consumer' && $K/kafka-consumer-perf-test.sh $B --topic e45 --num-records 10000 --timeout 60000 &&
    $K/kafka-topics.sh $B --create --topic e45e2e --partitions 1 --replication-factor 3 &&
    echo '## e2e latency' && $K/kafka-e2e-latency.sh --bootstrap-server 127.0.0.1:19290 --topic e45e2e --num-records 1000 --producer-acks all --record-size 1024 2>&1 | grep -v '^[0-9]*	'" 2>&1 ;;
lock)    # PERF-07's lock row: E-09e's lockbench, ported to fero's lock() (virtual time)
  { echo "# E-45 lock: $(date -u +%FT%TZ), node $(node --version), loadavg $(cat /proc/loadavg)"
    for c in 1 100; do echo "## lockloop --clients $c"; $N ports/lockloop.ts --clients $c --duration 5s --warmup 1s; done; } > results/lock.txt 2>&1
  cat results/lock.txt ;;
order)   # F4's evidence: pipelined writes to one partition across a leader change
  { echo "# E-45 order: $(date -u +%FT%TZ), node $(node --version), loadavg $(cat /proc/loadavg)"
    $N checks/order.check.ts --seeds 100; } > results/order.txt 2>&1
  cat results/order.txt ;;
*) echo "unknown block $block"; exit 2 ;;
esac
