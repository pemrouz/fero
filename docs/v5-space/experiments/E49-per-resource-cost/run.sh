#!/bin/sh
# E-49: how overhead grows per resource in the chosen design (V5-2: a resource is its own cluster).
# Usage: sh run.sh [tree|parts|cluster|disk|boot|gc|settled|dirdrop|genesis|limits|summary|all]
#        ("all" clears results/*.jsonl and reruns everything)
#   tree     the scratch tree with v4's directory, seam and codec, data linked beside them (tree.sh)
#   parts    memory and build time per resource, part by part (parts.ts), one timing hold
#   cluster  three processes of E-26's host with R home groups, R = 1 to 100,000 (cluster.mjs), one hold per run;
#            then one run at 10,000 and 100,000 that samples idle CPU for 90 s with the garbage collector traced
#   disk     files and bytes per resource, two layouts, and the one-box genesis (disk.mjs), one hold
# Added after the skeptic's check (each run of each target holds $SP/bin/timing on its own):
#   boot     cold boots of three processes (boot.mjs, a patched copy of E-26's host): Raft's random timers with
#            E-26's timing (500 ms ticks, a 2-3.5 s timeout) and with DESIGN-V5's (100 ms ticks, 2 s plus 0-500 ms),
#            and E-26's preferred-leader start campaign again, at R = 1,000, 10,000 and 100,000, leaders per process;
#            and memory with groups only at R = 250 and 500 (DEP-13's empty copy). Three runs each
#   gc       the preferred-leader boot with the garbage collector traced, then 4 slices of 10 s (CPU per process,
#            major collections), at R = 1,000, 10,000 and 100,000, three runs
# Added after the re-check:
#   settled  DEP-13's empty copy once V8 has shrunk the heap after the boot: memory with groups only, RSS 11 s after
#            boot and again 40 s after a forced collection, at R = 500, 1,000, 2,000 and 3,000, three runs (the boot
#            target's 20 s reading at 1,000 still held the boot's garbage: V8's own shrink there comes 10-30 s after)
#   dirdrop  v4's directory host: a link death (one server's R entries dropped), as written (R = 1,000 to 10,000)
#            and with the owner map as the index (R = 1,000 to 100,000), three runs (parts.ts drop=1)
#   genesis  the one-box genesis alone, three runs (in "disk" it ran right after removing 300,000 files)
#   limits   this box's open-file limits and kernel object sizes (not timed)
#   summary  results/tables.md (summarize.py)
# Timed parts hold $SP/bin/timing (a lock: no other timed run overlaps). The outside documents are fetched by
# fetch.sh (read for the comparison only; nothing here runs them).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
TREE=$SP/e49/tree
export TREE
RES=$HERE/results
NODE="node --expose-gc --max-old-space-size=8192"
mkdir -p "$RES"

one() {   # one parts process: its load average first, then its JSON line
  printf '{"loadavg":"%s","part":"%s","R":%s,"marker":1}\n' "$(cat /proc/loadavg)" "$1" "$2" >> "$RES/parts.jsonl"
  $NODE "$HERE/parts.ts" part="$1" R="$2" >> "$RES/parts.jsonl"
}

