#!/bin/bash
# build anclaw native .so for quickjs-ng (termux: clang + libcurl + libqjs).
# Output: src/native_modules/anclaw_net.so
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-anclaw_net.so}"
USR=/data/data/com.termux/files/usr
clang -fPIC -shared -O2 -o "$OUT" \
  module.c http.c tcp.c sha256.c \
  -I$USR/include -L$USR/lib -lqjs -lcurl
echo "built $(dirname "$0")/$OUT" >&2
