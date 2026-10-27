#!/usr/bin/env bash
# anclaw launcher — select platform: ./anclaw [node|qjs]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-auto}"

case "$(command -v qjs || true) $(command -v node || true)" in
  *"qjs"*"node"*|"node qjs"*) : ;;   # both available may pick explicitly
esac

if [[ "$TARGET" == "auto" ]]; then
  if command -v node >/dev/null 2>&1; then TARGET=node
  elif command -v qjs >/dev/null 2>&1; then TARGET=qjs
  else echo "anclaw: no node or qjs found" >&2; exit 1; fi
fi

case "$TARGET" in
  node)
    exec node "${ANCLAW_SRC:-$DIR/src/index.js}" "${@:2}" ;;
  qjs)
    exec qjs --std -m "${ANCLAW_SRC:-$DIR/src/index.js}" "${@:2}" ;;
  *)
    echo "anclaw: unknown target '$TARGET' (node|qjs)" >&2; exit 1 ;;
esac
