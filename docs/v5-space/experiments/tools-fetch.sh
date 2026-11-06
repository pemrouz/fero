#!/usr/bin/env bash
# tools-fetch.sh: re-creates every benchmark tool listed in TOOLS.md, with URLs and checksums.
#
# Usage:   docs/v5-space/experiments/tools-fetch.sh [step ...]      (no step = every default step)
# Steps:   apt etcd nats kafka natscli node26 etcdbench crane minio redpanda memtier-layer
#          napi-c napi-rs rquickjs deno-core raft-rs fuse-hello
# Gated:   memtier-src lazyfs fio-src   (run only with ALLOW_GATED=1; see TOOLS.md, "Needs permission")
#
# Every step is idempotent: it skips work whose output is already there and checks out.
# Downloads go to $SP/dl/<name>/ (each in its own folder), builds to $SP/opt/<name>/ or $SP/tools-src/<name>/.
# Compiles run under $SP/bin/heavy when that helper exists (the study's shared-lock rule).
# Written 2026-11-06 on the study box: Ubuntu 24.04, kernel 6.18.44-fc, 4 vCPU, Go 1.24.7, Rust 1.97.0, Node 22.22.0.
set -euo pipefail

SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
DL=$SP/dl; OPT=$SP/opt; SRC=$SP/tools-src
HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=$HERE/tools/src
HEAVY=""; [ -x "$SP/bin/heavy" ] && HEAVY="$SP/bin/heavy"
mkdir -p "$DL" "$OPT" "$SRC"

say() { printf '== %s\n' "$*"; }
# fetch URL FILE SHA256: download unless FILE exists with the right sha256; fail on mismatch.
fetch() {
  local url=$1 out=$2 sum=$3
  if [ -f "$out" ] && echo "$sum  $out" | sha256sum -c --quiet - 2>/dev/null; then return 0; fi
  curl -sSfL --retry 3 --max-time 900 -o "$out.part" "$url"
  echo "$sum  $out.part" | sha256sum -c --quiet - || { echo "CHECKSUM MISMATCH: $url" >&2; rm -f "$out.part"; exit 1; }
  mv "$out.part" "$out"
}

# --- system packages from the signed Ubuntu 24.04 (noble) archive; apt checks the signatures ---
step_apt() {
  say "apt: fio, build deps, perf"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fio=3.36-1ubuntu0.1 libevent-dev libfuse3-dev fuse3 libaio-dev liburing-dev \
    linux-tools-6.8.0-149-generic linux-tools-common
  # fio .deb: pool/universe/f/fio/fio_3.36-1ubuntu0.1_amd64.deb sha256 f76f54cfff9b6160668cadc05e964195fe672eaa33177371401d345b83cac9f1
  # perf binary: /usr/lib/linux-tools/6.8.0-149-generic/perf (software events only: this VM exposes no hardware PMU)
}

