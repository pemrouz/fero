#!/bin/sh
# E-09d downloads: Redpanda 26.2.6 and rpk, as official .debs from Redpanda's public release bucket
# (dl.redpanda.com's apt route needs an active token: TOKEN_NOT_ACTIVE). Unpacked with dpkg -x, not installed.
# The broker's ELF interpreter is fixed at /opt/redpanda/lib/ld.so, so /opt/redpanda is linked to the unpacked
# tree. The Kafka tools that drive it come from E-09c's fetch.sh.
set -e
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
d=$SP/dl/redpanda-deb
B=https://vectorized-public.s3.us-west-2.amazonaws.com/releases/redpanda/26.2.6
mkdir -p "$d"
# The bucket publishes no checksum file; these sha256 are first-seen values recorded on 2026-11-06
# (tools-fetch.sh; build-meta.json says commit 06e1aca30b726c8de9dc9db5c2b83b4da8edf6d0).
get() {
  [ -f "$2" ] && echo "$3  $2" | sha256sum -c --quiet - 2>/dev/null && return 0
  curl -sSfL --retry 3 --max-time 900 -o "$2.part" "$1"; echo "$3  $2.part" | sha256sum -c --quiet -; mv "$2.part" "$2"
}
get $B/redpanda_26.2.6-1_amd64.deb     "$d/redpanda_26.2.6-1_amd64.deb"     49c5f1da7a0bebed468b6af3f85596f2f2f857faa037bd8179c27cd01b0ae3b7
get $B/redpanda-rpk_26.2.6-1_amd64.deb "$d/redpanda-rpk_26.2.6-1_amd64.deb" 31f48681be8e104cf12fb416c9ac0680ea71e591b2fc1eb5c6ac59a81f3f2a7d
if [ ! -x "$d/root/opt/redpanda/libexec/redpanda" ]; then
  mkdir -p "$d/root"; dpkg -x "$d/redpanda_26.2.6-1_amd64.deb" "$d/root"; dpkg -x "$d/redpanda-rpk_26.2.6-1_amd64.deb" "$d/root"
fi
[ -e /opt/redpanda ] || ln -s "$d/root/opt/redpanda" /opt/redpanda
sh "$HERE/../E09c-kafka/fetch.sh"
/opt/redpanda/bin/rpk version | head -1
