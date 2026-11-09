#!/bin/sh
# E-38(c) uses etcd 3.5.17 and E-13's load client; both are fetched by E-13's fetch.sh.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
sh "$HERE/../E13-handover/fetch.sh"