# --- vendor release binaries, checked against the vendor's own checksum files ---
step_etcd() {
  say "etcd 3.5.17"; mkdir -p "$DL/etcd"
  # sha256 from https://github.com/etcd-io/etcd/releases/download/v3.5.17/SHA256SUMS
  fetch https://github.com/etcd-io/etcd/releases/download/v3.5.17/etcd-v3.5.17-linux-amd64.tar.gz \
    "$DL/etcd/etcd.tgz" eff6ac621d41711085d0f38fab17d8fa3705f6326c3ff11301a1f5a71fc94edd
  [ -x "$DL/etcd/etcd-v3.5.17-linux-amd64/etcd" ] || tar -xzf "$DL/etcd/etcd.tgz" -C "$DL/etcd"
}
step_nats() {
  say "nats-server 2.10.22"; mkdir -p "$DL/nats"
  # sha256 from https://github.com/nats-io/nats-server/releases/download/v2.10.22/SHA256SUMS
  fetch https://github.com/nats-io/nats-server/releases/download/v2.10.22/nats-server-v2.10.22-linux-amd64.tar.gz \
    "$DL/nats/nats.tgz" db0b3ccbe4cbdd3872ae7486ec4f6b0f85824632a0789f4da2e0a8518390483e
  [ -x "$DL/nats/nats-server-v2.10.22-linux-amd64/nats-server" ] || tar -xzf "$DL/nats/nats.tgz" -C "$DL/nats"
}
step_kafka() {
  say "Kafka 4.4.0 (Scala 2.13)"; mkdir -p "$DL/kafka"
  # archive.apache.org and dlcdn.apache.org are blocked on the study box; downloads.apache.org works.
  # sha512 from https://downloads.apache.org/kafka/4.4.0/kafka_2.13-4.4.0.tgz.sha512 (Apache publishes sha512 only).
  local want=f5ceba8a265ab6bb2d68362b1f6859a95e15d60ef92ba83b43fdf065b557dc18e98d6383c15b9977320e25b3a2c8b6f11decb17b0fa6c0f163423793a0eb95cb
  if ! { [ -f "$DL/kafka/kafka.tgz" ] && echo "$want  $DL/kafka/kafka.tgz" | sha512sum -c --quiet -; }; then
    curl -sSfL --retry 3 --max-time 900 -o "$DL/kafka/kafka.tgz" https://downloads.apache.org/kafka/4.4.0/kafka_2.13-4.4.0.tgz
    echo "$want  $DL/kafka/kafka.tgz" | sha512sum -c --quiet - || { echo "Kafka sha512 mismatch" >&2; exit 1; }
  fi
  [ -d "$DL/kafka/kafka_2.13-4.4.0" ] || tar -xzf "$DL/kafka/kafka.tgz" -C "$DL/kafka"
}
step_natscli() {
  say "nats CLI 0.5.1"; mkdir -p "$DL/natscli"
  # sha256 from https://github.com/nats-io/natscli/releases/download/v0.5.1/SHA256SUMS
  fetch https://github.com/nats-io/natscli/releases/download/v0.5.1/nats-0.5.1-linux-amd64.zip \
    "$DL/natscli/nats-0.5.1-linux-amd64.zip" f8a3e106deebed7afe736b7090359bda3aa62a04b310440bedc1d11a93c0ab4f
  if [ ! -x "$DL/natscli/unz/nats-0.5.1-linux-amd64/nats" ]; then
    mkdir -p "$DL/natscli/unz"; python3 -I -m zipfile -e "$DL/natscli/nats-0.5.1-linux-amd64.zip" "$DL/natscli/unz"
    chmod +x "$DL/natscli/unz/nats-0.5.1-linux-amd64/nats"
  fi
}
step_node26() {
  say "Node 26.13.0 (LTS 'Lithium')"; mkdir -p "$DL/node26"
  # sha256 from https://nodejs.org/dist/v26.13.0/SHASUMS256.txt
  fetch https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz \
    "$DL/node26/node-v26.13.0-linux-x64.tar.xz" d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
  [ -x "$DL/node26/node-v26.13.0-linux-x64/bin/node" ] || tar -xJf "$DL/node26/node-v26.13.0-linux-x64.tar.xz" -C "$DL/node26"
}

