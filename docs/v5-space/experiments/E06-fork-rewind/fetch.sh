#!/bin/sh
# E-06 downloads: Immutable.js 5.1.9 from the npm registry (the persistent map), checked against npm's own
# sha512 integrity and sha1 shasum. data and fero are the two sibling repos (see tree.sh); on a fresh machine
# clone data at 63fea66: git clone https://github.com/pemrouz/data && git -C data checkout 63fea66
set -e
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
D=$SP/dl/immutable
mkdir -p "$D" && cd "$D"
[ -f immutable-5.1.9.tgz ] || curl -fsSLO https://registry.npmjs.org/immutable/-/immutable-5.1.9.tgz
echo "ac23c3a01992ab665e14ac9ffff298f28cd74a0c  immutable-5.1.9.tgz" | sha1sum -c -
echo "9481d33c209e07f82933a0f8132348ee9325d72ce196ebc47a93b9b2703f3068  immutable-5.1.9.tgz" | sha256sum -c -
# npm's integrity field for 5.1.9: sha512-m8nVez3rwrgmWxtLMt1ZYXB2Lv7OKYn/disyxAlSDYAlKSlFoPPfIAmAM/M5xqL4m4C/wAPw7S2/CNaUii1Hxg==
[ "$(openssl dgst -sha512 -binary immutable-5.1.9.tgz | base64 -w0)" = "m8nVez3rwrgmWxtLMt1ZYXB2Lv7OKYn/disyxAlSDYAlKSlFoPPfIAmAM/M5xqL4m4C/wAPw7S2/CNaUii1Hxg==" ] && echo "sha512 integrity OK"
mkdir -p pkg && tar -xzf immutable-5.1.9.tgz -C pkg
