#!/bin/sh
# E-28 uses MinIO RELEASE.2025-10-15T17-29-55Z, built with go install from proxy.golang.org (checked by the Go
# checksum database) by the study's tools script. The PUT client (put/) uses Go's standard library only.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
sh "$HERE/../tools-fetch.sh" minio