# --- Go tools built from the Go module proxy; go.sum / sum.golang.org check every module ---
step_etcdbench() {
  say "etcd benchmark (go.etcd.io/etcd/v3/tools/benchmark @ v3.5.17)"
  # etcd's root go.mod has replace lines, so 'go install ...@v3.5.17' cannot work. A wrapper module
  # (tools/src/etcd-benchmark: go.mod copies etcd's require list, go.sum pins every hash) builds it instead.
  local d=$SRC/etcd-benchmark; mkdir -p "$d"; cp "$TOOLS/etcd-benchmark/"{go.mod,go.sum,tools.go} "$d/"
  [ -x "$d/etcd-benchmark" ] || (cd "$d" && $HEAVY go build -mod=mod -trimpath -o etcd-benchmark go.etcd.io/etcd/v3/tools/benchmark)
  # module go.etcd.io/etcd/v3 v3.5.17 h1:eqK0/iYyq2OUXVYfzqUvB5kHuoBDx+hxIfCcUuZ75gs=
}
step_crane() {
  say "crane v0.22.1 (google/go-containerregistry)"
  # module h1:RZuuSYhTvlDvtsK+NkutoCZ//C0X2ebLK8X8l3ULs84=
  [ -x "$OPT/crane/crane" ] || $HEAVY env GOBIN="$OPT/crane" go install github.com/google/go-containerregistry/cmd/crane@v0.22.1
}
step_minio() {
  say "MinIO server + mc (dl.min.io is blocked; built from the Go module proxy at their release tags)"
  # minio RELEASE.2025-10-15T17-29-55Z = v0.0.0-20251015172955-9e49d5e7a648 h1:6TdolSCLSs2nwm8i0PpWDqf9iX2Ty9WQK8wmr7dCnUM=
  # mc    RELEASE.2025-08-13T08-35-41Z = v0.0.0-20250813083541-7394ce0dd2a8 h1:9tuRE4iEaDkuxatxe7pddYYh1SX5mT0/D0haofZFeTY=
  # GOTOOLCHAIN=local: minio's go.mod asks for toolchain go1.24.8; its 'go 1.24.0' line is met by the box's 1.24.7.
  [ -x "$OPT/minio/minio" ] || $HEAVY env GOTOOLCHAIN=local GOBIN="$OPT/minio" go install -p 3 -trimpath github.com/minio/minio@v0.0.0-20251015172955-9e49d5e7a648
  [ -x "$OPT/minio/mc" ]    || $HEAVY env GOTOOLCHAIN=local GOBIN="$OPT/minio" go install -p 3 -trimpath github.com/minio/mc@v0.0.0-20250813083541-7394ce0dd2a8
}

# --- Redpanda: official .debs from Redpanda's public release bucket (dl.redpanda.com's apt route needs a token) ---
step_redpanda() {
  say "Redpanda 26.2.6 (.deb unpacked with dpkg -x; NOT run, see TOOLS.md)"
  local d=$DL/redpanda-deb B=https://vectorized-public.s3.us-west-2.amazonaws.com/releases/redpanda/26.2.6
  mkdir -p "$d"
  # The bucket publishes no checksum file and its ETags are multipart, so these sha256 are first-seen
  # values recorded on 2026-11-06 (build-meta.json says commit 06e1aca30b726c8de9dc9db5c2b83b4da8edf6d0).
  fetch $B/redpanda_26.2.6-1_amd64.deb     "$d/redpanda_26.2.6-1_amd64.deb"     49c5f1da7a0bebed468b6af3f85596f2f2f857faa037bd8179c27cd01b0ae3b7
  fetch $B/redpanda-rpk_26.2.6-1_amd64.deb "$d/redpanda-rpk_26.2.6-1_amd64.deb" 31f48681be8e104cf12fb416c9ac0680ea71e591b2fc1eb5c6ac59a81f3f2a7d
  if [ ! -x "$d/root/opt/redpanda/libexec/redpanda" ]; then
    mkdir -p "$d/root"; dpkg -x "$d/redpanda_26.2.6-1_amd64.deb" "$d/root"; dpkg -x "$d/redpanda-rpk_26.2.6-1_amd64.deb" "$d/root"
  fi
  # To run (needs the user's permission; the classifier refused it here): the broker's ELF interpreter is
  # hard-wired to /opt/redpanda/lib/ld.so, so either install the debs (dpkg -i, plus redpanda-tuner_26.2.6-1_amd64.deb
  # from the same bucket) or start it through its bundled loader:
  #   $d/root/opt/redpanda/lib/ld.so --library-path $d/root/opt/redpanda/lib $d/root/opt/redpanda/libexec/redpanda --version
  #   $d/root/opt/redpanda/libexec/rpk version        (rpk is a static Go binary)
}

