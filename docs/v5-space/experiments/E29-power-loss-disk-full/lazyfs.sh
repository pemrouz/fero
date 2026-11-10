#!/bin/sh
# E-29: start and stop LazyFS (a FUSE filesystem that holds unsynced writes in memory and can drop them).
#   lazyfs.sh up <work dir> [file]   mounts <work>/mnt over <work>/root; faults go to <work>/faults.fifo;
#                                [file] holds [[injection]] blocks (torn writes) to add to the config
#   lazyfs.sh down <work dir>    unmounts and waits for the process
#   lazyfs.sh clear <work dir>   a power loss: drop every unsynced byte, wait until LazyFS says it is done
# LazyFS 0.3.1 was built by ../tools-fetch.sh (TOOLS.md has the build note).
set -u
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
BIN=${LAZYFS:-$SP/dl/lazyfs/src/lazyfs/build/lazyfs}
cmd=$1; L=$2
case $cmd in
  up)
    mkdir -p "$L/mnt" "$L/root"
    mountpoint -q "$L/mnt" && { echo "already mounted"; exit 0; }
    rm -f "$L/faults.fifo" "$L/done.fifo"
    cat > "$L/cfg.toml" <<TOML
[faults]
fifo_path="$L/faults.fifo"
fifo_path_completed="$L/done.fifo"
[cache]
apply_eviction=false
[cache.simple]
custom_size="64mb"
blocks_per_page=1
[filesystem]
log_all_operations=false
logfile=""
TOML
    [ -n "${3:-}" ] && cat "$3" >> "$L/cfg.toml"
    "$BIN" "$L/mnt" --config-path "$L/cfg.toml" -o allow_other -o modules=subdir -o subdir="$L/root" -f >> "$L/lazyfs.log" 2>&1 &
    echo $! > "$L/lazyfs.pid"
    for i in $(seq 1 100); do mountpoint -q "$L/mnt" && [ -p "$L/faults.fifo" ] && [ -p "$L/done.fifo" ] && break; sleep 0.05; done
    mountpoint -q "$L/mnt" || { echo "lazyfs did not mount"; tail -5 "$L/lazyfs.log"; exit 1; }
    # one reader for the whole session: LazyFS answers "finished::clear-cache" there after each clear
    : > "$L/done.txt"; ( cat "$L/done.fifo" >> "$L/done.txt" 2>/dev/null & echo $! > "$L/reader.pid" ) ;;
  down)
    p=$(cat "$L/lazyfs.pid" 2>/dev/null || echo)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then fusermount3 -u "$L/mnt" 2>/dev/null || fusermount3 -uz "$L/mnt" 2>/dev/null; kill -9 "$p" 2>/dev/null
    else fusermount3 -uz "$L/mnt" 2>/dev/null; fi      # LazyFS already died (a torn-write fault kills it): drop the dead mount
    for i in $(seq 1 100); do mountpoint -q "$L/mnt" 2>/dev/null || break; sleep 0.02; done
    [ -f "$L/reader.pid" ] && { kill $(cat "$L/reader.pid") 2>/dev/null; rm -f "$L/reader.pid"; }
    rm -f "$L/lazyfs.pid" ;;
  clear)
    n=$(wc -l < "$L/done.txt")
    echo "lazyfs::clear-cache" > "$L/faults.fifo"
    for i in $(seq 1 2000); do [ "$(wc -l < "$L/done.txt")" -gt "$n" ] && exit 0; sleep 0.005; done
    echo "lazyfs did not confirm the clear"; exit 1 ;;
  fault)
    echo "$3" > "$L/faults.fifo" ;;
esac
