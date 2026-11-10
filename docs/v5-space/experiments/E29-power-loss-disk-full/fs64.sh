#!/bin/sh
# E-29(b): small filesystems to fill. Needs root (mount, losetup).
#   fs64.sh up <dir> <name> tmpfs|ext4 [MB=64]   mounts a filesystem of that size at <dir>/<name>
#   fs64.sh down <dir> <name>
set -eu
cmd=$1; D=$2; N=$3
case $cmd in
  up)
    kind=$4; mb=${5:-64}
    mkdir -p "$D/$N"
    mountpoint -q "$D/$N" && { umount "$D/$N"; }
    if [ "$kind" = tmpfs ]; then mount -t tmpfs -o size=${mb}m,mode=755 tmpfs "$D/$N"
    else
      rm -f "$D/$N.img"; truncate -s ${mb}M "$D/$N.img"
      mkfs.ext4 -q -F -m 0 -E lazy_itable_init=0,lazy_journal_init=0 "$D/$N.img"   # -m 0: no blocks held back for root
      mount -o loop,data=ordered "$D/$N.img" "$D/$N"
    fi ;;
  down)
    mountpoint -q "$D/$N" && umount "$D/$N" || true
    rm -f "$D/$N.img" ;;
esac
