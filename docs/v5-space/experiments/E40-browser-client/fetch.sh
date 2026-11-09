#!/bin/sh
# E-40 downloads: esbuild 0.25.12 from npm (the same pinned install E-03 made; package-lock.json pins
#   esbuild 0.25.12 sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==
#   @esbuild/linux-x64 0.25.12 sha512-uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==).
# Not downloaded here: Playwright 1.63.0 and Chrome for Testing 153.0.8010.12 (Playwright build 1243) were already
# installed on the study box (/opt/node-tools, /opt/pw-browsers); elsewhere: npm i playwright@1.63.0 &&
# npx playwright install chromium. `data` must sit next to this repo, at ../data (or set DATA), at 63fea66.
set -e
SP=${SP:-/tmp/fero-sp}
mkdir -p "$SP/dl/esbuild" && cd "$SP/dl/esbuild"
[ -f package.json ] || echo '{"name":"e03-esbuild","private":true}' > package.json
[ -d node_modules/esbuild ] || npm install --no-audit --no-fund esbuild@0.25.12
node -e "console.log(require('esbuild').version)"
