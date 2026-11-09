#!/bin/sh
# E-27 downloads nothing of its own. The tls26 variant runs Node 26.13.0, which the toolsmith fetched from
# nodejs.org and checked against SHASUMS256.txt: ../tools-fetch.sh node26 (it lands in $SP/dl/node26/).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
sh "$HERE/../tools-fetch.sh" node26
