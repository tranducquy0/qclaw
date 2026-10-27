#!/bin/bash
# build the anclaw_net quickjs-ng native module (on-device, termux-main).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-anclaw_net.so}"
clang -fPIC -shared -O2 -o "$OUT" anclaw_net.c \
  -I/data/data/com.termux/files/usr/include \
  -L/data/data/com.termux/files/usr/lib -lqjs -lcurl
echo "built $OUT"