# --- memtier_benchmark: the official image's binary layer, pinned by digest (fetch only; running it needs permission) ---
step_memtier_layer() {
  say "memtier_benchmark 2.5.2 binary layer from redislabs/memtier_benchmark (fetch only)"
  step_crane
  local d=$DL/memtier-image L=sha256:6aef4ecc13330f87660faa29ffcf7393ecb12811e60fbe0ae6567ffde4d7ea41
  mkdir -p "$d"
  # image redislabs/memtier_benchmark:2.5.2, linux/amd64 manifest sha256:ebdbcc1b2db83fbdede5810b358f620bb59a01b090a88feea2815e0a1fab1243
  if ! { [ -f "$d/layer2.tar.gz" ] && echo "${L#sha256:}  $d/layer2.tar.gz" | sha256sum -c --quiet -; }; then
    "$OPT/crane/crane" blob "redislabs/memtier_benchmark@$L" > "$d/layer2.tar.gz"
    echo "${L#sha256:}  $d/layer2.tar.gz" | sha256sum -c --quiet -
  fi
  mkdir -p "$d/root"; tar -xzf "$d/layer2.tar.gz" -C "$d/root"
  # binary: $d/root/usr/local/bin/memtier_benchmark (Ubuntu 22.04 build; its libevent/openssl/zlib needs are met by step_apt)
}

# --- my own smoke crates and C files (sources in tools/src/; Cargo.lock pins every crate checksum) ---
cargo_smoke() {  # name
  local d=$SRC/$1; mkdir -p "$d"; cp -r "$TOOLS/$1/." "$d/"
  (cd "$d" && $HEAVY cargo build --release --locked -j 3)
}
step_napi_c() {
  say "plain N-API addon in C (Node's own headers, no outside code)"
  local d=$SRC/napi-c; mkdir -p "$d"; cp "$TOOLS/napi-c/hello.c" "$d/"
  gcc -O2 -shared -fPIC -I"$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")/include/node" \
    -DNODE_GYP_MODULE_NAME=hello -o "$d/hello.node" "$d/hello.c"
}
step_napi_rs() { say "napi-rs 3.16.1 hello addon"; cargo_smoke napi-rs-hello; cp "$SRC/napi-rs-hello/target/release/libnapi_rs_hello.so" "$SRC/napi-rs-hello/hello.node"; }
step_rquickjs() { say "rquickjs 0.14.0 smoke"; cargo_smoke rquickjs-hello; }
step_deno_core() {
  say "deno_core 0.413.0 smoke (the v8 crate 150.4.0 downloads its prebuilt static library at build time)"
  # from https://github.com/denoland/rusty_v8/releases/download/v150.4.0/librusty_v8_simdutf_release_x86_64-unknown-linux-gnu.a.gz
  # (cached in ~/.cargo/.rusty_v8/; the v8 crate checks it against its own .sum file)
  cargo_smoke deno-core-hello
}
step_raft_rs() { say "raft-rs 0.7.0 smoke"; cargo_smoke raft-rs-hello; }
step_fuse_hello() {
  say "own FUSE 3 hello filesystem (checks that FUSE mounts work here)"
  local d=$SRC/fuse-hello; mkdir -p "$d"; cp "$TOOLS/fuse-hello/hellofs.c" "$d/"
  gcc -O2 -Wall $(pkg-config --cflags fuse3) -o "$d/hellofs" "$d/hellofs.c" $(pkg-config --libs fuse3)
}

