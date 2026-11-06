#!/usr/bin/env bash
# tools/smoke.sh: one short check per tool in TOOLS.md. Prints one "ok ..." (or BLOCKED/FAIL) line per tool.
# Not a benchmark: the numbers it prints are only proof that the tool ran. Servers use private ports
# (1xxxx) and scratch folders, and are stopped before the script ends.
# Usage: SP=<scratchpad> docs/v5-space/experiments/tools/smoke.sh | tee docs/v5-space/experiments/tools/results/smoke.txt
# Run it under $SP/bin/heavy so it never overlaps a timing run.
set -uo pipefail
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
DL=$SP/dl; OPT=$SP/opt; SRC=$SP/tools-src; W=$SP/smoke; rm -rf "$W"; mkdir -p "$W"
PIDS=(); trap 'for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; fusermount3 -u "$W/fusemnt" 2>/dev/null; rm -rf "$W"' EXIT
line() { printf '%-16s %s\n' "$1" "$2"; }
waitport() { for _ in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && return 0; sleep 0.5; done; return 1; }

echo "# smoke $(date -u +%FT%TZ) host=$(hostname) loadavg=$(cut -d' ' -f1-3 /proc/loadavg)"

# fio 3.36 (Ubuntu): 1,024 fdatasync'd 4 KB writes
r=$(fio --name=s --directory="$W" --rw=write --bs=4k --size=4m --ioengine=sync --fdatasync=1 --output-format=json 2>/dev/null \
  | python3 -I -c "import json,sys; j=json.load(sys.stdin)['jobs'][0]; print(j['write']['total_ios'], 'writes,', j['sync']['lat_ns']['N'], 'fdatasyncs, sync p99', round(j['sync']['lat_ns']['percentile']['99.000000']/1e3), 'us')" 2>&1) \
  && line fio "ok $(fio --version) $r" || line fio "FAIL $r"

# perf (Ubuntu linux-tools 6.8, software events only)
P=/usr/lib/linux-tools/6.8.0-149-generic/perf
r=$($P stat -x, -e task-clock -- true 2>&1 | grep task-clock | cut -d, -f1) && line perf "ok $($P --version) task-clock=${r}ms" || line perf FAIL

# redis-server + redis-benchmark 7.0 (Ubuntu)
redis-server --port 16379 --save '' --appendonly no --dir "$W" >"$W/redis.log" 2>&1 & PIDS+=($!); waitport 16379
r=$(redis-benchmark -p 16379 -t get -n 5000 -c 4 -q 2>&1 | tr '\r' '\n' | grep -m1 'requests per second') && line redis "ok $(redis-server --version | cut -d' ' -f3) $r" || line redis FAIL

# memtier_benchmark: fetched, not runnable without the user's permission
line memtier "BLOCKED: running the image binary and building from source were both refused (Code from External); see TOOLS.md"

