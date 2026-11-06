#!/bin/sh
# E-09b downloads: nats-server 2.10.22 and the nats CLI 0.5.1 (release archives, sha256 from each release's
# SHA256SUMS), through the shared tools script, and NATS's configuration page (cited for sync_interval).
#   https://github.com/nats-io/nats-server/releases/download/v2.10.22/nats-server-v2.10.22-linux-amd64.tar.gz
#     sha256 db0b3ccbe4cbdd3872ae7486ec4f6b0f85824632a0789f4da2e0a8518390483e
#   https://github.com/nats-io/natscli/releases/download/v0.5.1/nats-0.5.1-linux-amd64.zip
#     sha256 f8a3e106deebed7afe736b7090359bda3aa62a04b310440bedc1d11a93c0ab4f
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
bash "$HERE/../tools-fetch.sh" nats natscli
mkdir -p "$SP/dl/e09-cited"
curl -sSfL -o "$SP/dl/e09-cited/nats-config.md" \
  https://raw.githubusercontent.com/nats-io/nats.docs/master/running-a-nats-service/configuration/README.md
# first seen 2026-11-06 with sha256 af75b36bea0d7d5dce4416b4d39ae67e3b51e5db4ff0bbc5f6ef63a773cecf62 (a living page: may change)
sha256sum "$SP/dl/e09-cited/nats-config.md"
