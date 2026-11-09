#!/bin/sh
# E-12 variant: other filesystems on the same virtual disk, through loop devices with direct I/O
# (so the loop file's page cache is not a second cache). Makes:
#   $SP/e12/mnt/ext4j : ext4 with its jbd2 journal (data=ordered, the default), 4 GiB
#   $SP/e12/mnt/xfs   : XFS, 4 GiB (only if mkfs.xfs exists: apt-get install xfsprogs)
# Usage: sh mkfs.sh up | down. Run under $SP/bin/heavy (mkfs writes the inode tables up front).
set -eu
SP=${SP:-/tmp/fero-sp}
IMG=$SP/e12/fsimg; MNT=$SP/e12/mnt
case "${1:-up}" in
  up)
    mkdir -p "$IMG" "$MNT/ext4j" "$MNT/xfs"
    if ! mountpoint -q "$MNT/ext4j"; then
      rm -f "$IMG/ext4j.img"; fallocate -l 4G "$IMG/ext4j.img"
      mkfs.ext4 -q -F -E lazy_itable_init=0,lazy_journal_init=0 "$IMG/ext4j.img"
      dev=$(losetup --direct-io=on -f --show "$IMG/ext4j.img")
      mount -o data=ordered "$dev" "$MNT/ext4j"
    fi
    if command -v mkfs.xfs >/dev/null && ! mountpoint -q "$MNT/xfs"; then
      rm -f "$IMG/xfs.img"; fallocate -l 4G "$IMG/xfs.img"
      mkfs.xfs -q -f "$IMG/xfs.img"
      dev=$(losetup --direct-io=on -f --show "$IMG/xfs.img")
      mount "$dev" "$MNT/xfs"
    fi
    mount | grep "$MNT" ; losetup -l | grep "$IMG" || true ;;
  down)
    for m in ext4j xfs; do mountpoint -q "$MNT/$m" && umount "$MNT/$m" || true; done
    for d in $(losetup -l -n -O NAME,BACK-FILE | awk -v p="$IMG" 'index($2,p)==1{print $1}'); do losetup -d "$d"; done
    rm -rf "$IMG" ;;
esac