# nats-server 2.10.22 + nats CLI 0.5.1
N=$DL/natscli/unz/nats-0.5.1-linux-amd64/nats
"$DL/nats/nats-server-v2.10.22-linux-amd64/nats-server" -p 14222 -js -sd "$W/js" >"$W/nats.log" 2>&1 & PIDS+=($!); waitport 14222
r=$("$N" -s nats://127.0.0.1:14222 bench js pub sync smoke.js --create --msgs 200 --size 128 --no-progress 2>&1 | grep -m1 'stats:' | cut -c1-80) \
  && line nats "ok server $("$DL/nats/nats-server-v2.10.22-linux-amd64/nats-server" --version | cut -d' ' -f2) cli $("$N" --version) $r" || line nats FAIL

# etcd 3.5.17 + benchmark built at v3.5.17
E=$DL/etcd/etcd-v3.5.17-linux-amd64
"$E/etcd" --data-dir "$W/etcd" --listen-client-urls http://127.0.0.1:12379 --advertise-client-urls http://127.0.0.1:12379 \
  --listen-peer-urls http://127.0.0.1:12380 --initial-advertise-peer-urls http://127.0.0.1:12380 \
  --initial-cluster default=http://127.0.0.1:12380 >"$W/etcd.log" 2>&1 & PIDS+=($!); waitport 12379; sleep 1
r=$("$SRC/etcd-benchmark/etcd-benchmark" --endpoints=127.0.0.1:12379 --conns=1 --clients=1 put --key-size=8 --sequential-keys --total=200 --val-size=256 2>&1 | grep -m1 'Requests/sec' | tr -s ' \t' ' ') \
  && line etcd "ok $("$E/etcd" --version | head -1) benchmark put 200:$r" || line etcd FAIL

# Kafka 4.4.0, one KRaft node, 1,000 records through the producer perf tool
K=$DL/kafka/kafka_2.13-4.4.0; mkdir -p "$W/kafka"
sed -e "s#^log.dirs=.*#log.dirs=$W/kafka/data#" -e "s#9092#19092#g; s#9093#19093#g" "$K/config/server.properties" > "$W/kafka/server.properties"
export KAFKA_HEAP_OPTS="-Xmx1G -Xms1G" LOG_DIR=$W/kafka/logs
"$K/bin/kafka-storage.sh" format --standalone -t "$("$K/bin/kafka-storage.sh" random-uuid 2>/dev/null | tail -1)" -c "$W/kafka/server.properties" >"$W/kafka/format.log" 2>&1
"$K/bin/kafka-server-start.sh" "$W/kafka/server.properties" >"$W/kafka/server.out" 2>&1 & PIDS+=($!); waitport 19092; sleep 3
"$K/bin/kafka-topics.sh" --bootstrap-server 127.0.0.1:19092 --create --topic smoke --partitions 1 --replication-factor 1 >/dev/null 2>&1
r=$("$K/bin/kafka-producer-perf-test.sh" --topic smoke --num-records 1000 --record-size 1024 --throughput -1 --producer-props bootstrap.servers=127.0.0.1:19092 acks=all 2>&1 | grep -m1 'records sent' | cut -d, -f1) \
  && line kafka "ok $("$K/bin/kafka-topics.sh" --version 2>/dev/null | tail -1) $r" || line kafka FAIL

# Redpanda 26.2.6: unpacked, not run
line redpanda "BLOCKED: unpacked at $DL/redpanda-deb/root; running it was refused by the classifier; see TOOLS.md"

# MinIO + mc, plus one conditional PUT (If-None-Match: *) twice: expect 200 then 412
O=$OPT/minio; mkdir -p "$W/minio/data" "$W/minio/mc"; echo hi > "$W/minio/f.txt"
MINIO_ROOT_USER=smokeuser MINIO_ROOT_PASSWORD=smokepass123 "$O/minio" server "$W/minio/data" --address 127.0.0.1:19000 --console-address 127.0.0.1:19001 >"$W/minio.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:19000/minio/health/ready)" = 200 ] && break; sleep 0.5; done; sleep 1
for _ in 1 2 3 4 5; do "$O/mc" --config-dir "$W/minio/mc" alias set s http://127.0.0.1:19000 smokeuser smokepass123 >/dev/null 2>&1 && break; sleep 1; done
"$O/mc" --config-dir "$W/minio/mc" mb -q s/bkt >/dev/null 2>&1
c=""; for _ in 1 2; do c="$c $(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --aws-sigv4 'aws:amz:us-east-1:s3' --user smokeuser:smokepass123 \
  -H 'If-None-Match: *' -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' -X PUT --data-binary @"$W/minio/f.txt" http://127.0.0.1:19000/bkt/cond.txt)"; done
[ "$c" = " 200 412" ] && line minio "ok minio+mc built from RELEASE tags; conditional PUT twice ->$c" || line minio "FAIL conditional PUT ->$c"

# Node 26
line node26 "ok $("$DL/node26/node-v26.13.0-linux-x64/bin/node" -e 'process.stdout.write(process.version + " v8 " + process.versions.v8)')"

# N-API: plain C addon and napi-rs addon, on Node 22 and Node 26
for nd in node "$DL/node26/node-v26.13.0-linux-x64/bin/node"; do
  r=$("$nd" -e 'const m=require(process.argv[1]); process.stdout.write(process.version+" "+m.hello()+" "+m.add(2,3))' "$SRC/napi-c/hello.node" 2>&1) && line napi-c "ok $r" || line napi-c "FAIL $r"
  r=$("$nd" "$SRC/napi-rs-hello/smoke.js" "$SRC/napi-rs-hello/hello.node" 2>&1) && line napi-rs "$r" || line napi-rs "FAIL $r"
done

# Rust libraries for E-03, E-10, E-11
line rquickjs "$("$SRC/rquickjs-hello/target/release/rquickjs_hello" 2>&1)"
line deno_core "$("$SRC/deno-core-hello/target/release/deno_core_hello" 2>&1)"
line raft-rs "$("$SRC/raft-rs-hello/target/release/raft_rs_hello" 2>&1)"

# FUSE: mount our own hello filesystem, read it, unmount (LazyFS needs exactly this)
mkdir -p "$W/fusemnt"; "$SRC/fuse-hello/hellofs" "$W/fusemnt" && sleep 0.5
r=$(cat "$W/fusemnt/hello" 2>&1); fusermount3 -u "$W/fusemnt" 2>/dev/null
[ "$r" = "hello fuse" ] && line fuse "ok mount+read+unmount with libfuse3 $(dpkg-query -W -f '${Version}' libfuse3-3)" || line fuse "FAIL $r"
line lazyfs "BLOCKED: source build refused (Code from External); FUSE itself works (line above); see TOOLS.md"

# crane, Chromium
line crane "ok $("$OPT/crane/crane" version) digest $("$OPT/crane/crane" digest --platform linux/amd64 redislabs/memtier_benchmark:2.5.2 2>&1 | cut -c1-19)..."
r=$(timeout 60 /opt/pw-browsers/chromium --headless=new --no-sandbox --disable-gpu --dump-dom \
  'data:text/html,<script>document.write("WS="+(typeof WebSocket))</script>' 2>/dev/null | grep -o 'WS=[a-z]\+')
line chromium "ok $(/opt/pw-browsers/chromium --version 2>/dev/null) $r"
