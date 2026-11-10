#!/bin/sh
# E-44: three nats-server 2.10.22 processes on this box, clustered, JetStream on file storage with an fsync before
# every ack (sync_interval: always), which is the setting that matches fero's `persisted`.
#   cluster.sh up | down | kill <n> | start <n> | leader <stream>
set -u
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
BIN=$SP/dl/nats/nats-server-v2.10.22-linux-amd64/nats-server
W=$SP/e44/c
CP="14431 14432 14433"; RP="16431 16432 16433"
conf() {
  i=$1; cp=$(echo $CP | cut -d' ' -f$i); rp=$(echo $RP | cut -d' ' -f$i)
  routes=$(for r in $RP; do printf 'nats://127.0.0.1:%s,' $r; done | sed 's/,$//')
  mkdir -p "$W/n$i"
  cat > "$W/n$i.conf" <<CONF
server_name: n$i
listen: 127.0.0.1:$cp
cluster { name: e44, listen: 127.0.0.1:$rp, routes: [$routes] }
jetstream { store_dir: "$W/n$i", sync_interval: always, max_file_store: 2G, max_memory_store: 256M }
CONF
}
start() { i=$1; conf $i; "$BIN" -c "$W/n$i.conf" -l "$W/n$i.log" -P "$W/n$i.pid" & }
case $1 in
  up) rm -rf "$W"; mkdir -p "$W"; for i in 1 2 3; do start $i; done
      for t in $(seq 1 100); do grep -q "JetStream cluster new metadata leader" "$W"/n*.log 2>/dev/null && break; sleep 0.1; done
      grep -h "Server is ready\|metadata leader" "$W"/n*.log | tail -4 ;;
  down) for i in 1 2 3; do [ -f "$W/n$i.pid" ] && kill $(cat "$W/n$i.pid") 2>/dev/null; done; sleep 0.5 ;;
  kill) kill -9 $(cat "$W/n$2.pid") ;;
  start) start $2 ;;
esac