# --- gated: builds of cloned GitHub source. The auto-mode classifier refused these on 2026-11-06
#     ("Code from External"); they run only when the user sets ALLOW_GATED=1. ---
gate() { [ "${ALLOW_GATED:-0}" = 1 ] || { echo "skip $1: gated (set ALLOW_GATED=1 once the user allows source builds)"; return 1; }; }
step_memtier_src() {
  gate memtier-src || return 0
  say "memtier_benchmark 2.5.2 from source (tag 2.5.2 = f3ff1793d39bf19077957e986f966206eb349de7)"
  local d=$DL/memtier; mkdir -p "$d"
  [ -d "$d/src" ] || git clone -q --depth 1 --branch 2.5.2 https://github.com/RedisLabs/memtier_benchmark "$d/src"
  [ "$(git -C "$d/src" rev-parse HEAD)" = f3ff1793d39bf19077957e986f966206eb349de7 ]
  (cd "$d/src" && $HEAVY sh -c "autoreconf -ivf && ./configure --prefix=$OPT/memtier && make -j3 && make install")
}
step_lazyfs() {
  gate lazyfs || return 0
  say "LazyFS 0.3.1 from source (tag 0.3.1 = 045a0b3a1126725e693934e29d3ba15e08cc39ec)"
  local d=$DL/lazyfs; mkdir -p "$d"
  [ -d "$d/src" ] || git clone -q --depth 1 --branch 0.3.1 https://github.com/dsrhaslab/lazyfs "$d/src"
  [ "$(git -C "$d/src" rev-parse HEAD)" = 045a0b3a1126725e693934e29d3ba15e08cc39ec ]
  # libpcache's CMake fetches spdlog from a github.com/.../archive URL, which the proxy refuses (403).
  # Clone both of its dependencies by tag instead and hand them to FetchContent.
  [ -d "$d/toml11" ] || git clone -q --depth 1 --branch v3.7.1 https://github.com/ToruNiina/toml11 "$d/toml11"     # dcfe39a783a94e8d52c885e5883a6fbb21529019
  [ -d "$d/spdlog" ] || git clone -q --depth 1 --branch v1.10.0 https://github.com/gabime/spdlog "$d/spdlog"        # 76fb40d95455f249bd70824ecfcae7a8f0930fa3
  (cd "$d/src/libs/libpcache" && mkdir -p build && cd build && \
    $HEAVY sh -c "cmake -DFETCHCONTENT_SOURCE_DIR_TOML=$d/toml11 -DFETCHCONTENT_SOURCE_DIR_SPDLOG=$d/spdlog .. && cmake --build . -j3")
  (cd "$d/src/lazyfs" && mkdir -p build && cd build && \
    $HEAVY sh -c "cmake -DLAZYFS_BUILD_TESTS=OFF -DFETCHCONTENT_SOURCE_DIR_TOML=$d/toml11 -DFETCHCONTENT_SOURCE_DIR_SPDLOG=$d/spdlog .. && cmake --build . -j3")
  # mount: $d/src/lazyfs/scripts/mount-lazyfs.sh -c <config.toml> -m <mnt> -r <root> -s   (FUSE works on this box: see fuse-hello)
}
step_fio_src() {
  gate fio-src || return 0
  say "fio 3.43 from source (optional; the apt fio 3.36 is the default)"
  local d=$DL/fio; mkdir -p "$d"
  [ -d "$d/src" ] || git clone -q --depth 1 --branch fio-3.43 https://github.com/axboe/fio "$d/src"
  [ "$(git -C "$d/src" rev-parse HEAD)" = d2dcd7e053d1902d2420f151c83990e6acdd9f8c ]
  (cd "$d/src" && $HEAVY sh -c "./configure --prefix=$OPT/fio && make -j3 && make install")
}

ALL="apt etcd nats kafka natscli node26 etcdbench crane minio redpanda memtier-layer napi-c napi-rs rquickjs deno-core raft-rs fuse-hello memtier-src lazyfs fio-src"
for s in ${@:-$ALL}; do
  fn="step_${s//-/_}"
  declare -F "$fn" >/dev/null || { echo "unknown step: $s" >&2; exit 2; }
  "$fn"
done
say "done; run tools/smoke.sh to check each tool"
