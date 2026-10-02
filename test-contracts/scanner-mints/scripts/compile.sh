#!/usr/bin/env bash
# Compile the scanner test contract with Compact 0.35.0 and ZKIR v3 (full keys unless
# --skip-zk is given). Runs inside the toolchain image (docker/run.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd -P)"
want="0.35.0"
have="$(compact compile --version | cut -d' ' -f1)"
if [ "$have" != "$want" ]; then
  echo "expected Compact $want, found $have" >&2
  exit 1
fi
echo "compact compile $(compact compile --version); language $(compact compile --language-version); runtime $(compact compile --runtime-version); zkir $(compact compile --feature-zkir-v3 --ledger-version)"
contracts="ScannerMints"
if [ -n "${SCANNER_CONTRACTS:-}" ]; then contracts="$SCANNER_CONTRACTS"; fi
for c in $contracts; do
  echo "== $c"
  rm -rf "managed/$c"
  start=$(date +%s)
  compact compile --feature-zkir-v3 --compact-path "$root/node_modules" "$@" "contracts/$c.compact" "managed/$c"
  echo "== $c compiled in $(( $(date +%s) - start ))s"
  for ir in managed/"$c"/zkir/*.bzkir; do
    [ -f "$ir" ] || continue
    # prints: Mock compiling circuit "<file>" (k=<k>, rows=<rows>)
    zkir-v3 mock-compile "$ir"
  done
done
