#!/usr/bin/env bash
# Stop and remove the local stack recorded in docker/local-stack/ports.env:
# its containers, network and volumes, and nothing else (compose project scope).
#
#   docker/local-stack/down.sh            # remove the stack
#   MIP0018_KEEP_LOGS=1 down.sh           # first save each service's log to .state/<project>/
# bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
state="$here/ports.env"
if [ ! -f "$state" ]; then
  echo "no stack recorded ($state missing); nothing to do" >&2
  exit 0
fi
# shellcheck disable=SC1090
. "$state"
# Ports only matter for `up`; give compose placeholders so an older ports.env still tears down.
: "${MIP0018_NODE_PORT:=0}" "${MIP0018_INDEXER_PORT:=0}" "${MIP0018_PROOF_PORT:=0}" "${MIP0018_WALLET_PROOF_PORT:=0}"
export MIP0018_DOCKER_PREFIX MIP0018_STACK_PROJECT MIP0018_NODE_PORT MIP0018_INDEXER_PORT MIP0018_PROOF_PORT MIP0018_WALLET_PROOF_PORT

if [ -n "${MIP0018_KEEP_LOGS:-}" ]; then
  mkdir -p "$here/.state/$MIP0018_STACK_PROJECT"
  for s in node indexer proof-server wallet-proof-server; do
    docker compose -f "$here/compose.yml" logs --no-color "$s" >"$here/.state/$MIP0018_STACK_PROJECT/$s.log" 2>&1 || true
  done
  echo "logs saved in $here/.state/$MIP0018_STACK_PROJECT/" >&2
fi

docker compose -f "$here/compose.yml" down --volumes --remove-orphans >&2
rm -f "$state"
echo "removed $MIP0018_STACK_PROJECT" >&2
