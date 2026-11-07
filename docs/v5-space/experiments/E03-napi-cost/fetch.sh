#!/bin/sh
# E-03's downloads. Everything lands under $SP/dl or Cargo's cache; nothing goes in the repo.
set -e
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
# 1. esbuild 0.25.12 (to bundle data into one script for the two embedded engines), from npm.
#    package-lock.json pins: esbuild 0.25.12 sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==
#    and @esbuild/linux-x64 0.25.12 sha512-uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==
mkdir -p "$SP/dl/esbuild" && cd "$SP/dl/esbuild"
[ -f package.json ] || echo '{"name":"e03-esbuild","private":true}' > package.json
npm install --no-audit --no-fund esbuild@0.25.12
# 2. Rust crates from crates.io, pinned by each crate's Cargo.lock (sha256 per crate):
#    napi 3.16.1 / napi-derive 3.7.0 / napi-build 2.6.0 (addon/), deno_core 0.413.0 with v8 150.4.0
#    (isolate/denocore/; its build script downloads rusty_v8's prebuilt static library
#    librusty_v8_simdutf_release_x86_64-unknown-linux-gnu.a.gz v150.4.0 from github.com/denoland/rusty_v8
#    releases into ~/.cargo/.rusty_v8/), rquickjs 0.14.0 (isolate/quickjs/). seam/daemon has no dependency.
for c in addon isolate/denocore isolate/quickjs seam/daemon; do cargo fetch --locked --manifest-path "$HERE/$c/Cargo.toml"; done
# 3. Node 26.13.0 (the second Node row) comes from the study's tools: experiments/tools-fetch.sh node26
#    (nodejs.org tarball, sha256 checked against SHASUMS256.txt).