# the dispatch is one brace group ending in exit, so editing this file during a run is safe
{
case "${1:-all}" in
  tree) sh "$HERE/tree.sh" "$TREE"; cp "$TREE/VERSIONS" "$RES/versions.txt"; { uname -r; nproc; free -g | head -2; } >> "$RES/versions.txt" ;;
  parts) "$SP/bin/timing" sh "$HERE/run.sh" _parts ;;
  _parts)
    for R in 1000 10000 100000; do
      for p in base raft-founded raft-member raft-open settings group-record slot-rle perslot-map-1 perslot-map-10 perslot-map-100 \
               perslot-packed-1 perslot-packed-10 perslot-packed-100 fold-empty fold-10 dir-host-indexed dir-names \
               client-source client-source-off timers dormant asm-cheap; do one "$p" "$R"; done
    done
    # dense forms: 100,000 resources would need 3.3 GB (slot table) and 8.2 GB (per-slot state) per member
    for R in 1000 10000; do for p in slot-dense perslot-dense perslot-packed-4096 fold-100 asm-drafted; do one "$p" "$R"; done; done
    one slot-rows 1000
    # one listening socket per resource (v4's form): this box allows 20,000 open files per process, so 1,000 and 10,000
    for R in 1000 10000; do one listen "$R"; done
    # v4's directory host as written: its register copies the registry (quadratic), so it stops at 10,000
    for R in 100 1000 3000 10000; do one dir-host "$R"; done ;;
  cluster) for r in 1 2 3; do "$SP/bin/timing" node "$HERE/cluster.mjs" runs=$r; done
    # idle CPU over 90 s in 10 s slices, with the garbage collector traced (one run at 10,000 and at 100,000)
    "$SP/bin/timing" node "$HERE/cluster.mjs" runs=1 scales=10000,100000 long=9 out=idle-long.jsonl ;;
  disk) "$SP/bin/timing" sh "$HERE/run.sh" _disk ;;
  _disk)
    for run in 1 2 3; do
      # genesis first: the results/disk.jsonl genesis lines were taken last, right after removing 300,000 files
      node "$HERE/disk.mjs" layout=genesis n=200 >> "$RES/disk.jsonl"
      for R in 1 10 100 1000 10000 100000; do
        node "$HERE/disk.mjs" layout=files R=$R >> "$RES/disk.jsonl"
        node "$HERE/disk.mjs" layout=shared R=$R >> "$RES/disk.jsonl"
      done
    done ;;
  boot)
    for r in 1 2 3; do
      "$SP/bin/timing" node "$HERE/boot.mjs" runs=$r scales=1000,10000,100000 start=random tick=500 elect=4 mem=0 tag=random-e26
      "$SP/bin/timing" node "$HERE/boot.mjs" runs=$r scales=1000,10000,100000 start=random tick=100 elect=20 jitter=5 mem=0 tag=random-v5
      "$SP/bin/timing" node "$HERE/boot.mjs" runs=$r scales=1000,10000,100000 start=preferred tick=500 elect=4 mem=0 tag=preferred-e26
      "$SP/bin/timing" node "$HERE/boot.mjs" runs=$r scales=250,500 start=preferred tick=500 elect=4 wait=20 tag=dep13
    done ;;
  gc)
    for r in 1 2 3; do
      "$SP/bin/timing" node "$HERE/boot.mjs" runs=$r scales=1000,10000,100000 start=preferred tick=500 elect=4 trace=1 slices=4 out=gc.jsonl tag=gc
    done ;;
  settled)
    for r in 1 2 3; do
      "$SP/bin/timing" node "$HERE/boot.mjs" runs=$r scales=500,1000,2000,3000 start=preferred tick=500 elect=4 wait=40 tag=dep13w40
    done ;;
  dirdrop)
    for r in 1 2 3; do "$SP/bin/timing" sh "$HERE/run.sh" _dirdrop; done ;;
  _dirdrop)
    for R in 1000 3000 10000; do
      printf '{"loadavg":"%s","part":"dir-host","R":%s,"marker":1}\n' "$(cat /proc/loadavg)" "$R" >> "$RES/dirdrop.jsonl"
      $NODE "$HERE/parts.ts" part=dir-host R=$R drop=1 >> "$RES/dirdrop.jsonl"
    done
    for R in 1000 10000 100000; do
      printf '{"loadavg":"%s","part":"dir-host-indexed","R":%s,"marker":1}\n' "$(cat /proc/loadavg)" "$R" >> "$RES/dirdrop.jsonl"
      $NODE "$HERE/parts.ts" part=dir-host-indexed R=$R drop=1 >> "$RES/dirdrop.jsonl"
    done ;;
  genesis)
    for run in 1 2 3; do "$SP/bin/timing" node "$HERE/disk.mjs" layout=genesis n=200 >> "$RES/genesis.jsonl"; done ;;
  limits)
    { echo "# open files: this process, a node process started from a shell whose soft limit is 1,024, the kernel ceilings"
      grep 'open files' /proc/self/limits
      sh -c 'ulimit -Sn 1024; node -e "process.stdout.write(require(\"fs\").readFileSync(\"/proc/self/limits\",\"utf8\").split(\"\\n\").find((l) => l.includes(\"open files\")) + \" (node, soft limit 1024 before it started)\\n\")"'
      ( ulimit -n 30000 ) 2>&1 | sed 's/^/raise to 30000: /'
      echo "fs.nr_open $(cat /proc/sys/fs/nr_open)"; echo "fs.file-max $(cat /proc/sys/fs/file-max)"
      echo "# kernel objects per cached inode, dentry and open file (name, active, total, object size B)"
      grep -E '^(ext4_inode_cache|dentry|filp) ' /proc/slabinfo | awk '{print $1, $2, $3, $4}'
    } > "$RES/limits.txt"; cat "$RES/limits.txt" ;;
  summary) python3 "$HERE/summarize.py" "$RES" > "$RES/tables.md"; cat "$RES/tables.md" ;;
  all)
    rm -f "$RES/parts.jsonl" "$RES/cluster.jsonl" "$RES/idle-long.jsonl" "$RES/disk.jsonl" "$RES/boot.jsonl" "$RES/gc.jsonl" "$RES/dirdrop.jsonl" "$RES/genesis.jsonl"
    sh "$0" tree; sh "$0" parts; sh "$0" cluster; sh "$0" disk; sh "$0" boot; sh "$0" gc; sh "$0" settled; sh "$0" dirdrop; sh "$0" genesis; sh "$0" limits; sh "$0" summary ;;
  *) echo "usage: sh run.sh [tree|parts|cluster|disk|boot|gc|settled|dirdrop|genesis|limits|summary|all]"; exit 2 ;;
esac
exit 0
}
